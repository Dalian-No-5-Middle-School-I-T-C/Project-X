# 08 无上限批注可持续阻断布局与PDF生成

- 原标题：Unbounded annotations enable persistent layout and PDF DoS
- 云端级别：高危（High）
- 原始报告：[打开报告](https://chatgpt.com/codex/cloud/security/findings/ae21198237b08191be712769f9ad01be?repo=https%3A%2F%2Fgithub.com%2FDalian-No-5-Middle-School-I-T-C%2FProject-X&sev=)
- 关联提交：[81ad500](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/commit/81ad50044fd0a070c9570742a60cf270cb31f08b)

- 页面时间：2026 年 8 月 3 日 13:38（原页面未注明时区）。
- 操作者：Tim-Hanchuan-Yang。

## 概要

**由本次变更引入。** 本提交新增持久化 annotation 输入及逐行展开/渲染，却只加了客户端 160 字符限制。服务端归一化没有同等验证，尽管其已有对作文格尺寸、目标字数等会放大布局的数据的显式限制。

客户端设置 maxLength={160}，但 PUT /api/cards/:cardId 接受自由格式卡片请求体，normalizeCard() 展开复制所有主观题而不验证 annotation 类型或长度。布局代码归一化整个字符串，按单元格宽度切行，为每行分配含文本与矩形的对象。填空分页估算分段高度时反复执行这些工作，构建最终布局时再做一次。saveCardWithLayout() 随后把展开结构序列化到磁盘。约 8 MB ASCII 批注可在 A4 单元格生成约 100,000 个行对象，产生大量临时内存、大布局文件及事件循环 CPU 消耗。SQLite TEXT 列没有严格小上限，恶意批注会留下，后续布局、识别准备和 PDF 请求重复昂贵处理；PDF 还对每行调用 PDFKit。并发请求可能耗尽堆或垄断 Node。认证缩小可达范围，但默认教师拥有 /api/cards 写门禁接受的权限，且无通用 API 限流。应在 buildLayout() 前于服务端确认批注是短字符串，并对布局总行数和输出大小设限。

## 验证

1. 在现实的认证教师角色下，攻击者批注可进入生产保存 API，绕过仅浏览器 160 字符限制。
2. 布局前的服务端归一化/持久化无等效类型或长度限制，只有较宽的 8 MiB JSON 体上限。
3. 布局和 PDF 将批注长度展开为无上限逐行对象/操作，并将展开布局写盘。
4. 生产路径专项测试展示明显 CPU、内存和输出放大：108,696 行对象、34.3 MB 布局、35 秒 PDF 操作、约 2.64 GiB 峰值 RSS。
5. 已存批注经真实 API 重载并重复触发布局；普通教师具有所需权限。无需实际进程崩溃即可证明已展示的可用性风险。

### 验证输出结果

原页面提供验证输出入口；附件内容未包含在已归档的页面正文中。

## 证据注释

1. 预期 160 字符限制仅是浏览器 maxLength，可被直接 API 绕过。
2. 主观题通过 ...q 复制；不同于作文格放大参数，新增批注未检查类型/长度。
3. 保存先于数据库持久化构建攻击者控制布局，并将展开布局序列化到磁盘。
4. PDF 对每个攻击者生成的批注行做一次 PDFKit 文本渲染，形成可重复 CPU/输出大小消耗点。
5. 完整批注复制并分为数组，没有文本或行数上限。
6. 每行成为独立文本/矩形对象，把紧凑字符串放大为大内存布局。
7. 填空分页在构造分段前反复计算高度，重复批注折行与分配。

## 攻击路径分析

先建立事实，再做策略调整。不适用强制排除：影响不限于本人，前提现实，攻击者是普通教师使用日常内容编辑流程，而非管理员、主机操作者、开发者或物理攻击者。虽然 PUT 是受保护写入，安全能力差异在于正常获授权教师内容导致共享服务器无界资源消耗；设计答题卡的权限不等于拒绝服务的权限。远程可达依部署，但仓库隧道路径支持，真实已认证 API PoC 证明服务可达时路径成立。高影响、高可能性按矩阵为高危，除非符合严重条件；这里只证明单一共享服务受影响，没有 RCE、管理员接管、完整数据提取或隐蔽系统性改分，故非严重。

### 路径

恶意/失陷普通教师 → 已认证网络请求 → 5174 API，可由 Cloudflare 或其他代理暴露 → /api/cards RBAC 对 PUT 要求 grade:write → 默认教师满足 → 提交超大主观题批注，低于全局 8 MiB → normalizeCard 无界复制 → buildLayout 反复折行并逐行建对象 → 展开布局序列化，SQLite 留存批注 → TEXT 与格式化布局 JSON 保存放大内容 → 重复请求 GET /api/cards/:cardId/layout 或 /pdf → 重载并处理 → PDF 重建、逐行 PDFKit drawText → 单个已存批注放大为数 GiB 内存及长处理 → 共享 Node CPU、内存、磁盘、带宽与事件循环耗尽。

攻击过程：恶意普通教师或持教师会话者绕过浏览器 maxLength=160，直接 PUT 约 7.5 MB 批注。日常 API 有服务端认证与 RBAC，但普通教师具有门禁要求的权限。服务端不验证就复制，先构建布局再持久化，每折行建立渲染对象。SQLite 保存完整批注及更大的格式化布局，后续布局/PDF 可重复触发。真实已认证 Express PoC 使用普通教师：PUT 返回 200，保留全部 7,500,000 字符，生成 34,315,466 字节布局，后续布局响应 14,618,017 字节。生产 createPdf 基准耗时 35.07 秒，输出 57,801,015 字节，RSS 约 2.84 GB。最强反向证据包括回环监听、公开隧道可选、默认认证、受保护教师写入、8 MiB 请求上限、MariaDB TEXT 比 SQLite 严格，以及有限堆仅布局测试未崩溃。这些降低跨所有部署的普遍性，却不能否定漏洞：仓库有公开隧道方式；教师是预期远程用户而非运维；PoC 穿过真实门禁；8 MiB 仍容纳会放大成数 GiB PDF 的载荷；SQLite 是受支持且已验证持久化的后端；PDF 主要 external/ArrayBuffer 分配不受所测 JS 堆上限控制。未演示实际崩溃或并发耗尽，但一次生产 PDF 调用已证明严重 CPU/内存消耗。此路径不读取或暴露秘密；边界是教师持久化内容进入共享高资源渲染器。

## 发生可能性

**高。** 对范围内恶意/失陷教师，默认已有权限，单个正常认证请求即可，无竞态/复杂链，客户端限制轻易绕过，无通用限流，且真实 API 已演示。回环、可选入口、8 MiB 上限与 MariaDB 较小 TEXT 容量限制普遍性，但不使仓库支持的 SQLite 与隧道/代理部署中的利用变得不太可能。**攻击向量：远程网络。**

## 影响程度

**高。** 单张卡可展开超过十万保留布局对象、数十 MB 持久/生成输出、长时间事件循环工作及 PDF 数 GiB 进程内存。该 Node 承载共享卡片、扫描、判分、分析流程，故失败或垄断影响他人。未证明代码执行、泄密、改分或大范围安装失陷，不符严重标准。

## 假设条件

- 攻击者为恶意普通教师或控制其会话，无需管理员、主机、开发者访问。
- 生产认证保持默认开启，除非显式设置 PROJECTX_AUTH_ENFORCE 为 0/false。
- 远程暴露依部署：监听 127.0.0.1:5174，启动脚本支持可选 Cloudflare Quick Tunnel。
- 持久重复触发在 SQLite 最强；MariaDB TEXT 可能在保存时拒绝，但 saveCardWithLayout 在数据库写入前已展开布局。
- 所提供验证产物与结果来自此精确提交、隔离本地存储及真实已认证 Express。

原文另列的利用前提：

- 可直接或经配置代理/隧道访问 Web/API。
- 带默认 grade:write 的有效普通教师账号/会话。
- PUT 卡片，含一个批注过大的填空主观题。
- 若要求已存布局/PDF 持久重触发，后端需留存超大批注，如已证明的受支持 SQLite。

## 控制措施

- 默认认证开启，除兼容开关关闭外需有效 Bearer/Cookie。
- PUT 需 grade:write，但默认普通教师有此权限。
- Express JSON 单请求 8 MiB，限制输入却不限制已演示布局/PDF 放大。
- React maxLength=160，不是服务端安全控制。
- 回环监听；远程需代理/隧道，仓库提供可选 Quick Tunnel。
- CORS 允许列表不阻止非浏览器认证请求。
- 无通用布局/PDF 限流、并发上限、总元素上限、输出限制或批注服务端验证。
- MariaDB TEXT 可能阻止长期保存多 MB 批注，但布局先做，SQLite 确实保存。
- 此发现没有代码执行或秘密披露入口，证明的是共享服务可用性耗尽。

## 盲点

- 未实际杀进程、造成宿主 OOM/磁盘满或测试并发；阈值依主机内存、Node、PDFKit、进程监管。
- PDF 基准调用生产 createPdf 并消费完整流，未通过完整 HTTP 端点做并发负载。
- 不是每个部署都开隧道/公网代理，部分仅本机或受管理网络可达。
- 持久重放仅在 SQLite 演示；MariaDB 可能写库时拒绝，但写前布局仍可达。
- 无基础设施清单证明容器内存、自动扩容、工作进程隔离、代理限制或外部限流。
- 未量化各受支持生产环境需要多少并发请求才终止。

## 证据代码

文件名后的数字是该片段在报告所关联提交中的首行行号；不连续的片段分别列出。

### [src/apps/answer-card/client/pages/DesignEditors.tsx:763](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/81ad50044fd0a070c9570742a60cf270cb31f08b/src/apps/answer-card/client/pages/DesignEditors.tsx#L763)

~~~~tsx
            <label>
              文字注释
              <textarea
                rows={2}
                maxLength={160}
                placeholder="可填写题干说明，如：看图计算并填空；注：答案不唯一"
                value={question.annotation ?? ""}
                onChange={(event) =>
                  updateQuestion(question.id, (draft) => void (draft.annotation = event.target.value.trim() ? event.target.value : undefined))
                }
~~~~

### [src/apps/answer-card/server/index.ts:179](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/81ad50044fd0a070c9570742a60cf270cb31f08b/src/apps/answer-card/server/index.ts#L179)

~~~~typescript
      // Sanitize subjective block: ensure all question scores are numbers
      if (block.type === "subjective" && Array.isArray((block as any).questions)) {
        return {
          ...block,
          questions: (block as any).questions.map((q: any) => {
            const normalized = {
              ...q,
              score: typeof q.score === "number" ? q.score : 0,
              minHeightMm: typeof q.minHeightMm === "number" ? q.minHeightMm : 68,
            };
            // 作文格参数上限校验，防止 targetChars/rows/columns 过大导致布局与 PDF 生成 DoS。
            if (q.essayGrid) {
              const g = q.essayGrid;
              normalized.essayGrid = {
                columns: clampInt(g.columns, 0, 60),
                rows: clampInt(g.rows, 0, 200),
                cellWidthMm: clampNumber(g.cellWidthMm, 4, 12, 7),
                cellHeightMm: clampNumber(g.cellHeightMm, 4, 12, 7),
                targetChars: clampInt(g.targetChars, 1, 5000, 600),
                showTitle: g.showTitle !== false,
                lineColor: typeof g.lineColor === "string" ? g.lineColor : "#222",
                lineWidthMm: clampNumber(g.lineWidthMm, 0.05, 0.5, 0.15),
                showFrame: g.showFrame !== false,
                showWordScale: g.showWordScale !== false,
              };
            }
            return normalized;
~~~~

### [src/apps/answer-card/server/index.ts:235](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/81ad50044fd0a070c9570742a60cf270cb31f08b/src/apps/answer-card/server/index.ts#L235)

~~~~typescript
async function saveCardWithLayout(cardRepo: CardRepository, card: AnswerCard, createdBy?: number): Promise<AnswerCard> {
  const normalized = normalizeCard(card, card.id);
  const layout = buildLayout(normalized);
  const exists = await cardRepo.findById(normalized.id);

  if (exists) {
    await cardRepo.updateCard(normalized);
  } else {
    await cardRepo.createCard(normalized, createdBy);
    await cardRepo.updateCard(normalized);
  }

  await writeLayoutDocument(normalized.id, layout);
~~~~

### [src/apps/answer-card/server/pdf.ts:421](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/81ad50044fd0a070c9570742a60cf270cb31f08b/src/apps/answer-card/server/pdf.ts#L421)

~~~~typescript
  (question.annotationLines ?? []).forEach((line) => {
    drawText(doc, line.text, line.rect.x, line.rect.y, 7);
  });
~~~~

### [src/shared/layout.ts:712](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/81ad50044fd0a070c9570742a60cf270cb31f08b/src/shared/layout.ts#L712)

~~~~typescript
/** 按单元格宽度把注释文字按字符折行（中文按全角字符估算宽度）。 */
function wrapBlankAnnotation(text: string, maxWidthMm: number): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const charsPerLine = Math.max(1, Math.floor(maxWidthMm / BLANK_ANNOTATION_CHAR_WIDTH));
  const lines: string[] = [];
  for (let i = 0; i < clean.length; i += charsPerLine) lines.push(clean.slice(i, i + charsPerLine));
  return lines;
~~~~

### [src/shared/layout.ts:747](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/81ad50044fd0a070c9570742a60cf270cb31f08b/src/shared/layout.ts#L747)

~~~~typescript
  const annotationLines: Array<{ text: string; rect: Rect }> = [];
  if (question.annotation?.trim()) {
    const lines = wrapBlankAnnotation(question.annotation, Math.max(8, cellRect.width - BLANK_NUMBER_WIDTH - 3));
    lines.forEach((text, index) => {
      annotationLines.push({
        text,
        rect: rect(
          cellRect.x + BLANK_NUMBER_WIDTH + 1,
          cursorY + index * BLANK_ANNOTATION_LINE_HEIGHT,
          cellRect.width - BLANK_NUMBER_WIDTH - 2,
          BLANK_ANNOTATION_LINE_HEIGHT
        )
      });
    });
    cursorY += lines.length * BLANK_ANNOTATION_LINE_HEIGHT + BLANK_ANNOTATION_GAP_Y;
~~~~

### [src/shared/layout.ts:1356](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/81ad50044fd0a070c9570742a60cf270cb31f08b/src/shared/layout.ts#L1356)

~~~~typescript
    while (remaining.length > 0) {
      const title = firstSegment ? block.title : `${block.title}（续）`;
      const firstHeight = blankSubjectiveSegmentHeight([remaining[0]], title, firstSegment);

      ensureSpace(firstHeight);
      if (firstHeight > availableHeight(getY()) && getPage().blocks.length > 0) {
        newPage();
      }

      let count = 0;
      let height = firstHeight;
      for (let index = 1; index <= remaining.length; index += 1) {
        const nextQuestions = remaining.slice(0, index);
        const nextHeight = blankSubjectiveSegmentHeight(nextQuestions, title, firstSegment);
        if (index > 1 && nextHeight > availableHeight(getY())) break;
        count = index;
        height = nextHeight;
      }

      const segmentQuestions = remaining.slice(0, Math.max(1, count));
      const nextY = addBlankSubjectiveSegment(getPage(), block, segmentQuestions, title, firstSegment, getY());
~~~~
