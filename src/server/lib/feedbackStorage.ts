/**
 * 反馈附件聚合容量（#357）。
 *
 * 单次请求的 15 × 100 MiB 只是「一次」的上限：管理员可以反复提交，每次都永久占盘。
 * 这里按 `data/answer-card/feedback/` 整个目录的实际占盘做聚合闸门（排除 `_tmp` 暂存）。
 * 每个请求初始预留为 0；multer 存储引擎在写入文件字节时按进度申请预留，文本字段不占配额，
 * 文件写入受预留背压，声明了 Content-Length 也不会提前锁住整包额度。「测容量 → 移动/入库」
 * 串行执行，避免两个并发上传各自看到旧容量后一起越界。
 *
 * 默认 8 GiB，可用 PROJECTX_FEEDBACK_ATTACHMENT_TOTAL_MIB 调整，天花板 100 GiB。
 */
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { resolveFeedbackStorageMib } from "../../shared/feedbackLimits";

const MEBIBYTE = 1024 * 1024;
const MIN_CHUNKED_STEP_BYTES = 256 * 1024;
const MAX_CHUNKED_STEP_BYTES = 8 * MEBIBYTE;

const resolvedStorage = resolveFeedbackStorageMib(process.env);
for (const notice of resolvedStorage.notices) console.warn(`[feedback-storage] ${notice}`);

export const MAX_FEEDBACK_STORAGE_BYTES = resolvedStorage.mib * MEBIBYTE;

let feedbackMutationTail: Promise<void> = Promise.resolve();

/**
 * 备份与反馈附件变更互斥：备份在数据库快照与附件目录复制之间不允许提交或删除反馈，
 * 否则备份可能保留附件记录却缺少文件（删除已提交）或多出未入快照的文件。
 */
export function withFeedbackMutationLock<T>(work: () => Promise<T>): Promise<T> {
  const run = feedbackMutationTail.then(work, work);
  feedbackMutationTail = run.then(() => undefined, () => undefined);
  return run;
}

/** chunked 每次追加预留的步长：约为总配额的 1/32，最小 256 KiB、最大 8 MiB。 */
export function chunkedReservationStep(): number {
  return Math.min(
    MAX_CHUNKED_STEP_BYTES,
    Math.max(MIN_CHUNKED_STEP_BYTES, Math.floor(MAX_FEEDBACK_STORAGE_BYTES / 32))
  );
}

export class FeedbackStorageQuotaError extends Error {
  readonly code = "FEEDBACK_STORAGE_QUOTA_EXCEEDED";

  constructor() {
    super("反馈附件总容量已达上限，暂时无法上传附件；可以先提交不带附件的内容");
    this.name = "FeedbackStorageQuotaError";
  }
}

/** 目录读不出来时不能当成 0：宁可拒绝上传，也不能在错误基线上放行。 */
export class FeedbackStorageUnavailableError extends Error {
  readonly code = "FEEDBACK_STORAGE_UNAVAILABLE";

  constructor() {
    super("无法统计反馈附件容量，已拒绝本次上传，请稍后重试");
    this.name = "FeedbackStorageUnavailableError";
  }
}

export interface FeedbackStorageReservation {
  /** 当前已预留的字节数；chunked 上传会随接收进度增长。 */
  readonly bytes: number;
  /** 本请求最多可预留的字节数。 */
  readonly limit: number;
  /** 保证预留至少覆盖到 totalBytes（并发文件共用同一请求时按累计目标幂等补齐）。
   *  容量不够时抛 FeedbackStorageQuotaError；没有可追加容量但已覆盖时返回 false/true。 */
  ensureBytes(totalBytes: number): Promise<boolean>;
  /** 幂等释放；必须在本请求的 _tmp 文件全部移走或删除之后调用。 */
  release(): void;
}

async function directoryBytes(dir: string, skipDir?: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err: any) {
    if (err?.code === "ENOENT") return 0; // 目录还不存在（尚未上传过附件）
    throw new FeedbackStorageUnavailableError();
  }
  const skip = skipDir ? path.resolve(skipDir) : null;
  let total = 0;
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (skip && path.resolve(full) === skip) continue;
    if (entry.isDirectory()) {
      total += await directoryBytes(full, skipDir);
    } else if (entry.isFile()) {
      try {
        total += (await stat(full)).size;
      } catch (err: any) {
        if (err?.code === "ENOENT") continue; // 统计期间被并发删除
        throw new FeedbackStorageUnavailableError();
      }
    }
  }
  return total;
}

const ORPHAN_TMP_GRACE_MS = 10 * 60_000;

/** 清理失败、预留已经释放的临时文件：按实际占盘继续计入准入，直到确认删除。 */
const leakedTempFiles = new Set<string>();
const activeTempFiles = new Set<string>();

export function markActiveFeedbackTempFile(filePath: string): void {
  activeTempFiles.add(path.resolve(filePath));
}

export function unmarkActiveFeedbackTempFile(filePath: string): void {
  activeTempFiles.delete(path.resolve(filePath));
}

export function activeFeedbackTempFiles(): ReadonlySet<string> {
  return activeTempFiles;
}

export function markFeedbackTempFileLeaked(filePath: string): void {
  const resolved = path.resolve(filePath);
  activeTempFiles.delete(resolved);
  leakedTempFiles.add(resolved);
  invalidateFeedbackStorageUsage();
}

async function leakedTempBytes(): Promise<number> {
  let total = 0;
  for (const filePath of [...leakedTempFiles]) {
    try {
      total += (await stat(filePath)).size;
    } catch (err: any) {
      if (err?.code === "ENOENT") {
        leakedTempFiles.delete(filePath);
        continue;
      }
      throw new FeedbackStorageUnavailableError();
    }
  }
  return total;
}

/** 准入核算：永久占盘 + 超过宽限期的孤儿临时件 + 清理失败的临时件 + 其他请求的预留。
 *  在途 _tmp 由各自的预留覆盖，不论修改时间都不再按占盘加一次。
 *  上传没有请求体超时，不能靠 10 分钟宽限期把慢请求当成孤儿。 */
async function admissionUsage(feedbackRoot: string, tmpDir: string): Promise<number> {
  let total = await directoryBytes(feedbackRoot, tmpDir);
  total += await leakedTempBytes();
  let entries;
  try {
    entries = await readdir(tmpDir, { withFileTypes: true });
  } catch (err: any) {
    if (err?.code === "ENOENT") return total;
    throw new FeedbackStorageUnavailableError();
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = path.join(tmpDir, entry.name);
    const resolved = path.resolve(full);
    if (leakedTempFiles.has(resolved)) continue;
    if (activeTempFiles.has(resolved)) continue; // 活跃上传由各自预留覆盖
    try {
      const info = await stat(full);
      if (now - info.mtimeMs >= ORPHAN_TMP_GRACE_MS) total += info.size;
    } catch (err: any) {
      if (err?.code === "ENOENT") continue;
      throw new FeedbackStorageUnavailableError();
    }
  }
  return total;
}

let reservedBytes = 0;
let quotaQueue: Promise<void> = Promise.resolve();
let reservationSeq = 0;
const activeReservations = new Set<number>();
const USAGE_CACHE_TTL_MS = 15_000;
const usageCache = new Map<string, { bytes: number; at: number }>();

/** 删除、孤儿清理、泄漏登记等树外变更后清空缓存；下次申请预留重新扫描。 */
export function invalidateFeedbackStorageUsage(): void {
  usageCache.clear();
}

async function cachedAdmissionUsage(feedbackRoot: string, tmpDir: string): Promise<number> {
  const key = path.resolve(feedbackRoot);
  const cached = usageCache.get(key);
  if (cached && Date.now() - cached.at < USAGE_CACHE_TTL_MS) return cached.bytes;
  const bytes = await admissionUsage(feedbackRoot, tmpDir);
  usageCache.set(key, { bytes, at: Date.now() });
  return bytes;
}

function makeReservation(
  feedbackRoot: string,
  tmpDir: string,
  initialBytes: number,
  limitBytes: number
): FeedbackStorageReservation {
  let held = initialBytes;
  let released = false;
  let registered = false;
  const id = ++reservationSeq;
  const ensure = async (target: number, attempt: number): Promise<boolean> => {
    const run = quotaQueue.then(async (): Promise<boolean | "retry" | "retry-later"> => {
      if (released) return false;
      if (held >= target) return true;
      if (held >= limitBytes) return false;
      const used = await cachedAdmissionUsage(feedbackRoot, tmpDir);
      if (released) return false;
      if (held >= target) return true; // 并发文件已经把这个目标补上了
      const minimum = target - held;
      const available = MAX_FEEDBACK_STORAGE_BYTES - used - reservedBytes;
      if (available < minimum) {
        // 先到的请求优先：后到者等得更久，让最早请求先尝试；最早请求超时失败后，
        // 后到者仍有时间接手，避免「先到者其实也装不下」时两个一起失败。
        const hasEarlier = [...activeReservations].some((other) => other < id);
        return hasEarlier ? "retry-later" : "retry";
      }
      const desired = Math.max(minimum, chunkedReservationStep());
      const delta = Math.min(desired, available, limitBytes - held);
      if (delta <= 0) return false;
      reservedBytes += delta;
      held += delta;
      if (!registered) {
        activeReservations.add(id);
        registered = true;
      }
      return true;
    });
    quotaQueue = run.then(() => undefined, () => undefined);
    const result = await run;
    if (result === "retry" || result === "retry-later") {
      const maxAttempts = result === "retry-later" ? 40 : 20;
      if (attempt >= maxAttempts) throw new FeedbackStorageQuotaError();
      await new Promise((resolve) => setTimeout(resolve, 50));
      return ensure(target, attempt + 1);
    }
    return result;
  };
  return {
    get bytes() { return held; },
    get limit() { return limitBytes; },
    ensureBytes(totalBytes: number): Promise<boolean> {
      const target = Math.max(0, Math.floor(totalBytes));
      return ensure(target, 0);
    },
    release() {
      if (released) return;
      released = true;
      if (registered) activeReservations.delete(id);
      reservedBytes = Math.max(0, reservedBytes - held);
      held = 0;
    },
  };
}

/** 每次反馈请求的零预留：只有 multer 真正写文件字节时才申请预留，文本字段不占配额。 */
export function createFeedbackStorageReservation(
  feedbackRoot: string,
  tmpDir: string,
  limitBytes: number
): FeedbackStorageReservation {
  return makeReservation(feedbackRoot, tmpDir, 0, limitBytes);
}

/** 上传完成/失败时把预留换成实际占用，再串行执行「测容量 → 移动/入库」。
 *  失败时在同一串行队列里先执行调用方的清理（删目录、清临时文件），再释放预留，
 *  避免下一个并发请求同时看到残留目录和未释放的预留。 */
export function settleFeedbackStorage<T>(
  feedbackRoot: string,
  reservation: FeedbackStorageReservation | null,
  incomingBytes: number,
  task: () => Promise<T>,
  onError?: () => Promise<void>
): Promise<T> {
  if (incomingBytes <= 0) {
    reservation?.release();
    return task();
  }
  const run = quotaQueue.then(async () => {
    try {
      // used 已包含本请求以及已经缓冲完成的并发请求的 _tmp 文件；再叠加 reservedBytes
      // 会把同一批字节算两遍。串行队列保证前一个请求移动完成后，后一个才看到它的永久占用。
      const used = await directoryBytes(feedbackRoot);
      if (used > MAX_FEEDBACK_STORAGE_BYTES) {
        throw new FeedbackStorageQuotaError();
      }
      const result = await task();
      const cached = usageCache.get(path.resolve(feedbackRoot));
      if (cached) {
        cached.bytes += incomingBytes;
        cached.at = Date.now();
      }
      return result;
    } catch (err) {
      if (onError) {
        try {
          await onError();
        } catch (cleanupErr) {
          console.error("[feedback-storage] 结算失败后的清理也失败:", cleanupErr);
        }
      }
      throw err;
    } finally {
      reservation?.release();
    }
  });
  quotaQueue = run.then(() => undefined, () => undefined);
  return run;
}
