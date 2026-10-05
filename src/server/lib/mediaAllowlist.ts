/**
 * URL 凭据可访问的媒体端点白名单（安全 R30）。
 *
 * 跨域 API 模式下，前端要把 PDF / 图片 / SSE 的地址直接交给浏览器（`<img src>`、
 * `<a href>`、`window.open`、`EventSource`），没法带 Authorization 头，于是历史上把
 * **主会话令牌**拼进了 `?token=`。问题是后端对 `?token=` 一视同仁：主令牌能读任意 GET 接口，
 * 而 URL 会进浏览器历史、代理与访问日志——泄漏一次等于整份只读权限外泄。
 *
 * 现在的口径：
 *  - `?mt=`（单次资源票据）按「用户 + 具体路径 + 方法 + 时限」放行，见 `services/mediaTicket.ts`；
 *  - `?token=`（主会话令牌）**只**允许命中本白名单的只读媒体端点，其余一律要求走头/Cookie。
 * 白名单按「这条 URL 会不会被浏览器自己发出去」来选，而不是按权限：数据类 GET 一律不在其中。
 */

/**
 * 逐条对照过真实路由注册（`app.get` / `router.get`）后确定的清单，模式与挂载前缀一一对应。
 * 注意：本注释里不能出现「星号紧跟斜杠」的路径写法，它会提前关闭块注释；示例一律用 `:id` 形式。
 *  - `/api/cards/:id`（index.ts、paper-routes.ts）：pdf / layout / export / paper（含 `?format=image`、`?page=`）
 *    与判分 preview / progress SSE；
 *  - `/api/answer-block-crops/:id/image`（cropGate）：学生「我的作答」与网阅切块图；
 *  - `/api/scanner/:sessionId`（createScannerRouter）：进度 SSE、扫描页图、判分图；
 *  - `/api/exams/:id/answer-key/pages/:index/image`、`/api/scores/me/exams/:id/paper`（含 pages 变体）。
 *
 * 刻意不收录：CSV/JSON 数据导出（`export-csv`、`export-wrong`、`students.csv` 名册）——它们在前端一律走
 * `downloadBlob` 配 `authFetch`，凭据在请求头里，浏览器不会自己发这个 URL，没有放进白名单的必要；
 * 以及任何返回业务数据的 GET。曾经写过的「卡内单页图」与「我的作答切块图」两条路径并无对应路由，
 * 已随本次核对删除。
 */
const PATTERNS: RegExp[] = [
  // 答题卡插图资源（<img src>）
  /^\/api\/assets\/[^/]+\/[^/]+$/,
  // 卡版式导出 / PDF / JSON 导出 / 原卷页（下载与新窗口打开）
  /^\/api\/cards\/[^/]+\/pdf$/,
  /^\/api\/cards\/[^/]+\/layout$/,
  /^\/api\/cards\/[^/]+\/export$/,
  /^\/api\/cards\/[^/]+\/paper$/,
  // 判分预览图与进度 SSE
  /^\/api\/cards\/[^/]+\/grading\/preview\/[^/]+$/,
  /^\/api\/cards\/[^/]+\/grading\/progress\/[^/]+$/,
  // 切块图（网阅、逐题明细）
  /^\/api\/answer-block-crops\/[^/]+\/image$/,
  // 扫描端：进度 SSE、扫描页图、判分图
  /^\/api\/scanner\/progress\/[^/]+$/,
  /^\/api\/scanner\/scan-image\/[^/]+$/,
  /^\/api\/scanner\/grading-image\/[^/]+\/[^/]+$/,
  // 标准答案页图
  /^\/api\/exams\/\d+\/answer-key\/pages\/[^/]+\/image$/,
  // 学生端我的原卷 / 作答页
  /^\/api\/scores\/me\/exams\/\d+\/paper$/,
  /^\/api\/scores\/me\/exams\/\d+\/paper\/pages\/\d+\/image$/,
];

/**
 * 判断「GET/HEAD 的媒体请求」是否允许从 URL 取凭据。
 * 路径按去掉查询串后的 pathname 比较；查询串本身不参与匹配（`?v=`、`?page=` 等不影响端点身份）。
 */
export function isUrlCredentialAllowedPath(pathname: string): boolean {
  if (!pathname.startsWith("/api/")) return false;
  return PATTERNS.some((pattern) => pattern.test(pathname));
}

/** 给错误信息与文档用的清单（只到模式层，不暴露实现细节）。 */
export function describeUrlCredentialAllowlist(): string {
  return `${PATTERNS.length} 组只读媒体端点（资源图/PDF/导出/SSE）`;
}
