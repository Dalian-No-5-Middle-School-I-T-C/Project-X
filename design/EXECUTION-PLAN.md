# Project-X UI 重构 · 执行方案（供执行模型使用）

> **上游文档**：`DESIGN-SYSTEM.md`（美学规格，先读）、`tokens/tokens.css`（令牌事实源）、`demo/demo.html`（视觉锚点）。
> **代码地图**：`.workbuddy/plans/UI-REWRITE-ONBOARDING.md`（模块/路由/API/已知坑的导航，先读 §0-§6）。
> **你的角色**：执行者。你没有美学裁量权——本方案未覆盖的决策，先查 DESIGN-SYSTEM §9 的设计原则类比；仍无答案则在任务卡中留下 `DESIGN-QUESTION` 标记并选择最保守方案，**禁止即兴发挥**。

---

## 0. 执行铁律（违反任何一条 = 返工）

1. **功能守恒**：任何页面迁移后，其现有功能点、API 调用、权限判断、路由参数**一个不少、一个不改**。迁移 = 换皮，不是改逻辑。
2. **整页迁移**：一个页面要么完全旧版、要么完全新版，**禁止半页混搭**（旧 class 与新工具类不得出现在同一页面文件中）。这是防串台的底线。
3. **零手写 CSS**：新代码只允许 Tailwind 工具类 + `components/ui/` 组件。除 `@theme` 与主题变量文件外，**不得新增任何 `.css` 文件、不得新增 `style={{}}` 内联样式**（动态值如进度条宽度除外）。
4. **颜色只说语义**：工具类只用语义色（`bg-primary` `text-muted-foreground` `border-border` `bg-success-soft`…）。**禁止** `bg-[#xxx]` 任意色值；图表 JS 取色只允许来自 `theme.ts`。
5. **图标只用 lucide-react**；emoji 作为功能图标出现即缺陷。
6. **数字一律 `tabular-nums`**：分数、排名、ID、百分比、统计值。
7. **不动非 UI 边界**：`src/shared/`、`src/server/`、`native/`、`llmclient/`、`modeRoutes.ts`、路由表、API 端点 —— 一律不碰。
8. **每阶段过闸**：执行本文件 §6 的验证命令，全绿才可进入下一阶段。

---

## 1. 旧 → 新变量映射表（P1 桥接与逐页替换的词典）

| 旧（styles.css / 内联 / 幽灵变量） | 新（Tailwind 语义类 / 令牌） |
|---|---|
| `--brand` `--brand-light` `--brand-dark` | `bg-primary` / hover:`bg-primary/90`（= `--px-accent-bg` 系） |
| `--brand-soft` `--brand-tint` `--surface-tint` | `bg-accent`（= `--px-accent-soft`） |
| `--brand-glow` | `--px-accent-ring`（仅焦点环/焦点阴影） |
| `--text` `--text-primary` | `text-foreground` |
| `--text-secondary` | `text-secondary-foreground`（fg-secondary） |
| `--muted` | `text-muted-foreground` |
| `--surface` `--bg-secondary` `--color-background-secondary`（幽灵） | `bg-card` |
| `--surface-raised` | `bg-popover` |
| `--background` `--color-background-primary`（幽灵） | `bg-background` |
| `--line` `--line-light` | `border-border/60`（border-subtle） |
| `--line-strong` `--border` `--color-border-primary`（幽灵） | `border-border` |
| `--success` `--warning` `--info` 及 `*-soft` | `bg-success-soft text-success-fg` 等 4 件套（映射进 Tailwind 主题色） |
| `--z-dropdown/modal/toast/lightbox`（CSS 9999 与 TS 1200 漂移） | `--px-z-*` 阶梯，统一由 shadcn 组件内置 |
| `--shadow-sm/md/lg/glass/brand*` | `--px-shadow-1..4`；glass/brand 系**废弃** |
| `--mobile-bottom-nav-height` `--touch-target-min` 等 | `--px-mobile-bottom-nav-h` `--px-touch-target` |
| 硬编码 `#C00F28` `#3C3489` `#EEEDFE` `#FFF8E1` `#166534` `#b91c1c` `#64748b` 等 25+ 处 | 按语境归入 accent / success / warning / info / neutral 语义，**逐个登记到任务卡** |
| emoji 图标 📝🆕📋 | lucide：`SquarePen` `Sparkles` `ClipboardList` |
| `rgba(226,75,74,…)` `#E24B4A`（旧 danger） | danger 语义族（= red 族暗档） |

> 完整新令牌数值：**只允许**从 `design/tokens/tokens.css` 抄录。

---

## 2. 阶段总览

| 阶段 | 内容 | 预估 | 出口标准 |
|------|------|------|----------|
| P0 | 基线与依赖 | 0.5d | 基线截图归档；依赖装好；typecheck 绿 |
| P1 | 主题层接入 + 旧变量桥接 | 0.5d | 旧界面零布局变化、色彩切新；幽灵变量全部有定义；暗色可用 |
| P2 | 组件基座（shadcn/ui 落地） | 2d | §3.2 组件清单全部可用并有最小用法示例 |
| P3 | 应用外壳迁移 | 1d | 新外壳上线，11 条路由全可达，权限渲染一致 |
| P4 | 页面逐页迁移（8 张任务卡） | 5–8d | 每张任务卡验收项全绿 |
| P5 | 清理固化 | 1d | styles.css 归零；审计清单通过；文档更新 |

---

## 3. 阶段任务卡

### P0 · 基线与依赖

- [ ] 安装：`tailwindcss@^4 @tailwindcss/vite class-variance-authority clsx tailwind-merge`，shadcn CLI 初始化（会引入所需 `@radix-ui/*`、`sonner`、`vaul` 等），`@tanstack/react-table`
- [ ] 对 11 条路由 × light/dark 截图存档（`design/baseline/`，命名 `路由_主题.png`），作为回归对照
- [ ] 全库清点旧变量与硬编码色出现位置，形成《替换台账》（附在 PR 描述）
- [ ] **过闸**：`npm run typecheck` 绿

### P1 · 主题层接入（不换任何组件，先换"皮底下的血"）

- [ ] `vite.config.ts` 接入 `@tailwindcss/vite`；新建 `client/theme/app.css`：`@import "tailwindcss"` + `@theme { … }`，**`@theme` 内容按 `tokens/tokens.css` 逐值映射**（映射关系见 DESIGN-SYSTEM §3.3）
- [ ] dark 策略：`@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *))`（沿用现有 `data-theme` 属性，切换逻辑零改动）
- [ ] 密度：`[data-density="compact"]` 变量档保留（扫描台使用）
- [ ] 新建 `client/theme/legacy-bridge.css`：把旧变量（`--brand`、`--text`…）与**幽灵变量**（`--color-border-primary`、`--color-background-secondary`、`--color-background-tertiary`、`--color-border-tertiary`、`--color-text-primary`、`--color-text-secondary` 等 58 处）全部别名为新令牌值。此文件**置顶引入**，旧 7011 行样式立即继承新色彩且布局不变
- [ ] 重写 `client/theme.ts`：从 `@theme` 镜像生成（可写 `scripts/sync-tokens.mjs` 半自动），数值与 tokens.css 一致；`zLightbox` 等漂移值统一
- [ ] **过闸**：typecheck + build + verify:auth 绿；对照基线截图：布局零位移、仅色彩变化；暗色逐页核对

### P2 · 组件基座（`components/ui/` 重组）

按 DESIGN-SYSTEM §6 规格落地，顺序即依赖序：

1. 基础：`Button(含 loading)` `Input/Textarea/Field` `Select` `Checkbox/Radio/Switch` `Badge` `Card` `Skeleton` `Spinner` `Kbd`
2. 覆盖层：`Dialog` `Sheet` `DropdownMenu` `Tooltip` `Sonner(Toaster)` `Tabs` `ToggleGroup(SegmentedControl)` `Pagination` `Progress`
3. 数据：`Table`（TanStack 封装 `<DataTable>`：排序/筛选/列显隐/分页/紧凑密度 props）`EmptyState` `StatCard` `ScoreBadge` `Chart`（chart.js 适配器，从 theme.ts 取色）
4. 业务外壳件：`AppRail` `PageHeader` `StatusBar` `ContextPanel` `UploadZone`（迁移 DragDropZone 能力）
5. `components/ui/index.ts` 桶导出；**旧 `Button.tsx/Modal.tsx/…` 保留到 P5**，新组件同名导出时以命名空间区分（如 `ui/v2` 目录或 `Button2` 临时名，P5 统一改名）
- [ ] **过闸**：每个组件在一个临时 `/design-preview` 本地路由（不发布）中渲染全变体 × light/dark/compact 截图核对 demo.html

### P3 · 应用外壳（`App.tsx` 布局区，1503–1729 行段）

- [ ] JSX 重构为 `AppRail + (ContextPanel?) + PageHeader + Routes + StatusBar`；**`WorkspaceProvider`、`Routes` 表、`switchMode`、`useBlocker`、权限派生逻辑原样保留**
- [ ] 导航项渲染沿用 `canDesign/canManageExams/canAnalyze/showScoresTab/canManageAccounts/canManageGlobal` 布尔组（1490–1501 行），一项不少
- [ ] `AccountMenu`、主题切换、`MobileDrawer`→Sheet、移动底部导航 平移到新外壳
- [ ] 设计模式的答题卡侧栏 → `ContextPanel`（功能：新建/导入/列表/上传原卷/导出/删除/缺原卷高亮 全部保留，见 App.tsx 1506–1564）
- [ ] `CardSelectPage`/`ScannerWorkspace` 的 `app-shell no-card-sidebar` 复用外壳（scanner build 入口 `ScannerApp.tsx` 同步换壳）
- [ ] **过闸**：11 路由可达；深链 `/exam-manage` 等刷新还原；未保存离开 `/design` 拦截弹窗正常；typecheck+build+verify:auth 绿

### P4 · 页面迁移任务卡（按业务优先级排序，每张卡独立可交付）

> 每张卡格式：**目标文件 → 功能守恒清单（逐条核对）→ 组件映射 → 专属验收**。

**T1 扫描链路（最高优先）** — `LoginPageScanner` `CardSelectPage` `ScannerWorkspace` `ScannerPanel` `ScanPreviewModal`
- 守恒：选卡搜索+学科筛选+大考 Tab 展开；TWAIN 扫描+SSE 进度；文件导入；PDF 式多页预览+缩略图+快捷键；`/api/scanner/*` 调用不变
- 新特性（修复已知坑）：SSE 断连 5s 自动重连+状态横幅（UI-5）；紧凑密度 `data-density="compact"`；异常卷红边置顶；右下 Kbd 快捷键卡
- 验收：`npm run build:scanner:full` 绿；demo.html「扫描工作台」视图对照

**T2 成绩分析** — `AnalysisRoutePage` `ExamSelectPage` `ExamGroupDetailPage` `ScoreDetailPage` `StudentScoreDetail` `ScoreFixPage` `QuestionStudentScoresModal` `ScoreTable` `Analysis*` 全组 `ExportModal` `GroupExportModal`
- 守恒：考试/大考/跨考三入口；双 6-Tab 结构与各 Tab 全部功能；合并↔分科切换；题目排序+下钻；个别改分/修改答案双模式；导出（成绩/大考 ZIP）；AI 分析（react-markdown 渲染）
- 新特性：大考试导出加确定性进度（UI-3）；`manually_modified` 标记统一来源（UI-6）；图表全部走 `Chart` 适配器
- 验收：demo「成绩分析」视图对照；`npx tsx scripts/grading-rules-smoke.ts` 绿

**T3 学生端** — `ScoresRoutePage→StudentScores` `StudentAiPanel` `StudentSemesterComparison` `StudentSubjectRadar` `StudentTrendChart`
- 守恒：仅本人成绩（隐私红线，**不得新增任何排名/他人视图**）；学期对比；雷达；趋势；AI 面板
- 验收：demo「学生成绩」视图对照

**T4 首页+登录** — `HomePage` `LoginPage` `LoginPageScanner` `ForcedPasswordChange`
- 守恒：dashboard 快捷入口（继续阅卷/最新扫描/考试管理）；模块卡权限渲染+新标签打开逻辑；登录 `identifier` 字段+`isPersistent`；强制改密
- 新特性：emoji → lucide（`SquarePen`/`Sparkles`/`ClipboardList`）
- 验收：demo「登录」「首页」视图对照；`npm run verify:auth` 绿

**T5 考试管理（含低频网阅，克制投入）** — `ExamManagePage` `ExamManagementPage` `ExamDetailPage` `CreateExamGroupModal` `PaperUploadPanel` `GradePanel` `ScorePad` `OnlineReviewPanel` `BlockSelectPage` `CropImageViewer` `AnnotationOverlay` `ReviewAssignPage` `DisputeManagePage` `ReviewTracePage` `GradingConfigPage`
- 守恒：考试 CRUD+大考组；识别判分入口；阅卷中置顶语义；详情 5 Tab；GradePanel/PaperUploadPanel 浮层；多评/仲裁/分配/溯源/题块配置全部可用
- 新特性：提交节流+loading（UI-1/UI-2）；批注浮层 z-index 走令牌（UI-4）；网阅子页**只套 Table/Dialog/Badge 规范，不做额外设计**
- 验收：typecheck+build 绿；网阅主流程人工走查可用

**T6 答题卡设计器** — `DesignPage` `DesignEditors` `NewCardModal` `ImportCardModal` `AssignedFormulaModal`
- 守恒：客观/主观编辑器全部字段与交互；SVG 预览（StudentArea/Objective/Subjective 全部元素）；9 科预设；导入导出；赋分公式；自动保存状态机；useBlocker
- 美学：三栏 Resizable 工作台；纸面恒白居中；块列表选中红左边条
- 验收：新建→编辑→保存→导出 PDF 全链路人工走查

**T7 账号/权限/设置/信息页** — `AccountRoutePage→AccountManagement` `TeacherManagement` `ClassManagement` `UserManagement` `StudentManagement` `ImportModal` `PermissionManager` `GlobalSettingsPage` `UserGuidePage/Modal` `SponsorPage` `BeianFooter`
- 守恒：4 管理 Tab；CSV 导入+账密导出；权限矩阵；全局设置项（原卷策略/AI 服务商）；备案页脚
- 验收：`npm run verify:security-critical` 绿

**T8 兜底与边界** — `ErrorBoundary` 兜底 UI、`routeFallback`、`NotFound`（`*` → `/home` 重定向前可加 404 视觉）
- 验收：断网/JS 错误各触发一次看视觉

### P5 · 清理固化

- [ ] 逐段删除 `styles.css` 已迁移部分，目标**文件删除**；同步删除 `legacy-bridge.css`
- [ ] 旧 `components/ui/`（Button/Modal/SegmentedControl/Input/Panel/Table/Spinner/LoadingScreen/DataCard）删除，新组件转正命名
- [ ] 审计：`grep -rn "#[0-9a-fA-F]\{6\}" client/` 仅允许命中 theme.ts/@theme；`grep -rn "style={{" client/` 仅允许动态值；无 emoji 图标；无新手写 css 文件
- [ ] 文档：`AGENTS.md`、`.workbuddy/plans/UI-REWRITE-ONBOARDING.md` §7（设计系统段）、`readus/KNOWN-ISSUES.md` UI-1~7 关闭
- [ ] 最终过闸：全部验证命令 + 基线截图终对照

---

## 4. 防串台规约（结构性，非纪律性）

| 维度 | 规约 |
|------|------|
| 样式 | Tailwind 原子类无全局命名空间问题；禁止 `@apply` 复用拼装业务类；禁止新增 `.css` |
| 组件 | `pages/*` 只可 import：`components/ui/*`、本页目录内组件、`WorkspaceContext`、`auth/*`、`util/*`、hooks。跨页面 import 组件 = 架构违规（ESLint `no-restricted-imports` 固化） |
| 状态 | 不引入新全局 store；`WorkspaceContext` 字段只读消费，新增字段需任务卡注明 |
| 主题 | 双构建目标同一主题；scanner 仅加 `data-density="compact"`；禁止 scanner 私设色 |
| 图标 | `lucide-react` 唯一 import 源 |
| 变量 | `@theme`/`theme.ts`/`tokens.css` 三处同步由脚本完成（`scripts/sync-tokens.mjs`），手改视为漂移事故 |
| 数据 | 学生端组件禁止接收/缓存非本人数据字段（前端不展示越权字段，红线） |

## 5. 每页迁移标准流程（执行者按此节拍工作）

1. 打开任务卡 → 通读目标文件与 `UI-REWRITE-ONBOARDING.md` 对应小节
2. 列出该页**功能点清单**（事件处理/API/权限/路由参数）贴进 PR 描述
3. 用 P2 组件重写 JSX；删除该页全部旧 class 与内联样式
4. 对照 demo.html 对应视图微调间距层级
5. light/dark/compact × 桌面/移动 四象限自截屏
6. 过闸命令 → 提交（一个页面一个 commit，信息格式 `ui(v2): migrate <PageName>`）

## 6. 验证命令（每次过闸必跑）

```bash
npm run typecheck                 # 类型
npm run build                     # web 产物 + server bundle
npm run build:scanner:full        # 动过扫描端任何文件时必跑
npm run verify:auth               # 动过 auth/登录/权限渲染时必跑
npm run verify:security-critical  # 动过账号/权限/成绩数据展示时必跑
npx tsx scripts/grading-rules-smoke.ts  # 动过判分/分析展示时必跑
```

## 7. 风险与回滚

- **最大风险**：P1 桥接期间旧样式与新令牌叠加导致局部色差 → 以基线截图逐页对比，色差只在色彩不在布局即属预期
- **回滚单位**：每页面一个 commit，单页回退不影响其他；P1 桥接单独一个 commit，可整体 revert 回到旧主题
- **禁止事项再强调**：不得"顺手"改业务逻辑、API 参数、权限判断；发现问题记录到 PR 描述，由下一任务卡处理
