# AGENTS.md

*最近一次更新于 2026-09-10*

## 项目与部署边界

本仓库为 Project-X 答题卡设计阅卷系统，覆盖答题卡设计、PDF 导出、扫描识别、判分、网上阅卷、成绩分析和 AI 分析。

- **实际部署形态：Windows 扫描端配原生 OMR 组件 + Linux 服务端。服务端部署使用 MariaDB，服务端不执行 OMR。**
- Web：教师 / 学生页面，构建到 `dist/web/`；扫描端：Electron 桌面应用，构建到 `dist/scanner/`。两者入口分离，不要把扫描端依赖引入 Web。
- Windows 扫描端负责扫描仪调用和原生识别；Linux 服务端接收扫描端上传并提供业务 API、阅卷和分析。
- SQLite 仍用于本地模式及部分测试；不能因生产使用 MariaDB 而移除 SQLite 兼容，也不能用 SQLite 测试代替 MariaDB 验证。
- Ubuntu 包的 `PROJECTX_ENABLE_SCANNER=0` 与 `PROJECTX_ENABLE_SCANNER_CLIENT_API=1` 分别控制本机扫描能力和远程扫描端上传接入，不要混淆。

## 开始工作前

1. 查看 `git status` 和本次任务范围，保留用户已有修改，不覆盖、不回退无关工作。
2. 按下方目录定位调用入口，先查现有接口、类型、组件和测试，再修改。修复问题需追踪「界面 / API 写入 → 持久化 → 实际消费者 → 可观察行为」。
3. 现行约束以本文件和用户要求为准；实现事实核对当前代码、`package.json`、`vite.config.ts` 和 CI。旧文档中的版本号、测试通过数、历史方案不代表当前状态。
4. 审核任务保持只读；实施任务完成必要验证。不要把代码修改自动扩大为发布、生产迁移或部署。

## 文档入口

项目文档包括 [README.md](README.md)、[readus/](readus/) 和 [docs/](docs/)。**`docs/superpowers` 不是项目文档目录，不作为现行规范来源；其他外围文件或用户说明不要自动提升为项目规范。**

| 任务 | 优先阅读 |
| --- | --- |
| 项目概况、运行与打包 | `README.md`、`package.json` |
| 架构与模块关系 | `readus/ARCHITECTURE.md` |
| 数据库及 SQL 兼容 | `readus/DATABASE.md`、`readus/双方言SQL函数安全清单.md` |
| 账号与权限 | `readus/ACCOUNT-ARCHITECTURE.md`、`readus/ACCOUNT-CONTROL.md` |
| UI 与主题 | 本文件样式规范、`readus/UI-ARCHITECTURE.md`、`readus/SKIN-THEME.md` |
| 扫描端与多端使用 | `readus/SCANNER-SETUP.md`、`readus/多端使用说明.md` |
| 历史变更 | `readus/CHANGELOG.md` |

按任务阅读相关文档即可；遇到文档与实现冲突，明确差异，不凭旧说明改写现有行为。

## 代码导航

| 位置 | 职责 |
| --- | --- |
| `src/apps/answer-card/client/` | React UI；`main.tsx` / `App.tsx` 为 Web 入口，`main-scanner.tsx` / `ScannerApp.tsx` 为扫描端入口 |
| `src/apps/answer-card/server/index.ts` | Express 应用入口、路由装配和运行配置 |
| `src/apps/answer-card/server/` | 产品 API、扫描、`recognition.ts` 原生识别衔接、PDF、存储及 LLM 接入 |
| `src/server/routes/`、`services/`、`repositories/` | 业务路由、服务和数据访问；修改前检查已有实现 |
| `src/server/auth/`、`middleware/` | 身份认证和权限控制 |
| `src/server/db/` | 数据库配置、适配器、schema 和迁移 |
| `src/shared/` | 跨端共享类型、布局、判分和统计；重点为 `types.ts`、`layout.ts`、`grading.ts` |
| `native/AnswerCardRecognizer/`、`native/ScannerBridge/` | C++ OMR 与 TWAIN 扫描桥 |
| `electron/` | 扫描端桌面运行环境 |
| `llmclient/` | Python AI 服务；按相关任务需要启动 |
| `scripts/`、`.github/workflows/ci.yml` | 构建、打包、迁移、回归验证和 CI |

修改布局或识别契约时，同时检查布局生成、原生识别输入输出、共享类型及判分消费者；修改成绩规则时检查扫描判分、网上阅卷、重算、排名和分析等实际受影响路径，避免各端各写一套规则。

## 实现规范

- 优先复用现有库、服务、类型和组件；安装依赖时保持清单与锁文件一致，避免顺手升级无关依赖。
- 数据访问沿用 `DbAdapter`（`src/server/db/mysql.ts`）及既有仓储模式；SQL 使用参数绑定。Upsert / 忽略冲突优先使用 `buildUpsertSQL` / `buildInsertIgnore`，不要在共享路径直接写单一数据库方言。
- 数据结构变更检查 SQLite 的 `schema.sql` / `migrations.ts` 和 MariaDB 的 schema / `mysql.ts` 迁移；兼顾新库初始化与已有库升级，不能只改建表语句。
- 权限约束放在后端，并复用现有范围判断；前端隐藏按钮不等于授权校验。涉及成绩、阅卷、发布或删除时核对数据范围与持久化结果。
- Web 兼容目标包含 iOS 15 / Safari 15（见 `vite.config.ts`）；UI 修改兼顾移动端、明暗模式及两套皮肤。
- 不提交运行数据、数据库、密钥或生成的打包产物。验证使用隔离测试数据，避免影响现有业务数据。

## 样式事实源（P6 T05 定稿）

- **CSS 唯一事实源** = `src/apps/answer-card/client/theme/app.css` + `theme/tokens.css` + `theme/backdrop.css`。旧 `styles.css` 与 `theme/legacy-bridge.css` 已删除，不恢复 legacy 样式。
- **组件唯一事实源** = `src/apps/answer-card/client/components/ui/v2/*`，通过桶文件具名 import，先查看已有组件 API。
- **禁止新建 CSS 文件、禁止手写业务 CSS**。业务样式一律用 Tailwind 工具类 + `--px-*` 语义令牌；需要扩展主题在 `app.css` 的 `@theme` 块内加，禁止散落硬编码。
- Preflight 未启用（架构师 D2 决策），全局 reset 已由 `app.css` 的 `@layer base` 接管；**Preflight 启用另立 P7**。组件显式声明所需背景、边框和间距。

## 运行与验证

README 开发环境建议 Node.js 24+；当前 CI 使用 Node.js 22。命令以 `package.json` 为准，PowerShell 下 `npm` 失败时使用 `npm.cmd`。

| 目的 | 命令 / 说明 |
| --- | --- |
| 启动开发 | `npm run dev`，API 默认 `5174`，Vite `5173`，代理 `/api` 与 `/assets` |
| 类型检查 | `npm run typecheck`（不是 ESLint） |
| 认证 / 权限 | `npm run verify:auth` |
| 核心逻辑 | `npm run verify:core-logic` |
| 安全与完整性 | `npm run verify:security-critical` |
| 判分冒烟 | `npx tsx scripts/grading-rules-smoke.ts`；其他专项验证查看 `verify:*` 脚本 |
| Web + 服务端构建 | `npm run build`，含类型检查，产物 `dist/web/` + `dist/server/` |
| 扫描端 + 服务端构建 | `npm run build:scanner:full`，含类型检查 |
| Ubuntu 服务端打包 | `npm run package:server:ubuntu24`；该脚本不包含类型检查，需先单独验证 |
| 健康检查 | `GET /api/app/health`；健康响应不能代替业务流程验证 |

- 代码改动运行类型检查、相关专项测试和受影响目标的构建；共享代码影响两端时检查两端。纯文档改动检查路径、命令与 diff 即可。
- SQL / 迁移修改需验证 MariaDB 相关路径，并保留 SQLite 回归；报告实际数据库环境，不能把未运行的测试写成通过。
- `predev` 会检查 Node 的 `better-sqlite3` 原生模块；Electron 和 Node ABI 不同，桌面打包后若 Node 测试报 ABI 错误，使用 `npm run native:rebuild:node` 恢复。
- Linux / CI 仅验证 Web 与服务端时可用 `npm install --ignore-scripts`，再 `npm rebuild better-sqlite3`；完整桌面开发还需要 Electron 和 Windows 原生依赖。
- 原生扫描与 OMR 需 Windows 环境，扫描仪验收还需真实硬件。构建通过不代表设备或视觉验收通过；交付说明已完成的验证及未覆盖部分，不保留固定的历史通过数量。

<cursor_cloud_specific_instructions>

以下仅适用于 Cursor Cloud：Linux 云环境无法完成 Windows 原生 OMR / TWAIN 设备验收。遵循上述通用规范，按当前 CI 安装依赖和执行验证；不要将云端 SQLite 测试环境当作生产部署形态。

</cursor_cloud_specific_instructions>

## Code of Conduct — 八荣八耻

以瞎猜接口为耻，以认真查询为荣。
以模糊执行为耻，以寻求确认为荣。
以臆想业务为耻，以人类确认为荣。
以创造接口为耻，以复用现有为荣。
以跳过验证为耻，以主动测试为荣。
以破坏架构为耻，以遵循规范为荣。
以假装理解为耻，以诚实无知为荣。
以盲目修改为耻，以谨慎重构为荣。
