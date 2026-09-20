# 39 赞助二维码API绕过身份认证

- 原标题：Sponsor QR API bypasses authentication
- 云端级别：Low
- 原始报告：[打开报告](https://chatgpt.com/codex/cloud/security/findings/fcedf7b99a588191b3d12afe217abb65?repo=https%3A%2F%2Fgithub.com%2FDalian-No-5-Middle-School-I-T-C%2FProject-X&sev=&page=2)
- 关联提交：[e60693f](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/commit/e60693fdaeaec0a05442581af42e9b84f2bf18b0)

## 概要

本提交在 optionalAuth 后挂载两个 GET /api/sponsor 端点，未用 authMiddleware 或 req.user，且后续 RBAC 前缀门禁不覆盖它。optionalAuth 对无令牌直接继续，因此即使 PROJECTX_AUTH_ENFORCE 开启，匿名仍可枚举支付渠道，再 GET /api/sponsor/qr/:channelId 读取二维码。

文档受众为已登录学生、教师、管理员，前端登录隐藏不防直接请求。仓库默认 qrFile=null、没有真实 QR，但明确支持运行时启用。可能披露收款身份／支付元数据并允许抓取、盗链，不含学业记录或写操作。建议路由要求认证；图片元素不能设 Bearer 时用 authFetch 获取 blob URL。

## 验证及证据

真实应用强制认证：匿名 /api/cards 为 401，同进程 sponsor 元数据和测试 QR 为 200 image/png，响应与源 PNG SHA-256 相同。代码证明只有可选身份、无后续门禁；文档说明登录用户受众。环境启动用 bcrypt shim，匿名端点与受保护对照不执行 bcrypt。

## 攻击路径与分级

匿名 GET 元数据 → 取得启用渠道 ID/名称/描述/URL → GET QR → 固定目录 sendFile。发生可能性高：公开且配置 QR 的实例只需两个 GET，无凭据、互动或复杂猜测。影响低：只读且本来对所有已认证角色公开，可能收款身份；无任意文件、凭据、学业数据或执行。功能正常配置不是攻击者特权要求，故保留低危。

## 假设、控制与盲点

运维公开服务并配置 enabled 渠道、qrFile 和 data/sponsor/qr 文件。仅启用渠道可列／读，文件须存在，basename 和固定目录阻路径穿越，回环绑定；认证中间件虽存在未挂载，前端登录无后端效力，没有抓取限流。

默认没有实际支付码，不能测真实收款信息。文档一方面说登录用户，一方面验证清单给裸 curl，存在访问意图歧义，原报告保留。未知具体公网、CDN／缓存、代理日志或防盗链策略。

## 代码证据

- [](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/e60693fdaeaec0a05442581af42e9b84f2bf18b0/readus/SPONSOR-PAGE.md#L13-L19)
- [](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/e60693fdaeaec0a05442581af42e9b84f2bf18b0/src/apps/answer-card/server/index.ts#L317-L327)
- [](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/e60693fdaeaec0a05442581af42e9b84f2bf18b0/src/server/middleware/auth.ts#L65-L74)
- [](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/e60693fdaeaec0a05442581af42e9b84f2bf18b0/src/server/routes/sponsor.ts#L46-L90)

原始页面文本和代码片段见 [结果原文](结果原文.md#结果-39)。
