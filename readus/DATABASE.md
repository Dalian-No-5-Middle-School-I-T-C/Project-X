# Project-X 数据库模块文档

> **版本**: v1.4.7
> **技术栈**: SQLite + better-sqlite3 + bcryptjs
> **目标**: 为五中智能试卷管理系统提供统一的数据存储与访问能力

---

## 目录

- [快速开始](#快速开始)
- [数据库架构](#数据库架构)
- [表结构说明](#表结构说明)
- [API 接口](#api-接口)
- [认证与授权](#认证与授权)
- [数据保留与清理](#数据保留与清理)
- [与其他模块的连接](#与其他模块的连接)
- [常见问题](#常见问题)

---

## 快速开始

### 1. 安装依赖

```powershell
npm install
```

需要安装的额外依赖（已写入 `package.json`）：
- `better-sqlite3` — SQLite 同步驱动，包含原生 C++ 模块
- `bcryptjs` — 密码哈希，纯 JS 实现，兼容 bcrypt 哈希格式

> **注意**: 当前需要编译的 Node 依赖只有 `better-sqlite3`。如果遇到编译错误，请确保已安装 Python 和 Visual Studio Build Tools。

### 2. 启动服务器

```powershell
# 开发模式（前端热更新 + 后端服务）
npm run dev

# 仅启动后端服务
npm run server
```

首次启动时，数据库会自动：
1. 创建 `data/projectx.db` SQLite 数据库文件
2. 执行建表 SQL（`src/server/db/schema.sql`）
3. 插入默认角色（管理员/教师/学生）
4. 插入默认数据保留策略（周测30天/月考90天/期中期末永久）
5. 创建默认管理员账号 `admin` / `admin123`

> **⚠️ 安全提醒**: 首次启动后请立即登录并修改默认密码！

### 3. 数据库文件位置

```
data/
└── projectx.db              # SQLite 数据库主文件
    ├── projectx.db-shm      # WAL 模式共享内存文件
    └── projectx.db-wal      # WAL 模式日志文件
```

可通过环境变量修改数据库路径：

```powershell
$env:PROJECTX_DB_PATH = "D:\\shared\\projectx.db"
npm run server
```

---

## 数据库架构

### 模块划分

```
┌─────────────────────────────────────────────────────────────┐
│                     SQLite 数据库                            │
├─────────────────┬─────────────────┬─────────────────────────┤
│  用户与权限      │  答题卡设计      │    考试与扫描            │
├─────────────────┼─────────────────┼─────────────────────────┤
│ users           │ answer_cards    │ exams                   │
│ roles           │ objective_blocks│ scan_batches            │
│ classes         │ objective_...   │ scan_records            │
│ grades          │ subjective_...  │ objective_recognitions  │
│ class_students  │ card_assets     │ objective_grades        │
│ teacher_classes │                 │ subjective_grades       │
├─────────────────┴─────────────────┴─────────────────────────┤
│                      成绩统计                                 │
├─────────────────────────────────────────────────────────────┤
│ student_scores                                              │
│ question_scores                                             │
└─────────────────────────────────────────────────────────────┘
```

### 技术特性

| 特性 | 配置 | 说明 |
|------|------|------|
| **日志模式** | WAL | Write-Ahead Logging，提升并发性能 |
| **外键约束** | ON | 启用级联删除，保障数据一致性 |
| **同步模式** | NORMAL | 平衡数据安全与写入性能 |
| **忙等待** | 5000ms | 并发访问时的自动重试 |

---

## 表结构说明

### 模块一：用户与权限

#### `users` — 用户表

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | INTEGER PK | 自增主键 |
| `username` | TEXT UNIQUE | 登录账号（学生=P+学号，教师=T+随机数） |
| `password_hash` | TEXT | bcrypt 格式哈希密码 |
| `name` | TEXT | 真实姓名 |
| `role_id` | INTEGER FK | 关联 roles.id |
| `student_number` | TEXT UNIQUE | 学号/考号（仅学生） |
| `subject` | TEXT | 任教科目（仅教师，v1.1新增） |
| `initial_password` | TEXT | 初始明文密码（用于导出账密，v1.1新增） |
| `email` | TEXT | 邮箱 |
| `phone` | TEXT | 联系电话 |
| `is_active` | INTEGER | 0=禁用 1=启用 |
| `last_login_at` | DATETIME | 最后登录时间 |

#### `roles` — 角色表

内置三种角色：

| id | name | 权限 |
|----|------|------|
| 1 | admin | `["*"]`（全部权限） |
| 2 | teacher | 答题卡读写、考试读写、成绩读写 |
| 3 | student | 成绩查看 |

#### `class_students` — 班级-学生关联

| 字段 | 类型 | 说明 |
|------|------|------|
| `class_id` | INTEGER FK | 班级 ID |
| `student_id` | INTEGER FK | 学生用户 ID |
| `joined_at` | DATETIME | 加入时间 |

#### `teacher_classes` — 教师-班级关联（v1.1 新增）

| 字段 | 类型 | 说明 |
|------|------|------|
| `teacher_id` | INTEGER FK | 教师用户 ID |
| `class_id` | INTEGER FK | 班级 ID |
| `subject` | TEXT | 可选：该教师在此班级的任教科目覆盖 |
| `created_at` | DATETIME | 关联创建时间 |

### 模块二：答题卡设计

#### `answer_cards` — 答题卡主表

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT PK | 8位数字字符串（如 `12345678`） |
| `title` | TEXT | 答题卡标题 |
| `subject` | TEXT | 科目拼音 key，如 `wuli` / `shuxue` |
| `subject_label` | TEXT | 科目中文名 |
| `exam_date` | TEXT | 考试日期，ISO `YYYY-MM-DD` |
| `sided` | TEXT | `single` / `double` |
| `layout_data` | TEXT | 兼容遗留列；运行时不再读写，布局由 `buildLayout(card)` 按需生成 |
| `created_by` | INTEGER FK | 创建者用户ID |

#### `objective_blocks` / `objective_questions` — 客观题块与逐题配置

`objective_blocks` 保留块级兼容字段；v1.3 起实际逐题配置优先保存在 `objective_questions`。

| 字段 | 类型 | 说明 |
|------|------|------|
| `block_id` | TEXT FK | 所属客观题块 |
| `question_number` | INTEGER | 题号，可非连续 |
| `sort_order` | INTEGER | 块内显示顺序 |
| `mode` | TEXT | `single` / `multiple` / `indefinite` |
| `option_count` | INTEGER | 本题选项数 |
| `score` | REAL | 本题满分 |
| `scoring_rule_json` | TEXT | JSON：多选/不定项部分得分规则 |

#### `subjective_blocks` / `subjective_questions` — 主观题块与题目

主观题块新增 `block_kind`，用于区分 `fill_blank`（填空题紧凑布局）与 `answer`（解答题布局）。

`subjective_questions` 支持填空题的逐空配置：

| 字段 | 类型 | 说明 |
|------|------|------|
| `blanks_label_style` | TEXT | `none` / `arabic_parentheses` / `roman_parentheses` |
| `blanks_items_json` | TEXT | JSON：每个空的标签、宽度、高度 |

### 模块三：考试与扫描

#### `exams` — 考试表

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | INTEGER PK | 自增主键 |
| `name` | TEXT | 考试名称 |
| `card_id` | TEXT FK NULL | 使用的答题卡；v1.3 起可为空，用于删除/解绑答题卡后保留考试记录 |
| `status` | TEXT | draft/active/grading/closed |
| `retention_policy_id` | INTEGER FK | 数据保留策略 |

#### `scan_records` — 扫描记录

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | INTEGER PK | 自增主键 |
| `batch_id` | INTEGER FK | 所属扫描批次 |
| `file_path` | TEXT | 原始图片路径 |
| `student_number` | TEXT | 识别出的学号 |
| `status` | TEXT | pending/recognized/graded/error |
| `expires_at` | DATETIME | 超过此日期可被清理 |

### 模块四：成绩统计

#### `student_scores` — 学生总分

记录每场考试每位学生的客观题总分、主观题总分、排名、百分位。

#### `question_scores` — 各题得分明细

记录每场考试每位学生每道题的得分，用于成绩分析和错题统计。
v1.4.5 新增 `manually_modified`、`modified_by`、`modified_at` 字段追踪手动改分。

#### `answer_overrides` — 成绩手动修改记录 (v1.4.5)

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | INTEGER PK | 自增主键 |
| `exam_id` | INTEGER FK | 所属考试 |
| `card_id` | TEXT | 答题卡 ID |
| `question_number` | INTEGER | 题号 |
| `score_type` | TEXT | objective / subjective |
| `override_type` | TEXT | score / answer |
| `old_value` | TEXT | 旧值 JSON |
| `new_value` | TEXT | 新值 JSON |
| `created_by` | INTEGER FK | 操作教师 |
| `created_at` | DATETIME | 操作时间 |

记录每次手动改分或修改答案的操作轨迹，用于审计追溯。

---

## API 接口

### 认证接口

```
POST /api/auth/login          # 登录
Body: { identifier: string, password: string }

POST /api/auth/logout         # 退出登录
Headers: Authorization: Bearer <token>

GET  /api/auth/me             # 获取当前用户信息
Headers: Authorization: Bearer <token>
```

### 答题卡接口

```
GET    /api/cards                    # 答题卡列表
POST   /api/cards                    # 新建答题卡
GET    /api/cards/:cardId            # 获取答题卡详情
PUT    /api/cards/:cardId            # 保存答题卡
GET    /api/cards/:cardId/layout     # 获取布局坐标
GET    /api/cards/:cardId/pdf        # 导出 PDF
POST   /api/cards/:cardId/assets     # 上传图片资源
DELETE /api/cards/:cardId            # 删除答题卡；可传 unlinkExams 或 deleteReferencedExams
DELETE /api/exams/:examId            # 删除考试；可传 deleteLinkedCard
```

### 识别与阅卷接口

```
POST /api/cards/:cardId/recognition/objective   # 单张客观题识别
POST /api/cards/:cardId/grading/objective       # 批量客观题阅卷
Body: multipart/form-data, files[]
```

> **注意**: 以上接口需要 Bearer Token 认证（除 `/api/auth/*` 外）。

---

## 认证与授权

### 登录方式

支持多种登录方式：
1. **用户名** — 管理员/教师的职工号，或学生 `P`+学号（如 `P24101`）
2. **学号** — 学生可直接用纯数字学号登录（如 `24101`）
3. **用户名 + 学号** — 均可作为登录标识符

> v1.1 新增 `passwordPolicy.ts`：学生默认密码允许 5 位学号；自改密码仍需 ≥ 6 位。

### Token 机制

- 登录成功后返回 `token`，有效期 **8 小时**
- 请求时携带 Header：`Authorization: Bearer <token>`
- Token 持久化到 `~/.projectx/tokens.json` 磁盘文件（服务器重启后仍有效，6 个月持久化 Token）

### 权限控制

| 角色 | 答题卡 | 考试 | 扫描 | 成绩 | 用户管理 |
|------|--------|------|------|------|----------|
| 管理员 | 全部 | 全部 | 全部 | 全部 | 全部 |
| 教师 | 读写 | 读写 | 读写 | 读写 | 无 |
| 学生 | 只读 | 无 | 无 | 查看自己的 | 无 |

---

## 数据保留与清理

### 保留策略

| 考试类型 | 扫描原始图片 | 识别结果 | 成绩数据 |
|----------|-------------|---------|---------|
| 周测 | 30天 | 30天 | 永久 |
| 月考 | 90天 | 90天 | 永久 |
| 期中期末 | 永久 | 永久 | 永久 |

### 清理机制

- **自动清理**: 服务启动时注册定时任务，每 24 小时执行一次
- **清理范围**: 过期扫描图片文件、过期识别原始数据
- **保留数据**: 成绩汇总（`student_scores`、`question_scores`）永不删除
- **手动清理**: `npx tsx src/server/db/cleanup.ts [保留天数]`

### 归档机制

考试结束后，可通过 API 将扫描数据归档为压缩包，释放主库空间：

```
exam_archives 表：记录归档信息（路径、大小、归档时间）
```

---

## 与其他模块的连接

### 系统架构

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Electron 前端  │────▶│  Node.js 后端   │────▶│   SQLite 数据库  │
│  (React UI)     │◀────│  (Express API)  │◀────│  (共享服务器)   │
└─────────────────┘     └─────────────────┘     └─────────────────┘
         │                       │
         │              ┌────────┴────────┐
         │              │                 │
         │         ┌────▼────┐      ┌────▼────┐
         │         │ C++ 识别 │      │ PDF 生成 │
         │         │ 模块    │      │ 模块    │
         │         └────┬────┘      └─────────┘
         │              │
         └──────────────┘
              (通过后端调度)
```

### 模块交互

| 模块 | 连接方式 | 说明 |
|------|---------|------|
| **Electron 前端** | HTTP API | 通过 `fetch/axios` 调用后端 REST API |
| **Node.js 后端** | `better-sqlite3` | 唯一直接操作数据库的模块 |
| **C++ 识别模块** | 命令行/进程 | 后端 `spawn` 进程，传入图片路径和 layout 数据 |
| **PDF 生成** | 后端内部 | `pdfkit` 直接生成，不经过数据库 |

### 数据流

1. **答题卡设计** → 前端编辑 → 后端 `PUT /api/cards/:id` → 数据库 `answer_cards` + 题块表 + 题级配置
2. **PDF 导出** → 后端 `GET /api/cards/:id/pdf` → 直接生成 PDF（不走数据库）
3. **扫描识别** → 后端接收图片 → 调用 C++ 识别模块 → 保存结果到 `scan_records` + `objective_recognitions`
4. **自动阅卷** → 对比 `objective_answer_keys` → 写入 `objective_grades` + `student_scores`
5. **成绩查询** → 查询 `student_scores` + `question_scores`

---

## 常见问题

### Q: 数据库文件放在哪里？

默认路径: `data/projectx.db`（项目根目录下）

可通过环境变量修改：
```powershell
$env:PROJECTX_DB_PATH = "D:\\shared\\projectx.db"
```

### Q: 如何备份数据库？

**方式一：程序内导出（推荐）**
管理员登录后，点击右上角账号 →「导出数据」，系统会自动打包 ZIP（含 projectx.db、可选 scanner.db、data/answer-card/ 目录）供下载。当前运行时若没有 legacy scanner.db 属于正常状态，备份文件仍支持通过「导入数据」一键恢复。

**方式二：手动复制**
SQLite 数据库是单个文件，直接复制 `projectx.db` 即可备份：
```powershell
copy data\projectx.db data\projectx_backup_20260101.db
```

### Q: 并发访问有问题吗？

- SQLite 使用 **WAL 模式**，支持多读单写
- 设置了 5000ms 忙等待超时
- 适合 <10 个并发客户端的场景

### Q: 忘记管理员密码怎么办？

删除数据库重新启动，或手动修改数据库：
```sql
-- 生成新密码哈希（使用 bcryptjs，saltRounds=10）
-- 然后更新数据库
UPDATE users SET password_hash = '<new_hash>' WHERE username = 'admin';
```

### Q: 如何导入学生名单？

通过 `/api/users/import-csv` 使用批量导入 API 上传 CSV/Excel 文件，一行即可。参见 [ADMIN-GUIDE](./ADMIN-GUIDE.md) 第 4/5 节了解操作说明。

### Q: 自定义 AI 服务商返回 404 怎么办？

1. **检查 Base URL 格式**：确保填写的是 API 端点地址（如 `https://api.openai.com` 或 `https://api.deepseek.com`），而不是网站首页（如 `https://openai.com`）。系统会自动补齐 `/v1` 路径。
2. **检查 Python llmclient 是否运行**：自定义服务商仍需通过 Python 中转服务。运行：
   ```powershell
   py -m uvicorn llmclient.server:app --host 127.0.0.1 --port 8766
   ```
3. **检查 API Key**：确保密钥有效且有余额。
4. **检查模型名称**：模型名需与提供商提供的一致。若不确定，可将模型列表留空，由系统自动获取。

### Q: 扫描图片存储在哪里？

扫描图片默认存储在 `data/recognition/uploads/` 目录下。超过保留期后自动清理。

---

## 文件结构

```
src/server/
├── db/
│   ├── schema.sql           # 完整建表 SQL 快照
│   ├── index.ts             # 数据库连接、初始化编排、密码哈希
│   ├── paths.ts             # projectx.db / answer-card 数据目录 / scanner.db 路径解析
│   ├── migrations.ts        # 版本化幂等迁移（schema_migrations）
│   ├── seeds.ts             # 默认角色与保留策略
│   └── cleanup.ts           # 数据清理脚本 + 定时任务
├── repositories/
│   ├── UserRepository.ts      # 用户 CRUD + 批量导入 + 导出
│   ├── CardRepository.ts      # 答题卡 CRUD（JSON ↔ DB 转换）
│   ├── ExamRepository.ts      # 考试、扫描、成绩存储
│   ├── ClassRepository.ts     # 年级/班级/花名册数据访问
│   ├── ScoreRepository.ts     # 学生成绩查询
│   └── AnalysisRepository.ts  # 分析聚合查询
├── services/
│   └── AuthService.ts         # 登录逻辑、Token 管理（持久化）
├── middleware/
│   └── auth.ts                # Express 认证/鉴权中间件
├── auth/
│   └── permissions.ts         # 权限模型定义
└── routes/
    ├── auth.ts                # 认证 API
    ├── users.ts               # 用户管理 API
    ├── classes.ts             # 班级管理 API
    ├── scores.ts              # 成绩查询 API
    ├── teachers.ts            # 教师管理 API (v1.1)
    ├── export.ts              # 账密导出 API (v1.1)
    └── backup.ts              # 数据库全量备份/恢复 (v1.2.1)
src/types/
├── archiver.d.ts              # archiver v8 ESM 类型声明
└── adm-zip.d.ts               # adm-zip 类型声明
```
```

---

## 更新日志

- **v1.2.1** (06-17) — 数据库全量备份/恢复（ZIP 导出导入），强制考试时间，UI 响应式三级断点，导入模板升级 .xlsx
- **v1.2.0** (06-17) — AI 成绩分析，Electron 探活增强
- **v1.1.5** (06-16) — 阅卷流程重构，多端打包 x86/x64
- **v1.1.0** (06-14) — 教师/学生管理，CSV/Excel 批量导入导出
- **v1.0.x** (06-14) — 答题卡管理，品牌化，登录持久化
- **v0.2.0** (06-11) — SQLite 数据库模块，权限系统，成绩统计

### v1.3.0 (2026-06-17)
- 新增 `objective_questions`，支持同一客观题块内按题配置题型、选项数、分值和评分规则
- `subjective_blocks` 新增 `block_kind`；`subjective_questions` 新增 `blanks_label_style`、`blanks_items_json`
- `exams.card_id` 迁移为可空，支持答题卡被引用时先解绑考试再删除
- 删除答题卡/考试时增加冲突检测、解绑和联删分支，避免 SQLite 外键错误直接暴露给用户

### v1.4.0 (2026-06-18)
- `student_scores` 新增 `assigned_score`（赋分）
- `exams` 新增 `assigned_formula`（赋分公式 JSON）
- `users` 新增 `score_display_mode`（deviation/zscore/percentile）、`review_confidence_threshold`、`ai_api_key`
- 新增 `export_templates` 表（导出模板，4 槽位）
- 新增 `ai_providers` 表（AI 多服务商配置）

#### `ai_providers` — AI 服务商配置

| 列 | 类型 | 说明 |
|-----|------|------|
| `id` | INTEGER PK | 自增主键 |
| `user_id` | INTEGER FK | 所属用户 |
| `name` | TEXT | 自定义名称（如 "我的GPT"） |
| `provider_type` | TEXT | openai / deepseek / gemini |
| `base_url` | TEXT | API 端点地址（Gemini 留空，其余自动补齐 `/v1`） |
| `api_key` | TEXT | API 密钥 |
| `models` | TEXT | JSON 模型列表，为空则自动获取 |
| `is_active` | INTEGER | 0=禁用 1=启用 |

每个教师可配置多个服务商，用于 AI 成绩分析的模型路由。

**Base URL 说明**：填写 API 端点地址而非网站首页。GPT/DeepSeek 等 OpenAI 兼容协议会自动补齐 `/v1`；**Gemini 无需填写 Base URL**（使用 Google 原生 GenAI SDK，仅需 API Key）。
常见的 Base URL 示例：
- **OpenAI**: `https://api.openai.com`（自动补为 `https://api.openai.com/v1`）
- **DeepSeek**: `https://api.deepseek.com`（自动补为 `https://api.deepseek.com/v1`）
- **Gemini**: 无需填写（Google 原生 SDK）
- **Azure**: `https://xxx.openai.azure.com/openai`（含 `/openai` 部署前缀，不自动补 `/v1`）
- **Ollama**: `http://localhost:11434`（自动补为 `http://localhost:11434/v1`）

> ⚠️ **使用前提**：自定义服务商仍需通过 Python llmclient 中转服务。请先启动：
> ```powershell
> py -m uvicorn llmclient.server:app --host 127.0.0.1 --port 8766
> ```

---

_由五中人，为五中人，服务五中教学。_
