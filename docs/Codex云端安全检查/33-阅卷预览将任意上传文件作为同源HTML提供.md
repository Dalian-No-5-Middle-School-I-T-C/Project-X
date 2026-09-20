# 33 阅卷预览将任意上传文件作为同源HTML提供

- 原标题：Grading previews serve arbitrary uploads as same-origin HTML
- 云端级别：中危（Medium）
- 原始报告：[打开报告](https://chatgpt.com/codex/cloud/security/findings/198b4cb5d2d081919341f2c2cc435ad7?repo=https%3A%2F%2Fgithub.com%2FDalian-No-5-Middle-School-I-T-C%2FProject-X&sev=&page=2)
- 关联提交：[43ae248](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/commit/43ae248f04068b5f741a34c709f804cba7da34ae)

- 页面时间：2026 年 6 月 13 日 21:08（原页面未注明时区）。
- 操作者：Toyama Kasumi。

## 概要

此问题由本次修改引入。父版本已经在不验证类型的情况下保存判分上传，但该目录不对 Web 开放。本次提交新增预览 URL 和 sendFile，将已有弱点转化为持久化同源跨站脚本攻击。应限制上传为已验证图片，生成固定安全扩展名，并为预览固定图片 Content-Type、添加 nosniff；也可以强制作为附件下载，或从独立来源提供转换后的图片。预览还应要求认证，并检查答题卡和考试范围。

Multer 保留攻击者提供的原文件扩展名，只限制大小，没有扩展名、MIME 或魔数检查。两个判分处理器即使原生识别失败，也会返回预览 URL。新增预览直接调用 res.sendFile，Content-Type 由可控扩展名决定，不强制下载，也不设置沙箱。该版本的上传和预览均无认证授权。匿名用户可从答题卡 API 取得 ID，通过 files 上传 payload.html；即使识别失败仍能取得 URL，再诱使教师或管理员访问合法的同源链接。HTML 将以 Project-X 来源执行，可以发起同源请求、读取可访问数据、修改浏览器状态或显示窃取凭据的界面。客户端有意在新标签页打开预览，rel=noreferrer 限制 opener，却不能阻止文档脚本执行。

## 验证

1. 攻击者控制的 multipart 文件名和内容以活动扩展名进入识别存储，没有类型或认证控制。
2. 识别失败仍会返回持久化载荷的稳定 URL。
3. 匿名预览以内联 text/html 返回，没有 attachment、CSP 或 nosniff。
4. 现实 HTTP 上传到预览的复现确认，载荷在重启后仍存在，并可精确取回。
5. 直接导航是现实操作，客户端链接没有沙箱；浏览器自动化尝试因缺少系统库而受阻。

### 验证输出结果

原页面提供验证输出入口；附件内容未包含在已归档的页面正文中。

## 证据注释

1. 界面直接导航至预览，新标签页的 noreferrer 不会添加沙箱或禁用脚本。
2. 上传保留不可信扩展名，没有类型或内容验证。
3. 客观题判分抛错后仍返回 URL，使非图片 HTML 仍可取得。
4. 合并判分无论成功或失败，同样暴露预览。
5. 新路由按扩展名内联提供文件，.html 可以在应用来源下执行。

## 攻击路径分析

不适用排除规则：影响不限于本人，攻击者匿名且不具高权限，使用正常上传流程，受害者导航也是现实前提。源码及 HTTP 验证确立了可控输入、持久存储、内联 HTML 和缺少路由授权。最强反向证据是 index.ts:697–704 的回环绑定，但威胁模型明确包含代理或隧道；缺少入口资料会降低确信程度，不能机械地将其改判为仅限本机。影响为中，因为同源脚本损害机密性、完整性和来源信任，但未证明令牌窃取、管理员接管或广泛改分。在可达部署中，匿名路径确定且已演示，虽然需要交互，发生可能性仍高。中等影响与高可能性得到中危。

### 路径

匿名远程用户 → 上传自选 .html 文件名及 HTML 字节 → 公开 Multer 上传 → 生成文件名保留 .html → 持久保存在 recognition/uploads/`<cardId>` → 识别失败仍暴露 URL → 公开 sendFile → 返回没有 CSP、nosniff 或 attachment 的 text/html → 教师或管理员导航至该地址 → 以应用来源执行 → 来源 API、数据和可信界面受到影响。

Express 判分是使用 SQLite 及持久上传存储的生产组件。配置使用 path.extname(file.originalname)，匿名用户能够保存 .html。两个处理器在成功或异常时都给出 URL；预览没有认证、固定图片类型、下载处置、CSP 或 nosniff。HTTP 复现确认匿名创建和列出答题卡、上传 HTML、重启后保留，以及返回逐字节相同的 text/html;charset=utf-8。应用的 target=_blank 加 noreferrer 限制 opener，但不提供沙箱。其他反向证据包括需要导航、React 转义、basename／safeId、存在却未使用的防护中间件，以及没有直接观察浏览器执行。这些都不能阻止该入口：威胁模型允许代理，React 不渲染这份直接响应，目录穿越控制不限制媒体类型，路由未挂认证，已证明的内联 HTML 会产生确定的标准浏览器行为。不过，交互要求、缺少入口资料及未证明 Bearer 窃取，使影响限定为中。

## 发生可能性

高。代理部署中，匿名利用复杂度低，答题卡可以公开列出或创建，文件字节和扩展名任意，失败后仍取得可用 URL，HTTP 全部存储和交付链已验证。用户交互和实际代理情况未知属于限制，但同源判分预览是可信的社会工程材料，不需要竞争、秘密或高权限写入。攻击向量为远程网络。

## 影响程度

中。可信来源脚本可以读取该来源允许读取的响应、调用可访问操作、修改界面或实施钓鱼，跨越匿名用户到教师／管理员浏览器的边界。不评为高，是因为需要导航，该版本使用显式 Bearer，而不是已证明自动附带的高权限 Cookie；没有证明令牌窃取或接管，而且若干 API 本就允许匿名访问。

## 假设条件

- 按威胁模型通过代理或 Cloudflare 向学校提供访问，仓库没有入口清单。
- 前端和预览同源，相对 URL 及路由组合支持这一点。
- 教师或管理员可能被社会工程，或在处理判分内容时被诱导打开 URL。
- 普通浏览器执行内联 HTML，没有阻断 CSP 或强制下载。

原文另列前提：

- 部署通过配置的代理或隧道可达。
- 存在有效答题卡 ID，可匿名列出或创建。
- multipart 文件不超过 20 MiB，原始文件名使用 .html 等活动扩展名。
- 教师或管理员打开返回的或攻击者提供的 URL。

## 控制措施

- 没有代理时，回环绑定限制直接暴露。
- 单次上传限制为 20 MiB，但不限制为图片。
- safeId 和 basename 防止目录穿越，不防止活动内容。
- target=_blank／noreferrer 限制 opener 和 referrer，不禁用文档脚本。
- React 转义与该路径无关，因为文档由 Express 直接交付。
- 其他位置的 Bearer 中间件没有挂在答题卡、判分或预览路由上。
- 虽然执行识别，但成功失败都公开文件，因此拒绝识别不能缓解问题。

## 盲点

- 没有代理、隧道、Kubernetes 或负载均衡清单，公网暴露依据威胁模型。
- 缺少 libatk-1.0.so.0，Electron 无法启动，未观察实际 JavaScript 执行；但已证明没有沙箱的内联 HTML 前提。
- 环境缺少已声明的 bcrypt 原生包，验证只为启动使用惰性管理员种子记录，没有修改受影响路由或上传逻辑。
- 未证明该版本高权限 Bearer 位于可读存储中，或预览会自动发送它，因此不声称接管或已认证管理操作。
- 不知道链接分发方式、外部链接打开频率，以及外部代理是否添加 CSP、nosniff 或 Content-Disposition。

## 证据代码

文件名后的数字是该片段在报告所关联提交中的首行行号；不连续的片段分别列出。

### [src/apps/answer-card/client/App.tsx:987](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/43ae248f04068b5f741a34c709f804cba7da34ae/src/apps/answer-card/client/App.tsx#L987)

~~~~tsx
                {row.previewUrl ? (
                  <a
                    className="score-preview-link"
                    href={row.previewUrl}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(event) => event.stopPropagation()}
~~~~

### [src/apps/answer-card/server/index.ts:219](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/43ae248f04068b5f741a34c709f804cba7da34ae/src/apps/answer-card/server/index.ts#L219)

~~~~typescript
  const recognitionUpload = multer({
    storage: multer.diskStorage({
      destination: async (req, _file, cb) => {
        const cardId = safeId(paramValue(req.params.cardId));
        const dir = path.join(dataDir, "recognition", "uploads", cardId);
        await mkdir(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase() || ".png";
        const name = `scan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
        cb(null, name);
      }
    }),
    limits: { fileSize: 20 * 1024 * 1024 }
~~~~

### [src/apps/answer-card/server/index.ts:389](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/43ae248f04068b5f741a34c709f804cba7da34ae/src/apps/answer-card/server/index.ts#L389)

~~~~typescript
          rows.push({
            ...gradeObjectiveRecognition(card, file.originalname || path.basename(file.path), recognition),
            previewUrl: gradingPreviewUrl(cardId, file.path)
          });
        } catch (error) {
          const recognition: ObjectiveRecognitionResult = {
            status: "failed",
            imagePath: file.path,
            pageNumber,
            message: error instanceof Error ? error.message : String(error),
            questions: []
          };
          rows.push({
            ...gradeObjectiveRecognition(card, file.originalname || path.basename(file.path), recognition),
            previewUrl: gradingPreviewUrl(cardId, file.path)
          });
~~~~

### [src/apps/answer-card/server/index.ts:450](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/43ae248f04068b5f741a34c709f804cba7da34ae/src/apps/answer-card/server/index.ts#L450)

~~~~typescript
          rows.push({
            ...gradeCombinedRecognition(card, file.originalname || path.basename(file.path), recognition),
            previewUrl: gradingPreviewUrl(cardId, file.path)
          });
        } catch (error) {
          const recognition: CombinedRecognitionResult = {
            status: "failed",
            imagePath: file.path,
            pageNumber,
            message: error instanceof Error ? error.message : String(error),
            questions: [],
            subjectiveQuestions: []
          };
          rows.push({
            ...gradeCombinedRecognition(card, file.originalname || path.basename(file.path), recognition),
            previewUrl: gradingPreviewUrl(cardId, file.path)
~~~~

### [src/apps/answer-card/server/index.ts:489](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/43ae248f04068b5f741a34c709f804cba7da34ae/src/apps/answer-card/server/index.ts#L489)

~~~~typescript
  app.get("/api/cards/:cardId/grading/preview/:fileName", (req, res, next) => {
    try {
      const cardId = safeId(paramValue(req.params.cardId));
      const fileName = path.basename(paramValue(req.params.fileName));
      const targetPath = path.join(dataDir, "recognition", "uploads", cardId, fileName);
      if (!existsSync(targetPath)) {
        res.status(404).json({ message: "答题卡图片不存在" });
        return;
      }
      res.sendFile(targetPath);
~~~~
