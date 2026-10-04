/**
 * 日志脱敏：把 URL 里的凭据类查询参数打码（安全 R30）。
 *
 * 服务端没有请求体/URL 访问日志，真正会记住 `?token=` / `?mt=` 的地方是
 * ① 异常信息里带出的完整 URL（例如侧车/微信接口调用失败时抛出的 message），
 * ② 反向代理的 access_log（由部署方按 readus 的说明配置）。
 * 这里先把 ① 管住：任何要写进日志的字符串都过一次本函数，凭据只剩前 6 位可供对账。
 */

const CREDENTIAL_PARAMS = ["token", "mt", "access_token", "api_key", "apikey", "key"];

/** 打码 URL 查询串中的凭据参数；非 URL 字符串原样返回（只做子串替换）。 */
export function redactUrlCredentials(input: unknown): string {
  if (input == null) return "";
  const text = String(input);
  if (!text.includes("?")) return text;
  let redacted = text;
  for (const name of CREDENTIAL_PARAMS) {
    // `?token=abc&…`、`&mt=abc` 两种位置都要盖住；值到下一个 & / 引号 / 反引号 / 空白为止。
    // 这里用普通单引号串拼正则而不是模板串：字符类里含反引号，模板串会被它截断。
    const pattern = new RegExp('([?&]' + name + '=)([^&\\s"\'`]{1,})', "gi");
    redacted = redacted.replace(
      pattern,
      (_match, prefix: string, value: string) => `${prefix}${value.slice(0, 6)}***`
    );
  }
  return redacted;
}

/**
 * 供 `console.error` 使用的错误副本：message 与 stack 里的凭据一并打码。
 * 保留原对象不动，避免影响上层对 error 的判型与重试逻辑。
 */
export function safeErrorForLog(error: unknown): unknown {
  if (error instanceof Error) {
    const copy: Error & { cause?: unknown } = new Error(redactUrlCredentials(error.message));
    copy.name = error.name;
    copy.stack = error.stack ? redactUrlCredentials(error.stack) : copy.stack;
    if ("cause" in error) (copy as { cause?: unknown }).cause = error.cause;
    return copy;
  }
  return redactUrlCredentials(error);
}

/** Authorization 头的脱敏（只留方案名与指纹前缀）。 */
export function redactAuthorizationHeader(header: unknown): string {
  const value = String(header ?? "");
  if (!value) return "";
  const [scheme, credential] = value.split(/\s+/);
  if (!credential) return `${scheme ?? ""} ***`;
  return `${scheme} ${credential.slice(0, 6)}***`;
}
