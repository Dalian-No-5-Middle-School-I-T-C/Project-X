# Project-X CHANGELOG

## v1.4.8 (2026-06-23)

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

### 版本
- v1.4.7 → v1.4.8

## v1.4.7 (2026-06-20)

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
