/**
 * 运维类错误消息脱敏（安全 R25）。
 *
 * 备份/恢复、mysqldump、文件替换这类失败，`error.message` 里常常自带主机信息：
 * 临时目录绝对路径、数据目录、`C:\Users\<name>\...`、MySQL 报错里的
 * `... for user 'projectx_app'@'10.0.0.7'`。这些原样回给前端就等于把服务器文件系统
 * 结构与数据库账号暴露给每一个能点「恢复」按钮的会话（而管理员会话可能被共享/截屏）。
 *
 * 判据：**详细信息进日志，脱敏后的摘要进响应**。这里只做「抹掉路径与凭据」，
 * 不抹掉错误类别本身（ENOENT / ER_ACCESS_DENIED / not a ZIP），否则管理员无法自查。
 * 需要保留完整原文时，请调用方自己 `console.error`。
 */

const WINDOWS_PATH_RE = /(?:[A-Za-z]:[\\/]|\\\\)[^\s"',;)]*/g;
// 两段及以上的 POSIX 绝对路径（`/tmp/x`、`/var/lib/projectx/data`）；单段斜杠不算，避免误伤日期与分数写法
const POSIX_PATH_RE = /(?:\/(?:[A-Za-z0-9._\-\u0080-\uFFFF]+|~))(?:\/[A-Za-z0-9._\-\u0080-\uFFFF]+)+/g;
const MYSQL_CRED_RE = /(for user|identified by|password)\s*=?\s*'[^']*'/gi;
// MySQL 报错里跟在账号后面的 `@'host'`（内网 IP / 主机名同样属于主机信息）
const MYSQL_HOST_RE = /@\s*'[^']*'/g;
const CLI_ARG_RE = /(--(?:password|user|host|result-file|database)=)[^\s]+/gi;

export interface SanitizeOptions {
  /** 完全抹干净时的兜底文案 */
  fallback: string;
  /** 摘要最大长度，默认 200 字符 */
  maxChars?: number;
}

export function sanitizeOpsMessage(raw: string | undefined | null, options: SanitizeOptions): string {
  const firstLine = String(raw ?? "").split(/\r?\n/)[0] ?? "";
  const redacted = firstLine
    .replace(WINDOWS_PATH_RE, "<路径>")
    .replace(POSIX_PATH_RE, "<路径>")
    .replace(MYSQL_CRED_RE, "$1 '<已脱敏>'")
    .replace(MYSQL_HOST_RE, "@'<已脱敏>'")
    .replace(CLI_ARG_RE, "$1<已脱敏>")
    .replace(/\s{2,}/g, " ")
    .trim();
  const maxChars = options.maxChars ?? 200;
  // 只剩占位符/标点的（原本整句就是一个路径）没有对外价值，回落到固定文案。
  // 判据刻意只认「占位符之外没有实质字符」，不能顺手把中文错误也吞掉——
  // 中文摘要同样要留给管理员自查。
  const residue = redacted
    .replace(/<路径>|<已脱敏>/g, "")
    .replace(/[\s:：,，。.;；()（）[\]{}\-_/\\|"']+|^[A-Za-z]:$/g, "");
  if (residue === "") return options.fallback;
  return redacted.length > maxChars ? `${redacted.slice(0, maxChars)}…` : redacted;
}

/** 给健康检查/日志用：判断一句消息是否仍含主机路径（回归脚本用得上）。 */
export function containsHostPath(message: string): boolean {
  return /(?:[A-Za-z]:[\\/]|\\\\)[^\s"',;)]*/.test(message)
    || /(?:\/(?:[A-Za-z0-9._\-\u0080-\uFFFF]+|~))(?:\/[A-Za-z0-9._\-\u0080-\uFFFF]+)+/.test(message);
}
