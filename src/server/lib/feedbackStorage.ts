/**
 * 反馈附件聚合容量（#357）。
 *
 * 单次请求最多 15 × 100 MiB，但每次成功都会永久占盘。这里按
 * `data/answer-card/feedback/` 的实际占用做聚合闸门。
 *
 * 有 Content-Length 的请求按声明体积预留。没有 Content-Length 的分块请求只按步进
 * （256 KiB）预留，不能在准入时把剩余配额一次划走，否则一条慢连接会把其他老师的上传全部拒掉。
 * 年轻的 `_tmp` 文件要么挂在某次预留上，要么按实际大小计入；预留必须在这些文件被移走或删除之后才释放。
 *
 * 默认 8 GiB，可用 PROJECTX_FEEDBACK_ATTACHMENT_TOTAL_MIB 调整，天花板 100 GiB。
 */
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

const MEBIBYTE = 1024 * 1024;
const DEFAULT_TOTAL_MIB = 8192;
const MAX_TOTAL_MIB = 102400;
/** 分块上传每次多预留的字节。只代表「接下来这一小段」，不是剩余配额。 */
export const FEEDBACK_STREAM_STEP_BYTES = 256 * 1024;

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

let quotaWarned = false;

export class FeedbackStorageQuotaError extends Error {
  readonly code = "FEEDBACK_STORAGE_QUOTA_EXCEEDED";

  constructor() {
    super("附件空间已满，暂时无法上传。请稍后再试，或请管理员清理不再需要的反馈。");
    this.name = "FeedbackStorageQuotaError";
    if (!quotaWarned) {
      quotaWarned = true;
      console.warn(
        `[feedback-storage] 反馈附件聚合容量已满（${Math.round(MAX_FEEDBACK_STORAGE_BYTES / MEBIBYTE)} MiB）。` +
        "可删除旧反馈，或调整 PROJECTX_FEEDBACK_ATTACHMENT_TOTAL_MIB。"
      );
    }
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
  /** 当前已经预留的字节数。分块上传会随接收步进增长。 */
  readonly bytes: number;
  /**
   * 在当前预留上再加 `extra` 字节。单线程内同步完成，失败时不改已预留的量。
   * 空间不够时返回 false。
   */
  tryGrow(extra: number): boolean;
}

/** 正在写入、已由某次预留覆盖的临时文件。不在此集合里的 `_tmp` 按实际大小计。 */
const coveredTmp = new Set<string>();
const releasers = new WeakMap<FeedbackStorageReservation, () => void>();

let reservedBytes = 0;
/** 永久文件 + 没有预留覆盖的临时文件。活跃上传的临时字节由 reservedBytes 代表。 */
let baseUsage = 0;
/**
 * 最近一次核算失败。为 true 时不能凭旧的 baseUsage 放行，必须先重新扫盘成功。
 * 已经提交入库的反馈不受影响。
 */
let usageUnknown = false;
let refreshFaultsRemaining = 0;
let postCommitRefreshFaultsRemaining = 0;
let quotaQueue: Promise<void> = Promise.resolve();

/** 测试用：下一次容量刷新直接失败。生产路径不会调用。 */
export function failNextFeedbackUsageRefreshForTests(): void {
  refreshFaultsRemaining += 1;
}

/** 测试用：下一次「事务已经提交之后」的容量刷新失败，且不得回滚该次提交。 */
export function failNextPostCommitFeedbackUsageRefreshForTests(): void {
  postCommitRefreshFaultsRemaining += 1;
}

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = quotaQueue.then(task, task);
  quotaQueue = run.then(() => undefined, () => undefined);
  return run;
}

export function noteFeedbackTempPath(filePath: string): void {
  coveredTmp.add(path.resolve(filePath));
}

function releaseLocked(reservation: FeedbackStorageReservation | null): void {
  releasers.get(reservation as FeedbackStorageReservation)?.();
}

async function directoryBytes(dir: string, skipDir?: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err: any) {
    if (err?.code === "ENOENT") return 0;
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
        if (err?.code === "ENOENT") continue;
        throw new FeedbackStorageUnavailableError();
      }
    }
  }
  return total;
}

async function scanTmp(tmpDir: string): Promise<{ uncovered: number; covered: number }> {
  let entries;
  try {
    entries = await readdir(tmpDir, { withFileTypes: true });
  } catch (err: any) {
    if (err?.code === "ENOENT") return { uncovered: 0, covered: 0 };
    throw new FeedbackStorageUnavailableError();
  }
  let uncovered = 0;
  let covered = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = path.join(tmpDir, entry.name);
    try {
      const size = (await stat(full)).size;
      if (coveredTmp.has(path.resolve(full))) covered += size;
      else uncovered += size;
    } catch (err: any) {
      if (err?.code === "ENOENT") continue;
      throw new FeedbackStorageUnavailableError();
    }
  }
  return { uncovered, covered };
}

async function refreshBaseUsage(feedbackRoot: string, tmpDir: string): Promise<void> {
  if (refreshFaultsRemaining > 0) {
    refreshFaultsRemaining -= 1;
    usageUnknown = true;
    throw new FeedbackStorageUnavailableError();
  }
  try {
    const permanent = await directoryBytes(feedbackRoot, tmpDir);
    const { uncovered, covered } = await scanTmp(tmpDir);
    // 临时文件已经比预留更大时，把多出来的部分算进基线，避免预留落后于落盘。
    const excess = Math.max(0, covered - reservedBytes);
    baseUsage = permanent + uncovered + excess;
    usageUnknown = false;
  } catch (err) {
    usageUnknown = true;
    throw err instanceof FeedbackStorageUnavailableError ? err : new FeedbackStorageUnavailableError();
  }
}

function notePostCommitRefreshFailure(err?: unknown): void {
  usageUnknown = true;
  if (err) {
    console.error("[feedback-storage] 反馈已提交，容量重新核算失败，已暂停后续上传直到核算恢复:", err);
  } else {
    console.error("[feedback-storage] 反馈已提交，容量重新核算失败，已暂停后续上传直到核算恢复");
  }
}

function createReservation(initial: number): FeedbackStorageReservation {
  let held = initial;
  let released = false;
  const reservation: FeedbackStorageReservation = {
    get bytes() {
      return held;
    },
    tryGrow(extra: number): boolean {
      if (released || usageUnknown) return false;
      if (extra <= 0) return true;
      if (baseUsage + reservedBytes + extra > MAX_FEEDBACK_STORAGE_BYTES) return false;
      reservedBytes += extra;
      held += extra;
      return true;
    },
  };
  releasers.set(reservation, () => {
    if (released) return;
    released = true;
    reservedBytes = Math.max(0, reservedBytes - held);
    held = 0;
  });
  return reservation;
}

/** 在 multer 写临时文件之前，按声明的 Content-Length 预留。 */
export function reserveFeedbackStorage(
  feedbackRoot: string,
  tmpDir: string,
  bytes: number
): Promise<FeedbackStorageReservation> {
  return enqueue(async () => {
    await refreshBaseUsage(feedbackRoot, tmpDir);
    if (baseUsage + reservedBytes + bytes > MAX_FEEDBACK_STORAGE_BYTES) {
      throw new FeedbackStorageQuotaError();
    }
    reservedBytes += bytes;
    return createReservation(bytes);
  });
}

/**
 * 分块 / 无 Content-Length：先确认还有空位，再只预留一个步进（或更小的剩余空间）。
 * 后续由路由在收到正文时调用 tryGrow，按实际到达的字节加预留。
 */
export function beginChunkedFeedbackReservation(
  feedbackRoot: string,
  tmpDir: string
): Promise<FeedbackStorageReservation> {
  return enqueue(async () => {
    await refreshBaseUsage(feedbackRoot, tmpDir);
    const free = MAX_FEEDBACK_STORAGE_BYTES - baseUsage - reservedBytes;
    if (free <= 0) throw new FeedbackStorageQuotaError();
    const initial = Math.min(FEEDBACK_STREAM_STEP_BYTES, free);
    reservedBytes += initial;
    return createReservation(initial);
  });
}

/**
 * 删除本次请求的临时文件后再释放预留。
 * 删不掉的文件会先从「已覆盖」集合拿掉，刷新基线时按实际大小计入，避免释放后出现配额空窗。
 */
export function releaseFeedbackUpload(
  feedbackRoot: string,
  tmpDir: string,
  reservation: FeedbackStorageReservation | null,
  tempPaths: readonly string[]
): Promise<void> {
  return enqueue(async () => {
    for (const filePath of tempPaths) {
      coveredTmp.delete(path.resolve(filePath));
      await rm(filePath, { force: true }).catch(() => {});
    }
    try {
      await refreshBaseUsage(feedbackRoot, tmpDir);
    } catch (err) {
      usageUnknown = true;
      console.error("[feedback-storage] 释放上传预留时无法重新核算容量:", err);
    }
    releaseLocked(reservation);
  });
}

/**
 * 上传完成时串行执行「按实际占盘核算 → 移动/入库」。
 * 事务提交之后的核算失败只把容量标成未知并暂停后续上传，不再把这次提交当成失败。
 */
export function settleFeedbackStorage<T>(
  feedbackRoot: string,
  tmpDir: string,
  reservation: FeedbackStorageReservation | null,
  incomingBytes: number,
  tempPaths: readonly string[],
  task: () => Promise<T>
): Promise<T> {
  return enqueue(async () => {
    await refreshBaseUsage(feedbackRoot, tmpDir);
    if (usageUnknown) throw new FeedbackStorageUnavailableError();
    if (incomingBytes > 0) {
      const used = await directoryBytes(feedbackRoot);
      if (used > MAX_FEEDBACK_STORAGE_BYTES) throw new FeedbackStorageQuotaError();
    }
    const result = await task();
    for (const filePath of tempPaths) coveredTmp.delete(path.resolve(filePath));
    if (postCommitRefreshFaultsRemaining > 0) {
      postCommitRefreshFaultsRemaining -= 1;
      notePostCommitRefreshFailure();
      releaseLocked(reservation);
      return result;
    }
    try {
      await refreshBaseUsage(feedbackRoot, tmpDir);
    } catch (err) {
      notePostCommitRefreshFailure(err);
      releaseLocked(reservation);
      return result;
    }
    releaseLocked(reservation);
    return result;
  });
}
