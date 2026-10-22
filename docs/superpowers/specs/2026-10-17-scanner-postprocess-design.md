# 扫描端「扫描后处理页」设计说明书

> 状态：设计定稿（2026-10-17），待实施。实施计划见 `docs/superpowers/plans/2026-10-17-scanner-postprocess-page.md`。
> 视觉准绳：`design/demo/demo.html`（明澈 Clarity v2.0 视觉锚点，**视图 8「扫描工作台」为本页同族范式**）+ `design/DESIGN-SYSTEM.md` + `design/tokens/tokens.css`。
> 线框参考：`docs/扫描端后处理页-ui草案.html`（v5，自包含单文件；本说明书 §6 列出草案与 demo 语义的偏差修正，实施以本说明书为准）。
> 决策溯源：2026-10-17 设计会话（Kimi Code，session_b91bb09e）中用户逐条锁定，时间戳为 UTC。

---

## 1. 目标与范围

扫描端（Electron，`扫描端微调` 分支）在**每批扫描完成后自动进入**一个独立的「扫描后处理页」，把现在散落在 `ScannerPanel` done/partial 视图与全局 `UploadProgressCard` 里的异常处理收编为**一个页面、右上角分段控件切三个视图**：

1. **扫描结果**：本批全部卷子的小方块网格 / 列表，支持搜索、筛选、多选删除；
2. **卡查看与改分**：左卡图随时可点识别块改答案，右列照搬 Web 成绩修改表格（含主观题给分），两路并存不切换；
3. **异常处理**：队列式工作台，四类异常逐条处理、处理完自动跳下一条。

**范围边界（用户锁定 + YAGNI）**

- 队列**只管本次扫描会话**的异常；历史遗留卷 / `scanner-pending` 待处理卷仍走原入口，不收编（09:55）。
- 扫描工作台（`ScannerWorkspace` / `ScannerPanel`）现状不改行为，只加「扫完上抛」一个回调；后处理页是新增屏，不替换工作台（09:56）。
- 修改即写本地库（沿用 correction 通道的串行持久化），**不做**「暂存后批量提交」（09:55 设计会话结论）。
- 不做多人协作、不做移动端适配（扫描端为桌面工位）。
- 不新增后端业务通道，除 §5 列出的 2 处**读/删扩展**外全部复用现有端点。

## 2. 用户决策清单（溯源）

| # | 决策 | 用户原话/选择（UTC） | 对实现的约束 |
|---|------|---------------------|--------------|
| D1 | 单页 + 右上角分段控件切三视图，**不是三栏同屏** | 10:02「不要把这几个功能放到一页上啊！…切换tab可以放在右上角」 | 页头右侧 `SegmentedControl`（3 项）；三视图互斥渲染 |
| D2 | 视图 1 = 列表/方块查看本批全部卷子，信息同现状 | 09:46 首条需求 | 网格 + 列表双视图切换 |
| D3 | 视图 1 方块要小，「类似于现在 twain 扫描判分时那个方块大小」 | 10:09 | 网格规格 = demo 视图 8 `scanGrid`：`repeat(auto-fill,minmax(128px,1fr))`、gap 12、缩略图 3:4 |
| D4 | 视图 1 支持多选删除卡 | 10:13 | 选择态 + 底部操作条 + 危险确认 Dialog；删除只动本地，不影响远端已上传成绩 |
| D5 | 视图 2 卡上点选与按题改分**并存、不做模式切换** | 10:09「卡上点选，按题改分没必要切换式。他想点就点，像按照题就按照题」 | 同一份 correction 文档驱动左画布与右表格，无 SegmentedControl 模式开关 |
| D6 | 视图 2 右列照搬 Web 成绩修改表格布局 | 10:09 + 截图（`题号｜类型｜得分/满分｜识别｜修改`，顶部客观/主观/总分汇总 + 保存修改） | 列结构、控件类型（客观=下拉、主观=分数输入）对齐 `ScoreFixPage.tsx:458-548` |
| D7 | 按题改分含**主观题给分** | 09:54 选「客观题 + 主观题给分」 | 主观题行可输入分数（0..满分，step 0.5） |
| D8 | 视图 3 = 异常**队列**：处理完自动跳下一条，可跳过 | 09:53 选 B | 队列状态机：current 索引 + skipped 集合 + 进度「第 x/N 条」 |
| D9 | 四类异常全进队：考号问题 / 考号重复 / 缺页配对失败 / 识别存疑（=置信度过低） | 09:55 多选 + 补充「识别存疑就是之前的置信度过低」 | 存疑判据 = `needsReview`（`confidence < resolveReviewConfidenceThreshold`，默认阈值 `OBJECTIVE_REVIEW_CONFIDENCE_THRESHOLD = 0.12`，`src/shared/grading.ts:21`） |
| D10 | 视图 3 必须有独立的**改考号**入口 | 10:13「你现在的异常卷处理没有改考号的地方」 | 考号修正面板：考号区域裁图 + 花名册联想输入 + 确认重匹配 |
| D11 | 重卡处理 = 并排看图定性 → 保留其一 / 不是同一人→改考号；丢弃沿用 `discarded` 语义 | 09:46 痛点 + 设计会话 v3 确认 | 复用 `POST .../groups/:groupId/discard` 与 correction 通道，不覆盖已保存成绩 |
| D12 | 上传：正常卷后台照常自动传；异常卷处理完一条自动补传一条；不清零不阻塞 | 09:54 选「正常卷先传，异常卷留下（推荐）」 | 复用 `scannerUploadManager`；新增「按组补传」helper |
| D13 | 入口：扫完自动跳入；页头「返回扫描」可回工作台续扫，续扫异常累进同一队列 | 09:56 选「扫完自动跳 + 可返回续扫（推荐）」 | `ScannerApp` 新增 `postprocess` 屏；队列按 cardId 累积多个 sessionId |
| D14 | 成品符合「明澈」设计语言 | 10:02「最后成品要符合我们项目明澈的设计语言和要求」 | 全部组件取自 `components/ui/v2` 桶文件；颜色只写语义类；compact 密度；lucide 图标；纸面恒白 |

## 3. 页面外壳（对齐 demo 视图 8「扫描工作台」）

demo 视图 8 是「全屏任务流」：`header.phead`(52px) + 主体，无 AppRail。本页同构：

```
┌ header（h-page-header，bg-card，border-b border-border-subtle）───────────────┐
│ [← 返回扫描](Button ghost icon-sm)  标题+副标题(已扫N·正常M·异常K·已上传x/y)   │
│                                          上传状态(TaskProgress/文案)  [Seg 3项] │
├──────────────────────────────────────────────────────────────────────────────┤
│ 当前视图内容（bg-background，p-4/6，overflow-auto）                            │
└──────────────────────────────────────────────────────────────────────────────┘
```

- 分段控件三项：`扫描结果` / `卡查看与改分` / `异常处理`（第三项 label 内嵌 `Badge tone="danger"` 计数，等宽数字）。demo 的 `.seg` 带计数（「全部 234」）即此语义。
- 页头不放主按钮（一屏主按钮 ≤1 的规则留给视图内部：视图 2 的「保存修改」、视图 1 选择态的「删除选中」各自为其屏唯一主按钮）。
- 密度：扫描端已全局 `data-density="compact"`（`ScannerApp.tsx:51-54`），本页不另设。

## 4. 三视图规格

### 4.1 视图 1 · 扫描结果

- 工具行：搜索 `Input`（考号/姓名，前置 `Search` 图标）｜`SegmentedControl` 筛选 `全部 N / 正常 N / 异常 N`｜右置 `SegmentedControl` `方块/列表` + `Button outline`「选择」。
- 方块网格（**demo 视图 8 规格**）：`grid gap-3`，`grid-template-columns: repeat(auto-fill, minmax(128px, 1fr))`；单卡 = 缩略图（`aspect-[3/4]`，`bg-paper` 恒白容器 + `border border-border rounded-xs`，图走 `/api/scanner/scan-image/:recordId`）+ caption 行（考号 `text-xs tabular-nums` + 小徽章 `Badge` 高 18px 档：正常=success、存疑=warning、异常=danger）。异常卡 `ring-2 ring-destructive` 并置顶（demo `.scan-thumb.bad` = 2px err 描边）。
- 列表视图：`Table`（考号｜姓名｜页数｜客观/主观/总分（右对齐等宽）｜状态徽章｜操作），行高走 compact 令牌。
- 多选删除：点「选择」进入选择态（卡片左上 `Checkbox`，选中卡 `border-primary`）；页内底部浮出操作条（`bg-card border-t`）：`已选 N 张`＋代价文案＋`取消`(outline)＋`删除选中(N)`(destructive，本屏唯一主按钮)；确认走 `ConfirmDialog tone="danger"`，文案：「删除 N 张扫描卡？本地扫描记录与识别结果将被移除，不可恢复。已上传的远端成绩不受影响。」
- 删除语义（服务端护栏）：组内任一页存在非 discarded 回执（`scanner_submissions.state in ('saved','held','conflict')`）时，需请求体 `force:true` 才放行；客户端第一次确认 Dialog 展示该提示并二次确认。远端上传通道**不提供**删除（与现状一致）。

### 4.2 视图 2 · 卡查看与改分

- 数据源：选中组的 correction 文档 `GET /api/scanner/session/:sessionId/groups/:groupId/correction`（本地通道，远端模式同，见 §5 通道裁定）。
- 左列（flex-1）：**CorrectionCanvas**——从 `CardCorrectionEditor.tsx:115-125` 抽出的 SVG 点选画布（内联渲染，非 Dialog）：`bg-muted p-3 rounded-md` 中性底托恒白纸面（demo `.paper-wrap` 语义）；页切换/缩放控件用 `Button outline sm` + `SegmentedControl`（适配/100%/150%）。存疑格 amber 描边标记，点击即改。
- 右列（flex-1.2）：成绩修改表格，列 `题号｜类型｜得分/满分｜识别｜修改`：
  - 行数据 = `gradeCombinedRecognition(card, fileName, correctionState(...).recognition, threshold)` 的 `questions` + `subjectiveQuestions`（**编辑即时重算**，不等保存）；
  - 「识别」列 = 文档原始 `recognition` 的 selectedOptions / score（改过的行加 `Badge tone="warning"`「已改」）；
  - 「修改」列：客观题 = 选项编辑（单选 `Select` 选项字母＋「未答」；多选/不定项 = 选项字母 toggle  chips）、主观题 = `Input type=number min0 max=满分 step0.5`；
    **与 Web 的有意偏差**：Web `ScoreFixPage.tsx:506-528` 的客观题下拉是「得分档」（0..满分按 step），因为 Web 改的是已入库 `question_scores`；本页改的是**入库前的填涂**，唯一可表示的编辑是选项格，故客观题列改为选项编辑。列结构/汇总条/保存语义仍照搬 Web。
  - 存疑行 `bg-warning-soft` 置顶（demo `.tbl .hl`）；行点击 ↔ 左画布定位同题（`scoreBlockForQuestion` 同思路：按 questionNumber 滚动/高亮对应 polygon）；
  - 顶部汇总行：`客观题 X · 主观题 Y · 总分 Z`（等宽）＋ 右置 `Button primary`「保存修改」（`PUT .../correction`，`loading` 强制）。
- 两路编辑写同一 `edits: CorrectionEdit[]`：画布点击 = `toggleCorrectionCell`；表格改选项 = `selectObjectiveOptionCells`；表格改分数 = `selectScoreCells`（§5 新增纯函数）。保存后 `onSaved` → 重拉批结果 + 按 §5 补传护栏决定是否补传（D12）。

### 4.3 视图 3 · 异常处理（队列）

- 左卡（260px）：`异常队列` 标题 + `Progress`（已处理/总数）+「第 x/N 条」；条目列表（类型徽章 + 考号/摘要；已处理=删除线+success 勾，当前=`border-primary bg-accent-soft`）；底部 `暂时跳过`(outline) / `下一条`(secondary)。
- 右区按当前条类型渲染专用面板：
  - **考号问题**：考号修正面板——左：考号区域裁图（correction 文档中 `student_digit` 格的外接矩形裁切，前端 canvas/css crop 即可，不新增端点）+ 整卡缩略图；右：`Input` 考号 + 联想下拉（`GET /api/exams/:examId/participant-search?q=`，显示 考号+姓名；examId 由 §5 扩展字段提供）+ `Button primary`「确认考号·重新匹配学生」（= 把考号写入 digit 格 edits）；考号不在名单 → `Badge tone="danger"` 提示，仍可确认或「标记废卷」（走 discard，仅冲突副本允许，否则提示不可用原因）。
  - **考号重复**：重卡对比面板——同考号 ≥2 张回执卡并排（`ScanConflictCard[]` 按 studentId 分组）：每卡缩略图（首页图）+ 考号/总分（等宽）/扫描时间/清晰度（`GET /api/scanner/card/:cardId/scans` 的 createdAt/scanQuality 按 recordId 关联）/`Badge`（已入库/正式成绩保留）；系统倾向提示（两份填涂 hash 相同→「同一张卡扫了两遍」，用 `scannerDuplicateEvidence` 同口径的前端近似：逐页识别 JSON 相同则提示重扫）；操作：`保留这份`(对另一张 discard) / `不是同一人 → 改考号`(切考号修正面板)。
  - **缺页/配对失败**：展示期望页 vs 实际页（`mapScanPageToLayout` 计算缺失 layoutPage）、该组已有页缩略图；操作：`重新识别此卡`（`POST /api/scanner/session/:sid/retry`）/`整卡改分`/`删除该组`（同视图 1 删除护栏）。
  - **识别存疑**：列出存疑题（needsReview 的题号 + 置信度），`去改这题` → 切视图 2 并定位该题。
  - **其他失败（兜底）**：展示 `failure.message` + `整卡改分` + `重新识别此卡`。非用户新增类型，仅为不丢异常。
- 处理完成判定：该组不再出现在新一轮 validate 响应的 failures/reviewCards、且 needsReviewCount=0 → 标记已处理、自动跳下一条；跳过不标记。

## 5. 数据与通道契约

**通道裁定（2026-10-17 施工期复核后定稿）：后处理页单一事实源 = 本地通道。**
远端模式下本页同样读写本地（`validate` / `correction` / `discard` / `retry` / `DELETE groups`），处理完一组经 `scannerUploadManager.startUpload` 补传（manager 自建 remote session）。理由：本页持有的是本地 TWAIN sessionId，而上传端点认的是服务器为上传任务另建的 `job.remoteSessionId`（`lib/scannerUploadManager.ts:551-556`），两者不相通；`requestJob` 在 job 收尾后 reject「上传任务已关闭」（:897-899），持有 jobId/remoteSessionId 的只有 `UploadProgressCard` 闭包。现状同构：`ScannerPanel` 远端模式读的也是本地 `results?previewOnly=1`、订正打本地 correction（`ScannerPanel.tsx:398-404`）。因此下表「远端」列端点**仅**由上传任务内部与 `UploadProgressCard`（已上传任务的后续冲突处理）使用，后处理页不直接调用。远端模式下本地回执表为空，删除护栏只保护本地已入库组；删除已上传组 = 放弃补传，ConfirmDialog 文案已覆盖该代价。

**补传护栏（D12 的精确化，2026-10-17 施工期复核后定稿）**：重复学号的第二份回执到服务端会走 conflict → `withdraw()` 删除 `student_scores/question_scores` 并把考试打回阅卷态（`scannerSubmissions.ts:121-141`、:515「已保存成绩撤出后才可重新保存」），故**已上传/已入库的组绝不重传**。`handleSaved` 判定顺序：① 本地模式不上传；② 该组已有上传 job → 不新建会话，job 有失败页则 `retryFailed(job.id)`，否则指向右上角上传卡；③ 加载时已上传/已入库 → 不重传，提示「服务器成绩修改请走 Web 成绩修改」（该路径才是已入库卷的权威改分通道，与现状一致）；④ 其余（本次处理掉的异常组）才 `startUpload` 首传。

**复用（不改动）**

| 用途 | 端点 | 位置 |
|------|------|------|
| 批结果（队列/网格/表格的总数据源） | 本地 `GET/POST /api/scanner/session/:sid/results`（`?previewOnly=1` 纯预览）、`POST /api/scanner/session/:sid/validate`；远端 `GET /api/scanner/upload/sessions/:sid/results` | `scanner/index.ts:494-507`、`scanner-upload.ts:541-570` |
| 整卡点选/改分文档 | `GET/PUT /api/scanner/session/:sid/groups/:gid/correction`（远端 `upload/sessions/...`） | `routes/scan-correction.ts:11-42` |
| 改考号（服务端重判） | 本地 `POST /api/scanner/session/:sid/retry {groupId, studentId}`；远端 `POST .../correct` | `scanner/index.ts:528`、`scanner-upload.ts:571` |
| 作废重复副本 | `POST .../groups/:gid/discard` | `scanner/index.ts:560`、`scanner-upload.ts:600` |
| 卡图 | 本地 `GET /api/scanner/scan-image/:recordId`；远端 `GET /api/scanner/upload/records/:recordId/image` | `scanner/index.ts:574`、`scanner-upload.ts:528` |
| 组级扫描元数据（时间/清晰度） | `GET /api/scanner/card/:cardId/scans` | `scanner/index.ts:367-399` |
| 花名册联想 | `GET /api/exams/:examId/participant-search?q=` | `server/index.ts:2887` |
| 上传/补传 | `scannerUploadManager.startUpload/refreshResults/requestJob` | `lib/scannerUploadManager.ts:688/827/897` |

**新增/扩展（仅 2 处）**

1. `DELETE /api/scanner/session/:sessionId/groups`（本地通道，body `{groupIds:string[], force?:boolean}`）：事务内逐组校验回执（非 discarded 回执存在且 `force!=true` → 409 列出冲突组），否则逐页 `deleteScanRecord`（`scan-store.ts:193-198`，已含 `scan_correction_pages` 清理）。响应 = validate 模式 `ScanBatchResponse`。远端通道不加删除。
2. 读扩展：`GET /api/scanner/scan/:sessionId` 与 `GET /api/scanner/upload/sessions/:sessionId/status` 响应追加 `examId: number | null`（`resolveScannerExam(session.card_id, sessionId)`，`services/scannerExam.ts`），供花名册联想使用；纯追加字段，不破坏现有消费方。

**新增纯函数（shared，带冒烟测试）**

- `src/shared/correctionCellSelect.ts`：`selectObjectiveOptionCells(cells, questionNumber, options)`、`selectScoreCells(cells, questionId, blockId, score)`（`evaluateScoreCells` 的逆：base/tens/ones/fraction 位规则同 `scanCorrection.ts:57-70`）、`selectStudentDigitCells(cells, digits)`。
- `src/shared/scanPostprocess.ts`：`buildPostprocessGroups(response, layoutPageCount)`、`buildPostprocessQueue(groups)`（分类顺序 duplicate → student_id → missing_page → low_confidence → other；组内按 groupId 数值序）。分类只用结构化信号（conflicts 非空 / 缺 layoutPage / studentId 为 null / needsReviewCount>0），**不解析 message 文案**。

## 6. 与 v5 草案（docs/扫描端后处理页-ui草案.html）的偏差修正

| 草案画法 | demo/规范语义 | 修正 |
|----------|---------------|------|
| 网格 `repeat(8,1fr)`、缩略图高 56px | 视图 8 `scanGrid`：`auto-fill minmax(128px,1fr)`、gap 12、3:4 比例 | 按 demo |
| 异常卡 1.5px 实红边 | `.scan-thumb.bad` = 2px err 描边（ring） | `ring-2 ring-destructive` |
| 删除确认自绘虚线框 Dialog | `ConfirmDialog tone="danger"`（sm 480 宽、双按钮右置、文案说清代价） | 用组件 |
| 视图 2 为占位框（「同 v4 缩略」） | — | 草案补全为自包含（v4 表格画法并入），见计划 Task 9 |
| 重卡面板含「清晰度」 | 数据可得（`scan_quality`） | 保留，来源注明 `GET /card/:cardId/scans` |
| 页头自绘 seg（白底浮起） | `SegmentedControl`（bg-secondary 容器 + 选中浮起 shadow-1） | 用组件 |

## 7. 验收标准

1. `npm run typecheck`、`npm run build:scanner:full` 通过；新增冒烟脚本进 `package.json` 的 `verify:*` 并全绿；回归 `verify:scan-correction`、`verify:scanner-batch-results`、`verify:scanner-pending`、`verify:scanner-upload-manager` 不红。
2. 视觉：亮/暗双主题 + 默认 flat 与 `paper-edge` 双皮肤下截图，与 demo 视图 8 同屏比对；眯眼测试品牌红仅出现在主按钮/选中态/异常强调；纸面暗色下恒白。
3. 交互：扫完一批自动跳入；返回续扫第二批后队列累积；四类异常各造一例（用 `scripts/` 隔离数据）走通处理→自动补传；多选删除含已入库组时出现 409 二次确认路径。
4. 真机 TWAIN 与扫描仪验收不在本计划承诺范围（Windows 真机另行验收）。
