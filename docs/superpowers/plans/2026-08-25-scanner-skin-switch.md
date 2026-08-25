# 扫描端换肤入口（Scanner Skin Switch）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 扫描端在初次选肤引导之后仍可随时换肤——登录页右上角 + 两个已登录页面顶栏右侧提供切换入口，版本升至 v2.5.0。

**Architecture:** 复用 `SkinSwitcher` 组件的既有双模式（受控/自管）。`ScannerApp` 把已有的 `skin` state 与 `setSkin` 作为可选 props 下发给 `CardSelectPage` / `ScannerWorkspace`（受控模式）；`LoginPageScanner` 用无 props 自管模式。持久化、账号同步、审计全部走现有管线，零后端改动。

**Tech Stack:** React 19 + TypeScript + Tailwind 工具类 + 现有 ui/v2 组件桶。

**规格文档:** `docs/superpowers/specs/2026-08-25-scanner-skin-switch-design.md`

---

## 背景速览（给零上下文的执行者）

- 项目是答题卡设计阅卷系统。扫描端 = `vite build --mode scanner` 产物（仅 ScannerApp 子树，打包进 Electron）。
- 皮肤 = `document.documentElement.dataset.skin`（现有 `paper-edge` / `flat` 两套），与明暗 `data-theme` 正交。
- `SkinSwitcher`（`src/apps/answer-card/client/components/SkinSwitcher.tsx`）已支持两种模式：
  - **受控**：传 `skin` + `onSkinChange` → 由父组件 state 驱动；
  - **自管**：不传 props → 组件自己读写 localStorage(`projectx-skin`) + `data-skin`。
- `ScannerApp.tsx:27-70` 已有完整管线：state 初始化、落盘 effect、登录同步 effect、PATCH `/api/users/me/settings` 回写 effect——本计划只补 UI 入口，不动这些 effect。
- 本仓库无组件级单测框架；每个任务的验证门 = `npm run typecheck`（tsc --noEmit）+ 最终 `npm run build:scanner:full`。
- 规范约束（AGENTS.md）：禁止新建 CSS 文件/手写 CSS；组件从 `./ui/v2` 桶具名 import；跟随现有代码风格（文件内有简短中文注释惯例）。
- 工作目录 = 仓库根 `E:\git\Project-X`；分支 `feat/scanner-skin-switch`。

## 文件结构总览

| 动作 | 文件 | 职责 |
|---|---|---|
| Modify | `src/apps/answer-card/client/components/LoginPageScanner.tsx` | 登录页加自管 `<SkinSwitcher />`（右上角） |
| Modify | `src/apps/answer-card/client/components/CardSelectPage.tsx` | 加可选 props + 顶栏右侧受控切换器 |
| Modify | `src/apps/answer-card/client/components/ScannerWorkspace.tsx` | 同上 |
| Modify | `src/apps/answer-card/client/ScannerApp.tsx` | 下发 props + 更新 onboarding footerNote 文案 |
| Modify | `readus/SKIN-THEME.md` | 推翻"扫描端不提供切换按钮"旧决策记录 |
| Modify | `package.json` / `package-lock.json` / `README.md` / `readus/CHANGELOG.md` | v2.5.0 版本发布面 |

不新建任何源码/CSS 文件。

---

### Task 1: LoginPageScanner 自管换肤入口

**Files:**
- Modify: `src/apps/answer-card/client/components/LoginPageScanner.tsx`

- [ ] **Step 1.1: 添加 SkinSwitcher import**

在第 5 行 `import { BeianFooter } from "./BeianFooter";` 之后插入：

```tsx
import { SkinSwitcher } from "./SkinSwitcher";
```

- [ ] **Step 1.2: 根容器加 relative 定位**

将第 114 行：

```tsx
    <div className="flex min-h-[100dvh] w-full flex-col items-center justify-center gap-4 bg-background p-4">
```

改为（仅加 `relative`）：

```tsx
    <div className="relative flex min-h-[100dvh] w-full flex-col items-center justify-center gap-4 bg-background p-4">
```

- [ ] **Step 1.3: 右上角渲染自管 SkinSwitcher**

在第 114 行根 div 开标签之后、第 115 行 `<Card ...>` 之前插入（定位写法对齐 web 端 `LoginPage.tsx:47-59` 的绝对定位容器）：

```tsx
      {/* v2.5.0: 扫描端登录页皮肤入口（自管模式：登录前直接读写 localStorage + data-* 属性；
          登录后由 ScannerApp 接管，会话显式选择优先并同步到账号偏好） */}
      <div className="absolute right-4 top-4 z-10">
        <SkinSwitcher />
      </div>
```

- [ ] **Step 1.4: 类型检查**

Run: `npm run typecheck`
Expected: 退出码 0（无错误输出即成功）

- [ ] **Step 1.5: Commit**

```bash
git add src/apps/answer-card/client/components/LoginPageScanner.tsx
git commit -m "feat(scanner): 登录页右上角新增自管换肤入口"
```

---

### Task 2: CardSelectPage 受控换肤入口

**Files:**
- Modify: `src/apps/answer-card/client/components/CardSelectPage.tsx:30-32,43,161-171`

- [ ] **Step 2.1: 添加 SkinSwitcher import**

在第 6 行 `import { useIsMobile } from "../hooks/useMediaQuery";` 之后插入：

```tsx
import { SkinSwitcher } from "./SkinSwitcher";
```

- [ ] **Step 2.2: Props 接口增加可选字段**

将第 30-32 行：

```tsx
interface Props {
  onSelectCard: (cardId: string) => void;
}
```

改为：

```tsx
interface Props {
  onSelectCard: (cardId: string) => void;
  /** v2.5.0: 受控皮肤（由 ScannerApp 下发；未传时不渲染切换器，保持组件独立可用） */
  skin?: string;
  onSkinChange?: (skin: string) => void;
}
```

- [ ] **Step 2.3: 组件签名解构新 props**

将第 43 行：

```tsx
export function CardSelectPage({ onSelectCard }: Props) {
```

改为：

```tsx
export function CardSelectPage({ onSelectCard, skin, onSkinChange }: Props) {
```

- [ ] **Step 2.4: 顶栏右侧渲染受控 SkinSwitcher**

将第 161-171 行的 header：

```tsx
        <header className="flex min-h-[56px] shrink-0 items-center gap-3 border-b border-border-subtle bg-card px-6 py-3">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-xl font-semibold">
              <ClipboardList size={22} className="shrink-0 text-primary" />
              答题卡扫描端
            </h1>
            <p className="m-0 mt-0.5 text-xs text-muted-foreground">
              选择答题卡或大考组，进入扫描工作台
            </p>
          </div>
        </header>
```

改为（在标题 div 之后追加 `ml-auto` 容器）：

```tsx
        <header className="flex min-h-[56px] shrink-0 items-center gap-3 border-b border-border-subtle bg-card px-6 py-3">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-xl font-semibold">
              <ClipboardList size={22} className="shrink-0 text-primary" />
              答题卡扫描端
            </h1>
            <p className="m-0 mt-0.5 text-xs text-muted-foreground">
              选择答题卡或大考组，进入扫描工作台
            </p>
          </div>
          {skin !== undefined && onSkinChange && (
            <div className="ml-auto flex items-center gap-2">
              <SkinSwitcher skin={skin} onSkinChange={onSkinChange} />
            </div>
          )}
        </header>
```

- [ ] **Step 2.5: 类型检查**

Run: `npm run typecheck`
Expected: 退出码 0

- [ ] **Step 2.6: Commit**

```bash
git add src/apps/answer-card/client/components/CardSelectPage.tsx
git commit -m "feat(scanner): 答题卡选择页顶栏支持受控换肤"
```

---

### Task 3: ScannerWorkspace 受控换肤入口

**Files:**
- Modify: `src/apps/answer-card/client/components/ScannerWorkspace.tsx:14,35-39,50,102-105`

- [ ] **Step 3.1: 添加 SkinSwitcher import**

在第 16 行 `import { ScannerPanel } from "./ScannerPanel";` 之后插入：

```tsx
import { SkinSwitcher } from "./SkinSwitcher";
```

- [ ] **Step 3.2: Props 接口增加可选字段**

将第 35-39 行：

```tsx
interface Props {
  cardId: string;
  cardTitle: string;
  onBack: () => void;
}
```

改为：

```tsx
interface Props {
  cardId: string;
  cardTitle: string;
  onBack: () => void;
  /** v2.5.0: 受控皮肤（由 ScannerApp 下发；未传时不渲染切换器，保持组件独立可用） */
  skin?: string;
  onSkinChange?: (skin: string) => void;
}
```

- [ ] **Step 3.3: 组件签名解构新 props**

将第 50 行：

```tsx
export function ScannerWorkspace({ cardId, cardTitle, onBack }: Props) {
```

改为：

```tsx
export function ScannerWorkspace({ cardId, cardTitle, onBack, skin, onSkinChange }: Props) {
```

- [ ] **Step 3.4: 顶栏右侧渲染受控 SkinSwitcher**

将第 102-105 行的 header：

```tsx
        <header className="flex h-page-header shrink-0 items-center gap-3 border-b border-border-subtle bg-card px-5">
          <Button variant="ghost" size="icon-sm" onClick={onBack} aria-label="返回答题卡列表"><ArrowLeft size={18} /></Button>
          <div className="flex min-w-0 flex-1 flex-col"><strong className="truncate text-base font-semibold">{cardTitle}</strong><span className="truncate text-xs text-muted-foreground">扫描仪直扫或导入图片进行阅卷判分 · ID:{cardId}</span></div>
        </header>
```

改为（标题 div 已有 `flex-1`，追加 `ml-auto` 容器在其后）：

```tsx
        <header className="flex h-page-header shrink-0 items-center gap-3 border-b border-border-subtle bg-card px-5">
          <Button variant="ghost" size="icon-sm" onClick={onBack} aria-label="返回答题卡列表"><ArrowLeft size={18} /></Button>
          <div className="flex min-w-0 flex-1 flex-col"><strong className="truncate text-base font-semibold">{cardTitle}</strong><span className="truncate text-xs text-muted-foreground">扫描仪直扫或导入图片进行阅卷判分 · ID:{cardId}</span></div>
          {skin !== undefined && onSkinChange && (
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <SkinSwitcher skin={skin} onSkinChange={onSkinChange} />
            </div>
          )}
        </header>
```

- [ ] **Step 3.5: 类型检查**

Run: `npm run typecheck`
Expected: 退出码 0

- [ ] **Step 3.6: Commit**

```bash
git add src/apps/answer-card/client/components/ScannerWorkspace.tsx
git commit -m "feat(scanner): 扫描工作台顶栏支持受控换肤"
```

### Task 4: ScannerApp 下发 props + 引导层文案更新

**Files:**
- Modify: `src/apps/answer-card/client/ScannerApp.tsx:90,97-105,107-124`

- [ ] **Step 4.1: 给 CardSelectPage 传受控 props**

将第 107-124 行的 JSX：

```tsx
  return (
    <CardSelectPage
      onSelectCard={(cardId) => {
        // Fetch card title before entering workspace
        fetchJson<CardSummary>(`/api/cards/${cardId}`)
          .then((card) => {
            setSelectedCardId(cardId);
            setSelectedCardTitle(card.title || cardId);
            setPage("workspace");
          })
          .catch(() => {
            setSelectedCardId(cardId);
            setSelectedCardTitle(cardId);
            setPage("workspace");
          });
      }}
    />
  );
```

改为：

```tsx
  return (
    <CardSelectPage
      skin={skin}
      onSkinChange={setSkin}
      onSelectCard={(cardId) => {
        // Fetch card title before entering workspace
        fetchJson<CardSummary>(`/api/cards/${cardId}`)
          .then((card) => {
            setSelectedCardId(cardId);
            setSelectedCardTitle(card.title || cardId);
            setPage("workspace");
          })
          .catch(() => {
            setSelectedCardId(cardId);
            setSelectedCardTitle(cardId);
            setPage("workspace");
          });
      }}
    />
  );
```

- [ ] **Step 4.2: 给 ScannerWorkspace 传受控 props**

将第 97-105 行：

```tsx
  if (page === "workspace" && selectedCardId) {
    return (
      <ScannerWorkspace
        cardId={selectedCardId}
        cardTitle={selectedCardTitle}
        onBack={() => setPage("select")}
      />
    );
  }
```

改为：

```tsx
  if (page === "workspace" && selectedCardId) {
    return (
      <ScannerWorkspace
        cardId={selectedCardId}
        cardTitle={selectedCardTitle}
        onBack={() => setPage("select")}
        skin={skin}
        onSkinChange={setSkin}
      />
    );
  }
```

- [ ] **Step 4.3: 更新引导层 footerNote 文案**

将第 90 行：

```tsx
          footerNote="如需更改皮肤，可随时在教师端网页的「账号设置 → 客户端设置」中切换。"
```

改为：

```tsx
          footerNote="如需更改皮肤，可随时在登录页右上角的调色盘按钮切换；登录后也可在各页面顶栏右侧切换。"
```

- [ ] **Step 4.4: 类型检查**

Run: `npm run typecheck`
Expected: 退出码 0

- [ ] **Step 4.5: Commit**

```bash
git add src/apps/answer-card/client/ScannerApp.tsx
git commit -m "feat(scanner): ScannerApp 下发皮肤受控 props 并更新引导层文案"
```

---

### Task 5: SKIN-THEME.md 决策记录更新

**Files:**
- Modify: `readus/SKIN-THEME.md:90,190-191`

- [ ] **Step 5.1: 更新 §三 文件职责表中 ScannerApp 行**

将第 90 行：

```markdown
| `client/ScannerApp.tsx` | 登录页/登录后按本地或账号 `themeSkin` 落盘 + 设 `data-skin`（账号 flat 显式写入覆盖残留，换账号不继承）；不提供切换按钮 |
```

改为：

```markdown
| `client/ScannerApp.tsx` | 登录页/登录后按本地或账号 `themeSkin` 落盘 + 设 `data-skin`（账号 flat 显式写入覆盖残留，换账号不继承）；v2.5.0 起向 `CardSelectPage`/`ScannerWorkspace` 下发受控 `skin` props（顶栏右侧 SkinSwitcher），登录页为自管入口 |
```

- [ ] **Step 5.2: 更新 §六 FAQ「扫描端能切换皮肤吗」**

将第 190-191 行：

```markdown
**Q：扫描端（scanner）能切换皮肤吗？**
A：扫描端不提供切换按钮（工作台场景），但登录页/登录后按本地记录或账号 `themeSkin` 设置 `data-skin`（账号为 flat 时显式写入覆盖上一账号残留），换账号登录不会继承旧皮肤。
```

改为：

```markdown
**Q：扫描端（scanner）能切换皮肤吗？**
A：能（v2.5.0 起）。登录页右上角为自管模式入口（登录前直接读写 localStorage + data-skin）；登录后答题卡选择页与扫描工作台顶栏右侧均为受控模式入口（由 ScannerApp 下发，即时生效并 PATCH 同步到账号偏好）。数据面行为不变：登录页/登录后按本地记录或账号 `themeSkin` 设置 `data-skin`（账号为 flat 时显式写入覆盖上一账号残留），换账号登录不会继承旧皮肤。
```

- [ ] **Step 5.3: 全文残留检查**

Run: `Select-String -Path "readus/SKIN-THEME.md" -Pattern "不提供切换"`
Expected: 无输出（旧决策表述已清零）

- [ ] **Step 5.4: Commit**

```bash
git add readus/SKIN-THEME.md
git commit -m "docs(skin): 更新扫描端换肤入口决策记录"
```

---

### Task 6: v2.5.0 版本发布面

**Files:**
- Modify: `package.json`（version 字段）
- Modify: `package-lock.json`（根与 packages[""] 两处 version）
- Modify: `README.md:4`
- Modify: `readus/CHANGELOG.md`（标题行之后插入新条目）

- [ ] **Step 6.1: 版本号升级**

Run: `npm version 2.5.0 --no-git-tag-version`
（同时更新 package.json 与 package-lock.json 两处，避免手工编辑 lockfile）

验证 Run: `node -p "require('./package.json').version + ' / ' + require('./package-lock.json').version"`
Expected: `2.5.0 / 2.5.0`

- [ ] **Step 6.2: README 徽章**

将 `README.md` 第 4 行：

```html
  <img src="https://img.shields.io/badge/version-2.4.1-blue.svg" alt="Version">
```

改为：

```html
  <img src="https://img.shields.io/badge/version-2.5.0-blue.svg" alt="Version">
```

- [ ] **Step 6.3: CHANGELOG 新增 v2.5.0 条目**

在 `readus/CHANGELOG.md` 第 1 行 `# Project-X CHANGELOG` 与第 3 行 `## v2.4.1 ...` 之间插入（日期以合入当日实际日期为准）：

```markdown

## v2.5.0 (2026-08-25) — 扫描端可随时换肤（登录页 + 工作台双入口）

> 此前扫描端仅在首次进入时强制选肤，一次性标志写入后无任何更改入口，官方指引指向教师端网页设置页（机房场景不可达）。本版本补齐扫描端自身的换肤能力。

### 扫描端换肤入口（v2.5.0）
- **登录页右上角**新增调色盘按钮（自管模式）：登录前直接读写本机 `projectx-skin` 并即时应用，与 web 端登录页一致。
- **答题卡选择页与扫描工作台顶栏右侧**新增受控调色盘按钮：由 ScannerApp 下发皮肤状态，切换即时生效，自动落盘并 fire-and-forget 同步到账号偏好（`PATCH /api/users/me/settings`，后端照常记录 theme_change_events 审计）。
- 首次选肤引导层文案同步更新：不再指向教师端网页，改为本端入口说明。
- 数据面零改动：皮肤注册表、CSS 令牌、同步语义（会话显式选择优先/登出清除标记/换设备恢复账号偏好）均沿用既有实现。
- 文档：`readus/SKIN-THEME.md` 更新文件职责表与 FAQ（推翻"扫描端不提供切换按钮"的旧决策）。

```

- [ ] **Step 6.4: 版本一致性检查**

Run: `Select-String -Path "package.json","package-lock.json","README.md" -Pattern "2\.4\.1"`
Expected: 无输出（旧版本号清零）

- [ ] **Step 6.5: Commit**

```bash
git add package.json package-lock.json README.md readus/CHANGELOG.md
git commit -m "chore(release): 版本定为 2.5.0，CHANGELOG 增补扫描端换肤条目"
```

---

### Task 7: 最终验证（全量门禁）

**Files:** 无新改动（只读验证）

- [ ] **Step 7.1: 类型检查**

Run: `npm run typecheck`
Expected: 退出码 0

- [ ] **Step 7.2: scanner 构建门禁**

Run: `npm run build:scanner:full`
Expected: typecheck 通过 + vite scanner 模式构建成功 + esbuild bundle 成功，产物在 `dist/scanner/`

- [ ] **Step 7.3: tree-shake 回归确认（信息性）**

Run: `Get-ChildItem dist/scanner/assets/*.js | Select-String -Pattern "客户端设置" -List`
Expected: 无匹配（scanner 产物不含 web 端 AccountSettingsPage 内容；本次改动未给 scanner 入口链引入任何 App/pages 依赖）

- [ ] **Step 7.4: 手动冒烟清单（需要运行环境时执行）**

启动 `npm run dev` 后打开扫描端构建产物或 dev 页面逐项确认：
1. 清空站点数据 → 引导层出现 → 二选一确认 → 进入登录页；
2. 登录页右上角调色盘按钮 → 切换另一套皮肤 → 即时生效；
3. 登录 → CardSelectPage 顶栏右侧调色盘 → 切换 → 即时生效；
4. 进入某答题卡 → ScannerWorkspace 顶栏右侧调色盘 → 切换 → 即时生效；
5. 刷新页面 → 保持所选皮肤；
6. （可选，web 环境）教师端「账号设置 → 客户端设置」显示同步后的同值。

- [ ] **Step 7.5: 汇报**

向用户汇报：任务完成情况、typecheck/build 结果、冒烟结果（若执行）、以及 stash 中尚存的白屏 WIP 提醒。

---

## 自审记录

- **规格覆盖**：规格 §五 改动清单 8 个文件 ↔ Task 1-4（源码 4 个）+ Task 5（SKIN-THEME.md）+ Task 6（版本面 4 个）；§四 数据流 = 复用管线未触碰；§七 验证 = Task 7。无缺口。
- **占位符扫描**：无 TBD/TODO；所有代码步骤均含完整代码；CHANGELOG 日期注明"以合入当日实际日期为准"。
- **类型一致性**：三个组件的可选 props 统一为 `skin?: string; onSkinChange?: (skin: string) => void`，与 `SkinSwitcherProps`（SkinSwitcher.tsx:81-92）同名同型；`setSkin` 为 React `Dispatch<SetStateAction<string>>`，可直接赋给 `(skin: string) => void`（TS 允许该方向协变）。

