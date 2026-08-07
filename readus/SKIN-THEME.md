# 皮肤切换功能说明（v2.1.0）

> 本文档定位：**皮肤（外观风格）切换功能**的完整说明——功能是什么、入口在哪、数据怎么流、接口有哪些、未来如何新增一套皮肤。配套阅读：`readus/UI-ARCHITECTURE.md`（前端架构）、`design/DESIGN-SYSTEM.md`（设计系统）、`readus/CHANGELOG.md`（变更记录）。

---

## 一、功能概述

**皮肤（Skin）= 前端整套视觉风格**，与「明暗模式」是两个正交维度：

| 维度 | 属性 | 可选值 | 持久化 |
|------|------|--------|--------|
| 明暗 | `data-theme` | `light` / `dark` | 设备级（localStorage `projectx-theme`） |
| 皮肤 | `data-skin` | `flat`（默认，明澈 Flat 2.0）· 未来新增 | **账号级**（users 表 `theme_skin`，换设备自动恢复） |

- **当前仅有一套皮肤**：`flat`（明澈 Flat 2.0，项目默认设计系统）。皮肤选择器中的「更多皮肤 · 开发中」为禁用占位项。
- **默认皮肤不设 `data-skin` 属性**（零污染）：只有选择了非默认皮肤，`<html>` 上才会出现 `data-skin="xxx"`，由 `theme/tokens.css` 的 `[data-skin="xxx"]` 覆盖块接管整套 L2 语义令牌。
- 皮肤切换入口（4 处）：

| 入口 | 位置 | 说明 |
|------|------|------|
| 登录页 | 卡片右上角 Palette 按钮 | 未登录即可切换（自管模式，直接写 localStorage），登录后保留 |
| 侧栏底部 | 导航栏底部 Palette 按钮 | 替换了原 Sun/Moon 一键按钮，菜单内含「皮肤 + 明暗」两组 |
| 页头 | 右上角 Palette 按钮（≥lg 屏） | 同上 |
| 账号设置 | 「客户端设置」Tab → 「外观 / 皮肤」区 | 皮肤 + 明暗分段选择，即时生效 |

菜单结构（`components/SkinSwitcher.tsx`）：

```
┌ 外观 · 皮肤 ──────────────┐
│ ◉ 明澈 Flat 2.0（默认风格） │ ← 皮肤组（Checkbox 勾选当前）
│ 🔒 更多皮肤 · 开发中        │ ← 禁用占位
│ ────────────────────────── │
│ 明暗                        │
│ (•) 亮色  ( ) 暗色         │ ← 明暗组（Radio，复用既有 theme 状态）
└────────────────────────────┘
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

### 同步策略（App.tsx 两个 effect）

1. **登录后同步**（`user` 变化时）：
   - 本地 localStorage 已有显式皮肤选择 → **本地优先**，保留本地值（覆盖「登录页选的皮肤登录后保留」场景），由第 2 个 effect 负责回写后端；
   - 本地无选择（新设备/清缓存）→ 应用账号 `themeSkin` 并写入 localStorage（**换设备恢复账号偏好**）。
2. **皮肤变更 → 回写账号**（`skin` 变化时）：已登录且 `skin ≠ user.themeSkin` 时自动 `PATCH /api/users/me/settings`，fire-and-forget，离线/失败静默不打扰。

> 设计决策：**皮肤（风格）走账号级**，**明暗（theme）保持设备级**（沿用既有 `projectx-theme` 机制，不落库）。原因：明暗是设备使用习惯，皮肤是身份偏好；如需明暗也跨设备同步，可扩展 `theme_skin` 存组合值或新增字段，见 §五。

---

## 三、前端实现

| 文件 | 职责 |
|------|------|
| `client/components/SkinSwitcher.tsx` | 皮肤切换器组件：`SKIN_OPTIONS` 皮肤注册表、`DEFAULT_SKIN`、受控/自管双模式 |
| `client/App.tsx` | `skin` state（localStorage `projectx-skin` 初始化）、`data-skin` 同步 effect、登录同步 effect、皮肤回写 effect；侧栏/页头替换原 Sun/Moon 按钮 |
| `client/WorkspaceContext.tsx` | `WorkspaceValue` 增加 `skin` / `setSkin`（与 `theme` / `setTheme` 并列下发） |
| `client/auth/types.ts` | `AuthUser.themeSkin?: string` |
| `client/components/LoginPage.tsx` | 登录页皮肤入口（自管模式，WorkspaceProvider 之外） |
| `client/pages/AccountSettingsPage.tsx` | 「客户端设置」Tab →「外观 / 皮肤」区（SegmentedControl 亮/暗 + SkinSwitcher） |
| `client/main.tsx` / `main-scanner.tsx` | 渲染前预置 `data-skin`（读 `projectx-skin`，非 `flat` 才设置，防白闪） |
| `client/ScannerApp.tsx` | 登录后应用账号 `themeSkin`（与 web 端一致；扫描端不提供切换按钮） |
| `client/components/ui/v2/chart.tsx` | MutationObserver `attributeFilter` 已含 `data-skin`，未来皮肤切换图表自动重绘 |
| `client/theme/tokens.css` | 头部注释区新增「皮肤扩展规约」（无新规则） |

**关键机制**：
- 皮肤状态单一来源 = App 顶层 `useState`（受控模式）；登录页用自管模式直写 `localStorage["projectx-skin"]` + `data-skin`，登录后由 App 接管（两处读写同一 localStorage key，天然一致）。
- `data-skin` 默认不出现 → 现有用户零迁移、零样式影响。

---

## 四、后端实现与 API

### 数据模型

- `users.theme_skin`（TEXT，默认 `'flat'`）：皮肤 ID。字符串不枚举，为未来皮肤留空间。
- 迁移：SQLite `migrations.ts` **v33 `user-theme-skin`**（`addColumnIfMissing` 幂等）；MariaDB `mysql.ts` `mariadbMigrations` v33（`ALTER TABLE users ADD COLUMN theme_skin VARCHAR(32) DEFAULT 'flat'`）；三份建表 SQL（`schema.sql` / `schema.mariadb.sql` / `schema.mysql.sql`）同步加列。
  - 存量 SQLite 库：启动时自动补齐 v33（已用 `data/projectx.db` 实测通过）。
- 校验：`UpdateUserSettingsSchema.themeSkin` = `z.string().min(1).max(32).optional()`（空串 / 超长 400 拒绝）。

### API 一览

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/auth/me` | 返回 `themeSkin`（默认 `"flat"`），登录/刷新后前端首个拉取点 |
| POST | `/api/auth/login` | 响应 `user` 对象自带 `theme_skin`（`SELECT u.*`），字段名 `themeSkin` |
| GET | `/api/users/me/settings` | 返回 `themeSkin` |
| PATCH | `/api/users/me/settings` | body `{ "themeSkin": "flat" }` 更新（其余字段不受影响） |

请求示例：

```bash
# 更新皮肤偏好
curl -X PATCH http://<host>:5174/api/users/me/settings \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"themeSkin":"flat"}'

# 读取
curl http://<host>:5174/api/users/me/settings -H "Authorization: Bearer <token>"
# → { "scoreDisplayMode": ..., "themeSkin": "flat", ... }
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

---

## 六、FAQ

**Q：为什么默认皮肤不设 `data-skin` 属性？**
A：保持与 PR #221 之前的 DOM 完全一致，现有用户与既有样式零迁移、零风险；只有非默认皮肤才需要属性选择器接管。

**Q：登录页选的皮肤登录后会保留吗？**
A：会。登录页自管模式写入 localStorage；登录后 App 的「登录后同步」effect 判定本地有显式选择 → 本地优先保留，并自动回写账号。

**Q：换一台设备登录，皮肤会恢复吗？**
A：会。新设备 localStorage 无记录 → 应用账号 `themeSkin`。

**Q：明暗模式为什么不一起存账号？**
A：设计决策——皮肤（风格）是身份偏好走账号级；明暗是设备使用习惯，沿用设备级 `projectx-theme`。如需改变，可在 `theme_skin` 存组合值（如 `flat-dark`）或新增列，前端 `App.tsx` 两个同步 effect 稍作扩展即可。

**Q：扫描端（scanner）能切换皮肤吗？**
A：扫描端不提供切换按钮（工作台场景），但登录后会应用账号皮肤偏好；`main-scanner.tsx` 同样预置 `data-skin` 防白闪。

**Q：皮肤切换后图表/打印预览会受影响吗？**
A：图表经 `useChartTheme` 实时读 CSS 变量并监听 `data-skin` 自动重绘；答题卡纸面走 `--px-paper-*` 语义（纸面恒白，ADR-6），除非皮肤块显式覆盖，否则打印预览保持白纸。
