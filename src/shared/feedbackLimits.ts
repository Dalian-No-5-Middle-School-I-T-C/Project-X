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
