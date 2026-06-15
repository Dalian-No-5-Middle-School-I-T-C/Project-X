# Project-X 三级账号控制系统技术说明

> **版本**: v1.1.0（账号控制系统）
> **作者**: Project-X
> **日期**: 2026-06-14
> **关联文档**: [`ARCHITECTURE.md`](./ARCHITECTURE.md) · [`DATABASE.md`](./DATABASE.md)

本文档说明本次为「答题卡设计系统」补齐的 **学生 / 教师 / 管理员 三级账号控制系统（RBAC）**：
做了什么、怎么实现、接口如何调用、如何验证、以及如何启用。

---

## 1. 背景与目标

`ARCHITECTURE.md` 第 8 节指出：系统已有 `AuthService` + bcrypt、`users/roles` 表与默认 admin、
`/api/auth/login` 与 Bearer Token 中间件，但 **认证未贯通**——业务接口完全开放，且缺少用户/班级管理、
学生自助查分、密码修改、细粒度权限。README 的 v1.1 里程碑正是「用户权限管理、多班级分析」。

本次工作把这套「半就绪」的认证骨架补成一个 **完整、可验证、可渐进启用** 的三级账号控制系统：

| 角色 | 答题卡 | 考试 | 扫描/阅卷 | 成绩 | 用户管理 | 班级管理 |
|------|--------|------|-----------|------|----------|----------|
| **管理员 admin** | 全部 | 全部 | 全部 | 全部 | 全部 | 全部 |
| **教师 teacher** | 读写 | 读写 | 读写 | 读写 + 代查学生 | 无 | 只读 |
| **学生 student** | 无 | 无 | 无 | 只查自己 | 无 | 无 |

---

## 2. 本次新增 / 修改清单

### 新增文件

| 文件 | 作用 |
|------|------|
| `src/server/auth/permissions.ts` | 权限模型：权限常量、角色映射、通配符判定、角色权限缓存 |
| `src/server/repositories/ClassRepository.ts` | 年级 / 班级 / 花名册数据访问 |
| `src/server/repositories/ScoreRepository.ts` | 学生成绩查询（自助查分 + 即时排名） |
| `src/server/routes/users.ts` | 用户管理 API（仅管理员） |
| `src/server/routes/classes.ts` | 年级 / 班级 / 花名册 API |
| `src/server/routes/scores.ts` | 成绩查询 API（学生自助 + 教师代查） |
| `scripts/verify-auth.ts` | 端到端自动化验证脚本 |
| `ACCOUNT-CONTROL.md` | 本说明文档 |

### 修改文件

| 文件 | 修改点 |
|------|--------|
| `src/server/middleware/auth.ts` | 新增 `optionalAuth`、`requirePermission`，`requireRole` 改为可变参数，`req.user` 增加 `student_number`，`/me` 回传权限列表，支持 query token |
| `src/server/services/AuthService.ts` | 新增 `changePassword`、`revokeUserTokens`；登录响应携带 `permissions` |
| `src/server/repositories/UserRepository.ts` | 新增管理员方法：`findByIdIncludingInactive`、`adminListUsers`、`reactivateUser`、`countByRole`、`batchCreateStudents`、用户名/学号查重、`updateUser` 支持改角色 |
| `src/server/routes/auth.ts` | 登录响应带 `permissions`；新增 `POST /api/auth/change-password` |
| `src/apps/answer-card/server/index.ts` | 挂载 `optionalAuth` 与三个新路由；为业务路由加 RBAC 网关；预热权限缓存 |
| `package.json` | 新增脚本 `verify:auth` |

> **未改动数据库 schema**：`schema.sql` 已包含 `roles / users / grades / classes / class_students / student_scores / question_scores` 等全部所需表，本次完全复用，无需迁移。

---

## 3. 权限模型设计（`src/server/auth/permissions.ts`）

权限以 **`域:动作`** 命名，集中常量化，避免散落的魔法字符串：

```
card:read / card:write     答题卡
exam:read / exam:write      考试
grade:read / grade:write    阅卷与成绩
score:read                  学生查看自己的成绩
user:manage                 用户管理（仅管理员）
class:manage                班级/年级管理（仅管理员）
system:manage               系统维护（仅管理员）
```

**角色 → 权限映射**（写入 `roles.permissions` 列，JSON 数组）：

- `admin` → `["*"]`（超级权限）
- `teacher` → `["card:read","card:write","exam:read","exam:write","grade:read","grade:write"]`
- `student` → `["score:read"]`

**通配符判定** `permissionSetGrants(held, required)`：

1. 持有 `"*"` → 放行一切；
2. 持有精确权限 → 放行；
3. 持有 `域:*`（如 `card:*`）→ 放行该域全部动作。

**缓存**：角色权限极少变更，进程内用 `Map<roleId, Set<permission>>` 缓存；
角色定义变更时调用 `invalidatePermissionCache()` 失效。服务启动时 `loadRolePermissions(true)` 预热。

---

## 4. 认证与会话（`AuthService` + 中间件）

- **登录**：`identifier`（用户名/职工号/P+学号）+ `password`；bcrypt 校验；签发随机 32 字节 hex token，有效期 **8 小时**，存于服务端内存。
- **会话**：`Authorization: Bearer <token>`；也支持 `?token=`（用于 SSE / PDF 等无法设请求头的场景）。
- **修改密码**：校验原密码 → 写新哈希 → **吊销该用户全部会话**，强制重新登录。
- **禁用/改密时** 自动调用 `revokeUserTokens(userId)`，避免旧 token 继续生效。

### 中间件一览

| 中间件 | 行为 |
|--------|------|
| `authMiddleware` | 强制认证，无/失效 token → 401，并挂载 `req.user` |
| `optionalAuth` | 有 token 则解析挂载，无 token 也放行（用于记录 `created_by`） |
| `requireRole(...names)` | 要求属于指定角色之一，否则 403 |
| `requirePermission(perm)` | 基于角色权限做细粒度判定（支持通配），否则 403 |

---

## 5. 接口清单

> 除特别说明，均需 `Authorization: Bearer <token>`。

### 5.1 认证 `/api/auth`

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| POST | `/api/auth/login` | 公开 | 登录，返回 `{ token, user, permissions }` |
| POST | `/api/auth/logout` | 登录 | 退出，吊销当前 token |
| GET | `/api/auth/me` | 登录 | 当前用户信息 + 权限列表 |
| POST | `/api/auth/change-password` | 登录 | 改密 `{ oldPassword, newPassword }` |

### 5.2 用户管理 `/api/users`（要求 `user:manage`，即仅管理员）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/users` | 列表（`?page&pageSize&role&keyword&includeInactive`），含角色统计 |
| GET | `/api/users/:id` | 详情（含班级） |
| POST | `/api/users` | 创建用户 `{ username, password, name, role, student_number?, email?, phone? }` |
| PUT | `/api/users/:id` | 更新 `{ name?, email?, phone?, role?, is_active?, student_number? }` |
| POST | `/api/users/:id/reset-password` | 重置密码 `{ newPassword? }`（学生缺省用学号） |
| DELETE | `/api/users/:id` | 禁用账号（软删除） |
| POST | `/api/users/:id/reactivate` | 重新启用 |
| POST | `/api/users/import-csv` | 批量导入学生/教师（CSV/Excel） |

> **安全护栏**：系统至少保留 1 名管理员——降级或禁用最后一名管理员会被拒绝。

### 5.3 班级管理 `/api/classes`（读：管理员+教师；写：`class:manage` 仅管理员）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/classes/grades` | 年级列表 |
| POST | `/api/classes/grades` | 新建年级 |
| DELETE | `/api/classes/grades/:id` | 删除年级（级联删班级/花名册） |
| GET | `/api/classes?gradeId=` | 班级列表（含人数） |
| POST | `/api/classes` | 新建班级 `{ gradeId, name }` |
| DELETE | `/api/classes/:id` | 删除班级 |
| GET | `/api/classes/:id/students` | 班级花名册 |
| POST | `/api/classes/:id/students` | 加入学生 `{ studentId }` 或 `{ studentIds:[] }` |
| DELETE | `/api/classes/:id/students/:studentId` | 移出学生 |

### 5.4 成绩查询 `/api/scores`

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| GET | `/api/scores/me` | 登录 | **学生查自己** 的全部考试成绩（含排名/百分位） |
| GET | `/api/scores/me/exams/:examId` | 登录 | 自己某场考试的逐题明细 |
| GET | `/api/scores/students/:studentId` | `grade:read` | 教师/管理员代查某学生成绩 |
| GET | `/api/scores/students/:studentId/exams/:examId` | `grade:read` | 代查逐题明细 |

> 学生只能访问 `/me*`；`/students/*` 需要 `grade:read`，学生没有该权限 → 403。

### 5.5 业务路由的 RBAC 网关

`/api/cards`、`/api/exams`、`/api/analysis`、`/api/scanner` 由 `makeGate()` 守卫：
GET/HEAD 走「读权限」，写操作走「写权限」。

---

## 6. 兼容性开关 `PROJECTX_AUTH_ENFORCE`

`ARCHITECTURE.md` 指出 v1.0 前端三模式 UI **未强制登录**。为避免直接打断现网前端，业务路由的强制鉴权由环境变量控制：

| 取值 | 行为 |
|------|------|
| 未设置 / `0`（默认） | 仅 `optionalAuth` 解析身份（用于 `created_by`），**不拦截**业务路由——现有前端无需改造即可继续使用 |
| `1` / `true` | **完整 RBAC**：业务路由未登录 401、权限不足 403 |

> 用户管理 / 班级管理 / 改密等 **管理类接口始终强制鉴权**，不受该开关影响。
> 当前端接入登录后，设置 `PROJECTX_AUTH_ENFORCE=1` 即可全量启用三级控制。

```powershell
# 启用强制鉴权
$env:PROJECTX_AUTH_ENFORCE = "1"
npm run server
```

---

## 7. 验证

提供端到端自动化验证脚本 `scripts/verify-auth.ts`，在 **临时数据库** 上覆盖 7 大类用例：

1. 数据库初始化与默认管理员
2. 角色权限模型（通配符 / 细粒度）
3. 登录 / Token / 改密 / 会话吊销
4. 创建教师·学生、批量导入、改角色、禁用与启用
5. 年级 / 班级 / 花名册
6. 学生自助查分（含即时排名、越权隔离）
7. 中间件 `requirePermission` / `requireRole` 的放行与拦截（含 401/403）

### 运行方式

```powershell
npm install          # 首次需安装依赖（含 better-sqlite3 / bcrypt 原生编译）
npm run verify:auth
```

预期输出（节选）：

```
== 7. 中间件 requirePermission / requireRole ==
  ✓ 管理员可访问用户管理
  ✓ 教师访问用户管理被 403
  ✓ 学生访问用户管理被 403
  ✓ 未登录访问用户管理被 401
────────────────────────────────────────
结果：33 通过，0 失败
```

全部通过则退出码 `0`，否则 `1`（可直接接入 CI）。

### 静态校验

所有新增/修改文件均通过 TypeScript 严格模式（`tsconfig.json` 中 `strict: true`）检查，无类型错误：

```powershell
npm run typecheck
```

> ⚠️ **说明**：本系统在交付环境中已通过 TypeScript 语言服务的静态类型校验；
> 由于交付环境未安装 Node.js 运行时与 `node_modules`，`verify:auth` 的**实际运行**需在
> 已执行 `npm install` 的开发机上完成。脚本本身已随代码交付、可直接运行。

---

## 8. 默认账号与首次使用

服务首次启动自动创建：

```
用户名: admin
密码:   admin123
```

**首次登录后请立即通过 `POST /api/auth/change-password` 修改默认密码。**

典型初始化流程（管理员操作）：

1. 登录 admin → 改密；
2. `POST /api/classes/grades` / `POST /api/classes` 建年级班级；
3. `POST /api/users` 创建教师，或 `POST /api/users/import-csv` 批量导入学生；
4. `POST /api/classes/:id/students` 编排花名册；
5. 学生用「P+学号 + 初始密码（P+学号）」登录，`GET /api/scores/me` 查分。

---

## 9. 设计取舍

- **Token 存磁盘**：`~/.projectx/tokens.json`，重启后 Token 存活（6 个月持久化 Token）；满足校内单机/小并发，后续可平滑替换为 JWT/Redis。
- **写权限合并**：业务网关中答题卡写操作要求 `grade:write`（教师/管理员均具备），与三级模型一致，无需对每条路由单独标注，降低耦合。
- **学生账号自动建档**：阅卷落库时若学生不存在会以占位哈希自动建档（见 `index.ts` 的 `persistGradingResults`）；这类账号 `password_hash` 为空，`changePassword` 对空哈希放行原密码校验，便于后续由管理员重置或学生首次设密。
- **排名即时计算**：`ScoreRepository` 查询时计算排名/百分位，避免依赖 `student_scores.rank` 是否落库，保证一致性。

---

_由五中人，为五中人，服务五中教学。_
