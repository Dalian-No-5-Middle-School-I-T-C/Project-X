# Project-X CHANGELOG

## v1.8.2 (2026-07-09) — 暗色模式全面修复

基于 v1.6.3 暗色模式基线进行系统性修复，解决 v1.7.0+ 新增组件在暗色下的灰底灰字、可读性差、与背景融为一体等问题。

### 问题根因
- v1.6.3 暗色模式已稳定（GitHub Dark 风格，#C0392B / #E6EDF3 / #161B22），但组件级暗色覆盖不完整
- v1.7.0/v1.8.0 大量新增组件使用 `var(--brand)` / `var(--text)` 等变量，但未覆写背景色
- 亮色模式下 `rgba(255,255,255,0.55~0.78)` 半透明毛玻璃在暗色底上呈现灰色、文字难以阅读

### 修复方案
**统一原则**：所有亮色半透明/毛玻璃背景在暗色下覆写为 `var(--surface)` / `var(--surface-raised)`，移除 `backdrop-filter`，添加清晰 `var(--line)` / `var(--line-strong)` 边框。

#### 核心变量（保持 v1.6.3 不变）
| 变量 | 暗色值 |
|------|--------|
| `--brand` | `#C0392B` |
| `--text` | `#E6EDF3` |
| `--surface` | `#161B22` |
| `--surface-raised` | `#21262D` |
| `--background` | `#0D1117` |

#### 修复的组件（`styles.css` ~250 行新增暗色覆盖）
- **通用按钮** `.ghost-button` / `.primary-button`：背景 `var(--surface-raised)` + 边框，hover 品牌色
- **通用面板** `.panel`：背景 `var(--surface)`，hover `var(--surface-raised)` + 品牌色边框
- **答题卡列表** `.card-list-item` / `.card-list-actions button`：移除半透明白，激活态品牌红渐变
- **底部状态栏** `.statusbar`：背景 `var(--surface-raised)`
- **顶部导航** `.mode-toggle button`：未激活用 `var(--surface-raised)` 与背景区分，激活保留红渐变
- **题块卡片** `.block-chip`：背景 `var(--surface-raised)`，hover/active 品牌红渐变
- **题块操作按钮** `.chip-actions button` / `.question-editor-title button`：背景 `var(--surface)`
- **上传按钮** `.upload-button`：背景 `var(--surface-raised)` + 品牌色虚线边框
- **答案键按钮** `.answer-key-row button`：背景 `var(--surface-raised)`，激活态品牌红
- **分值检查** `.score-warning-summary`：去掉亮色黄底，改为深色品牌黄调

#### 阅卷表格暗色适配
- `.score-table` / `.score-table-head` / `.question-grade-list` / `.question-grade`：覆写半透明白背景
- `.question-grade.needs-review`：深色黄调
- `.status-ok`：深色绿 `#6EE7B7`，`.status-warn`：深色黄 `#FCD34D`
- `.file-queue` / `.queued-files span`：覆写半透明白，移除 backdrop-filter

#### AI 分析面板暗色适配
- `.ai-analysis-panel`：背景 `var(--surface)`
- `.icon-button`：背景 `var(--surface-raised)`，hover 品牌色
- `.ai-status-warning`：深色黄调 + `#FCD34D` 文字
- `.ai-report-summary` / `.ai-caveats span` / `.ai-tool-trace span`：深色背景
- `.ai-question-action em`：`var(--muted)` 文字色

### 修改文件
| 文件 | 改动 |
| --- | --- |
| `src/apps/answer-card/client/styles.css` | 暗色覆盖段新增 ~250 行组件级暗色适配 |

---

## v1.8.1 (2026-07-06) — 代码审查 bug 修复与一致性收敛

基于 PR161 代码审查报告（`readus/CODE-REVIEW.md`），修复安全漏洞、崩溃 bug、排名/百分位不一致及若干前端问题。

### 安全修复
- **MariaDB 恢复命令注入（C-S1）**：`backup.ts` restore 改用 `execFile` 参数数组 + stdin，消除 shell 注入
- **扫描上传路径遍历（H-S12）**：`side` 白名单、`sessionId` basename 兜底、扩展名白名单
- **ZIP 解压前缀绕过（M-S18）**：路径检查改用 `path.relative`，防止 `destDir-evil` 类前缀攻击

### 数据一致性
- **排名算法统一（H-L2）**：`score-editing.ts` 与 `ReviewService.ts` 两份重复 `recomputeRankings` 收敛为共享模块 `rankingUpdate.ts`，改用 `competitionRank`（同分并列）
- **百分位公式统一（M-L4）**：写入 DB 时统一使用公式 A `(total - rank) / (total - 1) * 100`（末名 0）
- **分数舍入（H-L3）**：成绩编辑/复核路径 `total_score` 统一 `roundScore`（3 位小数）

### 阅卷逻辑
- **复核置信度阈值生效（H-L1）**：Web 阅卷链路读取用户 `reviewConfidenceThreshold` 并传入 `gradeObjectiveQuestion`
- **主观题负分裁剪（M-L6）**：`Math.max(0, Math.min(score, maxScore))`
- **多页阅卷择优（M-L2/M-L3）**：跨页去重纳入置信度；学号优先取 `status=ok` 的识别结果

### 前端修复
- **GradingResults 崩溃（C-F1）**：`useState` 移到早返回之前，修复 Hook 数量变化崩溃
- **ScannerPanel 闭包陷阱（C-F2/C-F3）**：用 ref 追踪 `pages`/`sessionId`/`scannerMode`，修复 done 回传页数 0 与远程上传空循环
- **网上阅卷前进（H-F2）**：「保存并下一份」真正前进到下一份
- **SSE 健壮性（H-F5/M-F4）**：`JSON.parse` 加 try/catch；扫描 SSE 断连反馈错误状态
- **图片压缩内存泄漏（H-F6）**：`URL.revokeObjectURL` 释放 blob URL

### 小修复
- `generateTeacherUsername` 异步检查存在性，避免用户名碰撞（L-S2）
- `englishTemplate` 移除无意义三元（L-L4）
- `ClassManagement` CSV 表头正则去重（L-F8）

### 测试与文档
- 新增 `readus/CODE-REVIEW.md`（含修复状态总表）
- 新增 `scripts/bugfix-verification.ts`（14 项单元断言）
- 新增 `scripts/ranking-integration-check.ts`（真实 SQLite 排名集成测试）

### 回归验证
- `npm run typecheck` ✓
- `npm run verify:auth` — 54 通过 / 0 失败
- `npx tsx scripts/grading-rules-smoke.ts` ✓
- `npx tsx scripts/bugfix-verification.ts` — 14 通过
- `npx tsx scripts/ranking-integration-check.ts` ✓
- `npm run build` ✓
- GUI 冒烟：登录、设计/考试/阅卷/分析四页正常渲染

### 第二轮修复（对照 PR161 + debug 审查）
- **H-S4**：`ExamRepository` / 扫描器持久化改用 `ON CONFLICT DO UPDATE`，重扫保留 rank/percentile/手动改分
- **H-S1**：成绩修改 PUT 路由增加 `requireExamAccess`
- **H-S11**：`getVisibleExamIds` 异步化 + `getMysqlDb()`，MariaDB 模式考试可见性正确
- **M-L4 显示层**：`AnalysisRepository` 百分位显示统一公式 A
- **backup**：MariaDB 默认端口 `3306`（原误 `443`）
- **ScannerPanel**：`sessionIdRef` 在 `startScan` 同步赋值
- **score-editing**：答案 `updateCard` 持久化、同步 `subjective_score`、传入复核阈值
- **PR161**：`COUNT(ss.exam_id)` 修复 JOIN 重复计数

### 修改文件

| 文件 | 改动 |
| --- | --- |
| `src/server/routes/backup.ts` | execFile 防注入、ZIP 路径检查 |
| `src/server/routes/scanner-upload.ts` | side/ext/sessionId 安全校验 |
| `src/server/services/rankingUpdate.ts` | **新增** 统一排名/百分位重算 |
| `src/server/routes/score-editing.ts` | 使用共享排名模块 + roundScore |
| `src/server/services/ReviewService.ts` | 同上 |
| `src/shared/grading.ts` | 阈值参数、跨页择优、主观分裁剪 |
| `src/apps/answer-card/server/index.ts` | 读取用户复核阈值传入阅卷 |
| `src/apps/answer-card/client/App.tsx` | GradingResults Hook 修复、SSE try/catch |
| `src/apps/answer-card/client/components/ScannerPanel.tsx` | ref 闭包修复 |
| `src/apps/answer-card/client/components/OnlineReviewPanel.tsx` | 保存并下一份前进 |
| `src/apps/answer-card/client/components/PaperUploadPanel.tsx` | objectURL 释放 |
| `src/server/repositories/UserRepository.ts` | 教师用户名生成重试 |
| `src/shared/cardTemplates.ts` | 移除冗余三元 |
| `scripts/bugfix-verification.ts` | **新增** 回归测试 |
| `scripts/ranking-integration-check.ts` | **新增** 排名集成测试 |
| `readus/CODE-REVIEW.md` | **新增** 代码审查报告 + 修复状态 |
| `src/server/services/userSettings.ts` | **新增** 共享复核阈值读取 |
| `src/server/repositories/ExamRepository.ts` | H-S4 upsert + COUNT 修复 |
| `src/apps/answer-card/server/middleware.ts` | H-S11 异步 getMysqlDb |
| `src/apps/answer-card/server/scanner/index.ts` | H-S4 扫描持久化 upsert |
| `src/server/repositories/AnalysisRepository.ts` | M-L4 百分位显示 + COUNT |
| `src/server/routes/exam-groups.ts` | COUNT(ss.exam_id) |

---

## v1.8.0 (2026-07-04) — 原卷上传与 AI 知识点分析

### 数据库 schema 完善
- `schema.sql` 初始建表补充 v1.8.0 新增字段：
  - `answer_cards`: `has_original_paper`, `original_paper_filename`, `original_paper_path`, `question_range`, `extra_notes`, `knowledge_points_text`
  - `users`: `require_original_paper`, `highlight_missing_paper`
- `schema.mysql.sql` 同步补充上述字段（之前仅 `schema.mariadb.sql` 完整）
- MariaDB 增量迁移新增 `v17 original-paper-and-knowledge-points`，确保已有 MariaDB 生产库自动补齐原卷相关列和 `knowledge_points` 表

### SQL 兼容性
- `KnowledgePointRepository.getWeaknessesForExam / getWeaknessesForStudent` 的 `GROUP_CONCAT(DISTINCT ... ORDER BY ...)` 改为按 `(point_text, question_number)` 分组，然后在 JS 层聚合题号，兼容 SQLite 和 MySQL

### 版本号
- `package.json` / README badge / UI 侧栏版本号统一为 `1.8.0`

### 原卷上传
- 答题卡创建后自动弹出原卷上传面板（可由教师在设置中关闭）
- 支持 DOCX / PDF / 图片（JPG/PNG/BMP/TIFF/WebP）上传，最大 50MB
- 拒绝 .doc 格式，引导转为 .docx
- 图片自动前端压缩（max 2048px, JPEG 80%）+ 后端 sharp 兜底压缩
- 图片格式自动转为 PDF 存储；DOCX/PDF 保留原文件
- 题目范围填写（全部 / 自定义文字）+ 特别描述备注
- 原卷文件存储在 `data/answer-card/papers/:cardId/`

### AI 知识点分析
- 智能路由：多模态（Gemini/GPT）直传图片，一次调用；纯文本（DeepSeek）自动检测文字层
- DeepSeek 三模式：自动（文字层→mammoth/pdf-parse，无文字层→Tesseract.js OCR）/ 视觉接力（视觉模型转写→DeepSeek分析）
- 三层格式保障：JSON Schema 硬约束 + System Prompt 软约束 + Node 后端校验兜底
- 知识点存储在 `knowledge_points` 表，独立于答题卡，与成绩数据关联
- 前端编辑：彩色标签、双击编辑、长按编辑（移动端）、删除/添加知识点
- 分析结果持久化，后续可重新分析或手动修改

### 成绩分析联动
- 新增 `GET /api/analysis/knowledge-points/:examId` — 按知识点聚合全班得分率
- 新增 `GET /api/analysis/knowledge-points/:examId/students/:studentId` — 单个学生知识点弱项
- llmclient 新增 `get_knowledge_point_weaknesses` 工具，AI 能指出具体知识点的薄弱环节

### 原卷导出增强
- 答题卡导出 `.projectx-card.json` 包含原卷 base64 + 知识点数据
- PDF 导出前统一检查卡片：分值 → 原卷（内联渲染：图片/img可缩放、PDF/iframe翻页、DOCX/Office链接）→ 知识点（内联分析+编辑），三步进度条，含「← 上一步」回退
- 原卷预览按文件类型智能渲染：`?format=image` 获取图片，默认 PDF，互不干扰
- 原卷放大预览 Modal 支持 ± 缩放（25%~300%），按钮实时显示当前倍率
- 修复图片原卷上传后不被识别：`/api/cards/:cardId/paper/info` 双检查（DB + 文件实际存在），自动修复不一致
- 上传原卷后自动刷新侧栏状态
- 导出卡片内知识点分析面板与上传面板 UI 统一（单选框 `.radio-label` 对齐）

### 侧边栏标识
- 左侧答题卡列表新增橙色竖条标识未上传原卷的考试
- 可在教师设置中关闭高亮

### 系统 AI 配置（Admin Only）
- `ai_providers` 表新增 `is_system` 列，全校统一 AI 提供商
- 知识分析仅使用系统级 AI 提供商，教师无法自行配置
- AccountMenu「AI 设置」Tab 仅 admin 可见
- 教师设置新增「强制上传原卷」「侧边栏高亮」双开关

### 移动端适配
- 文件上传：移动端大按钮组（拍照/选文件）
- 面板全屏化（<760px），sticky 底部按钮
- 知识点编辑长按触发
- 输入框 16px 字体防 iOS 缩放

### 数据库
- migration v16：`ai_providers.is_system` (SQLite + MariaDB)
- schema.sql / schema.mariadb.sql / schema.mysql.sql 三份同步
- 新建 `knowledge_points` 表（card_id, question_number, point_text, category）

### 新增依赖
- `sharp` — 图片压缩与格式转换
- `mammoth` — DOCX 文本提取
- `pdfjs-dist` — PDF 文字层检测与文本提取（替代 pdf-parse）
- `tesseract.js` — OCR 引擎（扫描件兜底）

### 新增文件
- `src/apps/answer-card/server/paper-converter.ts` — 文件校验、压缩、图片→PDF
- `src/apps/answer-card/server/paper-ocr.ts` — 文本提取 + OCR
- `src/apps/answer-card/server/routes/paper-routes.ts` — 原卷/knowledge-points CRUD
- `src/server/repositories/KnowledgePointRepository.ts` — 知识点 CRUD + 成绩联动查询
- `src/apps/answer-card/client/components/DragDropZone.tsx` — 拖拽上传
- `src/apps/answer-card/client/components/KnowledgeTagList.tsx` — 可编辑知识点标签
- `src/apps/answer-card/client/components/PaperUploadPanel.tsx` — 原卷上传主面板
---

---


---

## v1.7.3 (2026-07-04) — 移动端网页适配

### 移动端全面适配

系统从桌面端专用布局升级为桌面/移动端双适配架构。新增 480px 手机断点，通过底部导航栏替代桌面端 Tab 切换，实现手机端原生体验。

- **底部导航栏（Bottom Navigation Bar）**：
  - 固定屏幕底部，毛玻璃背景 + 品牌色激活项
  - 根据用户权限动态生成导航项（设计/考试/阅卷/分析/成绩/账号），最多 5 个 Tab
  - 图标 + 短标签（2-3字），触摸目标 44px，iPhone 安全区适配（`env(safe-area-inset-bottom)`）
  - 桌面端 `display: none`，仅 480px 以下显示
- **Topbar 移动端精简**：
  - 隐藏副标题、隐藏桌面端 `mode-toggle`（由底部导航替代）
  - 标题省略号截断，操作按钮紧凑排列
  - `position: sticky` 固定顶部
- **480px 移动端主断点**（~300 行新增 CSS）：
  - 全局重置：`body` 可滚动、`app-shell` 取消固定高度、底部 padding 为导航栏留空间
  - 8 个 mode 页面逐一适配：
    - **design**：预览区 + 属性面板纵向排列，答题卡页面自适应宽度
    - **exam-manage**：考试列表表格改卡片布局，表头隐藏
    - **grading**：扫描面板 padding 缩减，扫描结果网格紧凑化
    - **analysis**：分析卡片 2 列，排名表横向滚动，箱型图 2 列
    - **scores**：概览卡片紧凑排列，Tab 横向滚动，图表高度缩减
    - **account**：三栏班级布局改单列，表单单列，表格横向滚动
    - **sponsor**：收款码卡片全宽，二维码缩至 140px
    - **guide**：正文 13px、表格横向滚动、代码块紧凑
- **Modal 底部弹出（Bottom Sheet）**：
  - 所有弹窗从屏幕底部滑出，全宽圆角顶部（`border-radius: 20px 20px 0 0`）
  - 底部按钮纵向全宽排列
  - PDF 查看弹窗全屏化
  - 账号菜单下拉改为底部弹出
- **触摸优化**：
  - 输入框 `font-size: 16px`（防止 iOS Safari 自动缩放）
  - 触摸目标最小 44px
  - `-webkit-overflow-scrolling: touch` + `overscroll-behavior: contain`
- **横屏适配**（iPad 等）：
  - 1024px landscape：主内容 + 属性面板 320px 双列
  - 768px landscape：单列 + 底部导航缩小至 48px
- **暗色模式配套**：底部导航栏、Topbar、Modal 全部适配 `[data-theme="dark"]`
- **HTML Meta 标签**：viewport 添加 `viewport-fit=cover`，新增 `apple-mobile-web-app-capable`、`theme-color`

### 技术实现

- **纯 CSS 适配策略**：不修改任何子组件文件，全部通过 `styles.css` 中的 `@media (max-width: 480px)` 规则覆盖
- **App.tsx 最小改动**：仅新增 `mobileNavItems` useMemo（权限驱动的导航项数组）+ 底部导航 JSX
- **CSS 变量扩展**：新增 `--mobile-bottom-nav-height`、`--mobile-safe-area-bottom/top`、`--touch-target-min`、`--mobile-content-padding`

### 修改文件

| 文件 | 改动 |


## v1.7.2 (2026-07-01) — 统计图表 + 教师权限管理

### 统计图表系统
- 新增 `AnalysisCharts` 可复用图表组件：`ScoreDoughnut`（饼图）、`ComparisonBar`（柱状图）、`TrendLine`（折线图）。
- `AnalysisOverview` 嵌入「图表可视化」区域：分数段分布饼图 + 关键指标面板。
- 学生端 `StudentScores` 成绩列表顶部嵌入总分趋势折线图（≥2 场考试显示，时间正序排列）。
- Chart.js 颜色处理：新增 `resolveColor()` CSS 变量解析 + `withAlpha()` 安全 alpha 拼接，避免 Canvas API 下 `var(--brand)15` 非法颜色。

### 教师权限管理系统
- 新增 `teacher_permissions` 表（v16 migration）：`teacher_id`/`grade_id` + `can_view_scores`/`can_view_charts`/`can_view_students` 三个开关。
- 新增 `GET/PUT/DELETE /api/admin/permissions` 路由（admin-only）。
- 新增 `PermissionManager` 前端组件：管理员可视化管理各教师/年级的查看权限。
- RBAC 集成：`getVisibleExamIds` 检查 `teacher_permissions` 表，关闭权限的教师看不到受限年级的全部数据。
- `AccountMenu` 新增「权限管理」入口（仅 admin 可见）。

### 暗色主题持续打磨
- 品牌色调优：珊瑚红 `#F77866` → 低亮红 `#D94040` → 最终 `#C0392B` 暗沉红（Tim 版）。
- 文字亮度：`#C9D1D9` → `#EAEAEA`（亮白），`--muted` → `#888888`。
- 顶部栏 `rgba(22,27,34,0.75)` 暗色毛玻璃，mode-toggle 容器可见暗底。
- 答题卡预览强制白纸黑字（`.page` `#fafafa` + `color:#333`）。
- SVG 文字全系列 `fill:#111 !important`。
- 侧边栏 hover：黑遮罩 → 品牌红微光 `rgba(217,64,64,0.08)`。
- 按钮 hover：黑块 → 微光白 `rgba(255,255,255,0.08)`。
- Kimi 补全 1460 行组件级暗色覆盖（`.panel`/`.block-chip`/`.answer-key-editor` 等）。

### Bug 修复
- `CreateExamGroupModal`：修复重复 `error`/`setError` 声明导致 tsc 编译失败。
- 学生端趋势图：修复 `/api/scores/me` 返回 DESC 排序导致折线图时间倒序（改为 `[...data].reverse()`）。
- Chart.js 颜色：修复 `var(--brand)15` 拼接为非法 Canvas 颜色。
- `update.sh` 重写：Node 自动探测 + 分支安全 + 跨平台进程管理。

### 工程化改进
- 后端路由拆分：14 条分析路由提取为 `routes/analysis.ts` + 3 个共享模块。
- Zod 请求校验：`POST /api/cards`、`POST /api/exams`、`PATCH /api/users/me/settings`、`POST /api/analysis/cross-exam/groups`。
- 文件上传魔数校验（PNG/JPEG/BMP/TIFF）+ MIME 预过滤。
- DB 性能索引 v12：`student_scores` 复合索引 + `question_scores` 复合索引。
- SQL 动态 UPDATE 白名单校验。
- 统一错误码 `ApiError` 枚举 + 中文提示。
- GitHub Actions CI 工作流（typecheck + test + build）。
- `AutoBackup`：考试关闭后自动拷贝 DB 到 `data/backups/`。

### 答题卡模板
- 新增辽宁新高考政治/历史/地理模板（16 单选 × 3 分 + 主观题 52 分，满分 100）。

## v1.7.1 (2026-06-30) — 网上阅卷能力补全

### 网上阅卷队列

- 新增 `GET /api/review/exams/:examId/blocks`：按大题块汇总待阅/已阅数量。
- 增强 `GET /api/review/exams/:examId/block-crops`：返回学生姓名，供阅卷队列展示。
- 新增 `POST /api/review/exams/:examId/block-crops/:cropId/submit`：提交题块分数、更新切块状态、重算总分与排名。
- 新增 `ReviewService`：题块汇总、分数 upsert、排名重算。
- 教师成绩详情页新增 **网上阅卷** Tab（`OnlineReviewPanel`）：左侧题块列表 + 右侧切块图片与逐题打分。

### 状态流转

- 切块默认 `ready`（待阅）→ 提交后 `reviewed`；可标记 `disputed`（争议）。

### 暗色模式视觉升级

- **答题卡预览**：暗色 UI 下 `.page` 保持白纸黑字（`#ffffff` 背景 + `color-scheme: only light`），不再继承深色表面色。
- **SVG 文字**：将全局浅色 `fill: #EAEAEA` 改为仅作用于 `.page` 内的 `#111` 黑字，修复预览文字几乎不可见的问题。
- **对比度**：`--text-secondary` / `--muted` 调亮，次要文字在暗色背景下更易读。
- **网上阅卷**：`OnlineReviewPanel` 侧栏、题块列表、图片区与打分输入框暗色适配。
- **工程清理**：删除 `styles.css` 末尾约 1000 行重复的暗色规则块。

### 分数统计图修复

- **箱线图交互**：分数统计分布 图中班级柱形可点击，联动顶栏班级筛选；补传 `selectedClassId` 修复高亮不更新。
- **图例与可读性**：新增极值/四分位/中位/均值图例，加粗坐标与柱形对比度，暗色模式下提升箱线图与分数段分布可视性。
- **成绩变化曲线**：分析页考试列表下方恢复 `AnalysisTrend`（重构后曾丢失未渲染）。
- **演示校验脚本**：修正上次考试对比用例（应对「演示-数学」而非「数学月考」发起请求）。

### 合并 main（v1.6.4 / v1.6.5）

- **背景图 API**：恢复 `GET /api/app/background` 与 `POST /api/users/me/background`。
- **设置保存崩溃**：`PATCH /api/users/me/settings` 改为读取 `req.body`（非 `validatedBody`）。
- **exam_groups 列补齐**：SQLite / MariaDB 新增 migration v15，补齐 `source` 等缺失列。
- **前端防御性加固**：`ScoreDetailPage`、`AccountMenu`、`App` 对设置返回值增加 null-safe guard。

## v1.7.0 (2026-06-30) — 成绩分析补全与学生学期对比

### 成绩分析补全

- 实现 `GET /api/analysis/exams/:examId/previous`：对比上一场同科目考试，返回均分/及格率变化。
- 修复 `findPreviousExam`：`grade_id` 为 NULL 时正确匹配；日期回退使用 `exam_date → start_time → created_at`。
- 教师成绩详情「概况」Tab 展示上次考试对比条（均分变化、及格率变化）。

### 学生端分析增强

- 新增 `GET /api/scores/me/semester-comparison`：按学年学期（8月~1月为第一学期，2月~7月为第二学期）汇总成绩。
- 学生成绩页新增学期对比 Tab，柱状图展示各学期/各科均分。
- 学生端雷达图与排名趋势可下拉切换考试/大考组/学期三种维度。

### iOS 15 Safari 兼容（基于 #141）

- Vite web 构建目标设为 `es2020 + safari15`，确保 JS 在 iOS 15 / macOS Safari 15+ 上可解析运行。
- 修复 `Array.prototype.at` 在 iOS 15 上不可用导致 白屏 的问题。
- `src/components/WebCompat.tsx`：Safari 专用兼容检测与提示横幅。

### 工程清理

- 删除 `.tsbuildinfo` 缓存，确保类型检查从零开始。



## v1.6.5 (2026-07-01) — iOS 15 Safari 兼容与错误边界 (#141)

### Web SPA 兼容性

- **iOS 15 / Safari 15 降级编译**：Vite web 构建目标设为 `es2020 + safari15`（`vite.config.ts`），搭配 `package.json` 中 `browserslist: "iOS >= 15, Safari >= 15"`，确保产出 JS 在 iOS 15 Safari 上可解析运行。
- **Runtime polyfills**：新增 `src/apps/answer-card/client/polyfills.ts`，在 `main.tsx` 最顶部加载，补丁 `Object.hasOwn` 和 `structuredClone`（iOS 15.0-15.3 缺失这两个 API）。
- **无痕浏览 localStorage 容错**：`App.tsx` 中主题读写的 `localStorage.getItem/setItem` 包裹 `try/catch`，避免 iOS Safari 隐私模式下抛出 `SecurityError` 导致白屏。

### ErrorBoundary

- **新增 `ErrorBoundary.tsx`**：React class 组件包裹 `<AuthProvider>` + `<App />`。任意组件渲染异常时展示「页面加载失败」恢复界面，含错误信息和「刷新页面」按钮，替代原有空白页。

### 依赖清理

- `package-lock.json` 轻量化：移除 `@electron/windows-sign`、`electron-winstaller`、`postject` 等不必要 peer 依赖，标记 `@types/node` / `@types/react` / `csstype` / `react` 等为 `devDependencies`。

## v1.6.4 (2026-07-01) — 背景图恢复与设置保存崩溃修复

### Bug 修复

- **背景图不显示**：`GET /api/app/background` 和 `POST /api/users/me/background` 路由在 v1.6.0 数据库重构中被意外删除，导致 CSS `body.has-bg-image::after` 请求 404 JSON 而非图片数据。现已恢复两个路由。
- **保存设置时服务端崩溃**：`PATCH /api/users/me/settings` 在 v1.6.3 修复时写入了 bug — handler 从 `(_req as any).validatedBody` 读取请求体，但 `validateBody` 中间件将校验后数据写入 `req.body`（而非 `validatedBody`），导致 `body` 始终为 `undefined`，访问 `body.scoreDisplayMode` 时报 `TypeError: Cannot read properties of undefined`。成绩详情页切换显示模式（偏差值/Z值/百分位）或账号设置保存时均会触发此崩溃。**修复**：改为读取 `(_req as any).body`。
- **SQLite / MariaDB `no such column: source`**：老数据库（v1.6.0 初期创建的）`exam_groups` 表缺少 `source`、`description`、`start_date` 等列（schema 已更新含这些列，但 `CREATE TABLE IF NOT EXISTS` 不会重建已存在的表；migration v8 若在列补齐逻辑加入前已被标记为"已应用"则跳过补齐）。双数据库均新增 migration v15（SQLite: `migrations.ts` + MariaDB: `mysql.ts`）确保所有缺失列在启动时补齐。
- **前端防御性加固**：`ScoreDetailPage.tsx`、`AccountMenu.tsx`、`App.tsx` 中对 `/api/users/me/settings` 返回值的访问增加了 null-safe guard。

## v1.6.3 (2026-06-29) — 暗色主题完善与登录页隔离

### 暗色模式按钮修正

暗色模式下按钮颜色从与亮色一致的亮粉红修正为沉稳暗红色，移除高光效果。

- `[data-theme="dark"]` Brand 色板：
  - `--brand`: `#F05060` → `#C0392B`（深暗红）
  - `--brand-light`: `#FF7080` → `#D44637`
  - `--brand-dark`: `#D03040` → `#96281B`
  - `--brand-glow / --brand-soft / --brand-tint`：对应调暗
  - `--shadow-brand / --shadow-brand-lg`：减弱发光（opacity 从 0.30/0.35 降至 0.15/0.18）
- 移除按钮高光：
  - `.primary-button::after` → `background: none`
  - `.mode-toggle button.active::after` → `background: none`
  - `.answer-key-row button.active::after` → `background: none`
- `.primary-button:hover:not(:disabled)` 不再 `filter: brightness(1.05)`

### 账号区域暗色背景适配

暗色模式下账号菜单和账号管理面板的背景从灰色残余修正为深色。

- `.account-menu-trigger`：暗色下 `background: var(--surface-raised)`（原 `rgba(255,255,255,0.65)` 在暗色下显示为灰白块）
- `.account-form-grid / .account-import-box / .class-column / .score-card`：暗色下 `background: var(--surface)`
- `.account-search`：暗色下 `background: var(--surface-raised)`
- `.class-list-item / .roster-item / .student-search-item`：暗色下适配背景、文字和 hover 边框色

### Web / Scanner 登录页隔离

Web 教师/学生端登录页错误地包含了扫描端的「服务器连接」和「API Key」输入框。

- **`LoginPage.tsx`**：恢复为老版本，仅含用户名 + 密码 + 记住我 + 使用说明，用于 Web 端
- **`LoginPageScanner.tsx`**（新建）：含远端服务器配置（URL + API Key + 测试连接），标题改为「答题卡扫描端」，仅扫描端使用
- **`ScannerApp.tsx`**：登录页改为 `import { LoginPageScanner }`

### 删除夜间模式可控开关

夜间模式已工作稳定，无需再通过账号设置中的「实验性」复选框来隐藏主题切换按钮。

- **App.tsx**：删除 `darkModeEnabled` state 与 `{darkModeEnabled && (...)}` 条件包裹，主题切换按钮常驻 Tab 栏
- **AccountMenu.tsx**：删除 `darkModeEnabled` / `setDarkModeEnabled` props，删除「夜间模式（实验性）」复选框和 ⚠ 警告文字
- `theme` useEffect 简化：直接 `setAttribute("data-theme", theme)`

### Bug 修复

- **保存设置报 「API route not found」**：`PATCH /api/users/me/settings` 路由在服务端缺失，现已添加 `GET`/`PATCH` 两个处理函数，使用 `UpdateUserSettingsSchema` 校验，直接更新 users 表
- **新建答题卡后列表不刷新**：`createCard` 中 `refreshCards()` 移到 `finally` 块确保总被执行，同时给 `examAction === "link"` 路径加 try-catch 防止关联失败中断刷新
- 与 main 分支的 `styles.css` 合并冲突已自动解决

## v1.6.2 (2026-06-29) — 大题切块与扫描端打包修复

### 大题作答图片切块

- native `answer-card-recognizer` 新增 `--crops-dir <dir>`，识别成功后复用 marker 匹配与透视校正结果，在 warped A4 图上按 `layout.pages[].blocks[]` 裁剪大题图片。
- 裁剪区域优先使用 `frameRect`，没有时退回 `rect`，默认扩展 2.5mm padding，并 clamp 到页面范围内；同一大题跨页时生成多张续页图片，不做跨页拼接。
- 识别 JSON 新增 `blockCrops` manifest，包含 `blockId/blockTitle/blockType/pageNumber/segmentIndex/questionNumbers/rect/path/widthPx/heightPx/dpi`。
- 服务端新增 `AnswerBlockCropService` 与 `answer_block_crops` 表，统一索引普通阅卷 `scan_records` 与扫描仪 `twain_scan_records`。
- 批量阅卷在 `ExamRepository.addScanRecord()` 返回记录 ID 后持久化切块；扫描仪 OCR 以 `twain_scan_record` 为 source 写入切块。
- 学生成绩详情与教师个别改分页新增“大题作答图片”区域，点击题目可按 `questionNumbers` 定位到对应大题块；缺少切块时沿用整页答题卡预览。
- 新增 `GET /api/answer-block-crops/:cropId/image`，并预留 `GET /api/review/exams/:examId/block-crops` 供网上阅卷队列读取题块、学生、分数和状态。

### 扫描端打包修复

- 修复 Electron 扫描端启动时报 `ENOENT, dist\scanner\index.html not found in app.asar`：scanner 构建完成后将 `index-scanner.html` 规范化为 `dist/scanner/index.html`。
- 移除未使用的 `localtunnel` 运行依赖，消除 electron-builder 的 `localtunnel@undefined` 依赖路径警告。
- x64 打包脚本继续通过 `-c.electronDist=node_modules/electron/dist` 复用本机 Electron；ia32 打包不再复用 x64 Electron，改为下载/使用真正的 32 位 Electron 运行时。
- 已验证 `release/win-unpacked/答题卡扫描端.exe` 为 x64，`release/win-ia32-unpacked/答题卡扫描端.exe` 与 ia32 `better_sqlite3.node` 为 x86。
- ia32 Electron 打包后建议执行 `npm run native:rebuild:node` 恢复开发环境 Node 版 `better-sqlite3`。

### 版本号

- `package.json` / `package-lock.json` 更新为 1.6.2，README 发布文件名同步更新。

## v1.6.1 (2026-06-28) — Web/Scanner 构建分离

### 构建拆分

代码库拆分为两个独立的 Vite 构建目标：

```
v1.6.0:  dist/client/ (全在一起)
v1.6.1:  dist/web/ (教师+学生) + dist/scanner/ (扫描端)
```

- **Web 构建** (`vite build --mode web` → `dist/web/`)：教师 + 学生页面，**不含 ScannerPanel 代码**，部署到服务器
- **Scanner 构建** (`vite build --mode scanner` → `dist/scanner/`)：仅 ScannerPanel，打包进 Electron 桌面端
- **入口文件**：`index.html` (Web) / `index-scanner.html` (Scanner)，各含独立 `main.tsx` / `main-scanner.tsx`
- **ScannerApp.tsx**：新建独立扫描端组件，含答题卡选择 + 扫描面板 + 结果预览，无设计/分析/账号等 Tab
- **App.tsx**：移除 ScannerPanel 导入和使用（web 模式不需要）

### 扫描端重构：答题卡选择 + 工作台

- **双屏路由**：`CardSelectPage`（选卡）→ `ScannerWorkspace`（扫描）
- **CardSelectPage.tsx**：对齐 ExamSelectPage 风格
  - 单科/大考双 Tab 切换
  - 搜索框（按 ID 或名称搜索）
  - 学科下拉筛选
  - 表格列表（答题卡名称 / 科目 / 日期）
  - 大考 Tab：展开显示下辖考试列表，点击选择对应答题卡
- **ScannerWorkspace.tsx**：扫描工作台
  - TWAIN 扫描仪直扫（复用 ScannerPanel）
  - 文件/目录导入阅卷（复用 grading API，含 GradingResults 展示）
  - 顶栏返回按钮

### 学生端 Bug 修复

- **成绩天梯无法显示**：`/api/ladder/*` 路由已定义但未在 `server/index.ts` 中 mount，所有请求落入 SPA fallback 返回 HTML
  - 修复：添加 `import ladderRoutes` 并 `app.use("/api/ladder", ladderRoutes)`
- **跨考累计 JSON 报错**：同上根因，修复后天梯三种维度（单科/大考/跨考）均可正常查询

### 废弃：学生端 / 教师端 Electron 打包

- 删除 `electron:pack:student`、`:teacher` 以及所有 ia32 变体脚本
- 教师/学生功能统一通过 Web 构建访问，Electron 只保留扫描端
- 删除 `scripts/package-variant.ts` 引用（v1.7.0 已删除该文件）
- 删除 `VITE_PROJECTX_VARIANT` 编译时变量，改用 `VITE_BUILD_TARGET`

### Electron 精简

- `electron/main.cjs`：移除 variant 体系，固定为扫描端
- 只加载 `dist/scanner/`，固定 `PROJECTX_ENABLE_SCANNER=1`
- 包名改为「答题卡扫描端」

### 后端适配

- 默认客户端目录从 `dist/client` 改为 `dist/web`
- Ubuntu 服务器打包脚本同步更新
- 移除 `PROJECTX_VARIANT` 配置项

### Persona 简化

- 管理员在 Web 端可切换「教师」/「学生」身份
- 移除「教师扫描端」persona（扫描端独立使用，无需切换）
- `AuthContext.tsx` 使用 `VITE_BUILD_TARGET` 判断 persona 可用性

## v1.6.0 (2026-06-27) — 客户端拆分 + 运行时身份切换

### 架构：从单体 Electron 到独立客户端

教师扫描端、教师端、学生端各自独立，统一通过 HTTP API 通信。

```
v1.5.5:  单一 Electron 进程（设计+扫描+阅卷 全在一起）
v1.6.0:  扫描端(Electron) ←→ 服务端(API) ←→ 教师端(WEB) / 学生端(WEB)
```

### 运行时 Persona（AuthContext 扩展）

- **管理员可在账户下拉菜单切换身份视图**：扫描端 / 教师端(学科老师/班主任/学年主任) / 学生端
- 切换即时生效，无需重启
- persona 存 localStorage，登录恢复
- 教师/学生固定身份，不可切换

**文件**：`AuthContext.tsx`（新增 type `AppPersona` / `TeacherRoleOverride` / `setPersona` / `availablePersonas`）
**文件**：`AccountMenu.tsx`（新增「查看身份」区域，仅管理员可见）

### 登录页：远端配置 + 本地模式

- 新增折叠面板「服务器连接（可选）」：输入服务器地址、API Key、测试连接
- 不填 = 纯本地模式（所有数据存本地 SQLite）
- 填了 = 教师/学生功能走远程 API
- 服务器地址和 API Key 存 localStorage
- `api.ts` 中 `getApiBase()` 改为运行时读取 localStorage

**文件**：`LoginPage.tsx`（重构，新增 Globe + 连接测试）
**文件**：`api.ts`（`API_BASE` 常量 → `getApiBase()` 函数，同时自动附带 X-Api-Key 头）

### API Key 认证体系

**新建表**（migration v11）：

```sql
CREATE TABLE api_keys (
  id, name, api_key UNIQUE, scope DEFAULT 'scanner', is_active, created_by, created_at
);
```

- `ensureDefaultAdmin()` 时自动生成一条 scanner key
- 管理 API：`GET/POST/PUT/DELETE /api/admin/api-keys`
- 中间件：`src/server/middleware/api-key.ts`（从 `X-Api-Key` header 校验）
- scope `scanner` 的 key 仅能访问 `/api/scanner/*`

### 扫描上传端点

**文件**：`src/server/routes/scanner-upload.ts`

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/scanner/upload/sessions` | 创建扫描会话 |
| `POST` | `/api/scanner/upload/sessions/:id/pages` | 上传扫描页（multipart） |
| `POST` | `/api/scanner/upload/sessions/:id/complete` | 标记完成 |
| `GET` | `/api/scanner/upload/sessions/:id/status` | 查询状态 |

双鉴权：`apiKeyAuth`（高优先级）+ `authMiddleware`（低优先级，任一通过即可）

### ScannerPanel：本地/远程双模

- 新增「本地存储」←→「上传服务器」切换按钮
- 本地模式：行为不变，扫描结果存本地 SQLite
- 远程模式：扫描完成后自动逐页上传到服务端
- 上传进度实时显示（上传中/完成/失败状态）
- 模式选择存 localStorage（`projectx_scanner_mode`）

**文件**：`ScannerPanel.tsx`（新增 `Upload`/`Database` 图标，`scannerMode` 状态，`uploadToRemote()` 函数，上传状态指示器）
**文件**：`twain_scan_records` 表新增 `uploaded INTEGER DEFAULT 0` 字段

### App.tsx 运行时 Variant

- `appVariant` 从 compile-time `import.meta.env.VITE_PROJECTX_VARIANT` → runtime `useAuth().persona`
- `hasNativeScanner` 通过 `navigator.userAgent` 检测 Electron 环境
- 扫描 TAB 可见性 = persona 允许 + grading 权限 + 本地有扫描硬件
- WEB 模式（浏览器）自动隐藏扫描 Tab

### 数据库

- 新增 `api_keys` 表（v11 migration）
- `twain_scan_records` 新增 `uploaded` 列
- 两份 schema 同步更新：`schema.sql` + `schema.mariadb.sql`

### 端口默认值改为 443

所有默认 MariaDB 端口 3306 → 443（适配仅开放 22/80/443 的防火墙场景）

### 版本号

- `package.json` 1.5.5 → 1.6.0

## v1.5.5 (2026-06-27)数据库重构
### 新增文件

| 文件 | 说明 |
|------|------|
| `src/apps/answer-card/client/styles.css` | 新增 ~300 行：CSS 变量、底部导航样式、480px 断点全部规则、横屏适配、暗色模式配套 |
| `src/apps/answer-card/client/App.tsx` | 新增 `mobileNavItems` useMemo + 底部导航 `<nav>` JSX + `ReactElement` 类型导入 |
| `index.html` | viewport meta 升级 + 3 个新 meta 标签 |

### 版本
- v1.5.2 → v1.7.3

## v1.5.2 (2026-06-26) — 数据库双后端架构

### SQLite → MySQL 双后端迁移

本项目从单机桌面端向 B/S 服务端架构演进的第一步：所有 Repository / Service / Route / Middleware 已全面异步化，支持通过环境变量切换 SQLite 或 MySQL 后端。

- **双后端适配器**（`db/mysql.ts`）：统一 `DbAdapter` 异步接口——`get()` / `all()` / `run()` / `exec()` / `transaction()`
  - MySQL 模式：`mysql2` 连接池（连接数上限 20）、事务通过 `PoolConnection` 实现
  - SQLite 模式：内部 better-sqlite3 同步调用，对外暴露 async 接口，**完全兼容原有行为**
  - 环境变量控制：不设 `PROJECTX_MYSQL_HOST` → 自动回退 SQLite，零配置零影响
- **新增 `db/schema.mysql.sql`**：完整 MySQL 建表脚本，InnoDB 引擎、utf8mb4、AUTO_INCREMENT、外键约束、30+ 索引，与 SQLite schema 一一对应
- **6 个 Repository 全量异步化**：
  - `UserRepository`（39 方法）、`AnalysisRepository`（34 方法）、`CardRepository`（22 方法）、`ClassRepository`（17 方法）、`ExamRepository`（15 方法）、`ScoreRepository`（4 方法）
  - SQL 从 `db.prepare().get()` 迁移为 `await db.get()`，事务从 sync callback 迁移为 async `db.transaction(async (tx) => {...})`
  - `INSERT OR REPLACE` 在 MySQL 端自动转换为 `ON DUPLICATE KEY UPDATE`（adapter 内透明处理）
- **6 个 Route 文件异步化**：`classes.ts`、`scores.ts`、`teachers.ts`、`users.ts`、`export.ts`、`score-editing.ts`——Express handler 全部改为 `async (req, res)`，内部调用 `await repo.xxx()`
- **2 个 Service 异步化**：`AuthService.ts`（`getUserByToken`、`login` 等核心方法）、`AssignedScoreService.ts`（赋分公式管理）
- **1 个 Middleware 异步化**：`middleware/auth.ts`——`attachUser()`、`authMiddleware()`、`getCurrentUserHandler()`、`optionalAuth()` 全部改为 async
- **App Server 局部迁移**：`app server/index.ts` 中全部 Repository 调用加 `await`，3 处 `db.transaction()` 拆为顺序 async 调���，`card-layout.ts` 中 `findCardForLayout` → async
- **Scanner DB 保持 SQLite**：`scan-store.ts`（19 处 `.prepare()`）和 grading pipeline 中的 `INSERT OR REPLACE` 保持 SQLite 原样，扫描流水线独立运行

### 依赖
- 新增 `mysql2: ^3.14.0`
- 保留 `better-sqlite3: ^12.11.1`（SQLite 回退 + scanner.db）

### 前端性能优化

- **`transition: all` 替换**：~30 处全局 `transition: all 0.3s` 替换为精确属性列表（`background`、`color`、`border-color`、`box-shadow`），消除 backdrop-filter 无效重算，减少帧间重排开销
- **毛玻璃 GPU 优化**：`.liquid-glass` 和 `.liquid-glass-strong` 增加 `will-change: backdrop-filter`，让浏览器预分配 GPU 资源；`.sidebar` 增加 `contain: paint layout style`，隔离渲染区域
- **CSS 变量别名**：新增 `--primary: var(--brand)`、`--bg-secondary: var(--surface-raised)`、`--bg-accent: var(--brand-soft)`、`--border: var(--line-strong)`，解决多个组件引用未定义变量导致的暗色模式渲染异常

### Bug 修复

| 修复项 | 文件 | 说明 |
|--------|------|------|
| 表名不一 | `AnalysisRepository.ts` ×2 | `exam_group_items` → `exam_group_members`（与 schema v8 对齐） |
| 列名错位 | `app server/index.ts` | 主观题 `question_id` 误写入 `block_id` 列 → INSERT 列宣言改为 `question_id` |
| 默认值不一致 | `migrations.ts` ×2 | `score_display_mode`: `'deviation'` → `'zscore'`；`export_templates.name`: `'Untitled'` → `'未命名'` |
| localStorage 写错值 | `App.tsx:529` | 关闭夜间模式后仍写入 `"dark"` → 改为写入 `effectiveTheme` |
| 组件白色硬编码 | `CreateExamGroupModal.tsx` ×4、`GroupExportModal.tsx` ×2 | `#fff` 背景改为 `var(--surface)`，品牌按钮色改为 `var(--brand)` |
| 合并冲突冗余 | `CreateExamGroupModal.tsx`、`GroupExportModal.tsx` | 清除 `<<<<<<<`/`>>>>>>>` git 冲突标记 |

### 版本
- v1.5.1 → v1.5.2

## v1.5.1 (2026-06-25) — 学生端升级

### 学生端全面升级

- **个人成绩趋势分析（纵向）**：新增折线图展示学生各科历次考试成绩变化趋势，支持多学科同时对比、班级均分/年级均分参照线开关。使用 Chart.js 渲染，学科标签可交互筛选
- **学科横向对比（薄弱学科识别）**：雷达图 + 详情表格，聚合本学期全部考试数据，按各科平均分与班级均分差距自动标注薄弱学科。支持趋势方向（进步/退步/稳定）图标标识
- **AI 个人分析**：两种模式
  - **单场分析**：在成绩列表展开某场考试后，点击「AI 分析」按钮调用教师端现有 AI 接口
  - **整体分析**：综合学生全部考试成绩，生成个性化学习建议和薄弱点分析
- **学生自配 AI 服务商**：复用已有 `ai_providers` 系统，学生可在 AI 分析 Tab 中自行填写 API Key 和模型配置（支持 DeepSeek / OpenAI 兼容 / Gemini），费用由学生个人承担
- **综合仪表盘 UI**：从单一成绩列表重构为混合式布局——顶部统计概览卡片（考试数/平均分/学科数/最佳/待提升），Tab 导航切换四个功能模块

### 新增后端 API

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/scores/me/trends` | 学生成绩趋势数据（含班级/年级均分） |
| `GET` | `/api/scores/me/subject-comparison` | 学科横向对比分析（含薄弱学科标注） |
| `POST` | `/api/scores/me/ai-analysis` | 学生个人 AI 整体分析 |

### 新增类型
- `StudentTrendPoint`：趋势数据点（总分、班级均分、年级均分、排名、百分位）
- `SubjectWeaknessItem`：学科薄弱分析结果（考试次数、平均分、班级均分差距、趋势方向）
- `StudentAiAnalysisRequest`：学生 AI 分析请求

### 数据库
- 无新增表，复用已有 `ai_providers` 表

### 依赖
- 新增 `chart.js` + `react-chartjs-2`

### Bug 修复
- **折线图数据对齐**：不同学科的考试名不一致时，之前按数组索引对齐导致数据点错位，现改为按考试名映射到共享 labels
- **新路由认证缺失**：`POST /api/scores/me/ai-analysis` 移入 `scores.ts` 路由器，自动享受 `authMiddleware` 保护
- **SQL 列不存在导致 500**：`ScoreRepository.getStudentTrendData()` 引用了 `class_students.is_active` 列，该列不存在；修复为移除虚假列引用、`JOIN` 改为 `LEFT JOIN` 子查询处理多班级、学生无班级时 classAvg 返回 NULL
- **学生可越权访问教师分析接口**：`getVisibleExamIds()` 对学生返回 `null`（全部可见），导致学生可调用任意考试的 AI 分析接口。修复：`requireExamAccess` 中增加学生分支，仅放行 `hasScore()` 为 true 的考试
- **学生通过 hasScore 可越权删除考试/查看全班数据**：`requireExamAccess` 的学生分支对所有方法（GET/DELETE/...）通行。修复：学生分支仅允许 `POST /.../ai-analysis`，其余方法返回 403
- **AI 单场分析按钮在 auth 强制模式下永久 403**：`POST /api/analysis/exams/:examId/ai-analysis` 经过 `analysisGate` 要求 `grade:read`，学生只有 `score:read`。修复：新增 `POST /api/scores/me/exams/:examId/ai-analysis`（挂载在 scores router 下，无 analysisGate），前端 `AiAnalysisForExam` 改为调用该端点
- **整体 AI 分析后端对接错误**：`POST /api/scores/me/ai-analysis` 原设计向 llmclient 发送 `examId: 0` + `studentAnalysis: true`，但 llmclient 仅支持 exam-scoped 请求。修复为直接用服务端已有的趋势数据生成文本分析报告，不再调用 llmclient；待 llmclient 支持学生分析后可切换回
- 清理未使用的 import

### 新增后端 API
| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/scores/me/exams/:examId/ai-analysis` | 学生单场考试 AI 分析（绕过教师端 RBAC gate） |

### 版本
- v1.5.0 → v1.5.1

## v1.5.0 (2026-06-24) — 稳定版

### 跨考入口 & 排名修复
- **三选一紧凑切换**：考试选择页右上角 toggle 改为 [单科 | 大考 | 跨考]，跨考不再单独占一个按钮
- **跨考内联化**：跨考试总分统计直接嵌入 ExamSelectPage，不再跳出独立页面，无需「返回」操作
- **按周预览**：跨考「按日期打包」模式新增实时考试预览，切换日期即刻看到该周包含哪些考试
- **日期/按钮对齐**：跨考面板日期输入框与统计按钮统一基线对齐
- **全局并列排名修复**：所有排名从顺序排名改为同分并列排名（1,2,2,4,5...），覆盖跨考总分、大考排名、单科排名、导出表格等全部场景
- **competitionRank 提取**：排名工具函数从 `denseRank` 重命名为 `competitionRank`（更准确），提取到 `src/shared/ranking.ts` 避免 AnalysisRepository 与 exam-groups 代码重复
- **表名统一**：AnalysisRepository 从 `exam_group_items` 改为 `exam_group_members`，消除迁移后新装环境表缺失导致的跨考功能不可用
- **列表隔离**：按 `source` 列隔离大考列表（`NULL`/`'manual'`）与跨考已存组列表（`'cross-manual'`/`'week'`），避免互相泄漏
- **删除确认**：跨考已存组删除增加确认弹窗（显示关联考试数），考试管理大考删除支持级联考试选项
- **周预览口径对齐**：前端周预览日期取值与后端 `COALESCE(exam_date, created_at)` 对齐，无答题卡日期考试不再遗漏
- **名次变化修复**：上次考试排名（preRankMap）改用并列排名，消除同分场景下名次变化计算偏差
- **死代码清理**：删除已内联但未删除的 CrossExamTotalPage.tsx (424行) 和 migrations.ts 中未调用的 createExamGroupsIfMissing
- **暗色主题**：跨考删除确认弹窗改用 CSS 变量，暗色模式下不再白框刺眼

### 大考（Exam Group）功能

- **大考组 CRUD**：支持创建「大考合集」将多场单科考试组织为一个逻辑大考（如"2026高考摸底大考"包含语数英物化生）
- **关联考试管理**：创建时可选择关联已有考试，创建后也可增删成员考试，支持拖拽排序
- **大考内新建考试**：可直接在大考合集中快速创建新考试并自动关联
- **大考分析视图**：概览 Tab 展示各科参数卡片网格（人数/均分/最高/最低/标准差/及格率/优秀率），成绩 Tab 提供跨科横向排名表
- **跨科排名**：按总分排名显示校排/班排，每科单独显示原始分/赋分/校排/班排，支持班级筛选和「仅全科参加」开关
- **总分模式**：可按原始分或赋分计算总分排名
- **大考标签**：支持月考/期中/期末/模考/统考标签分类
- **考试选择页大考入口**：新增「单科考试」/「大考」分类切换
- **考试管理页大考入口**：考试管理 Tab 新增单科/大考模式切换，支持大考列表管理

#### 数据库
- 新增 `exam_groups` 表（name, description, grade_id, tag, status, is_official, total_score_mode, only_full_participants）
- 新增 `exam_group_members` 表（group_id, exam_id, sort_order）
- Migration v8 幂等创建

#### API
| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/exam-groups` | 大考列表 |
| `POST` | `/api/exam-groups` | 创建大考 + 关联考试 |
| `GET` | `/api/exam-groups/:groupId` | 大考详情含成员列表 |
| `PUT` | `/api/exam-groups/:groupId` | 更新大考信息 |
| `DELETE` | `/api/exam-groups/:groupId` | 删除大考（级联，不删考试） |
| `POST` | `/api/exam-groups/:groupId/exams` | 批量关联考试 |
| `DELETE` | `/api/exam-groups/:groupId/exams/:examId` | 移除关联 |
| `PUT` | `/api/exam-groups/:groupId/exams/sort` | 批量更新排序 |
| `GET` | `/api/exam-groups/:groupId/overview` | 大考概览（各科参数） |
| `GET` | `/api/exam-groups/:groupId/rankings` | 跨科总分排名 |
| `POST` | `/api/exam-groups/:groupId/export` | 导出 ZIP（总览+各科小分） |

### 导出增强

- **单科导出新增可选胶囊**：`客观题小分` 和 `主观题小分`，可选加入导出列
- 客观题小分：拉展该科所有客观题得分（Q1/Q2/...），含每题满分标注
- 主观题小分：拉展该科所有主观题得分（S1/S2/...），含每题满分标注
- 胶囊颜色分类：基础(蓝)/分数(绿)/排名(橙)/题目(紫)
- **大考导出（ZIP）**：总览表（跨科排名+各科原始分/年排/班排）+ 各科详细小分 Excel 文件
- 导出可选：是否包含客观题小分、主观题小分、选择导出哪些科目

### 前端组件
- `CreateExamGroupModal`：创建/编辑大考弹窗，含考试搜索选择器
- `ExamGroupDetailPage`：大考分析视图（概览+成绩 Tab）
- `GroupExportModal`：大考 ZIP 导出配置弹窗
- `ExamSelectPage` 更新：新增单科/大考分类切换
- `ExportModal` 更新：新增客观题小分/主观题小分胶囊列
- `App.tsx` 集成：大考创建模态框、大考分析视图、考试管理双模式

### 跨考试总分分析（合并自 main）

- **CrossExamTotalPage**：三种模式（按周自动打包 / 手动选考试 / 选择已存大考组）计算跨考总分排名
- 按日期范围自动关联一周内的考试，快速生成一周考试包总分
- 支持仅全科参加、仅部分参加等出席模式筛选
- 考试选择页新增「跨考总分」快捷入口
- API: `GET/POST/DELETE /api/analysis/cross-exam/groups`, `POST /api/analysis/cross-exam/total`
- DB: `exam_groups` 表新增 `source`/`start_date`/`end_date` 字段兼容两种用途

### 备案合规
- **ICP 备案信息**：登录页底部新增备案号展示（辽ICP备2026013340号 + 辽公网安备21020402001085号），`BeianFooter.tsx` 组件含工信部/公安备案双链接

### 性能优化
- **毛玻璃性能修复**：大量 `backdrop-filter: blur()` 改为 `opacity` 叠加，消除滚动/切换页面时的明显卡顿感（#115）

### Bug 修复
- **暗色主题残余硬编码**：CreateExamGroupModal、GroupExportModal 内联白色背景改为 CSS 变量，修复暗色模式下弹窗白块（#113）

### 开发者工具
- **Demo 测试数据集**：新增 `testdata/demo-exams/`，含可导入备份 ZIP、CSV 片段、种子脚本和验证脚本，覆盖单科/大考/跨考/并列排名/缺考/名次变化/小分导出等全场景（#116）

### 教师角色细化
- **组长/科任/班主任严格区分**：后端数据范围过滤逻辑完善，真正实现 `subject_teacher`（本科目本班）、`head_teacher`（本班全科）、`grade_leader`（全年全科）三级隔离；修复相关数据库查询值名问题（#114）
### 版本
- v1.4.7 → v1.5.0

## v1.4.7 (2026-06-20)

### 教师细分角色（权限数据范围）

- **教师三种细分角色**：管理员可在「教师管理」中设置三种角色，登录后自动限定数据可见范围
  - **学科老师**（`subject_teacher`）：仅限本学科本人所教班级的考试与成绩
  - **班主任**（`head_teacher`）：仅限所管班级全部科目考试与成绩（限本年级）
  - **学年主任**（`grade_leader`）：全年级全科目，不受限制
  - 未设置细分角色的教师保持原全权限，向后兼容
- **后端数据范围过滤**：所有 `/api/exams`、`/api/analysis/exams/:id/*`、`/api/exams/:id` 端点自动根据 `teacher_role` 过滤可见考试
- **数据库**：`users` 表新增 `teacher_role TEXT` 列；自动 migration
- **管理员 UI**：用户管理列表新增「教师细分」列；新建/编辑表单增加角色下拉；教师管理面板增加角色选择

### 暗色模式全面修复
- 15 处硬编码 `background: #fff` 改为 CSS 变量 `var(--surface)`
- 所有 TSX 组件内联 `#fff` 背景统一替换为 `var(--surface)`
- 表单元素（input/select/textarea/checkbox）暗色适配
- 模态卡片、面板、编辑区暗色适配
- SVG 答题卡预览页暗色适配（CSS 变量 + style 双保险）
- 侧栏渐变、badge 标签、下拉菜单暗色适配
- 背景图在暗色模式下叠加 `brightness(0.45)` 遮罩
- 追加 ~90 行 `[data-theme="dark"]` 集中覆盖规则

### 账号设置重构
- 左侧分类导航栏：阅卷设置 / 客户端设置 / AI 设置
- 选中项品牌色高亮 + 左边框指示
- 右侧内容面板按 Tab 切换，独立保存按钮
- 默认展开"阅卷设置"

### Gemini SDK 完整修复
- `providers.py`: 修复用户配置 Gemini 时走错 OpenAI 路径的致命 Bug
- `ai-providers.ts`: Gemini 不再强制要求 Base URL
- 前端 Gemini 选中时隐藏 Base URL 输入框，显示提示文案
- "如何填写？"帮助卡片更新：Gemini 标注为"无需填写"
- 新增 Google AI Studio 获取 API Key 指引

### Bug 修复
- **Markdown 链接解码错误**：`UserGuidePage.tsx` 处理本地 .md 相对链接，阻止 Electron file:// 协议下的乱码
- **学生导入去年级列**：CSV 模板从 `年级,班级,学号,姓名` → `班级,学号,姓名`，后端自动从"几年几班"解析年级
- **学生管理滚动容器**：年级/班级/花名册三栏添加 `max-height` 内滚动，不再拉伸整个页面
- **ESC 全局退出**：ESC 关闭成绩分析 detail / 赞助页 / 使用说明页，聚焦输入框时跳过
- **自动保存提示圆角容器**：`.autosave-status` 改为圆角 pill 样式

### 答题卡设计增强
- **题块自动命名**："一、单选（10题 50分）"实时生成，`toChinese(n)` 算法支持 1-100，增删块/改题型/改题数/改分值时自动刷新
- **块级编辑同步**：修改块级题型/选项数时自动同步到所有逐题配置
- **每题配置默认折叠**：按需展开/收起，减少设计器面板高度

### 夜间模式开关
- 账号设置 → 客户端设置 → 新增「夜间模式（实验性）」复选框
- 默认不启用，标注"⚠ 实验性功能，存在严重视觉问题"
- 不启用时顶部栏隐藏主题切换按钮
- localStorage 持久化存储

### 版本
- v1.4.6 → v1.4.7

### 日间/夜间模式
- 新增主题切换按钮：位于顶部栏右侧，☀️/🌙 SVG 图标即按钮，点击即时切换
- 完整深色色板：品牌色、中性色阶、阴影、毛玻璃效果全部适配暗色背景
- `data-theme="dark"` 属性挂载 html，`color-scheme` 同步，系统表单元素自动暗色
- 设置持久化：localStorage 保存选择，刷新后保持

### Bug 修复
- **答题卡放大控件无效**：`width` 百分比在 flex 容器中仍被约束 → 改用 `transform: scale()` 缩放图片
- **背景图被遮挡（四次修复）**：`body::before{z:-1}` → `body.style.background` → `insertBefore+#root z-index` → 最终 `body::after` 浮层覆盖（内容面板 15+ 处 `background:#fff` 把视口填满，背景放哪层都没用，必须浮在最上面用半透明穿透）
- **背景图透明度可调**：checkbox 开/关 → range 滑块 0%~50%，滑块拖动即时生效无需保存
- **上传自定义背景图**：设置面板新增上传按钮，`POST /api/users/me/background`，存储到 `data/answer-card/backgrounds/`
- **手动改分后赋分自动重算**：`recomputeRankings()` 末尾追加 `AssignedScoreService.recalculateAll()`

### 数据库 & API
- 新增 `users.background_opacity REAL DEFAULT 0`（旧 `show_background` 列自动迁移）
- `GET /api/app/background` 优先返回用户自定义背景
- `POST /api/users/me/background` multipart 上传（5MB, image/*）
- settings API 新增 `backgroundOpacity` 字段

## v1.4.5 (2026-06-19)

### AI 服务商配置优化
- 账号设置中 AI 服务商「如何填写？」改为独立卡片弹窗（createPortal），不再叠在设置上
- 移除旧 AI API Key 输入框（已被 AI 服务商完全替代）
- Base URL 保存时自动补齐 `/v1` 路径
- 哈基米合并为 Gemini，下拉选项简化为 GPT/DeepSeek/Gemini
- 修复保存 Gemini 时报错 `NOT NULL constraint failed: ai_providers.user_id`
- AI 分析接口错误信息中文化：区分连接失败/超时/404

### 成绩修改 + 逐题明细
- 数据库新增 `answer_overrides` 表 + 成绩表新增手动修改追踪字段
- API: 学生搜索、逐题改分、修改答案批量重算、班级均分统计
- `ScoreFixPage`: 双模式→搜索→逐题改分/答案编辑，内嵌答题卡（点击放大）
- `StudentScoreDetail`: 点击成绩表行→子页面，逐题得分+班级均分率+答题卡
- 成绩 Tab 栏右侧「分数有问题？」按钮（仅教师/管理员）

### 弹窗遮挡修复
- `ScoreFixPage` 图片放大、`ScanPreviewModal`、`ImportCardModal`、`StudentScoreDetail` 全部 `createPortal`
### 分数段动态化
- 硬编码 0-59/60-69/... 改为按 10 分一段自动生成，末段截止满分
- 0 人分段自动隐藏，颜色按位置（首段红/末段绿）

### 弹窗遮挡修复
- `ScoreFixPage` 图片放大、`ScanPreviewModal`、`ImportCardModal`、`StudentScoreDetail` 全部 `createPortal`
- 修改答案后自动调用评分引擎重算全部分数+排名

## v1.4.0 (2026-06-18)

### 缺陷修复 (2026-06-19)
- 导入答题卡创建考试时科目存为拼音（如 wuli）→ 改为优先用 `subjectLabel`（中文名）
- 新建考试默认状态从 `draft` 改为 `active`，避免阅卷后状态异常
- 阅卷流程 `prepareLayoutForCard` 增加 `normalizeCard` 调用，旧卡阅卷自动修复 null 数值

### 答题卡预览改造 (2026-06-19)
- 答题卡预览从新窗口打开改为页内叠加弹窗：半透明背景蒙层(z-index:99999)，支持多页纵向滚动
- 新建公共组件 `ScanPreviewModal.tsx`：PDF 风格预览，缩略图导航，PgUp/PgDn/ESC 快捷键
- ScannerPanel 和设计模式阅卷结果均迁移到新组件，删除旧 `StudentDetailModal` 内联代码
- 分析-成绩表格新增「答题卡」列：每行显示蓝色「预览」链接，点击弹出答题卡图片
- 按学生过滤：API 通过 scan_records 插入顺序与上传文件时间排序对齐，只返回该学生的答题卡页
- 新增 API: `GET /api/scanner/exam/:examId/student/:studentId/scans` + `GET /api/scanner/grading-image/:cardId/:fileName`
- 修复: 原查 scanner.db（空库），现从 recognition/uploads/:cardId/ 读取实际文件
- 修复: grading 持久化 file_path 改为存 multer 实际路径（新阅卷生效）
- 单面答题卡不显示"正面/反面"标识

### 导入答题卡模板增强 (2026-06-19)
- 导入 `.projectx-card.json` 后弹出 `ImportCardModal` 确认卡片
- 可修改：科目、考试名称、考试日期（内联日历选择器）
- 考试关联三选一：不创建 / 创建考试（留空默认同答题卡名）/ 关联已有考试
- 后端 import 端点支持 override 字段 + 自动创建/关联考试

### 成绩查看大改造
- 新增「考试选择页」：按学年、年级、学科三级筛选，卡片网格展示考试，含人数/均分/状态预览
- 考试管理从分析子Tab独立为顶层「考试管理」Tab，位于设计右侧
- 成绩查看页新增班级选择器（右上角），5个子Tab：概况、成绩、考试分析、AI分析、得分率
- 概况Tab重写：信息卡片 + 分数段水平条形图 + 箱型图 + 上次考试对比条

### 成绩表格增强
- 成绩表格支持排序：全年级按校排，单班级按班排
- 新增「名次变化」列：对比上次同科考试，↑进步/↓退步箭头 + 颜色
- 新增「偏差值/Z值/百分位排名」三选一（账户设置切换）
- 新增 API: `/api/analysis/exams/:id/score-table`

### 赋分引擎
- 新增三种赋分公式：等比例转换、线性公式(raw×0.7+30)、自定义表达式
- 赋分科目自动识别：化学、生物、地理、政治
- 赋分配置可在考试创建时和考后修改，实时批量重新计算
- DB: `student_scores.assigned_score`, `exams.assigned_formula`

### 导出系统扩展
- 导出模板系统：4个自定义模板槽，每个模板可命名并保存列配置
- 胶囊拖拽排序列：每列以胶囊形式展示，支持拖拽更换列序
- 数据预览：导出前预览前3行真实数据
- 侧表：可附加年级前N名参照表，N可手动输入，与主表间有空隙
- A4竖版适配：超出1页时警告提示
- 新增表: `export_templates`

### 账户设置
- 偏差值/Z值/百分位排名三选一
- 复核置信度阈值滑块 (0~1)
- DB: `users.score_display_mode`, `users.review_confidence_threshold`

### 数据库迁移
- student_scores 新增 assigned_score 列
- exams 新增 assigned_formula 列
- users 新增 score_display_mode, review_confidence_threshold 列
- 新增 export_templates 表
- 新增 ai_providers 表（多服务商配置）

### AI 多服务商扩展
- 支持 GPT / DeepSeek / 哈基米 / Gemini 四条AI分析线路，可自定义 Base URL
- 账号设置新增「AI 服务商」管理：添加/编辑/删除服务商配置
- AI 分析面板新增服务商下拉选择 + 模型输
- 数据库：ai_providers 表 (name, provider_type, base_url, api_key, models)
- API: GET/POST/PUT/DELETE /api/ai/providers

### 班级对比增强
- 考试分析Tab班级对比新增「对比基准班级」下拉，选择班级后显示均分差值
- 班级按年级分组展示（optgroup），未分配年级自动归入「无年级」
- 班级对比表支持行间均分差异着色（↑绿/↓红）

### 成绩表格增强
- 成绩表格新增「年级」列（通过 LEFT JOIN grades 获取）
- 概况Tab新增「年级前五/后五」排名（按分数排序）
- 概况Tab新增「进步前五/退步前五」排名（按名次变化排序）

### UX 修复
- 账号设置 Modal 使用 Portal 渲染到 body，修复 backdrop-filter 遮挡问题
- Z值/班级下拉框垂直对齐统一（padding + flex 居中）
- 考试管理表格样式统一为列表式（exam-list-table div 布局）
- 子Tab 文字与标题栏左右对齐
- 平均分卡片移除红色高亮框
- 导出按钮文字横向排列（whiteSpace: nowrap）

### Bug 修复
- **答题卡竖向排列修复**：客观题「竖向（4题一组）」不再将每道题的 A/B/C/D 选项完全纵向堆叠并独占整行，改为高考 AB 卡式 4 题一组纵向排布，每题选项仍保持横向小组选项
- **预览/PDF 坐标一致**：竖向模式继续由 `src/shared/layout.ts` 统一生成坐标，SVG 预览、PDF 导出和识别布局 JSON 共享同一排版结果
- **答题卡创建日期校验**：移除新建弹窗中 `new Date()` 的宽松失焦解析，避免 `777-01-01` 被自动规范为 `0777-01-01`；前端、保存接口和导入接口均校验真实日期与年份范围

### UX 交互一致性改进
- 客观题属性面板中「选项排列」的竖向选项更新为「竖向（4题一组）」，底部提示同步说明 AB 卡式小组排布规则
- 新建答题卡日期输入框在外部值变化时同步日历月份，非法手输日期失焦后回退到当前有效值，避免右侧预览/检查器显示异常年份

### 开发者
- `ObjectiveBlock`、`ObjectiveQuestionConfig` 新增可选字段 `optionLayout: "horizontal" | "vertical"`，缺省按 `"horizontal"`，旧答题卡 JSON 与数据库无需迁移
- `ObjectiveQuestionDefinition` 同步增加 `optionLayout`，由 `normalizeQuestionConfig` 按块级 → 单题级 → 默认值顺序解析；评分逻辑不受影响
- `layout.ts` 新增 `vertical-grid` 排列模式与 `isVerticalQuestion` 判定，竖向题走 4 题一组纵向排布路径

---

## v1.3.0 (2026-06-17)

### 学科答题卡模板
- 新增 `src/shared/cardTemplates.ts`，新建答题卡时可按科目自动生成语文、英语、数学、物理、化学、生物的常用题块结构
- 英语模板支持在新建弹窗中选择是否包含听力题 1-20
- 语文模板支持选择题统一置于卷首，或按原题号分散插入到主观题块之间
- 化学、生物等模板内置"解答题中的小空"样式，减少手动搭建填空线的重复操作

### 客观题题级配置与评分规则
- 客观题块新增 `questions` 明细，可为同一题块内的每道题独立设置题号、题型、选项数、分值、标准答案和评分规则
- 多选/不定项评分规则扩展为三类：按选对项数给分、按正确答案总数分档给分、固定部分分
- 评分规则支持"允许夹杂错误选项但按选对项数给分"的特殊口径，用于语文等题型
- 新增 `scripts/grading-rules-smoke.ts`，覆盖语文、数学、物理、生物典型部分得分规则

### 填空题与版式
- 主观题块新增 `blockKind`，区分"填空题"和"解答题"，避免仅靠标题猜测布局
- 填空题支持每个空单独保存标签、宽度和高度，布局与 PDF 预览会显示对应空号
- 布局引擎支持非连续客观题号、混合选项数和跨页续排，`layout.ts`、`pdf.ts`、前端 SVG 预览共用同一结构

### 删除保护与数据一致性
- 答题卡被考试引用时，直接删除会返回 409，并给出引用考试名称
- 删除答题卡时可选择"解绑考试并删除答题卡"或"连同引用考试一起删除"
- 删除考试时可选择仅删除考试并解除答题卡关联，或同时删除关联答题卡
- `exams.card_id` 改为可空，支持先保留考试记录再解除答题卡引用

### 数据库与文档
- 新增 `objective_questions` 表，保存题级客观题配置和 `scoring_rule_json`
- `subjective_blocks` 新增 `block_kind`，`subjective_questions` 新增 `blanks_label_style`、`blanks_items_json`
- README、架构、数据库、管理员、多端、账号和项目胶囊文档同步到 v1.3.0

---

## v1.2.1 (2026-06-17)

### Bug 修复

- **Electron 后端启动增强**：探活重试从 20 次（3s）延长至 30 次（4.5s）；新增原生模块加载失败的明确错误诊断，区分 native 模块 ABI 不匹配错误
- **低分辨率/DPI 缩放 UI 修复**：CSS 响应式设计改为三级断点（1300px / 1060px / 760px），解决 125%/150% DPI 缩放时侧栏与主内容区、检查器面板重叠问题；窄屏下侧栏宽度自适应收缩
- **答题卡创建考试时间校验**：前端与后端均强制要求考试时间（YYYY-MM-DD），不再允许留空
- **数据库导入导出多项热修复**：修复认证 token 键名不匹配（`auth_token` → `projectx_auth_token`）导致 401；修复 archiver v8 ESM API 变更（`archiver("zip")` → `new ZipArchive({})`）；修复 unzipper 流式解析 FILE_ENDED；最终改用 adm-zip 同步全内存解压 + express.raw() 直传二进制绕过 multipart/form-data corrupt 问题

### 新功能

- **数据库全量备份/恢复**：管理员可从账号菜单「导出数据」打包全部数据（projectx.db + scanner.db + data/answer-card/）为 ZIP 下载；支持通过「导入数据」上传 ZIP 恢复，恢复后建议重启应用
- **答题卡创建记录教师信息**：`POST /api/cards` 现已将 `created_by`（创建答题卡的教师账号 ID）持久化写入 `answer_cards` 表，支持后续审计追溯
- **导入模板升级为 Excel**：学生/教师导入的示例模板从纯文本 CSV 改为正式 .xlsx 文件（通过 SheetJS 生成）

### 新增 API

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/db/backup` | 导出全量数据 ZIP（需管理员权限） |
| `POST` | `/api/db/restore` | 上传 ZIP 恢复数据库（raw binary, 需管理员权限） |

### 依赖变更
- 新增 `archiver` v8（ESM, ZIP 打包）、`adm-zip`（ZIP 解压）
- 移除 `@types/archiver`（v8 ESM 无兼容类型），自建 `src/types/archiver.d.ts`、`src/types/adm-zip.d.ts`

---

## v1.2.0 (2026-06-17)

### AI 成绩分析
- 在「分析 → 成绩分析」中新增 AI 成绩分析卡片，位置位于「分数统计分布」之后、「学生排名」之前
- 新增 `llmclient` Python 中转服务，提供 `GET /health`、`GET /models`、`POST /analysis/run`
- 支持 `gemini-3.1-flash-lite`、`gemini-3.5-flash`、`deepseek-v4-flash`、`deepseek-v4-pro`
- Gemini 与 DeepSeek 默认开启 thinking；DeepSeek V4 thinking 请求保留 `reasoning_content` 续轮，但不返回前端展示
- 新增成绩工具白名单：考试概览、分数分布、班级摘要、题目分析、排名分段、错误率高题目
- 成绩分析中的教学关注口径改为错误/低分率分档：30%-49% 低档、50%-69% 中档、70%+ 高档，避免把普通错题误标为复核风险
- Node 新增 `/api/analysis/ai/status` 和 `/api/analysis/exams/:examId/ai-analysis`

### 桌面启动与本地服务
- Electron 本地 Express 启动改为等待真实 `listening` 事件后再返回，避免端口绑定失败时误判成功
- `127.0.0.1:5174` 遇到 `EADDRINUSE` 或 `EACCES` 时自动 fallback 到随机端口
- 新增 `/api/app/health`，Electron 通过真实 HTTP 探活后才加载窗口，避免空壳窗口

### 文档
- 新增 [`AI成绩分析.md`](./AI成绩分析.md)
- README、管理员手册、架构文档、多端说明同步补充 AI 分析与本地端口探活说明

---

## v1.1.5 (2026-06-16)

### UX 交互一致性改进

- **阅卷流程重构**：考试选择器提升为主入口，选择考试后答题卡自动关联（可手动覆盖），无需重复选择答题卡
- **考试创建自动回填**：选择答题卡后自动填充考试名称和科目，消除重复输入
- **教师关联班级即时生效**：关联/解除班级后详情即时更新，无需手动刷新
- **学生创建交互统一**：花名册栏新增「学号+姓名+加号」快捷创建，与年级/班级的输入+加号模式一致；原独立弹窗改为标题栏「新建学生」按钮触发
- **标题栏按钮统一**：学生管理标题栏加入「新建学生」按钮，所有管理页统一为 [刷新] [新建] [导入] [导出] 布局
- **导入/导出图标一致**：统一使用 Download 表示导入、Upload 表示导出
- **新建答题卡时可同步创建/关联考试**：NewCardModal 新增「考试关联」区块，支持同时创建同名考试（名称可编辑）或关联已有考试，省去考试管理页面单独操作；三选一采用紧凑胶囊按钮
- **新增 PATCH /api/exams/:examId**：支持更新考试的答题卡关联、名称和科目

### Windows x64 / ia32 打包
- 学生端、教师普通端、教师扫描端均支持 `x64` 与 `ia32` 打包；默认命令保持 `x64` 行为不变
- 新增 `electron:pack:*:ia32`、`electron:dist:*:ia32`、`electron:msi:*:ia32` 脚本
- 新增 `npm run electron:msi:all`，一次生成三端 x64/ia32 共 6 个 MSI
- 32 位原生资源统一放在 `resources/native/win-ia32/`，运行时按 `process.arch` 自动选择 `win-x64` 或 `win-ia32`
- 32 位打包会先重建 Electron ia32 的 `better-sqlite3`，打包结束后恢复开发环境的 Node 原生模块

### 依赖变更

- 密码哈希依赖由原生 `bcrypt` 调整为纯 JS `bcryptjs`；Electron 原生重建范围收敛为 `better-sqlite3`

---

## v1.1.0 (2026-06-14~15)

### 多端产品变体（学生端 / 教师普通端 / 教师扫描端）
- 同一代码库打包为三个独立 Electron 包：`student`、`teacher`、`teacher-scanner`
- 学生端仅「我的成绩」；教师普通端设计/阅卷/分析/账号（无扫描）；教师扫描端全功能
- 三端共用 `%APPDATA%\answer-card-designer` 数据目录，账号/考试/成绩互通
- 变体配置定义于 `src/shared/appVariant.ts`，前端先按产品端限功能，再按角色限功能
- 学生默认密码允许 5 位学号（自改密码仍要求 ≥6 位）；`src/server/auth/passwordPolicy.ts`
- 学生登录支持用户名或学号两种方式
- 打包脚本：`electron:pack/dist/msi:student/teacher/scanner`
- 新增多端说明文档 `readus/多端使用说明.md`

### CSV/Excel 批量导入师生
- **学生**：`年级,班级,学号,姓名` → 自动建年级/班级，账号=`P`+学号，密码=账号
- **教师**：`科目,姓名` → 自动生成 T+6位随机数账号、6位随机数字密码
- 支持 CSV / Excel (.xlsx/.xls) 上传、粘贴、预览、模板下载

### 教师管理面板
- 顶栏常驻「新建教师」「导入教师」「导出教师账密」
- 左侧列表按创建时间排序+搜索；右侧编辑姓名、科目(9科下拉)、关联/解除班级
- 手动创建教师弹窗（科目+姓名 → 自动生成账号密码）

### 学生管理面板（原班级管理改名）
- Tab「班级管理」→「学生管理」；2 Tab（教师管理/学生管理）
- 顶栏常驻「导入学生」「导出学生账密」
- 三栏：年级 → 班级(含人数) → 花名册(学号/姓名/账号)

### 账密导出统一 Excel
- 学生/教师/成绩导出全部统一为 .xlsx，fetch+blob 下载
- 导出前安全警告；旧 CSV 端点 301 重定向

### 赞助页面（Issue #11）
- 账号菜单「支持项目」低调入口，顶栏不增加 Tab
- `GET /api/sponsor` + `GET /api/sponsor/qr/:channelId` 预留收款码接口
- JSON 配置 `server/data/sponsor.json` + 图片目录 `data/sponsor/qr/`
- 无收款码时展示占位 UI；部署时放置 PNG 并更新配置即可启用
- 详见 [`readus/SPONSOR-PAGE.md`](./SPONSOR-PAGE.md)

### Bug 修复
- Express 5 `router.use()` 单回调限制 → 拆为两行独立调用
- 导入/导出图标方向统一（导入=Download、导出=Upload）
- UI 版本号 `v1.0.1` → `v1.1.0`

### 数据库
- `users` 新增 `subject`(教师科目)、`initial_password`(导出明文密码)
- 新建 `teacher_classes` 表(教师↔班级多对多)
- 自动 migration

### 新增 API
| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/users/import-csv` | 批量导入学生/教师 |
| `GET` | `/api/teachers` | 教师列表(创建时间排序) |
| `GET/PUT` | `/api/teachers/:id` | 教师详情/更新 |
| `POST/DELETE` | `/api/teachers/:id/classes` | 教师关联/解除班级 |
| `GET` | `/api/export/students` | 导出学生账密 .xlsx |
| `GET` | `/api/export/teachers` | 导出教师账密 .xlsx |
| `GET` | `/api/analysis/exams/:id/export-csv` | 成绩导出改为 .xlsx |
| `GET` | `/api/sponsor` | 赞助页配置（各渠道收款码 URL） |
| `GET` | `/api/sponsor/qr/:channelId` | 收款码图片 |

### 依赖变更
- 新增 `xlsx` (SheetJS)

---

## v1.0.x — 答题卡系统 UX 增强 & 卡片管理 (2026-06-14)

### 侧栏 & 品牌
- 侧栏仅设计 Tab 显示，阅卷/分析/账号全屏
- 标题→「答题卡设计阅卷系统」，图标→`resources/icon.png`

### 答题卡 ID 与管理
- ID 改为确定性 8 位纯数字(基于科目+时间戳 hash)
- 导出 `.projectx-card.json`(含答案+配图base64+布局)、导入、级联删除
- 设计器基本信息面板新增科目、考试日期

### 新建答题卡 Modal
- `NewCardModal`：科目选择(9科预设+自定义)、考试名称、日期选择器
- `src/shared/pinyin.ts`：中文科目名→拼音 key 转换

### 登录 & 持久化
- 「记住密码」6个月免登录(180天持久化 token)
- Token 磁盘持久化到 `~/.projectx/tokens.json`(重启不丢失)
- 默认单面答题卡(sided 默认 single)

### Topbar 布局修复
- Tab 栏固定右侧，按钮组移到中间，切换 Tab 位置不跳动
