# Project-X CHANGELOG

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
