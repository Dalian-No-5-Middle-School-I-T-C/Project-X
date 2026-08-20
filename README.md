# Project-X | 五中智能试卷管理系统

<p align="center">
  <img src="https://img.shields.io/badge/version-2.2.1-blue.svg" alt="Version">
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20MariaDB-green.svg" alt="Platform">
  <img src="https://img.shields.io/badge/license-GPLV3.0-yellow.svg" alt="License">
  <img src="https://img.shields.io/badge/tech-React%20%7C%20Node.js%20%7C%20C%2B%2B%20%7C%20SQLite%20%7C%20MariaDB%20%7C%20Electron-9cf.svg" alt="Tech Stack">
</p>

## 项目简介

**Project-X** 是大连市第五中学信息化部（I.T.C.）自主开发的智能试卷管理工具，旨在解决学校长期依赖外包扫描答题卡与阅卷系统所带来的**报错频繁、费用高昂、受制于人**等核心痛点。

本项目由信息化部成员 **1g NaOH、火箭、云墨丹心、近代先人、CH（往届学长）** 牵头推进，从零开始构建一套属于学校自己的、可自主可控的答题卡设计与阅卷解决方案。

> **当前版本**：v2.2.1（版本历史见 [CHANGELOG.md](./readus/CHANGELOG.md)）
> **核心能力**：Home 仪表盘（快捷入口 + 模块卡片）→ 答题卡设计 → PDF 导出 → 扫描仪直扫 → 自动识别判分 → 大题作答图片切块 → 网上阅卷队列（2P/3P 多评 + 争议仲裁 + 断点续批 + PAD 优先 UI + 批注系统）→ 考试管理（含晨测/大考双模式）→ 大考组 → 成绩分析（难度 P / 区分度 D 双指标、总体分析、上次考试对比、学生学期成绩对比、知识点难度/区分度）→ 成绩修改 → 逐题得分明细 → 赋分引擎 → 导出模板 → 教师/学生/班级管理 → AI 成绩分析 → AI 知识点分析 → 知识点弱项诊断 → 并列排名 → 暗色主题 → 皮肤切换（明澈 Flat 2.0 + 纸锋 Paper Edge）→ MariaDB 双模（本地 SQLite / 远程 MariaDB 10.11）→ 服务器部署 → Web/Scanner 构建分离 → iOS 15 Safari Web 兼容 → 原卷上传 → 移动端响应式适配（480/768/1024 三档断点、底部导航 + 抽屉、表格卡片化、Home 页重构）
> **下个里程碑**：TBD

我们的爱发电地址：https://ifdian.net/a/ProjectX
---

## 为什么要做这个项目？

大连市第五中学在考试阅卷工作中长期采用第三方外包服务，在实际使用中遇到了以下问题：

| 痛点 | 具体表现 |
|------|----------|
| **报错频繁** | 外包系统对答题卡格式要求苛刻，稍有偏差即导致扫描失败或识别错误 |
| **费用高昂** | 按次或按年收费，随着考试频次增加，成本持续累积 |
| **受制于人** | 无法自主修改答题卡模板，特殊需求响应慢，数据隐私存疑 |
| **体验割裂** | 不同考试需要反复适应不同系统，教师操作成本高 |

**Project-X 的目标**：让学校拥有完全自主的答题卡生成与阅卷能力，一次开发，长期受益，数据本地可控。

---

## 功能特性

### 网上阅卷系统

- **Home 仪表盘**：登录后进入图形化首页，模块卡片 + 快捷入口（继续阅卷 / 最新考试），Tab 栏可开关
- **任务分配引擎**：年级组长为每个题块分配教师和份数，系统随机分配（Fisher-Yates 算法），教师进入考试后自选题块
- **2P/3P 多评**：双评或三评独立打分，分差超阈值自动争议；5 种取整方式（ceil/floor/round/half/none），每道题可单独配置
- **新阅卷 UI（PAD 优先）**：左图右分，大按钮打分，滚轮缩放，90° 旋转，批注系统（文字 + 手写 + palm rejection），学生端可查看批注
- **争议仲裁**：争议自动交由指定仲裁人或搁置，年级组长可手动判分
- **断点续批**：退出自动保存进度和草稿分数，重新进入弹窗恢复
- **阅卷溯源**：每学生每轮评审人+分数可追溯
- **考试管理增强**：每条考试新增「网阅」按钮，进入 5 Tab 管理页（阅卷 / 分配 / 争议 / 溯源 / 设置）
- **打分面板双模式**（v1.9.4）：满分 < 20 走「枚举模式」直接点分大按钮；满分 ≥ 20 走「十位+个位+十分位」位值合成；含 0.5 时枚举底部加 `0/0.5` 专用行、位值十分位列渲染 `0/0.5`；点选即提交并自动跳下一卷
- **仲裁人可选 + 工作量均衡**（v1.9.4）：题块仲裁人可留空，未设仲裁人时分配后自动把未分配卷吸收到份数最少的教师、并在教师间搬运使份数差 ≤ 阈值（默认 4 份）；争议卷自动改派给已分配且未评过该生的教师，被自动追加的卷标记 `auto_assigned`
- **设置三层拆分**（v1.9.4 重构）：个性化（账号设置，不变）/ 局部网阅（考试「网阅设置」Tab：题块级 `has_half_point`+本人块工作量下放到教师；「网阅默认」模板含分差/取整/0.5/自动改派/均衡阈值/复评模式（reviewMode：单评/双评/三评），由管理员设置并作为新建题块默认值）/ 全局（Home → 全局设置，仅管理员：原卷强制上传+高亮策略、AI 系统服务商）

### 答题卡设计

- **答题卡管理**：新建（科目弹窗 + 考试名称 + 必填考试日期 + 同步创建/关联考试）、保存、读取、导出、导入、删除答题卡
- **学科模板**：语文、英语、数学、物理、化学、生物可自动生成常用题块；英语可选择是否包含听力，语文可选择题统一卷首或按题号穿插
- **确定性 ID**：基于科目 + 时间戳的 8 位纯数字 ID，导入时自动生成新 ID 防冲突
- **导出/导入**：`.projectx-card.json` 格式，含标准答案 + 配图 base64 + 坐标布局，即插即用
- **A4 标准版式**：含标题、六点定位标记、学生信息区、学号填涂区、题块、页码
- **客观题设计**：
  - 单选、多选、不定项，可按题配置题号、题型、选项数、分值和标准答案
  - 多选支持按选对项数、按正确答案总数分档、固定部分分等规则
  - 支持横向排列与高考 AB 卡式竖向排列；竖向模式按 4 题一组纵向排布，每题选项保持横向小组选项
- **主观题设计**：
  - 带分数填涂区的手工给分样式（支持十位/个位/十分位）
  - 纯书写块、填空题（阿拉伯/罗马数字序号）、解答题内小空、横线格、空白大框
  - 支持图片插入、最小高度设置
- **PDF 导出**：毫米级精确标准 A4 PDF，直接打印
- **单/双面支持**：标记答题卡为单面或双面，扫描/阅卷时自动过滤背面
- **删除保护**：答题卡被考试引用时先提示冲突，可选择解绑考试或连同考试一起删除
- **坐标布局**：所有定位点、填涂框、作答区坐标精确到毫米

### 阅卷识别

- **批量识别判分**：上传多张答题卡图片，自动完成：
  - 客观题：选项填涂检测 + 标准答案对比判分
  - 主观题：红色划线分数格识别
  - 学号：数字填涂网格识别
- **多页合并评分**：双面卡 / 多页卡自动合并正反面成绩，去重汇总总分
- **PDF 式详情预览**：按学生聚合展示所有页面，纵向滚动翻阅，缩略图导航
- **大题作答图片切块**：识别成功后按 `layout.pages[].blocks[]` 的大题框裁剪作答图片，跨页大题按页生成续页图片；学生成绩详情与教师个别改分页优先展示大题切块，仍保留整页预览。
- **低置信度标记**：置信度偏低的题目自动标"待复核"
- **Excel (.xlsx) 导出**：点击导出按钮下载，Excel 直接打开

### 扫描仪直扫

- **柯达 i3000 支持**：通过 C++ TWAIN 原生桥直接驱动高速扫描仪
- **双屏流程**：答题卡选择页（单科/大考双Tab）→ 扫描工作台（直扫 + 导入阅卷）
- **本地/远程双模**：本地直接识别存 SQLite；远程模式下扫描完成自动上传到远端服务器
- **远端上传**：三步流程（创建会话 → 逐页上传图片 → 标记完成），API Key 鉴权
- **服务端接入模式**：Ubuntu 设置 `PROJECTX_ENABLE_SCANNER_CLIENT_API=1` 接收扫描端上传；无需、也不应在服务器启用 TWAIN
- **切块资产同步**：扫描仪 OCR 与普通批量阅卷都会落库 `answer_block_crops`；远程上传模式预留切块 manifest/文件接收能力，服务端可复用扫描端生成的大题图片。
- **文件导入阅卷**：扫描端也支持导入目录或单张图片进行识别的判分
- **单面过滤**：单面答题卡自动跳过背面扫描结果，避免无效数据
- **实时进度**：SSE 推送扫描进度 + 逐页缩略图预览
- **自动识别评分**：扫描完成自动调用识别引擎提取考号、判分
- **考号-图片持久化**：学号与图片路径存入 SQLite 数据库

### 成绩分析

- **考试选择页**：三选一切换 [单科 | 大考 | 跨考]，单科按学年/年级/学科筛选，大考展示合集列表，跨考嵌入按周打包/选定考试/已存组三种分析模式
- **大考组管理**：创建大考合集（如"2026高考摸底大考"含语数英物化生），关联已有考试或直接在合集中新建考试，支持拖拽排序和删除确认（可选级联删除关联考试）
- **大考分析**：6 Tab（概览 / 成绩 / 题目分析 / 班级对比 / 总体分析 / AI 分析），概览 Tab 各科参数卡片网格，成绩 Tab 横向跨科排名表（校排/班排/分数，赋分科目同行显示赋分），支持「合并 / 分科」视图切换、班级筛选和「仅全科参加」开关，各科均带难度 P / 区分度 D 徽章
- **跨考试总分**：按日期自动打包一周考试、手动选择考试合并、或读取已保存考试组，一键计算跨考试总分排名，预览该周考试列表
- **并列排名**：全系统排名统一为同分并列（1, 2, 2, 4, 5...），覆盖跨考、大考、单科、导出等所有场景
- **导出增强**：单科导出可选「客观题小分」「主观题小分」胶囊列；大考导出为 ZIP（总览表含跨科排名 + 各科详细小分 Excel）
- **考试管理**：创建考试、关联答题卡（支持新建答题卡时同步创建/关联）、科目、赋分
- **成绩查看页**：6 子Tab（概况 / 成绩 / 题目分析 / 班级对比 / 总体分析 / AI 分析），班级选择器 + 指标切换 + 「分数有问题？」入口（教师/管理员）

- **成绩修改**：支持个别改分（逐题下拉/输入）和批量修改答案（按钮组切换选项），修改后自动重算全部分数+排名；点击学生行进入逐题得分明细页（班级均分率 + 答题卡放大预览）

- **概况 Tab**：信息卡片（人数/均分/最高/最低/及格率/优秀率/标准差）+ **难度系数 P / 区分度 D** 指标卡 + 分数段水平条形图（10 分一段，0 人段自动隐藏，首段红/末段绿）+ 箱型图 + 年级前五/后五 + 进步前五/退步前五
- **成绩 Tab**：成绩表格含校排/班排/名次变化/偏差值/Z值/百分位，支持排序与搜索；大考支持「合并 / 分科」视图切换与班级筛选
- **题目分析 Tab**：逐题得分率表，**表头可点击排序**（题号/类型/得分率/正确率/平均分/满分/错误率/难度 P/区分度 D），点击行下钻查看该题**每个学生的得分明细**（学号/姓名/班级/得分率/知识点），难度与区分度以彩色档位徽章呈现
- **班级对比 Tab**：下拉选择基准班级，各班均分差值着色；大考下额外提供逐科班级均分对比（与「题目分析」共存，不互相替代）
- **总体分析 Tab**：整合成绩分布可视化——直方图（叠加正态曲线）+ Q-Q 图 + 正态性检验（Shapiro-Wilk / KS / AD / 偏度 / 峰度）；普通考试按全卷与各班、大考按总分 / 各科 / 各班切换；样本量 < 30 时给出小样本提示
- **AI 分析 Tab**：支持 GPT / DeepSeek / Gemini 多服务商，Gemini 使用 Google 原生 SDK 无需 Base URL，账号设置中「AI 服务商」集中管理；**大考同样支持 AI 分析**（按成员考试逐科汇总）；模型读取的成绩工具现已附带难度 P 与区分度 D，用于判断试卷难易与题目区分能力
- **档位阈值（系统设置）**：管理员在 Home「全局设置」中可配置难度 / 区分度档位（阈值、标签、颜色），前端徽章与后端统计统一读取 `system_settings.analysis_difficulty_bands` / `analysis_discrimination_bands`
- **赋分引擎**：等比例/线性/自定义表达式三种公式，化学/生物/地理/政治自动赋分
- **导出系统**：胶囊拖拽排序列，4 个自定义模板槽，A4 竖版超页警告，侧表（年级前 N 名），Excel (.xlsx)
- **阅卷自动落库**：判分时选择考试自动写入数据库，消除阅后即焚
- **AI 成绩分析**：多服务商架构（GPT/DeepSeek/Gemini，Gemini 走 Google 原生 SDK），白名单成绩工具生成结构化报告；工具输出已包含难度 P 与区分度 D，大考可由模型按成员考试汇总
- **原卷上传**（v1.8.0）：答题卡创建后自动引导上传原卷（DOCX/PDF/图片），前端 Canvas 压缩 + 后端 sharp 压缩，最大 50MB
- **AI 知识点分析**（v1.8.0）：AI 自动分析每道题的知识点，支持多模态直传（Gemini/GPT 看图）和 OCR 增强（视觉模型转写 → 推理模型分析），结果以彩色标签呈现，教师可双击编辑
- **知识点弱项诊断**（v1.8.0）：成绩分析 AI 可通过知识点维度诊断班级薄弱环节，按得分率排序，"勾股定理得分率 62%" 级别精准定位
- **系统 AI 配置**（v1.8.0）：AI 提供商改为管理员统一配置（`ai_providers.is_system=1`），教师无需了解 API，账号设置仅 admin 可见
- **导出检查**（v1.8.0）：PDF 导出前三步检查卡片——分值验证 → 原卷预览（按文件类型内联渲染：图片/img+缩放、PDF/iframe、DOCX/Office链接）→ 知识点分析（内联 AI 分析+编辑），三步含「← 上一步」回退，全部 ✓ 方可导出，侧栏橙色标识未上传原卷的考试
- **原卷预览**（v1.8.0）：放大 Modal 支持 ± 缩放（25%~300%），按钮实时显示当前倍率，`?format=image` 参数避免图片/PDF格式冲突

### 账户与安全

- **RBAC 权限体系**：管理员、教师、学生三级角色，细粒度权限控制（设计/阅卷/分析/用户管理/成绩查看）
- **教师细分角色**：管理员可为教师设置「学科老师」「班主任」「学年主任」三种细分角色，自动限制数据可见范围
  - **学科老师**（`subject_teacher`）：只能查看本科目 + 自己所教班级的考试和成绩
  - **班主任**（`head_teacher`）：只能查看本班级的全部科目考试和成绩（限同年级）
  - **学年主任**（`grade_leader`）：全科目 + 全班级 + 全年级，不受限制
  - 未设置细分角色的教师保持全权限（向后兼容）
- **记住密码**：勾选后签发 180 天持久令牌，令牌存磁盘（`~/.projectx/tokens.json`），服务器/软件重启不丢失
- **6 个月免登录**：本设备内打开即用，无需反复输入密码
- **考试模式**（v2.2.0）：创建考试可选「晨测（quiz，教师全量可见）/ 大考（formal，精细权限）」，考试详情页管理员可随时切换
- **知识点难度/区分度**（v2.2.0）：成绩分析「题目分析 → 知识点薄弱环节」每行带难度 P / 区分度 D 徽章（复用可配置档位）
- **皮肤切换**（v2.1.0 / v2.1.1）：前端外观皮肤（「纸锋 Paper Edge」v2.3.0 起为默认 + 「明澈 Flat 2.0」，明暗两维度正交）；入口收敛为**登录页自管 + 账号设置受控**两处，并新增**首次登录前强制引导层**（明澈 / 纸锋大预览并排、必须二选一）；皮肤偏好账号级持久化，换设备自动恢复；扩展接口预留，详见 [SKIN-THEME.md](./readus/SKIN-THEME.md)

### 学生功能

- **我的成绩**：查看各科考试成绩、排名趋势图、学科雷达图、**本学期 vs 上学期对比**
- **成绩天梯**：年级前十名榜单（单场考试 / 大考组 / 跨考累计三种维度），管理员可开关
- **AI 成绩分析**：学生个人成绩 AI 分析报告

### 桌面应用

- **Windows 扫描端**：Electron 桌面端，仅含扫描面板（TWAIN 直扫 + 答题卡选择 + 结果预览），便携版 EXE + MSI 安装包
- **Web 端自理**：教师/学生功能通过浏览器访问 Web 部署地址，不再打包 Electron 教师/学生端
- **x64 / ia32 双架构**：扫描端均支持 64 位与 32 位 Windows 包；32 位原生资源位于 `resources/native/win-ia32/`
- **打包入口修复**：扫描端构建最终产物统一提供 `dist/scanner/index.html`，Electron 运行时与服务端 SPA fallback 使用同一入口；ia32 包不再复用 x64 Electron 运行时。
- **数据共用**：`%APPDATA%\answer-card-designer\`（管理员 Web 端建账号→扫描端/学生 Web 端直接使用）
- **支持项目**：账号菜单低调入口，JSON 配置驱动的收款码预留接口（详见 [SPONSOR-PAGE.md](./readus/SPONSOR-PAGE.md)）

> 多端详细说明见 [`readus/多端使用说明.md`](./readus/多端使用说明.md)

---

### 移动端 Web 适配

在冻结技术栈（React 19 + TypeScript + Vite 7，不引入新依赖 / 第三方状态库，延续 Context 模式）前提下完成移动端功能与界面适配，目标是让教师/学生在手机与平板上通过浏览器即可完整使用全部功能。

- **响应式断点**：统一为 3 级——`480px`（手机）/ `768px`（平板）/ `1024px`（桌面）。`client/breakpoints.ts` 为断点唯一真相源，`client/hooks/useMediaQuery.ts` 提供 `useIsMobile` / `useIsTablet` / `useIsDesktop`（SSR 安全）。
- **导航适配**（v2.0.0 重构）：`<1024px` 顶栏显示汉堡按钮，唤起 `Sheet` 侧边抽屉（按权限列出全部可用模块：首页 / 答题卡设计 / 考试管理 / 成绩分析 / 账号…，含设计操作与外观切换）；`≤480px` 手机下另提供底部导航栏（常用模块 ≤5 项）。ESC / 遮罩关闭。
- **表格卡片化**：480px 下依据 `td[data-label]` 将长表格自动转为卡片列表（`DataCard` 组件），桌面端保留原表格，零额外 JS 开销。
- **Home 页重构**：内联样式全部替换为 CSS 类，480px 单列 + 44px 触摸区；输入控件移除 `fontSize:13` 内联，避免 iOS Safari 输入框聚焦时整体缩放。
- **Modal 规范化**：修复 480px 遮罩断链，卡片底部加抓手条与安全区 padding，移动端统一为底部弹出式。

> 移动端适配始于 v1.9.5，详见 [CHANGELOG.md](./readus/CHANGELOG.md)「v1.9.5：移动端 Web UI/UX 适配」；v2.0.0 随 Flat 2.0 重构将抽屉导航替换为 `Sheet` + 底部导航。

---

## 架构与设计体系（v2.0.0）

### 前端架构

- **Vite + React 19 + TypeScript** 单仓多目标构建：`dist/web/`（教师 + 学生 Web 端）与 `dist/scanner/`（Electron 扫描工作台）共用同一组件库与主题；扫描端通过 `data-density="compact"` 获得紧凑密度，不做第二套主题。
- **路由 = mode 系统**：每个功能 = 一个真实 URL，mode ↔ 路径的单一映射收敛在 `client/modeRoutes.ts`（`MODE_PATH` / `pathToMode`，11 个 mode：home / design / exam-manage / analysis / scores / account / account-settings / global-settings / sponsor / guide / permissions），支持 URL 深链、新标签打开与刷新保持当前页；多端变体与可用 mode 集合见 `src/shared/appVariant.ts` 的 `allowedModes`。

### UI 现状（v2.0.0）

- **Flat 2.0 设计系统已全量落地**：全部页面完成迁移（T1–T8），旧 `styles.css`（6048 行）与 `theme/legacy-bridge.css` 已删除，遗留类归零。
- **样式事实源** = `src/apps/answer-card/client/theme/app.css`（`@theme` 块 + `@layer base` 最小 reset）+ `theme/tokens.css` + `theme/backdrop.css`（背景图功能）。禁止新建 CSS 文件、禁止硬编码 hex，铁律见 [AGENTS.md](./AGENTS.md)「样式事实源」。
- **组件库唯一事实源** = `src/apps/answer-card/client/components/ui/v2/`（桶导出，禁止直指实现文件、禁止跨页面互相 import）。
- **令牌三处同步**：`design/tokens/tokens.css`（设计层事实源）↔ `app.css @theme` ↔ `client/theme.ts`（JS / 图表取色），由 `scripts/sync-tokens.mjs` 同步，手改任一视为漂移事故。
- **皮肤扩展机制**（v2.1.0 + v2.3.0）：皮肤 = 与明暗正交的风格维度（`data-skin` 属性），现有两套皮肤——默认 `flat`（明澈 Flat 2.0，不设属性零污染）与 `paper-edge`（纸锋 Paper Edge，v2.3.0，纸面米底 + 墨色文字 + 品牌亮蓝）；新增皮肤只需在 `theme/tokens.css` 追加 `[data-skin="xxx"]` L2 覆盖块 + `components/SkinSwitcher.tsx` 注册表登记一项，组件与业务代码零改动，详见 [SKIN-THEME.md](./readus/SKIN-THEME.md)。

### 架构 / 设计文档

| 文档 | 说明 |
|------|------|
| [readus/ARCHITECTURE.md](./readus/ARCHITECTURE.md) | 系统总体架构、分层、数据流、原生模块与构建部署 |
| [docs/superpowers/specs/2026-07-29-grade-analysis-redesign-design.md](./docs/superpowers/specs/2026-07-29-grade-analysis-redesign-design.md) | 成绩分析重构设计文档（选项分析 / 跨班对比 / 可配置阈值体系，已批准实施） |
| [design/EXECUTION-PLAN.md](./design/EXECUTION-PLAN.md) | P6 设计执行计划 |
| [design/DESIGN-SYSTEM.md](./design/DESIGN-SYSTEM.md) | Flat 2.0「明澈 Clarity」美学规格（令牌架构、组件规格、设计原则） |
| [design/tokens/tokens.css](./design/tokens/tokens.css) | 主题令牌事实源（L1 原始 / L2 语义 / L3 组件） |
| [design/demo/demo.html](./design/demo/demo.html) | 交互 Demo（8 视图 × 亮暗双主题），视觉验收基准 |
| [design/designer-sandbox.html](./design/designer-sandbox.html) | 设计器沙盒 |
| [design/EXECUTION-PLAN.md](./design/EXECUTION-PLAN.md) | 重构执行计划（T1–T8 任务卡、P0–P5 阶段、防串台规约） |

> 完整版（含新 UI 开发指南与全局风格调整方法）见 [readus/UI-ARCHITECTURE.md](./readus/UI-ARCHITECTURE.md)。

---

## 新 UI 开发指南（落实设计稿）

做新页面 / 新组件时，按下述步骤对齐 Flat 2.0 设计系统：

1. **找蓝本**：先在 [design/demo/demo.html](./design/demo/demo.html) 找到对应视图（登录 / 首页 / 考试管理 / 成绩分析 / 学生成绩 / 扫描工作台 / 设计基础 / 组件），再查 [design/DESIGN-SYSTEM.md](./design/DESIGN-SYSTEM.md) §6 组件规格与 §9 设计原则；设计稿未覆盖处选最保守方案，禁止即兴发挥。
2. **组件**：只从 `components/ui/v2` 桶**具名 import**（Button / Card / Dialog / Tabs / Table / DataCard / EmptyState / Spinner / Badge / Field / Input / Select / Switch / RadioGroup / StatCard / Chart …），禁止直指实现文件、禁止跨页面互相 import。
3. **样式**：只用 Tailwind 工具类 + 语义令牌（`bg-card` / `border-border` / `text-primary` / `text-muted-foreground` / `rounded-lg` / `rounded-md` / `tabular-nums`）；**禁止**硬编码 hex、内联 `style={{}}`（动态值须注释说明）、新建 CSS 文件（要扩展主题则改 `design/tokens/tokens.css` + `app.css @theme` 并跑 `scripts/sync-tokens.mjs`）。数字一律 `tabular-nums`，图标只用 lucide-react。
4. **路由**：新页面按四步接线——
   - `client/modeRoutes.ts`：`MODE_PATH` 加 mode → 路径映射，并注册组件（`pathToMode` 自动防 redirect 回首页，保证深链 / 刷新保持）；
   - `src/shared/appVariant.ts`：`allowedModes` 加入新 mode（teacher / teacher-scanner / student 三变体按需）；
   - `App.tsx`：`railNavItems` 加侧栏项。
5. **验收**：
   - `npm run typecheck` + `npm run build:web` + `npm run build:scanner` 全绿；
   - 铁律 grep：hex 仅允许命中 `tokens.css` / `@theme`；`style={{` 仅允许带注释的动态值；
   - 视觉：Playwright 亮 / 暗双主题截图对照 [design/demo/demo.html](./design/demo/demo.html) 对应视图（ui-visual-verification）。

---

## 快速开始

### 普通用户

#### 方式一：便携版 EXE（推荐临时使用）

前往 [GitHub Releases](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/releases) 按需下载（版本号以 Releases 最新为准）：
```
答题卡扫描端-2.2.1-x64.exe
答题卡扫描端-2.2.1-ia32.exe
```

> 普通 64 位 Windows 请选择 `x64` 包；需要兼容 32 位 Windows 时选择 `ia32` 包。扫描端含 TWAIN 直扫 + 答题卡选择 + 结果预览。教师/学生功能请通过浏览器访问服务器部署的 Web 端。

> 自 v1.6.3 起，`ia32` 包使用真正的 32 位 Electron 运行时，并重建 32 位 `better-sqlite3`；打包后可用 PE 架构检查确认 exe 为 x86。

#### 方式二：MSI 安装包（推荐机房部署）

各端均有对应 MSI 安装包，适合学校机房、域控、组策略等集中部署场景。

#### 基本使用流程

**设计答题卡**：
1. 打开程序 → 点击「新建答题卡」→ 弹窗中选择科目、填写考试名称和考试日期
2. 编辑标题、题块、标准答案 → 保存 → 导出 PDF → 打印

**阅卷判分**（v1.9.0 起阅卷并入考试管理，Web 端走网上阅卷；图片批量判分在扫描端）：
1. Web 端：「考试管理」→ 选择考试 → 点「网阅」→「阅卷」Tab 选题块 → 逐卷打分（支持 2P/3P 多评）
2. 扫描端：选择答题卡 → 扫描工作台导入图片或直接扫描 →「开始识别判分」→ 查看成绩 → 导出 Excel (.xlsx)

**查看分析**：
1. 切到「分析」模式 → 选考试 → 查看总览/排名/题目分析
2. 点击「导出」→ 选择「年级排名」或「班级排名」→ 下载 Excel (.xlsx) 成绩表

---

### 开发人员

#### 环境要求

- Windows 操作系统
- Node.js 24+（开发）/ Node.js 22（Electron 打包）
- Visual Studio 2022（编译 C++ 原生模块需要）
- OpenCV 4.13+（识别引擎编译需要）

#### 安装依赖

```powershell
npm install --ignore-scripts
```

> 使用 `--ignore-scripts` 避免 Electron 下载 SSL 问题。安装后需手动重建原生模块：
> ```powershell
> npm rebuild better-sqlite3
> ```

#### 数据库模式

Project-X v1.5.5 支持双数据库模式，通过环境变量或系统设置界面（管理员 → 账号设置 → 数据存储）切换：

| 模式 | 后端 | 说明 |
|------|------|------|
| **本地 SQLite**（默认） | `data/projectx.db` | 零依赖，单机/离线/开发测试 |
| **远程 MariaDB** | MariaDB 10.11 LTS 服务端 | 生产环境多用户部署，支持 32 位 |

```powershell
# SQLite 模式（默认，无需任何配置）
npm run dev

# MariaDB 模式
$env:PROJECTX_MARIADB_HOST     = "127.0.0.1"
$env:PROJECTX_MARIADB_USER     = "projectx_app"
$env:PROJECTX_MARIADB_PASSWORD = "your_password"
npm run dev
```

> 首次连接 MariaDB 时自动执行 `schema.mariadb.sql` 建表。现有 SQLite 数据可用 `npx tsx scripts/migrate-to-mariadb.ts` 迁移到 MariaDB。

#### 开发模式

```powershell
npm run dev
```

一条命令同时启动后端与前端。Vite dev server 在 `http://127.0.0.1:5173`，后端 API 在 `http://127.0.0.1:5174`。

开发时查看两端页面：

| 端 | 访问地址 | 页面内容 |
|----|---------|---------|
| **Web 端** | `http://127.0.0.1:5173/` | 教师 + 学生完整功能（设计/考试管理/网上阅卷/分析/账号） |
| **扫描端** | `http://127.0.0.1:5173/index-scanner.html` | 答题卡选择 + ScannerPanel 扫描面板（直扫 + 图片导入判分） |

两个入口共用同一个 Vite dev server 和后端 API，无需额外配置。

> **扫描功能调试**：开发环境下后端扫描路由默认关闭。如需连接真实扫描仪调试，启动时加环境变量：
> ```powershell
> $env:PROJECTX_ENABLE_SCANNER = "1"
> npm run dev
> ```
> 不连扫描仪也可以访问 `index-scanner.html` 调试 UI（答题卡列表、按钮交互等均可正常渲染）。

AI 成绩分析依赖 Python 中转服务（可选功能）。服务端启动时会自动尝试拉起它，失败只影响 AI 分析、不影响其余功能。首次启用需 `py -m pip install -r llmclient/requirements.txt` 并配置 `llmclient/.env`（复制 `.env.example`），详见 **[AI成绩分析.md](./readus/AI成绩分析.md)**。

#### 网阅功能演示数据（Demo 种子）

无需真实扫描仪或原生识别器即可实测网阅（双模式打分面板、0.5 小数、工作量均衡、全局设置）、文理分科大考、填空题升级、P/D 统计与正态性检验等。`testdata/demo-exams` 提供一键种子（v1.9.4 起，覆盖至 #212/#211/#206）：

```powershell
# 方式零：前端一键导入（推荐，管理员登录后 账户菜单 → 导入演示数据 / 清除演示数据）
# 方式一：仓库脚本（需 Git Bash / WSL）
./import-all.sh seed

# 方式二：直接调用 tsx
npx tsx testdata/demo-exams/scripts/seed.ts
```

种子会写入：

- 一场「演示-网阅测试」考试，含题块 **A**（满分 15、含 0.5 小数）与题块 **B**（满分 25）；
- 第二教师账号 `demo-teacher-2` / `teacher123`（学科数学），用于演示工作量均衡；
- 切块与分配：题块 A 故意把卷拆给两位教师并留 2 份未分配，触发 `rebalanceWorkload` 自动均衡（份数差收敛到 ≤ 4）。

登录实测：

| 账号 | 密码 | 可验证 |
|------|------|--------|
| `demo-teacher` | `teacher123` | 题块 A 枚举模式 + 0.5 底部行；题块 B 位值模式；本人块 `has_half_point` 可改 |
| `demo-teacher-2` | `teacher123` | 工作量均衡后被追加的卷（`auto_assigned`）；教师改局部设置的 403/200 边界 |
| `admin` | 见数据库旁 `bootstrap-admin.txt`（首次登录强制改密） | Home → 全局设置（仅管理员可见）；仲裁人留空自动改派争议卷 |

清理 / 重置演示数据：脚本每次运行会先执行 `cleanupDemoData`（删除「演示-」前缀的考试、答题卡、演示账号等），再重建，因此**重复运行即自动重置**，无需单独 clean 子命令：

```powershell
# 重置演示数据（先清后建）
./import-all.sh seed
```

如需分终端调试，也可手动启动：

```powershell
# 终端 1：后端
npx tsx src/apps/answer-card/server/index.ts

# 终端 2：前端
npx vite --port 5173
```

#### 打包发布

```powershell
# Web 端构建（部署服务器）
npm run build:web:full                # 构建 dist/web/ + dist/server/

# 扫描端构建
npm run build:scanner:full             # 构建 dist/scanner/ + dist/server/

# 如需重新构建 C++ 原生组件，先按目标架构生成 native 资源
npm run native:build:x64               # 输出到 resources/native/win-x64
npm run native:build:ia32              # 输出到 resources/native/win-ia32

# 扫描端打包（仅此一端）
npm run electron:pack                  # 扫描端目录包 (x64)
npm run electron:pack:ia32             # 扫描端目录包 (ia32)

npm run electron:dist                  # 扫描端便携 EXE (x64)
npm run electron:dist:ia32             # 扫描端便携 EXE (ia32)

npm run electron:msi                   # 扫描端 x64 MSI
npm run electron:msi:ia32              # 扫描端 32 位 MSI
```

> 维护提示：`vite build --mode scanner` 日志中仍会显示 `index-scanner.html`，构建完成后会自动重命名为 `dist/scanner/index.html`。这是为了让 Electron 内置 Express 的 SPA fallback 能稳定读取同一个入口文件。


Web 端构建产物部署到服务器，教师和学生通过浏览器访问。

多端打包和使用方式见 **[多端使用说明.md](./readus/多端使用说明.md)**。

#### 常用脚本

| 命令 | 说明 |
|------|------|
| `npx tsc --noEmit` | TypeScript 类型检查 |
| `npm run typecheck` | 类型检查（别名） |
| `npm run build` | 构建 Web 端 + 后端 |
| `npm run build:scanner:full` | 构建扫描端 + 后端 |
| `npm run dev` | Web 开发模式 |
| `npm run electron:dev` | 构建扫描端并启动 Electron |
| `npm run electron:pack` | 生成扫描端目录包 (x64) |
| `npm run electron:pack:ia32` | 生成扫描端目录包 (ia32) |
| `npm run native:rebuild:node` | 32 位 Electron 打包后恢复本机 Node 版 `better-sqlite3` |
| `npm run electron:dist` | 生成扫描端便携 EXE (x64) |
| `npm run electron:dist:ia32` | 生成扫描端便携 EXE (ia32) |
| `npm run electron:msi` | 生成扫描端 MSI (x64) |
| `npm run electron:msi:ia32` | 生成扫描端 MSI (ia32) |
| `npm run verify:auth` | 账号权限自动化验证（54 项用例） |
| `npm run verify:security-critical` | 安全/完整性关键用例（42 项） |
| `npm run verify:176-178` | 考试模式（晨测/大考）+ 知识点难度/区分度冒烟（10 项） |
| `npx tsx testdata/demo-exams/scripts/verify.ts` | 演示数据完整性校验 |
| `npx tsx scripts/grading-rules-smoke.ts` | 客观题部分得分规则冒烟验证 |

---

## 文档

项目说明与手册类文档统一放在 [`readus/`](./readus/) 目录，按主题分类如下：

| 文档 | 说明 | 适合读者 |
|------|------|----------|
| [ARCHITECTURE.md](./readus/ARCHITECTURE.md) | 系统总体架构、分层、数据流、原生模块与构建部署 | 开发者 |
| [项目胶囊.md](./readus/项目胶囊.md) | 架构速查：目录、类型、API、约定的一页摘要 | 开发者 |
| [DATABASE.md](./readus/DATABASE.md) | SQLite 表结构、Repository、认证与数据清理 | 开发者 / 运维 |
| [ACCOUNT-ARCHITECTURE.md](./readus/ACCOUNT-ARCHITECTURE.md) | 三级账号 RBAC 全栈架构、教师细分角色与 v1.0→v1.1 变更说明 | 开发者 |
| [ACCOUNT-CONTROL.md](./readus/ACCOUNT-CONTROL.md) | 账号控制系统 API、权限矩阵与启用方式 | 开发者 |
| [ADMIN-GUIDE.md](./readus/ADMIN-GUIDE.md) | 管理员日常操作：教师/学生管理、导入导出、年级班级花名册 | 机房管理员 / 教务 |
| [多端使用说明.md](./readus/多端使用说明.md) | Web 端 / 扫描端的功能差异、共用数据目录、账号登录与构建部署 | 管理员 / 教师 / 打包维护 |
| [AI成绩分析.md](./readus/AI成绩分析.md) | AI 成绩分析卡片、llmclient Python 服务、模型配置、工具白名单与本地端口探活 | 教师 / 管理员 / 开发者 |
| [SKIN-THEME.md](./readus/SKIN-THEME.md) | 皮肤切换功能说明：入口、数据流、API、如何新增一套皮肤 | 开发者 |
| [SPONSOR-PAGE.md](./readus/SPONSOR-PAGE.md) | 赞助/支持页面入口、收款码配置与 API 说明（Issue #11） | 开发者 / 运维 |
| [readus/CHANGELOG.md](./readus/CHANGELOG.md) | 版本变更记录（v2.3.0 纸锋皮肤 + v2.2.0 考试模式/知识点 P·D + v2.1.0 皮肤机制 + v2.0.0 Flat 2.0 重构 + v1.9.5 移动端适配等） | 全体 |

---

## 项目架构

> 详细架构说明（分层、数据流、原生模块、构建部署等）见 **[ARCHITECTURE.md](./readus/ARCHITECTURE.md)**。

```
Project-X/
├── src/
│   ├── apps/answer-card/
│   │   ├── client/                      # React 前端
│   │   │   ├── App.tsx                  # 主应用（Web 端，不含扫描面板）
│   │   │   ├── ScannerApp.tsx            # 扫描端双屏容器（v1.6.1：选卡↔工作台）
│   │   │   ├── theme/                    # 样式事实源（app.css + tokens.css + backdrop.css）
│   │   │   ├── pages/                    # 路由页（Home/Design/ExamManage/Analysis/Scores/Account/AccountSettings/GlobalSettings/Info…，v2.0.0 起）
│   │   │   └── components/              # 子组件
│   │   │       ├── NewCardModal.tsx        # 新建答题卡弹窗（科目+名称+日期+考试关联）
│   │   │       ├── LoginPage.tsx            # Web 端登录页（v1.6.3: 仅用户名密码，不含扫描功能）
│   │   │       ├── LoginPageScanner.tsx       # 扫描端登录页（v1.6.3: 含远端服务器配置+API Key）
│   │   │       ├── AccountMenu.tsx          # 账户下拉菜单（v1.6.0: 管理员身份切换）
│   │   │       ├── SponsorPage.tsx          # 赞助/支持页面（收款码预留）
│   │   │       ├── AccountManagement.tsx    # 教师/学生管理（双 Tab）
│   │   │       ├── TeacherManagement.tsx    # 教师管理（科目/班级关联）
│   │   │       ├── ImportModal.tsx          # 通用CSV/Excel导入弹窗
│   │   │       ├── ImportCardModal.tsx       # 导入答题卡确认弹窗（科目/考试/日期）
│   │   │       ├── ScanPreviewModal.tsx      # PDF 式多页答题卡预览弹窗（缩放/PgUp/PgDn）
│   │   │       ├── ScoreFixPage.tsx          # 成绩修改 + 大题作答图片定位
│   │   │       ├── StudentScoreDetail.tsx    # 逐题得分明细 + 大题作答图片（按题号定位切块）
│   │   │       ├── StudentScores.tsx        # 学生我的成绩
│   │   │       ├── ScannerPanel.tsx         # 扫描仪控制面板（v1.6.0: 本地/远程双模）
│   │   │       ├── CardSelectPage.tsx        # 答题卡选择页（v1.6.1: 单科/大考双Tab）
│   │   │       ├── ScannerWorkspace.tsx      # 扫描工作台（v1.6.1: 直扫+导入阅卷）
│   │   │       ├── ExamSelectPage.tsx       # 考试选择页（单科/大考/跨考 三选一，内联跨考分析）
│   │   │       ├── ScoreDetailPage.tsx      # 成绩查看页（概况/成绩/考试分析/AI分析）
│   │   │       ├── CreateExamGroupModal.tsx  # 大考创建/编辑弹窗（关联考试+内联新建考试）
│   │   │       ├── ExamGroupDetailPage.tsx   # 大考分析视图（概览+跨科排名表）
│   │   │       ├── GroupExportModal.tsx      # 大考 ZIP 导出配置
│   │   │       ├── AnalysisOverall.tsx      # 概况：信息卡片+分布图+排名
│   │   │       ├── AnalysisDistribution.tsx # 箱型图/分数分布
│   │   │       ├── AnalysisAiPanel.tsx      # AI 成绩分析（多服务商）
│   │   │       ├── ScoreTable.tsx           # 成绩表格（排序/搜索/偏差值）
│   │   │       ├── ExportModal.tsx          # 导出弹窗（胶囊拖拽/模板/A4适配）
│   │   │       ├── AssignedFormulaModal.tsx # 赋分公式配置
│   │   │       └── AnalysisQuestions.tsx   # 题目得分率排行
│   │   │       ├── KnowledgeTagList.tsx      # 可编辑知识点彩色标签（v1.8.0）
│   │   │       ├── PaperUploadPanel.tsx      # 原卷上传与AI分析面板（v1.8.0）
│   │   └── server/                      # Express 后端
│   │       ├── index.ts                 # 主路由（卡片CRUD/导入导出/识别/阅卷/考试/分析/成绩修改）
│   │       ├── services/AnswerBlockCropService.ts # 大题切块文件归档与数据库索引
│   │       ├── recognition.ts           # C++ 识别引擎子进程管理
│   │       ├── storage.ts               # 文件存储层
│   │       ├── pdf.ts                   # PDF 生成（pdfkit）
│   │       ├── paper-converter.ts         # 文件校验、图片压缩、格式转换（v1.8.0）
│   │       ├── paper-ocr.ts               # 文本提取（mammoth/pdf-parse）+ OCR（Tesseract.js）（v1.8.0）
│   │       ├── routes/
│   │       │   ├── analysis.ts            # 成绩分析路由（含知识点弱项端点）
│   │       │   └── paper-routes.ts        # 原卷上传与知识点CRUD路由（v1.8.0）
│   │       ├── database/                # 扫描记录 SQLite
│   │       └── scanner/                 # TWAIN 扫描仪子系统
│   ├── server/                          # 共享服务模块
│   │   ├── db/                          # 主数据库（projectx.db / MariaDB）
│   │   ├── repositories/                # 数据访问层
│   │   │   ├── CardRepository.ts         # 答题卡 CRUD
│   │   │   ├── ExamRepository.ts         # 考试 CRUD
│   │   │   ├── UserRepository.ts         # 用户管理（含 CSV 导入）
│   │   │   ├── KnowledgePointRepository.ts # 知识点 CRUD + 成绩联动查询（v1.8.0）
│   │   │   └── AnalysisRepository.ts     # 分析查询
│   │   ├── mysql.ts                 # DbAdapter 统一接口 + SQLite / MariadbAdapter（v1.5.5）
│   │   ├── middleware/                   # 认证中间件（含 v1.6.0 api-key 认证）
│   │   ├── routes/                       # 认证/用户/赞助/AI服务商/成绩修改/导出/大考组/跨考/API Key/扫描上传等路由
│   │   └── services/                     # AuthService / AssignedScoreService（赋分引擎）
│   └── shared/                          # 前后端共享
│       ├── types.ts                     # 全部类型定义
│       ├── ranking.ts                   # 竞赛排名工具函数（competitionRank）
│       ├── grading.ts                   # 评分引擎
│       ├── layout.ts                    # 答题卡坐标布局
│       ├── cardTemplates.ts             # 学科默认答题卡模板
│       ├── pinyin.ts                    # 科目名→拼音 key 转换
│       ├── blankLabels.ts               # 填空序号格式化
│       ├── defaultCard.ts               # 默认答题卡工厂 + ID 生成
│       └── appVariant.ts                # 多端变体定义（v1.6.1: 运行时 persona）
├── native/
│   ├── AnswerCardRecognizer/            # C++ 识别引擎（OpenCV）
│   └── ScannerBridge/                   # C++ TWAIN 扫描仪桥接
├── scripts/
│   ├── build-server.ts                  # esbuild 后端打包
│   ├── migrate-to-mariadb.ts            # SQLite → MariaDB 数据迁移（v1.5.5）
│   ├── setup-mariadb.sh                 # Ubuntu/Debian 一键建库建表（v1.5.5）
│   ├── grading-rules-smoke.ts           # 多选/不定项评分规则冒烟验证
│   └── build-scanner-bridge.bat         # 扫描仪桥接一键编译
├── electron/
│   └── main.cjs                         # Electron 主进程
├── llmclient/                            # Python AI 中转服务（FastAPI + provider SDK）
├── readus/                              # 项目文档（架构、账号、管理员手册、多端说明等）
├── data/                                # 运行时数据
│   ├── answer-card/                     # 派生布局 JSON、扫描图片、资产
│   ├── sponsor/qr/                      # 收款码图片（部署时放置，不进 git）
│   └── projectx.db                      # 主数据库（用户/卡片/考试/成绩）
├── dist/                                # 构建产物
│   ├── web/                              # Web 端（教师+学生，无扫描代码）
│   ├── scanner/                          # 扫描端（ScannerPanel only）
│   └── server/                           # 后端 API
├── resources/native/win-x64/            # 64 位原生模块打包目录
├── resources/native/win-ia32/           # 32 位原生模块打包目录
└── release/                             # Electron 打包输出
```

---

## 技术栈

| 层级 | 技术 |
|------|------|
| **前端** | React 19 + TypeScript + Vite + Lucide React |
| **后端** | Node.js + Express 5 + multer |
| **识别引擎** | C++ + OpenCV 4.13 + nlohmann/json（子进程调用） |
| **扫描仪** | C++ TWAIN API + GDI+（子进程调用） |
| **数据库** | SQLite via better-sqlite3（本地模式）/ MariaDB 10.11 via mysql2（远程模式，32位兼容） |
| **跨方言层** | DbAdapter 统一接口 + buildUpsertSQL + buildInsertIgnore |
| **PDF** | pdfkit（毫米级精确排版） |
| **桌面** | Electron 39 + electron-builder + WiX Toolset |
| **构建** | Vite（前端）+ esbuild（后端） |

---

## API 接口一览

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET/POST` | `/api/cards` | 答题卡列表 / 创建（含 subject/title/examDate/englishListening/chineseChoicePlacement） |
| `GET/PUT/DELETE` | `/api/cards/:id` | 答题卡详情 / 保存 / 删除（引用考试时支持解绑或联删） |
| `GET` | `/api/cards/:id/export` | 导出为 .projectx-card.json（含答案+配图+实时生成布局） |
| `POST` | `/api/cards/import` | 导入答题卡 |
| `GET` | `/api/cards/:id/layout` | 实时生成布局坐标 |
| `GET` | `/api/cards/:id/pdf` | 导出 PDF |
| `POST` | `/api/cards/:id/recognition` | 单张识别（客观+主观） |
| `POST` | `/api/cards/:id/grading` | 批量识别判分（支持 examId 落库） |
| `POST` | `/api/cards/:id/assets` | 上传资源图片 |
| `GET/POST` | `/api/exams` | 考试列表 / 创建 |
| `GET` | `/api/exams/:id` | 考试详情+成绩 |
| `PATCH` | `/api/exams/:id` | 更新考试（cardId/name/subject） |
| `DELETE` | `/api/exams/:id` | 删除考试（可选同时删除关联答题卡） |
| `GET` | `/api/exams/:examId/student/:studentId/scores` | 学生分数详情+班级均分 |
| `PUT` | `/api/exams/:examId/student/:studentId/scores` | 逐题修改分数 |
| `GET` | `/api/exams/:examId/answers` | 答题卡答案配置 |
| `PUT` | `/api/exams/:examId/answers` | 修改答案并批量重算全部分数 |
| `GET` | `/api/exams/:examId/students/search` | 搜索考生（?q=考号或姓名） |
| `GET` | `/api/analysis/exams/:id/overview` | 考试总览统计 |
| `GET` | `/api/analysis/exams/:id/students` | 学生排名 |
| `GET` | `/api/analysis/exams/:id/questions` | 题目得分率 |
| `GET` | `/api/analysis/exams/:id/classes` | 考试关联班级 |
| `GET` | `/api/analysis/exams/:id/export-csv` | 导出成绩 Excel (.xlsx)（?classId= 选班级） |
| `GET` | `/api/scanner/sources` | TWAIN 扫描仪检测 |
| `POST` | `/api/scanner/scan` | 启动扫描会话 |
| `GET` | `/api/scanner/progress/:id` | SSE 扫描进度 |
| `GET` | `/api/scanner/session/:id/results` | 合并学生成绩（多页汇总） |
| `GET` | `/api/scanner/scan-image/:recordId` | 扫描原图预览 |
| `GET` | `/api/scanner/exam/:examId/student/:studentId/scans` | 按考试+学生查答题卡页 |
| `GET` | `/api/scanner/grading-image/:cardId/:fileName` | 上传阅卷图片 |
| `GET` | `/api/answer-block-crops/:cropId/image` | 读取大题作答切块图片 |
| `GET` | `/api/review/exams/:id/blocks` | 网上阅卷题块汇总（待阅/已阅数量） |
| `GET` | `/api/review/exams/:id/block-crops` | 网上阅卷队列（大题切块 + 学生信息） |
| `POST` | `/api/review/exams/:id/block-crops/:cropId/submit` | 提交题块阅卷分数并标记状态 |
| `GET` | `/api/review/exams/:id/trace` | 阅卷溯源（每学生每轮评分详情） |  ← v1.9.0 |
| `GET` | `/api/review-assign/exams/:id/blocks/:bid` | 题块分配列表 |  ← v1.9.0 |
| `POST` | `/api/review-assign/exams/:id/blocks/:bid` | 创建/重新分配阅卷任务 |  ← v1.9.0 |
| `GET` | `/api/review-session/exams/:id/blocks/:bid` | 读取阅卷会话（断点续批） |  ← v1.9.0 |
| `PUT` | `/api/review-session/exams/:id/blocks/:bid` | 保存阅卷会话 |  ← v1.9.0 |
| `GET` | `/api/review-arbitration/exams/:id/disputes` | 争议列表 |  ← v1.9.0 |
| `POST` | `/api/review-arbitration/crops/:cid/resolve` | 提交仲裁最终分 |  ← v1.9.0 |
| `GET` | `/api/block-grading-config/exams/:id` | 题块网阅设置列表 |  ← v1.9.0 |
| `POST` | `/api/block-grading-config/exams/:id/batch` | 批量更新题块设置 |  ← v1.9.0 |
| `GET/PUT` | `/api/system-settings` | 全局设置（原卷策略 `require_original_paper`/`highlight_missing_paper`、AI 系统服务商开关位，仅管理员） |  ← v1.9.4 |
| `GET` | `/api/system-settings/public` | 只读：原卷两策略标志（认证用户），供前端判断强制上传/高亮 |  ← v1.9.4 |
| `GET/POST/PUT/DELETE` | `/api/ai/providers/system` | AI 系统服务商管理（仅管理员，`is_system=1`） |  ← v1.9.4 |
| `GET` | `/api/dashboard` | 首页仪表盘数据 |  ← v1.9.0 |
| `GET` | `/api/review/my-exams` | 教师待阅考试列表 |  ← v1.9.0 |
| `GET` | `/api/review-annotations?cropId=` | 读取切块批注 |  ← v1.9.0 |
| `POST` | `/api/review-annotations` | 保存批注 |  ← v1.9.0 |
| `DELETE` | `/api/review-annotations/:id` | 删除批注 |  ← v1.9.0 |
| `GET` | `/api/review-assign/exams/:id/eligible-teachers` | 可分配教师列表（同科同年级） |  ← v1.9.0 |
| `POST` | `/api/auth/login` | 登录（支持 isPersistent 6 月免登录） |
| `GET` | `/api/auth/me` | 当前用户信息 |
| `GET` | `/api/teachers` | 教师列表（按创建时间排序） |
| `GET/PUT` | `/api/teachers/:id` | 教师详情 / 更新（姓名/科目/教师角色） |
| `POST` | `/api/teachers/:id/classes` | 教师关联班级 |
| `DELETE` | `/api/teachers/:id/classes/:classId` | 教师解除班级关联 |
| `POST` | `/api/users/import-csv` | 批量导入学生/教师（CSV/Excel） |
| `GET` | `/api/export/students` | 导出学生账密 Excel |
| `GET` | `/api/export/teachers` | 导出教师账密 Excel |
| `GET` | `/api/sponsor` | 赞助页配置（各渠道收款码 URL） |
| `GET` | `/api/sponsor/qr/:channelId` | 收款码图片 |
| `GET/PUT/DELETE` | `/api/exams/:id/assigned-formula` | 赋分公式配置 |
| `POST` | `/api/exams/:id/recalculate-assigned` | 批量重新计算赋分 |
| `GET/POST` | `/api/exam-groups` | 大考组列表 / 创建 |
| `GET/PUT/DELETE` | `/api/exam-groups/:id` | 大考组详情 / 更新 / 删除（?deleteExams=1 级联删考试） |
| `POST` | `/api/exam-groups/:id/exams` | 关联考试至大考组 |
| `DELETE` | `/api/exam-groups/:id/exams/:examId` | 移除关联 |
| `GET` | `/api/exam-groups/:id/overview` | 大考概览（各科参数） |
| `GET` | `/api/exam-groups/:id/rankings` | 大考跨科排名（?classId=&fullOnly=1） |
| `POST` | `/api/exam-groups/:id/export` | 大考 ZIP 导出（总览+各科小分） |
| `POST` | `/api/analysis/cross-exam/total` | 跨考试总分统计 |
| `GET/POST` | `/api/analysis/cross-exam/groups` | 跨考组列表 / 创建 |
| `DELETE` | `/api/analysis/cross-exam/groups/:id` | 删除跨考组 |
| `GET` | `/api/analysis/exams/:id/score-table` | 成绩表格数据（年排/班排/名次变化/偏差值/Z值/百分位） |
| `GET` | `/api/analysis/exams/:id/previous` | 上次同科考试对比（均分/及格率变化） |
| `GET` | `/api/scores/me/semester-comparison` | 学生本学期 vs 上学期成绩对比 |
| `GET/PUT/DELETE` | `/api/export/templates/:slot` | 导出模板 CRUD |
| `POST` | `/api/export/exams/:id/scores` | 按列配置导出 Excel |
| `GET` | `/api/export/columns` | 导出列元数据 |
| `PATCH` | `/api/users/me/settings` | 更新用户设置（成绩指标/复核阈值/背景图透明度） |
| `POST` | `/api/users/me/background` | 上传自定义背景图 |
| `GET` | `/api/app/background` | 获取背景图文件（优先用户自定义） |
| `GET/POST/PUT/DELETE` | `/api/ai/providers` | AI 服务商配置管理 |
| `GET` | `/api/db/backup` | 导出全量数据 ZIP（SQLite: VACUUM / MariaDB: mysqldump） |
| `POST` | `/api/db/restore` | 上传 ZIP 恢复数据库 |
| `POST` | `/api/db/import-demo` | 一键重置并导入演示数据（管理员；会清空原有「演示-」前缀数据并更换考试 ID） |  ← v1.9.4 |
| `POST` | `/api/db/clear-demo` | 一键清除「演示-」前缀数据（管理员） |  ← v1.9.4 |
| `GET` | `/api/app/health` | 健康检查（含数据库状态与 `capabilities.scannerClientApi`） |
| `GET/PATCH` | `/api/app/db-config` | 数据库配置读取/修改（管理员） |
| `POST`            | `/api/scanner/upload/sessions`              | 创建扫描上传会话（API Key + JWT 双鉴权） |
| `POST`            | `/api/scanner/upload/sessions/:id/pages`   | 上传扫描页（multipart） |
| `POST`            | `/api/scanner/upload/sessions/:id/complete` | 标记扫描完成 |
| `GET`             | `/api/scanner/upload/sessions/:id/status`   | 查询扫描状态 |
| `GET/POST/PUT/DELETE` | `/api/admin/api-keys` | API Key 管理（管理员） |
| `GET` | `/api/ladder/config` | 天梯开关状态 |
| `PUT` | `/api/ladder/config` | 管理员设置天梯开关 |
| `GET` | `/api/ladder/exams/:id` | 单场考试天梯数据 |
| `GET` | `/api/ladder/exam-groups/:id` | 大考组天梯数据 |
| `GET` | `/api/ladder/cross-exam` | 跨考累计天梯数据（?mode=week\|selected\|group） |

---

## 贡献者

本项目由大连市第五中学信息化部（I.T.C.）成员发起并维护：

| 昵称 | 角色 | 备注 |
|------|------|------|
| **1g NaOH** | 项目牵头人 | 核心架构与后端开发 |
| **火箭** | 项目牵头人 | 前端与 Electron 桌面端 |
| **云墨丹心** | 项目牵头人 | UI/UX 设计与答题卡版式 |
| **近代先人** | 项目牵头人 | 算法与识别模块预研 |
| **CH** | 项目牵头人 | 项目奠基与经验传承 |

> 感谢所有为 Project-X 提供测试反馈、文档建议和代码贡献的同学与老师！

---
## 看板娘
<img width="1254" height="1254" alt="82210f7b5cb77968108b5aa81a3b2191" src="https://github.com/user-attachments/assets/34c2c9b5-a373-48cf-b605-5a66faecc7b8" />
<img width="1070" height="1470" alt="31c82194dfda46f5a99ea69efd19eb45" src="https://github.com/user-attachments/assets/c73fd099-d40f-4dd2-8e1a-57982522b326" />
<img width="1254" height="1254" alt="9884f7ad4fb44e7d82c66620f1eb43a5" src="https://github.com/user-attachments/assets/e4e05802-68d4-486b-8c32-da3abf754f14" />
<img width="1122" height="1402" alt="aea2da6d3469351758d4d3d9dc56f9b0" src="https://github.com/user-attachments/assets/4680cf8c-c7af-454e-a082-cdbf41afd025" />
<img width="3344" height="1882" alt="27dacd5f25f0f04ed397bf22a3cdc441" src="https://github.com/user-attachments/assets/3bf17d59-5867-4e97-beda-c3630617c7c9" />
<img width="1054" height="1492" alt="1e26fe449f38c89316b12e8cfc78db07" src="https://github.com/user-attachments/assets/d7e0d091-a18a-4786-9ef8-7b76bc2213d2" />
## 开源协议

本项目采用 GPL-3.0 license 开源协议。

---

## 联系我们

- **组织**：大连市第五中学信息化部（I.T.C.）
- **仓库**：[github.com/Dalian-No-5-Middle-School-I-T-C/Project-X](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X)
- **Issues**：如有问题或建议，欢迎提交 [GitHub Issue](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/issues)

---

<p align="center">
  <strong>由五中人，为五中人，服务五中教学。</strong><br>
  <em>Project-X —— 让技术回归校园，让智慧赋能教育。</em>
</p>
