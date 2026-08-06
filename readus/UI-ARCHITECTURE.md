# Project-X UI 架构与开发指南（v2.0.0）

本文档定位：UI 全面重构（Flat 2.0「明澈 Clarity」设计系统）**全量落地后**的现状说明，也是**新 UI 开发**与**全局风格调整**的唯一方法文档；配套 `readus/CHANGELOG.md` 的 v2.0.0 条目阅读。

> 阅读前提：本文档假设读者已了解项目整体架构（见 [readus/ARCHITECTURE.md](./ARCHITECTURE.md)）。业务页面怎么写、组件怎么用、全局风格怎么调，全部以本文档为准。

---

## 一、当前 UI 架构（现状说明）

### 1. 技术栈与构建

| 项 | 说明 |
|----|------|
| 前端 | **Vite 7 + React 19 + TypeScript**，Tailwind CSS v4（无 Preflight，另立 P7）+ shadcn/ui 组件基座 |
| 双构建目标 | `dist/web/`（教师 + 学生 Web 端）与 `dist/scanner/`（Electron 扫描工作台）**共用同一组件库与主题**；扫描端通过 `data-density="compact"` 获得紧凑密度，不做第二套主题 |
| 后端 | Express API（`src/apps/answer-card/server/index.ts`），端口 **5174**；Vite dev 在 5173 并代理 `/api` |
| 组件 | `components/ui/v2/` 是**唯一组件事实源**（P5 已删除旧 PascalCase 组件目录） |
| 样式 | **三文件事实源**：`theme/app.css` + `theme/tokens.css` + `theme/backdrop.css`，旧 `styles.css`（6048 行）与 `theme/legacy-bridge.css` 已于 P6 T05 删除，遗留类归零 |

### 2. 客户端关键目录地图

`src/apps/answer-card/client/`：

| 目录 / 文件 | 职责 |
|-------------|------|
| `theme/app.css` | Tailwind v4 入口：`@import "tailwindcss/theme.css"` + `utilities.css`、`@layer base` 最小 reset、`@theme` 语义映射、`dark` 自定义 variant、`tw-animate-css` 动画工具类 |
| `theme/tokens.css` | **令牌源**（`app.css` 内 import）：L1 原始 / L2 语义（亮·暗）/ L3 组件，三套全量落在本文件 |
| `theme/backdrop.css` | 自定义背景图浮层（`body.has-bg-image::after`），功能性样式，非遗留装饰 |
| `theme.ts` | JS 侧令牌镜像（图表取色、动态样式、z-index 阶梯），与 tokens.css 同步 |
| `components/ui/v2/` | 设计系统组件基座（**桶导出**，页面只准从这里具名 import） |
| `components/` | 业务组件（页面各自私有，禁止跨页面互相 import） |
| `pages/` | 路由页（HomeRoutePage / DesignPage / ExamManagePage / AnalysisRoutePage / ScoresRoutePage / AccountRoutePage / AccountSettingsPage / GlobalSettingsRoutePage / InfoRoutePages 等） |
| `modeRoutes.ts` | mode ↔ URL 路径**单一映射**（`MODE_PATH` / `pathToMode`） |
| `auth/` | AuthContext、强制改密、API 封装 |
| `lib/` `hooks/` `util/` `dev/` | 工具函数 / useMediaQuery（三断点）等 |
| `App.tsx` | 主应用外壳：`railNavItems`（桌面 rail + 移动抽屉共用）、路由渲染、`canOpenMode` 权限闸 |
| `ScannerApp.tsx` | 扫描端双屏容器 |

### 3. 样式事实源与令牌分层

**三个文件的分工：**

| 文件 | 角色 | 关键内容 |
|------|------|----------|
| `theme/app.css` | 落地入口 | `@theme` 块把 `--px-*` 令牌映射为 Tailwind 语义工具类（`bg-background`/`text-foreground`/`border-border`/`bg-card`…）；`@layer base` 最小 reset（`box-sizing`/`html,body,#root` 尺寸/`body` 背景前景与主题过渡/`color-scheme`/原生控件 UA 收敛）——**Preflight 未启用**（架构师 D2 决策，启用另立 P7） |
| `theme/tokens.css` | 令牌源 | L1 原始 / L2 语义 / L3 组件三层的唯一定义处 |
| `theme/backdrop.css` | 功能样式 | 背景图浮层与暗色遮罩（JS 开关逻辑在 App.tsx，零改动） |

**tokens.css 两层结构（实际分三层 + 密度/动效）：**

- **L1 · RAW 原始色阶（`:root`，约 19 行起）**——组件与页面**禁止直接引用**：
  - `--px-red-50~950`（品牌红阶，`--px-red-600: #C00F28` 为**品牌基准色**）；
  - `--px-gray-0~950`（锌灰中性阶）；`--px-green-*` / `--px-amber-*` / `--px-blue-*`（状态色阶）；
  - `--px-chart-1~8` 数据可视化色板（`chart-1 = #C00F28` 品牌红领衔，顺序即取用顺序）；
  - `--px-space-0~20`（4px 基栅格）、`--px-radius-xs~full`（4/6/8/12/16/20/999px）、`--px-text-xs~5xl` 字号阶梯（中文 14px 为正文基准）；
  - 字体栈、行高、字重、动效（dur/ease）、z-index 阶梯（`--px-z-base~lightbox`）、断点（`--px-bp-phone~wide`）。
- **L2 · SEMANTIC 语义令牌（亮 / 暗两块）**——组件**只能引用本层**：
  - **亮**：`:root, [data-theme="light"]`（**约 145 行起**）——`--px-bg-*`（canvas/surface/raised/overlay/subtle/muted/inverse/scrim 背景层次）、`--px-fg-*`（primary/secondary/tertiary/disabled/inverse/on-accent 文字，带对比度注释如 `fg-primary 15.8:1`）、`--px-border-*`（subtle/default/strong 三级）、`--px-accent-*`（bg/hover/active/soft/fg/border/ring）、success｜warning｜danger｜info 四件套、`--px-shadow-1~4` + `--px-shadow-accent`、`--px-focus-ring`、paper（答题卡纸面恒白）、selection；
  - **暗**：`[data-theme="dark"]`（**约 225 行起**）——同键覆盖，原则：**不用纯黑底**、品牌红提亮一档保对比、阴影加深 + 顶部分光。
- **L3 · COMPONENT 组件令牌（`:root`）**：控件高度（control-h-sm/md/lg + touch-target 44px）、表格行高、外壳骨架（rail 宽 / page-header 高 / mobile-nav 高）、内容容器、输入控件共性、安全区。
- 另有 `[data-density="compact"]`（紧凑密度，扫描工作台用）与 `@media (prefers-reduced-motion)`（动效收敛为 1ms）。

**令牌三处同步（防漂移）：**

```
design/tokens/tokens.css（设计层事实源）
        │  npm run sync-tokens（scripts/sync-tokens.mjs）
        ▼
client/theme/app.css（@theme 块）  ── 组件/工具类消费
client/theme.ts（JS/图表取色）     ── chart.js 适配器等消费
```

- 手改 `app.css` 的 `@theme` 块或 `theme.ts` 中的任一值 = **漂移事故**（历史上发生过 tokens.css / styles.css / theme.ts 三处漂移，已修）。
- 唯一合法改法：改 `design/tokens/tokens.css` → 跑同步 → 验证（详见第三节）。

### 4. 组件库 v2 用法要点

`components/ui/v2/` 是唯一组件事实源，**纪律**：

- **桶具名 import**：一律 `import { Button, Card } from "@/components/ui/v2"`（等价路径按项目 alias），**禁止直指实现文件**（如 `v2/button`）、禁止跨页面互相 import；
- 组件内零手写 CSS，只用工具类 + cva；颜色只说语义；图标只用 lucide-react；
- 常用组件清单：`Button` / `Card`（含 CardHeader/CardTitle/CardContent…）/ `Dialog` / `Tabs` / `Table`（含 TableWrap/DataTable）/ `DataCard` / `EmptyState` / `Spinner`（含 Skeleton/SkeletonText/Kbd）/ `Badge` / `Field` / `Input` / `Select` / `Switch` / `Checkbox` / `RadioGroup` / `SegmentedControl` / `ToggleGroup` / `StatCard` / `Chart` / `Sheet` / `DropdownMenu` / `Tooltip` / `Toaster` / `Pagination` / `Progress` / `UploadZone` / `AppShell` 系列（AppRail/PageHeader/ContextPanel/StatusBar）；
- **`Badge` 用 `tone` 不用 `variant`**（`neutral`/`warning`/`success`/`danger`，默认 `neutral`；`ExamStatusBadge` 枚举已固定）；
- **`DropdownMenuItem` 危险项（删除类）用 `tone="danger"`**（红字，须置底分组）；
- `paletteColor` / `chartPalette` / `rampPalette` / `useChartTheme` / `withAlpha` 均由 `index.ts` 从 `chart.tsx` **再导出**，图表取色统一走这里（chart.js 适配器从 `theme.ts` 取色）。

### 5. mode 路由系统

**每个功能 = 一个真实 URL**，mode ↔ 路径映射收敛在 `client/modeRoutes.ts`：

- `MODE_PATH`：`Record<ProjectXAppMode, string>` 单一映射（design→`/design`、exam-manage→`/exam-manage`、home→`/home`、analysis→`/analysis`、scores→`/scores`、account→`/account`、account-settings→`/account-settings`、global-settings→`/global-settings`、sponsor→`/sponsor`、guide→`/guide`、permissions→`/permissions`）；
- `pathToMode(pathname)`：由当前 URL 反推 mode（`/` 根路径直接视作 `home`），**无法识别时返回 `null`**。⚠ 教训：`pathToMode` 未覆盖的路径会触发重定向回 fallbackMode，**一帧跳走**（历史 404 事故），新 mode 必须在此完整登记；
- `src/shared/appVariant.ts`：三变体 `student` / `teacher` / `teacher-scanner`，各自 `allowedModes`：
  - `student`：`["scores", "account-settings"]`；
  - `teacher` / `teacher-scanner`：`["home", "design", "exam-manage", "analysis", "account", "account-settings", "global-settings"]`（后者 `enableScanner: true`）；
- `App.tsx`：`railNavItems`（桌面 rail + 移动抽屉共用同一数据源）生成导航项；路由渲染时每个 `<Route>` 包一层 `canOpenMode(mode)` 权限闸（学生端通过教师深链直接 403 重定向）；深链/刷新时 `pathToMode` → `canOpenMode` 双闸保持当前页。

### 6. 设计锚点与文档引用表

| 文档 | 说明 |
|------|------|
| [design/DESIGN-SYSTEM.md](../design/DESIGN-SYSTEM.md) | Flat 2.0「明澈 Clarity」美学规格：§3 令牌架构、**§6 组件规格**、**§9 设计决策记录（ADR）**、§4 视觉语言、§7 交互模式 |
| [design/tokens/tokens.css](../design/tokens/tokens.css) | 主题令牌事实源（L1 原始 / L2 语义 / L3 组件） |
| [design/demo/demo.html](../design/demo/demo.html) | 交互 Demo（**8 视图**：登录 / 首页 / 考试管理 / 成绩分析 / 学生成绩 / 扫描工作台 / 设计基础 / 组件，亮暗双主题），**视觉验收基准** |
| [design/designer-sandbox.html](../design/designer-sandbox.html) | 设计器沙盒 |
| [design/EXECUTION-PLAN.md](../design/EXECUTION-PLAN.md) | 重构执行计划（T1–T8 任务卡、P0–P5 阶段、防串台规约、附录 B 同步规约） |
| [docs/system_design.md](../docs/system_design.md) | P6 系统设计（含 mermaid 类图 / 时序图） |
| [readus/ARCHITECTURE.md](./ARCHITECTURE.md) | 系统总体架构、分层、数据流、原生模块与构建部署 |
| [AGENTS.md](../AGENTS.md) | 「样式事实源（P6 T05 定稿）」节 = 团队铁律 |
| [readus/CHANGELOG.md](./CHANGELOG.md) | v2.0.0 条目 = 本次重构变更全记录 |

---

## 二、新 UI 开发指南（落实设计稿）

做新页面 / 新组件，按下述五步对齐 Flat 2.0：

### 步骤 1 · 找蓝本

先在 [design/demo/demo.html](../design/demo/demo.html) 定位对应视图（8 视图 × 亮暗双主题），再查 [design/DESIGN-SYSTEM.md](../design/DESIGN-SYSTEM.md) **§6 组件规格**（每个组件的"基座 → 定死的美学决策"）与 **§9 设计原则（ADR）**。设计稿未覆盖处选最保守方案，**禁止即兴发挥**。

### 步骤 2 · 用组件

只从 `components/ui/v2` 桶**具名 import**（见第一节 §4 清单与要点），例如：

```tsx
import { Button, Card, CardContent, Badge, StatCard, Chart, paletteColor } from "@/components/ui/v2";
```

- `Badge` 传 `tone`；删除类菜单项用 `DropdownMenuItem tone="danger"`；
- 图表色一律经 `paletteColor(n)` / `chartPalette`；
- 禁止直指 `v2/button` 这类实现文件，禁止跨页面互相 import。

### 步骤 3 · 写样式

只用 **Tailwind 工具类 + 语义令牌**：

```tsx
<div className="rounded-lg border-border bg-card p-4">
  <h2 className="text-base font-semibold text-primary">标题</h2>
  <p className="text-sm text-muted-foreground">说明文字</p>
  <span className="tabular-nums">123.45</span>
</div>
```

**铁律**：禁止硬编码 hex、禁止内联 `style={{}}`（仅允许带注释说明的动态值）、**禁止新建 CSS 文件**；要扩展主题只改 `design/tokens/tokens.css` + 跑同步（见第三节）。数字一律 `tabular-nums`，图标只用 lucide-react。

### 步骤 4 · 接路由（新页面四步接线）

1. `client/modeRoutes.ts`：`MODE_PATH` 加 `mode → 路径`，并注册页面组件映射（`pathToMode` 自动覆盖则防 redirect 回首页，保证深链 / 刷新保持当前页）；
2. `src/shared/appVariant.ts`：按需把新 mode 加入 `teacher` / `teacher-scanner` / `student` 三变体的 `allowedModes`；
3. `App.tsx`：`railNavItems` 加侧栏项（桌面 rail + 移动抽屉自动生效）；
4. `App.tsx`：路由渲染处加 `<Route path="/xxx" element={canOpenMode("xxx") ? <XxxPage/> : <Navigate to={MODE_PATH[fallbackMode]} replace/>} />` 权限分支。

### 步骤 5 · 验收

1. `npm run typecheck` + `npm run build:web` + `npm run build:scanner` 全绿；
2. **铁律 grep**：`hex` 仅允许命中 `tokens.css` / `@theme`；`style={{` 仅允许带注释的动态值；
3. **视觉**：Playwright 亮 / 暗双主题截图对照 `design/demo/demo.html` 对应视图（走 `ui-visual-verification` skill 流程）。

---

## 三、全局风格调整指南（本版重点）

### 1. 令牌分层速查（改哪层管什么）

| 想调什么 | 改哪里 |
|----------|--------|
| 品牌色（红阶）、中性色（gray 阶）、图表色板、间距、圆角、字号、字重、动效、z 阶梯、断点 | **L1 `:root`**（`design/tokens/tokens.css` 19 行起） |
| 背景层次（bg-*）、文字色（fg-*）、边框（border-* 三级）、品牌强调（accent-*）、状态四件套（success/warning/danger/info）、阴影 4 级、焦点环、paper、selection | **L2 亮块**（`[data-theme="light"]`，145 行起）与 **L2 暗块**（`[data-theme="dark"]`，225 行起） |
| 控件高度、表格行高、外壳骨架、内容容器 | **L3**（`:root`，292 行起） |
| 扫描工作台紧凑密度 | `[data-density="compact"]` |
| 减少动效 | `prefers-reduced-motion` 块 |

> 原则：业务代码里**禁止**直接出现任何色值 / 尺寸魔法数，全部收敛到令牌。语义工具类（`bg-primary` / `text-muted-foreground` 等）在 `app.css @theme` 里已映射好，一般无需改。

### 2. 标准流程（全局风格调整唯一合法路径）

```
改 design/tokens/tokens.css（只改这里）
      → npm run sync-tokens      （同步 app.css @theme + theme.ts）
      → npm run typecheck
      → npm run build:web / build:scanner
      → Playwright 亮暗双主题截图验证（ui-visual-verification）
```

⚠ **禁手改 `app.css` 的 `@theme` 块与 `theme.ts`**——它们是同步产物，手改 = 漂移事故，下次同步被覆盖。

### 3. 场景 A · 换主题色（例：品牌红 → 蓝）

品牌红 = 校徽绯红 `#C00F28`。换色有 **4 处必改点**，只改色阶会出现"残点"（残留旧品牌红）：

1. **L1 红阶或改引用**：要么直接改 `--px-red-50~950` 色值，要么把 L2 accent 系列改为引用蓝阶，例如：
   ```css
   /* L1 蓝阶（示例） */
   --px-blue-500: #3B82F6;
   --px-blue-600: #2563EB;   /* 新品牌基准 */
   --px-blue-700: #1D4ED8;
   --px-blue-800: #1E3A8A;
   ```
   ```css
   /* L2 亮块：accent-* 改指蓝阶 */
   --px-accent-bg:         var(--px-blue-600);
   --px-accent-bg-hover:   var(--px-blue-700);
   --px-accent-bg-active:  var(--px-blue-800);
   --px-accent-soft:       var(--px-blue-50);
   --px-accent-soft-hover: var(--px-blue-100);
   --px-accent-fg:         var(--px-blue-700);
   --px-accent-border:     var(--px-blue-100);
   ```
2. **`--px-chart-1`**（L1，**硬编码 `#C00F28`**，图表主系列 = 本校/本班数据，必须一起改）：
   ```css
   --px-chart-1: #2563EB;
   ```
3. **3 处硬编码品牌红 `rgba(192,15,40,…)`**（L2 亮块，不同步改会残留旧品牌红）：
   ```css
   --px-accent-ring:       rgba(37, 99, 235, 0.30);   /* 焦点环 */
   --px-selection-bg:      rgba(37, 99, 235, 0.14);   /* 选中文字 */
   --px-shadow-accent:     0 2px 8px rgba(37, 99, 235, 0.22);
   ```
4. **暗块 `[data-theme="dark"]` 的品牌红提亮值**（如 `#D93851` / `#E0485F` 系列）同样要换成新品牌色的提亮档（保证白字对比度 ≥ 4.5:1）：
   ```css
   --px-accent-bg:        #3B82F6;   /* 暗色下提亮档 */
   --px-accent-bg-hover:  #4C8FFA;
   --px-accent-bg-active: #2563EB;
   ```
5. 跑标准流程（§2）同步 + 验证。

> 另注意：`theme.ts` 里也镜像了品牌（`brand/brandDark/brandSoft/…`）与 chart 色板，同步脚本会自动更新，但 JS 侧个别 `rgba(192,15,40,…)` 需随同步核对。

### 4. 场景 B · 整套风格微调

- **中性色**：L1 `--px-gray-*` 色阶（低彩度锌灰系是 Flat 2.0 的冷静基调，调整会波及 bg/fg/border 的视觉）；
- **背景层次**：L2 亮块 `--px-bg-canvas/surface/raised/overlay/subtle/muted`（4 级：画布 → 表面 → 浮起 → 覆盖层）；
- **圆角体系**：L1 `--px-radius-xs~full`（12px 卡片 / 8px 控件 / 6px 输入框等全局生效）；
- **间距**：L1 `--px-space-*`（4px 基栅格，编号 = 4px 倍数）；
- **阴影**：L2 `--px-shadow-1~4` + `--px-shadow-accent`（低明度克制，拒绝泛光）；
- **焦点环**：L2 `--px-focus-ring` + `--px-accent-ring`（全局唯一形态）；
- **字号阶梯**：L1 `--px-text-xs~5xl`（正文基准 14px，`app.css @theme` 已覆盖 Tailwind 默认 16px）。

### 5. 场景 C · 暗色定制

只改 `[data-theme="dark"]` 块（225 行起），遵循三条既定原则：

- **不用纯黑底**（canvas `#101013`，非 `#000`）；
- **品牌红/强调色提亮一档**保白字对比度（accent-bg 暗色下用 `#D93851` 而非 `#C00F28`）；
- **阴影加深 + 顶部分光**（暗色 shadow 用高透明度黑）。

如需调暗色下的状态色、边框、paper（答题卡纸面**恒白**，不要改暗），同样只改本块。

### 6. 验证与注意

- tokens.css 内已带**对比度注释**（如 `--px-fg-primary 15.8:1`、secondary 7.0:1、tertiary 4.9:1、暗色 accent-bg 白字 4.6:1），调整后保持 ≥ 4.5:1 的验收基线；
- **换色残点清单**：`--px-chart-1`（L1 硬编码 `#C00F28`）+ L2 亮块 3 处 `rgba(192,15,40,…)`（`--px-accent-ring` / `--px-selection-bg` / `--px-shadow-accent`）必须一起改，否则残留旧品牌红；
- **禁手改 `app.css`**（`@theme` 块是同步产物）；**Preflight 未启用**（P7 前新增样式要显式声明 bg/border/padding）；
- 全部改完跑 `ui-visual-verification`（Playwright 亮暗截图对照 demo）收尾。

---

*配套阅读：[readus/CHANGELOG.md](./CHANGELOG.md) v2.0.0 条目（本次重构全记录）｜ [AGENTS.md](../AGENTS.md)「样式事实源」节（团队铁律）。*
