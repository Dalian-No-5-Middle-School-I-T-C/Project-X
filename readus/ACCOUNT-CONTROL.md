# Project-X 三级账号控制系统技术说明

> **性质**: 账号 / RBAC 后端权威说明（第 1、2 节保留 v1.1~v1.5 的建设记录，属历史快照）
> **复核至**: v2.7.1（数据库迁移 v63）
> **校订日期**: 2026-10-17（#322 学生网页端自助权限收敛；同步 Cookie 主通道、媒体票据与鉴权默认值）
> **作者**: Project-X
> **关联文档**: [`ACCOUNT-ARCHITECTURE.md`](./ACCOUNT-ARCHITECTURE.md)（全栈视角 + 多端） · [`ARCHITECTURE.md`](./ARCHITECTURE.md) · [`DATABASE.md`](./DATABASE.md) · [`ADMIN-GUIDE.md`](./ADMIN-GUIDE.md)

本文档说明 **学生 / 教师 / 管理员 三级账号控制系统（RBAC）**：模型怎么定、接口如何调用、门放在哪里、如何验证。
第 3~6 节与实现同步；第 1、2 节的「本次新增 / 修改清单」是 v1.1 当时的交付记录，
只用于说明来源，不代表当前文件清单。

v1.3.0 的账号控制接口保持兼容；后续新增的答题卡模板、题级评分规则和考试/答题卡删除保护仍沿用现有 `card:*`、`exam:*`、`grade:*` 权限网关。

---

## 1. 背景与目标

`ARCHITECTURE.md` 第 8 节指出：系统已有 `AuthService` + bcryptjs、`users/roles` 表与默认 admin、
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

> **账号部分未单独改动数据库 schema**：账号控制复用 `roles / users / grades / classes / class_students / student_scores / question_scores` 等既有表。v1.3.0 另有答题卡题级配置相关迁移，详见 [`DATABASE.md`](./DATABASE.md)。

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

> **这三行由建库脚本播种**（SQLite `schema.sql` / MariaDB 对应初始化），`permissions.ts` 里的
> `DEFAULT_ROLE_PERMISSIONS` 只是该列为空时的兜底；运行时判定 `roleHasPermission()` 读的是缓存里的 `roles.permissions`。
> **当前没有修改角色权限位的管理界面或 API**——`/api/admin/permissions` 管的是教师权限矩阵
> （`teacher_permissions` 行：年级 / 科目 / 班级 / 题块 × 5 个标志），不是角色位。
> 要按人收口权限，改矩阵；要改角色语义，改播种数据并重启（第 4 节的 #322 字段门正是复用 `grade:write`，
> 因此角色位一旦被调整，学生 / 教师的自助阅卷设置边界会随之变化）。

**通配符判定** `permissionSetGrants(held, required)`：

1. 持有 `"*"` → 放行一切；
2. 持有精确权限 → 放行；
3. 持有 `域:*`（如 `card:*`）→ 放行该域全部动作。

**缓存**：角色权限极少变更，进程内用 `Map<roleId, Set<permission>>` 缓存，服务启动时由
`initPermissionCache()` 从 `roles` 表载入。
`invalidatePermissionCache()`（改角色时调用）只是把缓存置空，随后的 `loadRolePermissions()` 会返回
**硬编码兜底表**（仅 admin / teacher / student 三个角色）直到 `initPermissionCache()` 再跑一次——
因此改完角色定义要靠重启或重新初始化缓存生效，不要以为失效即等于热更新。

---

## 4. 认证与会话（`AuthService` + 中间件）

- **登录**：`identifier`（用户名/职工号/学号/`P`+学号）+ `password`，可选 `isPersistent`（「记住登录」）；bcryptjs 校验 bcrypt 格式哈希。
- **Token 签发与存储**：随机 32 字节 hex，落盘 `~/.projectx/tokens.json` **只存 SHA-256 摘要**（服务重启后会话仍可用）；普通会话有效期 **8 小时**，持久会话 **30 天**。
- **会话传递**：主通道是 HttpOnly Cookie `projectx_auth_token`（同源浏览器登录响应体不再回传 token，避免 XSS 从响应体窃取长期令牌）；`Authorization: Bearer <token>` 供跨源/脚本客户端使用。
- **URL 携带凭据（安全整改 R30）**：`?token=` 只对**媒体白名单**（`src/server/lib/mediaAllowlist.ts`：图片 / PDF / 导出 / SSE 类只读 GET）生效；需要把链接交给 `<img>`、下载或 EventSource 时，改由 `POST /api/auth/media-ticket` 签发单次资源票据 `?mt=`——票据绑定「当前用户 + 这一条只读路径 + 时限」，登出 / 吊销会话时连带作废，不能当万能令牌用。
- **一次性密码强制改密**：`password_change_required` 账号只能访问认证自助端点，其余 API 一律 **428 `PASSWORD_CHANGE_REQUIRED`**（`requirePasswordChangeCompleted`）。
- **学生密码**：默认密码为学号（允许 5 位）；学生自改密码仍要求 ≥ 6 位（`passwordPolicy.ts`）。
- **修改密码**：校验原密码 → 写新哈希 → **吊销该用户全部会话**，强制重新登录。
- **禁用 / 改密时** 自动调用 `revokeUserTokens(userId)`，避免旧 token 继续生效；该调用同时作废该用户的媒体票据。

### 中间件一览

| 中间件 | 行为 |
|--------|------|
| `authMiddleware` | 解析并挂载 `req.user`；令牌无效 → 401；**无令牌时看开关**：默认强制模式 401，`PROJECTX_AUTH_ENFORCE=0/false` 下放行（见 §6） |
| `optionalAuth` | 有 token 则解析挂载，无 token 也放行（用于记录 `created_by`） |
| `requireRole(...names)` | 自己检查 `req.user`：未认证 401（**与开关无关**），角色不在名单 403 |
| `requirePermission(perm)` | 基于角色权限做细粒度判定（支持通配）：未认证 401，权限不足 403；这两个门是管理路由在兼容模式下的下限 |
| `requirePasswordChangeCompleted` | 一次性密码账号在改密前只放行认证自助端点，其余 428 |
| `requirePermissionCompat` / `makeGate`（`apps/answer-card/server/middleware.ts`） | 业务路由的兼容版门：已登录按角色权限位判定；**匿名请求只在 `PROJECTX_AUTH_ENFORCE=0/false` 的免登录模式下放行**，默认强制模式下仍 401 |

### 考试范围数据门（2026-10 安全整改·第三批）

上表是「角色/权限位」级别的门；考试数据还需要第二层「这条记录是不是你的范围」的门，
集中在 `src/apps/answer-card/server/middleware.ts`：

| 门 | 判定内容 | 拒绝时 |
|------|----------|--------|
| `requireExamAccess` / `validateExamIdsAccess` | 考试是否在 `getVisibleExamIds` 结果内（管理员、学年主任放行；学生一律不因考试可见而获得教师侧数据；晨测对全体教师放大） | 403 `EXAM_OUT_OF_SCOPE` |
| `makeViewPermissionGate(flag)` / `requirePermissionCompat` | 权限矩阵的查看位（`can_view_scores` / `can_view_charts` / `can_view_students`）与角色权限位 | 403 |
| `requireGradingScope` / `isBlockedToOwnGradingBlocks` | 判分是否落在本人被分配的题块 | 403 |
| `requireWholeExamGradingAccess` | 整卷判分上传：需整卷授权或本人任教范围，题块级分配不构成整卷授权（考试创建者例外保留） | 403 |
| `hasExamOrganizationAffinity` / `canManageExamOrganization` | 删除/解绑答题卡时只能作用于与自己有组织归属（年级/班级/学科）的考试；无归属者只拿到引用**数量**，不拿到考试名单 | 403 / 名单置空 |
| `getPermittedBlocks` | 题块级阅卷人的题块集合，`[]` 表示什么都看不到（空集合不等于「未配置」） | 403 / 空列表 |
| `hasClassViewPermission` | 花名册、应考名单写入按教师可访问班级收敛（`getAccessibleClassIds`：null=全校，`[]`=无） | 403 |

学生侧的三条硬约束（学生只有 `score:read`，因此凡带 `grade:read` 的门都不得挡在学生自助路径上）：

- `GET /api/scores/me/exams/:examId` 与 `/api/exams/:examId/student/:studentId/scores`：学生只能读**本人**逐题明细，越界 403；教师侧的矩阵门对学生不叠加（`requireStudentOwnDetail` + `teacherSideOnly`）。
- 天梯（`/api/ladder/*`）：学生只能读自己**参加过**的考试或大考组，未参加的考试 403，不能借跨考/组天梯聚合读到他人排名。
- 成绩公布门（v41/PR #256）仍是硬过滤：未公布时学生侧详情返回 404。改分/仲裁/网阅/扫描入库等写分路径是否撤回公布由管理员全局开关 `auto_unpublish_on_score_change` 决定（默认关闭＝保持公布、学生直接读到最新成绩；开启＝同一事务内撤回并写审计）——见 PR #326 与 [PR248 发布说明](./PR248-成绩公布发布说明.md) 的 2026-10-14 口径变更。

### 自助设置接口的字段门（#322，2026-10-17）

「账号设置」页对学生是**部分开放**的：皮肤、明暗和底部导航属于本人偏好，阅卷设置和背景图不属于。
它们共用 `PATCH /api/users/me/settings`。被禁字段一旦出现就整单 403，不带这些字段时其余项仍可写。
判定函数在 `src/apps/answer-card/server/middleware.ts`，读写接线在 `server/index.ts`：

| 门 | 管住的字段 / 动作 | 判定口径 | 拒绝时 |
|------|------------------|----------|--------|
| `canWriteGradingSelfSettings(user)` | `scoreDisplayMode`、`reviewConfidenceThreshold`（常量表 `GRADING_SELF_SETTING_FIELDS`） | **角色权限位** `grade:write`——管理员可在权限矩阵里调整，不在代码里写死 role 名单 | 整单 403，仅当请求确实带了这两个字段 |
| `isStudentAccount(user)` | `backgroundOpacity`；`GET /api/users/me/settings` 的透明度读数；`GET /api/app/background` | **角色身份**：`student` 一律按「没有背景」处理。故意不看权限位 | 读：透明度改写成 0，背景图 404。写：PATCH 带 `backgroundOpacity` 则整单 403。历史文件不删 |
| `requireBackgroundUploadAccess` | `POST /api/users/me/background`（上传自定义背景图） | **角色身份**：`student` 一律拒绝。故意不看权限位——给某人放开壁纸不应连带给他改分权限 | 403；门挂在 multer **之前**，被拒请求不会先落盘 |

学生仍保留的自助能力：界面皮肤 / 明暗模式 / Tab 栏显隐，以及本人 AI 服务商配置
（`/api/ai/providers` 按 `user_id` 隔离、密钥加密存储）。背景图不在此列：学生网页端不挂浮层，
也不能改透明度或上传。前端同步隐藏阅卷 Tab 与整段背景区（`AccountSettingsPage.tsx`），
并在保存时只提交允许的字段，避免夹带被禁字段时整单 403 把底部导航一起打断——
但**授权口径始终以上表的后端门为准**。
页签回退只在「请求的正是被隐藏的阅卷设置」时发生（`!canEditGradingSettings && settingsTab === "grading"`），
写成「无 `grade:write` 就一律回客户端设置」会把学生的 AI 页签一起锁死，那是越界；`verify:auth` 里有一条
源码接线断言看着这一点。

---

## 5. 接口清单

> 除特别说明，均需已登录会话：浏览器走 HttpOnly Cookie `projectx_auth_token`，脚本/跨源客户端走 `Authorization: Bearer <token>`。
> 只有只读媒体类 GET 允许 URL 携带凭据，且优先用 `?mt=` 资源票据而不是把会话令牌拼进 URL（见第 4 节）。

### 5.1 认证 `/api/auth`

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| POST | `/api/auth/login` | 公开 | 登录 `{ identifier, password, isPersistent? }`；Set-Cookie 为主通道，响应体 `{ httpOnlyAuth, user, permissions, passwordChangeRequired }`，仅在跨源/脚本客户端才附带 `token`；含 IP 与账号双维度限流 |
| POST | `/api/auth/logout` | 登录 | 退出，吊销当前 token，清 Cookie 并作废该用户媒体票据 |
| GET | `/api/auth/me` | 登录 | 当前用户信息 + 权限列表 |
| POST | `/api/auth/change-password` | 登录 | 改密 `{ oldPassword, newPassword }`（吊销全部会话） |
| POST | `/api/auth/media-ticket` | 登录 | 签发单次资源票据 `{ path }` → `{ ticket, path, expiresAt, ttlSeconds }`；路径不在媒体白名单内返回 400 |

### 5.2 用户管理 `/api/users`（要求 `user:manage`，即仅管理员）

> 例外：`/api/users/me/*` 是**本人自助**接口，在 `apps/answer-card/server/index.ts` 里挂载于
> `app.use("/api/users", userRoutes)` **之前**，只要求登录，不受 `user:manage` 约束；
> 它自己的字段门见下表与第 4 节。

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

| 方法 | 自助路径 | 权限 | 说明 |
|------|----------|------|------|
| GET | `/api/users/me/settings` | 登录 | 读取本人设置。学生的 `backgroundOpacity` 固定返回 0，库里的历史值不下发（#322） |
| PATCH | `/api/users/me/settings` | 登录 + 字段门 | `scoreDisplayMode` / `reviewConfidenceThreshold` 需 `grade:write`；学生带 `backgroundOpacity` 也整单 403。不带这些字段时皮肤 / 明暗 / Tab 栏可写（#322） |
| POST | `/api/users/me/background` | 登录，**学生拒绝** | 上传自定义背景图（图片类型校验 + 体积上限）；学生账号 403（#322） |
| GET | `/api/app/background` | 匿名/登录 | 非学生：本人自定义背景优先，否则全局默认背景。学生：404，自定义图和默认图都不下发（#322） |

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
`makeGate()` / `requirePermissionCompat` 是**兼容版**判定：已登录按角色权限位（含通配）放行，
匿名请求只在免登录模式下才通过；考试数据还要再过第 4 节的「数据范围门」。
读写权限位之外，逐题明细、天梯、图表/名单查看等按第 4 节的门收敛，不由 `makeGate()` 单独负责。

---

## 6. 兼容性开关 `PROJECTX_AUTH_ENFORCE`

v1.0 前端三模式 UI **未强制登录**。为保留「桌面单机免登录设计器」这一用法，业务路由的强制鉴权
由环境变量控制；判定唯一真源是 `src/server/lib/authEnforce.ts` 的 `isAuthEnforced()`
（历史上 `server/index.ts` 与 `middleware/auth.ts` 各写了一份**语义相反**的判定，已收敛为这一处，
且该函数每次调用实时读 env）。

> 唯一的间接层：`apps/answer-card/server/middleware.ts` 里的兼容门读的是模块级 `authEnforced`，
> 由 `createApp()` 在装配路由时用 `setAuthEnforced(isAuthEnforced())` 写入。因此**进程启动后改 env 不会自动生效**，
> 需要重启；测试脚本可以直接调 `setAuthEnforced()` 模拟两种模式。

| 取值 | 行为 |
|------|------|
| **未设置（默认）** / `1` / `true` / 其它任意值 | **开启强制鉴权**：受保护路由未登录 401、权限或数据范围不足 403 |
| `0` / `false`（大小写敏感） | 关闭强制：`optionalAuth` 只解析身份（用于 `created_by`），匿名请求可通过兼容门——即「未登录即可使用」的兼容模式 |

> ⚠️ 早期文档把这张表写反了（称「未设置 = 默认不拦截」）；以本表与 `isAuthEnforced()` 为准。
>
> **开关的作用范围取决于具体挂的是哪个门**，不能笼统地说「`authMiddleware` 保护的路由一定要求登录」：
>
> | 挂载的门 | `PROJECTX_AUTH_ENFORCE=0` 时**无令牌**请求的结果 |
> |----------|--------------------------------------------------|
> | `authMiddleware` | **放行**。`authenticateRequest()` 返回 `none` 且未强制时直接 `next()`，与 `optionalAuth` / `makeGate` 口径一致；令牌「存在但无效」仍一律 401 |
> | `requireRole(...)` / `requirePermission(...)` | **401「未认证」**。这两个门自己检查 `req.user`、不读开关，所以 §5.2 用户管理、权限矩阵、控制台等入口在兼容模式下仍有下限 |
> | §4「自助设置接口的字段门」 | 与开关对齐：`canWriteGradingSelfSettings(undefined)` 未强制时为 `true`，`requireBackgroundUploadAccess` 未强制时放行匿名请求——桌面单机模式里没有「学生」身份可言，这是刻意的兼容口径 |
>
> 结论照旧：**Web 部署不要设置 `PROJECTX_AUTH_ENFORCE=0`**。一旦设置，只挂 `authMiddleware` 的自助路由
> （含 `PATCH /api/users/me/settings`、`POST /api/users/me/background`）就变成匿名可写，
> 只有后面还跟着 `requirePermission` / `requireRole` 的入口守着。
> 免登录模式仅供单机桌面端使用。

```powershell
# 默认即强制；显式写明更清楚
$env:PROJECTX_AUTH_ENFORCE = "1"
npm run dev

# 仅桌面单机兼容模式：关闭业务路由拦截
$env:PROJECTX_AUTH_ENFORCE = "0"
```

---

## 7. 验证

提供端到端自动化验证脚本 `scripts/verify-auth.ts`，在 **临时数据库** 上按章节覆盖：

1. 数据库初始化与默认管理员
2. 角色权限模型（通配符 / 细粒度）
3. 登录 / Token / 改密 / 会话吊销
4. 创建教师·学生、批量导入、改角色、禁用与启用
5. 年级 / 班级 / 花名册
6. 学生自助查分（含即时排名、越权隔离）与看板 / 趋势统计
7. 中间件 `requirePermission` / `requireRole` / `requireExamAccess` 的放行与拦截（含 401/403），
   以及 **#322 的自助设置字段门与背景图上传门**（含「门必须挂在 multer 之前」的接线检查）
8~12. 权限矩阵运行时消费、题块授权、软删除与恢复、天梯公布闸门、按考试模式收敛的数据留存策略

> 用例数量随功能增长，本文不固定「N 项通过」；以脚本自身输出的失败数为准。

### 运行方式

```powershell
npm install          # 首次需安装依赖（better-sqlite3 为原生模块，bcryptjs 为纯 JS 依赖）
npm run verify:auth
```

输出末尾形如：

```
== 7. 中间件 requirePermission / requireRole ==
  ✓ 管理员可访问用户管理
  ✓ 学生上传背景图被 403
────────────────────────────────────────
结果：<通过数> 通过，0 失败
```

全部通过则退出码 `0`，否则 `1`（可直接接入 CI）。

### 静态校验

所有新增/修改文件均通过 TypeScript 严格模式（`tsconfig.json` 中 `strict: true`）检查，无类型错误：

```powershell
npm run typecheck
```

> ⚠️ **说明**：`verify:auth` 需要已执行 `npm install` 的开发机（含原生模块）才能真正运行；
> 交付环境若缺运行时，只能完成静态类型校验。不要把「类型检查通过」写成「端到端验证通过」。

---

## 8. 默认账号与首次使用

服务首次启动自动创建：

```
用户名: admin
密码:   查看数据库文件同目录的 bootstrap-admin.txt
```

**该密码只能用于安全初始化；首次登录后必须通过界面或 `POST /api/auth/change-password` 修改。改密后引导文件会自动删除。**

典型初始化流程（管理员操作）：

1. 登录 admin → 改密；
2. `POST /api/classes/grades` / `POST /api/classes` 建年级班级；
3. `POST /api/users` 创建教师，或 `POST /api/users/import-csv` 批量导入学生；
4. `POST /api/classes/:id/students` 编排花名册；
5. 学生用「P+学号 + 初始密码（P+学号）」登录，`GET /api/scores/me` 查分。

---

## 9. 设计取舍

- **Token 存磁盘**：`~/.projectx/tokens.json` 只存 SHA-256 摘要，重启后会话存活；
  短会话 8 小时、持久会话 30 天，另有 Cookie 主通道与单次媒体票据（R30）。
  满足校内单机/小并发，后续可平滑替换为 JWT/Redis。
- **写权限合并**：业务网关中答题卡写操作要求 `grade:write`（教师/管理员均具备），与三级模型一致，无需对每条路由单独标注，降低耦合。
- **学生账号自动建档**：阅卷落库时若学生不存在会以占位哈希自动建档（见 `index.ts` 的 `persistGradingResults`）；这类账号 `password_hash` 为空，`changePassword` 对空哈希放行原密码校验，便于后续由管理员重置或学生首次设密。
- **排名即时计算**：`ScoreRepository` 查询时计算排名/百分位，避免依赖 `student_scores.rank` 是否落库，保证一致性。

---

_由五中人，为五中人，服务五中教学。_
