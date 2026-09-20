# 33 阅卷预览将任意上传文件作为同源HTML提供

- 原标题：Grading previews serve arbitrary uploads as same-origin HTML
- 云端级别：Medium
- 原始报告：[打开报告](https://chatgpt.com/codex/cloud/security/findings/198b4cb5d2d081919341f2c2cc435ad7?repo=https%3A%2F%2Fgithub.com%2FDalian-No-5-Middle-School-I-T-C%2FProject-X&sev=&page=2)
- 关联提交：[43ae248](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/commit/43ae248f04068b5f741a34c709f804cba7da34ae)

## 概要

父版本已不校验阅卷上传类型，但上传目录不可通过 Web 访问；本提交新增预览 URL 与 sendFile，将旧校验缺失变成持久同源 XSS。Multer 保留 originalname 扩展名，仅限大小；原生识别成功和失败均返回预览。新路由 res.sendFile 按扩展名推导 Content-Type，无固定图片类型、强制下载、CSP 或 nosniff。该版本上传和预览都无认证。

匿名攻击者可公开取得／创建 cardId，上传 payload.html，识别失败也拿到持久 URL，诱导教师／管理员打开。HTML 在 Project-X 源执行，可读取来源可访问数据、发请求、改变页面或展示凭据钓鱼。UI 的 target=_blank、rel=noreferrer 只限制 opener/referrer，不隔离文档脚本。建议验证真实图片、固定安全扩展名与媒体类型并加 nosniff，或强制附件／独立来源转换图片，同时检查认证及卡片考试范围。

## 验证及证据

真实无认证建卡／列表、HTML 上传、重启后预览均成功，响应字节一致且 Content-Type: text/html; charset=utf-8，没有下载或沙箱头。浏览器尝试因 Electron 缺 libatk-1.0.so.0 失败，所以没有直接观察 JavaScript 执行；服务器已证明常规浏览器执行所需的内联 HTML 条件。

## 攻击路径与分级

匿名 HTML＋扩展名 → 磁盘生成文件仍 .html → 失败识别返回 URL → 公共 sendFile → 受害者导航 → 同源代码。

发生可能性高：可达代理部署下无需账号，简单且稳定，但需点击。影响程度中：同源数据与 UI 信任受影响；此版本主要是显式 Bearer，未证明能从浏览器取到令牌或自动携带特权 Cookie，多个接口原已公开，未证明接管或广泛改分。非仅自身、特权或不现实前提，最终中危。

## 假设、控制与盲点

服务按威胁模型公开，前端与预览同源，受害者打开返回链接，文件≤20 MiB；无外部阻止 HTML 的头。回环绑定、safeId/path.basename、防目录穿越、React 转义、noreferrer、别处未挂载的 Bearer 中间件和识别拒绝，都不能限制这里直接提供的活跃文档。

无具体 ingress manifest；未实际浏览器执行和令牌重放。环境缺 bcrypt 原生包，启动用惰性管理员行，不改上传／路由。未证明该版本浏览器可读令牌或自动特权认证，不主张管理员接管。真实预览传播习惯及外部 CSP/nosniff/附件头未知。

## 代码证据

- [](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/43ae248f04068b5f741a34c709f804cba7da34ae/src/apps/answer-card/client/App.tsx#L987-L993)
- [](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/43ae248f04068b5f741a34c709f804cba7da34ae/src/apps/answer-card/server/index.ts#L219-L233)

原始页面文本和代码片段见 [结果原文](结果原文.md#结果-33)。
