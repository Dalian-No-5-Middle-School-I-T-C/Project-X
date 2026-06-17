# Project-X CHANGELOG

---

## v1.2.1 (2026-06-17)

### Bug 修复

- **Electron 后端启动增强**：探活重试从 20 次（3s）延长至 30 次（4.5s）；新增原生模块加载失败的明确错误诊断，区分 native 模块 ABI 不匹配错误
- **低分辨率/DPI 缩放 UI 修复**：CSS 响应式设计改为三级断点（1300px / 1060px / 760px），解决 125%/150% DPI 缩放时侧栏与主内容区、检查器面板重叠问题；窄屏下侧栏宽度自适应收缩
- **答题卡创建考试时间校验**：前端与后端均强制要求考试时间（YYYY-MM-DD），不再允许留空
- **数据库导入导出多项热修复**：修复认证 token 键名不匹配（`auth_token` → `projectx_auth_token`）导致 401；修复 archiver v8 ESM API 变更（`archiver("zip")` → `new ZipArchive({})`）；修复 unzipper 流式解析 FILE_ENDED；最终改用 adm-zip 同步全内存解压 + express.raw() 直传二进制绕过 multipart/form-data corrupt 问题

### 新功能

- **数据库全量备份/恢复**：管理员可从账号菜单「导出数据」打包全部数据（projectx.db + scanner.db + data/answer-card/）为 ZIP 下载；支持通过「导入数据」上传 ZIP 恢复，恢复后建议重启应用
- **答题卡创建记录教师信息**：`POST /api/cards` 现已将 `created_by`（创建答题卡的教师账号 ID）持久化写入 `answer_cards` 表，支持后续审计追溯
- **导入模板升级为 Excel**：学生/教师导入的示例模板从纯文本 CSV 改为正式 .xlsx 文件（通过 SheetJS 生成）

### 新增 API

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/db/backup` | 导出全量数据 ZIP（需管理员权限） |
| `POST` | `/api/db/restore` | 上传 ZIP 恢复数据库（raw binary, 需管理员权限） |

### 依赖变更
- 新增 `archiver` v8（ESM, ZIP 打包）、`adm-zip`（ZIP 解压）
- 移除 `@types/archiver`（v8 ESM 无兼容类型），自建 `src/types/archiver.d.ts`、`src/types/adm-zip.d.ts`

---

## v1.2.0 (2026-06-17)

### AI 成绩分析
- 在「分析 → 成绩分析」中新增 AI 成绩分析卡片，位置位于「分数统计分布」之后、「学生排名」之前
- 新增 `llmclient` Python 中转服务，提供 `GET /health`、`GET /models`、`POST /analysis/run`
- 支持 `gemini-3.1-flash-lite`、`gemini-3.5-flash`、`deepseek-v4-flash`、`deepseek-v4-pro`
- Gemini 与 DeepSeek 默认开启 thinking；DeepSeek V4 thinking 请求保留 `reasoning_content` 续轮，但不返回前端展示
- 新增成绩工具白名单：考试概览、分数分布、班级摘要、题目分析、排名分段、复核风险
- Node 新增 `/api/analysis/ai/status` 和 `/api/analysis/exams/:examId/ai-analysis`

### 桌面启动与本地服务
- Electron 本地 Express 启动改为等待真实 `listening` 事件后再返回，避免端口绑定失败时误判成功
- `127.0.0.1:5174` 遇到 `EADDRINUSE` 或 `EACCES` 时自动 fallback 到随机端口
- 新增 `/api/app/health`，Electron 通过真实 HTTP 探活后才加载窗口，避免空壳窗口

### 文档
- 新增 [`AI成绩分析.md`](./AI成绩分析.md)
- README、管理员手册、架构文档、多端说明同步补充 AI 分析与本地端口探活说明

---

## v1.1.5 (2026-06-16)

### UX 交互一致性改进

- **阅卷流程重构**：考试选择器提升为主入口，选择考试后答题卡自动关联（可手动覆盖），无需重复选择答题卡
- **考试创建自动回填**：选择答题卡后自动填充考试名称和科目，消除重复输入
- **教师关联班级即时生效**：关联/解除班级后详情即时更新，无需手动刷新
- **学生创建交互统一**：花名册栏新增「学号+姓名+加号」快捷创建，与年级/班级的输入+加号模式一致；原独立弹窗改为标题栏「新建学生」按钮触发
- **标题栏按钮统一**：学生管理标题栏加入「新建学生」按钮，所有管理页统一为 [刷新] [新建] [导入] [导出] 布局
- **导入/导出图标一致**：统一使用 Download 表示导入、Upload 表示导出
- **新建答题卡时可同步创建/关联考试**：NewCardModal 新增「考试关联」区块，支持同时创建同名考试（名称可编辑）或关联已有考试，省去考试管理页面单独操作；三选一采用紧凑胶囊按钮
- **新增 PATCH /api/exams/:examId**：支持更新考试的答题卡关联、名称和科目

### Windows x64 / ia32 打包
- 学生端、教师普通端、教师扫描端均支持 `x64` 与 `ia32` 打包；默认命令保持 `x64` 行为不变
- 新增 `electron:pack:*:ia32`、`electron:dist:*:ia32`、`electron:msi:*:ia32` 脚本
- 新增 `npm run electron:msi:all`，一次生成三端 x64/ia32 共 6 个 MSI
- 32 位原生资源统一放在 `resources/native/win-ia32/`，运行时按 `process.arch` 自动选择 `win-x64` 或 `win-ia32`
- 32 位打包会先重建 Electron ia32 的 `better-sqlite3`，打包结束后恢复开发环境的 Node 原生模块

### 依赖变更

- 密码哈希依赖由原生 `bcrypt` 调整为纯 JS `bcryptjs`；Electron 原生重建范围收敛为 `better-sqlite3`

---

## v1.1.0 (2026-06-14~15)

### 多端产品变体（学生端 / 教师普通端 / 教师扫描端）
- 同一代码库打包为三个独立 Electron 包：`student`、`teacher`、`teacher-scanner`
- 学生端仅「我的成绩」；教师普通端设计/阅卷/分析/账号（无扫描）；教师扫描端全功能
- 三端共用 `%APPDATA%\answer-card-designer` 数据目录，账号/考试/成绩互通
- 变体配置定义于 `src/shared/appVariant.ts`，前端先按产品端限功能，再按角色限功能
- 学生默认密码允许 5 位学号（自改密码仍要求 ≥6 位）；`src/server/auth/passwordPolicy.ts`
- 学生登录支持用户名或学号两种方式
- 打包脚本：`electron:pack/dist/msi:student/teacher/scanner`
- 新增多端说明文档 `readus/多端使用说明.md`

### CSV/Excel 批量导入师生
- **学生**：`年级,班级,学号,姓名` → 自动建年级/班级，账号=`P`+学号，密码=账号
- **教师**：`科目,姓名` → 自动生成 T+6位随机数账号、6位随机数字密码
- 支持 CSV / Excel (.xlsx/.xls) 上传、粘贴、预览、模板下载

### 教师管理面板
- 顶栏常驻「新建教师」「导入教师」「导出教师账密」
- 左侧列表按创建时间排序+搜索；右侧编辑姓名、科目(9科下拉)、关联/解除班级
- 手动创建教师弹窗（科目+姓名 → 自动生成账号密码）

### 学生管理面板（原班级管理改名）
- Tab「班级管理」→「学生管理」；2 Tab（教师管理/学生管理）
- 顶栏常驻「导入学生」「导出学生账密」
- 三栏：年级 → 班级(含人数) → 花名册(学号/姓名/账号)

### 账密导出统一 Excel
- 学生/教师/成绩导出全部统一为 .xlsx，fetch+blob 下载
- 导出前安全警告；旧 CSV 端点 301 重定向

### 赞助页面（Issue #11）
- 账号菜单「支持项目」低调入口，顶栏不增加 Tab
- `GET /api/sponsor` + `GET /api/sponsor/qr/:channelId` 预留收款码接口
- JSON 配置 `server/data/sponsor.json` + 图片目录 `data/sponsor/qr/`
- 无收款码时展示占位 UI；部署时放置 PNG 并更新配置即可启用
- 详见 [`readus/SPONSOR-PAGE.md`](./SPONSOR-PAGE.md)

### Bug 修复
- Express 5 `router.use()` 单回调限制 → 拆为两行独立调用
- 导入/导出图标方向统一（导入=Download、导出=Upload）
- UI 版本号 `v1.0.1` → `v1.1.0`

### 数据库
- `users` 新增 `subject`(教师科目)、`initial_password`(导出明文密码)
- 新建 `teacher_classes` 表(教师↔班级多对多)
- 自动 migration

### 新增 API
| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/users/import-csv` | 批量导入学生/教师 |
| `GET` | `/api/teachers` | 教师列表(创建时间排序) |
| `GET/PUT` | `/api/teachers/:id` | 教师详情/更新 |
| `POST/DELETE` | `/api/teachers/:id/classes` | 教师关联/解除班级 |
| `GET` | `/api/export/students` | 导出学生账密 .xlsx |
| `GET` | `/api/export/teachers` | 导出教师账密 .xlsx |
| `GET` | `/api/analysis/exams/:id/export-csv` | 成绩导出改为 .xlsx |
| `GET` | `/api/sponsor` | 赞助页配置（各渠道收款码 URL） |
| `GET` | `/api/sponsor/qr/:channelId` | 收款码图片 |

### 依赖变更
- 新增 `xlsx` (SheetJS)

---

## v1.0.x — 答题卡系统 UX 增强 & 卡片管理 (2026-06-14)

### 侧栏 & 品牌
- 侧栏仅设计 Tab 显示，阅卷/分析/账号全屏
- 标题→「答题卡设计阅卷系统」，图标→`resources/icon.png`

### 答题卡 ID 与管理
- ID 改为确定性 8 位纯数字(基于科目+时间戳 hash)
- 导出 `.projectx-card.json`(含答案+配图base64+布局)、导入、级联删除
- 设计器基本信息面板新增科目、考试日期

### 新建答题卡 Modal
- `NewCardModal`：科目选择(9科预设+自定义)、考试名称、日期选择器
- `src/shared/pinyin.ts`：中文科目名→拼音 key 转换

### 登录 & 持久化
- 「记住密码」6个月免登录(180天持久化 token)
- Token 磁盘持久化到 `~/.projectx/tokens.json`(重启不丢失)
- 默认单面答题卡(sided 默认 single)

### Topbar 布局修复
- Tab 栏固定右侧，按钮组移到中间，切换 Tab 位置不跳动
