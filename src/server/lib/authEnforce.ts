/**
 * 鉴权强制判定 —— 全局唯一真源。
 *
 * 由环境变量 PROJECTX_AUTH_ENFORCE 控制：
 *   - "0" / "false"（大小写敏感）：关闭强制，仅解析身份，无 token 也放行
 *     （“未登录即可使用”的兼容模式）。
 *   - 其它任何取值（含未设置、空字符串、"1"、"true"、"yes" 等）：开启强制，
 *     受保护路由必须携带有效 Bearer Token / Cookie。
 *
 * 历史 bug：曾存在两份判定（`server/index.ts` 的 createApp 与
 * `server/middleware/auth.ts` 的 authMiddleware），语义相反，导致环境变量未设置时
 * 一边认为强制、一边放行。此处收敛为同一函数，且每次调用实时读取 env，
 * 避免模块级常量在进程启动时一次性快照带来的二次漂移。
 */
export function isAuthEnforced(): boolean {
  const v = process.env.PROJECTX_AUTH_ENFORCE;
  return v !== "0" && v !== "false";
}
