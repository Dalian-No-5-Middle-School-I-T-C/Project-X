# 扫描端换肤入口（Scanner Skin Switch）设计文档

- 日期：2026-08-25
- 分支：`feat/scanner-skin-switch`（基于 `fix/issue-257-designer-visual` @ 618a56a）
- 目标版本：**v2.5.0**（小版本号递增；当前 package.json 为 2.4.1）

## 一、背景与问题

扫描端（scanner 构建，打包进 Electron 桌面应用）在 v2.4.1（commit 7103440，#252）引入了
"首次进入强制选肤"引导层（`SkinOnboarding`），但存在以下问题：

1. **一次性标志锁死引导层**：`localStorage["projectx-skin-onboarded"] === "1"` 后引导层永不复现；
2. **全程零切换入口**：`LoginPageScanner` 没有 web 登录页右上角的调色盘按钮；
   `CardSelectPage` / `ScannerWorkspace` 也未引用任何皮肤组件；scanner 构建 tree-shake
   掉了唯一受控换肤入口 `AccountSettingsPage`；
3. **官方"后悔药"不可达**：引导层 footerNote 指向"教师端网页的账号设置"，对只在机房使用
   扫描端的操作员等于不可达。

结果：用户初次选定皮肤后无法再更改。本设计推翻 `readus/SKIN-THEME.md:90` 与 §六 FAQ
中"扫描端不提供切换按钮"的旧决策。

## 二、目标与非目标

**目标**
- 扫描端登录页右上角提供换肤按钮（自管模式，与 web 登录页一致）。
- 已登录的两个页面（`CardSelectPage`、`ScannerWorkspace`）顶栏右侧提供受控换肤按钮。
- 切换即时生效，并沿用现有管线落盘 + 同步到账号偏好。
- 版本号升至 v2.5.0，更新 CHANGELOG 与 README 徽章。

**非目标**
- 明暗主题（`data-theme`）不在本次范围（正交维度）。
- 不改 `SkinSwitcher` 组件本体、不新增皮肤、不改后端 API/数据库。

## 三、方案选型

采用**方案 A：受控下发**（已与需求方确认）：

- `ScannerApp` 将已有的 `skin` state 与 `setSkin` 作为可选 props 下发给两个页面，
  页面内渲染受控模式 `<SkinSwitcher skin={skin} onSkinChange={...} />`。
- 备选的"自管模式铺开"被否决：绕过 ScannerApp state 导致账号偏好要等下次登录才同步，
  且与 web 端"设置页用受控模式"惯例不一致。
- 备选的 Portal 插槽注入被否决：过度设计，组件边界模糊。

## 四、数据流（全部复用现有管线，零后端改动）

- **工作台内切换**：`setSkin` → 现有 effect 落盘 localStorage(`projectx-skin`) +
  设 `document.documentElement.dataset.skin` → 现有 effect fire-and-forget
  `PATCH /api/users/me/settings { themeSkin }` → 后端照旧写审计表 `theme_change_events`。
- **登录页切换**（未登录）：自管模式写 localStorage + sessionStorage(`projectx-skin-chosen`)
  → 登录时按现有语义本地优先，随后自动 PATCH 到账号。
- 未来新增皮肤只需在 `SKIN_OPTIONS` 注册表登记，扫描端自动出现，组件零改动。

## 五、改动清单（5 个文件，均为前端/文档）

| 文件 | 改动 |
|---|---|
| `src/apps/answer-card/client/ScannerApp.tsx` | 给 `CardSelectPage`/`ScannerWorkspace` 传 `skin` + `onSkinChange` props；改 onboarding `footerNote` 文案为「如需更改皮肤，可随时在登录页右上角的调色盘按钮切换；登录后也可在各页面顶栏右侧切换。」 |
| `src/apps/answer-card/client/components/CardSelectPage.tsx` | 新增可选 props `skin?`/`onSkinChange?`，顶栏右侧（`ml-auto` 容器）条件渲染受控 `<SkinSwitcher>` |
| `src/apps/answer-card/client/components/ScannerWorkspace.tsx` | 同上 |
| `src/apps/answer-card/client/components/LoginPageScanner.tsx` | 右上角渲染自管 `<SkinSwitcher />`（无 props），定位方式复用 web `LoginPage.tsx:58` 的写法 |
| `readus/SKIN-THEME.md` | 更新 L90 入口清单与 §六 FAQ：扫描端提供双入口 |

**版本发布面（v2.5.0）**

| 文件 | 改动 |
|---|---|
| `package.json` | version → 2.5.0 |
| `package-lock.json` | 同步两处 version 字段（仓库惯例） |
| `README.md` | L4 版本徽章 → 2.5.0 |
| `readus/CHANGELOG.md` | 新增 `## v2.5.0` 条目（日期取合入日实际日期），说明扫描端双入口换肤 |

## 六、错误处理

- PATCH `/api/users/me/settings` 失败静默（现有 catch-ignore，沿用）。
- localStorage/sessionStorage 异常 try-catch（现有写法，沿用）。
- 页面 props 未传时不渲染切换器（向后兼容，两页面仍可独立使用）。

## 七、测试与验证

1. `npm run typecheck` — 0 错误。
2. `npm run build:scanner:full` — scanner 包构建通过，确认 tree-shake 不回归
   （产物不含 AccountSettingsPage/App）。
3. 手动冒烟：
   - 引导层 → 登录页右上角换肤即时生效；
   - 登录后 CardSelectPage / ScannerWorkspace 顶栏换肤即时生效；
   - 刷新后保持所选皮肤；登出重登按既有语义恢复；
   - （环境可用时）web 端「账号设置 → 客户端设置」显示同步后的同值。
