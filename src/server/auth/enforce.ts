/**
 * 鉴权强制模式判定 —— 全局唯一真相源。
 *
 * 所有需要判断「是否开启强制鉴权」的地方都必须调用本函数，
 * 禁止在各自模块里用不同的字面量散落判断，否则会出现语义相反的 bug
 * （如 authMiddleware 默认放行、而 createApp 默认强制）。
 *
 * 判定规则（与 createApp 历史行为一致）：
 *   - 显式设为 "0" / "false" → 关闭强制（向后兼容「未登录即可使用」的开发模式）
 *   - 未设置 / 其它任意值（含 "1"/"true"/"yes"/"on"）→ 开启强制
 */
export function resolveEnforceAuth(): boolean {
  const v = process.env.PROJECTX_AUTH_ENFORCE;
  return v !== "0" && v !== "false";
}
