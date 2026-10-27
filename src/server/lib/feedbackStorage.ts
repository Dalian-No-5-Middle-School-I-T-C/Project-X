/**
 * 反馈附件聚合容量（#357）。
 *
 * 单次请求的 15 × 100 MiB 只是「一次」的上限：管理员可以反复提交，每次都永久占盘。
 * 这里按 `data/answer-card/feedback/` 整个目录的实际占盘做聚合闸门（排除 `_tmp` 暂存），
 * 并在 multer 落临时文件之前按 Content-Length 预留容量；「测容量 → 移动/入库」串行执行，
 * 避免两个并发上传各自看到旧容量后一起越界，也避免接近上限时先把 1.5 GiB 写进暂存盘。
 *
 * 默认 8 GiB，可用 PROJECTX_FEEDBACK_ATTACHMENT_TOTAL_MIB 调整，天花板 100 GiB。
 */
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const MEBIBYTE = 1024 * 1024;
const DEFAULT_TOTAL_MIB = 8192;
const MAX_TOTAL_MIB = 102400;

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

export class FeedbackStorageQuotaError extends Error {
  readonly code = "FEEDBACK_STORAGE_QUOTA_EXCEEDED";

  constructor() {
    super(
      `反馈附件总容量已达上限（${Math.round(MAX_FEEDBACK_STORAGE_BYTES / MEBIBYTE)} MiB），` +
      "请先删除旧反馈或调整 PROJECTX_FEEDBACK_ATTACHMENT_TOTAL_MIB"
    );
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
  /** 幂等释放；上传失败/响应关闭后由路由调用。 */
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

/** 准入核算：永久占盘 + 超过宽限期的孤儿临时件 + 其他请求的预留。
 *  活跃上传的 _tmp 由各自的预留覆盖，不能再按实际字节算一遍；宽限期大于请求超时。 */
async function admissionUsage(feedbackRoot: string, tmpDir: string): Promise<number> {
  let total = await directoryBytes(feedbackRoot, tmpDir);
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
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        reservedBytes = Math.max(0, reservedBytes - bytes);
      },
    } satisfies FeedbackStorageReservation;
  });
  quotaQueue = run.then(() => undefined, () => undefined);
  return run;
}

/** 上传完成/失败时把预留换成实际占用，再串行执行「测容量 → 移动/入库」。 */
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
    reservation?.release();
    // used 已包含本请求以及已经缓冲完成的并发请求的 _tmp 文件；再叠加 reservedBytes
    // 会把同一批字节算两遍。串行队列保证前一个请求移动完成后，后一个才看到它的永久占用。
    const used = await directoryBytes(feedbackRoot);
    if (used > MAX_FEEDBACK_STORAGE_BYTES) {
      throw new FeedbackStorageQuotaError();
    }
    return task();
  });
  quotaQueue = run.then(() => undefined, () => undefined);
  return run;
}
