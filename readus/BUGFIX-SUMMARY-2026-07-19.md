# Project-X「修正网阅系统」分支 Bug 修复总结

> **分支**：`修正网阅系统` (v1.9.0) | **执行日期**：2026-07-18 ~ 2026-07-19
> **路径**：`C:\Users\xujia\Desktop\五中自研试卷星\Project-X`
> **设计依据**：`readus/CODE-REVIEW.md` + 静态扫描 + 源码逐文件核查
> **范围**：P0（数据完整性 + 安全 + 崩溃类）+ P1（用户体验 + 类型安全 + 限速）+ P2 小型项

---

## 一、项目背景

- **项目定位**：大连市第五中学信息化部（I.T.C.）自研智能试卷管理系统
- **技术栈**：React 19 + Express 5 + TypeScript 5.9 + SQLite/MariaDB + Electron 39 + C++/OpenCV
- **当前分支工作**：v1.9.0 网上阅卷系统全面重构，相对 main 改动 42 文件 / +4609 行
- **工作区状态**：clean，与 `origin/修正网阅系统` 同步

---

## 二、检验发现的问题

### 2.1 显式标记
- 源码中仅 1 处 TODO（`llmclient/server.py:120`），无 FIXME/BUG/XXX/HACK

### 2.2 静态坏味道
| 类别 | 数量 | 典型问题 |
|------|------|---------|
| 吞错（空 catch） | 35 处 | `server/index.ts:1253/1376` 导入导出吞错、`backup.ts` 7 处吞错 |
| `as any` 滥用 | 120+ 处 | `server/index.ts`（26）、`AnalysisRepository.ts`（21） |
| 自动化测试 | 无 | 无 test 脚本、无测试框架 |

### 2.3 CODE-REVIEW.md 未修复项
- **9 个 P0**：鉴权默认关闭、事务缺失、默认密码、吞错等
- **4 个 P1**：登录无限速、CORS 通配符、前端 catch 吞错、as any 滥用
- **6 大类 P2**：Token 明文、SQLite 事务、列表虚拟化、as any 全面清理、测试补全等

---

## 三、修复方案与执行结果

### 3.1 用户决策确认（3 项）

| 决策点 | 用户选择 |
|--------|---------|
| C-S2 鉴权默认关闭如何修复？ | **默认开启**（推荐方案 A），提供 `PROJECTX_AUTH_ENFORCE=0` 逃生开关 |
| H-S7 默认密码 admin123 如何处理？ | **仅警告不强制**（不改 schema，避免数据库迁移） |
| H-S9 登录限速如何实现？ | **同意新增** `express-rate-limit` 依赖 |

---

### 3.2 P0 修复（9 项全完成）

#### P0-1 导出答题卡 base64 吞错（数据完整性）
- **文件**：`src/apps/answer-card/server/index.ts`
- **现状**：导出答题卡时读取 assets 文件用 `catch {}` 完全吞错，磁盘错误/权限问题导致导出文件缺图但显示成功
- **修复**：收集 `failedAssets: string[]`，响应 JSON 追加 `warnings: { failedAssets }`，控制台 `console.warn` 记录
- **验证**：制造不可读 assets 文件，确认响应含 `warnings.failedAssets`

#### P0-2 导入答题卡写文件吞错（数据完整性）
- **文件**：`src/apps/answer-card/server/index.ts`
- **现状**：导入答题卡时写文件用 `catch {}` 吞错，用户看到"导入成功"但答题卡缺图
- **修复**：收集 `failedImports: string[]`，追加 `warnings.failedImports`，校验 base64 解码后 buffer 长度
- **验证**：构造损坏 base64 导入文件，确认响应含 `warnings.failedImports`

#### P0-3 备份/恢复流程吞错（数据完整性 — 关键路径）
- **文件**：`src/server/routes/backup.ts`
- **现状**：8 处吞错（closeDb/closeDatabase/archive error/cleanupDir/moveDir）
- **修复**：
  - 关键路径（恢复时 `closeDatabase`）失败 → 抛错中止返回 500
  - `closeDb`（scanner DB）失败 → warn 继续（非核心数据）
  - `cleanupDir` 内部 → warn 记录
  - `moveDir` → 向上抛错让调用方感知
- **验证**：锁定 DB 调用恢复接口，确认返回 500

#### P0-4 C-S2 鉴权默认关闭（安全）⚠️ Breaking Change
- **文件**：`src/apps/answer-card/server/index.ts`
- **现状**：`PROJECTX_AUTH_ENFORCE` 默认 false，所有业务路由无登录可访问
- **修复**：改为默认 true，仅显式设 `0`/`false` 才关闭
```ts
const enforceAuth =
  process.env.PROJECTX_AUTH_ENFORCE !== "0" && process.env.PROJECTX_AUTH_ENFORCE !== "false";
```
- **缓解**：提供 `PROJECTX_AUTH_ENFORCE=0` 逃生开关，升级文档需醒目提示

#### P0-5 C-S3 requireExamAccess 无用户时放行（安全）
- **文件**：`src/apps/answer-card/server/middleware.ts`
- **现状**：`if (!req.user) { next(); return; }` 无用户直接放行
- **修复**：添加模块级 `authEnforced` 变量 + `setAuthEnforced()` 导出，`enforceAuth=true` 时无用户返回 401
- **联动**：`index.ts` 的 `createApp` 中调用 `setAuthEnforced(enforceAuth)`

#### P0-6 H-S5 persistGradingResults 无事务保护（数据一致性）
- **文件**：`src/apps/answer-card/server/index.ts`
- **现状**：7 步操作（建账→补密码→查学生→扫描记录→切块→总分→题目分数）无事务，中途失败残留半成品
- **修复**：用 `db.transaction(async (tx) => {...})` 包裹每个学生处理，`db.run`→`tx.run`，添加 `failedStudents` 记录
- **技术细节**：闭包内提取 `const studentId = row.studentId` 保证 TypeScript 类型收窄

#### P0-7 H-S6 CardRepository.updateCard 无事务（数据一致性）
- **文件**：`src/server/repositories/CardRepository.ts`
- **现状**：DELETE 块数据后循环 INSERT，中途失败块数据永久丢失
- **修复**：用 `this.db.transaction(async (tx) => {...})` 包裹，`insertObjectiveBlock`/`insertSubjectiveBlock` 加 `tx: DbAdapter` 参数

#### P0-8 H-S7 默认管理员密码 + 登录警告（安全）
- **文件**：`AuthService.ts` + `auth.ts` + `AuthContext.tsx` + `db/index.ts` + `types.ts`
- **现状**：admin 默认密码 `admin123`，无任何登录提示
- **修复**（仅警告不强制）：
  - `AuthService.login` 验证成功后检测 admin + 默认密码，返回 `warning` 字段
  - `auth.ts` 的 `res.json` 传递 `warning`
  - `AuthContext.tsx` 的 `login` 函数返回 warning，延迟 200ms 弹 `window.alert`
  - `db/index.ts` 的 `console.log` 改为 `console.warn` 加强措辞
- **验证**：全新数据库登录 admin/admin123，确认弹窗提示

#### P0-9 H-S8 changePassword 空密码哈希绕过（安全）
- **文件**：`src/server/services/AuthService.ts`
- **现状**：`if (row.password_hash) { 验证原密码 }` — 空 hash 跳过验证
- **修复**：空 hash 视为异常状态，返回"账户密码状态异常，请联系管理员重置"
- **注意**：login 流程的学生空 hash 自动补齐逻辑保持不变（那是登录路径）

---

### 3.3 P1 修复（3 项完成 + 1 项部分完成）

#### P1-1 H-S9 登录无速率限制（安全）
- **文件**：`src/server/routes/auth.ts` + `package.json`
- **现状**：`POST /api/auth/login` 无任何速率限制，可暴力破解
- **修复**：新增 `express-rate-limit` 依赖，配置 15 分钟/10 次/IP
```ts
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  standardHeaders: true, legacyHeaders: false,
  message: { message: "登录尝试过于频繁，请 15 分钟后重试" }
});
router.post("/login", loginLimiter, async (req, res) => { ... });
```

#### P1-2 M-S1 CORS 通配符（安全）
- **文件**：`src/apps/answer-card/server/index.ts`
- **现状**：`res.setHeader("Access-Control-Allow-Origin", "*")` 允许任意域
- **修复**：从 `PROJECTX_CORS_ORIGIN` 环境变量读取白名单（逗号分隔），默认 `http://127.0.0.1:5173,http://localhost:5173`，动态校验 Origin

#### P1-3 前端 .catch(() => {}) 治理（用户体验）
- **文件**：`src/apps/answer-card/client/auth/api.ts`
- **现状**：17 处前端 `.catch(() => {})` 让接口失败用户无感知
- **修复**：在 `fetchJson` 内部 `throw error` 之前加全局 `console.warn` 记录，一处覆盖所有调用点
- **说明**：完整的 UI error 状态展示留作后续增强

#### P1-4 as any 治理（部分完成）
- **文件**：`src/apps/answer-card/server/index.ts`
- **已完成**：`(_req as any).user.userId ?? (_req as any).user.id` → `_req.user!.id`（8 处）
- **剩余**：约 39 处（card/block/row/user 字段类型补全），需定义 `ExamRow`/`Block` 子类型接口，工作量大

---

### 3.4 P2 小型项修复（3 项完成）

#### P2-1 M-S3 Token 明文存储（安全）
- **文件**：`src/server/services/AuthService.ts`
- **现状**：`tokenStore` 的 key 是明文 token，磁盘 `tokens.json` 也存明文
- **修复**：添加 `hashToken()` 函数（SHA-256），`login`/`verifyToken`/`logout` 中用 `hashToken(token)` 作为 Map key
- **影响**：现有会话失效（用户需重新登录），安全升级可接受

#### L-S5 cleanupExpiredTokens 定时调度
- **文件**：`src/server/services/AuthService.ts`
- **现状**：有 `cleanupExpiredTokens` 方法但无定时调用
- **修复**：构造函数中 `setInterval(() => this.cleanupExpiredTokens(), 60 * 60 * 1000)` + `timer.unref()`

#### L-S13 CSV 公式注入防御
- **文件**：`App.tsx` + `ScannerWorkspace.tsx`
- **现状**：CSV 导出无公式注入防御
- **修复**：对以 `= + - @ \t \r` 开头的单元格加前缀单引号 `'`
```ts
const safe = /^[=+\-@\t\r]/.test(cell) ? `'${cell}` : cell;
```

---

## 四、验证结果（全通过）

| 验证脚本 | 结果 |
|---------|------|
| `npm run typecheck` | ✅ 0 错误 |
| `npx tsx scripts/bugfix-verification.ts` | ✅ 18 checks passed |
| `npm run verify:auth` | ✅ 54 通过，0 失败 |
| `npx tsx scripts/ranking-integration-check.ts` | ✅ ok |
| `npx tsx scripts/grading-rules-smoke.ts` | ✅ ok |

---

## 五、修改文件清单（15 个）

### 核心业务代码
| 文件 | 涉及修复项 |
|------|-----------|
| `src/apps/answer-card/server/index.ts` | P0-1, P0-2, P0-4, P0-5, P0-6, P1-2, P1-4 |
| `src/apps/answer-card/server/middleware.ts` | P0-5 |
| `src/server/routes/backup.ts` | P0-3 |
| `src/server/repositories/CardRepository.ts` | P0-7 |
| `src/server/services/AuthService.ts` | P0-8, P0-9, P2-1, L-S5 |
| `src/server/db/index.ts` | P0-8 |
| `src/server/routes/auth.ts` | P0-8, P1-1 |

### 前端代码
| 文件 | 涉及修复项 |
|------|-----------|
| `src/apps/answer-card/client/auth/AuthContext.tsx` | P0-8 前端 |
| `src/apps/answer-card/client/auth/types.ts` | P0-8 |
| `src/apps/answer-card/client/auth/api.ts` | P1-3 |
| `src/apps/answer-card/client/App.tsx` | L-S13 |
| `src/apps/answer-card/client/components/ScannerWorkspace.tsx` | L-S13 |

### 配置
| 文件 | 涉及修复项 |
|------|-----------|
| `package.json` | P1-1 新增 `express-rate-limit` |

---

## 六、Breaking Change 风险与缓解

| 修复 | Breaking? | 影响范围 | 缓解措施 |
|------|-----------|---------|---------|
| P0-4 (C-S2) 鉴权默认开启 | ⚠️ 是 | 所有未携带 token 的请求被拒 | `PROJECTX_AUTH_ENFORCE=0` 逃生开关 + 升级文档 |
| P0-8 (H-S7) 默认密码警告 | 否 | 仅 admin 登录时多 warning + 弹窗 | 不阻断访问，可关闭 |
| P1-2 (M-S1) CORS 收紧 | 部分 | 非白名单域跨域请求被拒 | 默认含开发环境 origin，生产需配置 `PROJECTX_CORS_ORIGIN` |
| P2-1 (M-S3) Token 哈希 | 是（轻微） | 现有会话失效 | 用户需重新登录，安全升级可接受 |

---

## 七、新增依赖

| 依赖 | 版本 | 用途 | 风险 |
|------|------|------|------|
| `express-rate-limit` | latest | P1-1 登录限速 | 低，轻量成熟库 |

**无数据库迁移**（P0-8 采用"仅警告不强制"方案，不新增 `must_change_password` 字段）。

---

## 八、待后续处理

### 8.1 P1-4 剩余 as any（约 39 处）
- `(card as any).examDate` / `subjectLabel` → 补全 `AnswerCard` 类型
- `(block as any).questions` → 定义 Block 子类型联合 + 类型守卫
- `(row as any).subject` / `subject_label` / `exam_date` → 定义数据库行类型接口
- `(user as any).score_display_mode` 等 → 补全 `UserRecord` 类型
- **工作量**：中，纯类型重构不改运行时行为

### 8.2 P2-6 剩余子项（12+ 项）
| 编号 | 问题 | 修复方向 |
|------|------|---------|
| M-S2 | token 查询参数 | 改为短期一次性 URL 签名 |
| M-S4 | 错误信息脱敏 | 统一错误中间件 |
| M-S6 | 文件上传 magic bytes 校验 | multer 配置 + 文件头检查 |
| M-S9 | deleteExamRows 事务 + CASCADE | db.transaction 包裹 |
| M-S10 | autoBackupOnExamClose 用 VACUUM INTO | 替换文件复制 |
| M-S11 | recomputeRankings 纳入事务 | db.transaction 包裹 |
| M-S14 | 上传文件数量限制 | multer limits 配置 |
| M-S17 | getVisibleExamIds 无 teacher_role 返回空数组 | `return null` → `return []`（⚠️ breaking） |
| M-F1/2/3 | 前端 useMemo/AbortController/竞态 | 逐组件优化 |
| M-F7 | AccountMenu ESC + 焦点陷阱 | 模态无障碍 |
| M-F8 | setTimeout 清理 | useEffect cleanup |
| M-L1/8/9 | 一致性收敛 | 跨模块统一 |
| L-S14 | 错误中间件脱敏 | 生产环境隐藏堆栈 |

### 8.3 P2 四个大型重构项（单独评估）
| 编号 | 问题 | 工作量 |
|------|------|--------|
| P2-2 (M-S5) | SQLite 事务中 await → 同步 API | 大，需兼容 MariaDB |
| P2-3 (M-F9) | 大列表虚拟化 | 中，引入 react-window |
| P2-4 (L-F1) | as any 全面清理（120+ 处） | 大，分模块治理 |
| P2-5 | 自动化测试补全 | 大，引入 vitest + 写测试 |

---

## 九、手动验证清单（部署后执行）

| 路径 | 验证点 | 关联修复 |
|------|--------|---------|
| 登录 admin/admin123（默认密码） | 响应含 warning + 前端弹窗提示 | P0-8 (H-S7) |
| 连续 11 次错误登录 | 第 11 次返回 429 | P1-1 (H-S9) |
| 无 token 访问 `/api/cards` | 返回 401 | P0-4 (C-S2) |
| 无 token 访问 `/api/exams/1/analysis` | 返回 401 | P0-5 (C-S3) |
| 导出答题卡（含损坏资源） | 响应含 `warnings.failedAssets` | P0-1 |
| 导入答题卡（含损坏 base64） | 响应含 `warnings.failedImports` | P0-2 |
| 备份恢复（锁定 DB） | 返回 500 而非"成功但损坏" | P0-3 |
| 阅卷提交（mock 中途失败） | 该学生无残留数据 | P0-6 (H-S5) |
| 编辑答题卡（mock 中途失败） | 块数据未丢失 | P0-7 (H-S6) |
| 空密码用户改密 | 返回"账户密码状态异常" | P0-9 (H-S8) |
| 跨域请求 evil.com | 无 ACAO 头 | P1-2 (M-S1) |
| 前端接口失败 | 控制台有 `[API]` warn 日志 | P1-3 |

---

## 十、环境变量配置说明

部署时需注意以下新增/变更的环境变量：

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `PROJECTX_AUTH_ENFORCE` | `true`（未设置时） | 鉴权强制模式。设为 `0` 或 `false` 可关闭（向后兼容） |
| `PROJECTX_CORS_ORIGIN` | `http://127.0.0.1:5173,http://localhost:5173` | 允许的 CORS origin 白名单，逗号分隔 |

**升级注意事项**：
1. v1.9.0 之前默认不鉴权，升级后默认开启鉴权。若需保持免登录，设置 `PROJECTX_AUTH_ENFORCE=0`
2. 生产环境需配置 `PROJECTX_CORS_ORIGIN` 为实际前端域名
3. Token 存储改为 SHA-256 哈希，所有现有会话失效，用户需重新登录

---

*本总结文档生成于 2026-07-19，对应分支 `修正网阅系统` v1.9.0。*
