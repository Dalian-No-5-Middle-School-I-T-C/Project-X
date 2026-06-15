# CHANGELOG-003 | v1.1.0 — 赞助页面与收款码预留接口

> **发布日期**: 2026-06-15  
> **里程碑**: Issue #11 赞助页面 — 低调支持入口、JSON 配置驱动、收款码图片预留接口  
> **详细说明**: [`SPONSOR-PAGE.md`](./SPONSOR-PAGE.md)

---

## 核心变更

### 1. 赞助/支持页面（Issue #11）

- 新增 **`sponsor` 应用模式**，通过账号菜单「支持项目」进入，**不在顶栏增加 Tab**
- 新增 `SponsorPage` 组件：居中卡片布局，复用现有玻璃拟态样式
- 无收款码时展示虚线占位框 + `QrCode` 图标 +「收款码待配置」弱提示
- 所有已登录用户（学生 / 教师 / 管理员）均可访问

### 2. 后端配置与 API 预留

- 新增 `GET /api/sponsor` — 返回标题、说明与各支付渠道配置
- 新增 `GET /api/sponsor/qr/:channelId` — 按渠道返回收款码 PNG 图片
- 配置文件：`src/apps/answer-card/server/data/sponsor.json`
- 图片目录：`data/sponsor/qr/`（运行时放置，不进 git）
- 后续启用收款码：放置 PNG → 更新 `qrFile` 字段 → 重启应用，**无需重新构建前端**

### 3. 多端变体兼容

- `ProjectXAppMode` 扩展为含 `sponsor` 模式
- `sponsor` **不加入** `allowedModes` 列表，仅通过账号菜单隐式导航，与学生端 / 教师端变体配置兼容

---

## 新增 API

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/sponsor` | 赞助页配置（含各渠道 `qrUrl`） |
| `GET` | `/api/sponsor/qr/:channelId` | 收款码图片（未配置时 404） |

---

## 前端文件变更

| 文件 | 变更 |
|------|------|
| `components/SponsorPage.tsx` | **新建** — 赞助页组件 |
| `components/AccountMenu.tsx` | **修改** — 新增「支持项目」菜单项 |
| `App.tsx` | **修改** — `sponsor` 模式面板、返回导航、顶栏标题 |
| `styles.css` | **修改** — 新增 `.sponsor-*` 样式类 |
| `shared/appVariant.ts` | **修改** — `ProjectXAppMode` 含 `sponsor` |

---

## 后端文件变更

| 文件 | 变更 |
|------|------|
| `server/routes/sponsor.ts` | **新建** — 赞助 API 路由 |
| `server/data/sponsor.json` | **新建** — 赞助页 JSON 配置 |
| `server/index.ts` | **修改** — 挂载 `/api/sponsor` |
| `data/sponsor/qr/.gitkeep` | **新建** — 收款码目录占位 |
| `.gitignore` | **修改** — 允许跟踪配置与目录占位，忽略实际收款码图片 |

---

## 文档更新

- `readus/SPONSOR-PAGE.md` — 赞助页面完整说明（入口、配置、API、验证）
- `readus/CHANGELOG-003.md` — 本文件
- `README.md` — 文档索引、API 表格、组件列表更新

---

## 验证

| 检查项 | 结果 |
|--------|------|
| `npm run typecheck` | 通过 |
| `GET /api/sponsor` 占位态 | `qrUrl: null` |
| 临时配置收款码图片 | `/api/sponsor/qr/wechat` 返回 200 |
| 与 `main` 分支合并 | 已解决 `App.tsx` / `ProjectXAppMode` 冲突 |

---

## 版本号

本变更为 v1.1.0 功能增量，**不提升** `package.json` 版本号。

Closes #11
