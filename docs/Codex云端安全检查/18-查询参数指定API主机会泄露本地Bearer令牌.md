# 18 查询参数指定API主机会泄露本地Bearer令牌

- 原标题：Query-selected API host leaks stored bearer tokens
- 云端级别：High
- 原始报告：[打开报告](https://chatgpt.com/codex/cloud/security/findings/1ce6598757808191b579c9ac8a379332?repo=https%3A%2F%2Fgithub.com%2FDalian-No-5-Middle-School-I-T-C%2FProject-X&sev=)
- 关联提交：[7287c94](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/commit/7287c945f715ddc22f13a32a85c8f2744d9de1e8)

## 概要

本提交修正独立 Grade-Analysis-System-mobile.html 内四处字符串引号语法错误；父版本整个内联脚本不能解析，修复后原先休眠的不安全组合变得可达。API_BASE 直接读取 URL 的 api_base/apiBase，无同源或允许列表限制；脚本读取同源 localStorage 的 px_token，并在 DOMContentLoaded 自动 API.me()。apiGet 将令牌作为 Authorization 发往所选主机。

未认证攻击者诱导已通过该独立页面登录的用户打开学校原站页面、但 api_base 指向攻击者 HTTPS 主机的链接。攻击者自己批准 CORS 预检，即可收到 /api/auth/me 的 Bearer，并在过期／撤销前重放到真实学校 API，取得受害学生、教师或管理员权限。建议将 API_BASE 限于同源或明确可信允许列表，避免 localStorage 持久化令牌或向 URL 指定目标发送凭据。

## 验证与证据

验证四处修复共同使脚本从不可解析变成可执行；任意 HTTPS API 来源没有校验；正常登录会存 px_token；页面自动初始化将其附到选择的主机。脚本执行测试捕获了 fetch 目的地和 Authorization；部署文档与服务端认证代码证明独立页面发布方式及令牌可重放。缺浏览器库和真实实例，未完成真实浏览器 CORS 捕获再到活站重放的最终集成测试。

## 攻击路径与分级

匿名攻击者链接 → 受害者打开已部署同源 mobile HTML → DOMContentLoaded/API.me/apiGet → 攻击者批准预检并收到 Authorization → 重放真实学校 API → 按受害身份执行其权限范围内操作。

发生可能性高：攻击者只需 URL、可允许 CORS 的端点和受害者一次点击，凭据由正常移动页登录产生。影响程度高：泄露的是可重放凭据，教师／管理员可影响教育记录、成绩、用户和配置。无需攻击者本地／特权访问，非自身影响；但依赖可选独立页面、精确来源令牌、用户点击及足够权限受害者，故高危而非严重。

## 假设与已有控制

该 HTML 已按文档复制发布；受害者曾在其精确来源登录，px_token 仍有效；打开含 api_base/apiBase 且没有覆盖 token 参数的链接；攻击 HTTPS 主机允许受害来源及 Authorization 预检；捕获后及时重放。

令牌随机 32 字节，普通非持久会话 8 小时，可被退出、重置密码或撤销；移动页退出清除 localStorage；服务端 RBAC 限制在被盗身份范围。CORS 预检可被攻击者目标允许，不构成防线。Node 回环监听有公开隧道／Nginx 文档。独立 HTML 需部署复制，不自动在 dist/client；仅使用主客户端 HttpOnly Cookie 且无此来源 px_token 的用户不受影响。未找到该页有效 connect-src 或 API 来源校验。

## 盲点

未运行完整浏览器到攻击服务器再到真实 Project-X 的重放；未知哪些实例部署独立页、使用者数量与角色。CORS 行为虽可由攻击方控制，但未实浏览器验证。各特权端点未逐一重放，影响由身份／权限语义推导。仓库外 CSP 或代理响应头可能缓解，但没有强制证据。

## 代码证据

- [](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/7287c945f715ddc22f13a32a85c8f2744d9de1e8/Grade-Analysis-System-mobile.html#L191-L208)

原始页面文本和代码片段见 [结果原文](结果原文.md#结果-18)。
