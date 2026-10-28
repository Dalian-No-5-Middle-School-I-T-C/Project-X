/**
 * 反馈附件聚合容量（#357）。
 *
 * 单次请求的 15 × 100 MiB 只是「一次」的上限：管理员可以反复提交，每次都永久占盘。
 * 这里按 `data/answer-card/feedback/` 整个目录的实际占盘做聚合闸门（排除 `_tmp` 暂存），
 * 并在 multer 落临时文件之前按 Content-Length 预留容量；「测容量 → 移动/入库」串行执行，
 * 避免两个并发上传各自看到旧容量后一起越界，也避免接近上限时先把 1.5 GiB 写进暂存盘。
 *
 * 无 Content-Length 的 chunked 请求没有可预知的体积，改为「分块步进预留」：先只占一小步，
 * 正文继续到达时暂停、追加预留后再继续，单个慢速连接不会把全部剩余配额一次性锁死。
 *
 * 默认 8 GiB，可用 PROJECTX_FEEDBACK_ATTACHMENT_TOTAL_MIB 调整，天花板 100 GiB。
 */
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const MEBIBYTE = 1024 * 1024;
const DEFAULT_TOTAL_MIB = 8192;
const MAX_TOTAL_MIB = 102400;
const MIN_CHUNKED_STEP_BYTES = 256 * 1024;
const MAX_CHUNKED_STEP_BYTES = 8 * MEBIBYTE;

function resolveTotalBytes(): number {
  const raw = Number(process.env.PROJECTX_FEEDBACK_ATTACHMENT_TOTAL_MIB);
  if (!Number.isFinite(raw) || raw < 1) {
    if (process.env.PROJECTX_FEEDBACK_ATTACHMENT_TOTAL_MIB !== undefined) {
      console.warn(`[feedback-storage] PROJECTX_FEEDBACK_ATTACHMENT_TOTAL_MIB 非法，按默认 ${DEFAULT_TOTAL_MIB} MiB 处理`);
    }
    return DEFAULT_TOTAL_MIB * MEBIBYTE;
  }
  if (raw > MAX_TOTAL_MIB) {
    console.warn(`[feedback-storage] PROJECTX_FEEDBACK_ATTACHMENT_TOTAL_MIB=${raw} 超过天花板 ${MAX_TOTAL_MIB}，已夹紧`);
    return MAX_TOTAL_MIB * MEBIBYTE;
  }
  return Math.round(raw * MEBIBYTE);
}

export const MAX_FEEDBACK_STORAGE_BYTES = resolveTotalBytes();

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
  /** 仅 chunked 使用：追加预留，容量不足时抛 FeedbackStorageQuotaError。 */
  grow(additionalBytes: number): Promise<void>;
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

export function markFeedbackTempFileLeaked(filePath: string): void {
  leakedTempFiles.add(path.resolve(filePath));
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
 *  活跃上传的 _tmp 由各自的预留覆盖，不能再按实际字节算一遍；宽限期大于请求超时。 */
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
    if (leakedTempFiles.has(path.resolve(full))) continue;
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

function makeReservation(
  feedbackRoot: string,
  tmpDir: string,
  initialBytes: number,
  limitBytes: number
): FeedbackStorageReservation {
  let held = initialBytes;
  let released = false;
  return {
    get bytes() { return held; },
    get limit() { return limitBytes; },
    grow(additionalBytes: number): Promise<void> {
      const requested = Math.max(0, Math.floor(additionalBytes));
      const run = quotaQueue.then(async () => {
        if (released) return;
        const target = Math.min(limitBytes, held + requested);
        const delta = target - held;
        if (delta <= 0) return;
        const used = await admissionUsage(feedbackRoot, tmpDir);
        if (released) return;
        if (used + reservedBytes + delta > MAX_FEEDBACK_STORAGE_BYTES) {
          throw new FeedbackStorageQuotaError();
        }
        reservedBytes += delta;
        held = target;
      });
      quotaQueue = run.then(() => undefined, () => undefined);
      return run;
    },
    release() {
      if (released) return;
      released = true;
      reservedBytes = Math.max(0, reservedBytes - held);
      held = 0;
    },
  };
}

/** 在 multer 写临时文件之前预留容量；返回的 release 必须幂等。 */
export function reserveFeedbackStorage(
  feedbackRoot: string,
  tmpDir: string,
  bytes: number
): Promise<FeedbackStorageReservation> {
  const run = quotaQueue.then(async () => {
    const used = await admissionUsage(feedbackRoot, tmpDir);
    if (used + reservedBytes + bytes > MAX_FEEDBACK_STORAGE_BYTES) {
      throw new FeedbackStorageQuotaError();
    }
    reservedBytes += bytes;
    return makeReservation(feedbackRoot, tmpDir, bytes, bytes);
  });
  quotaQueue = run.then(() => undefined, () => undefined);
  return run;
}

/** chunked / 无 Content-Length 上传：先按一步预留，正文到达时再分块追加（见 reservation.grow）。 */
export function reserveRemainingFeedbackStorage(
  feedbackRoot: string,
  tmpDir: string,
  maxBytes: number
): Promise<FeedbackStorageReservation> {
  const step = chunkedReservationStep();
  const run = quotaQueue.then(async () => {
    const used = await admissionUsage(feedbackRoot, tmpDir);
    const free = MAX_FEEDBACK_STORAGE_BYTES - used - reservedBytes;
    if (free <= 0) throw new FeedbackStorageQuotaError();
    // 剩余容量不足一步时也只占一半，给并发请求留出准入空间。
    const initial = Math.min(step, Math.max(1, Math.floor(free / 2)), maxBytes);
    reservedBytes += initial;
    return makeReservation(feedbackRoot, tmpDir, initial, maxBytes);
  });
  quotaQueue = run.then(() => undefined, () => undefined);
  return run;
}

/** 上传完成/失败时把预留换成实际占用，再串行执行「测容量 → 移动/入库」。
 *  成功时在文件移出 _tmp 之后释放预留；失败时保留预留，由调用方清理临时文件后再释放。 */
export function settleFeedbackStorage<T>(
  feedbackRoot: string,
  reservation: FeedbackStorageReservation | null,
  incomingBytes: number,
  task: () => Promise<T>
): Promise<T> {
  if (incomingBytes <= 0) {
    reservation?.release();
    return task();
  }
  const run = quotaQueue.then(async () => {
    // used 已包含本请求以及已经缓冲完成的并发请求的 _tmp 文件；再叠加 reservedBytes
    // 会把同一批字节算两遍。串行队列保证前一个请求移动完成后，后一个才看到它的永久占用。
    const used = await directoryBytes(feedbackRoot);
    if (used > MAX_FEEDBACK_STORAGE_BYTES) {
      throw new FeedbackStorageQuotaError();
    }
    const result = await task();
    reservation?.release();
    return result;
  });
  quotaQueue = run.then(() => undefined, () => undefined);
  return run;
}
