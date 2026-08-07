# Project-X Design System v2.0「明澈 Clarity」— UI 美学设计方案

> **文档性质**：总设计师交付的**设计规格书**。所有执行模型以此为准绳；本文件不讨论实现细节的操作步骤（见 `EXECUTION-PLAN.md`）。
> **适用范围**：Web 端（教师+学生）与 Scanner 端（Electron 扫描工作台）双目标，亮/暗双主题。
> **视觉锚点**：`demo/demo.html`（单文件可交互 demo，浏览器直接打开）。

---

## 1. 设计哲学：明澈 Clarity

一套为「每天都要用、一次用几小时」的教育专业工具而生的**功能美学**体系。五条不可妥协的原则：

| # | 原则 | 含义 | 反例（现状病灶） |
|---|------|------|----------------|
| P1 | **内容即界面** | 答题卡纸面、成绩数据、扫描图像是唯一主角；界面 chrome 退后，用发丝边框与留白代替装饰 | 全站玻璃拟态 `backdrop-filter blur(24px)`、径向渐变泛光、品牌红铺满 |
| P2 | **品牌克制** | 校红 `#C00F28` 只出现在 4 个位置：品牌标识、主行动按钮、选中态、关键数据强调。界面 90% 由中性色承载 | 顶栏/侧栏/按钮/卡片全红系渐变，红失去强调意义 |
| P3 | **效率即美学** | 信息密度可选（舒适/紧凑）、数字等宽对齐、表格右对齐、键盘可达、操作路径 ≤3 步 | 扫描台与判分台无密度分级；`ScorePad` 无 loading；导出无进度 |
| P4 | **一致即信任** | 单一令牌源、单一组件源、单一图标源；任何颜色/间距/圆角都可追溯到令牌 | `--warning` CSS/TS 双源漂移；58 处幽灵变量；25+ 硬编码色 |
| P5 | **状态可感知** | 每个异步操作有加载/成功/失败/空四态；危险操作有明确代价提示 | UI-1 提交无节流、UI-5 SSE 断连无提示、UI-3 大导出无进度 |

**美学血统**：Linear 的精确秩序 × Apple HIG 的层级克制 × Notion 的中文亲和。**明确拒绝**：玻璃拟态滥用、弥散投影泛光、无意义渐变、emoji 当图标、动画超过 240ms 的"表演性"动效。

---

## 2. 技术选型指令（强制）

| 层 | 选型 | 理由（设计视角） |
|----|------|------------------|
| 样式引擎 | **Tailwind CSS v4**（CSS-first，`@theme` 配置） | 令牌即主题；原子化天然**消灭类名冲突**（防串台的结构性保障）；无运行时 |
| 组件基座 | **shadcn/ui**（Radix UI 无头原语 + 源码自有组件） | 组件源码进仓库、可改可控，无黑盒依赖；Radix 自带焦点管理/键盘导航/ARIA |
| 数据表格 | **TanStack Table v8** | 成绩表/题目分析表需要排序/筛选/列显隐/虚拟滚动；头less 不干扰美学 |
| 图标 | **lucide-react**（维持现状） | 已是唯一合法图标源；规格见 §4.6 |
| 图表 | **chart.js 保留** + 自研 `<Chart>` 主题适配器 | 迁移面最小；适配器从令牌取色，图表不再是美学飞地 |
| 数字展示 | `tabular-nums` 工具类 | 分数/排名/ID 必须等宽数字 |
| 禁止引入 | Ant Design / MUI / Element / 任何自带主题的组件库 | 主题体系会与本方案冲突，造成新的"串台" |

> 双构建目标（web / scanner）共用同一组件库与主题；scanner 端通过 `data-density="compact"` 获得紧凑密度，**不做第二套主题**。

> **皮肤扩展机制（v2.1.0 预留，未做第二套视觉风格）**：前端已建立「皮肤 = 风格维度（`data-skin`），与明暗（`data-theme`）正交」的扩展接口——当前仅默认皮肤 `flat`（即本设计系统），新增皮肤只需在 tokens.css 追加 `[data-skin="xxx"]` L2 覆盖块 + 前端注册表登记一项（组件零改动），机制细节见 `readus/SKIN-THEME.md`。若未来新增皮肤，需遵守本文件 §3.2 色彩体系纪律（对比度 ≥4.5:1、chart-1 恒等于当前主体、纸面恒白 ADR-6）。

---

## 3. 主题层（本次重构的核心交付）

### 3.1 三层令牌架构

事实源文件：**`design/tokens/tokens.css`**（已交付，含 light/dark/compact 完整定义）。

```
L1 Primitive  原始令牌   --px-red-600 / --px-gray-100 / --px-space-4 …
     ↓ 只能向下引用
L2 Semantic   语义令牌   --px-bg-surface / --px-fg-primary / --px-accent-bg …
     ↓ 组件与页面只允许消费本层（经 Tailwind 工具类间接消费）
L3 Component  组件令牌   --px-control-h-md / --px-table-row-h / --px-rail-w …
```

- **L1 禁止出现在业务代码**。任何 `--px-red-600` 直接写进组件 = 评审驳回。
- 亮/暗主题只改 L2 映射，组件零改动 —— 这是"主题层重构"的意义。
- 紧凑密度 `[data-density="compact"]` 只改 L3 尺寸令牌。

### 3.2 色彩体系（数值已定义于 tokens.css，此处规定**用法**）

| 令牌族 | 角色 | 使用纪律 |
|--------|------|----------|
| 品牌绯红 `#C00F28`（red-600 领衔 11 档色阶） | Accent | 主按钮、选中态、品牌标识、当前数据系列。**一屏内主按钮 ≤1 个** |
| 锌灰 Zinc 11 档 | 界面骨架 | 承载 90% 界面；暗色主题复用同阶反转 |
| 绿/琥珀/蓝 3 族 | 状态语义 | success/warning/info，每族仅 4 件套（bg/soft/fg/border） |
| 绯红兼任 | danger | 危险与品牌同族不同档，靠**语境+图标+文案**区分，不靠新色相 |
| 8 色图表色板 `--px-chart-1..8` | 数据可视化 | chart-1 品牌红**恒等于"当前主体"**（本校/本班/当前考试），其余按序取用 |

**界面色彩配比（60-30-8-2）**：约 60% 中性底、30% 中性文字与边框、8% 状态色、**≤2% 品牌红**。执行模型自查：截图眯眼测试，红色应当"一眼找到、只有一处"。

### 3.3 shadcn/ui 主题映射表（执行时按此生成）

| shadcn 变量 | ← 本方案令牌（Light） | Dark |
|---|---|---|
| `--background` | `--px-bg-canvas` (#F4F4F5) | #101013 |
| `--foreground` | `--px-fg-primary` | #F4F4F5 |
| `--card` / `--popover` | `--px-bg-surface` / `--px-bg-raised` | #17171B / #1E1E23 |
| `--primary` | `--px-accent-bg` (#C00F28) | #D93851 |
| `--primary-foreground` | `--px-fg-on-accent` | 同左 |
| `--secondary` / `--muted` | `--px-bg-subtle` / `--px-bg-muted` | #1B1B20 / #222228 |
| `--muted-foreground` / `--secondary-foreground` | `--px-fg-tertiary` / `--px-fg-secondary` | #8B8B94 / #A1A1AA |
| `--accent` / `--accent-foreground` | `--px-accent-soft` / `--px-accent-fg` | rgba(217,56,81,.14) / #F28393 |
| `--destructive` | `--px-danger-bg` | #D93851 |
| `--border` / `--input` | `--px-border-default` / `--px-input-border` | rgba(255,255,255,.11) |
| `--ring` | `--px-accent-ring` | rgba(217,56,81,.45) |
| `--radius` | `--px-radius-md` (8px) | 同左 |
| `--chart-1..5` | `--px-chart-1..5` | 同左 |
| 间距/字阶/阴影/z-index | Tailwind `@theme` 的 `--spacing-*` `--text-*` `--shadow-*` 全部对齐 tokens.css L1 | — |

> 完整数值以 `tokens/tokens.css` 为准，本表是**语义对应关系**，不允许映射表之外的"临时色"。

### 3.4 可复现规约（后期更新如何不走样）

1. **单一事实源**：色彩/间距/字阶/圆角/阴影/动效/z-index 只存在于 `tokens.css`（设计层）→ 执行层生成 Tailwind `@theme` + `theme.ts` 镜像（图表/JS 用）。**三处数值由脚本同步，禁止手改其中一处**。
2. **新增颜色**：必须先在 tokens.css L1 建档 + L2 指派语义角色 + DESIGN-SYSTEM 记录用途，三步齐全才可使用。
3. **新增组件**：必须先查 §5 组件目录 → 没有则按 §6 组件规格以 shadcn 原语拼装 → 进 `components/ui/` 并登记。
4. **设计评审两问**：这个颜色的令牌是什么？这个组件和现有哪个组件是同类？答不出即返工。

---

## 4. 视觉语言规范

### 4.1 字体排印

| 角色 | 令牌 | 规格 | 用途 |
|------|------|------|------|
| Display | text-4xl/5xl | 28/32px · 700 · leading-tight · 字距 -0.02em | 登录页/首页欢迎 |
| 页面标题 | text-2xl | 20px · 600 | PageHeader |
| 区块标题 | text-lg | 16px · 600 | Card/Section 标题 |
| 正文 | text-base | 14px · 400 · leading-normal | 默认 |
| 辅助 | text-sm | 13px · 400 · fg-secondary | 说明文字 |
| 微标注 | text-xs | 12px · 500 · fg-tertiary | 表头/徽章/图注 |
| **数据** | + `tabular-nums` | 字号随语境 · 500/600 | 分数、排名、ID、百分比 **一律等宽数字右对齐** |

字体栈维持系统中文字体栈（tokens.css `--px-font-sans`），不引入 Webfont（离线内网可用）。

### 4.2 间距与密度

- **4px 基栅格**：一切内外边距取 `--px-space-*`（4/8/12/16/24/32/48/64），禁止 7px/13px 类魔法数。
- **密度两档**：舒适（默认，表格行高 44/控件高 36）｜紧凑（扫描/判分工位，行高 36/控件高 32）。密度切换不动字号。
- 卡片内边距：桌面 20–24px，移动 16px；卡片间距：16–24px。

### 4.3 圆角与边框

| 元素 | 圆角 | 边框 |
|------|------|------|
| 按钮/输入/徽章 | md(8) / sm(6) | 1px `--px-border-default` |
| 卡片/面板 | lg(12) | 1px `--px-border-subtle` |
| 模态/抽屉 | xl(16) | 无（用阴影分层） |
| 头像/状态点 | full | — |

**边框优先、阴影兜底**：层级关系能用 1px 发丝边框表达的就不用阴影；全站阴影仅 4 档（`--px-shadow-1..4`），分别对应 静止卡片/悬停浮起/模态抽屉/灯箱。

### 4.4 动效

| 场景 | 时长 | 缓动 | 形式 |
|------|------|------|------|
| 微反馈（hover/press） | 100ms | ease-standard | 背景/边框色变，**禁位移** |
| 状态过渡（tab/展开） | 160ms | ease-out | 透明度 + ≤4px 位移 |
| 弹层进出（modal/toast） | 240ms | ease-out | fade + scale 0.98→1 / 滑入 |
| 页面入场 | 360ms 上限 | ease-out | 仅首屏，fade+translateY 8px |

- `prefers-reduced-motion` 时全部收敛为瞬时（tokens.css 已内置开关）。
- **禁止**：弹簧动画用于功能反馈、循环呼吸动画（loading 除外）、超过 360ms 的任何过渡。

### 4.5 可访问性基线（验收硬指标）

正文对比度 ≥4.5:1（tokens 各 fg 与对应 bg 已配对达标）；焦点环全局唯一形态 `--px-focus-ring`（2px 底色 + 4px 品牌红 30%）；交互目标桌面 ≥32px / 移动 ≥44px；色彩永不单独承载状态（必配图标或文字）；所有弹层焦点圈定 + Esc 关闭（Radix 原生提供）。

### 4.6 图标

lucide-react 唯一来源。尺寸档位 14/16/18/20，默认 strokeWidth 2，16px 以下用 1.75。**emoji 不得作为功能图标**（现状 HomePage 的 📝🆕📋 必须替换）。语义图标固定映射：成功 CircleCheck / 警告 TriangleAlert / 危险 OctagonAlert / 信息 Info / 扫描 ScanLine / 识别 Sparkles → 全站唯一。

---

## 5. 布局与应用外壳

### 5.1 桌面外壳（重构后）

```
┌──────────┬───────────────────────────────────────────────┐
│          │  PageHeader：面包屑/标题 · 页面动作 · 全局元素   │ 60px
│  AppRail ├───────────────────────────────────────────────┤
│  232px   │                                               │
│ (可收起   │  Content（max-w 1200/1440，模块自定）           │
│  至64px) │                                               │
│          ├───────────────────────────────────────────────┤
│          │  StatusBar：系统状态 · 自动保存 · 环境标识        │ 30px
└──────────┴───────────────────────────────────────────────┘
```

- **AppRail（主导航栏）**：顶部品牌区（校徽+系统名）→ 主导航（首页/设计/考试管理/分析/我的成绩/账号/全局设置，**按权限渲染**，与现有 `canDesign/canManageExams/...` 一一对应）→ 底部（主题切换、用户菜单）。选中项：浅红底 + 品牌红文字 + 左侧 3px 指示条。
- **ContextPanel（模块上下文栏，300px，按需出现）**：仅设计模式保留（现 280px 答题卡侧栏的正统化），其余模块不得私设常驻侧栏。
- **PageHeader**：页面标题+一句副标题+本页主行动（右置，主按钮 ≤1）。
- **StatusBar**：常驻底部，承载自动保存状态机（保存中/已保存 HH:mm/失败重试）、扫描服务状态、版本号。替代现状散落的浮层提示。
- 路由与 `modeRoutes.ts` **零改动**；深链/`useBlocker`/权限显示逻辑原样保留。

### 5.2 移动端

底部导航（≤480px，5 项上限，安全区适配）+ 顶部抽屉（Sheet）= 现状能力的组件化，不新增不减少。

---

## 6. 组件规格（shadcn 基座上的固定配方）

> 每个组件给出：**基座 → 定死的美学决策**。未列"可选"的维度即不允许分叉。UI 库组件进 `components/ui/`，业务组件进各自模块目录，**禁止页面内私造同款**。

| 组件 | 基座 | 规格（定死项） |
|------|------|----------------|
| Button | shadcn Button | 5 变体：`primary`(品牌红实底)/`secondary`(中性实底)/`outline`/`ghost`/`destructive`；3 尺寸 sm32/md36/lg40；**loading 态强制**（spinner 替换图标+禁用）；图标+文字间距 8px |
| IconButton | Button variant=ghost size=icon | 必须有 aria-label + Tooltip |
| Input/Select/Textarea | shadcn | 高 36，边框 `--input`，focus=全局焦点环；错误态=danger 边框+下方 12px 错误文案 |
| Checkbox/Radio/Switch | shadcn | 选中填充品牌红；Switch 用于即时生效设置，Checkbox 用于提交前选择，**不混用** |
| SegmentedControl | ToggleGroup | 容器 bg-subtle 圆角 8，选中白色/深色浮起+shadow-1；用于 ≤5 项视图切换 |
| Tabs | shadcn Tabs | 下划线式唯一形态：选中=fg-primary+2px 品牌红下划，未选=fg-tertiary；考试详情 6 Tab 归此 |
| Badge/Tag | shadcn Badge | 状态徽章=soft 底+fg 字+前置 8px 状态点；**考试状态枚举固定**：未开始(灰)/阅卷中(琥珀)/已完成(绿)/异常(红) |
| Card/Panel | shadcn Card | 圆角 12 + border-subtle + 无阴影（静止）；hover 可点时 shadow-2+translateY(-2px) 160ms |
| StatCard 数据卡 | 组合 | 大数字 text-3xl tabular-nums + 12px 指标名 + 环比小字（涨绿跌红，教育语境**跌红涨绿**，与股市一致） |
| Table | TanStack Table + shadcn Table | 表头 12px 500 fg-tertiary bg-subtle sticky；行高 44/紧凑 36；**文字左对齐、数字右对齐、操作列右置**；hover 行 bg-subtle；斑马纹禁用 |
| Dialog | shadcn Dialog | 3 宽档 sm480/md640/lg880；标题+关闭右上；**危险确认统一双按钮右置：主按钮 destructive 文案说清代价**（"删除考试，不可恢复"） |
| Drawer/Sheet | shadcn Sheet | 右侧 420px 用于详情速览（学生逐题/扫描异常卷）；移动端导航用左侧 |
| Toast | Sonner | 右下，4 语义色，成功 3s/失败常驻可关；操作型 toast 带撤销按钮 |
| Tooltip | shadcn Tooltip | 仅解释图标/截断文本，200ms 延迟，禁放交互内容 |
| DropdownMenu | shadcn | 菜单项高 32，危险项 danger 红字置底分组 |
| Progress | shadcn Progress | 扫描/导出/识别**必须**确定性进度（百分比+当前项名），不允许无限 spinner 兜底 |
| Skeleton | shadcn Skeleton | 页面首载一律骨架屏模拟真实布局；spinner 仅限按钮内与 <300ms 场景 |
| EmptyState | 组合 | 三段式：lucide 线框图标 48px(fg-tertiary) + 标题 + 一句引导 + 主行动按钮 |
| Pagination | shadcn Pagination | 表格统一底栏：左"共 N 条"、右翻页；≥200 行进虚拟滚动替代 |
| UploadZone | 自研（复用 DragDropZone 能力） | 虚线框 1.5px border-strong 圆角 12 + 图标 + "拖拽或点击"；拖拽悬停时品牌红边+soft 底 |
| ScoreBadge 分数徽标 | 组合 | 得分/满分 `12/15` 等宽数字；得分率着色：≥85% 绿 / 60–84% 中性 / <60% 红 |
| Kbd 键盘提示 | 组合 | 等宽 12px + border 圆角 4 + bg-subtle；扫描/判分界面右下角常驻快捷键卡 |
| Chart | chart.js 适配器 | 网格线 border-subtle、无图例盒、直接标注；色序=chart-1..8；难度 P/区分度 D 徽章档位沿用现有语义 |
| PaperCanvas 答题卡纸面 | 自研 | **纸面恒白**（`--px-paper-bg`，暗色下不变），卡片外裹 12px 中性底容器以衬托 |

**防串台组件纪律**：页面不得 import 其他页面的组件；跨页面复用的组件只能存在于 `components/ui/`；UI 库之外的新增手写 CSS 总量应为零（Tailwind 工具类 + 组件源码内联完成）。

---

## 7. 交互模式规范（页面级范式）

| 模式 | 规范 | 适用 |
|------|------|------|
| 列表→详情 | 列表页(筛选条+表格) → 详情页(Tabs 组织)；返回保留筛选与滚动位 | 考试管理、分析 |
| 工作台 | ContextPanel(对象列表) + 中央画布 + 右侧检查器；三区可分栏拖拽(Resizable) | 答题卡设计器 |
| 全屏任务流 | 隐藏 AppRail，顶部仅进度与退出；键盘主导；右下角快捷键卡 | 扫描工作台、网上阅卷 |
| 向导 | 顶部分步指示(Steps)，每步单栏 ≤5 字段，下一步前校验 | 新建考试/新建答题卡 |
| 异步四态 | 任何数据区都有 loading(骨架)/error(重试按钮)/empty(EmptyState)/success | 全部页面 |
| 自动保存 | 状态机：编辑→(1s 防抖)→保存中→已保存 HH:mm / 失败(重试)；离开拦截沿用 useBlocker | 设计器 |
| 危险操作 | 删除/覆盖类必须 confirm Dialog；不可逆且影响面大者输入名称确认 | 删除考试/答题卡 |
| 扫描反馈 | SSE 进度=Progress+当前文件名+已扫/总数+失败列表可重试；**断连 5s 内自动重连并明示状态**（修复 UI-5） | ScannerPanel |
| 提交节流 | 判分/阅卷提交：提交中按钮 loading+禁用，失败 toast 可重试（修复 UI-1/UI-2） | ScorePad/OnlineReview |
| 隐私边界 | 学生端任何接口仅渲染本人数据；前端不缓存他人字段；表格无"班级排名"列（受后端 requireExamAccess 约束） | 学生成绩 |

---

## 8. 分页面设计要点（优先级依业务确认：扫描识别链路 > 分析 > 学生 > 首页 > 考试管理 > 设计器 > 低频网阅）

1. **扫描工作台（最高优先）**：紧凑密度；左列=扫描控制+实时进度+文件导入，右列=已扫卷缩略图网格（每张卡：纸面缩略图+状态徽章+学号识别结果，异常卷红边置顶）；全键盘流（Enter=开始/继续，E=标记异常）；断连横幅明示。
2. **成绩分析**：顶部考试上下文条（考试名/学科/时间+切换）→ 6 Tabs；概况=StatCard 行（均分/最高/最低/标准差/及格率/优秀率）+分布图；题目分析=TanStack 表(可排序+下钻 Drawer)；图表全走 chart-1..8 色板。
3. **学生成绩（只读）**：总分卡+学科雷达(SVG)+趋势折线+逐场考试表；无排名无他人数据；AI 分析以 Card+Markdown 呈现。
4. **教师首页**：欢迎行(大问候+角色徽章) → 快捷入口(继续阅卷-琥珀/最新扫描-蓝/考试管理-中性，**lucide 图标替代 emoji**) → 模块卡(权限渲染) → 最近考试表。
5. **考试管理**：筛选条(学期/学科/状态 SegmentedControl) + 考试表(状态徽章+进度条+操作 DropdownMenu)；阅卷中考试琥珀 soft 行底置顶（保留现状语义）；详情 5 Tab。网阅子功能（分配/争议/仲裁/溯源/设置）**保证可用、套用表格与 Dialog 规范即可，克制投入**。
6. **答题卡设计器**：三栏工作台；SVG 纸面预览恒白居中；检查器分区折叠；块列表用 Card 列表+选中品牌红左边条。
7. **登录**：居中 400px 卡片，左侧品牌区（校徽+系统名+一句价值主张），表单字段 `identifier`；暗色同样式。
8. **账号/权限/全局设置/指南/赞助**：标准"PageHeader+Card 分区"即可，不单独设计。

---

## 9. 设计决策记录（ADR 摘要，供后期效仿时理解"为什么"）

- **ADR-1 弃玻璃拟态取扁平发丝边框**：专业工具日使用时长远超展示型产品，模糊层耗 GPU 且降低文字锐度；边框+留白的秩序感在数据密度下更耐久。
- **ADR-2 品牌红克制到 2%**：强调色的强调能力与其出现频率成反比；同时红兼任 danger，必须靠稀缺性保住语义区分。
- **ADR-3 选 shadcn/ui 而非成品组件库**：主题必须 100% 自有（校绯红+锌灰+双主题+紧凑密度），成品库主题覆盖成本高于源码自有；Radix 的无障碍是验收硬指标的来源。
- **ADR-4 保留 chart.js 不换 Recharts**：迁移面最小化是执行约束；美学问题由主题适配器解决，与库无关。
- **ADR-5 双密度而非双主题**：scanner 端与 web 端美学同源，仅 L3 尺寸令牌分档，避免两套视觉语言再次"串台"。
- **ADR-6 纸面恒白**：答题卡是物理纸张的数字孪生，暗色模式下保持纸白是识别预览与打印认知一致性的关键。

---

## 10. 交付物清单（本目录）

| 文件 | 角色 |
|------|------|
| `DESIGN-SYSTEM.md`（本文件） | 美学方案与全部规范 |
| `EXECUTION-PLAN.md` | 分阶段执行方案 + 任务卡 + 验收标准 |
| `tokens/tokens.css` | 主题层令牌事实源（light/dark/compact 完整数值） |
| `demo/demo.html` | 单文件可交互 demo：8 视图（设计基础/组件/登录/首页/考试管理/分析/学生成绩/扫描台），亮暗可切换 |
