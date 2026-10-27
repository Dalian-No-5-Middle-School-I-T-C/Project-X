/**
 * 反馈附件聚合容量（#357）。
 *
 * 单次请求的 15 × 100 MiB 只是「一次」的上限：管理员可以反复提交，每次都永久占盘。
 * 这里按 `data/answer-card/feedback/` 整个目录的实际占盘做聚合闸门（排除 `_tmp` 暂存），
 * 并把「测容量 → 移动/入库」串行化，避免两个并发上传各自看到旧容量后一起越界。
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

async function directoryBytes(dir: string, skipDir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0; // 目录还不存在（尚未上传过附件）
  }
  const skip = path.resolve(skipDir);
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (path.resolve(full) === skip) continue;
    if (entry.isDirectory()) {
      total += await directoryBytes(full, skipDir);
    } else if (entry.isFile()) {
      try { total += (await stat(full)).size; } catch { /* 并发删除：留给下一次核算 */ }
    }
  }
  return total;
}

let quotaQueue: Promise<void> = Promise.resolve();

/** 串行执行「测容量 → 移动/入库」，防止并发上传在检查后一起落盘越界。 */
export function withFeedbackStorageQuota<T>(
  feedbackRoot: string,
  tmpDir: string,
  incomingBytes: number,
  task: () => Promise<T>
): Promise<T> {
  if (incomingBytes <= 0) return task();
  const run = quotaQueue.then(async () => {
    const used = await directoryBytes(feedbackRoot, tmpDir);
    if (used + incomingBytes > MAX_FEEDBACK_STORAGE_BYTES) {
      throw new FeedbackStorageQuotaError();
    }
    return task();
  });
  quotaQueue = run.then(() => undefined, () => undefined);
  return run;
}
