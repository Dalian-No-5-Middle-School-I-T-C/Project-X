# 39 赞助二维码API绕过身份认证

- 原标题：Sponsor QR API bypasses authentication
- 云端级别：低危（Low）
- 原始报告：[打开报告](https://chatgpt.com/codex/cloud/security/findings/fcedf7b99a588191b3d12afe217abb65?repo=https%3A%2F%2Fgithub.com%2FDalian-No-5-Middle-School-I-T-C%2FProject-X&sev=&page=2)
- 关联提交：[e60693f](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/commit/e60693fdaeaec0a05442581af42e9b84f2bf18b0)

- 页面时间：2026 年 6 月 15 日 21:43（原页面未注明时区）。
- 操作者：xiaoxu66609。

## 概要

本次提交新增并挂载两个赞助 GET 端点，却没有强制认证。已有的可选认证不会拒绝匿名用户，后续授权入口也不覆盖这些端点。

应用只在 /api/sponsor 之前应用 optionalAuth，没有令牌时仍会继续。路由没有 authMiddleware 或 req.user 检查，并且挂载在权限入口之前，不在其覆盖范围内。因此，即使启用 PROJECTX_AUTH_ENFORCE，互联网用户仍可通过 GET 枚举启用的支付渠道，再通过 GET /api/sponsor/qr/:channelId 取得支付二维码。这违反文档中仅面向已登录学生、教师和管理员的政策，前端登录检查不能保护直接 API 请求。当前提交没有二维码文件，但明确预期在运行时配置并启用。结果可能披露二维码中的支付账号或收款人身份，并允许匿名抓取及盗链。由于不涉及学业记录、凭据或修改操作，影响有限。路由应强制认证；img 不能设置 Bearer 请求头，客户端可以通过 authFetch 获取图片，再显示 blob URL。

## 验证

1. 在同一个设置 AUTH_ENFORCE=1 的真实进程中，匿名赞助请求返回 200，而受保护答题卡请求返回 401。
2. 确认 optionalAuth 始终继续执行，路由没有用户检查，后续专用权限入口也不覆盖它，因此不要求 req.user。
3. 配置启用渠道后，匿名请求返回 200 和 image/png，源文件与响应的 SHA-256 相同。
4. readus/SPONSOR-PAGE.md 规定受众为已登录的三类角色，匿名访问与该受众政策冲突。
5. 文档支持运行时配置二维码，默认则没有文件；外部可达性取决于受支持的代理或隧道部署，影响范围有限。

### 验证输出结果

原页面提供验证输出入口；附件内容未包含在已归档的页面正文中。

## 证据注释

1. 文档将受众设为所有已登录用户，匿名访问超出预期。
2. 新路由之前只有可选身份解析，位于后续角色访问控制之外。
3. optionalAuth 明确允许不带令牌的请求。
4. 两个处理器都没有强制认证或用户检查，直接返回配置或二维码。

## 攻击路径分析

事实评估为低影响、高发生可能性；矩阵中，任何非 ignore 可能性与低影响组合均为低危。不适用排除规则：影响不限于本人，攻击者无需运维、开发、本地、物理或认证权限；操作者启用二维码是在正常填充应用数据，不是攻击者必须取得的特权。问题存在于真实运行流程，威胁模型中的代理或隧道部署也现实可行。同时不应上调：默认没有二维码，端点只读，路径约束防止任意文件读取，材料本就预期提供给全部已登录用户。因此，最终是可报告的低危认证退化，而非忽略。

### 路径

匿名互联网用户 → 发送 GET → 部署代理或 Cloudflare → 回环 5174 服务 → optionalAuth → 没有 req.user 仍继续 → GET 赞助元数据取得渠道 ID 及二维码 URL → GET 二维码 → 从固定目录 sendFile → 获得运维配置的元数据和图片。

Express 为所有 API 先执行 optionalAuth，随后挂载没有强制认证的赞助路由，后面的权限入口也不覆盖它。元数据暴露启用渠道的 ID、名称、描述和 URL，二维码接口按启用渠道调用 sendFile。真实应用在 AUTH_ENFORCE=1 下验证：匿名答题卡请求返回 401，赞助及 qr/validation 返回 200，PNG 内容逐字节匹配。这是真实产品中的认证缺失，不只是前端正确性问题，因为直接 API 绕过登录界面。反向证据限定等级：服务绑定回环地址，默认 qrFile=null，使用固定目录，材料面向所有已登录角色，而非狭窄的高权限群体。文档中的生产公开部署及运行时启用方式，使匿名边界现实存在，但仍属于低危。

## 发生可能性

高。对于已公开且启用二维码的部署，只需两个普通 GET，无需账号、用户交互或复杂猜测，元数据会提供渠道 ID。在强制角色访问控制拒绝对照请求的同时，完整访问路径已经验证。实际二维码依赖正常运维配置，服务直接绑定回环地址，但二者都是现实部署状态，不是攻击者权限要求。攻击向量为远程网络。

## 影响程度

低。最大已证实影响是只读访问渠道元数据和配置的支付二维码，其中可能含收款人身份。没有凭据、学业记录、任意文件、代码执行或状态修改；这些材料本就预期广泛提供给已登录角色。

## 假设条件

- 部署按威胁模型通过代理或隧道公开回环服务。
- 操作者可按文档为启用渠道配置 qrFile，并将文件放入 data/sponsor/qr/。
- 尽管验证清单使用不带凭据的本地 curl，请求受众应为已登录三类角色的表述仍代表预期政策。

原文另列前提：

- 攻击者可通过常见代理或隧道访问 API。
- 披露真实二维码需要渠道启用、配置文件名且文件实际存在。
- 不需要账号、Bearer、Cookie、用户交互或特权攻击操作。

## 控制措施

- 强制认证开关只保护选定前缀，不包含赞助路由。
- authMiddleware 可以强制 Bearer 或查询令牌认证，但这里没有使用。
- optionalAuth 解析已提供的令牌，同时有意允许匿名请求。
- 前端没有用户时隐藏应用或菜单，但这不是后端控制。
- 只返回并提供 enabled 渠道。
- 二维码必须配置，且文件存在。
- basename 和固定目录防止任意路径访问。
- 回环监听降低未转发部署的暴露。
- 没有限流来阻止匿名枚举、抓取或盗链。

## 盲点

- 没有具体入口或防火墙清单确定每个实例的暴露。
- 默认没有真实支付二维码，无法静态确定真实内容的敏感性。
- 不带凭据的 curl 与已登录受众之间存在尚未解决的意图歧义。
- 没有生产缓存、CDN、日志或防盗链配置，无法确定保留和再次分发行为。
- 由于缺少 bcrypt，概念验证使用启动专用兼容桩；匿名处理器及受保护对照均不会执行 bcrypt。

## 证据代码

文件名后的数字是该片段在报告所关联提交中的首行行号；不连续的片段分别列出。

### [readus/SPONSOR-PAGE.md:13](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/e60693fdaeaec0a05442581af42e9b84f2bf18b0/readus/SPONSOR-PAGE.md#L13)

~~~~markdown
| 项目 | 说明 |
|------|------|
| **页面名称** | 支持项目（内部模式 `sponsor`） |
| **入口位置** | 右上角账号菜单 →「支持项目」 |
| **顶栏 Tab** | **不显示**（避免与工作模式并列，保持低调） |
| **适用角色** | 所有已登录用户（学生 / 教师 / 管理员） |
| **当前状态** | 接口与页面已就绪，收款码图片待部署时配置 |
~~~~

### [src/apps/answer-card/server/index.ts:317](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/e60693fdaeaec0a05442581af42e9b84f2bf18b0/src/apps/answer-card/server/index.ts#L317)

~~~~typescript
  // 在所有 /api 路由前解析身份（有 token 即挂载 req.user，无 token 放行）
  app.use("/api", optionalAuth);

  // 认证与账号控制系统路由
  app.use("/api/auth", authRoutes);
  app.use("/api/users", userRoutes);
  app.use("/api/classes", classRoutes);
  app.use("/api/teachers", teacherRoutes);
  app.use("/api/export", exportRoutes);
  app.use("/api/scores", scoreRoutes);
  app.use("/api/sponsor", sponsorRoutes);
~~~~

### [src/server/middleware/auth.ts:65](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/e60693fdaeaec0a05442581af42e9b84f2bf18b0/src/server/middleware/auth.ts#L65)

~~~~typescript
/**
 * 可选认证中间件：有 token 则解析挂载用户，无 token 也放行。
 * 用于在“未强制登录”阶段仍然记录 created_by / 区分匿名访问。
 */
export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const token = extractToken(req);
  if (token) {
    attachUser(req, token);
  }
  next();
~~~~

### [src/server/routes/sponsor.ts:46](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/e60693fdaeaec0a05442581af42e9b84f2bf18b0/src/server/routes/sponsor.ts#L46)

~~~~typescript
/** GET /api/sponsor — 赞助页配置（收款码 URL 由服务端解析） */
router.get("/", async (_req: Request, res: Response) => {
  try {
    const config = await loadSponsorConfig();
    const channels = config.channels
      .filter((channel) => channel.enabled)
      .map((channel) => {
        const qrPath = channel.qrFile ? resolveQrPath(channel.qrFile) : null;
        return {
          id: channel.id,
          name: channel.name,
          enabled: channel.enabled,
          qrUrl: qrPath ? `/api/sponsor/qr/${encodeURIComponent(channel.id)}` : null
        };
      });

    res.json({
      title: config.title,
      description: config.description,
      channels
    });
  } catch (error) {
    console.error("Sponsor config error:", error);
    res.status(500).json({ message: "赞助配置加载失败" });
  }
});

/** GET /api/sponsor/qr/:channelId — 按渠道返回收款码图片 */
router.get("/qr/:channelId", async (req: Request, res: Response) => {
  try {
    const channelId = req.params.channelId;
    const config = await loadSponsorConfig();
    const channel = config.channels.find((item) => item.id === channelId && item.enabled);
    if (!channel?.qrFile) {
      res.status(404).json({ message: "收款码未配置" });
      return;
    }

    const qrPath = resolveQrPath(channel.qrFile);
    if (!qrPath) {
      res.status(404).json({ message: "收款码文件不存在" });
      return;
    }

    res.sendFile(qrPath);
~~~~
