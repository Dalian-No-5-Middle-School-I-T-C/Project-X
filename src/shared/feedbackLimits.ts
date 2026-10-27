/** 管理员问题反馈附件限制（#357）：最多 15 个，单个小于 100 MiB。 */
export const MAX_FEEDBACK_ATTACHMENTS = 15;
export const MAX_FEEDBACK_ATTACHMENT_BYTES = 100 * 1024 * 1024;
/** 单次请求预算：文件字节之和 + multipart 边界/字段开销。 */
export const MAX_FEEDBACK_ATTACHMENTS_TOTAL_BYTES =
  MAX_FEEDBACK_ATTACHMENTS * MAX_FEEDBACK_ATTACHMENT_BYTES + 4 * 1024 * 1024;
