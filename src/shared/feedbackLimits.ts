/** 管理员问题反馈附件限制（#357）：最多 15 个，单个小于 100 MiB。 */
export const MAX_FEEDBACK_ATTACHMENTS = 15;
export const MAX_FEEDBACK_ATTACHMENT_BYTES = 100 * 1024 * 1024;
/** 单次请求预算：文件字节之和 + multipart 边界/字段开销。 */
export const MAX_FEEDBACK_ATTACHMENTS_TOTAL_BYTES =
  MAX_FEEDBACK_ATTACHMENTS * MAX_FEEDBACK_ATTACHMENT_BYTES + 4 * 1024 * 1024;

/** 反馈附件聚合容量默认 8 GiB，环境变量可调，天花板 100 GiB。 */
export const DEFAULT_FEEDBACK_STORAGE_MIB = 8192;
export const MAX_FEEDBACK_STORAGE_MIB = 102400;

/**
 * 附件总文件数上限。备份把每个附件作为一个 ZIP 条目，恢复侧默认条目预算是 2 万条；
 * 只按字节配额限制时，大量空文件/极小文件仍会把条目数推过恢复预算，导致合法备份无法恢复。
 * 默认 8000 条（约 533 次满 15 附件提交）、天花板 12000 条，给原卷与库文件留出条目余量。
 */
export const DEFAULT_FEEDBACK_ATTACHMENT_FILES = 8000;
export const MAX_FEEDBACK_ATTACHMENT_FILES = 12000;
/** 备份中数据库、原卷、答案页等非反馈条目预留：反馈附件不能把恢复条目预算吃干。 */
export const FEEDBACK_BACKUP_ENTRY_RESERVE = 4000;

/** 反馈附件实际上限 = min(配置上限, 恢复条目预算 - 非反馈预留)，避免导出的备份超出解压预算。 */
export function boundFeedbackAttachmentFiles(configuredFiles: number, restoreEntryLimit: number): number {
  return Math.max(0, Math.min(configuredFiles, restoreEntryLimit - FEEDBACK_BACKUP_ENTRY_RESERVE));
}

export function resolveFeedbackAttachmentFileLimit(
  env: Record<string, string | undefined> = {}
): { files: number; notices: string[] } {
  const raw = env.PROJECTX_FEEDBACK_ATTACHMENT_MAX_FILES;
  if (raw === undefined || String(raw).trim() === "") {
    return { files: DEFAULT_FEEDBACK_ATTACHMENT_FILES, notices: [] };
  }
  const parsed = Number(String(raw).trim());
  if (!Number.isFinite(parsed) || parsed < 1) {
    return {
      files: DEFAULT_FEEDBACK_ATTACHMENT_FILES,
      notices: [`PROJECTX_FEEDBACK_ATTACHMENT_MAX_FILES="${raw}" 不是 ≥1 的数，按默认 ${DEFAULT_FEEDBACK_ATTACHMENT_FILES} 条处理`],
    };
  }
  if (parsed > MAX_FEEDBACK_ATTACHMENT_FILES) {
    return {
      files: MAX_FEEDBACK_ATTACHMENT_FILES,
      notices: [`PROJECTX_FEEDBACK_ATTACHMENT_MAX_FILES=${raw} 超过天花板 ${MAX_FEEDBACK_ATTACHMENT_FILES}，已夹紧`],
    };
  }
  return { files: Math.floor(parsed), notices: [] };
}

/**
 * 解析聚合容量（纯函数，便于服务端与恢复预算共用）。
 * 备份会把反馈附件一起打包，恢复侧的解压总量必须能覆盖这份配额。
 */
export function resolveFeedbackStorageMib(
  env: Record<string, string | undefined> = {}
): { mib: number; notices: string[] } {
  const raw = env.PROJECTX_FEEDBACK_ATTACHMENT_TOTAL_MIB;
  if (raw === undefined || String(raw).trim() === "") {
    return { mib: DEFAULT_FEEDBACK_STORAGE_MIB, notices: [] };
  }
  const parsed = Number(String(raw).trim());
  if (!Number.isFinite(parsed) || parsed < 1) {
    return {
      mib: DEFAULT_FEEDBACK_STORAGE_MIB,
      notices: [`PROJECTX_FEEDBACK_ATTACHMENT_TOTAL_MIB="${raw}" 不是 ≥1 的数，按默认 ${DEFAULT_FEEDBACK_STORAGE_MIB} MiB 处理`],
    };
  }
  if (parsed > MAX_FEEDBACK_STORAGE_MIB) {
    return {
      mib: MAX_FEEDBACK_STORAGE_MIB,
      notices: [`PROJECTX_FEEDBACK_ATTACHMENT_TOTAL_MIB=${raw} 超过天花板 ${MAX_FEEDBACK_STORAGE_MIB}，已夹紧`],
    };
  }
  return { mib: Math.round(parsed), notices: [] };
}
