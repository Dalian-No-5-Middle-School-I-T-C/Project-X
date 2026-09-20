# 30 扫描端远程模式指南推荐HTTP传输凭据

- 原标题：Scanner remote-mode guide exposes credentials over HTTP
- 云端级别：中危（Medium）
- 原始报告：[打开报告](https://chatgpt.com/codex/cloud/security/findings/bb4738134740819191f3b5e307143d73?repo=https%3A%2F%2Fgithub.com%2FDalian-No-5-Middle-School-I-T-C%2FProject-X&sev=&page=2)
- 关联提交：[047b91e](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/commit/047b91efd57e23785101164081700bdbead80710)

- 页面时间：2026 年 6 月 28 日 21:12（原页面未注明时区）。
- 操作者：xiaoxu66609。

## 概要

此问题由本次修改引入。客户端此前已经接受任意 HTTP 服务器 URL，但本次变更新增最终用户说明，主动推荐远程扫描使用明文局域网端点，使不受传输保护的高价值凭据和教育记录发送成为受支持的部署路径。

新文档在扫描 API 密钥说明旁给出 http://192.168.1.100:5174 示例，没有要求 HTTPS，也没有警告 HTTP 只适合回环开发。客户端不检查协议，将该值作为全部 API 的基址。登录 JSON 包含用户名和密码，后续请求头包含扫描密钥及 Bearer，远程上传也通过同一连接发送学生答题图片。能够观察或修改校内局域网流量的人，可捕获可复用的教师／管理员凭据、会话及扫描密钥，读取图片或篡改请求。扫描密钥能认证上传，用户凭据和令牌则授予更广的角色权限。指南应改为 HTTPS，明确所有非回环连接必须使用 TLS；客户端也应拒绝明文远程连接，除非是显式且仅限回环的开发模式。

## 验证

1. 确认本次提交将非回环明文示例及密钥说明新增到用户可访问的指南。
2. 最近的 URL 控制接受该 HTTP 地址，没有 TLS、回环限制或警告。
3. 生产传输函数证明，登录凭据及扫描密钥会以明文到达 HTTP 接收方。
4. 后续 Bearer／密钥和 multipart 答题图片使用同一明文基址。
5. 追踪出厂扫描包、登录令牌、上传路由及可复用密钥认证，确定现实可达性和影响。

### 验证输出结果

原页面提供验证输出入口；附件内容未包含在已归档的页面正文中。

## 证据注释

1. 发往配置基址的 JSON 请求附带可复用 Bearer 或密钥，没有安全协议要求。
2. 登录 identifier／password 经该基址发送，遵循 HTTP 示例就会在传输途中暴露。
3. 远程创建会话及上传每张扫描图片，也通过相同的已认证连接。
4. 新远程说明把密钥与明确 HTTP 示例并列，没有 HTTPS 要求。

## 攻击路径分析

成功截获可复用机器或用户身份、答题图片，并影响扫描提交完整性，技术后果为高。发生可能性为中，因为需要本地网络位置、用户交互；产品默认本地模式，绑定回环地址的 Node 之外还需可达局域网代理或监听器。另一份部署指南要求 HTTPS，是有意义的反向证据，但产品指南和占位文字明确推荐明文，客户端又不强制 TLS，因此不能否定问题。不适用强制排除：攻击者是匿名低权限局域网用户，影响不限于本人；遵循文档是现实产品操作，而不是攻击者必须进行的特权写入。高影响与中等可能性得到中危，仍可报告。

### 路径

操作者遵循产品指南 → 填写 HTTP URL 和密钥后登录或扫描 → 客户端采用明文基址 → 没有 TLS 地传输认证及教育记录 → 匿名局域网在途攻击者观察或修改请求响应 → 捕获密码、密钥、Bearer、上传令牌及答题图片 → 重放身份或修改扫描内容 → 调用 Project-X 登录或上传 API。

操作者按打包指南配置示例地址和管理员签发的密钥，然后登录或上传。URL 没有协议检查，生产函数以明文发送密码请求体、X-Api-Key、Bearer、每页令牌及图片。匿名局域网在途攻击者可以捕获或篡改。可执行验证使用生产 URL 和请求头辅助函数，在 HTTP 接收端观察到每类数据。现有控制包括回环监听、默认本地模式、可撤销范围密钥、认证上传及另一份 HTTPS 指南；它们降低发生可能性，却不能保护遵循相冲突产品 HTTP 说明的用户。问题跨越真实局域网信任边界，损害身份及学生数据，因此不是仅影响本人、仅用于开发或需要攻击者特权的路径。

## 发生可能性

中。一旦使用明文端点，技术利用简单，无需 Project-X 账号，打包指南和界面占位文字都推荐该 URL。不过，攻击者需要位于受害者局域网路径，操作者需要选择远程而非默认本地模式，回环服务也需要额外局域网入口。相冲突的 HTTPS 指南进一步降低此类部署的普遍性，因此为中而非高。

## 影响程度

高。可以泄露可复用密码、Bearer、扫描密钥、上传令牌，以及可识别学生身份的答题图片。扫描密钥能够认证提交，用户凭据赋予更广权限，主动截获还能破坏扫描完整性。身份及教育数据影响较高，但受影响群体和权限等级取决于经过连接的账号及密钥。

## 假设条件

- 操作者遵循产品指南或登录占位文字，配置可访问的明文局域网地址。
- 匿名攻击者能够观察或修改扫描机的本地网络路径。
- Node 绑定回环地址，另有操作者配置的局域网监听器或代理使示例可达。

原文另列前提：

- 远程配置使用非回环 HTTP。
- 学校局域网存在可达 HTTP 端点。
- 受害者通过该端点输入凭据或上传。
- 攻击者处于传输路径中，或能够观察和修改局域网流量。

## 控制措施

- Node 不直接监听局域网，只绑定 127.0.0.1。
- 文档默认采用本地扫描。
- 另一份指南推荐 Nginx，并明确生产使用 HTTPS。
- 上传要求有效 scanner／full 密钥或用户会话。
- 密钥有范围和活动状态检查，并且可以撤销。
- 这些认证授权不能保护传输机密性，仍会接受从明文流量捕获的有效凭据。

## 盲点

- 没有清单证明具体局域网监听器、代理、负载均衡或示例地址的部署；Node 直接仅绑定回环地址。
- 概念验证使用 HTTP 捕获服务，而非实体校园网主机或抓包器，但执行了生产 URL 和请求头代码。
- 没有运行完整 TWAIN，密码及密钥暴露不依赖硬件。
- 静态分析不知道扫描机登录人数和权限分布。
- 同一示例此前已经存在于 readus/多端使用说明.md；本次提交是将其新增分发到主要产品内指南，而不是首次创造全部行为。

## 证据代码

文件名后的数字是该片段在报告所关联提交中的首行行号；不连续的片段分别列出。

### [src/apps/answer-card/client/auth/api.ts:48](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/047b91efd57e23785101164081700bdbead80710/src/apps/answer-card/client/auth/api.ts#L48)

~~~~typescript
export async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const token = getAuthToken();
  // v1.6.0: 同时支持 Api-Key header
  const storedApiKey = (() => { try { return localStorage.getItem("projectx_api_key"); } catch { return null; } })();
  const headers = new Headers(options?.headers);
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  if (storedApiKey && !headers.has("X-Api-Key")) {
    headers.set("X-Api-Key", storedApiKey);
  }
  const response = await fetch(apiUrl(url), { ...options, headers });
~~~~

### [src/apps/answer-card/client/auth/AuthContext.tsx:123](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/047b91efd57e23785101164081700bdbead80710/src/apps/answer-card/client/auth/AuthContext.tsx#L123)

~~~~tsx
  const login = useCallback(async (identifier: string, password: string, isPersistent?: boolean) => {
    const result = await fetchJson<LoginResponse>("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier, password, isPersistent: !!isPersistent })
    });
    setAuthToken(result.token);
~~~~

### [src/apps/answer-card/client/components/ScannerPanel.tsx:198](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/047b91efd57e23785101164081700bdbead80710/src/apps/answer-card/client/components/ScannerPanel.tsx#L198)

~~~~tsx
      const createRes = await authFetch("/api/scanner/upload/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cardId,
          name: `扫描_${cardId}_${new Date().toISOString().slice(0, 10)}`,
          dpi, paperSize, pageCount: pages.length,
        }),
      });
      if (!createRes.ok) throw new Error("创建远程会话失败");
      const { sessionId: remoteSessionId, uploadTokens } = await createRes.json() as { sessionId: string; uploadTokens: string[] };

      // Step 2: 逐页上传图片
      for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        const token = uploadTokens[i];
        setUploadMsg(`正在上传第 ${page.pageNum} 页 (${i + 1}/${pages.length})...`);

        // 获取本地图片并上传
        const imageRes = await authFetch(`/api/scanner/scan-image/${page.recordId}`);
        if (!imageRes.ok) continue;
        const blob = await imageRes.blob();

        const form = new FormData();
        form.append("image", blob, `page_${page.pageNum}.jpg`);
        form.append("token", token);
        form.append("pageNum", String(page.pageNum));
        form.append("side", page.side);

        const uploadRes = await authFetch(`/api/scanner/upload/sessions/${remoteSessionId}/pages`, {
          method: "POST",
          body: form,
        });
        if (!uploadRes.ok) {
          console.error(`Page ${page.pageNum} upload failed`);
        }
      }

      // Step 3: 标记完成
      await authFetch(`/api/scanner/upload/sessions/${remoteSessionId}/complete`, { method: "POST" });
~~~~

### [user guide/Project-X用户使用说明.md:154](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/047b91efd57e23785101164081700bdbead80710/user guide/Project-X用户使用说明.md#L154)

~~~~markdown
### 5.4 扫描端远程模式

扫描端支持 **本地** 与 **远程** 双模，在扫描工作台上方切换：

| 模式 | 数据存储 | 扫描图片 | 答题卡来源 |
|------|---------|---------|-----------|
| **本地**（默认） | 本机 SQLite | 本机 | 本机数据库 |
| **远程** | 远端服务器 | 上传到远端 | 远端 API |

**远程模式配置**：在登录页展开 **「服务器连接（可选）」**，填入：

- **服务器地址**：如 `http://192.168.1.100:5174`
- **API Key**：管理员在账号设置 → API Key 中生成的扫描专用 Key

扫描完成后自动三步上传：创建会话 → 逐页上传图片 → 标记完成。
~~~~
