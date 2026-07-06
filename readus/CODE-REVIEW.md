# Project-X 代码审查报告

> 审查日期：2026-07-06
> 审查范围：`src/`（后端 API、React 前端、共享业务逻辑）+ `scripts/`
> 审查方法：人工逐文件分析 + `tsc --noEmit` 类型检查
> 类型检查结果：**通过**（无编译错误，问题均为运行时/逻辑/安全类）

---

## 修复状态（本轮）

本轮针对报告中**明确、可验证且低风险**的 bug / 冲突点进行了修复与重构，并新增
`scripts/bugfix-verification.ts` 回归测试（14 项断言全部通过）。回归校验命令：
`npm run typecheck`、`npm run verify:auth`（54 通过）、`npx tsx scripts/grading-rules-smoke.ts`、
`npx tsx scripts/bugfix-verification.ts`。

| 条目 | 状态 | 说明 |
| --- | --- | --- |
| C-S1 | ✅ 已修复 | restore 改用 `execFile` 参数数组 + stdin，消除命令注入 |
| H-S12 | ✅ 已修复 | 扫描上传 `side` 白名单、扩展名白名单、`sessionId` basename 兜底 |
| M-S18 | ✅ 已修复 | ZIP 解压路径检查改用 `path.relative`，防前缀绕过 |
| H-L1 | ✅ 已修复 | 用户 `reviewConfidenceThreshold` 现已传入 Web 阅卷评分链路 |
| H-L2 / L-L11 | ✅ 已修复 | 两份重复 `recomputeRankings` 收敛为共享实现，改用 `competitionRank` |
| M-L4 | ✅ 已修复 | 排名重算统一百分位公式 A（末名 0，下限裁剪） |
| H-L3 | ✅ 已修复 | 成绩编辑/复核 total_score 统一 `roundScore` |
| M-L6 | ✅ 已修复 | 主观题分数增加下限裁剪 `Math.max(0, ...)` |
| M-L3 | ✅ 已修复 | 多页阅卷学号跨页择优取 `status=ok` 结果 |
| M-L2 | ✅ 已修复 | 跨页题目去重纳入置信度，避免复核标记被首页锁死 |
| C-F1 | ✅ 已修复 | `GradingResults` 的 `useState` 移到早返回之前 |
| C-F2 / C-F3 | ✅ 已修复 | `ScannerPanel` 用 ref 追踪 pages/sessionId/scannerMode |
| H-F2 | ✅ 已修复 | 网上阅卷"保存并下一份"真正前进 |
| H-F5 | ✅ 已修复 | SSE `onmessage` 的 `JSON.parse` 加 try/catch（ScannerPanel + App） |
| H-F6 | ✅ 已修复 | 图片压缩释放 `objectURL`，修复内存泄漏 |
| M-F4 | ✅ 已修复 | 扫描 SSE `onerror` 反馈错误状态 |
| L-S2 | ✅ 已修复 | `generateTeacherUsername` 改为异步并检查存在性 |
| L-F8 | ✅ 已修复 | `ClassManagement` CSV 表头正则去重 |
| L-L4 | ✅ 已修复 | `englishTemplate` 移除两分支相同的无意义三元 |

> 其余条目（如 C-S2/C-S3 鉴权默认策略、H-S7 默认密码、性能/虚拟化、a11y、大量 `any`
> 清理等）多属**产品策略决定**或**大范围重构**，改动会影响既有部署行为或超出本轮安全修复
> 范围，暂未在本轮处理，保留在下方清单供后续分批推进。

---

## 总览

| 维度 | Critical | High | Medium | Low | 合计 |
| --- | --- | --- | --- | --- | --- |
| 后端 API / 安全 / 服务 | 3 | 12 | 18 | 15 | 48 |
| 前端 React | 3 | 6 | 10 | 12 | 31 |
| 共享业务逻辑 | 0 | 3 | 13 | 13 | 29 |
| **合计** | **6** | **21** | **41** | **40** | **~108** |

严重程度定义：

- **Critical**：会导致崩溃、数据丢失、或严重安全漏洞（任意代码执行 / 未授权访问敏感数据）。
- **High**：明确的功能 bug、数据不一致、或权限缺失。
- **Medium**：性能问题、竞态条件、UX 缺陷、防御性安全措施不足。
- **Low**：代码质量、类型安全、可访问性、命名/文档问题。

---

## 一、后端 API / 安全 / 服务（48 项）

### 🔴 Critical

#### C-S1 命令注入 — MariaDB 恢复用 `exec()` 拼接 shell 命令

- **文件**：`src/server/routes/backup.ts:403-405`
- **描述**：`restoreMariadb` 函数使用 `child_process.exec()` 将数据库连接参数（host/port/user/password/database）直接拼接到 shell 命令字符串中。这些参数可通过 `PATCH /api/app/db-config` API 写入 `config.yml`。攻击者（或能修改配置的人）可在 password 字段中注入 shell 命令（如 `password'; rm -rf / #`），在服务器上执行任意命令。
- **对比**：同文件的 `backupMariadb` 函数正确使用了 `execFileAsync("mysqldump", args)`（参数数组形式），避免了 shell 注入。但 restore 部分却用了不安全的 `exec()`。
- **代码**：

```typescript
const { exec } = await import("node:child_process");
const cmd = `mysql --host=${host} --port=${port} --user=${user} ${password ? `--password=${password}` : ""} ${database}`;
const child = exec(cmd, { maxBuffer: 512 * 1024 * 1024 }, (err) => { ... });
```

- **修复建议**：改用 `execFile("mysql", ["--host="+host, "--port="+port, ...])` 参数数组形式，与 `backupMariadb` 一致。

#### C-S2 RBAC 鉴权默认关闭 — 所有业务接口无需登录即可访问

- **文件**：`src/apps/answer-card/server/index.ts:415-416`、`src/apps/answer-card/server/middleware.ts:22-27`
- **描述**：`PROJECTX_AUTH_ENFORCE` 环境变量默认未设置，`enforceAuth` 默认为 `false`。`makeGate` 函数在 `enforce` 为 false 时直接 `next()` 放行。这意味着**默认部署下**，所有业务路由（`/api/cards`、`/api/exams`、`/api/analysis`、`/api/review` 等）完全无需认证即可访问，包括创建/删除答题卡、创建/删除考试、修改成绩等敏感操作。
- **代码**：

```typescript
export function makeGate(enforce: boolean, readPerm: string, writePerm: string) {
  return (req, res, next) => {
    if (!enforce) { next(); return; } // ← 默认放行，无任何鉴权
    ...
  };
}
```

- **修复建议**：将 `PROJECTX_AUTH_ENFORCE` 默认设为 `true`，或在生产环境强制开启；至少对写操作（POST/PUT/DELETE）强制鉴权。

#### C-S3 `requireExamAccess` 在无用户时直接放行

- **文件**：`src/apps/answer-card/server/middleware.ts:136-139`
- **描述**：当 `req.user` 不存在时（未登录且未强制鉴权），`requireExamAccess` 直接 `next()` 放行。结合 C-S2，默认部署下任何人可访问任何考试的详情、成绩、分析数据。
- **代码**：

```typescript
export async function requireExamAccess(req, res, next): Promise<void> {
  if (!req.user) { next(); return; } // ← 无用户直接放行
  ...
}
```

- **修复建议**：`requireExamAccess` 在无用户时应拒绝（401）而非放行，除非显式处于非强制鉴权模式且有明确理由。

---

### 🟠 High

#### H-S1 成绩修改路由缺少考试级权限校验

- **文件**：`src/server/routes/score-editing.ts:200, 307`
- **描述**：`PUT /api/exams/:examId/student/:studentId/scores` 和 `PUT /api/exams/:examId/answers` 路由仅通过 `examGate`（角色级 `EXAM_WRITE` 权限）保护，但**未使用 `requireExamAccess`**。所有教师（包括学科教师）可以修改任何考试的学生分数和答案，不受所教班级/科目限制。
- **对比**：`analysis.ts` 和 `review.ts` 中的路由都正确使用了 `requireExamAccess`。
- **修复建议**：为这两个路由添加 `requireExamAccess` 中间件。

#### H-S2 成绩导出路由缺少权限校验 — 学生可导出任何考试的成绩

- **文件**：`src/server/routes/export-scores.ts:86`
- **描述**：`POST /api/export/exams/:examId/scores` 仅使用 `authMiddleware`（只要求登录），不检查 `requireExamAccess`，也不要求 `GRADE_READ` 权限。任何登录用户（包括学生）可导出任何考试的完整成绩表（含姓名、学号、分数、排名）。
- **代码**：

```typescript
router.post("/exams/:examId/scores", async (req, res) => {
  // ← 缺少 requireExamAccess 和 requirePermission(GRADE_READ)
  const examId = Number(req.params.examId);
  ...
});
```

- **备注**：`exportRoutes`（`/api/export/students`、`/api/export/teachers`）正确要求了 `USER_MANAGE` 权限，但 `exportScoresRoutes` 挂载在同一路径下却无权限检查。
- **修复建议**：添加 `requireExamAccess` + `requirePermission(GRADE_READ)`。

#### H-S3 AI 服务商 API Key 明文返回给前端

- **文件**：`src/server/routes/ai-providers.ts:32`、`src/apps/answer-card/server/routes/analysis.ts:37`
- **描述**：`GET /api/ai/providers` 和 `GET /api/analysis/ai/status` 接口将 AI 服务商的 API Key（如 OpenAI/DeepSeek/Gemini 的密钥）完整明文返回给前端。攻击者获取这些密钥后可盗用用户的 AI 账户产生费用。
- **代码**：

```typescript
// ai-providers.ts:27-35
res.json(providers.map((p: any) => ({
  ...
  apiKey: p.api_key,  // ← 明文返回完整 API Key
  ...
})));

// analysis.ts:31-41
function mapAiProvider(p: AiProviderRow) {
  return { ..., apiKey: p.api_key, ... };  // ← 同样明文返回
}
```

- **修复建议**：返回脱敏后的 key（如只显示后 4 位：`••••••••abcd`）；key 本身只在服务端使用，前端如需写入应通过单独的写接口。

#### H-S4 `saveStudentScore` 使用 `REPLACE INTO` 重置所有手动修改和赋分

- **文件**：`src/server/repositories/ExamRepository.ts:170-175`、`src/apps/answer-card/server/scanner/index.ts:44-47`
- **描述**：`saveStudentScore` 使用 `REPLACE INTO student_scores`，这在 SQLite/MariaDB 中是 **DELETE + INSERT** 语义。未指定的列（`rank`、`percentile`、`assigned_score`、`manually_modified`、`modified_by`、`modified_at`）会被重置为默认值。每次重新阅卷/扫描都会**丢失教师手动修改的分数和赋分计算结果**。
- **代码**：

```typescript
await this.db.run(
  "REPLACE INTO student_scores (exam_id, student_id, objective_score, subjective_score, total_score, graded_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)",
  examId, studentId, objectiveScore, subjectiveScore, total);
```

- **修复建议**：改用 `INSERT ... ON CONFLICT(exam_id, student_id) DO UPDATE SET` 仅更新指定列，保留 `manually_modified` 等字段。

#### H-S5 `persistGradingResults` 无事务保护，失败后数据不一致

- **文件**：`src/apps/answer-card/server/index.ts:266-358`
- **描述**：异步持久化阅卷结果时，对每个学生执行多步 DB 操作（确保学生账号、创建扫描记录、保存切块、保存总分、保存逐题分数），**全部没有事务包裹**。若中途失败（如数据库锁、磁盘满），已写入的部分数据会残留，导致考试状态为 `closed` 但成绩数据不完整。此外，该函数在 `res.json()` 之后异步执行（line 1041-1044），用户看到成功但数据可能未保存。
- **修复建议**：用 `db.transaction(async (tx) => {...})` 包裹每个学生的持久化逻辑；或至少在 res.json 之前完成关键写入。

#### H-S6 `CardRepository.updateCard` 非原子操作 — 删除后重插可丢失数据

- **文件**：`src/server/repositories/CardRepository.ts:39-56`
- **描述**：`updateCard` 先 `DELETE FROM objective_blocks WHERE card_id = ?` 和 `DELETE FROM subjective_blocks WHERE card_id = ?`，然后在循环中重新 INSERT。**无事务保护**。若中途出错（如约束冲突、磁盘满），答题卡的块数据被删除但未完整重新插入，导致数据永久丢失。
- **代码**：

```typescript
async updateCard(card: AnswerCard): Promise<void> {
  await this.db.run(`UPDATE answer_cards SET ...`);
  await this.db.run("DELETE FROM objective_blocks WHERE card_id = ?", card.id);
  await this.db.run("DELETE FROM subjective_blocks WHERE card_id = ?", card.id);
  // ← 若以下循环中途失败，数据已丢失
  for (const block of card.bodyBlocks) { ... await this.insertObjectiveBlock(...) }
}
```

- **修复建议**：用事务包裹整个 updateCard 流程。

#### H-S7 默认管理员密码 `admin123` 且无强制修改机制

- **文件**：`src/server/db/index.ts:88, 106`
- **描述**：系统初始化时创建默认管理员，用户名 `admin`，密码 `admin123`。虽然控制台打印了提醒，但**无强制首次登录改密机制**。若部署者忽略提醒，系统可被任何人用默认凭据完全控制。
- **修复建议**：首次登录时强制改密（可在用户表加 `must_change_password` 标志）。

#### H-S8 `changePassword` 允许空密码哈希用户无原密码修改密码

- **文件**：`src/server/services/AuthService.ts:157-162`
- **描述**：修改密码时，若用户当前 `password_hash` 为空字符串，则**跳过原密码验证**。虽然注释说是"默认管理员首次创建"，但这适用于**任何**密码哈希为空的用户。攻击者若能触发某用户密码哈希变为空（如通过批量导入 bug），即可无需原密码直接修改其密码。
- **代码**：

```typescript
if (row.password_hash) {
  const valid = await verifyPassword(oldPassword, row.password_hash);
  if (!valid) return { success: false, message: "原密码错误" };
}
// ← password_hash 为空时直接跳过验证，允许修改密码
```

- **修复建议**：仅在用户名为 `admin` 且确实为首次时跳过验证，或用专门的"首次改密"流程替代。

#### H-S9 登录接口无速率限制 — 可暴力破解密码

- **文件**：`src/server/routes/auth.ts:31-61`
- **描述**：`POST /api/auth/login` 无任何速率限制、账号锁定机制或失败次数统计。攻击者可无限次尝试暴力破解密码。学生默认密码为学号（公开信息），这使得暴力破解尤为有效。
- **修复建议**：添加基于 IP + 账号的速率限制（如 express-rate-limit），连续失败 N 次后锁定一段时间。

#### H-S10 扫描器主路由在强制鉴权模式下无法被 API Key 访问

- **文件**：`src/apps/answer-card/server/index.ts:1567`
- **描述**：`/api/scanner` 路由使用 `scannerGate`（`makeGate(enforceAuth, GRADE_WRITE, GRADE_WRITE)`），当 `enforceAuth` 开启时要求 `req.user` 存在。但扫描端 Electron 应用使用 `X-Api-Key` 认证，不设置 `req.user`。这导致**开启鉴权后扫描端完全无法工作**。`scanner-upload.ts` 正确使用了 `dualAuth`（支持 API Key 或 JWT），但主扫描路由未做同样处理。
- **修复建议**：将 `/api/scanner` 的鉴权改为 `dualAuth`（API Key 或 JWT 均可），与 `scanner-upload.ts` 一致。

#### H-S11 `admin-permissions.ts` 直接使用同步 SQLite，MariaDB 模式下失效

- **文件**：`src/server/routes/admin-permissions.ts:18, 40, 65`
- **描述**：该路由使用 `getDatabase()`（同步 `better-sqlite3` 实例），而非 `getMysqlDb()`（跨方言异步适配器）。在 MariaDB/远程数据库模式下，`getDatabase()` 返回的是本地 SQLite 空库，**教师权限管理功能完全失效**，读写的数据与实际业务数据库不一致。
- **修复建议**：改用 `getMysqlDb()` 适配器，与其他业务路由一致。

#### H-S12 扫描上传 `side` 参数路径遍历

- **文件**：`src/server/routes/scanner-upload.ts:130-131`
- **描述**：文件名构造为 `${sessionId}_p${pageNum}_${side}${ext}`，其中 `side` 来自 `req.body.side`（用户输入），**未做任何 sanitization**。若攻击者发送 `side = "../../evil"`，则 `path.join(scannerUploadDir(), fileName)` 会解析 `..` 导致文件被写到目标目录之外。
- **代码**：

```typescript
const side = (req.body?.side as string) || "front";
const fileName = `${sessionId}_p${String(pageNum).padStart(2, "0")}_${side}${ext}`;
const filePath = path.join(scannerUploadDir(), fileName);
writeFileSync(filePath, req.file.buffer); // ← 路径遍历
```

- **修复建议**：对 `side` 做白名单校验（只允许 `"front"`/`"back"`），或用 `path.basename()` 过滤。

---

### 🟡 Medium（后端）

#### M-S1 CORS 配置为通配符 `*`

- **文件**：`src/apps/answer-card/server/index.ts:422`
- **描述**：`Access-Control-Allow-Origin: *` 允许任何网站跨域访问 API。虽然未设置 `Allow-Credentials`，但 token 可通过 `?token=` 查询参数传递，任何恶意网站可构造包含 token 的 URL 读取 API 响应。
- **修复建议**：限制为已知前端域名或 `same-origin`。

#### M-S2 认证令牌通过查询参数传递 — 日志/Referer 泄露

- **文件**：`src/server/middleware/auth.ts:47-50`
- **描述**：支持 `?token=xxx` 查询参数认证（用于 SSE/PDF）。查询参数会被记录在服务器访问日志、代理日志、浏览器历史和 Referer 头中，导致 token 泄露。
- **修复建议**：改用 `Authorization` 头或短期一次性 URL 签名。

#### M-S3 Token 明文存储在磁盘文件中

- **文件**：`src/server/services/AuthService.ts:28-29, 72-85`
- **描述**：所有有效 token 存储在 `~/.projectx/tokens.json` 明文文件中。任何有文件系统读权限的人可窃取所有在线用户的会话令牌。
- **修复建议**：使用加密存储或改为只存 token 的哈希值。

#### M-S4 错误信息直接返回给客户端 — 内部细节泄露

- **文件**：多处，如 `src/server/routes/users.ts:125,176,204`、`src/server/routes/exam-groups.ts:72,112`、`src/server/routes/scanner-upload.ts:98,145`、`src/server/routes/backup.ts:161,265`、`src/server/routes/api-keys.ts:53`、`src/apps/answer-card/server/routes/paper-routes.ts:165,228,256` 等
- **描述**：大量路由在 catch 中直接返回 `err.message` 给客户端，可能泄露 SQL 错误、文件路径、数据库结构等内部信息。
- **代码**：

```typescript
res.status(500).json({ message: err.message }); // ← 可能泄露 SQL 错误、文件路径
```

- **修复建议**：统一返回通用错误消息，仅在服务端日志记录详细信息。

#### M-S5 SQLite 事务中 `await` 可导致并发请求交叉执行

- **文件**：`src/server/db/mysql.ts:147-160`
- **描述**：SQLite 适配器的事务实现：`begin.run()` → `await fn(this)` → `commit.run()`。由于 `fn` 是 async，在 `await` 点事件循环可能调度其他请求的 DB 操作，这些操作会在当前事务的 `BEGIN`/`COMMIT` 之间执行，被纳入当前事务。目前事务内未包含真正异步操作（如 bcrypt），但若将来添加，会产生数据一致性问题。
- **修复建议**：在事务期间使用 `better-sqlite3` 的同步事务 API（`db.transaction(() => {...})`）。

#### M-S6 文件上传仅检查 MIME 类型，未验证文件内容（magic bytes）

- **文件**：`src/apps/answer-card/server/index.ts:643-649`（card assets）、`src/apps/answer-card/server/index.ts:516-522`（背景图）
- **描述**：多个 multer `fileFilter` 仅检查 `file.mimetype.startsWith("image/")`，而 MIME 类型由客户端控制，可伪造。虽然项目有 `assertImageFile`（magic bytes 验证）工具函数，但**在 recognition 和 assets 上传路由中未被使用**。攻击者可上传伪装成图片的恶意文件。
- **修复建议**：在上传路由中调用 `assertImageFile` 验证 magic bytes。

#### M-S7 MariaDB 连接池启用 `multipleStatements: true`

- **文件**：`src/server/db/mysql.ts:216`
- **描述**：启用多语句执行增加了 SQL 注入攻击的潜在影响（允许堆叠查询）。虽然当前代码使用参数化查询，但作为纵深防御，应在 schema 初始化后关闭此选项。
- **修复建议**：schema 初始化后重建连接池并关闭 `multipleStatements`。

#### M-S8 `initMariadbSchema` 朴素地按 `;` 分割 SQL

- **文件**：`src/server/db/mysql.ts:337-343`
- **描述**：Schema 文件按 `;` 分割后逐条执行。若 SQL 中包含字符串字面量内的 `;`（如 `DEFAULT 'a;b'`）或存储过程/触发器中的 `;`，会被错误分割，导致语法错误或执行非预期 SQL。
- **修复建议**：使用支持完整 SQL 解析的分词器，或改用 `mysql2` 的 `multipleStatements` 一次性执行整个 schema。

#### M-S9 `deleteExamRows` 不使用事务且未清理所有关联数据

- **文件**：`src/apps/answer-card/server/helpers.ts:76-83`
- **描述**：删除考试时逐表 DELETE（`question_scores` → `student_scores` → `scan_batches` → `exams`），无事务包裹。且**遗漏了** `scan_records`、`answer_block_crops`、`answer_overrides`、`objective_recognitions` 等关联表，留下孤儿数据。
- **修复建议**：用事务包裹删除流程，并在 schema 中定义 `ON DELETE CASCADE` 外键。

#### M-S10 自动备份在数据库运行时直接复制文件 — 可能产生损坏的备份

- **文件**：`src/apps/answer-card/server/index.ts:248-263`
- **描述**：`autoBackupOnExamClose` 使用 `copyFile` 直接复制 `projectx.db`。在 WAL 模式下，直接复制主 DB 文件可能得到不含 WAL 中未 checkpoint 数据的不一致副本。
- **修复建议**：使用 `VACUUM INTO` 或 SQLite Backup API（如 `backup.ts` 中的 VACUUM INTO 方式）。

#### M-S11 `recomputeRankings` 在事务外执行 — 可能导致排名不一致

- **文件**：`src/server/routes/score-editing.ts:262`、`src/server/services/ReviewService.ts:231`
- **描述**：`recomputeRankings(db, examId)` 在事务提交后单独调用。若此函数失败（如数据库错误），分数已更新但排名仍为旧值，导致数据不一致。
- **修复建议**：将 `recomputeRankings` 纳入分数更新的事务中。

#### M-S12 `recomputeRankings` 使用顺序排名而非竞争排名 — 与全局排名逻辑不一致

- **文件**：`src/server/routes/score-editing.ts:446-452`
- **描述**：`rank = i + 1` 给出顺序排名（1, 2, 3, 4...），即使有并列分数。但应用其他部分（`AnalysisRepository`、`LadderService`）使用 `competitionRank`（竞争/密集排名）。同一考试在不同页面可能显示不同排名。
- **修复建议**：统一使用 `ranking.ts` 中的 `competitionRank`。

#### M-S13 天梯接口缺少考试访问校验

- **文件**：`src/server/routes/ladder.ts:67, 115, 294`
- **描述**：`GET /api/ladder/exams/:examId` 和 `GET /api/ladder/cross-exam` 未调用 `requireExamAccess`。任何登录用户可查看任何考试的 Top 10 排名（含姓名、学号、班级、分数），即使未参加该考试。`cross-exam` 模式下也未传递 `visibleExamIds` 进行可见性过滤。
- **修复建议**：添加 `requireExamAccess`。

#### M-S14 上传文件数量无限制 — 潜在 DoS

- **文件**：`src/apps/answer-card/server/index.ts:865, 955`
- **描述**：`recognitionUpload.array("files")` 未限制最大文件数量。multer 默认无文件数上限，攻击者可一次上传数千个文件，耗尽磁盘空间或内存。
- **修复建议**：设置 `limits: { files: N }`。

#### M-S15 默认 API Key 输出到控制台日志

- **文件**：`src/server/db/index.ts:122, 130`
- **描述**：`console.log(`[DB] Default scanner API key created: ${key}`)` 将完整的 API Key 输出到 stdout，可能被日志收集系统捕获。
- **修复建议**：只打印 key 的前几位，或提示用户从管理界面查看。

#### M-S16 `persistGradingResults` 中学生密码使用学号 — 自动建账逻辑

- **文件**：`src/apps/answer-card/server/index.ts:303-315`
- **描述**：阅卷持久化时，若学生账号不存在，自动用学号作为用户名和密码创建账号。这意味着任何提交阅卷结果的人（在未鉴权模式下为任何人）可以触发批量学生账号创建，且密码为学号（公开信息）。
- **修复建议**：自动建账应由专门的批量导入流程触发，阅卷时只关联已有学生。

#### M-S17 `getVisibleExamIds` 对无 `teacher_role` 的教师返回 `null`（全部可见）

- **文件**：`src/apps/answer-card/server/middleware.ts:53`
- **描述**：没有 `teacher_role` 字段的教师账号可以看到所有考试（注释说明是"向后兼容"）。这意味着如果管理员创建教师时忘记设置 `teacher_role`，该教师可访问全部考试数据。
- **修复建议**：无 `teacher_role` 时应返回空数组（无可见考试）或要求管理员显式授权。

#### M-S18 ZIP 解压路径检查使用 `startsWith` 可能被前缀绕过

- **文件**：`src/server/routes/backup.ts:469`
- **描述**：`safePath.startsWith(path.resolve(destDir))` 检查中，若 `destDir` 为 `/tmp/abc`，则 `/tmp/abc-evil/file` 也会通过检查（因为 `startsWith` 匹配）。
- **修复建议**：使用 `path.relative()` 检查结果不以 `..` 开头，或在路径末尾加 `path.sep`。

---

### 🟢 Low（后端）

#### L-S1 `/api/app/health` 路由重复注册

- **文件**：`src/apps/answer-card/server/index.ts:430, 602`
- **描述**：健康检查端点注册了两次。第二个（line 602）永远不会被执行（第一个已匹配并响应），是死代码。

#### L-S2 `generateTeacherUsername` 循环逻辑错误

- **文件**：`src/server/repositories/UserRepository.ts:161-166`
- **描述**：for 循环体中第一行就是 `return username;`，永远不会执行第二次迭代。循环毫无意义，生成的用户名可能碰撞。
- **代码**：

```typescript
generateTeacherUsername(): string {
  for (let attempt = 0; attempt < 10; attempt++) {
    const username = `T${crypto.randomInt(100000, 1000000)}`;
    return username; // ← 第一次迭代即返回，循环无效
  }
  return `T${Date.now().toString(36).slice(-6)}${crypto.randomInt(0, 1000)}`;
}
```

- **修复建议**：应先检查用户名是否存在，存在则重试。

#### L-S3 `saveCardWithLayout` 冗余的 create + update

- **文件**：`src/apps/answer-card/server/index.ts:136-139`
- **描述**：新建答题卡时先 `createCard`（INSERT），然后立即 `updateCard`（DELETE 所有块 + 重新 INSERT）。`createCard` 已插入了主记录，`updateCard` 又删除并重插块数据，造成不必要的 DB 操作和潜在失败点。
- **修复建议**：新建时一次性插入完整数据，不调用 updateCard。

#### L-S4 密码策略过于简单

- **文件**：`src/server/auth/passwordPolicy.ts:1`
- **描述**：仅要求 6 位长度，无复杂度要求（无大小写/数字/特殊字符要求），无常见密码黑名单。
- **修复建议**：增加最小复杂度要求和常见弱密码黑名单。

#### L-S5 过期 Token 清理函数未被定时调用

- **文件**：`src/server/services/AuthService.ts:228-238`
- **描述**：`cleanupExpiredTokens` 方法存在但从未在任何地方被调度调用。过期 token 会在 `verifyToken` 时被惰性清理，但 `tokens.json` 文件会持续增长。
- **修复建议**：启动时调用一次，并设置定时清理（如每小时）。

#### L-S6 `recomputeRankings` 性能为 O(n) 逐条 UPDATE

- **文件**：`src/server/routes/score-editing.ts:446-452`、`src/server/services/ReviewService.ts:73-82`
- **描述**：对每个学生执行单独的 UPDATE 语句。大考试（数百名学生）会导致大量 DB 往返。
- **修复建议**：可使用单条 `CASE WHEN` SQL 或批量更新优化。

#### L-S7 CSV 导入未防御 Excel 公式注入

- **文件**：`src/server/routes/users.ts:262-305`、`src/server/repositories/UserRepository.ts:235-315`
- **描述**：导入 CSV 数据时未检查以 `=`、`+`、`-`、`@` 开头的单元格。导出回 Excel 时这些可能被解释为公式执行。
- **修复建议**：导入时对以这些字符开头的字段前缀单引号或拒绝。

#### L-S8 Sponsor 路由无认证

- **文件**：`src/server/routes/sponsor.ts`
- **描述**：赞助相关接口无 `authMiddleware`。虽然是公开页面内容，但若赞助配置包含敏感信息需注意。

#### L-S9 `PRAGMA table_info` 使用字符串插值

- **文件**：`src/server/db/migrations.ts:19`
- **描述**：`db.prepare(`PRAGMA table_info(${tableName})`)` 使用模板字符串插值。虽然 `tableName` 当前均为硬编码常量，不可利用，但属于不安全模式。
- **修复建议**：PRAGMA 不支持参数化，可对 tableName 做白名单校验。

#### L-S10 `hasTable` 函数使用字符串插值

- **文件**：`src/apps/answer-card/server/middleware.ts:128`
- **描述**：`db.get(`SELECT 1 FROM ${table} LIMIT 1`)` 使用模板字符串插值表名。当前 `table` 为硬编码字符串，但若将来接受用户输入则有 SQL 注入风险。
- **修复建议**：对 table 做白名单校验。

#### L-S11 `persistGradingResults` 自动建账使用 `hashPassword(row.studentId)` — 大量 bcrypt 调用

- **文件**：`src/apps/answer-card/server/index.ts:303-308`
- **描述**：对每个学生调用 `hashPassword`（bcrypt），在大量学生场景下会阻塞事件循环（bcrypt 是 CPU 密集型）。
- **修复建议**：使用 `Promise.all` 并行或限制并发，或改为批量预建账号。

#### L-S12 SSE 进度监听器在异常情况下可能泄露

- **文件**：`src/apps/answer-card/server/index.ts:180-181, 829-863`
- **描述**：`gradingProgressSnapshots` 在 done/error 后 60 秒清理，但若进程崩溃或 done 事件未触发，snapshot 会残留。
- **修复建议**：启动时清理残留 snapshot，并设置兜底清理。

#### L-S13 `batchImportFromCsv` 中 `hashPassword` 在事务外但学生查找在事务外且无锁

- **文件**：`src/server/repositories/UserRepository.ts:270-298`
- **描述**：`findByStudentNumber` 和 `usernameExists` 在事务外检查，INSERT 在事务内。并发导入可能导致 TOCTOU 竞态（检查时不存在，插入时已存在），触发 UNIQUE 约束错误。
- **修复建议**：在事务内做存在性检查，或捕获 UNIQUE 冲突重试。

#### L-S14 错误处理中间件将 `error.message` 返回给客户端

- **文件**：`src/apps/answer-card/server/index.ts:1610-1613`
- **描述**：全局错误处理中间件返回 `error instanceof Error ? error.message : "服务器内部错误"`。对于未预期的错误（如 DB 错误），`error.message` 可能包含敏感信息。
- **修复建议**：对非 `ApiError` 类错误返回通用消息，仅 `ApiError` 的 message 可安全返回。

#### L-S15 `autoBackupOnExamClose` 路径拼接依赖相对路径

- **文件**：`src/apps/answer-card/server/index.ts:252`
- **描述**：`path.join(dataDir, "..", "projectx.db")` 依赖 `dataDir` 为 `data/answer-card`。若 `ANSWER_CARD_DATA_DIR` 设置为其他绝对路径，`..` 会指向错误目录。
- **修复建议**：直接使用 `resolveProjectDbPath()`。

---

## 二、前端 React（31 项）

### 🔴 Critical

#### C-F1 GradingResults 组件违反 Hooks 规则 — 条件性调用 useState

- **文件**：`src/apps/answer-card/client/App.tsx:2591-2606`
- **描述**：`GradingResults` 组件在 `if (!result) { return ... }` 早返回**之后**才调用 `useState`（行 2605-2606）。当 `result` 从 `null` 变为非 `null`（阅卷完成时），Hook 调用数量从 0 变为 2，React 会抛出 `"Rendered more hooks than during the previous render"` 错误，导致阅卷结果界面崩溃。
- **代码**：

```tsx
function GradingResults({ result, onDownloadCsv }) {
  if (!result) {
    return (<div className="grading-empty">...</div>);  // 早返回
  }
  // ↓ 这些 useState 在 result 非空时才执行
  const [previewPages, setPreviewPages] = useState<ScanPage[] | null>(null);
  const [previewTitle, setPreviewTitle] = useState("");
```

- **修复建议**：将所有 `useState` 移到早返回**之前**，或始终渲染组件、在内部判断 `result` 是否为空。

#### C-F2 ScannerPanel 闭包陷阱 — onScansComplete 传回错误的 pageCount

- **文件**：`src/apps/answer-card/client/components/ScannerPanel.tsx:114-176, 162`
- **描述**：`listenProgress(sid)` 在 `startScan` 中被调用时，`pages` 状态刚被重置为 `[]`。`es.onmessage` 闭包捕获的 `pages` 永远是初始的 `[]`。当 `"done"` 事件到达时，`onScansComplete?.(sid, pages.length)` 传回 `0`，而非实际扫描页数。后续 `fetchCombinedResults` 也基于错误的页数。
- **代码**：

```tsx
// 行 162: pages.length 始终为 0（闭包捕获的旧值）
case "done":
  setState("done");
  onScansComplete?.(sid, pages.length);  // BUG: 永远是 0
```

- **修复建议**：使用 `setPages` 的回调或 `useRef` 跟踪当前页数，在 `onmessage` 中读取最新值。

#### C-F3 ScannerPanel uploadToRemote 使用过期的 pages 和 scannerMode

- **文件**：`src/apps/answer-card/client/components/ScannerPanel.tsx:167, 191-245`
- **描述**：`"done"` 事件中通过 `setTimeout(() => void uploadToRemote(), 500)` 调用 `uploadToRemote`，该函数闭包捕获了 `listenProgress` 调用时的 `pages`（空数组）和 `scannerMode`。上传循环 `for (let i = 0; i < pages.length; i++)` 永远不会执行，因为 `pages.length === 0`。
- **修复建议**：用 `useRef` 保存最新的 `pages` 和 `scannerMode`，或改为在 `setState("done")` 后通过 `useEffect` 触发上传。

---

### 🟠 High（前端）

#### H-F1 TeacherManagement 搜索框每次按键都触发 API 请求（无防抖）

- **文件**：`src/apps/answer-card/client/components/TeacherManagement.tsx:39-55, 74, 233`
- **描述**：`loadTeachers` 是 `useCallback([keyword, selectedId])`，`keyword` 每次按键变化都会重建函数。`useEffect(() => { void loadTeachers(); }, [loadTeachers])` 因此每次按键都触发一次网络请求，没有防抖。虽然有 Enter 键搜索（行 234），但 useEffect 已经在每次按键时自动发请求了。
- **修复建议**：从 `loadTeachers` 的依赖中移除 `keyword`，或添加防抖/移除自动触发的 useEffect。

#### H-F2 OnlineReviewPanel "保存并下一份"与"仅保存"行为相同

- **文件**：`src/apps/answer-card/client/components/OnlineReviewPanel.tsx:158-162`
- **描述**：`setIndex` 的回调中，`advance` 为 `true` 和 `false` 两个分支返回**完全相同**的值 `Math.min(value, refreshed.rows.length - 1)`。`advance` 参数完全无效，"保存并下一份"不会前进到下一份。
- **代码**：

```tsx
setIndex((value) => {
  if (refreshed.rows.length === 0) return 0;
  if (advance) return Math.min(value, refreshed.rows.length - 1);      // 相同
  return Math.min(value, refreshed.rows.length - 1);                    // 相同
});
```

- **修复建议**：`advance` 为 `true` 时应 `return Math.min(value + 1, refreshed.rows.length - 1)`。

#### H-F3 多处使用原生 fetch 绕过 apiUrl，配置 API base 后请求路径错误

- **文件**：
  - `src/apps/answer-card/client/components/AccountMenu.tsx:147, 257, 287`（背景图上传、数据库备份导出、数据库恢复导入）
  - `src/apps/answer-card/client/components/TeacherManagement.tsx:164`（教师导出）
  - `src/apps/answer-card/client/components/ClassManagement.tsx:379`（学生导出）
- **描述**：这些地方使用 `fetch("/api/...")` 而非 `authFetch` 或 `fetchJson`，绕过了 `apiUrl()` 函数。当用户通过 `localStorage.projectx_server_url` 或 `VITE_PROJECTX_API_BASE` 配置了 API 基础地址时，这些请求会发往错误地址（相对路径而非配置的服务器）。同时也不携带 `X-Api-Key` 头。
- **修复建议**：统一使用 `authFetch` 替换原生 `fetch`。

#### H-F4 TeacherManagement 创建教师时 CSV 注入风险

- **文件**：`src/apps/answer-card/client/components/TeacherManagement.tsx:187`
- **描述**：手动创建教师时，直接将用户输入拼接到 CSV 字符串中：`` `科目,姓名\n${newTeacherSubject.trim()},${newTeacherName.trim()}` ``。如果姓名包含逗号、引号或换行符，CSV 格式会被破坏，可能导致数据错乱或注入。
- **修复建议**：对 CSV 字段进行转义（用双引号包裹并转义内部引号），或使用专用的 CSV 构建函数。

#### H-F5 ScannerPanel EventSource JSON.parse 无 try/catch

- **文件**：`src/apps/answer-card/client/components/ScannerPanel.tsx:120` 和 `src/apps/answer-card/client/App.tsx:1341`
- **描述**：`es.onmessage` 中 `JSON.parse(event.data)` 没有 try/catch。如果服务器推送了非 JSON 数据（如连接保持的心跳消息），会抛出未捕获异常，导致整个 SSE 监听崩溃。
- **修复建议**：用 try/catch 包裹 `JSON.parse`。

#### H-F6 PaperUploadPanel 图片压缩函数内存泄漏

- **文件**：`src/apps/answer-card/client/components/PaperUploadPanel.tsx:298-326`
- **描述**：`compressImageFile` 中调用 `URL.createObjectURL(file)` 创建对象 URL，但**从未调用** `URL.revokeObjectURL` 释放。每次压缩图片都会泄漏一个 blob URL。在大量上传场景下会持续占用内存。
- **修复建议**：在 `img.onload` 和 `img.onerror` 回调中调用 `URL.revokeObjectURL(img.src)`。

---

### 🟡 Medium（前端）

#### M-F1 App.tsx mobileNavItems 的 useMemo 因不稳定依赖完全失效

- **文件**：`src/apps/answer-card/client/App.tsx:545-574`
- **描述**：`useMemo` 的依赖数组包含 `loadExams` 和 `loadExamGroups`，但这两个是普通函数声明（非 `useCallback`），每次渲染都会重建。因此 `useMemo` 每次渲染都会重新计算，完全失去了记忆化效果。
- **修复建议**：将 `loadExams`、`loadExamGroups` 用 `useCallback` 包裹，或从依赖中移除。

#### M-F2 App.tsx 大量异步操作无 AbortController，存在竞态和卸载后 setState 风险

- **文件**：`src/apps/answer-card/client/App.tsx` 多处（如 `loadExams:1391`, `loadAnalysis:1411`, `loadCard:861`, `gradeAnswerCardFiles:1360` 等）
- **描述**：几乎所有数据获取函数都没有使用 `AbortController` 取消请求。如果组件卸载或依赖快速变化（如用户快速切换考试），旧请求完成后会 `setState` 已卸载的组件，或覆盖 newer 的数据。特别是 `loadAnalysis` 中 `setAnalysisExamId(examId)` 在 fetch 之前就设置了，如果 fetch 失败，UI 状态不一致。
- **修复建议**：为关键的数据获取添加 `AbortController`，在 `useEffect` cleanup 中取消。

#### M-F3 App.tsx 阅卷考试下拉框 onChange 中的 async 竞态

- **文件**：`src/apps/answer-card/client/App.tsx:2000-2011`
- **描述**：`<select onChange={async (e) => { ... await loadCard(exam.card_id); ... }}>` 如果用户快速切换考试选择，多个 `loadCard` 调用并发执行，最后完成的那个覆盖结果，可能加载了错误的答题卡。
- **修复建议**：用 AbortController 或版本号 guard 防止旧请求覆盖新结果。

#### M-F4 ScannerPanel EventSource onerror 无状态反馈，用户看到"卡住"

- **文件**：`src/apps/answer-card/client/components/ScannerPanel.tsx:173-175` 和 `src/apps/answer-card/client/App.tsx:1355-1357`
- **描述**：`es.onerror = () => { es.close(); }` — 关闭了 EventSource 但没有更新任何状态。如果 SSE 连接中断，进度条会永久停留在中间状态，用户无任何反馈。
- **修复建议**：在 `onerror` 中设置错误状态和提示消息。

#### M-F5 App.tsx ImportCardModal 关闭时错误地清除全局 isBusy

- **文件**：`src/apps/answer-card/client/App.tsx:2229`
- **描述**：`onClose={() => { setShowImportCardModal(false); setImportCardData(null); setIsBusy(false); }}` — 关闭导入弹窗时调用 `setIsBusy(false)`，但如果有其他操作正在进行（如答题卡保存），会错误地清除全局 busy 状态，允许用户在不应操作时点击按钮。
- **修复建议**：移除 `setIsBusy(false)`，让 isBusy 由实际操作管理。

#### M-F6 ScoreDetailPage 多个 load 函数并发调用导致 loading 状态闪烁

- **文件**：`src/apps/answer-card/client/components/ScoreDetailPage.tsx:67-73, 80-93`
- **描述**：`useEffect` 同时调用 `loadOverview()`, `loadQuestions()`, `loadRanking()`, `loadProgressRankings()`, `loadPreviousComparison()` 五个异步函数。每个都有独立的 try/catch/finally，`loadOverview` 的 finally 中 `setLoading(false)` 会在第一个完成时就清除 loading，但其他四个可能还在加载。切换 classId 时 `setLoading(true)` 没有被调用（只有初始的 `useState(true)`），所以切换班级时不会显示 loading 状态。
- **修复建议**：用统一的 loading 计数器或 `Promise.all` 管理加载状态。

#### M-F7 AccountMenu 设置弹窗缺少 ESC 关闭和焦点陷阱

- **文件**：`src/apps/answer-card/client/components/AccountMenu.tsx:487-799`
- **描述**：设置弹窗通过 `createPortal` 渲染到 `document.body`，有 `modal-overlay` 类名。App.tsx 的全局 ESC 处理器（行 654）检测到 `.modal-overlay` 后会 `return`（让 modal 自行处理），但 AccountMenu 的设置弹窗本身**没有** ESC 键监听。按 ESC 无反应，用户只能点击关闭按钮。同时没有焦点陷阱（focus trap），Tab 键会跳出弹窗。
- **修复建议**：添加 ESC 键监听关闭弹窗，实现焦点陷阱。

#### M-F8 大量 setTimeout 未清理，组件卸载后 setState

- **文件**：
  - `src/apps/answer-card/client/components/AccountMenu.tsx:133, 157, 198, 209, 246`
  - `src/apps/answer-card/client/components/DragDropZone.tsx:45, 61`
  - `src/apps/answer-card/client/components/ScannerPanel.tsx:167`
  - `src/apps/answer-card/client/components/LoginPageScanner.tsx:47`
- **描述**：多处 `setTimeout(() => setState(...), N)` 没有保存 timer ID，也没有在组件卸载时 `clearTimeout`。如果组件在定时器触发前卸载，会触发 setState on unmounted。`ScannerPanel:167` 的 `setTimeout` 尤其有问题——组件卸载后仍会触发 `uploadToRemote`。
- **修复建议**：用 `useRef` 保存 timer ID，在 `useEffect` cleanup 中清理。

#### M-F9 大量大列表未虚拟化，性能堪忧

- **文件**：
  - `src/apps/answer-card/client/App.tsx:1490-1525`（cards 列表）
  - `src/apps/answer-card/client/App.tsx:1906-1937`（exams 列表）
  - `src/apps/answer-card/client/components/ScoreTable.tsx:204-240`（成绩表）
  - `src/apps/answer-card/client/components/ExamSelectPage.tsx:380-394`（考试选择列表）
  - `src/apps/answer-card/client/components/ScannerPanel.tsx:499-521`（学生结果表）
- **描述**：所有列表都使用 `.map()` 全量渲染。`CardSelectPage` 甚至请求 `/api/cards?limit=500` 一次性加载500张卡。当数据量大时（几百名学生、几百场考试），DOM 节点过多会导致渲染卡顿。
- **修复建议**：对可能超过 50-100 项的列表引入虚拟滚动（如 `react-window`）。

#### M-F10 NewCardModal 日历下拉无点击外部关闭

- **文件**：`src/apps/answer-card/client/components/NewCardModal.tsx:133-206`
- **描述**：`DatePicker` 的日历弹出层 `showCalendar` 只能通过再次点击按钮关闭。用户打开日历后点击页面其他地方，日历不会关闭，UX 体验差。
- **修复建议**：添加 `useEffect` 监听 `document.pointerdown` 事件，点击外部时关闭日历。

---

### 🟢 Low（前端）

#### L-F1 大量 `any` 类型滥用，削弱类型安全

- **文件**：多处，共 30+ 处
- **关键位置**：
  - `App.tsx:406, 413, 830, 842, 1495, 1954, 2355, 2772, 3060-3126`（`as any` 断言、`catch (e: any)`）
  - `AccountMenu.tsx:98, 111, 186, 391`
  - `CardSelectPage.tsx:91, 93, 322`
  - `ScoreFixPage.tsx:21, 37`（`scoringRule: any`）
  - `AnalysisCharts.tsx:55, 89, 136`（chart options `as any`）
- **修复建议**：定义正确的类型接口，避免 `any` 和不必要的类型断言。

#### L-F2 多个组件使用 `React.CSSProperties` 等但未导入 React 命名空间

- **文件**：
  - `src/apps/answer-card/client/components/ScoreTable.tsx:257`
  - `src/apps/answer-card/client/components/ExamSelectPage.tsx:460, 464`
  - `src/apps/answer-card/client/components/CardSelectPage.tsx:15, 19`
  - `src/apps/answer-card/client/components/ExportModal.tsx:104`
  - `src/apps/answer-card/client/components/ScoreFixPage.tsx:105`
  - `src/apps/answer-card/client/components/StudentScores.tsx:26`
  - `src/apps/answer-card/client/components/ClassManagement.tsx:295`
  - `src/apps/answer-card/client/components/ImportModal.tsx:39`
- **描述**：这些文件只导入了具体的 hooks（如 `import { useState } from "react"`），却使用 `React.CSSProperties` 等 `React` 命名空间下的类型。这依赖 tsconfig 的 `jsx: react-jsx` 隐式提供全局 `React` 命名空间，不够明确。
- **修复建议**：改为 `import type { CSSProperties } from "react"` 并使用 `CSSProperties`。

#### L-F3 main-scanner.tsx 缺少 ErrorBoundary

- **文件**：`src/apps/answer-card/client/main-scanner.tsx:9-15`
- **描述**：Web 入口 `main.tsx` 用 `<ErrorBoundary>` 包裹了 `<App>`，但 Scanner 入口 `main-scanner.tsx`**没有**包裹 `<ScannerApp>`。Scanner 端发生未捕获的渲染错误时，整个应用白屏且无恢复 UI。
- **修复建议**：在 `main-scanner.tsx` 中也用 `<ErrorBoundary>` 包裹。

#### L-F4 大量 `confirm()` / `alert()` 阻塞式对话框，UX 不一致

- **文件**：
  - `App.tsx:987, 1516`（`confirm`）
  - `ClassManagement.tsx:189, 229, 275, 377`
  - `TeacherManagement.tsx:162`
  - `ExportModal.tsx:158`（`alert`）
- **描述**：项目其他地方使用了自定义 modal（如删除确认弹窗），但这些位置仍使用浏览器原生的 `confirm()`/`alert()`，风格不统一且阻塞主线程。
- **修复建议**：统一使用项目内的自定义 modal 组件。

#### L-F5 a11y 可访问性问题汇总

- **文件**：多处
- **具体问题**：
  - `DragDropZone.tsx:70-104`: 拖拽区域 `div` 有 `onClick` 但无 `role="button"`、无 `tabIndex`、无键盘事件处理，键盘用户无法使用。
  - `ScoreTable.tsx:171-199`: 排序按钮在 `<th>` 内用 `<button>` 包裹，但 `<th>` 不能包含交互式 button（HTML 验证不通过）。
  - `App.tsx:2232`: 导出检查 modal 的 `modal-backdrop` 点击关闭，但无 `role="dialog"`、无 `aria-modal="true"`。
  - `ScanPreviewModal.tsx:72-141`: modal 无 `role="dialog"`、无 `aria-modal`、无焦点陷阱。
  - `ExamSelectPage.tsx:414-445`: 删除确认 modal 无焦点管理、无 ESC 处理、无 ARIA 角色。
  - 多个 `<button>` 使用 emoji（如 🤖 📋 📤）作为唯一内容，缺少 `aria-label`。
- **修复建议**：补充 ARIA 角色、键盘交互、焦点管理、aria-label。

#### L-F6 App.tsx useEffect 依赖数组遗漏函数依赖（stale closure 风险）

- **文件**：`src/apps/answer-card/client/App.tsx:602, 615, 671, 678`
- **描述**：
  - 行 602: `useEffect(..., [])` 引用了 `saveCurrentCardBestEffort` 和 `clearAutoSaveTimer`，但二者不在依赖中。虽然通过 ref 工作正常，但 ESLint `exhaustive-deps` 会警告。
  - 行 678: `useEffect(..., [mode, exams.length])` 调用 `loadExams` 但未包含在依赖中。如果 `loadExams` 失败导致 `exams` 仍为 `[]`，effect 不会重试。
- **修复建议**：用 `useCallback` 包裹引用的函数并加入依赖，或确认 ref-based 设计是有意为之并添加注释。

#### L-F7 AnalysisAiPanel useEffect 依赖遗漏 loadStatus

- **文件**：`src/apps/answer-card/client/components/AnalysisAiPanel.tsx:97-100`
- **描述**：`useEffect(() => { setAnalysis(null); void loadStatus(); }, [examId, classId])` — `loadStatus` 不在依赖中且非 `useCallback`。每次 `examId`/`classId` 变化时 effect 重新运行，捕获的是当时渲染的 `loadStatus`，功能正确但 ESLint 会警告。
- **修复建议**：将 `loadStatus` 用 `useCallback` 包裹。

#### L-F8 ClassManagement parseCsv 重复正则项

- **文件**：`src/apps/answer-card/client/components/ClassManagement.tsx:60`
- **描述**：`/学号|student_number|学号/` — `学号` 出现了两次，是无意义的重复。
- **修复建议**：改为 `/学号|student_number/`。

#### L-F9 图表组件未 memo 化，频繁重渲染

- **文件**：`src/apps/answer-card/client/components/AnalysisCharts.tsx:48, 67, 102`
- **描述**：`ScoreDoughnut`、`ComparisonBar`、`TrendLine` 组件未用 `React.memo` 包裹。Chart.js canvas 渲染开销大，父组件每次重渲染都会触发图表重绘。`resolveColor` 每次渲染都调用 `getComputedStyle`。
- **修复建议**：用 `React.memo` 包裹图表组件，memoize `chartData` 和 `options`。

#### L-F10 App.tsx cloneCard 使用 JSON.parse(JSON.stringify()) 深拷贝

- **文件**：`src/apps/answer-card/client/App.tsx:186-188`
- **描述**：`JSON.parse(JSON.stringify(card))` 是深拷贝的简写，但会丢失 `Date` 对象、`undefined` 值、函数等。对于答题卡数据可能勉强可用，但不够健壮。
- **修复建议**：考虑使用 `structuredClone()`（现代浏览器支持）或 `import { cloneDeep } from "lodash-es"`。

#### L-F11 ScoreDetailPage 使用 key 强制 remount ScoreTable 作为刷新手段

- **文件**：`src/apps/answer-card/client/components/ScoreDetailPage.tsx:76-78, 358`
- **描述**：`displayMode` 变化时 `setScoreTableKey((k) => k + 1)`，通过改变 `key` 强制 `ScoreTable` 完全重新挂载。这丢失了组件内部状态（排序、搜索等），是一种反模式。
- **修复建议**：将 `displayMode` 作为 prop 传入，在 `ScoreTable` 内部用 `useEffect` 响应变化重新获取数据。

#### L-F12 ScannerPanel useEffect 空依赖但引用 cardId prop

- **文件**：`src/apps/answer-card/client/components/ScannerPanel.tsx:85-90`
- **描述**：`useEffect(() => { detectSources(); ... }, [])` 依赖为空，但 `detectSources` 内部不引用 `cardId`。如果 `cardId` 变化（父组件传入新卡），组件不会重新检测扫描仪。不过因为父组件 `ScannerWorkspace` 在切换卡片时会重新挂载 `ScannerPanel`，所以实际不影响。但依赖设计不严谨。
- **修复建议**：添加注释说明依赖设计，或将 `detectSources` 用 `useCallback` 包裹并加入依赖。

---

## 三、共享业务逻辑（29 项）

### 🟠 High

#### H-L1 用户配置的复核置信度阈值 `reviewConfidenceThreshold` 完全未生效

- **文件**：`src/shared/grading.ts:149`、`src/shared/types.ts:953`、`src/apps/answer-card/server/index.ts:452,466`
- **描述**：`gradeObjectiveQuestion` 的 `confidenceThreshold` 默认值为硬编码常量 `OBJECTIVE_REVIEW_CONFIDENCE_THRESHOLD = 0.12`。系统允许用户在设置中配置 `reviewConfidenceThreshold`（存入 DB `review_confidence_threshold` 字段，见 index.ts:452/466），但**所有调用方均未将该值传入** `gradeObjectiveQuestion`：
  - `gradeObjectiveRecognition` (grading.ts:246) 调用 `gradeObjectiveQuestion(card, recognized)` —— 不传阈值
  - `score-editing.ts:401` 调用 `gradeObjectiveQuestion(card, {...})` —— 不传阈值
  - `grading-rules-smoke.ts:36` 同上

  因此用户调整该设置后对阅卷复核判定**没有任何效果**，`needsReview` 永远按 0.12 判定。
- **代码**：

```typescript
// grading.ts:146-155
export function gradeObjectiveQuestion(
  card: AnswerCard,
  question: ObjectiveRecognitionQuestion,
  confidenceThreshold = OBJECTIVE_REVIEW_CONFIDENCE_THRESHOLD  // 始终用默认值
): ObjectiveQuestionGrade {
  ...
  const needsReview = confidence < confidenceThreshold;
```

```typescript
// types.ts:953  用户设置中定义了字段，但从未被读取用于评分
export interface UserSettings {
  scoreDisplayMode: ScoreDisplayMode;
  reviewConfidenceThreshold: number;   // ← 形同虚设
}
```

- **修复建议**：在调用 `gradeObjectiveQuestion` 时从用户设置读取 `reviewConfidenceThreshold` 并传入。

#### H-L2 `recomputeRankings` 用顺序名次 `i+1` 而非竞赛排名，与全局排名逻辑不一致

- **文件**：`src/server/routes/score-editing.ts:437-453` 和 `src/server/services/ReviewService.ts:65-82`（两处重复实现，同一 bug）
- **描述**：该函数在成绩编辑/复核提交后重算并存入 `student_scores.rank`。它直接用 `rank = i + 1` 顺序赋值，**没有处理同分并列**。而项目其它所有排名（`AnalysisRepository`、`LadderService`、`exam-groups` 路由）都使用 `competitionRank`（同分同名次，跳过下一名）。这导致：
  1. 同分学生得到不同名次（如 90,90,80 → 名次 1,2,3 而非 1,1,3）
  2. SQL `ORDER BY total_score DESC` 对同分行的顺序是非确定性的，并列学生的名次随机
  3. 写入的 `percentile` 用 `(1 - i/n)` 公式，与 ScoreRepository/LadderService 读取时用的 `((total-rank)/(total-1))` 公式不一致

  虽然当前多数查询会在读取时用 `competitionRank` 重算（缓解了表面影响），但该列被写入错误值且代码重复两份，属于明确的逻辑错误与潜在数据不一致源。
- **代码**：

```typescript
// score-editing.ts:446-452
for (let i = 0; i < allStudents.length; i++) {
  const rank = i + 1;   // ← 顺序名次，同分不并列
  const percentile = n > 1 ? Math.round((1 - i / n) * 1000) / 10 : 100;
  await db.run(
    "UPDATE student_scores SET `rank` = ?, percentile = ? WHERE id = ?",
    rank, percentile, allStudents[i].id
  );
}
```

对比 `ranking.ts` 正确实现：

```typescript
// ranking.ts:14-24  competitionRank 处理同分并列
if (prevScore !== null && s === prevScore) {
  setRank(rows[i], prevRank);   // 同分 → 同名次
} else {
  const rank = i + 1; ...
}
```

- **修复建议**：统一使用 `ranking.ts` 中的 `competitionRank`，消除两份重复实现。

#### H-L3 成绩编辑后 `totalScore` 未做舍入，浮点误差可能破坏并列判定

- **文件**：`src/server/routes/score-editing.ts:396-426`
- **描述**：重算客观分时 `totalObj += grade.score` 在循环中累加（不舍入），最后 `const totalScore = totalObj + subjScore.total` 也不舍入直接写入 DB。而 `grading.ts` 的 `gradeCombinedRecognition` 对所有汇总都用 `roundScore`（×1000/1000）。浮点累加会产生如 `85.30000000000001` 的伪影，而 `competitionRank` 用 `===` 严格比较判同分——两个本应并列的 85.3 分会因一个为 85.3、另一个为 85.30000001 而得到不同名次。
- **代码**：

```typescript
// score-editing.ts:396-426
let totalObj = 0;
for (...) {
  totalObj += grade.score;        // ← 累加不舍入
}
const totalScore = totalObj + subjScore.total;  // ← 不舍入直接存库
await tx.run(`UPDATE student_scores SET ... total_score = ? ...`, totalObj, totalScore, ...);
```

对比 grading.ts 的正确做法：

```typescript
// grading.ts:250
const score = roundScore(grades.reduce((sum, item) => sum + item.score, 0));
```

- **修复建议**：在 score-editing.ts 中对 `totalObj` 和 `totalScore` 调用 `roundScore` 后再入库。

---

### 🟡 Medium（共享逻辑）

#### M-L1 分数舍入精度全代码库不统一（3 位 / 2 位 / 1 位）

- **文件**：`src/shared/grading.ts:272`、`src/shared/cardScoreValidation.ts:42`、`src/server/repositories/AnalysisRepository.ts:30`
- **描述**：三套不同舍入精度并存：
  - `grading.ts` `roundScore`：`Math.round(v*1000)/1000`（3 位小数）
  - `cardScoreValidation.ts` `roundScore`：`Math.round(v*100)/100`（2 位小数）
  - `AnalysisRepository.ts` `round1`：`Math.round(v*10)/10`（1 位小数）

  `cardScoreValidation` 校验出的 `totalScore` 与 `grading` 实际产出的 `totalScore` 可能有 0.005 级别差异，导致校验提示"总分为 X.XX 分"与实际存储的 X.XXX 不符。
- **代码**：

```typescript
// grading.ts:271-273
function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;   // 3 位
}
// cardScoreValidation.ts:41-43
function roundScore(value: number): number {
  return Math.round(value * 100) / 100;     // 2 位 ← 不一致
}
```

- **修复建议**：统一为单一 `roundScore` 实现（建议 3 位），各处引用之。

#### M-L2 多页/双面阅卷去重逻辑忽略 `needsReview`/置信度，低置信度首页会"锁死"

- **文件**：`src/shared/grading.ts:400-415`
- **描述**：`gradeSessionStudentResults` 跨页去重时只比较 `missing_key` 状态和 `score`，**不考虑 `needsReview`/置信度**。若第 1 页某题低置信度（`needsReview=true`，score=3，status=review），第 2 页同题高置信度（score=3，status=correct），因 `existing.score < q.score` 为 false（相等），不会替换——复核标记被第 1 页"锁死"，即使第 2 页有可信读数。主观题去重（408-415）有同样问题。
- **代码**：

```typescript
// grading.ts:401-407
for (const q of row.questions) {
  const existing = objQMap.get(q.questionNumber);
  if (!existing || (existing.status === "missing_key" && q.status !== "missing_key") ||
      (existing.score < q.score && q.status !== "missing_key")) {
    objQMap.set(q.questionNumber, q);   // ← 同分但不复核的更好结果不会被采纳
  }
}
```

- **修复建议**：去重时纳入 `needsReview`/置信度，优先选高置信度结果。

#### M-L3 多页阅卷 `studentId` 恒取 `pages[0]`，后续页识别成功被忽略

- **文件**：`src/shared/grading.ts:447`
- **描述**：`studentId: pages[0]?.recognition.studentId?.value ?? "未识别"` 恒定取第一页的学号识别值。若首页学号识别失败（值为 null 或 status 非 ok）但后续页识别成功，仍用首页结果，学生被标记为"未识别"。应与题目去重一样择优。
- **代码**：

```typescript
// grading.ts:447
studentId: pages[0]?.recognition.studentId?.value ?? "未识别",
```

- **修复建议**：跨页择优选 `status === "ok"` 的学号识别结果。

#### M-L4 百分位存在两套互不一致的计算公式

- **文件**：`src/server/repositories/AnalysisRepository.ts:335`、`src/server/services/LadderService.ts:24`、`src/server/repositories/ScoreRepository.ts:61,115`、`src/server/routes/score-editing.ts:448`、`src/server/services/ReviewService.ts:75`
- **描述**：两种公式并存，对同一名次给出不同百分位：
  - 公式 A（LadderService / ScoreRepository）：`(total - rank) / (total - 1) * 100` —— 末名得 0
  - 公式 B（AnalysisRepository percentile 模式 / score-editing / ReviewService）：`(1 - (rank-1)/total) * 100` 或 `(1 - i/n)*100` —— 末名得 100/n（非 0）

  例：10 人考试第 10 名：公式 A = 0，公式 B = 10。不同页面显示不同值，用户困惑。
- **代码**：

```typescript
// LadderService.ts:24  公式A
return Math.round(((total - rank) / (total - 1)) * 10000) / 100;
// AnalysisRepository.ts:335  公式B
dv = Math.round((1 - (s.gradeRank - 1) / allStudents.length) * 1000) / 10;
```

- **修复建议**：统一为单一百分位公式（建议公式 A，末名得 0 更直观）。

#### M-L5 `class_size` 字段实际存的是"考试总人数"而非班级人数，命名误导

- **文件**：`src/server/repositories/ScoreRepository.ts:48-50,97`
- **描述**：`getStudentScores` 和 `getStudentTrendData` 的 SQL 中 `class_size` 子查询是 `SELECT COUNT(*) FROM student_scores WHERE exam_id = ...`（全考试人数），并非该学生所在班级的人数。该值用于百分位计算，结果是"年级百分位"被标为基于 `classSize`。`StudentTrendPoint.classSize` 类型注释也写的是班级人数，实际却是全考人数。
- **代码**：

```typescript
// ScoreRepository.ts:48-50
(
  SELECT COUNT(*) FROM student_scores s3 WHERE s3.exam_id = ss.exam_id
) AS class_size   // ← 实际是考试总人数，不是班级人数
```

- **修复建议**：按班级过滤 COUNT，或将字段重命名为 `exam_size` 并修正类型注释。

#### M-L6 主观题分数未做下限裁剪，负分可能入库

- **文件**：`src/shared/grading.ts:307`
- **描述**：`score: Math.min(recognition.score, maxScore)` 只裁剪上限，未裁剪下限。若识别端返回负数（异常情况），负分会原样进入汇总并计入 totalScore，进而影响排名。
- **代码**：

```typescript
// grading.ts:307
score: Math.min(recognition.score, maxScore),   // ← 缺 Math.max(0, ...)
```

- **修复建议**：改为 `Math.max(0, Math.min(recognition.score, maxScore))`。

#### M-L7 单选题标准答案含多个选项时被静默截断为首个，无任何告警

- **文件**：`src/shared/grading.ts:107-108,125`
- **描述**：`normalizeObjectiveAnswerKey` 对 `mode === "single"` 且答案多于 1 个时，取 `[options[0]]` 丢弃其余。教师若把单选题答案误配为 `[A, B]`（本意可能是"A 或 B"），系统静默改成 `[A]`，B 永远算错，且无告警。`cardScoreValidation` 也不检测此情况。
- **代码**：

```typescript
// grading.ts:107-111
if (question.mode === "single" && options.length > 1) {
  normalized[question.questionNumber] = [options[0]];   // ← 静默丢弃 B 及之后
}
```

- **修复建议**：在 `cardScoreValidation` 中对此情况告警，或在评分时记录警告。

#### M-L8 `isFillBlankBlock` 在校验模块与布局模块判定逻辑不一致

- **文件**：`src/shared/cardScoreValidation.ts:63-66` vs `src/shared/layout.ts:910-915`，另涉 `src/server/repositories/CardRepository.ts:103,193`
- **描述**：三处用三种不同启发式判定"填空题块"：
  - `cardScoreValidation`：有 blockKind 看 blockKind；否则看"所有题目 kind=blank"
  - `layout`：有 blockKind=fill_blank；否则需 `!title.includes("解答")`**且** 所有 blank
  - `CardRepository`：看 `title.includes("填空")`

  当一个块 `blockKind` 未设、title 含"解答"、但所有题为 blank 时：校验模块判为填空（按填空计分/校验），布局模块判为解答（逐题渲染），CardRepository 判为解答。同一答题卡在不同子系统里被当成不同类型，分数校验与实际渲染/计分错位。
- **代码**：

```typescript
// cardScoreValidation.ts:63-66  不看 title
function isFillBlankBlock(block: SubjectiveBlock): boolean {
  if (block.blockKind) return block.blockKind === "fill_blank";
  return block.questions.length > 0 && block.questions.every((q) => q.kind === "blank");
}
// layout.ts:910-915  多了 !title.includes("解答")
const isFillBlankBlock =
  block.blockKind === "fill_blank" ||
  (!block.blockKind && !block.title.includes("解答") && ...);  // ← 多一个条件
```

- **修复建议**：抽取为单一共享函数，三处统一引用。

#### M-L9 主观题高度计算用的 scoreHeader(11) 与实际布局用的 SCORE_HEADER_HEIGHT(10) 不一致

- **文件**：`src/shared/layout.ts:613` vs `src/shared/layout.ts:447,638`
- **描述**：`subjectiveQuestionHeight` 用 `scoreHeader = 11` 估算总高度，但 `addSubjectiveQuestion` 实际预留 `SCORE_HEADER_HEIGHT = 10`。1mm 差异导致内容区比规划高/矮 1mm，长期看会造成分页/对齐偏差。
- **代码**：

```typescript
// layout.ts:613
const scoreHeader = question.style === "manual_score_grid" ? 11 : 0;   // ← 11
// layout.ts:447
const SCORE_HEADER_HEIGHT = 10;                                         // ← 10
// layout.ts:638
const scoreHeaderH = question.style === "manual_score_grid" ? SCORE_HEADER_HEIGHT : 0;
```

- **修复建议**：估算处也用 `SCORE_HEADER_HEIGHT` 常量。

#### M-L10 `getScoreValues` 对非整数（X.5）分值题不生成 0 分格

- **文件**：`src/shared/layout.ts:425-443`
- **描述**：整数分值题生成 `[N..0, 0.5]`（含 0 分格）；但非整数分值（如 2.5）走 `for (value=score; value>=0; value-=1)`，得到 `[2.5, 1.5, 0.5]`，**不含 0**。大于 16 的分支又包含 0。三种路径对"0 分格"的处理不一致：X.5 分题无 0 分格，教师无法在格上标记 0 分（除非依赖"不涂=0"约定，但整数分题又显式给了 0 格，约定不统一）。
- **代码**：

```typescript
// layout.ts:434-443
const values: number[] = [];
for (let value = score; value >= 0; value -= 1) { values.push(value); }
if (!Number.isInteger(score)) {
  return values;          // ← 2.5 → [2.5,1.5,0.5]，缺 0
}
values.push(0.5);
return values;            // ← 5 → [5,4,3,2,1,0,0.5]，有 0
```

- **修复建议**：统一 0 分格的生成规则。

#### M-L11 拼音转换对常用字（与、法等）缺失，导致 key 损失/碰撞/全部回落"zhinan"

- **文件**：`src/shared/pinyin.ts:25-47,54-72`
- **描述**：`PINYIN_MAP` 缺很多常用科目字（如"与""法""经""济"等）。常见学科"道德与法治"逐字转换：德→de、与→(缺，丢弃)、法→(缺，丢弃)、治→zhi，结果 `dezhi`（丢失两个音）。更严重：任何全由未映射字组成的科目名会返回空字符串，最终 `result.slice(0,16) || "zhinan"` 全部回落为 `"zhinan"`，多个自定义科目共享同一 key 产生碰撞。另外去重逻辑 `!seen.has(py)` 会让同音字（如"数/书"都 shu）只保留首个，进一步加剧碰撞。
- **代码**：

```typescript
// pinyin.ts:70-71
const result = pinyins.join("");
return result.slice(0, 16) || "zhinan";   // ← 全未命中时多科目共用 "zhinan"
```

- **修复建议**：扩充拼音表，或改用完整拼音库（如 `pinyin-pro`）；回落值应保证唯一性（如附加 hash）。

#### M-L12 多选/不定项题未配 scoringRule 时，`canPartial=true` 却得分 0，行为反直觉

- **文件**：`src/shared/grading.ts:206-215`
- **描述**：对 multiple/indefinite 题，`canPartial` 只看模式不看是否配了规则。若教师建了一道多选题但**没配 scoringRule**，学生选了部分正确（无错选）时：`canPartial=true` → `partialScoreFor(undefined,...)` 返回 `undefined` → `score = undefined ?? wrongOrExtraScoreFor(undefined) = 0`。即"部分正确"得 0 分且状态被判为 wrong，与"全对才得分"的预期可能不符，且 `cardScoreValidation` 不提示缺规则。模板里所有多选题都配了规则，但自定义题目存在此陷阱。
- **代码**：

```typescript
// grading.ts:212-215
const partialScore = canPartial
  ? partialScoreFor(definition.scoringRule, selectedCorrectCount, correctOptions.length)  // 无规则→undefined
  : undefined;
const score = partialScore ?? wrongOrExtraScoreFor(definition.scoringRule);  // → 0
```

- **修复建议**：未配 scoringRule 的多选题应明确按"全对才得分"处理（canPartial=false），或在 `cardScoreValidation` 中提示缺规则。

#### M-L13 `generateCardId` 注释称"确定性"实为时间相关，同毫秒同科目生成同 ID

- **文件**：`src/shared/defaultCard.ts:7-20`，调用方 `src/apps/answer-card/server/index.ts:701-705,1330-1335`
- **描述**：注释写"确定性 8 位纯数字""同一科目同一毫秒生成同一 ID"，但 `seed = subject + Date.now()` 含时间，跨毫秒即不同，并非确定性。同毫秒同科目会产生**相同 ID**（哈希相同）。调用方有 `while (findById && retry<100)` 重试缓解（重试时加后缀改变哈希），所以不会真正冲突入库，但"确定性"命名误导，且重试在极端并发下仍可能漏（retry 上限 100）。
- **代码**：

```typescript
// defaultCard.ts:12-20
export function generateCardId(subject: string): string {
  const seed = `${subject}_${Date.now()}`;   // ← 非确定性
  ...
}
```

- **修复建议**：修正注释，或改用真正的确定性算法（如基于 subject + 随机数 + 库存在性检查）。

---

### 🟢 Low（共享逻辑）

#### L-L1 `competitionRank` 强依赖调用方预先降序排序，未排序则名次全错

- **文件**：`src/shared/ranking.ts:5-6,14-24`
- **描述**：注释"假设 rows 已按 score 降序排列"是唯一契约，函数内部不校验。一旦某调用方忘排序，名次静默错误。当前各调用方都排了序，但 API 脆弱。另外 `s === prevScore` 对浮点严格比较，若分数未统一舍入可能漏并列；`null`/`NaN` 分数的处理也不直观。
- **修复建议**：函数内部自行排序，或在文档中强调契约并对浮点比较加容差。

#### L-L2 多处"dense ranking"注释写错（实为 competition ranking）

- **文件**：`src/server/routes/exam-groups.ts:485,490,561,698`；`src/server/routes/ladder.ts`
- **描述**：注释写"dense ranking"（1,2,2,3），但代码用的是 `competitionRank`（1,2,2,4 跳名次）。行为本身一致（全用 competition），但注释会误导维护者去"修正"。
- **修复建议**：修正注释为"competition ranking"。

#### L-L3 `blankCount`(校验) 与 `blankQuestionCount`(布局) 对空 `items` 数组结果不同

- **文件**：`src/shared/cardScoreValidation.ts:72-75` vs `src/shared/layout.ts:487-489`
- **描述**：当 `blanks.items = []`（空数组）且 `count>1` 时：校验模块走 `if(items?.length)` 为 falsy → 返回 `count`；布局模块 `items?.length ?? count` → `0 ?? count = 0` → `max(1,0)=1`。两者一返回 count 一返回 1，校验以为有 N 空、布局只画 1 空。正常数据 items 不会为空数组，属边界情况。
- **代码**：

```typescript
// cardScoreValidation.ts:72-75
function blankCount(question) {
  if (question.blanks?.items?.length) return question.blanks.items.length;  // []→falsy→走下面
  return Math.max(1, question.blanks?.count ?? 1);                          // → count
}
// layout.ts:487-489
function blankQuestionCount(question) {
  return Math.max(1, question.blanks?.items?.length ?? question.blanks?.count ?? 1); // []→0→1
}
```

- **修复建议**：统一为单一实现。

#### L-L4 `englishTemplate` 三元表达式两分支返回同一字符串

- **文件**：`src/shared/cardTemplates.ts:187`
- **描述**：`objectiveBlock(withListening ? "客观题" : "客观题", questions)` 两分支都是"客观题"，三元无意义，疑似漏改（可能想区分"听力"与"非听力"标题）。死代码/易误导。
- **代码**：

```typescript
objectiveBlock(withListening ? "客观题" : "客观题", questions)  // ← 两边一样
```

- **修复建议**：确认意图，修正分支或移除三元。

#### L-L5 模板默认分值不完整，触发校验告警

- **文件**：`src/shared/cardTemplates.ts:192-216`（数学/物理）、`252-260`（化学）
- **描述**：
  - 数学：解答题 q15 `linedQuestion(15, 0, 72)` 分值 0；总分=73（非 100/150）
  - 物理：填空/解答均 0 分；总分=46
  - 化学：15×3+4×12=93（非 100/150）

  化学/数学/物理不是 `isFlexibleTotalSubject`（只豁免语文/英语/外语），所以 `validateCardScores` 会对这些模板默认卡报"总分为 X 分，通常应为 100 或 150 分"及"分值疑似过低"。模板作为脚手架可理解，但化学 93 分接近 100，疑似 answerBlankQuestion 应为 13 而非 12（4×13=52，+48=100）。
- **修复建议**：校正模板分值，或将这些科目加入 `isFlexibleTotalSubject` 豁免。

#### L-L6 `objectiveMaxRowsForAvailableHeight` 首行高度估算少算 0.9mm

- **文件**：`src/shared/layout.ts:314-318`
- **描述**：首行高度用 `FRAME_TOP+INNER_TOP+optionHeight+INNER_BOTTOM = 6.2+2.4+2.5+2.2=13.3`，但 `objectiveHeightForQuestions` 实际首行还含 `OBJECTIVE_OPTION_TOP_OFFSET=0.9`，即 14.2。估算偏乐观 0.9mm，可能让一个本放不下的段被判定"放得下"，后续由 `ensureSpace`+warning 兜底，不会崩，但偶发排版告警。
- **修复建议**：估算时加上 `OBJECTIVE_OPTION_TOP_OFFSET`。

#### L-L7 非连续题号块的 `questionCount` 字段语义不准

- **文件**：`src/shared/cardTemplates.ts:33-49`、`src/shared/grading.ts:70-73`
- **描述**：如语文模板客观题块含题号 [1,2,6,10,11,12,15]（7 题，跨 1-15），`objectiveBlock` 设 `questionCount=7`、`questionStart=1`。若 `block.questions` 缺失走 legacy 路径，会按 `questionStart+0..6` 生成 [1,2,3,4,5,6,7]，与真实题号不符。模板都带 `questions` 所以目前安全，但 `questionCount` 字段对非连续块语义错误，是潜在隐患。
- **修复建议**：legacy 路径应基于 `questionStart` 和实际题号集合生成，或废弃 legacy 路径。

#### L-L8 `LadderService.percentile` 当 rank>total 时返回负值

- **文件**：`src/server/services/LadderService.ts:22-25`
- **描述**：`((total - rank) / (total - 1)) * 100`，若传入 rank>total（异常但未防护），结果为负百分位。无下限裁剪。
- **修复建议**：加 `Math.max(0, ...)` 下限裁剪。

#### L-L9 `gradeCombinedRecognition` 对 `subjectiveQuestions` 做 `?? []` 防御，但类型声明为必填

- **文件**：`src/shared/grading.ts:325`、`src/shared/types.ts:298`
- **描述**：类型 `CombinedRecognitionResult.subjectiveQuestions: SubjectiveRecognitionQuestion[]`（必填），但代码 `(recognition.subjectiveQuestions ?? [])` 暗示实际可能 undefined。类型与运行时假设不符。
- **修复建议**：改为可选类型并在入口校验，或保持必填但移除冗余 `?? []`。

#### L-L10 `gradeSessionStudentResults` 主观题去重 key 用 `String(questionId) || String(questionNumber)`，空 questionId 时有碰撞风险

- **文件**：`src/shared/grading.ts:409`
- **描述**：当 `questionId` 为空字符串时回落到 `questionNumber`，若多个题 questionId 为空且 questionNumber 相同（或都为 0/空），会错聚合。正常数据 questionId 唯一，属边界。
- **修复建议**：对空 questionId 抛错或用 questionNumber+blockIndex 复合 key。

#### L-L11 `recomputeRankings` 逐行 UPDATE，大批量时性能差

- **文件**：`src/server/routes/score-editing.ts:446-453`、`src/server/services/ReviewService.ts:73-82`
- **描述**：N 个学生 N 次 UPDATE，未用单条 JOIN/窗口函数更新。大考场景下性能不佳，且两处重复实现。
- **修复建议**：用单条 `CASE WHEN` SQL 或窗口函数批量更新；抽取为单一实现。

#### L-L12 `blankScoreQuestion` 在 `cardScoreValidation` 与 `layout` 中重复定义

- **文件**：`src/shared/cardScoreValidation.ts:68-70` 与 `src/shared/layout.ts:565-567`
- **描述**：两处完全相同的函数定义，改一处漏一处会产生不一致。
- **修复建议**：抽到共享工具模块。

#### L-L13 `formatBlankLabel` 罗马数字仅支持到 50，超过无法表示

- **文件**：`src/shared/blankLabels.ts:3-22`
- **描述**：`romanNumeral` 数值表最大 50（"l"）。空白数 >50 时结果不完整。填空题极少 50+ 空，影响极小。
- **修复建议**：补充更大的罗马数字映射，或改用算法生成。

---

## 四、测试覆盖评估

### `scripts/grading-rules-smoke.ts`（102 行）

- **覆盖**：仅覆盖客观题部分得分（per_selected_count / by_correct_count / fixed_partial / indefinite）的 9 个用例，全部经手工推演验证正确。
- **未覆盖**（重要缺口）：
  - 低置信度触发的 `review` 状态
  - `missing_key`（无标准答案）路径
  - 题号不在卡内的兜底分支
  - 单选题多答案截断（M-L7）
  - `roundScore` 汇总与浮点
  - 主观题 `gradeSubjectiveRecognition`（含负分、裁剪）
  - `gradeCombinedRecognition` 总分合成
  - `gradeSessionStudentResults` 多页去重（M-L2/M-L3）
  - 无 scoringRule 的多选题（M-L12）

### `scripts/verify-auth.ts`（352 行）

- 53 项 auth/RBAC/班级/查分/趋势/统计用例，含奇偶样本量分位数（验证 `percentile` 插值正确）。
- **未覆盖**：排名并列场景（同分），建议补同分用例以锁定 competitionRank 行为。

---

## 五、数据一致性总览

下表汇总跨模块的不一致定义，是多个 bug 的根因：

| 概念 | 定义位置 | 不一致点 | 关联条目 |
| --- | --- | --- | --- |
| 分数舍入精度 | grading(3位)/validation(2位)/Analysis(1位) | 三套并存 | M-L1 |
| 百分位公式 | LadderService(A)/Analysis(B)/score-editing(B) | 两套并存 | M-L4 |
| 填空块判定 | validation/layout/CardRepository 三套 | 三套并存 | M-L8 |
| blank 计数 | validation 的 blankCount / layout 的 blankQuestionCount | 空数组分支不同 | L-L3 |
| 名次算法 | competitionRank(全局) / 顺序i+1(recomputeRankings) | 两套并存 | H-L2 |
| 置信度阈值 | 用户设置(可配) / grading(硬编码0.12) | 设置未生效 | H-L1 |
| class_size | 类型注释(班级) / SQL(考试总数) | 命名误导 | M-L5 |
| scoreHeader | 高度估算(11) / 实际布局(10) | 1mm 偏差 | M-L9 |

---

## 六、修复优先级建议

### 第一优先级（立即修复 — 安全 + 崩溃）

1. **C-S1** 命令注入 — 改用 `execFile` 参数数组
2. **C-S2 / C-S3** 鉴权默认放行 — 生产环境强制开启 RBAC
3. **C-F1** 阅卷结果必崩 — 移动 useState 到早返回之前
4. **C-F2 / C-F3** 扫描上传失效 — 用 useRef 修复闭包

### 第二优先级（高 — 功能 bug / 数据丢失 / 权限）

5. **H-S4** REPLACE INTO 丢失手动改分 — 改用 ON CONFLICT UPDATE
6. **H-S5 / H-S6** 无事务保护 — 为 updateCard / persistGradingResults 加事务
7. **H-S1 / H-S2 / H-S3 / H-S13** 权限缺失 — 补 requireExamAccess / 脱敏 API Key
8. **H-S12** 路径遍历 — side 参数白名单
9. **H-S11** admin-permissions 错库 — 改用 getMysqlDb
10. **H-S10** 扫描端鉴权后失效 — 改用 dualAuth
11. **H-F2** 保存并下一份不前进 — 修正 advance 分支
12. **H-L1** 置信度阈值无效 — 调用时传入用户设置值
13. **H-L2 / H-L3** 排名/舍入不一致 — 统一用 competitionRank + roundScore

### 第三优先级（中 — 一致性 / 性能 / UX）

14. 统一 M-L1（舍入精度）、M-L4（百分位公式）、M-L8（填空块判定）各收敛为单一实现
15. 修复 M-L2 / M-L3（多页阅卷去重纳入置信度/学号择优）
16. 前端竞态：M-F2 / M-F3 加 AbortController
17. 安全加固：M-S1 CORS、M-S2 token 查询参数、M-S4 错误脱敏、M-S6 magic bytes

### 第四优先级（低 — 代码质量）

18. 清理 `any`、统一类型导入、补 ErrorBoundary、a11y、提取重复实现

---

*本报告由逐文件人工审查生成，所有条目均经源码定位验证。建议按优先级分批修复，每批修复后运行 `npm run typecheck` 与 `npm run verify:auth` 回归。*
