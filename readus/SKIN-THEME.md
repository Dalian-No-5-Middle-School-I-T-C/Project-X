# 皮肤切换功能说明（v2.1.0 / v2.3.0 默认皮肤=纸锋）

> 本文档定位：**皮肤（外观风格）切换功能**的完整说明——功能是什么、入口在哪、数据怎么流、接口有哪些、未来如何新增一套皮肤。配套阅读：`readus/UI-ARCHITECTURE.md`（前端架构）、`design/DESIGN-SYSTEM.md`（设计系统）、`readus/CHANGELOG.md`（变更记录）。

---

## 一、功能概述

**皮肤（Skin）= 前端整套视觉风格**，与「明暗模式」是两个正交维度：

| 维度 | 属性 | 可选值 | 持久化 |
|------|------|--------|--------|
| 明暗 | `data-theme` | `light` / `dark` | 设备级（localStorage `projectx-theme`） |
| 皮肤 | `data-skin` | `paper-edge`（默认，纸锋 Paper Edge）· `flat`（明澈 Flat 2.0） | **账号级**（users 表 `theme_skin`，换设备自动恢复） |

- **现有两套皮肤**：
  - `paper-edge`（纸锋 Paper Edge，v2.3.0 起为**默认皮肤**）——设计来源 `demo-brutalist.html`（editorial-brutalist 技能）：纸面米底 #F1EFE9、墨色文字阶、品牌亮蓝 #2E44FF 替换默认绯红 accent；卡片/输入/表格直角 + 按钮/徽章胶囊；**纸纹网格**（`.paper-grid`，64px 浅网格铺内容区）、**硬偏移阴影仅 2 张重点卡**（登录卡 + 分数段分布卡，`.brutal-hard` → `--px-shadow-hard`）、**扫描台荧光绿状态点**（`--px-lime` / `--px-lime-strong`，`.scan-lime`）；状态语义重映射（已完成→蓝软族 / 阅卷中→墨描边族 / 异常→绯红族 / 信息→实蓝族）；图表单色纪律（chart-1 蓝 = 当前主体，绯红仅异常）。
  - `flat`（明澈 Flat 2.0，v2.3.0 前为默认设计系统）。
- **默认皮肤也设 `data-skin` 属性**：默认 `paper-edge` 的 CSS 覆盖块依赖 `[data-skin="paper-edge"]` 属性选择器，故 `<html>` 上始终出现 `data-skin`（默认纸锋；显式选 flat 时为 `data-skin="flat"`，无覆盖块回退 `:root` 明澈基准）。
- 皮肤切换入口（2 处）：

| 入口 | 位置 | 说明 |
|------|------|------|
| 登录页 | 卡片右上角 Palette 按钮 | 未登录即可切换（自管模式，直接写 localStorage），登录后保留 |
| 账号设置 | 「客户端设置」Tab → 「外观 / 皮肤」区 | **应用内唯一入口**：皮肤 + 明暗分段选择，即时生效 |

> **入口收敛说明（本版回退）**：v2.1.0 曾在「侧栏底部」与「页头」放置皮肤菜单（Palette 按钮），本版已回退——这两处恢复为原先的**暗色模式一键按钮（Sun/Moon）**，仅切换明暗（设备级 `projectx-theme` / `data-theme`），不再承载皮肤选择。皮肤切换因此收敛为上述两处（登录页自管 + 账号设置受控）。

**首次强制引导层（新增）**：首次进入登录页前（`localStorage["projectx-skin-onboarded"]` 缺失的设备级一次性标志），先弹出全屏引导层（`components/SkinOnboarding.tsx`），**明澈 / 纸锋两张大预览卡并排、带简介、必须二选一**——初始无预选、确认按钮禁用，点选其一后才可「进入登录」。确认时写入 sessionStorage `projectx-skin-chosen`（走登录同步 effect 的本地优先分支，登录后保留选择）+ 自管落盘 `projectx-skin` / `data-skin`（复用 `writeLocalSkin`）+ 写一次性 `onboarded` 标志。该引导仅覆盖未登录态（登录后登录页卸载），与登录页右上角 `SkinSwitcher` 自管入口并存（后者为登录前的备用切换）。

菜单结构（`components/SkinSwitcher.tsx`）：

```
┌ 外观 · 皮肤 ───────────────────────┐
│ (•) 纸锋 Paper Edge  默认·纸面墨蓝   │ ← 皮肤组（Radio 单选 + 描述小字）
│ ( ) 明澈 Flat 2.0    可选·白底绯红   │
│ ────────────────────────────────── │
│ 明暗                                 │
│ (•) 亮色  ( ) 暗色                  │ ← 明暗组（Radio，复用既有 theme 状态）
└─────────────────────────────────────┘
```

---

## 二、数据流

```
┌─────────────┐  切换皮肤    ┌──────────────────────┐
│ SkinSwitcher│───────────▶ │ App.tsx 顶层 skin 状态 │
└─────────────┘             │ + localStorage         │
                            │ + documentElement      │
                            └──────────┬─────────────┘
                                       │ 已登录时（effect 自动）
                                       ▼
                        PATCH /api/users/me/settings
                        { themeSkin: "flat" }  ← 账号级持久化
                                       │
                        GET /api/auth/me（登录 / 刷新时）
                        { themeSkin: "flat" }  ← 下发
```

### 同步策略（v2.3.0：会话内显式选择标记 + 账号权威）

皮肤状态单一来源 = App 顶层 `skin` state；「显式选择」与「默认值落盘」通过 sessionStorage 标记区分：

1. **显式选择标记**（`SkinSwitcher`）：任何一次切换（登录页/账号设置页，含选择默认皮肤值）都会写入 sessionStorage `projectx-skin-chosen`；**登出/会话失效时由 AuthContext 清除**。localStorage `projectx-skin` 仅作跨会话登录页记忆与防白闪。
2. **登录后同步**（App.tsx，`user` 变化时）：
   - sessionStorage 有「显式选择」标记 → **本地优先**（「登录页选的皮肤登录后保留」），由第 3 条 effect 回写账号；
   - 无标记（未显式选择过）→ **账号为权威**：应用账号 `themeSkin`（换设备恢复账号偏好；老账号 `theme_skin='flat'` 保持 flat，不被新默认覆盖）。
3. **皮肤变更 → 回写账号**（`skin` 变化时）：已登录且 `skin ≠ user.themeSkin` 时自动 `PATCH /api/users/me/settings`，fire-and-forget，离线/失败静默不打扰。
4. **共享设备**：A 登出清除标记 → B 登录无标记 → 应用 B 的账号偏好，不继承 A 的皮肤、不覆盖 B 的账号记录。

> 设计决策：**皮肤（风格）走账号级**，**明暗（theme）保持设备级**（沿用既有 `projectx-theme` 机制，不落库）。原因：明暗是设备使用习惯，皮肤是身份偏好；如需明暗也跨设备同步，可扩展 `theme_skin` 存组合值或新增字段，见 §五。

---

## 三、前端实现

| 文件 | 职责 |
|------|------|
| `client/components/SkinSwitcher.tsx` | 皮肤切换器组件：`SKIN_OPTIONS` 皮肤注册表、`DEFAULT_SKIN`（v2.3.0 = `paper-edge`）、`SKIN_CHOSEN_KEY`（sessionStorage 显式选择标记）、受控/自管双模式；皮肤组为 Radio 单选 + 描述小字展示 |
| `client/App.tsx` | `skin` state（localStorage `projectx-skin` 初始化）、`data-skin` 同步 effect（始终落盘 + 设置）、登录同步 effect（chosen 标记优先，否则账号权威）、皮肤回写 effect；侧栏底部与页头为**暗色模式一键按钮（Sun/Moon，仅切明暗）**，皮肤切换不在此两处 |
| `client/WorkspaceContext.tsx` | `WorkspaceValue` 增加 `skin` / `setSkin`（与 `theme` / `setTheme` 并列下发） |
| `client/auth/AuthContext.tsx` | 登录/me 响应统一归一化为 `themeSkin`；登出与会话失效时清除 `projectx-skin-chosen` |
| `client/auth/types.ts` | `AuthUser.themeSkin?: string` |
| `client/components/LoginPage.tsx` | 登录页皮肤入口（自管模式，WorkspaceProvider 之外）；首次引导层 `SkinOnboarding` 挂载点（`showOnboarding` state 由 `shouldShowSkinOnboarding()` 初始化） |
| `client/components/SkinOnboarding.tsx` | 首次登录前强制引导层：明澈 / 纸锋预览卡二选一（无默认），确认时写 `projectx-skin-chosen` + `writeLocalSkin` + `projectx-skin-onboarded` 一次性标志；纯语义令牌，无手写 CSS |
| `client/pages/AccountSettingsPage.tsx` | 「客户端设置」Tab →「外观 / 皮肤」区（SegmentedControl 亮/暗 + SkinSwitcher）；明暗文案标注「设备级偏好」 |
| `client/main.tsx` / `main-scanner.tsx` | 渲染前预置 `data-skin`（读 `projectx-skin`，有记录即设置，防白闪） |
| `client/ScannerApp.tsx` | 登录页/登录后按本地或账号 `themeSkin` 落盘 + 设 `data-skin`（账号 flat 显式写入覆盖残留，换账号不继承）；不提供切换按钮 |
| `client/components/ui/v2/chart.tsx` | MutationObserver `attributeFilter` 已含 `data-skin`，皮肤切换图表自动重绘 |
| `client/theme/tokens.css` | L1 加 `--px-font-serif`；L2 加 `--px-shadow-hard`；paper-edge 块加 `--px-lime`/`--px-lime-strong`、焦点环单条、`--px-fg-tertiary` 对比度 ≥4.5:1；作用域规则 ⑩-⑭（纸纹/硬影/荧光绿/弹层/区标题） |

**关键机制**：
- 皮肤状态单一来源 = App 顶层 `useState`（受控模式）；登录页用自管模式直写 `localStorage["projectx-skin"]` + `data-skin`，登录后由 App 接管（两处读写同一 localStorage key，天然一致）。
- 显式选择 = sessionStorage `projectx-skin-chosen`（登出清除），与 localStorage 记忆解耦，保证「登录页选择登录后保留」且不跨账号继承。
- 老账号（`theme_skin='flat'`）与老库（v33 迁移已应用、列默认 `'flat'`、新注册用户默认 flat）：**不迁移**，保持 flat 直至手动切换（v2.3.0 拍板）；仅新安装（schema 默认 `'paper-edge'`）与新装前端开箱即纸锋。

---

## 四、后端实现与 API

### 数据模型

- `users.theme_skin`（TEXT，默认 `'paper-edge'`，v2.3.0 起）：皮肤 ID。字符串不枚举，为未来皮肤留空间。存量库不迁移（老账号保持 flat，见 §三 关键机制）。
- 迁移：SQLite `migrations.ts` **v33 `user-theme-skin`**（`addColumnIfMissing` 幂等）；MariaDB `mysql.ts` `mariadbMigrations` v33（`ALTER TABLE users ADD COLUMN theme_skin VARCHAR(32) DEFAULT 'flat'`）；三份建表 SQL（`schema.sql` / `schema.mariadb.sql` / `schema.mysql.sql`）同步加列。
  - 存量 SQLite 库：启动时自动补齐 v33（已用 `data/projectx.db` 实测通过）。
- 校验：`UpdateUserSettingsSchema.themeSkin` = `z.string().min(1).max(32).optional()`（空串 / 超长 400 拒绝）。

### API 一览

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/auth/me` | 返回 `themeSkin`（默认 `"paper-edge"`），登录/刷新后前端首个拉取点 |
| POST | `/api/auth/login` | 响应 `user` 对象自带 `theme_skin`（`SELECT u.*`），字段名 `themeSkin` |
| GET | `/api/users/me/settings` | 返回 `themeSkin` |
| PATCH | `/api/users/me/settings` | body `{ "themeSkin": "paper-edge" }` 更新（其余字段不受影响） |

请求示例：

```bash
# 更新皮肤偏好
curl -X PATCH http://<host>:5174/api/users/me/settings \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"themeSkin":"paper-edge"}'

# 读取
curl http://<host>:5174/api/users/me/settings -H "Authorization: Bearer <token>"
# → { "scoreDisplayMode": ..., "themeSkin": "paper-edge", ... }
```

---

## 五、扩展指南：如何新增一套皮肤

新增一套皮肤 = 纯令牌覆盖 + 一处注册，组件与业务代码**零改动**。分 5 步：

1. **设计令牌**（`client/theme/tokens.css`，也是 `design/tokens/tokens.css` 的镜像源，两处需同步）：
   - 在文件末尾追加 `[data-skin="xxx"] { … }` 覆盖 L2 语义令牌：`--px-bg-*`（底色 4 级）、`--px-fg-*`（文字 4 级）、`--px-border-*`（边框 3 级）、`--px-accent-*`（品牌强调全套）、`--px-shadow-*`（阴影）、`--px-focus-ring`、`--px-selection-bg`；如需更圆/更方的形态覆盖 L3（如 `--px-radius-*`、`--px-control-h-*`）。
   - 追加 `[data-skin="xxx"][data-theme="dark"] { … }` 提供暗色覆盖（提亮 accent 档，正文对比度 ≥ 4.5:1，参考现有 dark 块原则）。
   - **CSS 特异性要点**：皮肤覆盖块必须写在 `[data-theme="dark"]` 块**之后**，暗色组合用双属性选择器 `[data-skin="xxx"][data-theme="dark"]`（特异性 (0,2,0) 恒胜），否则明暗会互相覆盖。
2. **注册皮肤**（`client/components/SkinSwitcher.tsx`）：在 `SKIN_OPTIONS` 数组加一项 `{ id: "xxx", label: "皮肤名", description: "一句话风格说明" }`——菜单、登录页、设置页自动出现该选项。
3. **图表跟随**：`chart.tsx` 的 MutationObserver 已监听 `data-skin`，无需改动（调色板运行时读 CSS 变量，`--px-chart-1` 若被皮肤块覆盖则图表色自动跟随）。
4. **防白闪**：`main.tsx` / `main-scanner.tsx` 已按 `projectx-skin` 预置 `data-skin`，无需改动。
5. **文档同步**：本文件「皮肤清单」一节登记；`design/DESIGN-SYSTEM.md` 的 §3 记录用途（可复现规约：L1 建档 → L2 指派语义 → 文档记录）。

> 注意：新增皮肤**不允许**引入新 CSS 文件或组件内手写样式（AGENTS.md 铁律）。全部差异必须落在 tokens.css 的 `[data-skin]` 覆盖块内；若某套风格需要组件结构变化（而非令牌可表达），说明该风格不适合走皮肤机制，需单独评审。
>
> **已评审豁免案例（纸锋 paper-edge，v2.3.0；2026-08 直角化修订 + 排版轻升级）**：纸锋皮肤块末尾含一组作用域规则（17 组），用于复刻 demo 的组件观感纪律——这些差异无法由纯令牌表达。规则全部以 `[data-skin="paper-edge"]` 限定作用域、不新建 CSS 文件、不改组件代码，默认皮肤零影响（纸锋为默认时其余皮肤零影响）：
>
> 1. **胶囊圆角命中面**：仅 Button 组件（`button[class~="rounded-md"][class~="whitespace-nowrap"]`，cva 基类特征）保留胶囊；徽章、分段选项、选项卡、计数徽标 2026-08 起一律直角方块（与卡片直角语言统一）。**注意一律用整词匹配 `[class~=]`**：子串匹配 `[class*=]` 会误命中 `data-[state=active]:after:bg-primary` 这类带 variant 前缀的工具类（曾导致选项卡全部被主按钮规则染墨）；
> 2. **按钮观感**（demo `.btn` 纪律）：字重 700；主按钮墨底纸字、hover 转蓝（暗色下保持蓝底白字）；描边按钮墨描边、hover 墨底；原生角色控件（checkbox/radio/switch）显式排除；
> 3. **选项卡**：下划线式改为独立细线描边**方块**组（2026-08 由胶囊改直角），选中墨底纸字；`[role="tablist"]` 加 `padding-block: 10px` 呼吸位，方块上下缘不贴标签栏分隔线/容器边缘；
> 4. **分段控件**：容器槽透明化（无槽独立描边**方块**，按 `bg-secondary` 类特征区分设置页单选组，不误伤），选中项墨底纸字；2026-08 修正命中面——实际基座是 Radix ToggleGroup（`role="group"`），原 `role="radiogroup"` 选择器从未命中，现两者并列兜底；
> 5. **进度条**（demo `.prog`）：`[role="progressbar"]` 轨道与填充直角；
> 6. **统计大数字**（demo `.stat .v`）：800 重 + 紧缩字距；
> 7. **纸纹网格**（demo `.paper-grid`）：`.paper-grid` 工具类复刻 64px 浅网格（repeating-linear-gradient），挂载到 AppShell 根 / 登录页根 / 扫描工作台 main；卡片与弹层有自身底色，自然无网格；
> 8. **重点卡硬阴影**（demo `.login-card` / `.panel`）：`.brutal-hard` → `--px-shadow-hard`（纸锋下 `8px 8px 0`），仅登录卡 + 分数段分布卡 2 落点；`[class~="shadow-4"]`（dialog/sheet）归零并给 dialog 补墨边（demo modal 纪律）；
> 9. **扫描台荧光绿**（demo `.dot--lime`）：`.scan-lime` 命中 Badge 前置状态点（`> span`），`--px-lime-strong`（亮底橄榄绿 / 暗底荧光绿），仅「服务器可达」与识别通过状态点 2 处；
> 10. **区标题排印**（demo `.sec h2`）：`h2` 900 重 + `-0.02em` 字距（行高不动，防中文长标题挤压）；
> 11. **徽章直角 + 档位三族重映射**（2026-08 评审）：`span[class~="rounded-full"][class~="tabular-nums"]` 归零圆角（BandBadge / TabsCount；内部状态点无 `tabular-nums`，保持圆形）；`MetricBadge.tsx` 在纸锋下将服务端档位色按档位位置重映射——最优档→蓝软族、最差档→绯红描边族、中间档→墨描边族（守住单色纪律；其余皮肤仍用服务端色）。此为豁免中唯一一处组件代码改动（行内色值无法被 CSS 覆盖），已用 MutationObserver 跟随 `data-skin` 运行时切换。
> 12. **页头眉题 + 表格/数据带**（2026-08 排版轻升级，纯 CSS）：⑯ `[class~="h-page-header"] h1` 900 重 + `-0.01em` 字距（与 ⑭ h2 同族），`h1 + span` 副标题首次启用 `--px-font-mono` 等宽体 + `0.1em` 字距 + `uppercase`（**不加蓝调**，保持原 `text-muted-foreground` 灰调；2026-08 用户反馈眉题蓝字与正文对比过强）；⑰ `th[class~="h-table-header"]` 仅加字重 500 + `0.06em` 字距 + 等宽体 + `uppercase`，**不反转底色**（2026-08 用户反馈墨底表头太突兀，保持浅底灰字）；⑱ `tbody tr:not([data-selected]):nth-child(even)` 轻纸底斑马纹（selected 异常卷行经 `data-selected` 排除，hover 特异性 (0,2,0) 自然覆盖）。命中面全部整词匹配 `[class~=]`，`h-page-header` 全项目仅 PageHeader 一处含 h1，其余页面 h1 零误伤。
>>
>> **取消的尝试**（2026-08 评审未通过）：⑲ 深色状态栏 + 表头墨底反转 + 副标题蓝调——首版落地后用户反馈视觉突兀（深底状态栏与米纸整体脱节；表头墨底反转破坏轻量表格观感；蓝调副标题与正文层级混乱）。已删除 ⑲ 整块与 7 个 `--px-statusbar-*` 令牌，⑰ 改回仅字重字距等宽，⑯ 去掉 `color: var(--px-accent-fg)`。
>
> 后续皮肤如需类似豁免，须同样在此登记评审。

---

## 六、FAQ

**Q：为什么默认皮肤也设 `data-skin` 属性？**
A：v2.3.0 起默认皮肤为 `paper-edge`，其 CSS 覆盖块依赖 `[data-skin="paper-edge"]` 属性选择器生效，故 `<html>` 上始终带 `data-skin`（默认纸锋；显式选 flat 时为 `data-skin="flat"`，无覆盖块回退 `:root` 明澈基准）。v2.1.0–v2.2.x「默认 flat 不设属性（与 PR #221 前 DOM 一致）」的约定随默认皮肤变更退出。

**Q：首次进入为什么必须选皮肤？**
A：首次登录前（`projectx-skin-onboarded` 标志缺失）弹出全屏引导层，明澈 / 纸锋带预览二选一、无默认预选，确认后方可进入登录页。这是设备级一次性引导（清 localStorage 后会再次弹出）；选完写入 `projectx-skin-chosen` 标记，登录后按本地优先保留，同时记 onboarded 标志避免重复弹窗。登录后仍可经右上角 `SkinSwitcher` 或账号设置随时改回。

**Q：登录页选的皮肤登录后会保留吗？**
A：会。登录页切换会写入 sessionStorage `projectx-skin-chosen` 标记；登录后该标记存在 → 本地优先，并自动回写账号。未显式选择过（全新用户/换设备）→ 应用账号偏好。

**Q：换一台设备登录，皮肤会恢复吗？**
A：会。新设备无「本会话显式选择」标记 → 应用账号 `themeSkin`（老账号 flat 保持 flat；新账号默认 paper-edge）。

**Q：共享设备上 A 登出后 B 登录，会继承 A 的皮肤吗？**
A：不会。登出/会话失效时清除 `projectx-skin-chosen`，B 登录以 B 的账号偏好为准；A 的本地选择也不会被 PATCH 覆盖到 B 的账号。

**Q：明暗模式为什么不一起存账号？**
A：设计决策——皮肤（风格）是身份偏好走账号级；明暗是设备使用习惯，沿用设备级 `projectx-theme`（账号设置页文案已标注「明暗为设备级偏好」）。如需改变，可在 `theme_skin` 存组合值（如 `flat-dark`）或新增列，前端 `App.tsx` 两个同步 effect 稍作扩展即可。

**Q：扫描端（scanner）能切换皮肤吗？**
A：扫描端不提供切换按钮（工作台场景），但登录页/登录后按本地记录或账号 `themeSkin` 设置 `data-skin`（账号为 flat 时显式写入覆盖上一账号残留），换账号登录不会继承旧皮肤。

**Q：皮肤切换后图表/打印预览会受影响吗？**
A：图表经 `useChartTheme` 实时读 CSS 变量并监听 `data-skin` 自动重绘；答题卡纸面走 `--px-paper-*` 语义（纸面恒白，ADR-6），除非皮肤块显式覆盖，否则打印预览保持白纸。

---

## 七、已知差异与声明（v2.3.0）

- **全局暗色主题保留**：demo 刻意移除全局 `[data-theme]` 暗色（深色仅 `.sec-dark` 区块出现），产品保留「皮肤 ⊥ 明暗」架构（`[data-skin="paper-edge"][data-theme="dark"]` 全局暗色）——有意扩展，非缺陷。
- **lime 扫描进度 fill 无对应组件**：demo 的荧光绿「扫描进度条」在产品中无对应组件（应用扫描进度为确定性文本/Spinner），荧光绿仅落地为状态点（`.scan-lime`）。
- **侧栏自动展开默认值变更**（v2.1.0 随皮肤 PR 引入）：`projectx-rail-auto-expand` 默认由开启改为关闭（避免鼠标扫过侧栏边缘即展开）+ 展开增加 200ms 延时——有意行为（代码注释佐证），在此声明，不回滚。
- **快捷建卡修复夹带**（commit `a5b6c34`）：「快捷创建答题卡时补充必填字段并处理失败提示」与皮肤功能无关但同批提交——已提交不可拆历史，在此声明。
