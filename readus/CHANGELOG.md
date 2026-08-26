# Project-X CHANGELOG

## v2.5.0 (2026-08-25) — 扫描端可随时换肤（登录页 + 工作台双入口）

> 此前扫描端仅在首次进入时强制选肤，一次性标志写入后无任何更改入口，官方指引指向教师端网页设置页（机房场景不可达）。本版本补齐扫描端自身的换肤能力。

### 扫描端换肤入口（v2.5.0）
- **登录页右上角、答题卡选择页与扫描工作台顶栏右侧**共 3 处调色盘按钮，全部由 ScannerApp 受控下发皮肤状态：切换即时生效，自动落盘并 fire-and-forget 同步到账号偏好（`PATCH /api/users/me/settings`，后端照常记录 theme_change_events 审计）。
- **登录瞬态回写护栏**（`lib/skinPatchGuard.ts`）：修复登录前切换皮肤会把账号偏好误写成切换前本机旧皮肤的缺陷——认证完成的那轮 effect 里同步与回写闭包共用陈旧 skin，现改为登录瞬态按「显式选择 ?? 账号偏好」判定，仅显式选择异于账号时恰好回写一次；冷启动恢复会话/重登/换账号同样受保护。回归测试 `npm run verify:scanner-skin-patch`（6 场景 13 断言）。
- 首次选肤引导层文案同步更新：不再指向教师端网页，改为本端入口说明。
- 数据面零改动：皮肤注册表、CSS 令牌、同步语义（会话显式选择优先/登出清除标记/换设备恢复账号偏好）均沿用既有实现。
- 文档：`readus/SKIN-THEME.md` 更新文件职责表与 FAQ（推翻"扫描端不提供切换按钮"的旧决策）。
- CI：Build job 在 web 构建外纳入 `build:scanner:full` 扫描端构建门禁。

## v2.4.1 (2026-08-22) — 扫描端（Electron ia32）打包与使用体验修复

> 分支 `feature/scanner-2.4.1`，基于 main（含 #247 安全更新、#249）整合后开发。

### 1. ia32 打包链路修复（sharp 原生模块）
- 新增自愈脚本 `scripts/ensure-sharp-platform-binaries.cjs`：按已安装的 sharp 版本精确拉取 `@img/sharp-win32-ia32` 到 `node_modules/@img/`（幂等；普通 `npm install` 若将其清除会自动补回），并接入全部 ia32 打包脚本（新 npm script `native:sharp:ia32`）。此前打包产物只含 x64 二进制，扫描端一启动即报「Could not load the 'sharp' module using the win32-ia32 runtime」。
- 打包机建议设置镜像环境变量避免 GitHub 直连超时：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`、`ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`。

### 2. 运行时路径修复（快捷方式启动 EPERM）
- 根因：MSI 快捷方式启动时进程 CWD 是 `C:\Windows\System32`，而原卷上传临时目录（multer dest）与入库相对路径基准均按 `process.cwd()` 解析 → `EPERM ... System32\data\answer-card\papers\_tmp` 启动失败。
- 修复：multer 上传目录改用 `storage.papersDir/_tmp`、相对路径基准改用 `storage.dataDir`（两者均遵循 `ANSWER_CARD_DATA_DIR`，dev 行为不变）；Electron 主进程启动时把 CWD 切到 userData（`%APPDATA%\answer-card-designer`），兜底其余遗留的 cwd 相对路径查找。

### 3. 首次进入强制选肤（对齐 web 端）
- 此前皮肤引导层只挂在 web 端登录页，扫描端从未出现。现复用 `SkinOnboarding`（明澈/纸锋大预览二选一、必须选择才能进入登录），复用同一一次性标志 `projectx-skin-onboarded`。
- 补齐与 web 一致的同步语义：会话内显式选择优先于账号偏好；登录后自动 PATCH 同步到账号 `theme_skin`，换设备/重装不再被默认皮肤打回。文案按扫描端场景调整（组件新增可选 props，web 端零改动）。

### 4. 管理员初始密码固定为 admin123（首次登录仍强制改密）
- 初始密码由「随机一次性密码」改为固定值 `admin123`，降低学校现场部署门槛，同时保留防呆：
  - 全新库以 admin/admin123 初始化，**首次登录强制修改密码**；
  - 停留在待改密引导态的存量库下次启动自动重置为 admin123（旧会话全部吊销，改密标记保留）；
  - 已自行修改过密码的在用库完全不受影响。
- bootstrap-admin.txt 仍会生成（内容即 admin123），备份还原与演示数据脚本等下游流程零改动。同步更新 `verify-security-critical` / `bugfix-summary-verification` 断言与 AGENTS.md / README / SERVER-README 文档事实。
- 桥接失败错误码人性化映射（VC++ 缺失/TWAIN 驱动崩溃）与指南补充密钥文件位置亦在本版本一并落地。

## v2.2.10 (2026-08-22) — 合并前审核修复：天梯公布门与软删除收口 + 版本徽章

> 合并前自审发现的两处 P1（均属本 PR 引入面：PR #256 公布 enforcement 的消费端缺口、#246 软删除可见性在天梯的残留）与一处 P3。

**1. [P1] 天梯端点接入成绩公布门（PR #256 v41 消费端补齐）**
- 此前三个天梯端点均不检查 `score_published`：学生可在教师公布前经「我的成绩 → 天梯 → 跨考累计」（周包聚合）看到本人分数与年级前十，单场/大考组路径也可直接调 API 取分——绕过「批改完成后默认不公布，学生端硬过滤」的核心承诺。
- 修复：`ladder.ts` 新增 `checkLadderPublished`（教师/管理员豁免，与天梯开关的管理员预览语义一致）；单场天梯在 `requireExamAccess` 后校验、组天梯对全部成员校验（任一未公布 403）；跨考天梯经 `getCrossExamTotal` 新增 `onlyPublished` 选项在考试集合解析后统一过滤（新增 `filterPublishedExamIds` 助手，保持原顺序）。
**2. [P1] 组天梯与跨考聚合的软删除收口**
- 组天梯成员查询未过滤软删除成员（round-2 已修 `canReadGroup` 的同类残留）：教师侧经 `validateExamIdsAccess` 对含软删除成员的组整体 403；学生侧（可见集合为 null）聚合含已删考试成绩。修复：成员查询补 `GROUP_MEMBER_NOT_SOFT_DELETED_SQL`。
- `getCrossExamTotalExams` 补 `EXAM_NOT_SOFT_DELETED_SQL`（selected 模式可经构造 examIds 触达软删除考试，此处统一收口）。
**3. [P3]** README 版本徽章 2.2.1 → 2.4.0（与 package.json 对齐，仓库惯例）。

**验证**：typecheck 0 错误；`verify:auth` 122/122（新增第 11 节 7 项：公布过滤助手、学生/教师跨考聚合三态、天梯门教师/管理员豁免与学生 403/放行）；security-critical 62、weekly-audit 57、weekly-demo、reliability-filter 21、p1-security 11、demo-safety 23、score-grid 全绿。

## v2.2.9 (2026-08-22) — PR #246 第三轮评审闭环（跨考试查看门 / 恢复解绑策略）

**1. [P1] 跨考试分析端点接入查看权限矩阵**
- 新增 `filterExamIdsByViewPermission`（`middleware.ts`）：批量返回教师按矩阵拥有指定查看标志的考试子集，语义与单场门 `hasViewPermission` 一致（allow-based：admin / 年级主任 / 未配置矩阵全保留；否则仅保留存在 flag=1 且维度匹配授权行的考试）；批量实现（授权行 + 考试维度各查一次）。
- 接入四个跨考试端点（此前仅消费 `can_view_scores` 可见范围或完全不过滤）：
  - `GET /trends`：趋势结果按 `can_view_charts` 收敛；
  - `GET /students/:studentId/trend`：教师读取学生成长曲线按 `can_view_students` 收敛（学生本人不受限）；
  - `POST /subject-deviation`（偏科名单，含姓名/考号/各科分数）：所选考试按 `can_view_students` 整体校验，任一被关即 403（与 `validateExamIdsAccess` 的「任一不可访问即 403」口径一致）；
  - `GET /subject-quality`：补齐教师可见考试范围过滤（此前任何教师可拉全校数据）+ 软删除排除（仓储 `getSubjectQuality` 新增 `examIds` 范围参数与 `EXAM_NOT_SOFT_DELETED_SQL`）+ 结果按 `can_view_charts` 收敛。
**2. [P2] 恢复操作解除保留策略绑定，恢复真正持久**
- `restoreSoftDeletedExam` 此前只重置 `exam_archives.is_deleted`，考试的 `retention_policy_id` 与旧结考时间不变——下一轮清理（含服务启动时的立即执行）会按原策略再次软删除同一场考试。现恢复时同步 `UPDATE exams SET retention_policy_id = NULL`（假设③：未关联策略 = 不归档不删除），恢复即人工豁免；审计与幂等语义不变。

**验证**
- `typecheck` 0 错误；`verify:auth` 115/115（新增第 10 节 12 项：批量过滤三态（管理员/班级禁行/全维度授权/学生门班级维度）、质量趋势范围+软删除过滤、**恢复→解绑→重跑 runCleanup 不再软删除**的端到端断言）。
- 回归：`verify:security-critical` 62/62、`weekly-audit-smoke` 57/57、`verify:weekly-demo`、`verify:reliability-filter` 21/21、`verify:p1-security` 11/11、`verify:demo-safety` 23/23、`verify:score-grid` 全绿；`git diff --check` 干净。

## v2.2.9 (2026-08-22) — 答题卡设计器修复（六项）+ 演示数据对齐新规范（并行分支条目，合并时纳入）
> 该条目由并行分支「答题卡设计器修复」撰写（830c6a7 / 1a99d5f），合并进本 PR 时与上方 #246 条目并存。

**答题卡设计器修复（830c6a7，P0/P1 缺陷族）**
**1. 「适合页面」无限放大（P0）** — `CardPreview` 的 ResizeObserver 观察高度随内容增长的包装层，与 fit-page 的 SVG 高度形成反馈环（每圈 +32px）。改为测量自身内部滚动区并删除 DesignPage 中间包装层；fit-page 宽度同时受宽高约束封顶。GUI 实测切换后 412×582 采样稳定。
**2. 三栏布局重构** — 用 react-resizable-panels（v4：Group/Panel/Separator）重构：右栏默认 380px 可拖拽（300–560），左栏可折叠成 32px 细条（头部按钮 + 拖拽均可触发），布局记忆到 localStorage。
**3. 填空题图片插入回归（#221 重构回归）** — 插图控件被 `!isFillBlankBlock` 条件误包导致填空题永不渲染；已拆出条件，填空题每题都有「插入图片 + 尺寸编辑 + 删除」；修复预览 404（href 缺 `/api` 前缀），恢复丢失的「文字注释」输入与预览渲染。
**4. 得分填涂格开关** — 解答题开关常显，开启自动切到「带分数填涂区」样式；填空题得分格为块级，仅首题显示开关并加「计分题」徽章，非计分题显示说明而非无效开关，配合块级「满分」输入生效。
**5. 作文格仿高考样式** — 新建 `src/shared/essayGrid.ts` 作为几何唯一事实源（排版引擎 layout.ts / SVG 预览 DesignEditors / PDF 导出 pdf.ts 三端行数行缝一致）；预览补齐粗边框、行间虚线、每 100 字刻度（含跨页续号）、题号右对齐；新建作文块默认朱红格线（`ESSAY_DEFAULT_LINE_COLOR=#c00000`，旧卡保留原色），面板新增「格线颜色」。实测 600 格红格 + 刻度 100–500 + 24 条行缝全部渲染。
**6. 客观题「选项竖排」新模式** — 新增第三种排列（A/B/C/D 在题号下方纵向堆叠），行高模型按 span 预留、识别坐标自动跟随；`ObjectiveOptionLayout` 增加 `vertical-options`，服务端 `CardRepository.normalizeOptionLayout` 白名单同步（此前会把 `vertical-options` 静默存成 `horizontal`，实测持久化成功）。同时修复检查器滚动容器 Panel 子项缺 `shrink-0` 导致排版警告面板叠在溢出编辑器控件上的问题。

**演示数据对齐新规范**
- 演示-语文卡（88000001）新增「作文（演示）」块：60 分/目标 600 字/朱红格线 `#c00000`/每 100 字刻度/粗边框，与设计器新建作文块默认配置一致（`demo/essayDemo.ts` 种子）。
- 演示-数学卡（88000002）客观题块 `option_layout='vertical-options'`，验证选项竖排与白名单持久化（其余演示卡保持 `horizontal` 对照）。
- `verify.ts` 新增 5 项校验点（作文块存在/朱红格线/刻度+边框/600 字、数学卡选项竖排）；`manifest.json` 新增 essayCard / objectiveLayoutDemo 用例；`testdata/demo-exams/README.md` 与 `演示数据.md` 同步。

**验证**
- `typecheck` 0 错误；演示数据导入 + `verify.ts` 全绿（含新增设计器校验点）；`projectx-demo.zip` 备份包按新规范重建。


## v2.2.8 (2026-08-22) — PR #246 第二轮评审闭环（4 项：编辑撤销 / 查看门全覆盖 / 软删除组访问 / 恢复通道）

**1. [P1] 编辑权限范围现按记录 ID 原地更新（撤销旧授权）**
- 此前前端保存不携带 `editingId`，后端按新维度 upsert——管理员修改教师/年级/科目/班级/题块后旧记录保留、另增一条，造成权限残留。
- `PUT /api/admin/permissions` 支持可选 `id`：携带时按记录 ID 原地更新全部维度与 5 个标志（`updateTeacherPermissionById`）；编辑撞现有维度组合返回 409（含显式预检查——SQLite/MariaDB 的 UNIQUE 均视 NULL 为互异，纯 NULL 维度的逻辑重复不触发数据库约束，须应用层拦截；DB 约束捕获保留作并发兜底）；记录不存在返回 404。前端 `PermissionManager` 保存时携带 `editingId`。
**2. [P1] 查看开关补齐剩余消费端**
- 单考试：`/exams/:examId/metrics`（难度/区分度）补 `requireViewCharts`；知识点总体 `GET /knowledge-points/:examId` 补图表门；知识点单学生下钻补 `requireViewStudents`。
- 大考组（新增 `hasGroupViewPermission` + `makeGroupViewPermissionGate`，语义与 canReadGroup「全部成员可见」模型一致：组内全部非软删除成员考试的维度均被 flag=1 授权行覆盖才放行）：overview / metrics / question-analysis / distribution / class-comparison / ai-analysis → 图表门；rankings（名单）→ 学生门；export（成绩导出）→ 成绩门。管理员/年级主任放行，未配置矩阵兼容放行。
**3. [P1] 软删除成员不再锁死整个大考组**
- `canReadGroup` 此前读取全部成员（含软删除）并要求 `every(...)` 可见——清理任务只标记 `exam_archives.is_deleted` 不删组成员关系，组内任一成员被软删除后整组对普通教师 403，统计端新加的排除逻辑根本执行不到。现与统计口径一致地过滤软删除成员（`GROUP_MEMBER_NOT_SOFT_DELETED_SQL`）。
**4. [P2] 软删除恢复通道落地**
- `cleanup.ts` 新增 `listSoftDeletedExams()` / `restoreSoftDeletedExam()`（is_deleted 重置 0 + `entity_lifecycle_events('exam',…,'restore')` 审计，幂等）。
- 控制台新增 `GET /api/admin/console/soft-deleted-exams` 与 `POST /api/admin/console/exams/:examId/restore`（均 SYSTEM_MANAGE）；`AdminConsolePage` 新增「已清理考试（可恢复）」区，行内恢复按钮 + 成功提示。
- 顺带修复 `middleware.ts` 一处行尾空格（评审 `git diff --check` 发现）。

**验证**
- `typecheck` 0 错误；`verify:auth` 103/103（新增第 9 节 15 项：upsert/按 ID 编辑维度迁移/409 冲突/组级图表门三态/软删除成员组放行与越权组拒绝/恢复列表-幂等-审计-可见性回归）。
- 回归：`verify:security-critical` 62/62、`weekly-audit-smoke` 57/57、`verify:weekly-demo`、`verify:reliability-filter` 21/21、`verify:p1-security` 11/11、`verify:demo-safety` 23/23 全绿；`git diff --check` 干净。
- 调试注记：`entity_lifecycle_events.entity_id` 为 TEXT 存储，消费方查询需以字符串绑定（数字绑定在 SQLite 不命中）。

## v2.2.7 (2026-08-22) — 合并 PR #256「成绩公布与撤回管理」（特性全量保留）

> 将 `origin/成绩公布更新`（PR #256，包版本 v2.4.0）合入本分支，与既有 #246 权限矩阵/软删除体系融合。PR #256 特性零删减；main 已全量包含（此前合并）；`纸锋` 分支尖端与 main 文件树一致，无增量内容。

**PR #256 特性（全部保留）**
- 成绩公布流程：批改完成后默认不公布；`POST /api/exams/:examId/publish`（单场）/ `POST /api/exams/publish-batch`（批量，含可见性范围校验）/ `POST /api/exams/:examId/unpublish`（撤回，带原因 ≤500 字，状态 `1→2`；重新公布 `2→1`），全部 `GRADE_WRITE` 门控 + 考试可见范围校验。
- 学生端硬过滤：`getStudentScores` / `getStudentTrendData` 增加 `score_published=1`；`/me/exams/:examId` 与学生单场 AI 分析接口公布前置校验（404/403）。教师端查分不受限。
- 审计：`exam_publish_events` 表记录每次公布/撤回的执行人、时间与原因；考试管理页三态徽章（已公布/已撤回/未公布）+ 公布/撤回/重新公布按钮（桌面与移动卡片对齐）；演示数据种子显式 `score_published=1`。

**迁移编号台账（二次撞号处理）**
- PR #256 基于旧 main（迁移止于 v38）新增 **v41**（`exams.score_published` + 存量 closed 回填为已公布）/ **v42**（`exam_publish_events`）；与本分支上一轮重编号的 v41–v43 再次撞号。
- 处理：**PR #256 保留 v41/v42 原号**（其分支已推送、库血统已存在）；本分支三个迁移最终编号 **v43**（track_type 回补）/ **v44**（控制台地基）/ **v45**（权限五维唯一约束）；MariaDB 侧对齐为 v41/v42 + v43/v44。v39/v40 维持作废。编号台账已写入 `migrations.ts` / `mysql.ts` 注释，作废编号请勿复用。
- 四血统临时库端到端冒烟（全新 / main 血统真实库 / 本分支旧编号血统 / PR #256 血统）全部通过：任何存量库升级都不会因版本号已记录而漏掉另一侧内容。

**语义融合点**
- 学生成绩/成长曲线同时满足「未软删除 且 已公布」双条件（`ScoreRepository` 两处 WHERE 均保留两侧过滤）。
- `/me/exams/:examId`：软删除 404 → 无成绩 404 → 未公布 404 三门共存。
- 公布/撤回经 `requireExamAccess` 与 `getVisibleExamIds`——与本分支改造后的可见性体系（矩阵过滤 + 软删除剔除）天然协同，教师无法公布软删除或越权考试。
- `verify-auth` 同时保留两侧适配：PR #256 的考试种子 `score_published=1` + 本分支第 8 节 18 项 #246 断言。

**验证**：typecheck 0 错误（包版本 2.4.0）；verify:auth 88/88、security-critical 62/62、weekly-audit 57/57、weekly-demo 全过、reliability-filter 21/21、p1-security 11/11、demo-safety 23/23、score-grid 全过。

## v2.2.6 (2026-08-22) — PR #246 评审 P1 四项闭环（权限矩阵 / 控制台可达 / 题块授权 / 软删除可见性）

> 针对 PR #246 评审提出的 4 项 P1「功能未闭环」缺陷收尾。其中控制台可达性与题块授权回退两项已在 5db2a2d 修复，本次复核确认并补齐剩余缺口，全部登记永久回归（`verify:auth` 新增第 8 节 18 项断言）。

**1. 权限矩阵查看标志运行时消费（补缺口：普通教师）**
- `getVisibleExamIds`（`middleware.ts`）：普通教师（无 `teacher_role`）此前在函数入口即提前返回 `null`（全可见），使「无 teacher_role 分支的矩阵限制」成为死代码——管理员对该类教师关闭「查看成绩」完全不生效。现删除该提前返回，普通教师同样消费 `can_view_scores=0` 禁止行（可见集合 = 全部考试 − 矩阵禁止，quiz 晨测仍豁免）；无任何矩阵记录 → 仍全可见（旧部署兼容）。班主任/学科教师提前返回问题、`can_view_charts`/`can_view_students` 查看门（`makeViewPermissionGate` → analysis 路由 16 处接线）已由 5db2a2d 落地，本次复核确认。
**2. `/admin-console` 可达性（已由 5db2a2d 修复，复核确认）**：两教师端变体 `allowedModes` 已含 `admin-console`，路由守卫先过变体白名单再过 `canManageGlobal`（SYSTEM_MANAGE），侧栏入口与直达路由均可达。
**3. 题块正向授权不被兼容回退绕过（已由 5db2a2d 修复，复核确认）**：`canGradeBlock` 对已配置矩阵的教师不再享受「题块无分配记录 → 放行」回退（学科/年级/班级不匹配或 `can_grade=0` 一律拒绝）；仅「完全未配置矩阵」的旧部署教师保留回退，避免未分配部署锁死。
**4. `auto_delete` 软删除可见性（补缺口：周审计与大考组链路）**：此前已覆盖考试列表（`listExams`/`listExamsForSelection`）、访问中间件（非管理员 404）、学生成绩/趋势、仪表盘、单科趋势。本次补齐：
- `WeeklyAuditService`：软删除的晨测不再计入周报发布门槛（未出分不再阻塞发布）、不再被自动收进周报组。
- `AnalysisRepository.getGroupMemberTrackMap`（大考组全部统计的成员唯一入口）：软删除成员考试不参与组指标/逐题/分布/班级对比；`exam-groups-analysis.ts` 四处成员查询、`exam-groups.ts` 列表成员数/出分数与详情成员列表、跨场对比组 `hydrateExamGroup`、赋分可用性探测同步过滤。组内残留软删除成员行（先建组后删除的场景）在读取口径统一剔除。
- 新增 `GROUP_MEMBER_NOT_SOFT_DELETED_SQL` 常量（`exam_group_members` 别名 `egm` 场景），与既有 `EXAM_NOT_SOFT_DELETED_SQL` 并列。

**验证**
- `npm run typecheck` 零错误；`verify:auth` 88/88（新增 #246 第 8 节 18 项：普通教师矩阵收敛 / quiz 豁免 / 图表与学生门 / 学科不匹配与 can_grade=0 拒绝 / 兼容回退保留 / 显式分配放行 / 软删除 404 与管理员恢复通道 / 周审计门槛与收录 / 大考组统计剔除）。
- 回归：`verify:security-critical` 62/62、`weekly-audit-smoke` 57/57、`verify:weekly-demo`、`verify:reliability-filter` 21/21、`verify:p1-security` 11/11、`verify:demo-safety` 23/23 全绿。
## v2.2.4 (2026-08-21) — 背景图层级修复与 main 主干整合

### 背景图层级修复（核心变更，分支 fix/background-image-layer）
- 修复自定义背景图覆盖在按钮/卡片之上、破坏 UI 可读性的问题。根因为背景图浮层 `body.has-bg-image::after` 使用 `z-index: var(--z-lightbox)`（600，弹层级别），被绘制在所有内容之上；原作者在 `AppShell` 与页面根容器铺不透明 `bg-background`，导致背景图只能置于最顶层才可见，形成「看得见但压按钮」的矛盾。
- 修复（仅改 CSS 唯一事实源 `src/apps/answer-card/client/theme/backdrop.css`）：
  1. 浮层 `z-index` 由 `600` 降为 `-1`，落到内容之下、viewport canvas 之上，成为真正最底层。
  2. 激活时新增 `body.has-bg-image { --color-background: transparent }`：所有消费 `bg-background` 的画布层（AppShell + 各页面根）随之透明、背景图透出；卡片/按钮使用 `bg-card`/`bg-primary` 等独立令牌，不受影响，依旧不透明、叠在背景图上且清晰可读。
  3. 未设置背景图时令牌仍是 canvas 色，外观零回归。
- 同步更新 `readus/UI-ARCHITECTURE.md`：说明层级决策，并补记早期四次「置于底层」失败的历史背景（当时内容面板硬编码 `background:#fff` 填满视口，v2.x 底色令牌化后该路径才成立）。

### 整合 origin/main 最新
- 本分支自 `codex/latest-score-release` 合并 `origin/main`，吸收其后继功能：周审计发布回补与考试日历视图（#245）、每周考试审计（#245 前序）、知识点分析与标注面板、大考分析路由/服务拆分与 N+1 收敛（#240/#241）、MariaDB 一键测试数据（#243）、首页「最新出分」按角色展示（#238）、学生跨班级/年级迁移（#237）、宣传网站入口（#233/#234）等。
- 合并产生 4 处服务端冲突，均取 `origin/main` 方言无关/超集版本（经 diff 核实无独有功能丢失）：
  - `migrations.ts` / `mysql.ts`：在 v35 基础上新增 v36 复习轮归零 / v37 逐题分析复合索引 / v38 AI 学情分析异步任务表；`mysql.ts` 另含 `SqliteAdapter.logTiming` 慢查询日志、`review_round` 默认值 1→0。
  - `DashboardService.ts`：main 已含「最新出分」块，且三处查询统一应用 `subjectFilter` 角色过滤。
  - `DemoDataService.ts`：改为 `buildInsertIgnore` + `db.run` 方言无关实现，并将 `seedFillBlankDemo` / `reviewDemo` / PNG 占位图生成抽到 `src/server/services/demo/` 子模块（合并自动带入，均为方言无关）。
- 验证：`npm run typecheck` 与 `npx vite build --mode web` 均通过。

### 本次合入「管理员控制台与教师权限细粒度」分支的冲突处理（2026-08-22）
- `package.json`：双方新增 npm scripts 取并集（`migrate:mariadb*` 三条 + `verify:weekly-demo` / `verify:reliability-filter`）。
- `llm-client.ts` / `paper-routes.ts`：import 冲突取并集——main 侧 `getLlmEnv`（llmclient/.env 密钥同源读取）与 `decryptField`（ai_providers.api_key 加密存储透传前解密），本分支侧 `fetchLlmClient` / `recordAiRun` / `finalizeAiRun`（AI 调用双层埋点）；正文两侧逻辑本就共存。
- `migrations.ts` / `mysql.ts`：**v39 编号两侧撞车**（main：knowledge_points.track_type 回补；本分支：控制台观测地基 + v40 权限五维唯一约束）。任一侧已初始化的库都会因 `schema_migrations` 已记录该版本号而整体跳过另一侧内容（main 血统库将缺控制台四表，随后权限重建引用缺失列导致启动失败）。处理：v39/v40 作废不再复用，统一顺延为 v41（track_type 回补）/ v42（控制台地基）/ v43（权限唯一约束），SQLite 与 MariaDB 双侧编号对齐；三个迁移对全部库血统幂等（重复列/表/键自动跳过）。

## v2.2.5 (2026-08-20) — PR #246 检修修复（保留策略消费端 + 明暗账号级回写）

> 针对 PR #246 评审提出的两项「功能未闭环」问题落地修复：数据保留策略此前仅写库不消费（定时清理只认环境变量），明暗方案此前只有读取链路没有回写链路。本次为纯补链路修复，不改变既有业务行为与数据格式。

**修复 1：数据保留策略消费端（`src/server/db/cleanup.ts`）**
- `runCleanup` 事务内新增「步骤 5」：每轮定时清理直接读取 `data_retention_policies`，仅处理 `status='closed'` 且 `retention_policy_id` 非空的考试，按 `COALESCE(closed_at, end_time)` 与策略 `retain_days` 判定到期。
- `auto_archive=1` → 幂等写入 `exam_archives`（`INSERT … WHERE NOT EXISTS`，`scan_count` 取自 `scan_batches`）；`auto_delete=1` → 归档记录标记 `is_deleted=1`。
- `CleanupResult` 新增 `archivedCount` / `markedDeletedCount`（向后兼容）；本轮跳过计数（永久保留 / 保留期内 / 无策略）写入汇总日志。
- 顺带修正步骤 4 注释「超过90天」与实现不符的历史小问题。
- **三条语义假设（经产品确认，均已在代码注释与运行日志标注）**：
  - ① `retain_days=0` = 永久保留，跳过归档/删除；
  - ② `auto_delete=1` = 软删除（仅标记 `is_deleted=1`，不物理销毁数据，可恢复）；
  - ③ 未关联策略的考试维持默认行为（不归档不删除，仅按 `PROJECTX_SCAN_RETENTION_DAYS` 清理扫描原图）。

**修复 2：明暗方案账号级回写链路（`src/apps/answer-card/client/App.tsx`）**
- 新增 `serverColorScheme` 状态（`GET /api/users/me/settings` 时缓存服务端值）。
- 新增写回 effect：`theme` 变更且已登录 → `PATCH /api/users/me/settings` body `{ colorScheme: theme }`（与皮肤同步对称、fire-and-forget；与读取值一致时跳过，成功后更新本地缓存防重复）。
- 语义：设备级优先 + 账号回写——本机切换后账号 `users.color_scheme` 随之更新，跨设备可恢复；`theme_change_events` 审计表与控制台「明暗分布」统计恢复真实。
- 服务端（`validation.ts` / `PATCH` 处理 / 审计写入）原已就绪，本次仅补齐客户端缺口；顺带更新 `App.tsx` 中「明暗为设备级偏好」的过时注释。

**验证**
- 保留策略集成验证（临时 SQLite 库，10/10 断言）：超期归档 / 保留期内跳过 / 永久保留跳过 / 未结考跳过 / 无策略跳过 / 幂等 / 软删除 / 不重复标记 / 其余考试零影响。
- `npx tsc --noEmit` 零错误；`verify:auth` 70/70、`verify:core-logic` 55 PASS、`verify:security-critical` 61/61 全绿。

## v2.2.4 (2026-08-19) — 答题卡设计器实机修复 + 管理员控制台与教师权限细粒度

> 基于 v2.2.3：实机调试 7 项缺陷修复 + PR #242 评审补丁 + 演示数据链路双后端化 + 管理员控制台可观测性与教师权限细粒度等功能更新。
> **含数据库 Schema 变更**：`users` / `teacher_permissions` 加列，新增 `theme_change_events` / `ai_analysis_runs` / `ai_provider_calls` / `entity_lifecycle_events` 四表。SQLite 由迁移 v37 自动执行；已初始化的 MariaDB/MySQL 生产库经服务启动时的运行期迁移自动补齐（零停机）。

**修复（实机调试 7 项）**
- **P0 保存答题卡报错**（`Bind parameters must not contain undefined`）：`CardRepository.ts` 主观题 INSERT 的 `blanks` 相关四列 `?? null`、四处 JSON 列 `undefined→null`——任何含主观题块（填空/解答/作文）的卡保存必崩，且直接拖垮 PDF。
- **P0 PDF 导出完全无法使用**：主因系保存阻断（`flushPendingCardSave` 抛错提前 return），随保存修复打通；附带 `pdf.ts` 得分格绘制显式受 `scoreGrid.enabled` 控制（V1/V2 均生效）。
- **P1 作文格编辑器功能列表混乱**：`DesignEditors.tsx` 对 `blockKind === "essay"` 跳过通用逐题编辑器，仅保留作文专属控件；补全「显示粗边框（showFrame）」「显示字数刻度（showWordScale）」开关。
- **P1 填空题缺少得分栏显隐开关**：填空题分支新增「显示得分填涂格」「显示"得分"标签」开关，与解答题语义一致。
- **P2 右栏「选中块设置」与「基本信息」视觉混淆**：`DesignPage.tsx` 检查器改为标签页（基本信息 / 选中块设置），选中题块自动切换。
- **P2 填空题右侧批注与答题横线齐平**：`DesignEditors.tsx` SVG 左空号标签与右批注上移 1.8mm，与 PDF 端 -2.35mm 视觉对齐。
- **P3 「横线高度（MM）」标签换行**：缩短为「横线高(mm)」。

**评审补丁（PR #242）**
- 抽取共享判定 `src/shared/scoreGrid.ts` 的 `shouldRenderScoreGrid(question, isV2)`，SVG 预览（`SubjectiveSvg`）与 PDF 导出（`pdf.ts`）统一消费，消除口径漂移；`enabled` 缺省视为开启（旧数据向后兼容）；`showLabel=false` 仅隐藏「得分」标签、不影响方格。
- 新增 `npm run verify:score-grid`（`scripts/verify-score-grid.ts`，沿用项目 `verify:*` tsx 冒烟体系，零新增依赖）：判定函数 8 组单元用例 + 3 组布局链路集成 + PDF 冒烟，全部通过。

**1. 管理员控制台（可观测性）**
- 聚合 API `/api/admin/console/{summary,activity,preferences,ai-usage,data-quality}`（`src/server/routes/console.ts`），全部复用 `SYSTEM_MANAGE`、仅聚合值、无 PII；防御式：新表未迁移时返回 `not_available` 而非报错；扫描成功率/人工修改率无 `scans` 表沉淀，如实 `not_available`（不编造）。
- 前端 `/admin-console` 页面（`AdminConsolePage.tsx`，管理菜单「控制台」入口）：平台概览瓦片（现存答题卡 / 当前考试数 / 用户角色分布 / 阅卷完成率）、实体生命周期事件流、用户偏好分布条（成绩显示模式 / 底部导航 / 皮肤 / 明暗 / 文理分科）、AI 调用观测（成功率 / 延迟 / Token 按功能表）、数据质量、数据保留策略行内编辑。零图表依赖、防御式加载。
- 历史累计：新增 `entity_lifecycle_events` 表 + `src/server/services/lifecycleEvents.ts`（`recordLifecycleEvent`，无 PII）；写入点 5 处（答题卡创建/删除含联动删考试、考试创建/删除含联动删答题卡、大考组删除事务内联动）；archive/restore 写入函数已就绪，待归档动作路由落地后接入。
- 数据保留策略：新增 `/api/admin/data-retention-policies` GET 列表 + PUT 更新（`SYSTEM_MANAGE`；`retain_days` 非负整数校验，0=永久保留）。

**2. 教师权限细粒度（科目 / 班级 / 题块维度）**
- `teacher_permissions` 扩展 `subject` / `class_id` / `block_id` / `can_grade` / `can_assign`（NULL=该维度不限），保留原 `UNIQUE(teacher_id, grade_id)`（未做破坏性约束重构，NULL 维度行与唯一索引 NULL 语义兼容）。
- 网阅题块级操作授权（防 IDOR）：新增 `requireGradingScope` / `canGradeBlock` / `isPrivilegedGrader`（`middleware.ts`），覆盖评分提交（submit）、领卷/退卷（claim ×2 / release）、断点续批（session get/put/delete）；题块无分配记录时全员放行（未分配部署不锁死）；crop 图片查看端点因仲裁流程特殊性（仲裁人未必被分配题块）未硬接入，留待权限矩阵统一处理。
- 正向授权查询：`getPermittedBlocks(user, examId)`（综合显式分配 + 细粒度授予，无约束时返回全部）、`isTeacherPermittedForExam(examId, teacherId, perm)`（表不存在或无记录 → 放行，兼容旧部署）。
- 工作量分配与权限矩阵绑定：创建分配前逐一校验目标教师 `can_assign`，被拒 403 明确列出；可分配教师列表仅返回矩阵内教师并加 `requireGradeLeaderOrAdmin` 门控；教师端可见题块列表按矩阵过滤（`getAvailableBlocksForTeacher` 接入 `getPermittedBlocks`）。
- 权限配置面板：`/api/admin/permissions` PUT upsert 扩展至全维度（四维精确匹配 IS NULL/=，撞旧唯一约束返回 409 明确提示）；前端教师权限管理页（`PermissionManager.tsx`）新增科目 / 班级 ID / 题块 ID 输入与「可阅卷」「可分配」开关及对应列表列，支持按科目、班级、阅卷任务维度分配与回收。

**3. AI 调用观测（双层埋点，服务端写入）**
- 新表：`ai_analysis_runs`（逻辑任务层：feature/model/stage/success/latency/tokens/error_code）、`ai_provider_calls`（实际模型调用层，`run_id` 关联）。
- 新模块 `src/server/services/aiTelemetry.ts`（`recordAiRun` / `finalizeAiRun` / `recordProviderCall` / `trackAnalysisCall`）——仅服务端调用，不暴露任何客户端路由；埋点全部 try/catch 兜底，失败绝不影响业务。
- 接入 4 个调用点：考试分析（`exam_analysis`）、大考分析（`exam_group_analysis`）、学生单场分析（`student_analysis`）、原卷知识点分析（`knowledge_points`，一次任务对应多次边车调用）。
- 安全约束：仅记录聚合字段，不保存 API Key / 完整提示词 / 学生姓名 / 完整回答；`/health` 探测不计入。

**4. 账号级主题持久化**
- `users` 新增 `ui_style`（`clarity` / `paper_edge`，与既有 `theme_skin` 双向同步过渡）、`color_scheme`（`light` / `dark`，替代仅存 localStorage 的设备级明暗）。
- `GET/PATCH /api/users/me/settings` 扩展 `uiStyle` / `colorScheme`；主题/明暗实际变化写入 `theme_change_events` 审计表；前端明暗在无本机覆盖时由服务端 `colorScheme` 种子化（设备级优先回退）。

**5. MariaDB 运行期迁移体系（含验证与回滚）**
- 运行期结构迁移：`runMariadbMigrations` 新增 v37（`users` 加 2 列含历史 NULL 回填、`teacher_permissions` 加 5 列、新建 4 张观测表 + 索引），服务启动 `initMariadbSchema()` 自动执行、对比 `schema_migrations` 执行缺失版本——已初始化的生产库重启即自动补齐、零停机；新装库幂等（重复列/表自动忽略）。
- 数据迁移工具 `scripts/migrate-to-mariadb.ts` 重写为 v2：补全 11 张此前缺失的迁移表（`system_settings` / `teacher_permissions` / `original_paper_pages` / 网阅 4 表 / 观测 4 表）；默认先调 `runMariadbMigrations` 自动补齐目标库结构（`--skip-schema` 关闭）；**迁移前自动 mysqldump 完整备份**（`--single-transaction`，找不到 mysqldump 时拒绝继续，可 `--skip-backup` 显式跳过）；迁移后三重验证（逐表行数对比 + 列结构对比 + `--sample=N` 抽样逐字段比对）；验证不通过打印回滚命令（`mysql < backup.sql`）并退出码非 0；新增 `--dry-run` / `--verify-only` / `--help` 与 npm 脚本 `migrate:mariadb` / `migrate:mariadb:dry` / `migrate:mariadb:verify`。

**增强**
- 演示数据链路双后端化（SQLite + MariaDB）：`DemoDataService.ts` 与 `demo/fillBlankDemo.ts`、`demo/reviewDemo.ts` 改造为 `DbAdapter`（`getMysqlDb()`），约 11 处 `INSERT OR IGNORE` → `buildInsertIgnore`、方言化 `tableExists`/事务/`datetime('now')`；`POST /api/db/import-demo`、`POST /api/db/clear-demo` 移除 MariaDB 400 门控，MariaDB 部署可一键导入/清除演示数据。附带修正：`reviewDemo.ts` 演示时间戳改为 MariaDB 可接受的 `2026-06-25 09:30:00`；`clearDemoData()` 异步化并同步调用点。验证：`scripts/verify-demo-safety.ts` 23 项断言全过。

**部署注意事项**
- PDF 中文渲染：`pdf.ts` 内置多平台 CJK 字体候选（Windows `simsun.ttc` / macOS `PingFang` / Linux `Noto Sans CJK`）与系统字体扫描回退；生产环境（浪潮 5220 / Linux）需存在可用 CJK 字体或显式设置 `PROJECTX_PDF_FONT_PATH`。
- MariaDB 生产库：重启服务即自动补 v37 结构（零停机）。全量数据搬迁按序执行 `npm run migrate:mariadb:dry` → `migrate:mariadb:verify` → `migrate:mariadb`（自动备份 + 补结构 + 三重验证；备份落盘 `data/backups/mariadb-pre-migration-<时间戳>.sql`，失败回滚命令见输出）。

**验证**
- 增量 tsc 零新增错误模式（全量 610 = 基线 605 + 新增 5 处与基线同类的 `Button variant` / 回调参数类型缺口，均属既有 ui/v2 组件类型技术债，不阻断 Vite/esbuild 构建）；迁移脚本单文件 tsc 零错误（`--help` 实测 EXIT=0）。
- v37 与 schema 一致性：四张观测表列级比对（7/11/10/6 列 ALL_MATCH）、`users` / `teacher_permissions` 默认值与 `schema.mariadb.sql` 完全一致；`requireGradingScope` 接线完整（review 2 / review-pool 4 / review-session 4）；四端 schema 一致。
- 回归冒烟：`verify:demo-safety` 23 项断言全过、`verify:score-grid` 全过。
- 本机无 MariaDB 实例，真连库 dry-run 未执行（连接失败路径表现正常）；真库验证命令见「部署注意事项」。

## v2.2.3 (2026-08-14) — 巨型文件拆分与大考查询批量化（未发版，基于 #239）

- 路由拆分：`exam-groups.ts`（1204 行）拆为 CRUD 主路由 + `exam-groups-analysis.ts`（概览/指标/逐题/分布/班级对比/AI/排名/导出）+ `exam-groups-helpers.ts`（权限与文理分科公共逻辑），行为不变。
- 服务拆分：`DemoDataService.ts`（859 行）的网阅种子与填空题种子拆到 `services/demo/`，PNG 占位图生成独立为 `demo/png.ts`。
- 前端拆分：`App.tsx` 的 CSV 导出（与扫描端重复实现合并为 `lib/gradingCsv.ts`）、知识点分析面板（`KnowledgeAnalysisInline.tsx`）抽出，删除无引用的 `GradingResults` 死代码。
- N+1 收敛：大考逐题/分布/班级对比的满分、考试元信息、逐科成绩改为一次批量查询；逐科区分度由每科重跑整组分析（O(n²)）改为复用一次结果。
- 修复大考导出 ZIP 中文文件名未编码导致响应头非法、下载 500 的问题（`filename*` 全量百分号编码）。

## v2.2.2 (2026-08-14) — 真实使用评审修复

- 网阅提交两项 P0 回归：新切块 `review_round` 默认 1 导致首评误报「已达到评分上限」（迁移 v36 + 两处插入点显式置 0 + schema 默认值修正）；演示/空卡体切块提交报「题号不在答题卡题目范围内」（种子补全题块 + 提交回退用落库逐题满分）。新增 `verify:review-submit` 回归脚本。
- 扫描原图保留期支持 `PROJECTX_SCAN_RETENTION_DAYS`（默认 30 天）；阅卷中（active/grading）的考试永不参与清理。
- 「导入演示数据」明确提示会重置全部「演示-」前缀数据并更换考试 ID。
- 名册 CSV 与成绩 CSV 统一转义与公式注入防御（新增 `src/shared/csv.ts` 单一实现）。
- 用户首次改密成功后清空明文 `initial_password`（管理员重置密码时仍会重新写入供导出下发）。
- 成绩表桌面端分页（50/100/200 条每页）、移动端仅渲染前 100 条，全年级数据不再一次性渲染；搜索缩小结果时自动回到第 1 页（受控分页 + onPaginationChange），分页栏显隐按数据总量而非当前页行数。
- 首页仪表盘科任老师科目口径统一（最新扫描 / 统计 / 最新出分一致过滤）。
- `MetricBadge` 档位请求改用 `authFetch`：原先裸 `fetch` 不带头且绕过 API 基址，远程服务器地址模式下 401/打错源。
- AI 分析文档补齐依赖安装步骤；README 版本徽章与 `package.json` 对齐。

## v2.2.1 (2026-08-07) — TWAIN 驱动 8 项缺陷修复（PX-COR-009 闭环）

> 修复扫描链路全部 8 项缺陷：消息泵收不到 `MSG_XFERREADY`（扫描卡死 60 秒）、x64 句柄截断、灰度/黑白假彩色、双面/多页丢页抢拍、部分失败被当作成功、中文路径保存失败；TWAIN 2.5.1 SDK 入库（不再依赖 `D:\twain-dsm-2.5.1` 绝对路径）、`win-x64` 原生产物补齐；TS 层扫描会话后台化（立即 202 + SSE 补发终态）与真正可用的取消（杀子进程 + 强杀兜底）。详见 `readus/TWAIN驱动问题研究报告.md` 第六节。

**1. 原生 TWAIN 驱动（ScannerBridge）**
- 事件消息泵：删除自造 `WM_USER+1`，`WndProc` 全量转发真实消息，`processTwainEvent` 传真实 `MSG`（`pEvent`）——`MSG_XFERREADY` 终于可达，扫描不再卡 60 秒超时。
- x64 句柄宽度：`DAT_IMAGENATIVEXFER` 返回值改用指针宽 `TW_HANDLE` 接收（原 4 字节 `TW_UINT32` 截断 `HBITMAP` 并污染栈）。
- 调色板：8bpp/1bpp 保存前用 DIB 颜色表 `SetPalette` 注入 GDI+，灰度/黑白不再假彩色或保存失败。
- 捕获状态机：每次 XFERDONE 后立即 `ENDXFER` 并复位状态，双面/多页由 `DAT_PENDINGXFERS` 查询驱动——不再丢背面、不再干等 30 秒、不抢拍。
- 成功判定：`success = 无中途失败 && 至少一页`，背面捕获失败也记录错误——部分失败批次不再被当作完成。
- 中文路径：`main` 改 `wmain` + `GetCommandLineW` 转 UTF-8。

**2. 构建系统**
- TWAIN 2.5.1 SDK（`twain.h` + 32/64 位预编译 `TWAINDSM.dll`，LGPL 许可说明）入库 `native/ScannerBridge/third_party/twain-dsm-2.5.1/`；vcxproj 与 build 脚本改仓库内相对路径，换机器/CI 可复现。
- `resources/native/win-x64/` 产物补齐（scanner-bridge.exe / TWAINDSM.dll / answer-card-recognizer.exe），64 位 Electron 开箱可用。
- build 脚本修复 vswhere 发现 MSBuild 的两个批处理解析 bug；`.gitignore` 只忽略超大 opencv DLL。

**3. TS 整合层**
- `POST /api/scanner/scan` 先创建会话立即返回 202，扫描 + OCR 后台执行；SSE 订阅时若会话已终态则补发终态事件——进度不再全部丢失、界面不再卡"扫描中"。
- 新增 `POST /api/scanner/scan/:sessionId/cancel`：终止 `scanner-bridge.exe` 子进程（kill + `taskkill /F /T` 强杀兜底），前端取消按钮接入；会话支持 `cancelled` 状态。

**验证**
- 双架构编译（x64 + ia32）成功，exe 冒烟（list/help）正常；typecheck 0 错误；`verify:auth` 54 项、`verify:security-critical` 42 项、`verify:scanner-cancel` 7 项全绿。
- 评审修复（P0/P1/PR 224 反馈）：`toUtf8` 修复 `WideCharToMultiByte` 1 字节缓冲区越界（按含 NUL 的 len 分配后 `pop_back`）；`MSG_PROCESSEVENT` 的 `pDest` 改传 `&m_sourceId`（DSM 对 NULL pDest 校验失败）+ WndProc 加 `m_state>=2` 守卫；取消竞态——`cancelRequested` 集合让"202 后立即取消"在子进程注册前被 `runBridge` 拦截，`runScanSession` 写 `scanning`/`completed` 前各加取消检查且取消不 rethrow；`completed` 移到 OCR 全部完成后（OCR 阶段取消不再被拒、SSE 补发不再提前 done）；ENDXFER 失败写 `errorMessage`；DSM 运行时加载删除 `D:\` 绝对路径（改 exe 目录 + fallback）；调色板补 4bpp/32bpp 分支并尊重 `biClrUsed`；SSE 路由 try/catch + 终态主动移除 handler；build 脚本 VS 安装根改用 vswhere `installationPath`、临时文件随机名；`maxPages=0` 直传（0=不限）。
- 未验证项（需真实扫描仪）：消息泵收事件、双面/多页 ADF、灰度图输出的真机行为待实测。
## v2.3.0 (2026-08-07) — 纸锋 Paper Edge 第二套皮肤（#纸锋）

> 落地 v2.1.0 皮肤扩展机制下的第二套皮肤「纸锋 Paper Edge」（设计来源 `demo-brutalist.html` / editorial-brutalist 技能）：纸面米底 + 墨色文字 + 品牌亮蓝 #2E44FF，直角 + 胶囊圆角纪律，全文件唯一硬偏移阴影 `8px 8px 0`。纯令牌覆盖 + 9 组已评审作用域规则（详见 [SKIN-THEME.md](./SKIN-THEME.md) §五豁免登记），组件零改动，默认皮肤零影响。

- `tokens.css`（theme 与 design 双份同步）追加 `[data-skin="paper-edge"]` L2 覆盖块：圆角归 0、纸面米色表面、墨阶文字、亮蓝 accent、状态语义重映射（已完成→蓝软族 / 阅卷中→墨描边族 / 异常→绯红族 / 信息→实蓝族）、阴影 1-3 级归零 + 4 级硬偏移、图表单色纪律（chart-1 蓝 = 当前主体）；`[data-skin="paper-edge"][data-theme="dark"]` 暗色组合（#141413 系推导，对比度 ≥4.5:1）。
- 9 组作用域规则（按钮胶囊 + 字重 700 / 主按钮墨底纸字 hover 转蓝 / 描边与次要按钮精调 / 选项卡独立描边胶囊组 / 分段控件无槽描边胶囊 / 进度条直角 / 徽章胶囊 / 统计大数字 800 重）——全部限定 `[data-skin="paper-edge"]` 作用域，`[class~=]` 整词匹配防 variant 前缀误伤。
- `SkinSwitcher` 注册表登记 `paper-edge`（移除「更多皮肤 · 开发中」禁用占位）；账号设置页「外观 / 皮肤」当前皮肤名跟随注册表动态显示。
- `app.css` @layer base：原生 range 滑块 `accent-color: var(--px-accent-bg)`（修复 WebView2 默认紫蓝渲染与两套皮肤不协调）。
- 文档：`DESIGN-SYSTEM.md` 皮肤清单（现有两套）、`SKIN-THEME.md` 皮肤清单与豁免案例登记更新。

**验证**
- `npm run typecheck` — 0 错误；`npm run verify:auth` 54/54（服务端未变，回归通过）。

## v2.1.0 (2026-08-07) — 皮肤切换：扩展接口 + 前端按钮 + 账号级持久化

> 搭建前端「皮肤」扩展机制（皮肤 = 与明暗正交的风格维度，`data-skin` 属性预留，当前仅默认「明澈 Flat 2.0」一套）+ 登录页 / 侧栏 / 页头 / 设置页四处切换入口 + 皮肤偏好账号级持久化（换设备自动恢复）。完整说明见 [SKIN-THEME.md](./SKIN-THEME.md)。（注：第二套皮肤「纸锋 Paper Edge」于 v2.3.0 落地，见上。）

**1. 前端**
- 新增 `components/SkinSwitcher.tsx`：皮肤切换器（`SKIN_OPTIONS` 皮肤注册表 + 默认 `flat`；菜单含「皮肤」组（当前勾选 + 「更多皮肤 · 开发中」禁用占位）与「明暗」组（亮/暗，复用既有 theme 状态）；支持受控（App/设置页）与自管（登录页）双模式）。
- `App.tsx`：新增 `skin` state（localStorage `projectx-skin`，默认 `flat` 不设 `data-skin` 属性，零污染零迁移）；登录后同步 effect（本地显式选择优先并回写后端，无本地记录则应用账号偏好）；皮肤变更自动 `PATCH /api/users/me/settings`（fire-and-forget）；侧栏底部与页头原 Sun/Moon 按钮升级为 SkinSwitcher。
- 入口：登录页卡片右上角（自管模式，未登录即可切换）、账号设置「客户端设置」Tab →「外观 / 皮肤」区（明暗 SegmentedControl + 皮肤按钮，即时生效）。
- 机制预留：`WorkspaceContext` 暴露 `skin`/`setSkin`；`AuthUser.themeSkin`；`main.tsx` / `main-scanner.tsx` 渲染前预置 `data-skin`（防未来皮肤白闪）；`chart.tsx` MutationObserver `attributeFilter` 增加 `data-skin`（未来皮肤切换图表自动重绘）；`tokens.css` 头部注释区新增「皮肤扩展规约」（`[data-skin="xxx"]` L2 覆盖块 + 暗色组合选择器写法）。
- 扫描端（ScannerApp）：登录后应用账号皮肤偏好（不提供切换按钮）。

**2. 后端**
- `users.theme_skin` 列（TEXT 默认 `'flat'`，皮肤 ID 字符串不枚举）：SQLite 迁移 **v33 `user-theme-skin`** + 三套 schema（sql / mariadb / mysql）+ MariaDB `mariadbMigrations` v33。
- `GET /api/auth/me` 与 `GET/PATCH /api/users/me/settings` 增加 `themeSkin` 字段（校验：`z.string().min(1).max(32)`，空串/超长 400 拒绝）；登录响应 `user` 经 `SELECT u.*` 自动携带。

**3. 修复（存量库升级路径）**
- `schema.sql` 移除 `idx_answer_block_crops_pool` 索引（其列 `claimed_by` 属 v32 迁移新增，写在 schema.sql 会导致存量库（迁移未到 v32）启动崩溃 `no such column: claimed_by`；该索引由 v32 迁移幂等创建，全新库不受影响）。

**4. 文档**
- 新增 `readus/SKIN-THEME.md`（完整说明：入口、数据流、前后端实现、API、新增皮肤 5 步扩展指南、FAQ）；README 功能特性 / UI 现状 / 文档表更新；`readus/UI-ARCHITECTURE.md` 新增 §三.7 皮肤扩展机制；`user guide` 4.14 更新为「外观 / 皮肤」。

**验证**
- `npm run typecheck` — 0 错误（顺带修复了 node_modules 缺失导致的 655 个基线类型错误，`npm install --ignore-scripts` 后恢复）。
- 存量库 `data/projectx.db`（v31）启动自动补齐 v32/v33 迁移，`theme_skin` 列落库实测通过。
- API 冒烟：`/api/auth/me` 与 settings GET 返回 `themeSkin`；PATCH 更新成功；空串/超长 400 拒绝。

## v2.1.1 (2026-08-08) — 首次登录前皮肤引导层 + 入口收敛 + 暗色按钮恢复

> 皮肤切换体验收敛：新增**首次进入登录页前的强制皮肤引导层**（明澈 / 纸锋两张大预览卡并排、带简介、必须二选一，确认后才进入登录）；将 v2.1.0 的四处入口收敛为「登录页 + 账号设置」两处，侧栏底部与页头恢复为原先的暗色模式一键按钮（Sun/Moon）。全程 Tailwind 语义令牌，未新建 CSS、未违反 UI 设计规范。完整说明见 [SKIN-THEME.md](./SKIN-THEME.md) §一。

**1. 前端**
- 新增 `components/SkinOnboarding.tsx`：全屏引导层（`role="radiogroup"` + 两个 `role="radio"` 卡片）。首次进入（`localStorage["projectx-skin-onboarded"]` 缺失）弹出；初始无预选、确认按钮禁用（文案「请先选择一种风格」），必须点选其一；确认时写入 sessionStorage `projectx-skin-chosen`（登录同步本地优先）+ 自管落盘 `projectx-skin` / `data-skin`（复用 `writeLocalSkin`）+ 一次性 `onboarded` 标志，随后卸载引导层显示登录页。
- `components/LoginPage.tsx`：用 `shouldShowSkinOnboarding()` 初始化 `showOnboarding` state，条件渲染引导层（`<>` 包裹）；确认后置 false 显示登录页。登录页右上角 `SkinSwitcher` 自管入口保留（登录前备用切换）。
- `components/SkinSwitcher.tsx`：导出既有 `writeLocalSkin`（引导层复用，避免重复逻辑）。
- `App.tsx`：侧栏底部（`AppRailFooter`）与页头（`PageHeader` actions）的 `SkinSwitcher` 移除，原地恢复**暗色模式一键按钮（Sun/Moon）**——点击切换 `theme`，复用既有 `data-theme` + `projectx-theme` 持久化 effect（设备级，无后端改动）；严格沿用现 UI 系统 Tailwind 工具类（`h-control-md` / `size-8` / `text-secondary-foreground` / `hover:bg-secondary` / `duration-(--px-dur-1)` 等），未引入 legacy CSS。
- `public/skin-onboarding-assets/`：复制 `flat-preview.png` / `paper-edge-preview.png`，构建以 `/skin-onboarding-assets/...` 根路径引用（已验证进入 `dist/web/`）。

**2. 文档**
- `readus/SKIN-THEME.md`：入口表由「4 处」更正为「2 处」+ 收敛说明、新增「首次强制引导层」段、前端实现表与 FAQ 同步。
- `README.md` 功能特性「皮肤切换」条目同步收敛描述。

**验证**
- `npm run typecheck` — 0 错误；`npm run build`（web + server）双绿，预览图确认进入 `dist/web/skin-onboarding-assets/`。
- 真机闭环（Playwright，独立 QA agent + 主理人接管复测）：明澈 / 纸锋 × 亮 / 暗 全组合 PASS——初始禁用、点选启用、落盘 `projectx-skin`/`chosen`/`onboarded`/`data-skin` 全中、确认后进入登录页、预览图 HTTP 200、防重复弹窗、零非 401 浏览器报错；暗色标题对比度 14.68:1。原 QA 脚本曾标记「选中边框与未选同色」，经静置复测确认为 150ms 边框过渡的采样假阳性（非选中态缺陷），非源码 bug。

## v2.2.0 (2026-08-07) — 知识点难度/区分度 + 考试模式切换（#176 #178）

> 双权限模式落地：晨测（quiz）对教师全量可见，大考（formal）继续走 teacher_role / teacher_permissions 精细权限；成绩分析的知识点面板补齐难度系数 P 与区分度 D，并修复知识点接口响应解包 bug。typecheck / verify:auth / verify:security-critical / 新增 verify:176-178 / build 全绿。

**1. 考试模式切换（Issue #178）**
- `exams.exam_mode` 列（迁移 v34 + 三套 schema 同步）：`quiz`=晨测（全量权限）、`formal`=大考（精细权限，默认）。
- 创建考试可选择考试模式；考试管理列表显示晨测/大考徽章；考试详情页管理员可随时切换。
- `getVisibleExamIds` 双模式：quiz 考试对所有教师放开精细限制，formal 考试保持原有 teacher_role + teacher_permissions 过滤；考试组可见性随之保持一致。
- 修复：未配置学科的 `subject_teacher` 也能看到晨测考试（回归测试覆盖）。
- 默认 `formal`，保证存量库与既有权限语义不扩大（晨测需显式选择）。

**2. 知识点难度/区分度（Issue #176）**
- `KnowledgePointRepository.getWeaknessesForExam` 重构为单查询聚合：每个知识点返回 `difficulty`（得分率/100）与 `discrimination`（极端组法逐题 D 均值），学生总分作为分组基准。
- 成绩分析「题目分析 → 知识点薄弱环节」每行新增难度 P / 区分度 D 徽章（复用可配置档位）。
- 顺带修复：知识点接口返回 `{ weaknesses }` 而前端按数组解析导致面板恒空的 bug（与 #213 高度相关，待云端复验）。

**验证**
- `npm run verify:176-178` — 10 项断言全绿（模式写入/默认值/可见性切换/难度区分度数值）。
- `npm run verify:auth` 54/54；`npm run verify:security-critical` 42/42；typecheck + build 全绿。

## v2.0.0 (2026-08-06) — UI 全面重构：Flat 2.0 设计系统落地

> 全部页面完成 Flat 2.0 设计系统迁移（Tailwind v4 + shadcn/ui 组件基座 + 三层令牌化），旧 `styles.css`（6048 行）与 `theme/legacy-bridge.css`（108 行）删除、遗留类归零；同期完成 P6 死代码清除、AccountMenu 侧栏化、天梯榜恢复接线与多项体验修复。typecheck / build:web / build:scanner 全绿。

**1. 设计系统（Flat 2.0）落地**
- **令牌化三处同步**：`design/tokens/tokens.css`（设计层事实源）↔ `client/theme/app.css`（`@theme` 块）↔ `client/theme.ts`（JS/图表取色），由 `scripts/sync-tokens.mjs` 同步；手改 app.css 视为漂移事故。
- **组件库唯一事实源** `components/ui/v2/`（桶导出，禁止直指实现文件）；语义类（`bg-card` / `border-border` / `text-primary` 品牌红 `#C00F28` / `rounded-lg` 12px / `rounded-md` 9px / `tabular-nums` 等），字体阶梯最大 `text-5xl`。
- **设计锚点**：`design/demo.html`（8 视图 × 亮暗双主题）、`design/designer-sandbox.html`（设计器）、`design/DESIGN-SYSTEM.md`（规格）、`design/EXECUTION-PLAN.md`（T1–T8 / P0–P5 计划）。

**2. 页面迁移（T1–T8）**
- 主题层 / 组件基座 / 应用外壳（AppRail 可收起）/ 答题卡设计器 / 成绩分析 / 扫描链路 / 学生端 / 首页+登录 / 考试管理 / 账号 / 权限 / 设置 / 信息页 / 兜底 404（NotFound）+ ErrorBoundary。

**3. P5 清理**
- 删除 9 个 legacy ui 组件（Button / Modal / SegmentedControl / Input / Panel / Table / DataCard / Spinner / LoadingScreen），旧桶仅 re-export v2；新增 v2 `DataCard` / `DataCardList`。
- `App.tsx` 弹层 → v2 `Dialog`、auth 加载态 → v2、硬编码 hex → 语义令牌、ESC 守卫补 Radix 弹层识别。

**4. P6 清理收尾（大项）**
- **死代码清除**：BFS 可达性分析删除 10 个不可达文件（OnlineReviewPanel / UserManagement / StudentManagement / MobileDrawer / DragDropZone / AnalysisOverview / AnalysisRanking / ExamManagementPage / CropImageViewer / ui-index.ts，共 1986 行；双基线验证非回归）。
- **AccountMenu 侧栏化**：个人设置入口从头像下拉迁至侧栏；账号设置升级为独立路由页 `/account-settings`（原 Dialog 抽为 `pages/AccountSettingsPage.tsx`，布局重写为横向 Tab，解决 vertical Tabs 压扁）。
- **天梯榜恢复接线**：成绩天梯 Tab 恢复至「我的成绩」页（StudentScores，接入点 A；此前 commit 95c0c63 曾下线），GradeLadder 系列 v2 化；可达性 3→0 全可达。
- **样式归零**：删除 `client/styles.css`（6048 行）+ `theme/legacy-bridge.css`（108 行）；最小 reset 接管进 `app.css @layer base`（box-sizing / 尺寸 / margin+overflow / color-scheme；**Preflight 未启用，另立 P7**）；背景图 `has-bg-image` 活功能迁至新建 `theme/backdrop.css`；遗留类归零（审计脚本输出「P6 目标达成」）。
- 其余：KnowledgeTagList 迁移（17 hex → 确定性散列）、叶子件语义化、`App.tsx` 残留清零、文档关闭 UI-1~7。

**5. 修复与体验**
- Radio 选中指示器 → 品牌红底白 ✓（根因 = P6 reset 未清 button UA padding，app.css 补 `padding: 0`）。
- 设置页布局重写（横向 Tab，不再压扁）。

**6. 破坏性 / 注意**
- 样式事实源变更：CSS 仅剩 `app.css` / `backdrop.css` / `tokens.css`；**禁止新建 CSS 文件、禁止硬编码 hex**。
- Preflight 待 P7。
- 死代码删除清单可从 git 历史恢复。

**验证**
- `npm run typecheck` / `npm run build:web` / `npm run build:scanner` — 全绿。
- Playwright 亮暗双主题截图走查（ui-visual-verification）。
- `npm run verify:auth` — 54/54、`npm run verify:security-critical` — 42/42（基线）。

## v1.10.2 (2026-08-04) — 网阅试卷池 + 成绩分析增强（Issue #174 #175）

> 网阅改为「试卷池」领卷模型，杜绝两位教师同时批阅同一份卷子；成绩分析新增雷达图、全部班级对比、选择题选项统计与更多对比维度。

### Issue #174 网阅试卷池
- `answer_block_crops` 新增 `claimed_by` / `claimed_at` / `claim_count`（迁移 v32 + 三套 schema），`ready/pending/disputed` 且未被领取的切块进入试卷池。
- 新增 `/api/review-pool/*`：池汇总、领下一份（支持按班级）、指定领取、释放/强制释放；领取为原子更新，并发下同一份卷只会被一位教师拿到。
- 提交后自动清空领取标记：待复核回到池中等待下一轮，已阅/争议离开池子；已领取试卷仅领取人可提交（管理员例外），非领取人提交返回冲突提示。
- 前端：逐题网阅面板与题块总分面板均改为「从试卷池领卷 → 批阅 → 提交」；阅卷分配页新增试卷池管理（汇总统计、条目列表、强制释放）。
- 验证：`scripts/review-pool-smoke.ts` 19 项断言全绿（互斥领取/冲突/释放/累计次数/提交归属）。

### Issue #175 成绩分析优化
- 跨班对比支持「全部班级」（`all=1`）与最多 30 个班级手工选择；每班新增难度系数 P、区分度 D（与考试级口径一致），响应带 `fullScore`。
- 班级对比页新增多维度雷达图（平均分率/中位分率/及格率/优秀率/难度/区分度/离散度）与选择题选项对比表（各班每选项人数与比例）。
- 题目分析 Tab 新增「选择题选项分析」面板：每道客观题各选项选择人数/比例、作答/未答人数、满分率，正确选项高亮。

### 修改文件清单
| 文件 | 改动 | 内容 |
|------|------|------|
| `src/server/db/migrations.ts` / `mysql.ts` / 三套 schema | +v32 | 试卷池三列 + 池查询索引 |
| `src/server/services/ReviewPoolService.ts` | 新增 | 汇总/领卷/释放/条目查询（原子互斥） |
| `src/server/routes/review-pool.ts` | 新增 | `/api/review-pool/*` |
| `src/server/services/ReviewService.ts` | +12 行 | 提交后清空领取标记 + 领取人归属校验 |
| `src/apps/answer-card/client/components/OnlineReviewPanel.tsx` | 重写队列 | 试卷池领卷/汇总/释放 |
| `src/apps/answer-card/client/components/GradePanel.tsx` | +40 行 | 题块总分面板池领卷 |
| `src/apps/answer-card/client/components/ReviewAssignPage.tsx` | +90 行 | 试卷池管理区 |
| `src/server/repositories/AnalysisRepository.ts` | +10 行 | 跨班对比每班 P/D、fullScore |
| `src/apps/answer-card/server/routes/analysis.ts` | +10 行 | `all=1` 全部班级、上限 30 |
| `src/apps/answer-card/client/components/AnalysisCharts.tsx` | +55 行 | `ClassRadar` 雷达图 |
| `src/apps/answer-card/client/components/OptionAnalysisPanel.tsx` | 新增 | 选项统计面板 |
| `src/apps/answer-card/client/components/ScoreDetailPage.tsx` | +120 行 | 全部班级/雷达/选项对比/难度区分度列 |
| `scripts/review-pool-smoke.ts` | 新增 | 试卷池冒烟测试（19 断言） |


## v1.10.1 (2026-08-03) — 填空题升级：自定义横线 / 插入图片 / 文字注释

> 填空题块支持逐空自定义横线（宽度、高度），支持插入题干图片，支持添加文字注释（自动折行）。

### 自定义横线
- 填空题块编辑器：每个空可单独设置横线宽（mm）与高（mm），支持逐空删除与「添加空」；块级「默认横线宽/高」作为新增空的默认值。
- 布局引擎：填空题紧凑网格按逐空自定义宽度排线，整列放不下时按比例整体缩小且不低于最小线宽；横线高度逐空生效。

### 插入图片
- 填空题块每题支持「插入图片」，沿用现有 `subjective_question_images` 存储；编辑器可调整宽/高、对齐方式（靠左/居中/靠右）并删除图片。
- 布局引擎：单元格内图片自动缩放至列宽以内，排在横线下方并计入行高；SVG 预览与 PDF 输出同步渲染。

### 文字注释
- `SubjectiveQuestion` 新增 `annotation`（文字注释/题干说明），`subjective_questions` 新增 `annotation` 列（迁移 v30）。
- 编辑器提供「文字注释」输入框；布局按单元格宽度自动折行，SVG/PDF 同步绘制。

### 修改文件清单
| 文件 | 改动 | 内容 |
|------|------|------|
| `src/shared/types.ts` | +4 行 | `SubjectiveQuestion.annotation` / `SubjectiveRenderItem.annotationLines` |
| `src/shared/layout.ts` | +150 行 | 填空单元格布局：逐空宽度、注释折行、图片排版、动态行高 |
| `src/apps/answer-card/client/pages/DesignEditors.tsx` | +100 行 | 逐空横线编辑、文字注释、图片管理、SVG 注释渲染 |
| `src/apps/answer-card/server/pdf.ts` | +4 行 | PDF 注释行绘制 |
| `src/server/repositories/CardRepository.ts` | +4 行 | annotation 持久化 |
| `src/server/db/migrations.ts` / `mysql.ts` | +8 行 | 迁移 v30 `subjective_questions.annotation` |
| `scripts/fill-blank-upgrade-smoke.ts` | 新增 | 填空题升级冒烟测试 |

## v1.10.0.4 (2026-08-03) — 统计口径统一（评审整改 PR-A）

> 统一 P/D 计算口径，修正正态性检验实现与展示，小样本不再展示区分度 D。

- 统一考试级区分度 D 口径：Python AI 工具 `get_exam_overview` 由「总分极端组差 / 满分」改为「各题 D 的算术平均」，与 Web 端 `getExamMetrics` 一致；逐题 D 复用同一实现（`_question_discriminations`），难度 P 也按「均分保留 1 位再除以满分」对齐。
- KS 正态性检验 p 值改用 Lilliefors 修正（Dallal & Wilkinson 1986 解析近似），n<5 不再给出 p 值；`normality()` 注释与实现对齐（综合判定以 Shapiro-Francia 为主判）。
- 小样本（&lt;4 人）时前端区分度 D 徽章显示「样本不足」：覆盖题目分析表、普通考试概况、大考概况整体/分科、大考逐题分析整体/分科、总体分析分布卡（`GroupMetrics.participantCount`、`GroupQuestionAnalysisResponse.overall/subjects.sampleSize`）。
- 文档：`readus/ARCHITECTURE.md` 新增 §13 成绩分析指标定义；总体分析正态性表补充 KS 参考值说明。
- 验证：`npm run typecheck` 通过；`scripts/bugfix-analysis-verification.ts` 新增考试级 D 均值与 KS 小样本断言（38/38）；TS/Python 合成数据 D 对比一致。

## v1.10.0.3 (2026-08-02) — 评审修复（大考参与口径 / 正态性 / 直方图 / 阈值）

> 修复 4 项 P0/P1 bug + 3 项非阻断观察，保证大考统计与总体分析数据准确。

**1. 大考参与口径（Bug 1，高严重）**
- `AnalysisRepository.getGroupTotalsMap` 之前无视 `exam_groups.only_full_participants` 与 `total_score_mode` 策略；缺考学生只要单科有成绩就被纳入大考总分，拉低均分与难度系数。
- 现读取 `exam_groups` 策略：
  - `only_full_participants=1` → `HAVING COUNT(DISTINCT exam_id) = member_count` 排除缺科者；
  - `total_score_mode='assigned'` → 对设有 `assigned_formula` 的考试使用 `assigned_score`（无则回退 `total_score`）。
- 全部大考相关方法（`getGroupMetrics` / `getGroupQuestionAnalysis` / `getGroupDistribution` / `getGroupClassComparison`）统一参与者口径；`getGroupMetrics.subjects[]` 不再硬编码 `gradedCount/maxScore/minScore/stdDev=0`（passRate/excellentRate 见 §6 跟进修复）。
- 测试：`scripts/bugfix-analysis-verification.ts` Bug 1 段（10 用例，全绿）。

**2. 正态性检验实现（Bug 2，高严重）**
- `shapiroFrancia`：原 W 计算未将期望正态分位数居中（den 含 `m²n` 误差），n=12 数据 W 被压至 0.014；Royston p 值近似公式含 `ln·ln·0` 笔误。
  - 修：W 改用 `[(v-v̄)·(e-ē)]² / [Σ(v-v̄)² · Σ(e-ē)²]`，p 值采用 Royston 1992 标准渐近 `μ = -1.5861 - 0.31082·ln(n) - 0.083751·ln²(n) + 0.0038915·ln³(n)`。
- `kolmogorovSmirnov`：原 D 计算两次 `Math.abs((i+1)/n - fExp)` 实际为同一值，未区分 D⁺/D⁻。
  - 修：D⁺ = max(i/n - F(x_i))、D⁻ = max(F(x_i) - (i-1)/n)。
- `normality` 综合判定：原"任一 p≥0.05 即通过"过于宽松，路径 0（10 个 0 + 1 个 100）被错判为正态。
  - 修：以 Shapiro-Francia 为主判（n<5 不可靠直接 false，n≥5 且 p≥0.05 视为正态）。
- 测试：极端偏态 isNormal=false (SF p<0.001)、正态数据 W>0.9、KS N(0,1) 50 样本不拒绝。

**3. 大考班级对比遵守阈值（Bug 3，中严重）**
- `getGroupClassComparison` 之前硬编码 `0.6` / `0.9` 算 passRate/excellentRate，与普通考试口径不一致。
- 修：改用 `thresholds.passRate` / `thresholds.excellentRate`（已 `await getAnalysisThresholds()`，变量就在上下文里）。
- 测试：调阈 0.5/0.85 后 passRate 50%→50%、excellentRate 0%→25%（之前会被 0.9 硬钉死为 0%）。

**4. 直方图区间标签（Bug 4，中低严重）**
- `histogram()`（`src/shared/stats.ts`）和 `generateDistributionRanges()`（`AnalysisRepository.ts`）之前用 "0-9"、"10-19"… 闭区间标签；归类用 `Math.floor(v/step)` 实际是半开区间 [min, min+step)。
  - 9.5 → bin 1 但标签 "0-9" 易让小数成绩（如 0.5 分档）误读为"被归到 0-9 段而不是 0-10 段"。
  - 修：标签改为 "0-<10"、"10-<20"… 末段 "90-100"；`min/max` 字段前 N-1 段仍为 `min+step-1`（兼容 SQL `BETWEEN r.min AND r.max`），末段 `max=fullScore`（闭区间，含满分；修复之前 100 不被 SQL 计入的隐藏缺口）。

**5. 非阻断观察**
- `routes/analysis.ts` `GET /exams/:examId/question-students` 之前只校验 `questionNumber`，`examId`/`classId` 无校验；补齐有限正整数校验，无效值 400。
- `getGroupMetrics.subjects[]` 中 `gradedCount/maxScore/minScore/stdDev` 之前硬编码 0；现按参与者集合实际聚合（passRate/excellentRate 见 §6 跟进修复）。

**6. 跟进修复：subjects[] 及格率/优秀率仍硬编码 0（评审遗留，2026-08-02 夜间）**
- 独立 agent 评审指出 `getGroupMetrics.subjects[]` 的 `passRate/excellentRate` 仍是硬编码 0（§5 原描述与实际不符，已更正）。
- 修：在逐科聚合 SQL 中按「该科满分 × 全局阈值」计算 `passRate = 及格线以上人数 / 实考人数`、`excellentRate = 优秀线以上人数 / 实考人数`，口径与 `getGroupClassComparison` 对总分用 `totalFull × thresholds` 一致；阈值经 `getAnalysisThresholds()` 读取（默认 0.6/0.9，管理员可配）。
- 注册永久回归：`scripts/bugfix-analysis-verification.ts` 新增断言——数学(60/60/90) passRate=100% excellentRate=33%、语文(70/50/80) passRate=67% excellentRate=0%。

**7. 跟进：逐题下钻 classId 过滤触发 `cs` 别名重复 → 500（Codex 在 PR #206 评审指出，2026-08-03）**
- 根因：`AnalysisRepository.getQuestionStudentScores()` 在 `question_scores qs` 上先 `LEFT JOIN class_students cs`（显示班级名），又插入 `classFilterQs(classId)` 返回的 `JOIN class_students cs`（按班级过滤）——同名别名 `cs` 重复；一旦传入正 `classId` 即报 `duplicate alias` / `no such column: cs.class_id`，HTTP 500。
- git blame 显示该 `cs` JOIN 来自 `f04b2e8e`（火箭，2026-08-01），**早于 PR #206**，属历史存量 bug，非 PR #206 引入；Codex 在评审 PR #206 时顺带发现。
- **冲突处理**：将本地 `cs2`/`cl` 标量子查询修复 `git stash pop` 到本分支时，与分支已合入的修复冲突——分支 `f158bce` 已用 `cs_scope`（过滤 `EXISTS`）+ `cs_display`（显示标量子查询）两个**不同别名**重写该方法，且额外覆盖 `classId===0`（无班级学生）与 `classId>0` 时显示班级名对齐过滤班级。分支方案更完整且无编译依赖（`c.join` 在该方法内已不存在），故冲突取**分支侧**，本地改动被取代；该 bug 在 PR #206 上本已修好。
- 注册永久回归：`scripts/bugfix-question-students-alias.ts` — **10 用例 全绿**（覆盖无 classId / 正 classId / classId=0（无班级）/ 双班学生不重复行 四场景，均不抛异常）。

**验证**
- `npx tsx scripts/bugfix-analysis-verification.ts` — **31 用例 全绿**（覆盖四项修复 + 阈值变更回测 + subjects 及格/优秀率）
- `npm run typecheck` / `npm run build` — 全绿
- `npm run verify:auth` — 54/54 全绿
- `npm run verify:security-critical` — 42/42 全绿
- `npx tsx scripts/grading-rules-smoke.ts` — ok
- `npx tsx scripts/bugfix-question-students-alias.ts` — **10 用例 全绿**（逐题下钻 classId 过滤 / cs 别名冲突回归）
- 真实数据回归：演示大考（6 科 16 人）`getGroupMetrics.subjects[].gradedCount/maxScore/minScore/stdDev` 现全部为真实值（非 0），分布 isNormal=true（p=0.38），班级对比 passRate=100%/excellentRate=38% 正确反映配置阈值。

## v1.10.0 — 成绩分析增强（难度 P / 区分度 D / 总体分析 / 大考 6-Tab）

> 分析模块重构：普通考试与大考统一为 6-Tab 结构，新增难度系数 P、区分度 D 双指标（考试/大考/科目/题目四级）、题目分析排序与逐生下钻、总体分析分布可视化，以及大考 AI 分析。

**1. 难度 P / 区分度 D 双指标**
- 后端 `AnalysisRepository` 经 `discriminationByExtremeGroup`（`src/shared/stats.ts`，极端组法 27%）在考试、大考、科目、题目四级统一产出 P/D；分布结果 `DistributionResult` 新增 `qq`（Q-Q 图坐标）。
- 前端 `DifficultyBadge` / `DiscriminationBadge` 彩色档位徽章；档位阈值由管理员在 Home「全局设置」配置，持久化于 `system_settings.analysis_difficulty_bands` / `analysis_discrimination_bands`，前端经 `useBands()` 读取。

**2. 题目分析：可排序 + 逐生下钻**
- `AnalysisQuestions` 表头可点击排序（题号/类型/得分率/正确率/平均分/满分/错误率/P/D）。
- 点击行打开 `QuestionStudentScoresModal` 查看该题每个学生的得分明细（学号/姓名/班级/得分率/知识点）；大考下钻复用 per-exam 的 `/api/analysis/exams/:examId/question-students` 端点。

**3. 总体分析 Tab（整合 score_distribution_viewer）**
- 新增 `AnalysisOverall`（普通考试与大考共用）：直方图（叠加正态曲线）+ Q-Q 图 + 正态性检验（Shapiro-Wilk / KS / AD / 偏度 / 峰度）；普通考试按全卷与各班、大考按总分/各科/各班切换；样本量 < 30 给出小样本提示。

**4. 双 6-Tab 结构**
- 普通考试（`ScoreDetailPage`）与大考（`ExamGroupDetailPage`）均为：概况/成绩/题目分析/班级对比/总体分析/AI 分析。大考的「成绩/题目分析/班级对比」支持「合并 ↔ 分科」视图切换（SubjectViewMode）。「班级对比」与「题目分析」共存，不互相替代。

**5. 大考 AI 分析**
- 新增 `POST /api/exam-groups/:groupId/ai-analysis`；Node 仅传 `groupId`，`llmclient /analysis/run` 经 `get_group_exam_ids` 解析成员考试集合下传工具层，模型按成员考试逐科汇总。工具返回体新增 P/D（`get_exam_overview` / `get_question_analysis`），工具层强制校验 `examId` 属于大考成员。

**验证**：`npm run typecheck` 与 `npm run build`（web + server）通过；仓库分析数据（考试 26、大考 8）冒烟验证指标、分布（含 Q-Q）、逐生下钻、大考聚合、班级对比均返回结构正确；区分度算法经合成数据单测确认（清晰梯度 D≈0.8）。

## v1.10.0.1 (2026-08-01) — 区分度 D 全为 0 修正

修复 v1.10.0 引入的区分度计算缺陷：题目分析在组装逐生小题得分时，聚合查询列别名为 `question_type`，但下钻取 `byQuestion` 映射时误用了 `r.score_type`（在聚合结果中为 `undefined`），导致每个题的 `byQuestion.get(key)` 均返回 `undefined`、区分度极端组法被跳过，前端所有题目的区分度 D 恒为 0（难度 P 正常）。

- `src/server/repositories/AnalysisRepository.ts`：`computeQuestionAnalysis` 的查表键由 `${r.question_number}:${r.score_type}` 改为 `${r.question_number}:${r.question_type}`，与 `byQuestion` 的键对齐。
- 验证：`getQuestionAnalysis(26)` 从「11 题 D 全 0」恢复为「9/11 非 0」；大考 `getGroupQuestionAnalysis(8)` 逐题区分度经同一修复路径恢复正常。区分度算法本身经合成数据单测确认正确（清晰梯度 D≈0.8），与 Python `llmclient` 工具层 `_extreme_group_discrimination` 结果一致；修复后 TS 与 Python 两侧 P/D 输出对齐。

## v1.10.0.2 (2026-08-01) — 班级筛选下题目分析崩溃修复

修复 v1.10.0 引入的第二个回归：`getQuestionAnalysis` 在**带 classId 筛选**时抛出 `SqliteError: no such column: qs.student_id`。

- 根因：`getQuestionAnalysis` 把 `classFilterQs(classId)`（其 JOIN 条件为 `cs.student_id = qs.student_id`，引用 `question_scores` 别名 `qs`）同时用于 `getExamTotalsMap`；而 `getExamTotalsMap` 查询的是 `student_scores ss`，该语句内并无 `qs` 表，故带 classId 时 JOIN 引用了不存在的 `qs.student_id`。无 classId 时 `classFilterQs` 返回空 JOIN，故此前全量（未筛选班级）冒烟未暴露此问题。
- 修复：`getQuestionAnalysis` 对 `getExamTotalsMap` 改用 `classFilter(classId)`（JOIN 条件 `cs.student_id = ss.student_id`，与 `student_scores ss` 对齐）；题目聚合查询与逐生小题得分查询仍用 `classFilterQs`（作用于 `question_scores qs`）。两者按同一班级筛选，学生集合一致，区分度极端组法对齐无误。
- 影响面：班级筛选下的题目分析、概况（P/D 以外的统计）、逐生下钻等路径此前在选班级时 500；大考逐题下钻复用 per-exam 端点，同样受益。无班级筛选的主路径不受影响。
- 验证：`npm run verify:auth` 由「54 项中 1 项异常」恢复为 **54/54**（`getExamOverview(examId, classId)` 用例）；`getQuestionAnalysis(26, 62)` 返回 11 题（9 非 0 D）无异常；`verify:security-critical` 42/42、`grading-rules-smoke` 通过、`npm run build` 通过。

## v1.9.6 (2026-07-31) — 在 #201 基线上合入 #193，修复填涂号区回归（PR #202）

> 基于 #201 基线（fix/pr193-on-201）合入 #193（作文格修复、移动端适配、受控资源路由等），并修复 #193 引入的填涂号区回归。
> 验证：`tsc --noEmit` 0 错误；默认配置布局输出与 #201 逐字节一致。

**1. 填涂号区回归修复（P0）**
- #193 曾将学生信息区重构为「标准表格形态」（顶部 0-9 表头行 + 左侧空框列），与 PDF/SVG/识别器坐标不一致导致格子错位。
- 已回退到 #201 实现：`layout.ts`（colGap 自适应格子）、`pdf.ts drawStudentArea`、`DesignEditors StudentAreaSvg`、`types.ts StudentAreaLayout` 四处保持一致，默认输出与 #201 逐字节一致。

**2. 学生信息区字段开关生效（P1）**
- `DesignPage` 的「基本信息字段」开关（姓名/班级/座位号/考号）与「显示注意事项」此前只写入 `studentInfo`、布局引擎不读取，勾选无效果。
- 现在 `layoutStudentArea` 按开关生成 `fieldRows` 与 `notesLines`（复用自动换行），PDF/SVG 渲染层同步按 `fieldRows`/`notesLines` 绘制；三处渲染共用同一数据源，从架构上消除「三处不一致」的回归根因。
- 新增「学号（填涂号区）」开关支持：关闭后不生成涂写格（识别器对空 `student_digits` 返回 `not_present`，不判失败）。

**3. 移动端抽屉版本号修复（P2）**
- `MobileDrawer.tsx` 曾硬编码 v1.9.2，现恢复为动态 `import.meta.env.VITE_APP_VERSION`（与桌面端一致）。

**4. README 补回爱发电地址行（P2）**
- #201 直推 main 的爱发电地址在冲突解决时被丢弃，已按 main 原样补回。

**5. 清理合并痕迹（P3）**
- `server/index.ts` 一行双 import 拆分；`GlobalSettingsRoutePage` 类名对齐 main（`global-settings-grid`）；`layout.ts`/`types.ts` 死代码（`DEFAULT_STUDENT_NOTES`/`measureTextWidthMm`/`wrapNotesLines`/`StudentAreaFieldRow`）随本次改造转为被使用或被清理。## v1.9.6 (2026-07-24) — 实机问题修复（5 项）

> 基于 1.9.4 实机测试发现的 5 个小问题，全部经 `npm run build`（typecheck + web + server）验证通过，无 TS 错误。
> 分支：1.9.5 基线（井号191）。与 1.9.6 答题卡设计器（学生信息区/作文格）改动相互独立，可叠加。

**1. 刷新网页重置背景图透明度（P1）**
- `AccountMenu.tsx`：背景图透明度滑杆原本只改本地状态与 `--bg-opacity` CSS 变量、未持久化；现改为防抖（400ms）PATCH `/api/users/me/settings` 的 `backgroundOpacity`。
- 后端 `users.background_opacity` 早已支持 GET/PUT，`App.tsx` 登录即加载并应用，刷新后恢复。

**2. 上传原卷只能上传一张图片（P1，新增多页支持）**
- 新增数据表 `original_paper_pages`（card_id, page_index, filename, stored_path），三份 schema（SQLite/MySQL/MariaDB）均 `CREATE TABLE IF NOT EXISTS`，服务启动自动建表。
- 上传路由 `paperUpload.single("file")` → `paperUpload.array("files", 40)`，逐页入库；首页（page 1）仍写 `original.<ext>` 以向后兼容预览/导出/AI 读取。
- `GET /paper` 支持 `?page=N`；`/paper/info` 返回 `pages` 列表；新增 `DELETE /paper/page/:pageIndex` 单页删除；`DELETE /paper` 清空全部页与文件。
- `getPaperFiles`（AI 知识点分析）改为读取全部页。
- 前端 `DragDropZone` 支持 `multiple` + `onFiles`；`PaperUploadPanel` 改为多文件选择与「第 N 页」列表（查看/单页删除/删除全部）。

**3. 「返回首页」按钮位置调整（已回滚，P2）**
- `App.tsx`：曾将顶栏左侧的「← 返回首页」按钮改为 `position: fixed` 视口左下角浮动按钮（bottom:40px, left:16px），但该按钮位于带 transform 的顶栏祖先内，`fixed` 定位被该祖先包含，最终渲染到左上方并与文字重叠。
- 已回滚为原始内联按钮（顶栏左侧、`marginRight:12`，仅 `!showTabBar && mode!=="home"` 时显示），消除重叠。原「位于正上方」的体感问题暂不处理，待后续统一评估导航布局。

**4. 「全局设置」按钮彻底失效（P1）**
- 根因：`App.tsx` 的 `<Routes>` 缺少 `/global-settings` 路由，点击后落到 `path="*"` 重定向回 `/home`。
- 新增 `pages/GlobalSettingsRoutePage.tsx` 包裹 `GlobalSettingsPage`（提供 `onBack`），并补上 `<Route path="/global-settings">`。

**5. 「最新扫描」被「考试管理」负优化（P2）**
- `HomePage.tsx` 首页快捷入口原为三元互斥（继续阅卷 > 最新扫描 > 考试管理），导致「最新扫描」被「考试管理」取代。
- 改为多卡并列：有未完成阅卷则显示「继续阅卷」、有最新扫描则显示「最新扫描」，且「考试管理」始终显示（无动态卡时至少保留入口）。

**6. 「全局设置」页面前端美化（P3）**
- `GlobalSettingsPage.tsx`：原左对齐、`maxWidth:640`、无容器包裹，观感简陋。
- 改为整页居中布局（`minHeight: calc(100vh - 96px)` + flex 纵向留白 + 横向 `alignItems: center`），内容包入 `maxWidth: 560` 的圆角卡片（边框 + 阴影）；标题升级为 18px/600 并加「仅管理员」徽标，整体居于页面中央。
- 注：路由补全（item 4 的 `GlobalSettingsRoutePage`）保留不变。

**7. 暗色模式首页快捷入口卡「糊掉」配色修复（P2）**
- 现象：`home-quick-card-*`（琥珀/蓝/紫/灰）使用高饱和浅色硬编码背景（`#FFF8E1`、`#E6F1FB`、`#EEEDFE`、`#F1EFE8`），在 `[data-theme="dark"]` 下与浅色文字（`--text-primary`）对比度极低，形成一块「糊掉」的亮块（实测「考试管理」紫卡最严重）。
- 修复：`styles.css` 新增暗色模式覆盖——将四色背景改为半透明低饱和色（`rgba(255,160,0,0.12)` / `rgba(55,138,221,0.12)` / `rgba(127,119,221,0.15)` / `rgba(139,148,158,0.12)`），左边界色改为对应高明度色；hover 阴影加深以适配暗底。
- 保持浅色模式原有 pastel 配色不变。

## v1.9.5 (2026-07-23) — 移动端 Web UI/UX 适配

> 在冻结技术栈（React 19 + TS + Vite 7，不引入新依赖、不引入第三方状态库、不改后端/DB schema、延续 Context 模式）前提下，完成移动端功能与界面适配。三项决策：**App.tsx 适度拆分**（抽离 6 个 mode 页面为独立路由组件，不引入状态库）；**优化重心=功能可用性优先**；**断点收敛为 3 级**（480 手机 / 768 平板 / 1024 桌面）。全部改动经 `npx vite build --mode web` 验证通过，无 TS 错误。

**基础设施（断点单一事实源）**
- 新建 `client/breakpoints.ts`：导出 `BP = { phone: 480, tablet: 768, desktop: 1024 }` 及 `maxWidthQuery()` / `minWidthQuery()` 辅助函数，作为全仓响应式断点唯一真相源。
- 新建 `client/hooks/useMediaQuery.ts`：`matchMedia` hook + `useIsMobile()` / `useIsTablet()` / `useIsDesktop()` 派生 hook（SSR 安全，避免水合不匹配）。
- `client/theme.ts`：re-export `breakpoints` 镜像，供 JS 侧一致引用。

**Modal 规范化（止血）**
- `styles.css`：修复 480px 块 `.modal-backdrop` → `.modal-overlay` 断链（旧类名无样式导致遮罩失效）；`.modal-card` 新增抓手条（`::before` 36×4px）+ 安全区 `padding-bottom: env(safe-area-inset-bottom)`；`:root` 新增 `--bp-phone/--bp-tablet/--bp-desktop`。
- 删除 `styles.css` 尾部重复段（6554–6746 行），消除样式覆盖冲突。
- `components/ui/Modal.tsx`：移除内联 `maxHeight:"85vh"` 与 `width:"92vw"`（由 CSS 类统一控制），保留 `cardStyle` 逃生门。

**App.tsx 拆分 + 移动抽屉导航**
- 抽离路由页：`pages/HomeRoutePage.tsx` / `AnalysisRoutePage.tsx` / `ScoresRoutePage.tsx` / `AccountRoutePage.tsx` / `InfoRoutePages.tsx`（sponsor/permissions/guide 三合一，统一 `navigateBackFromInfo()` 返回）。`App.tsx` 由 2398 行降至 2325 行。
- 新建 `components/MobileDrawer.tsx`：承载 9 个 mode 导航 + 设计模式操作 + 主题切换，ESC / 遮罩关闭。
- `WorkspaceContext.tsx`：`WorkspaceValue` 增加 `drawerOpen` / `setDrawerOpen`。
- `App.tsx`：新增 `drawerOpen` 状态；顶栏左侧加汉堡按钮（仅 480px 显示）；渲染 `MobileDrawer`。`styles.css` 新增 `.mobile-menu-button` / `.mobile-drawer-overlay` / `.mobile-drawer` / `.drawer-nav-item` 及暗色覆盖。

**表格卡片化（零 JS，480px 自动）**
- `styles.css`：新增 `.data-card-list` / `.data-card` / `.data-card-row` / `.data-card-actions`；新增 `.table-cards`（480px 块内，依据 `td[data-label]` 将表格转为卡片，无需 JS）。移除三处强制 `min-width`（`.analysis-ranking-table` 560px / `.student-subject-table` 500px / `.account-table` 600px）。
- 新建 `components/ui/DataCard.tsx`：通用卡片组件，支持 `rows` / `actions` / `onClick`。
- 应用：`AnalysisRanking`、`ExamManagePage`、`ExamSelectPage`、`CardSelectPage`、`ScoreTable`、`UserManagement`、`StudentManagement` 均加 `useIsMobile` 条件渲染（移动端 `DataCard`，桌面保留原表格）。

**HomePage 响应式 + 输入控件清理**
- 重写 `components/HomePage.tsx`：内联样式全替换为 CSS 类（`.home-container` / `.home-welcome*` / `.home-quick-grid` / `.home-quick-card` 等 4 色变体 / `.home-module-grid` / `.home-card*`）。
- `styles.css`：新增 `.home-*` 基础类（约 100 行）+ 480px 块响应式（padding 16px、title 18px、单列、44px 触摸区）。
- 清理输入控件 `fontSize:13` 内联（`ExamSelectPage:628` / `AnalysisAiPanel:200` / `ScoreDetailPage:257`），避免 iOS Safari 触发 300ms 缩放与字号跳变。

**指标**
- 新增文件 9 个；`styles.css` 6746 → 6930 行；`@media` 13 → 12 处；`App.tsx` 2398 → 2325 行；`package.json` 版本号 v1.9.5。
- 全部改动 `npx vite build --mode web` 通过，无 TS 错误。

**遗留（后续迭代）**
- 断点归并（1300/1060→1024，860/760/700→768，横屏保留方向）——风险较高，待截图对比 1100/800/720px 后实施。
- 暗色模式扩展覆盖 `.data-card`。
- 阶段 5 手势增强（`useSwipeClose` / `usePullToRefresh` 原生 touch，可选）。
- 真机验证：iOS Safari + Android Chrome，480px 全功能可达、无横向溢出、输入框不缩放。


---

## v1.9.2 (2026-07-21) — 网页化改造 / 启动台模式 + 前端风格统一 + BUG 修复

本版本是「审计 → 修复 → 统一 → 网页化」一揽子改造，分三阶段落地（前情见内部工作文档 `.workbuddy/plans/AUDIT-2026-07-20.md` / `PLAN-2026-07-20.md` / `SMOKE-2026-07-20.md`，不进仓库）。

### 阶段 0：BUG 修复（运行时已验证，见 `.workbuddy/plans/SMOKE-2026-07-20.md`）

- **赋分公式路由缺失（P0，功能性 404）**：前端 `AssignedFormulaModal` 调用 `GET/PUT /api/exams/:examId/assigned-formula`，后端从未注册该路由。新增路由（`requireExamAccess` 保护），经 `AssignedScoreService` 暴露。SMOKE 实测：GET 返回 `{formula,isAssignedSubject,presets}`，PUT 保存生效，不再 404。
- **Express 5 async 未捕获拒绝（P1，防请求挂死）**：新增 `server/lib/asyncHandler.ts` + `wrapRouter`，`createApp()` 内对全部 router/handler 统一包裹；async handler 抛错 → 转发错误中间件返回 500 JSON，不再永久转圈。
- **鉴权语义不统一（P1）**：`authMiddleware` 现读 `PROJECTX_AUTH_ENFORCE`（与 `makeGate` 一致）；默认开启，关闭且无 token 时放行（保留「无登录可用」兼容），开启时要求有效令牌。
- **其他小修**：删除 `index.ts` 重复的 `/api/app/health`（保留一处并加 try/catch）；`backup.ts` 的 `VACUUM INTO '[object Object]'` 增加单引号转义（防 Windows 用户名含单引号导致的语法错误/注入）；`score-editing.ts` 对 `scores` 数组元素与 answers 题号键做校验（非法即 400）。

### 阶段 1：前端统一（设计令牌 + 组件库 + 硬编码色收敛）

> 审计发现：存在完整设计系统（`styles.css` 6601 行 / 829 个类 + 暗色主题），但 84% 组件在写内联 `style`（1015 处内联 / 206 处硬编码色），同一语义多种硬编码色（成功绿 `#2E7D32`×15 等）。根因是「基类已写好、后续开发全 inline」。本阶段以「回流」为主。

- **设计令牌 / 组件库地基**：新建 `client/theme.ts` 镜像 `styles.css` 的 `:root` 变量为 TS 对象（供 JS 侧图表/状态点引用，杜绝「同文件混用 `var(--brand)` 与 `#2E7D32`」）；`styles.css` 新增语义色 `--success:#2E7D32; --warning:#E65100; --info:#1565C0` + `--z-*` z-index 阶梯（`--z-modal:1000` / `--z-toast:1100` / `--z-lightbox:1200` / `--z-dropdown:900`），为收敛 `100→100000→999999` 的 z-index 通胀打底；补全 ScannerApp 缺失的 `.loading-screen` / `.loading-spinner` 等类（修复扫描端加载屏无样式）。
- **共享 UI 组件库** `components/ui/*`：`Button` / `Modal`(Portal + 统一层级) / `SegmentedControl` / `Input` / `Panel` / `Table` / `Spinner` / `LoadingScreen`，封装 5 种模态实现 + 4 套分段控件 + 裸 `<table>` 等不一致。
- **重复硬编码色收敛（批 1）**：全仓散落的「成功绿」 `#2E7D32`（15 处）统一替换为 `var(--success)`（AccountMenu / AssignedFormulaModal / LoginPageScanner / ScannerPanel / StudentScoreDetail / ScoreFixPage 共 6 文件，`replace_all` 完成），消除同一语义多种硬编码色。

### 阶段 2：网页化改造 / 启动台模式（每功能独立 URL）

- **URL 路由化**：引入 `react-router-dom` v7，`main.tsx` 改用 `createBrowserRouter`（数据路由，`useBlocker` 方可生效）；新增 `modeRoutes.ts`（`MODE_PATH` 模式↔路径映射 + `pathToMode()`）；`mode` 改为 URL 驱动（初始从 `pathToMode(location.pathname)` 派生，地址栏↔mode 双向同步）；顶栏改为 6 个 `<NavLink>`（首页 / 设计 / 考试管理 / 分析 / 我的成绩 / 账号）。
- **根因修复（关键）**：登录初始化 effect 原先无条件 `setMode(defaultModeForUser)`（=home），会把深链 / 新标签打回 home → 打开 `/design` 新标签仍显示 home、「新窗口打开」看似无效。改为「地址栏已是功能路径则尊重之，否则回退默认首页」。
- **启动台模式（每功能新开界面）**：首页所有模块卡（设计 / 考试管理 / 分析 / 账号）改为 `onOpenNewTab`，点击在**新前台标签**打开该功能 URL，首页保留为常驻启动台；子页面「← 返回首页」按钮仅在关闭顶栏导航（紧凑模式 `!showTabBar`）时显示，避免与顶栏「首页」NavLink 重复；删除冗余的顶栏「在新窗口打开当前功能」按钮。
- **未保存离开确认**：`useBlocker` 拦截离开 `/design` 时的未保存改动，弹确认 Modal。
- **页面组件抽取（props 透传范式，零行为风险）**：`pages/DesignPage.tsx`（答题卡设计）、`pages/ExamManagePage.tsx`（考试管理）、`pages/GradingPage.tsx`（阅卷面板，原 `grading-grid` 为常驻隐藏的状态容器，实际阅卷 UI 由 `GradePanel` 弹层承载）从 `App.tsx` 巨石抽出；`WorkspaceContext.tsx` 声明 `WorkspaceValue` 类型骨架（含 `addEssayBlock`），为后续 `useWorkspace()` 全量接线铺路；三个编辑器（`CardPreview` / `ObjectiveEditor` / `SubjectiveEditor`）与全部 handler 以 props 原样传入，函数引用不变 → 交互行为完全一致。

### 阶段 2 续：领域模型抽取 + 状态外置 + 真实路由化（tsc + web 构建均 EXIT 0）

- **领域模型抽取（B1，解环瘦身）**：把设计器相关的纯函数从 `App.tsx` 收编到 `client/cardModel.ts`（`modeLabels` / `optionLayoutLabels` / `styleLabels` / `kindLabels` / `blankLabelStyleLabels` / `subjectiveBlockKind` / `subjectiveBlockKindLabel` / `answerBlankItems` / `cloneCard` / `answerText` / `defaultObjective` / `defaultSubjective` / `defaultBlankBlock` / `defaultEssayBlock` / `defaultAnswerBlankQuestion` / `answerLineCount` / `heightForAnswerLines` / `numericQuestionValue` / `findNextQuestionNumber` / `defaultBlankQuestion` 等 20+ helper，以及 `PreviewMode` / `PREVIEW_SETTINGS_KEY` / `PREVIEW_MIN_PERCENT` / `PREVIEW_MAX_PERCENT` 预览设置常量）；把三个编辑器及其 SVG 预览从 `App.tsx` 抽到 `client/pages/DesignEditors.tsx`（`ObjectiveEditor` / `SubjectiveEditor` / `CardPreview` / `StudentAreaSvg` / `ObjectiveSvg` / `SubjectiveSvg`）。`App.tsx` 体积由 ~3700 行降为 ~2290 行，仅保留状态与 handlers。
- **状态外置（B2，全量接线 WorkspaceProvider）**：`WorkspaceContext.tsx` 的 `WorkspaceValue` 由骨架升级为完整值对象（~119 字段，含 `selectedExamId` / `setSelectedExamId` / `onStartReview`，`subjectiveBlockKindLabel` 收敛为 `(SubjectiveBlock) => string`，`PdfWarningState.validation` 对齐为 `CardScoreValidationResult`），`App.tsx` 用 `<WorkspaceProvider value={workspace}>` 包裹整个 `<main>` 壳层；`pages/DesignPage.tsx` / `pages/ExamManagePage.tsx` 改为 `useWorkspace()` 消费共享状态（`teacherId` / `teacherRole` / `userRole` 由 `user` 派生），去掉逐层 props 透传；`DesignPage` 直接从 `./DesignEditors` 导入编辑器，`App.tsx` 删除对 DesignEditors 的失效 import。`GradingPage` 按计划仍保留 props 范式（未切 `useWorkspace()`）。
- **真实路由化（C，阶段 2 收官）**：`App.tsx` 由「`mode` 状态 + CSS `hidden-panel` 全挂载切换」改为由 URL 真实驱动渲染——`<Routes>` 路由表：`/home`(默认) 、`/design/*` 、`/exam-manage` 、`/analysis` 、`/scores` 、`/account` 、`/sponsor` 、`/permissions` 、`/guide` ，`*` → `<Navigate to="/home" />` ；`gradingPanel` 浮层与 statusbar 保持在 `<Routes>` 之外（阅卷功能由 `GradePanel` 弹层承载）。`mode` 状态早已由登录初始化 effect 与 URL 实时同步，顶栏标题 / `showCardSidebar` / `useBlocker` 等全部自动正确（拆而不改行为）。回归点修复：账号菜单 `onOpenGuide` / `onOpenPermissions` 原先只 `setMode` 不 `navigate`，路由化后 URL 不变会导致页面不切换，已改为先 `previousModeRef.current = mode` 再 `switchMode(x)`，与 `onOpenSponsor` 一致。（注：`/grading` 孤儿路由已于后续「阶段 2 续 2」BUG-4 修复中移除。）

### 阶段 2 续 2：安全与路由 bug 修复（来自审计清单 BUG-1 / BUG-4，tsc + web 构建均 EXIT 0）

- **BUG-1 鉴权强制判定语义相反（安全隐患）**：修复前 `authMiddleware`（`src/server/middleware/auth.ts`）用模块级常量 `ENFORCE_AUTH = PROJECTX_AUTH_ENFORCE === "1" || === "true"`（默认放行），而 `createApp`（`src/apps/answer-card/server/index.ts`）用 `enforceAuth = PROJECTX_AUTH_ENFORCE !== "0" && !== "false"`（默认强制）——两者语义相反。后果：当 `PROJECTX_AUTH_ENFORCE` 未设置或设为 `yes` / `on` 等非字面值时，`createApp` 认为强制开启，但 `authMiddleware` 退化为 `optionalAuth`，对它**直接保护**的路由无 token 也放行。修复：新建 `src/server/auth/enforce.ts` 导出唯一真相源 `resolveEnforceAuth()`（未设置 / 非 `0`/`false` → 强制，仅 `0`/`false` → 关闭）；`authMiddleware`、`makeGate` 依赖的 `authEnforced`（`src/apps/answer-card/server/middleware.ts`）、`createApp` 的 `enforceAuth` 三处统一调用该函数。运行时验证判定矩阵：`(unset)` / `yes` / `on` / `1` / `true` → **强制**，`0` / `false` → 关闭。
- **BUG-4 `/grading` 孤儿路由 + 永久隐藏（功能死链）**：修复前 `App.tsx` 的 `<Routes>` 含 `<Route path="/grading" element={<GradingPage active={false} .../>} />`，但 `ProjectXAppMode`（`src/shared/appVariant.ts`）联合类型与 `MODE_PATH`（`modeRoutes.ts`）均不含 `grading`，顶栏也无入口，且 `active={false}` 使页面被 `hidden-panel` 永久隐藏——是「可达但不可见」的死链。修复：移除该孤儿路由与 `GradingPage` 的 import。实际阅卷功能由 `GradePanel` 弹层承载（`exam-manage` 的「网阅」按钮触发 `onStartReview` → `setGradingPanel`），与本路由无关，功能不受影响。`src/apps/answer-card/client/pages/GradingPage.tsx` 文件保留（合法组件，未来若启用独立阅卷页可直接复用），不再是死链。

### 新增依赖
`react-router-dom` v7、`express-rate-limit`（登录限速，阶段 0 已用）。

### 修改文件清单（节选）

| 文件 | 阶段 | 内容 |
|------|------|------|
| `src/apps/answer-card/server/index.ts` | 0 | assigned-formula 路由 + async 包装 + 删重复 health |
| `src/server/lib/asyncHandler.ts` | 0 | 新增 async 错误包装 |
| `src/server/middleware/auth.ts` | 0 | 鉴权读 enforceAuth |
| `src/server/routes/backup.ts` / `score-editing.ts` | 0 | 单引号转义 / 入参校验 |
| `src/apps/answer-card/client/theme.ts` | 1 | 新增令牌镜像 |
| `src/apps/answer-card/client/styles.css` | 1 | `--success/--warning/--info` + `--z-*` + 补 loading 类 |
| `src/apps/answer-card/client/components/ui/*` | 1 | Button/Modal/SegmentedControl/Input/Panel/Table/Spinner/LoadingScreen |
| `src/apps/answer-card/client/main.tsx` | 2 | createBrowserRouter |
| `src/apps/answer-card/client/modeRoutes.ts` | 2 | 新增路由映射 |
| `src/apps/answer-card/client/App.tsx` | 2 / 2续 | URL 驱动 + NavLink + 抽 DesignPage/ExamManagePage/GradingPage；2续：cardModel 导入 + WorkspaceProvider 包裹 + 真实 `<Routes>` + guide/permissions 导航修复 |
| `src/apps/answer-card/client/cardModel.ts` | 2续(B1) | 新增：收编 20+ 设计 helper + PreviewMode/PREVIEW_* 预览常量 |
| `src/apps/answer-card/client/pages/DesignEditors.tsx` | 2续(B1) | 新增：ObjectiveEditor/SubjectiveEditor/CardPreview/StudentAreaSvg/ObjectiveSvg/SubjectiveSvg |
| `src/apps/answer-card/client/pages/DesignPage.tsx` / `ExamManagePage.tsx` | 2 / 2续(B2) | 新增页面组件；2续：改 `useWorkspace()` 消费，去掉 props 透传 |
| `src/apps/answer-card/client/pages/GradingPage.tsx` | 2 | 新增页面组件（props 范式，未切 useWorkspace） |
| `src/apps/answer-card/client/WorkspaceContext.tsx` | 2 / 2续(B2) | WorkspaceValue 骨架 → 完整值对象（~119 字段） |
| `src/apps/answer-card/client/components/HomePage.tsx` | 2 | 模块卡全部单开新标签 |
| `src/apps/answer-card/server/validation.ts` | 3 | `UpdateUserSettingsSchema` 补 requireOriginalPaper/highlightMissingPaper/showTabBar |
| `src/apps/answer-card/server/index.ts` | 3 | GET settings 补 showTabBar 返回 + 删重复 assigned-formula 路由 |
| `readus/ARCHITECTURE.md` | 3 | 前端架构重写（路由化/页面抽取/设计令牌/UI 组件库）+ v1.9.2 摘要 |
| `readus/DATABASE.md` | 3 | 版本号 v1.9.0 → v1.9.2 |
| `readus/KNOWN-ISSUES.md` | 3 | 审查版本号 + 最后更新日期 |
| `README.md` | 3 | CHANGELOG 描述更新 |

### 验证
- `npx tsc --noEmit` → EXIT 0（阶段 3 修复后仍通过）
- `npx vite build --mode web` → 1919 模块通过（阶段 3 修复后仍通过）
- SPA 深链（vite preview 实测）：`/` `/design` `/exam-manage` `/analysis` `/scores` `/account` `/sponsor` `/guide` `/permissions` 及未知路径 `/totally-unknown` 均 HTTP 200（SPA fallback 正常），`<Routes>` 由 URL 真实驱动渲染。
- B1/B2/C 收尾验证：`npx tsc --noEmit` 与 `npx vite build --mode web` 在 cardModel/DesignEditors 抽取、WorkspaceProvider 全量接线、真实 `<Routes>` 路由化后均 EXIT 0（`/api/app/background` 构建期未解析为良性提示，chunk >500kB 为既有告警，均非错误）。
- 阶段 0 四项修复经 `.workbuddy/plans/SMOKE-2026-07-20.md` 运行时验证通过（赋分公式复活、async→500、鉴权统一、score-editing 校验）
- 阶段 3 经全量代码审查：Grep 确认 assigned-formula 路由无重复、settings schema 字段与前端的 payload 对齐、GET/PUT settings 两端字段一致、文档版本号全部同步
- ⚠️ 无浏览器运行时 QA：抽取页（设计 / 考试管理 / 阅卷）需本地 `npm run dev` 实点冒烟。

### 阶段 3：发布后验证修复（2026-07-21 下午）

以上三阶段完成后经全量代码审查 + `tsc --noEmit` + `vite build --mode web` 验证，发现并修复 3 项回归问题：

- **🔴 assigned-formula 路由双重注册（P0，合并冲突残留）**：`index.ts` 中 `GET/PUT /api/exams/:examId/assigned-formula` 各出现两次（1554+1637、1581+1659），第二组为死代码（Express 只匹配第一组）。根因为合并时两版实现均被保留。已删除 1636–1680 行重复块，保留第一组。
- **🔴 保存用户设置静默失败（P0，Zod schema 滞后）**：`validation.ts` 的 `UpdateUserSettingsSchema` 仅定义 4 字段（scoreDisplayMode / reviewConfidenceThreshold / aiApiKey / backgroundOpacity），但前端 `AccountMenu.saveSettings()` 发送 6 字段（多了 requireOriginalPaper / highlightMissingPaper / showTabBar）。Zod `z.object()` 默认**静默剥离未知键**，`validateBody` 又以 `req.body = result.data` 覆盖原始 body → PATCH handler 收到的 req.body 缺失后三字段 → UPDATE 跳过 → 设置从未写入数据库、前端却显示"已保存"。根因为火箭在 7/4（加 requireOriginalPaper+highlightMissingPaper）和 7/19（加 showTabBar）两次往前端扩展字段时均忘记同步更新 schema。已补全 `requireOriginalPaper` / `highlightMissingPaper` / `showTabBar`（`z.coerce.boolean().optional()`）。
- **🟡 架构/数据库/已知问题文档版本滞后（P1/P2）**：`ARCHITECTURE.md` 仅描述到 v1.9.0，缺失路由化/页面抽取/设计令牌/UI 组件库等 v1.9.2 关键变更；`DATABASE.md` 与 `KNOWN-ISSUES.md` 版本标记停留在 v1.9.0；`README.md` CHANGELOG 描述仍写"v1.9.0 网上阅卷重构"。已全部同步更新到 v1.9.2，`ARCHITECTURE.md` 前端架构章节重写。
- **🔴 GET settings 缺失 showTabBar（P1，与上一项同源）**：`GET /api/users/me/settings` 未返回 `showTabBar` 字段，但前端 `AccountMenu` 的 `setShowTabBar(s.showTabBar === 1)` 依赖该字段，导致设置面板的「显示底部 Tab 导航栏」开关永远加载为关闭状态（`undefined === 1` → `false`），与数据库实际值不一致。PATCH 端已能正确写入，但读取端漏了。根因同上：火箭 7/19 加 `showTabBar` 时只改了 PATCH handler 和前端 saveSettings，忘记同步改 GET handler。已补 `showTabBar: (user as any).show_tab_bar ?? 0`。

---

## v1.9.1 (2026-07-19) — 答题卡设计器全面增强

### 作文块（essay block）

新增作文格答题卡设计功能，支持 A3 三栏标准作文纸渲染。

- **类型 `EssayGridConfig`**：columns / rows / cellWidthMm / cellHeightMm / targetChars / showTitle / lineColor / lineWidthMm（8 字段）
- **布局引擎**（`layout.ts`）：`layoutEssayBlock()` 函数生成 A3 三栏网格，支持跨页续排
- **设计器 UI**：新增「作文块」按钮 + inspector 面板（目标字数、格子尺寸、题号开关）
- **SVG 预览**：实时渲染作文格，「题：（000）」题号
- **PDF 导出**：完整格子网输出，黑色 `#222` 0.15mm 细线
- **语文模板**：`essayBlock()` 默认 60 分 / 600 字

### 解答题横格划线增强

`lineGrid` 字段从 2 字段扩展为完整的 `LineGridConfig`（7 字段）。

- **新增可配置项**：`lineColor`（默认 `#222`）、`lineWidthMm`（默认 0.15）、`fixedLineCount`（固定行数，自动算高度）、`insetLeftMm` / `insetRightMm`（边距）
- **默认启用**：新建解答题 `kind: "lined_answer"` + 5 行横线，无需手动勾选
- **inspector 面板**：行数 / 间距 / 颜色 / 线宽 / 边距均可调，自动联动高度
- **SVG / PDF 渲染**：全部参数可配置，不再硬编码 `#888` / `#777`

### 得分划线栏美化

新增 `ScoreGridConfig`（8 字段），保持格子外框尺寸不变，优化内部视觉。

- **新增可配置项**：`enabled`（独立开关）、`strokeColor`（默认 `#999`）、`dividerColor`（默认 `#ccc`）、`dividerWidthMm`（默认 0.1）、`fontSize`（默认 2.8，原 2.2）、`showLabel`（"得分"标签开关）
- **SVG / PDF**：颜色和字号均从配置读取，不再硬编码
- **inspector**：格线色 / 分隔线 / "得分"标签独立控制

### 填空右侧批注

`BlankItem` 新增 `rightAnnotation?: string` 字段，支持在填空横线右侧添加批注文字。

- **类型扩展**：`BlankItem.rightAnnotation` + `SubjectiveRenderItem.blankRightAnnotations`
- **inspector**：空白项列表新增「右侧批注」输入框（如 `(填＞或＜）`）
- **SVG**：灰色 `#888` 3px 文字，横线右侧 1.2mm
- **PDF**：对应位置绘制批注文字

### 移动端底部导航更新

- 新增 `home` 模式到 `mobileNavItems`（首页首选项），移除已删除的 `grading` 模式

### 修改文件清单

| 文件 | 改动 | 内容 |
|------|------|------|
| `src/shared/types.ts` | +50 行 | `EssayGridConfig` / `LineGridConfig` / `ScoreGridConfig` / `BlankItem.rightAnnotation` / `PageRenderBlock.panelIndex` |
| `src/shared/layout.ts` | +130 行 | `layoutEssayBlock()` + lineGrid 固定行数 + scoreGrid 开关 |
| `src/apps/answer-card/client/App.tsx` | +380 行 | 作文块按钮+inspector+SVG + 横线枪inspector+SVG + 得分栏inspector+SVG + 填空批注 |
| `src/apps/answer-card/server/pdf.ts` | +90 行 | `drawEssayGrid()` + lineGrid 可配置 + scoreGrid 可配置 + 填空批注 |
| `src/shared/cardTemplates.ts` | +50 行 | `essayBlock()` + `linedQuestion()` 新格式 + 语文模板集成 |

**总计**：+700 行新增代码，0 个删除，0 个新依赖。


### 版本
- v1.9.0 → v1.9.1

---

## v1.9.0 (2026-07-18) — 网上阅卷系统全面重构

### 概述
网上阅卷系统从独立模块重构为考试管理的核心子功能，新增 Home 仪表盘、任务分配引擎、2P/3P 多评机制、争议仲裁、PAD 优先阅卷 UI、批注系统（文字+手写）和断点续批能力。累计新建 30+ 文件，修改 15+ 文件。

---

### 架构变更
- **Home 仪表盘**：登录后进入图形化首页，模块卡片（答题卡设计 / 考试管理 / 成绩分析 / 账号管理）+ 快捷入口（继续阅卷 / 最新考试 / 考试管理引导卡片，始终可见）
- **考试管理重构**：保留原有新建/删除/赋分等功能；每条考试新增「网阅」按钮进入 ExamDetailPage（5 个 Tab：阅卷 / 阅卷分配 / 争议管理 / 阅卷溯源 / 网阅设置）
- **移除了独立阅卷模式**：`grading` mode 删除；新增 `home` mode
- **Tab 栏可开关**：`show_tab_bar` 用户设置，默认关闭。关闭后各页面顶部栏显示"← 返回首页"按钮（44px），开启后桌面模式栏和底栏均含「首页」首选项。设置即时生效
- **登录默认首页**：不再进答题卡设计器

---

### 阅卷任务分配引擎
- 年级组长/管理员为每个题块指定教师 + 份数，系统随机分配（Fisher-Yates + djb2 hash seed，确定性可重现）
- 教师进入考试后可自选已分配的题块，进度条显示实际待批/总数
- 仲裁人下拉：同科同年级教师列表，已分配本题块的教师置顶（标记"批卷教师"），冲突自动跳过
- `ReviewAssignPage` 完整界面：教师下拉选择 + 份数分配 + "🎲 随机分配"按钮

---

### 2P/3P 多评系统
- 考试级 `review_mode`：1P / 2P / 3P
- 2P：两教师独立打分 → 分差 ≤ 阈值取平均 → 分差 > 阈值进入争议
- 3P：三教师独立打分 → 一致取平均；两评接近取接近分平均（排除异常分）；三评分散进入争议
- 默认分差阈值：作文 3 分 / ≥10 分题 2 分 / <10 分题 1 分（可逐题块覆盖）
- 取整方式 5 种：`ceil` 向上 / `floor` 向下 / `round` 四舍五入 / `half` 保留 0.5 / `none` 保留小数。非作文默认 `ceil`，作文默认 `half`
- 仲裁：最终分以仲裁人判定为准；无指定仲裁人 → 搁置争议池待年级组长处理

---

### 新阅卷 UI（PAD 优先）
- **布局**：左图右分（≤900px 自动上下分栏）
- **图片操作**：滚轮缩放（25%~400%）、按钮旋转 90° CW/CCW
- **打分面板**：大按钮（56px+ 触控目标），根据满分自动生成列：<10 分 = 个位 + 0.5，≥10 分 = 十位 + 个位 + 0.5
- **工具栏**：上一份/下一份、缩放百分比、旋转、批注模式切换
- **快捷键**：Enter = 保存并下一份，← → = 翻页，滚轮 = 缩放

---

### 批注系统
- **文字批注（桌面端）**：点击答题卡 → 弹出输入框 → 半透明红色浮层叠加
- **手写批注（PAD/移动端）**：Canvas 渲染，PointerEvent 笔触追踪，palm rejection（忽略大面积触摸），笔迹保存为 JSON 路径数据
- **自动模式检测**：触摸设备默认手写，桌面端默认文字批注
- **API**：`GET/POST/DELETE /api/review-annotations`，批注可正常保存和读取
- **学生端可见**：新增 `CropImageViewer` 组件，学生在成绩详情可看到教师批注浮层

---

### 断点续批
- `review_sessions` 表持久化：当前批改位置 + 缩放/平移状态 + 未提交草稿分数
- 退出时自动保存，重新进入时恢复。草稿自动回填，已提交分数不回滚

---

### 争议管理与仲裁
- 争议自动检测：分差超阈值 → 自动交给指定仲裁人（冲突跳过 → 搁置争议池）
- 争议管理 Tab：年级组长/管理员查看搁置争议列表，手动判分或指派仲裁人
- 仲裁人冲突检测：若指定仲裁人已是该卷评审人 → 保留争议池，待人工处理

---

### 阅卷溯源
- `answer_block_crops` 追踪字段：`reviewer_id`、`reviewed_at`、`review_round`、`final_score`、`final_score_by`、`score_breakdown`
- 溯源 Tab：表格展示每学生每轮评审人+分数+状态

---

### 数据库新增 (v18 迁移，双库双轨)
- `review_assignments` — 阅卷任务分配
- `review_sessions` — 断点续批会话
- `review_annotations` — 批注存储
- `block_grading_config` — 逐题块网阅设置（阈值/取整/仲裁人）
- `answer_block_crops` 加列：reviewer_id, reviewed_at, review_round, final_score, final_score_by, score_breakdown
- `users` 加列：show_tab_bar
- `exams` 加列：review_mode, review_enabled

### 类型新增
- `SubjectiveBlockKind` + `"essay"`（作文标签，预留给语文/英语作文）
- 18+ 个新类型：ReviewMode, RoundingMode, BlockGradingConfig, ReviewAssignment, ReviewSession, ReviewAnnotation, ReviewTraceItem, DisputeItem, DashboardData, TeacherBlockAssignment, ExamReviewSettings, ArbitratorCandidate, BatchGradingConfigUpdate, ReviewProgress, ReviewRoundDetail, DisputeCheckResult

### API 新增
| 端点 | 说明 |
|------|------|
| `GET /api/dashboard` | 首页仪表盘数据 |
| `GET /api/review/my-exams` | 教师待阅考试列表 |
| `GET /api/review/exams/:id/trace` | 阅卷溯源 |
| `GET/POST /api/review-assign/...` | 任务分配 CRUD |
| `GET/PUT/DELETE /api/review-session/...` | 断点续批会话 |
| `GET /api/review-arbitration/...` | 争议列表 + 仲裁人候选 + 仲裁裁决 |
| `GET/PUT/POST /api/block-grading-config/...` | 题块网阅设置 + 批量覆盖 |
| `GET/POST/DELETE /api/review-annotations` | 批注 CRUD |

### 修复
- 并发 CAS 检测：`submitReviewCropScores` 用 `WHERE review_round = ?` 防止后写覆盖先写，冲突时前端提示
- Express 5 `req.params` 类型安全修复（`String(req.params.x ?? "")`）
- 双数据库迁移双轨制（SQLite 用 `hasTable`/`addColumnIfMissing`，MariaDB 用 `try/catch` + `sqls[]`）
- 成绩分析页移除旧的「网上阅卷」Tab（网阅统一在考试管理入口）
- 快捷入口无数据时不空白，fallback 到最新考试或考试管理引导卡片

### 大型二次修复
基于全面代码审查（14 个文件、45 个问题），修复 4 个致命 bug + 10 个严重 bug。

#### 致命修复（4 项）
- **P0-1 文件 I/O 在 DB 事务内** (`cleanup.ts`)：文件删除移到事务外，避免事务回滚导致数据不一致
- **P0-2 争议状态更新在事务外** (`ReviewService.ts`)：争议检测 + 状态写入全部移入事务内
- **P0-3 仲裁无 CAS 并发保护** (`review-arbitration.ts`)：CAS 乐观锁 `WHERE review_round = ? AND status = 'disputed'` + 事务统一化
- **P0-4 reviewMode 从未强制** (`ReviewService.ts`)：提交前检查 `已完成轮次 >= reviewMode`，防止无限提交

#### 严重修复（10 项）
- **P1-5 重复提交检测**：同一评审人不可对同一题块二次提交（从 `score_breakdown` 解析）
- **P1-6 偏差值统计错误** (`AnalysisRepository.ts`)：🇯🇵 偏差值 / Z 值的均值与标准差改用全体考生数据，不再按班级筛选
- **P1-7 假性标记** (`score-editing.ts`)：分数未变时不设 `manually_modified = 1`
- **P1-8 排名事务一致性** (`score-editing.ts` 两处)：排名重算从事务外移到事务内
- **P1-9 仲裁 max_score=0** (`review-arbitration.ts`)：从已有 question_scores 读取正确的 max_score
- **P1-10 仲裁 score_type 硬编码** (`review-arbitration.ts`)：从已有 question_scores 读取正确的 score_type
- **P1-11 评审人查询不可靠** (`ArbitrationService.ts`)：改用 score_breakdown JSON 解析，不再单查 reviewer_id
- **P1-12 通用化争议检测** (`ArbitrationService.ts`)：`computeMultiReviewResult` 支持 4+ 次评审，聚类判断替代硬编码 3P
- **P1-14 Token 暴露**：新增 `mediaUrl()`，同源图片/iframe 依靠 httpOnly cookie 认证，不再在 URL 中暴露 JWT
- **仲裁人冲突检查** (`ReviewService.ts`)：仲裁人已参与评审时提前抛出明确错误

#### 修改文件
| 文件 | 改动 |
|------|------|
| `src/server/db/cleanup.ts` | 文件 IO 移出事务 |
| `src/server/services/ReviewService.ts` | reviewMode 强制 + 争议事务内 + 重复/仲裁检查 |
| `src/server/routes/review-arbitration.ts` | CAS 保护 + 事务统一 + max_score/score_type 修复 |
| `src/server/routes/score-editing.ts` | manually_modified 条件 + 排名事务内 (2 处) |
| `src/server/services/ArbitrationService.ts` | 通用化争议检测 + 评审人检查修复 |
| `src/server/repositories/AnalysisRepository.ts` | 偏差值全体数据 |
| `src/apps/answer-card/client/auth/api.ts` | mediaUrl() 新增 |
| 前端 6 组件 | 图片 URL 改用 mediaUrl (cookie 认证) |

## v1.8.2 (2026-07-09) — 暗色模式全面修复

基于 v1.6.3 暗色模式基线进行系统性修复，解决 v1.7.0+ 新增组件在暗色下的灰底灰字、可读性差、与背景融为一体等问题。

### 问题根因
- v1.6.3 暗色模式已稳定（GitHub Dark 风格，#C0392B / #E6EDF3 / #161B22），但组件级暗色覆盖不完整
- v1.7.0/v1.8.0 大量新增组件使用 `var(--brand)` / `var(--text)` 等变量，但未覆写背景色
- 亮色模式下 `rgba(255,255,255,0.55~0.78)` 半透明毛玻璃在暗色底上呈现灰色、文字难以阅读

### 修复方案
**统一原则**：所有亮色半透明/毛玻璃背景在暗色下覆写为 `var(--surface)` / `var(--surface-raised)`，移除 `backdrop-filter`，添加清晰 `var(--line)` / `var(--line-strong)` 边框。

#### 核心变量（保持 v1.6.3 不变）
| 变量 | 暗色值 |
|------|--------|
| `--brand` | `#C0392B` |
| `--text` | `#E6EDF3` |
| `--surface` | `#161B22` |
| `--surface-raised` | `#21262D` |
| `--background` | `#0D1117` |

#### 修复的组件（`styles.css` ~250 行新增暗色覆盖）
- **通用按钮** `.ghost-button` / `.primary-button`：背景 `var(--surface-raised)` + 边框，hover 品牌色
- **通用面板** `.panel`：背景 `var(--surface)`，hover `var(--surface-raised)` + 品牌色边框
- **答题卡列表** `.card-list-item` / `.card-list-actions button`：移除半透明白，激活态品牌红渐变
- **底部状态栏** `.statusbar`：背景 `var(--surface-raised)`
- **顶部导航** `.mode-toggle button`：未激活用 `var(--surface-raised)` 与背景区分，激活保留红渐变
- **题块卡片** `.block-chip`：背景 `var(--surface-raised)`，hover/active 品牌红渐变
- **题块操作按钮** `.chip-actions button` / `.question-editor-title button`：背景 `var(--surface)`
- **上传按钮** `.upload-button`：背景 `var(--surface-raised)` + 品牌色虚线边框
- **答案键按钮** `.answer-key-row button`：背景 `var(--surface-raised)`，激活态品牌红
- **分值检查** `.score-warning-summary`：去掉亮色黄底，改为深色品牌黄调

#### 阅卷表格暗色适配
- `.score-table` / `.score-table-head` / `.question-grade-list` / `.question-grade`：覆写半透明白背景
- `.question-grade.needs-review`：深色黄调
- `.status-ok`：深色绿 `#6EE7B7`，`.status-warn`：深色黄 `#FCD34D`
- `.file-queue` / `.queued-files span`：覆写半透明白，移除 backdrop-filter

#### AI 分析面板暗色适配
- `.ai-analysis-panel`：背景 `var(--surface)`
- `.icon-button`：背景 `var(--surface-raised)`，hover 品牌色
- `.ai-status-warning`：深色黄调 + `#FCD34D` 文字
- `.ai-report-summary` / `.ai-caveats span` / `.ai-tool-trace span`：深色背景
- `.ai-question-action em`：`var(--muted)` 文字色

### 修改文件
| 文件 | 改动 |
| --- | --- |
| `src/apps/answer-card/client/styles.css` | 暗色覆盖段新增 ~250 行组件级暗色适配 |

---

## v1.8.1 (2026-07-06) — 代码审查 bug 修复与一致性收敛

基于 PR161 代码审查报告（`readus/CODE-REVIEW.md`），修复安全漏洞、崩溃 bug、排名/百分位不一致及若干前端问题。

### 安全修复
- **MariaDB 恢复命令注入（C-S1）**：`backup.ts` restore 改用 `execFile` 参数数组 + stdin，消除 shell 注入
- **扫描上传路径遍历（H-S12）**：`side` 白名单、`sessionId` basename 兜底、扩展名白名单
- **ZIP 解压前缀绕过（M-S18）**：路径检查改用 `path.relative`，防止 `destDir-evil` 类前缀攻击

### 数据一致性
- **排名算法统一（H-L2）**：`score-editing.ts` 与 `ReviewService.ts` 两份重复 `recomputeRankings` 收敛为共享模块 `rankingUpdate.ts`，改用 `competitionRank`（同分并列）
- **百分位公式统一（M-L4）**：写入 DB 时统一使用公式 A `(total - rank) / (total - 1) * 100`（末名 0）
- **分数舍入（H-L3）**：成绩编辑/复核路径 `total_score` 统一 `roundScore`（3 位小数）

### 阅卷逻辑
- **复核置信度阈值生效（H-L1）**：Web 阅卷链路读取用户 `reviewConfidenceThreshold` 并传入 `gradeObjectiveQuestion`
- **主观题负分裁剪（M-L6）**：`Math.max(0, Math.min(score, maxScore))`
- **多页阅卷择优（M-L2/M-L3）**：跨页去重纳入置信度；学号优先取 `status=ok` 的识别结果

### 前端修复
- **GradingResults 崩溃（C-F1）**：`useState` 移到早返回之前，修复 Hook 数量变化崩溃
- **ScannerPanel 闭包陷阱（C-F2/C-F3）**：用 ref 追踪 `pages`/`sessionId`/`scannerMode`，修复 done 回传页数 0 与远程上传空循环
- **网上阅卷前进（H-F2）**：「保存并下一份」真正前进到下一份
- **SSE 健壮性（H-F5/M-F4）**：`JSON.parse` 加 try/catch；扫描 SSE 断连反馈错误状态
- **图片压缩内存泄漏（H-F6）**：`URL.revokeObjectURL` 释放 blob URL

### 小修复
- `generateTeacherUsername` 异步检查存在性，避免用户名碰撞（L-S2）
- `englishTemplate` 移除无意义三元（L-L4）
- `ClassManagement` CSV 表头正则去重（L-F8）

### 测试与文档
- 新增 `readus/CODE-REVIEW.md`（含修复状态总表）
- 新增 `scripts/bugfix-verification.ts`（14 项单元断言）
- 新增 `scripts/ranking-integration-check.ts`（真实 SQLite 排名集成测试）

### 回归验证
- `npm run typecheck` ✓
- `npm run verify:auth` — 54 通过 / 0 失败
- `npx tsx scripts/grading-rules-smoke.ts` ✓
- `npx tsx scripts/bugfix-verification.ts` — 14 通过
- `npx tsx scripts/ranking-integration-check.ts` ✓
- `npm run build` ✓
- GUI 冒烟：登录、设计/考试/阅卷/分析四页正常渲染

### 第二轮修复（对照 PR161 + debug 审查）
- **H-S4**：`ExamRepository` / 扫描器持久化改用 `ON CONFLICT DO UPDATE`，重扫保留 rank/percentile/手动改分
- **H-S1**：成绩修改 PUT 路由增加 `requireExamAccess`
- **H-S11**：`getVisibleExamIds` 异步化 + `getMysqlDb()`，MariaDB 模式考试可见性正确
- **M-L4 显示层**：`AnalysisRepository` 百分位显示统一公式 A
- **backup**：MariaDB 默认端口 `3306`（原误 `443`）
- **ScannerPanel**：`sessionIdRef` 在 `startScan` 同步赋值
- **score-editing**：答案 `updateCard` 持久化、同步 `subjective_score`、传入复核阈值
- **PR161**：`COUNT(ss.exam_id)` 修复 JOIN 重复计数

### 修改文件

| 文件 | 改动 |
| --- | --- |
| `src/server/routes/backup.ts` | execFile 防注入、ZIP 路径检查 |
| `src/server/routes/scanner-upload.ts` | side/ext/sessionId 安全校验 |
| `src/server/services/rankingUpdate.ts` | **新增** 统一排名/百分位重算 |
| `src/server/routes/score-editing.ts` | 使用共享排名模块 + roundScore |
| `src/server/services/ReviewService.ts` | 同上 |
| `src/shared/grading.ts` | 阈值参数、跨页择优、主观分裁剪 |
| `src/apps/answer-card/server/index.ts` | 读取用户复核阈值传入阅卷 |
| `src/apps/answer-card/client/App.tsx` | GradingResults Hook 修复、SSE try/catch |
| `src/apps/answer-card/client/components/ScannerPanel.tsx` | ref 闭包修复 |
| `src/apps/answer-card/client/components/OnlineReviewPanel.tsx` | 保存并下一份前进 |
| `src/apps/answer-card/client/components/PaperUploadPanel.tsx` | objectURL 释放 |
| `src/server/repositories/UserRepository.ts` | 教师用户名生成重试 |
| `src/shared/cardTemplates.ts` | 移除冗余三元 |
| `scripts/bugfix-verification.ts` | **新增** 回归测试 |
| `scripts/ranking-integration-check.ts` | **新增** 排名集成测试 |
| `readus/CODE-REVIEW.md` | **新增** 代码审查报告 + 修复状态 |
| `src/server/services/userSettings.ts` | **新增** 共享复核阈值读取 |
| `src/server/repositories/ExamRepository.ts` | H-S4 upsert + COUNT 修复 |
| `src/apps/answer-card/server/middleware.ts` | H-S11 异步 getMysqlDb |
| `src/apps/answer-card/server/scanner/index.ts` | H-S4 扫描持久化 upsert |
| `src/server/repositories/AnalysisRepository.ts` | M-L4 百分位显示 + COUNT |
| `src/server/routes/exam-groups.ts` | COUNT(ss.exam_id) |

### Ubuntu 生产环境与 AI 知识点分析热修
- PDF 导出按环境变量、常见 Linux/Windows/macOS CJK 字体路径和系统字体目录自动发现字体；缺失时降级到 PDFKit 内置字体，并支持 `PROJECTX_PDF_FONT_PATH` / `PROJECTX_PDF_FONT_POSTSCRIPT_NAME` 覆盖。
- MariaDB 考试可见性统一走 `getMysqlDb()`；考试选择、分析和考试组统计不再依赖可能缺失的 `student_scores.id`，统一使用 `COUNT(ss.exam_id)`。
- Ubuntu 包启动脚本和 systemd 模板显式使用包内 `dist/web`，并补齐 `mammoth`、`pdfjs-dist`、`sharp`、`tesseract.js` 等服务端依赖。
- 新增 `llmclient` Python sidecar 生产部署与 MariaDB 读取支持；知识点分析优先使用系统级服务商，失败时将具体错误透传到前端。

---

## v1.8.0 (2026-07-04) — 原卷上传与 AI 知识点分析

### 数据库 schema 完善
- `schema.sql` 初始建表补充 v1.8.0 新增字段：
  - `answer_cards`: `has_original_paper`, `original_paper_filename`, `original_paper_path`, `question_range`, `extra_notes`, `knowledge_points_text`
  - `users`: `require_original_paper`, `highlight_missing_paper`
- `schema.mysql.sql` 同步补充上述字段（之前仅 `schema.mariadb.sql` 完整）
- MariaDB 增量迁移新增 `v17 original-paper-and-knowledge-points`，确保已有 MariaDB 生产库自动补齐原卷相关列和 `knowledge_points` 表

### SQL 兼容性
- `KnowledgePointRepository.getWeaknessesForExam / getWeaknessesForStudent` 的 `GROUP_CONCAT(DISTINCT ... ORDER BY ...)` 改为按 `(point_text, question_number)` 分组，然后在 JS 层聚合题号，兼容 SQLite 和 MySQL

### 版本号
- `package.json` / README badge / UI 侧栏版本号统一为 `1.8.0`

### 原卷上传
- 答题卡创建后自动弹出原卷上传面板（可由教师在设置中关闭）
- 支持 DOCX / PDF / 图片（JPG/PNG/BMP/TIFF/WebP）上传，最大 50MB
- 拒绝 .doc 格式，引导转为 .docx
- 图片自动前端压缩（max 2048px, JPEG 80%）+ 后端 sharp 兜底压缩
- 图片格式自动转为 PDF 存储；DOCX/PDF 保留原文件
- 题目范围填写（全部 / 自定义文字）+ 特别描述备注
- 原卷文件存储在 `data/answer-card/papers/:cardId/`

### AI 知识点分析
- 智能路由：多模态（Gemini/GPT）直传图片，一次调用；纯文本（DeepSeek）自动检测文字层
- DeepSeek 三模式：自动（文字层→mammoth/pdf-parse，无文字层→Tesseract.js OCR）/ 视觉接力（视觉模型转写→DeepSeek分析）
- 三层格式保障：JSON Schema 硬约束 + System Prompt 软约束 + Node 后端校验兜底
- 知识点存储在 `knowledge_points` 表，独立于答题卡，与成绩数据关联
- 前端编辑：彩色标签、双击编辑、长按编辑（移动端）、删除/添加知识点
- 分析结果持久化，后续可重新分析或手动修改

### 成绩分析联动
- 新增 `GET /api/analysis/knowledge-points/:examId` — 按知识点聚合全班得分率
- 新增 `GET /api/analysis/knowledge-points/:examId/students/:studentId` — 单个学生知识点弱项
- llmclient 新增 `get_knowledge_point_weaknesses` 工具，AI 能指出具体知识点的薄弱环节

### 原卷导出增强
- 答题卡导出 `.projectx-card.json` 包含原卷 base64 + 知识点数据
- PDF 导出前统一检查卡片：分值 → 原卷（内联渲染：图片/img可缩放、PDF/iframe翻页、DOCX/Office链接）→ 知识点（内联分析+编辑），三步进度条，含「← 上一步」回退
- 原卷预览按文件类型智能渲染：`?format=image` 获取图片，默认 PDF，互不干扰
- 原卷放大预览 Modal 支持 ± 缩放（25%~300%），按钮实时显示当前倍率
- 修复图片原卷上传后不被识别：`/api/cards/:cardId/paper/info` 双检查（DB + 文件实际存在），自动修复不一致
- 上传原卷后自动刷新侧栏状态
- 导出卡片内知识点分析面板与上传面板 UI 统一（单选框 `.radio-label` 对齐）

### 侧边栏标识
- 左侧答题卡列表新增橙色竖条标识未上传原卷的考试
- 可在教师设置中关闭高亮

### 系统 AI 配置（Admin Only）
- `ai_providers` 表新增 `is_system` 列，全校统一 AI 提供商
- 知识分析仅使用系统级 AI 提供商，教师无法自行配置
- AccountMenu「AI 设置」Tab 仅 admin 可见
- 教师设置新增「强制上传原卷」「侧边栏高亮」双开关

### 移动端适配
- 文件上传：移动端大按钮组（拍照/选文件）
- 面板全屏化（<760px），sticky 底部按钮
- 知识点编辑长按触发
- 输入框 16px 字体防 iOS 缩放

### 数据库
- migration v16：`ai_providers.is_system` (SQLite + MariaDB)
- schema.sql / schema.mariadb.sql / schema.mysql.sql 三份同步
- 新建 `knowledge_points` 表（card_id, question_number, point_text, category）

### 新增依赖
- `sharp` — 图片压缩与格式转换
- `mammoth` — DOCX 文本提取
- `pdfjs-dist` — PDF 文字层检测与文本提取（替代 pdf-parse）
- `tesseract.js` — OCR 引擎（扫描件兜底）

### 新增文件
- `src/apps/answer-card/server/paper-converter.ts` — 文件校验、压缩、图片→PDF
- `src/apps/answer-card/server/paper-ocr.ts` — 文本提取 + OCR
- `src/apps/answer-card/server/routes/paper-routes.ts` — 原卷/knowledge-points CRUD
- `src/server/repositories/KnowledgePointRepository.ts` — 知识点 CRUD + 成绩联动查询
- `src/apps/answer-card/client/components/DragDropZone.tsx` — 拖拽上传
- `src/apps/answer-card/client/components/KnowledgeTagList.tsx` — 可编辑知识点标签
- `src/apps/answer-card/client/components/PaperUploadPanel.tsx` — 原卷上传主面板
---

---


---

## v1.7.3 (2026-07-04) — 移动端网页适配

### 移动端全面适配

系统从桌面端专用布局升级为桌面/移动端双适配架构。新增 480px 手机断点，通过底部导航栏替代桌面端 Tab 切换，实现手机端原生体验。

- **底部导航栏（Bottom Navigation Bar）**：
  - 固定屏幕底部，毛玻璃背景 + 品牌色激活项
  - 根据用户权限动态生成导航项（设计/考试/阅卷/分析/成绩/账号），最多 5 个 Tab
  - 图标 + 短标签（2-3字），触摸目标 44px，iPhone 安全区适配（`env(safe-area-inset-bottom)`）
  - 桌面端 `display: none`，仅 480px 以下显示
- **Topbar 移动端精简**：
  - 隐藏副标题、隐藏桌面端 `mode-toggle`（由底部导航替代）
  - 标题省略号截断，操作按钮紧凑排列
  - `position: sticky` 固定顶部
- **480px 移动端主断点**（~300 行新增 CSS）：
  - 全局重置：`body` 可滚动、`app-shell` 取消固定高度、底部 padding 为导航栏留空间
  - 8 个 mode 页面逐一适配：
    - **design**：预览区 + 属性面板纵向排列，答题卡页面自适应宽度
    - **exam-manage**：考试列表表格改卡片布局，表头隐藏
    - **grading**：扫描面板 padding 缩减，扫描结果网格紧凑化
    - **analysis**：分析卡片 2 列，排名表横向滚动，箱型图 2 列
    - **scores**：概览卡片紧凑排列，Tab 横向滚动，图表高度缩减
    - **account**：三栏班级布局改单列，表单单列，表格横向滚动
    - **sponsor**：收款码卡片全宽，二维码缩至 140px
    - **guide**：正文 13px、表格横向滚动、代码块紧凑
- **Modal 底部弹出（Bottom Sheet）**：
  - 所有弹窗从屏幕底部滑出，全宽圆角顶部（`border-radius: 20px 20px 0 0`）
  - 底部按钮纵向全宽排列
  - PDF 查看弹窗全屏化
  - 账号菜单下拉改为底部弹出
- **触摸优化**：
  - 输入框 `font-size: 16px`（防止 iOS Safari 自动缩放）
  - 触摸目标最小 44px
  - `-webkit-overflow-scrolling: touch` + `overscroll-behavior: contain`
- **横屏适配**（iPad 等）：
  - 1024px landscape：主内容 + 属性面板 320px 双列
  - 768px landscape：单列 + 底部导航缩小至 48px
- **暗色模式配套**：底部导航栏、Topbar、Modal 全部适配 `[data-theme="dark"]`
- **HTML Meta 标签**：viewport 添加 `viewport-fit=cover`，新增 `apple-mobile-web-app-capable`、`theme-color`

### 技术实现

- **纯 CSS 适配策略**：不修改任何子组件文件，全部通过 `styles.css` 中的 `@media (max-width: 480px)` 规则覆盖
- **App.tsx 最小改动**：仅新增 `mobileNavItems` useMemo（权限驱动的导航项数组）+ 底部导航 JSX
- **CSS 变量扩展**：新增 `--mobile-bottom-nav-height`、`--mobile-safe-area-bottom/top`、`--touch-target-min`、`--mobile-content-padding`

### 修改文件

| 文件 | 改动 |


## v1.7.2 (2026-07-01) — 统计图表 + 教师权限管理

### 统计图表系统
- 新增 `AnalysisCharts` 可复用图表组件：`ScoreDoughnut`（饼图）、`ComparisonBar`（柱状图）、`TrendLine`（折线图）。
- `AnalysisOverview` 嵌入「图表可视化」区域：分数段分布饼图 + 关键指标面板。
- 学生端 `StudentScores` 成绩列表顶部嵌入总分趋势折线图（≥2 场考试显示，时间正序排列）。
- Chart.js 颜色处理：新增 `resolveColor()` CSS 变量解析 + `withAlpha()` 安全 alpha 拼接，避免 Canvas API 下 `var(--brand)15` 非法颜色。

### 教师权限管理系统
- 新增 `teacher_permissions` 表（v16 migration）：`teacher_id`/`grade_id` + `can_view_scores`/`can_view_charts`/`can_view_students` 三个开关。
- 新增 `GET/PUT/DELETE /api/admin/permissions` 路由（admin-only）。
- 新增 `PermissionManager` 前端组件：管理员可视化管理各教师/年级的查看权限。
- RBAC 集成：`getVisibleExamIds` 检查 `teacher_permissions` 表，关闭权限的教师看不到受限年级的全部数据。
- `AccountMenu` 新增「权限管理」入口（仅 admin 可见）。

### 暗色主题持续打磨
- 品牌色调优：珊瑚红 `#F77866` → 低亮红 `#D94040` → 最终 `#C0392B` 暗沉红（Tim 版）。
- 文字亮度：`#C9D1D9` → `#EAEAEA`（亮白），`--muted` → `#888888`。
- 顶部栏 `rgba(22,27,34,0.75)` 暗色毛玻璃，mode-toggle 容器可见暗底。
- 答题卡预览强制白纸黑字（`.page` `#fafafa` + `color:#333`）。
- SVG 文字全系列 `fill:#111 !important`。
- 侧边栏 hover：黑遮罩 → 品牌红微光 `rgba(217,64,64,0.08)`。
- 按钮 hover：黑块 → 微光白 `rgba(255,255,255,0.08)`。
- Kimi 补全 1460 行组件级暗色覆盖（`.panel`/`.block-chip`/`.answer-key-editor` 等）。

### Bug 修复
- `CreateExamGroupModal`：修复重复 `error`/`setError` 声明导致 tsc 编译失败。
- 学生端趋势图：修复 `/api/scores/me` 返回 DESC 排序导致折线图时间倒序（改为 `[...data].reverse()`）。
- Chart.js 颜色：修复 `var(--brand)15` 拼接为非法 Canvas 颜色。
- `update.sh` 重写：Node 自动探测 + 分支安全 + 跨平台进程管理。

### 工程化改进
- 后端路由拆分：14 条分析路由提取为 `routes/analysis.ts` + 3 个共享模块。
- Zod 请求校验：`POST /api/cards`、`POST /api/exams`、`PATCH /api/users/me/settings`、`POST /api/analysis/cross-exam/groups`。
- 文件上传魔数校验（PNG/JPEG/BMP/TIFF）+ MIME 预过滤。
- DB 性能索引 v12：`student_scores` 复合索引 + `question_scores` 复合索引。
- SQL 动态 UPDATE 白名单校验。
- 统一错误码 `ApiError` 枚举 + 中文提示。
- GitHub Actions CI 工作流（typecheck + test + build）。
- `AutoBackup`：考试关闭后自动拷贝 DB 到 `data/backups/`。

### 答题卡模板
- 新增辽宁新高考政治/历史/地理模板（16 单选 × 3 分 + 主观题 52 分，满分 100）。

## v1.7.1 (2026-06-30) — 网上阅卷能力补全

### 网上阅卷队列

- 新增 `GET /api/review/exams/:examId/blocks`：按大题块汇总待阅/已阅数量。
- 增强 `GET /api/review/exams/:examId/block-crops`：返回学生姓名，供阅卷队列展示。
- 新增 `POST /api/review/exams/:examId/block-crops/:cropId/submit`：提交题块分数、更新切块状态、重算总分与排名。
- 新增 `ReviewService`：题块汇总、分数 upsert、排名重算。
- 教师成绩详情页新增 **网上阅卷** Tab（`OnlineReviewPanel`）：左侧题块列表 + 右侧切块图片与逐题打分。

### 状态流转

- 切块默认 `ready`（待阅）→ 提交后 `reviewed`；可标记 `disputed`（争议）。

### 暗色模式视觉升级

- **答题卡预览**：暗色 UI 下 `.page` 保持白纸黑字（`#ffffff` 背景 + `color-scheme: only light`），不再继承深色表面色。
- **SVG 文字**：将全局浅色 `fill: #EAEAEA` 改为仅作用于 `.page` 内的 `#111` 黑字，修复预览文字几乎不可见的问题。
- **对比度**：`--text-secondary` / `--muted` 调亮，次要文字在暗色背景下更易读。
- **网上阅卷**：`OnlineReviewPanel` 侧栏、题块列表、图片区与打分输入框暗色适配。
- **工程清理**：删除 `styles.css` 末尾约 1000 行重复的暗色规则块。

### 分数统计图修复

- **箱线图交互**：分数统计分布 图中班级柱形可点击，联动顶栏班级筛选；补传 `selectedClassId` 修复高亮不更新。
- **图例与可读性**：新增极值/四分位/中位/均值图例，加粗坐标与柱形对比度，暗色模式下提升箱线图与分数段分布可视性。
- **成绩变化曲线**：分析页考试列表下方恢复 `AnalysisTrend`（重构后曾丢失未渲染）。
- **演示校验脚本**：修正上次考试对比用例（应对「演示-数学」而非「数学月考」发起请求）。

### 合并 main（v1.6.4 / v1.6.5）

- **背景图 API**：恢复 `GET /api/app/background` 与 `POST /api/users/me/background`。
- **设置保存崩溃**：`PATCH /api/users/me/settings` 改为读取 `req.body`（非 `validatedBody`）。
- **exam_groups 列补齐**：SQLite / MariaDB 新增 migration v15，补齐 `source` 等缺失列。
- **前端防御性加固**：`ScoreDetailPage`、`AccountMenu`、`App` 对设置返回值增加 null-safe guard。

## v1.7.0 (2026-06-30) — 成绩分析补全与学生学期对比

### 成绩分析补全

- 实现 `GET /api/analysis/exams/:examId/previous`：对比上一场同科目考试，返回均分/及格率变化。
- 修复 `findPreviousExam`：`grade_id` 为 NULL 时正确匹配；日期回退使用 `exam_date → start_time → created_at`。
- 教师成绩详情「概况」Tab 展示上次考试对比条（均分变化、及格率变化）。

### 学生端分析增强

- 新增 `GET /api/scores/me/semester-comparison`：按学年学期（8月~1月为第一学期，2月~7月为第二学期）汇总成绩。
- 学生成绩页新增学期对比 Tab，柱状图展示各学期/各科均分。
- 学生端雷达图与排名趋势可下拉切换考试/大考组/学期三种维度。

### iOS 15 Safari 兼容（基于 #141）

- Vite web 构建目标设为 `es2020 + safari15`，确保 JS 在 iOS 15 / macOS Safari 15+ 上可解析运行。
- 修复 `Array.prototype.at` 在 iOS 15 上不可用导致 白屏 的问题。
- `src/components/WebCompat.tsx`：Safari 专用兼容检测与提示横幅。

### 工程清理

- 删除 `.tsbuildinfo` 缓存，确保类型检查从零开始。



## v1.6.5 (2026-07-01) — iOS 15 Safari 兼容与错误边界 (#141)

### Web SPA 兼容性

- **iOS 15 / Safari 15 降级编译**：Vite web 构建目标设为 `es2020 + safari15`（`vite.config.ts`），搭配 `package.json` 中 `browserslist: "iOS >= 15, Safari >= 15"`，确保产出 JS 在 iOS 15 Safari 上可解析运行。
- **Runtime polyfills**：新增 `src/apps/answer-card/client/polyfills.ts`，在 `main.tsx` 最顶部加载，补丁 `Object.hasOwn` 和 `structuredClone`（iOS 15.0-15.3 缺失这两个 API）。
- **无痕浏览 localStorage 容错**：`App.tsx` 中主题读写的 `localStorage.getItem/setItem` 包裹 `try/catch`，避免 iOS Safari 隐私模式下抛出 `SecurityError` 导致白屏。

### ErrorBoundary

- **新增 `ErrorBoundary.tsx`**：React class 组件包裹 `<AuthProvider>` + `<App />`。任意组件渲染异常时展示「页面加载失败」恢复界面，含错误信息和「刷新页面」按钮，替代原有空白页。

### 依赖清理

- `package-lock.json` 轻量化：移除 `@electron/windows-sign`、`electron-winstaller`、`postject` 等不必要 peer 依赖，标记 `@types/node` / `@types/react` / `csstype` / `react` 等为 `devDependencies`。

## v1.6.4 (2026-07-01) — 背景图恢复与设置保存崩溃修复

### Bug 修复

- **背景图不显示**：`GET /api/app/background` 和 `POST /api/users/me/background` 路由在 v1.6.0 数据库重构中被意外删除，导致 CSS `body.has-bg-image::after` 请求 404 JSON 而非图片数据。现已恢复两个路由。
- **保存设置时服务端崩溃**：`PATCH /api/users/me/settings` 在 v1.6.3 修复时写入了 bug — handler 从 `(_req as any).validatedBody` 读取请求体，但 `validateBody` 中间件将校验后数据写入 `req.body`（而非 `validatedBody`），导致 `body` 始终为 `undefined`，访问 `body.scoreDisplayMode` 时报 `TypeError: Cannot read properties of undefined`。成绩详情页切换显示模式（偏差值/Z值/百分位）或账号设置保存时均会触发此崩溃。**修复**：改为读取 `(_req as any).body`。
- **SQLite / MariaDB `no such column: source`**：老数据库（v1.6.0 初期创建的）`exam_groups` 表缺少 `source`、`description`、`start_date` 等列（schema 已更新含这些列，但 `CREATE TABLE IF NOT EXISTS` 不会重建已存在的表；migration v8 若在列补齐逻辑加入前已被标记为"已应用"则跳过补齐）。双数据库均新增 migration v15（SQLite: `migrations.ts` + MariaDB: `mysql.ts`）确保所有缺失列在启动时补齐。
- **前端防御性加固**：`ScoreDetailPage.tsx`、`AccountMenu.tsx`、`App.tsx` 中对 `/api/users/me/settings` 返回值的访问增加了 null-safe guard。

## v1.6.3 (2026-06-29) — 暗色主题完善与登录页隔离

### 暗色模式按钮修正

暗色模式下按钮颜色从与亮色一致的亮粉红修正为沉稳暗红色，移除高光效果。

- `[data-theme="dark"]` Brand 色板：
  - `--brand`: `#F05060` → `#C0392B`（深暗红）
  - `--brand-light`: `#FF7080` → `#D44637`
  - `--brand-dark`: `#D03040` → `#96281B`
  - `--brand-glow / --brand-soft / --brand-tint`：对应调暗
  - `--shadow-brand / --shadow-brand-lg`：减弱发光（opacity 从 0.30/0.35 降至 0.15/0.18）
- 移除按钮高光：
  - `.primary-button::after` → `background: none`
  - `.mode-toggle button.active::after` → `background: none`
  - `.answer-key-row button.active::after` → `background: none`
- `.primary-button:hover:not(:disabled)` 不再 `filter: brightness(1.05)`

### 账号区域暗色背景适配

暗色模式下账号菜单和账号管理面板的背景从灰色残余修正为深色。

- `.account-menu-trigger`：暗色下 `background: var(--surface-raised)`（原 `rgba(255,255,255,0.65)` 在暗色下显示为灰白块）
- `.account-form-grid / .account-import-box / .class-column / .score-card`：暗色下 `background: var(--surface)`
- `.account-search`：暗色下 `background: var(--surface-raised)`
- `.class-list-item / .roster-item / .student-search-item`：暗色下适配背景、文字和 hover 边框色

### Web / Scanner 登录页隔离

Web 教师/学生端登录页错误地包含了扫描端的「服务器连接」和「API Key」输入框。

- **`LoginPage.tsx`**：恢复为老版本，仅含用户名 + 密码 + 记住我 + 使用说明，用于 Web 端
- **`LoginPageScanner.tsx`**（新建）：含远端服务器配置（URL + API Key + 测试连接），标题改为「答题卡扫描端」，仅扫描端使用
- **`ScannerApp.tsx`**：登录页改为 `import { LoginPageScanner }`

### 删除夜间模式可控开关

夜间模式已工作稳定，无需再通过账号设置中的「实验性」复选框来隐藏主题切换按钮。

- **App.tsx**：删除 `darkModeEnabled` state 与 `{darkModeEnabled && (...)}` 条件包裹，主题切换按钮常驻 Tab 栏
- **AccountMenu.tsx**：删除 `darkModeEnabled` / `setDarkModeEnabled` props，删除「夜间模式（实验性）」复选框和 ⚠ 警告文字
- `theme` useEffect 简化：直接 `setAttribute("data-theme", theme)`

### Bug 修复

- **保存设置报 「API route not found」**：`PATCH /api/users/me/settings` 路由在服务端缺失，现已添加 `GET`/`PATCH` 两个处理函数，使用 `UpdateUserSettingsSchema` 校验，直接更新 users 表
- **新建答题卡后列表不刷新**：`createCard` 中 `refreshCards()` 移到 `finally` 块确保总被执行，同时给 `examAction === "link"` 路径加 try-catch 防止关联失败中断刷新
- 与 main 分支的 `styles.css` 合并冲突已自动解决

## v1.6.2 (2026-06-29) — 大题切块与扫描端打包修复

### 大题作答图片切块

- native `answer-card-recognizer` 新增 `--crops-dir <dir>`，识别成功后复用 marker 匹配与透视校正结果，在 warped A4 图上按 `layout.pages[].blocks[]` 裁剪大题图片。
- 裁剪区域优先使用 `frameRect`，没有时退回 `rect`，默认扩展 2.5mm padding，并 clamp 到页面范围内；同一大题跨页时生成多张续页图片，不做跨页拼接。
- 识别 JSON 新增 `blockCrops` manifest，包含 `blockId/blockTitle/blockType/pageNumber/segmentIndex/questionNumbers/rect/path/widthPx/heightPx/dpi`。
- 服务端新增 `AnswerBlockCropService` 与 `answer_block_crops` 表，统一索引普通阅卷 `scan_records` 与扫描仪 `twain_scan_records`。
- 批量阅卷在 `ExamRepository.addScanRecord()` 返回记录 ID 后持久化切块；扫描仪 OCR 以 `twain_scan_record` 为 source 写入切块。
- 学生成绩详情与教师个别改分页新增“大题作答图片”区域，点击题目可按 `questionNumbers` 定位到对应大题块；缺少切块时沿用整页答题卡预览。
- 新增 `GET /api/answer-block-crops/:cropId/image`，并预留 `GET /api/review/exams/:examId/block-crops` 供网上阅卷队列读取题块、学生、分数和状态。

### 扫描端打包修复

- 修复 Electron 扫描端启动时报 `ENOENT, dist\scanner\index.html not found in app.asar`：scanner 构建完成后将 `index-scanner.html` 规范化为 `dist/scanner/index.html`。
- 移除未使用的 `localtunnel` 运行依赖，消除 electron-builder 的 `localtunnel@undefined` 依赖路径警告。
- x64 打包脚本继续通过 `-c.electronDist=node_modules/electron/dist` 复用本机 Electron；ia32 打包不再复用 x64 Electron，改为下载/使用真正的 32 位 Electron 运行时。
- 已验证 `release/win-unpacked/答题卡扫描端.exe` 为 x64，`release/win-ia32-unpacked/答题卡扫描端.exe` 与 ia32 `better_sqlite3.node` 为 x86。
- ia32 Electron 打包后建议执行 `npm run native:rebuild:node` 恢复开发环境 Node 版 `better-sqlite3`。

### 版本号

- `package.json` / `package-lock.json` 更新为 1.6.2，README 发布文件名同步更新。

## v1.6.1 (2026-06-28) — Web/Scanner 构建分离

### 构建拆分

代码库拆分为两个独立的 Vite 构建目标：

```
v1.6.0:  dist/client/ (全在一起)
v1.6.1:  dist/web/ (教师+学生) + dist/scanner/ (扫描端)
```

- **Web 构建** (`vite build --mode web` → `dist/web/`)：教师 + 学生页面，**不含 ScannerPanel 代码**，部署到服务器
- **Scanner 构建** (`vite build --mode scanner` → `dist/scanner/`)：仅 ScannerPanel，打包进 Electron 桌面端
- **入口文件**：`index.html` (Web) / `index-scanner.html` (Scanner)，各含独立 `main.tsx` / `main-scanner.tsx`
- **ScannerApp.tsx**：新建独立扫描端组件，含答题卡选择 + 扫描面板 + 结果预览，无设计/分析/账号等 Tab
- **App.tsx**：移除 ScannerPanel 导入和使用（web 模式不需要）

### 扫描端重构：答题卡选择 + 工作台

- **双屏路由**：`CardSelectPage`（选卡）→ `ScannerWorkspace`（扫描）
- **CardSelectPage.tsx**：对齐 ExamSelectPage 风格
  - 单科/大考双 Tab 切换
  - 搜索框（按 ID 或名称搜索）
  - 学科下拉筛选
  - 表格列表（答题卡名称 / 科目 / 日期）
  - 大考 Tab：展开显示下辖考试列表，点击选择对应答题卡
- **ScannerWorkspace.tsx**：扫描工作台
  - TWAIN 扫描仪直扫（复用 ScannerPanel）
  - 文件/目录导入阅卷（复用 grading API，含 GradingResults 展示）
  - 顶栏返回按钮

### 学生端 Bug 修复

- **成绩天梯无法显示**：`/api/ladder/*` 路由已定义但未在 `server/index.ts` 中 mount，所有请求落入 SPA fallback 返回 HTML
  - 修复：添加 `import ladderRoutes` 并 `app.use("/api/ladder", ladderRoutes)`
- **跨考累计 JSON 报错**：同上根因，修复后天梯三种维度（单科/大考/跨考）均可正常查询

### 废弃：学生端 / 教师端 Electron 打包

- 删除 `electron:pack:student`、`:teacher` 以及所有 ia32 变体脚本
- 教师/学生功能统一通过 Web 构建访问，Electron 只保留扫描端
- 删除 `scripts/package-variant.ts` 引用（v1.7.0 已删除该文件）
- 删除 `VITE_PROJECTX_VARIANT` 编译时变量，改用 `VITE_BUILD_TARGET`

### Electron 精简

- `electron/main.cjs`：移除 variant 体系，固定为扫描端
- 只加载 `dist/scanner/`，固定 `PROJECTX_ENABLE_SCANNER=1`
- 包名改为「答题卡扫描端」

### 后端适配

- 默认客户端目录从 `dist/client` 改为 `dist/web`
- Ubuntu 服务器打包脚本同步更新
- 移除 `PROJECTX_VARIANT` 配置项

### Persona 简化

- 管理员在 Web 端可切换「教师」/「学生」身份
- 移除「教师扫描端」persona（扫描端独立使用，无需切换）
- `AuthContext.tsx` 使用 `VITE_BUILD_TARGET` 判断 persona 可用性

## v1.6.0 (2026-06-27) — 客户端拆分 + 运行时身份切换

### 架构：从单体 Electron 到独立客户端

教师扫描端、教师端、学生端各自独立，统一通过 HTTP API 通信。

```
v1.5.5:  单一 Electron 进程（设计+扫描+阅卷 全在一起）
v1.6.0:  扫描端(Electron) ←→ 服务端(API) ←→ 教师端(WEB) / 学生端(WEB)
```

### 运行时 Persona（AuthContext 扩展）

- **管理员可在账户下拉菜单切换身份视图**：扫描端 / 教师端(学科老师/班主任/学年主任) / 学生端
- 切换即时生效，无需重启
- persona 存 localStorage，登录恢复
- 教师/学生固定身份，不可切换

**文件**：`AuthContext.tsx`（新增 type `AppPersona` / `TeacherRoleOverride` / `setPersona` / `availablePersonas`）
**文件**：`AccountMenu.tsx`（新增「查看身份」区域，仅管理员可见）

### 登录页：远端配置 + 本地模式

- 新增折叠面板「服务器连接（可选）」：输入服务器地址、API Key、测试连接
- 不填 = 纯本地模式（所有数据存本地 SQLite）
- 填了 = 教师/学生功能走远程 API
- 服务器地址和 API Key 存 localStorage
- `api.ts` 中 `getApiBase()` 改为运行时读取 localStorage

**文件**：`LoginPage.tsx`（重构，新增 Globe + 连接测试）
**文件**：`api.ts`（`API_BASE` 常量 → `getApiBase()` 函数，同时自动附带 X-Api-Key 头）

### API Key 认证体系

**新建表**（migration v11）：

```sql
CREATE TABLE api_keys (
  id, name, api_key UNIQUE, scope DEFAULT 'scanner', is_active, created_by, created_at
);
```

- `ensureDefaultAdmin()` 时自动生成一条 scanner key
- 管理 API：`GET/POST/PUT/DELETE /api/admin/api-keys`
- 中间件：`src/server/middleware/api-key.ts`（从 `X-Api-Key` header 校验）
- scope `scanner` 的 key 仅能访问 `/api/scanner/*`

### 扫描上传端点

**文件**：`src/server/routes/scanner-upload.ts`

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/scanner/upload/sessions` | 创建扫描会话 |
| `POST` | `/api/scanner/upload/sessions/:id/pages` | 上传扫描页（multipart） |
| `POST` | `/api/scanner/upload/sessions/:id/complete` | 标记完成 |
| `GET` | `/api/scanner/upload/sessions/:id/status` | 查询状态 |

双鉴权：`apiKeyAuth`（高优先级）+ `authMiddleware`（低优先级，任一通过即可）

### ScannerPanel：本地/远程双模

- 新增「本地存储」←→「上传服务器」切换按钮
- 本地模式：行为不变，扫描结果存本地 SQLite
- 远程模式：扫描完成后自动逐页上传到服务端
- 上传进度实时显示（上传中/完成/失败状态）
- 模式选择存 localStorage（`projectx_scanner_mode`）

**文件**：`ScannerPanel.tsx`（新增 `Upload`/`Database` 图标，`scannerMode` 状态，`uploadToRemote()` 函数，上传状态指示器）
**文件**：`twain_scan_records` 表新增 `uploaded INTEGER DEFAULT 0` 字段

### App.tsx 运行时 Variant

- `appVariant` 从 compile-time `import.meta.env.VITE_PROJECTX_VARIANT` → runtime `useAuth().persona`
- `hasNativeScanner` 通过 `navigator.userAgent` 检测 Electron 环境
- 扫描 TAB 可见性 = persona 允许 + grading 权限 + 本地有扫描硬件
- WEB 模式（浏览器）自动隐藏扫描 Tab

### 数据库

- 新增 `api_keys` 表（v11 migration）
- `twain_scan_records` 新增 `uploaded` 列
- 两份 schema 同步更新：`schema.sql` + `schema.mariadb.sql`

### 端口默认值改为 443

所有默认 MariaDB 端口 3306 → 443（适配仅开放 22/80/443 的防火墙场景）

### 版本号

- `package.json` 1.5.5 → 1.6.0

## v1.5.5 (2026-06-27)数据库重构
### 新增文件

| 文件 | 说明 |
|------|------|
| `src/apps/answer-card/client/styles.css` | 新增 ~300 行：CSS 变量、底部导航样式、480px 断点全部规则、横屏适配、暗色模式配套 |
| `src/apps/answer-card/client/App.tsx` | 新增 `mobileNavItems` useMemo + 底部导航 `<nav>` JSX + `ReactElement` 类型导入 |
| `index.html` | viewport meta 升级 + 3 个新 meta 标签 |

### 版本
- v1.5.2 → v1.7.3

## v1.5.2 (2026-06-26) — 数据库双后端架构

### SQLite → MySQL 双后端迁移

本项目从单机桌面端向 B/S 服务端架构演进的第一步：所有 Repository / Service / Route / Middleware 已全面异步化，支持通过环境变量切换 SQLite 或 MySQL 后端。

- **双后端适配器**（`db/mysql.ts`）：统一 `DbAdapter` 异步接口——`get()` / `all()` / `run()` / `exec()` / `transaction()`
  - MySQL 模式：`mysql2` 连接池（连接数上限 20）、事务通过 `PoolConnection` 实现
  - SQLite 模式：内部 better-sqlite3 同步调用，对外暴露 async 接口，**完全兼容原有行为**
  - 环境变量控制：不设 `PROJECTX_MYSQL_HOST` → 自动回退 SQLite，零配置零影响
- **新增 `db/schema.mysql.sql`**：完整 MySQL 建表脚本，InnoDB 引擎、utf8mb4、AUTO_INCREMENT、外键约束、30+ 索引，与 SQLite schema 一一对应
- **6 个 Repository 全量异步化**：
  - `UserRepository`（39 方法）、`AnalysisRepository`（34 方法）、`CardRepository`（22 方法）、`ClassRepository`（17 方法）、`ExamRepository`（15 方法）、`ScoreRepository`（4 方法）
  - SQL 从 `db.prepare().get()` 迁移为 `await db.get()`，事务从 sync callback 迁移为 async `db.transaction(async (tx) => {...})`
  - `INSERT OR REPLACE` 在 MySQL 端自动转换为 `ON DUPLICATE KEY UPDATE`（adapter 内透明处理）
- **6 个 Route 文件异步化**：`classes.ts`、`scores.ts`、`teachers.ts`、`users.ts`、`export.ts`、`score-editing.ts`——Express handler 全部改为 `async (req, res)`，内部调用 `await repo.xxx()`
- **2 个 Service 异步化**：`AuthService.ts`（`getUserByToken`、`login` 等核心方法）、`AssignedScoreService.ts`（赋分公式管理）
- **1 个 Middleware 异步化**：`middleware/auth.ts`——`attachUser()`、`authMiddleware()`、`getCurrentUserHandler()`、`optionalAuth()` 全部改为 async
- **App Server 局部迁移**：`app server/index.ts` 中全部 Repository 调用加 `await`，3 处 `db.transaction()` 拆为顺序 async 调���，`card-layout.ts` 中 `findCardForLayout` → async
- **Scanner DB 保持 SQLite**：`scan-store.ts`（19 处 `.prepare()`）和 grading pipeline 中的 `INSERT OR REPLACE` 保持 SQLite 原样，扫描流水线独立运行

### 依赖
- 新增 `mysql2: ^3.14.0`
- 保留 `better-sqlite3: ^12.11.1`（SQLite 回退 + scanner.db）

### 前端性能优化

- **`transition: all` 替换**：~30 处全局 `transition: all 0.3s` 替换为精确属性列表（`background`、`color`、`border-color`、`box-shadow`），消除 backdrop-filter 无效重算，减少帧间重排开销
- **毛玻璃 GPU 优化**：`.liquid-glass` 和 `.liquid-glass-strong` 增加 `will-change: backdrop-filter`，让浏览器预分配 GPU 资源；`.sidebar` 增加 `contain: paint layout style`，隔离渲染区域
- **CSS 变量别名**：新增 `--primary: var(--brand)`、`--bg-secondary: var(--surface-raised)`、`--bg-accent: var(--brand-soft)`、`--border: var(--line-strong)`，解决多个组件引用未定义变量导致的暗色模式渲染异常

### Bug 修复

| 修复项 | 文件 | 说明 |
|--------|------|------|
| 表名不一 | `AnalysisRepository.ts` ×2 | `exam_group_items` → `exam_group_members`（与 schema v8 对齐） |
| 列名错位 | `app server/index.ts` | 主观题 `question_id` 误写入 `block_id` 列 → INSERT 列宣言改为 `question_id` |
| 默认值不一致 | `migrations.ts` ×2 | `score_display_mode`: `'deviation'` → `'zscore'`；`export_templates.name`: `'Untitled'` → `'未命名'` |
| localStorage 写错值 | `App.tsx:529` | 关闭夜间模式后仍写入 `"dark"` → 改为写入 `effectiveTheme` |
| 组件白色硬编码 | `CreateExamGroupModal.tsx` ×4、`GroupExportModal.tsx` ×2 | `#fff` 背景改为 `var(--surface)`，品牌按钮色改为 `var(--brand)` |
| 合并冲突冗余 | `CreateExamGroupModal.tsx`、`GroupExportModal.tsx` | 清除 `<<<<<<<`/`>>>>>>>` git 冲突标记 |

### 版本
- v1.5.1 → v1.5.2

## v1.5.1 (2026-06-25) — 学生端升级

### 学生端全面升级

- **个人成绩趋势分析（纵向）**：新增折线图展示学生各科历次考试成绩变化趋势，支持多学科同时对比、班级均分/年级均分参照线开关。使用 Chart.js 渲染，学科标签可交互筛选
- **学科横向对比（薄弱学科识别）**：雷达图 + 详情表格，聚合本学期全部考试数据，按各科平均分与班级均分差距自动标注薄弱学科。支持趋势方向（进步/退步/稳定）图标标识
- **AI 个人分析**：两种模式
  - **单场分析**：在成绩列表展开某场考试后，点击「AI 分析」按钮调用教师端现有 AI 接口
  - **整体分析**：综合学生全部考试成绩，生成个性化学习建议和薄弱点分析
- **学生自配 AI 服务商**：复用已有 `ai_providers` 系统，学生可在 AI 分析 Tab 中自行填写 API Key 和模型配置（支持 DeepSeek / OpenAI 兼容 / Gemini），费用由学生个人承担
- **综合仪表盘 UI**：从单一成绩列表重构为混合式布局——顶部统计概览卡片（考试数/平均分/学科数/最佳/待提升），Tab 导航切换四个功能模块

### 新增后端 API

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/scores/me/trends` | 学生成绩趋势数据（含班级/年级均分） |
| `GET` | `/api/scores/me/subject-comparison` | 学科横向对比分析（含薄弱学科标注） |
| `POST` | `/api/scores/me/ai-analysis` | 学生个人 AI 整体分析 |

### 新增类型
- `StudentTrendPoint`：趋势数据点（总分、班级均分、年级均分、排名、百分位）
- `SubjectWeaknessItem`：学科薄弱分析结果（考试次数、平均分、班级均分差距、趋势方向）
- `StudentAiAnalysisRequest`：学生 AI 分析请求

### 数据库
- 无新增表，复用已有 `ai_providers` 表

### 依赖
- 新增 `chart.js` + `react-chartjs-2`

### Bug 修复
- **折线图数据对齐**：不同学科的考试名不一致时，之前按数组索引对齐导致数据点错位，现改为按考试名映射到共享 labels
- **新路由认证缺失**：`POST /api/scores/me/ai-analysis` 移入 `scores.ts` 路由器，自动享受 `authMiddleware` 保护
- **SQL 列不存在导致 500**：`ScoreRepository.getStudentTrendData()` 引用了 `class_students.is_active` 列，该列不存在；修复为移除虚假列引用、`JOIN` 改为 `LEFT JOIN` 子查询处理多班级、学生无班级时 classAvg 返回 NULL
- **学生可越权访问教师分析接口**：`getVisibleExamIds()` 对学生返回 `null`（全部可见），导致学生可调用任意考试的 AI 分析接口。修复：`requireExamAccess` 中增加学生分支，仅放行 `hasScore()` 为 true 的考试
- **学生通过 hasScore 可越权删除考试/查看全班数据**：`requireExamAccess` 的学生分支对所有方法（GET/DELETE/...）通行。修复：学生分支仅允许 `POST /.../ai-analysis`，其余方法返回 403
- **AI 单场分析按钮在 auth 强制模式下永久 403**：`POST /api/analysis/exams/:examId/ai-analysis` 经过 `analysisGate` 要求 `grade:read`，学生只有 `score:read`。修复：新增 `POST /api/scores/me/exams/:examId/ai-analysis`（挂载在 scores router 下，无 analysisGate），前端 `AiAnalysisForExam` 改为调用该端点
- **整体 AI 分析后端对接错误**：`POST /api/scores/me/ai-analysis` 原设计向 llmclient 发送 `examId: 0` + `studentAnalysis: true`，但 llmclient 仅支持 exam-scoped 请求。修复为直接用服务端已有的趋势数据生成文本分析报告，不再调用 llmclient；待 llmclient 支持学生分析后可切换回
- 清理未使用的 import

### 新增后端 API
| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/scores/me/exams/:examId/ai-analysis` | 学生单场考试 AI 分析（绕过教师端 RBAC gate） |

### 版本
- v1.5.0 → v1.5.1

## v1.5.0 (2026-06-24) — 稳定版

### 跨考入口 & 排名修复
- **三选一紧凑切换**：考试选择页右上角 toggle 改为 [单科 | 大考 | 跨考]，跨考不再单独占一个按钮
- **跨考内联化**：跨考试总分统计直接嵌入 ExamSelectPage，不再跳出独立页面，无需「返回」操作
- **按周预览**：跨考「按日期打包」模式新增实时考试预览，切换日期即刻看到该周包含哪些考试
- **日期/按钮对齐**：跨考面板日期输入框与统计按钮统一基线对齐
- **全局并列排名修复**：所有排名从顺序排名改为同分并列排名（1,2,2,4,5...），覆盖跨考总分、大考排名、单科排名、导出表格等全部场景
- **competitionRank 提取**：排名工具函数从 `denseRank` 重命名为 `competitionRank`（更准确），提取到 `src/shared/ranking.ts` 避免 AnalysisRepository 与 exam-groups 代码重复
- **表名统一**：AnalysisRepository 从 `exam_group_items` 改为 `exam_group_members`，消除迁移后新装环境表缺失导致的跨考功能不可用
- **列表隔离**：按 `source` 列隔离大考列表（`NULL`/`'manual'`）与跨考已存组列表（`'cross-manual'`/`'week'`），避免互相泄漏
- **删除确认**：跨考已存组删除增加确认弹窗（显示关联考试数），考试管理大考删除支持级联考试选项
- **周预览口径对齐**：前端周预览日期取值与后端 `COALESCE(exam_date, created_at)` 对齐，无答题卡日期考试不再遗漏
- **名次变化修复**：上次考试排名（preRankMap）改用并列排名，消除同分场景下名次变化计算偏差
- **死代码清理**：删除已内联但未删除的 CrossExamTotalPage.tsx (424行) 和 migrations.ts 中未调用的 createExamGroupsIfMissing
- **暗色主题**：跨考删除确认弹窗改用 CSS 变量，暗色模式下不再白框刺眼

### 大考（Exam Group）功能

- **大考组 CRUD**：支持创建「大考合集」将多场单科考试组织为一个逻辑大考（如"2026高考摸底大考"包含语数英物化生）
- **关联考试管理**：创建时可选择关联已有考试，创建后也可增删成员考试，支持拖拽排序
- **大考内新建考试**：可直接在大考合集中快速创建新考试并自动关联
- **大考分析视图**：概览 Tab 展示各科参数卡片网格（人数/均分/最高/最低/标准差/及格率/优秀率），成绩 Tab 提供跨科横向排名表
- **跨科排名**：按总分排名显示校排/班排，每科单独显示原始分/赋分/校排/班排，支持班级筛选和「仅全科参加」开关
- **总分模式**：可按原始分或赋分计算总分排名
- **大考标签**：支持月考/期中/期末/模考/统考标签分类
- **考试选择页大考入口**：新增「单科考试」/「大考」分类切换
- **考试管理页大考入口**：考试管理 Tab 新增单科/大考模式切换，支持大考列表管理

#### 数据库
- 新增 `exam_groups` 表（name, description, grade_id, tag, status, is_official, total_score_mode, only_full_participants）
- 新增 `exam_group_members` 表（group_id, exam_id, sort_order）
- Migration v8 幂等创建

#### API
| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/exam-groups` | 大考列表 |
| `POST` | `/api/exam-groups` | 创建大考 + 关联考试 |
| `GET` | `/api/exam-groups/:groupId` | 大考详情含成员列表 |
| `PUT` | `/api/exam-groups/:groupId` | 更新大考信息 |
| `DELETE` | `/api/exam-groups/:groupId` | 删除大考（级联，不删考试） |
| `POST` | `/api/exam-groups/:groupId/exams` | 批量关联考试 |
| `DELETE` | `/api/exam-groups/:groupId/exams/:examId` | 移除关联 |
| `PUT` | `/api/exam-groups/:groupId/exams/sort` | 批量更新排序 |
| `GET` | `/api/exam-groups/:groupId/overview` | 大考概览（各科参数） |
| `GET` | `/api/exam-groups/:groupId/rankings` | 跨科总分排名 |
| `POST` | `/api/exam-groups/:groupId/export` | 导出 ZIP（总览+各科小分） |

### 导出增强

- **单科导出新增可选胶囊**：`客观题小分` 和 `主观题小分`，可选加入导出列
- 客观题小分：拉展该科所有客观题得分（Q1/Q2/...），含每题满分标注
- 主观题小分：拉展该科所有主观题得分（S1/S2/...），含每题满分标注
- 胶囊颜色分类：基础(蓝)/分数(绿)/排名(橙)/题目(紫)
- **大考导出（ZIP）**：总览表（跨科排名+各科原始分/年排/班排）+ 各科详细小分 Excel 文件
- 导出可选：是否包含客观题小分、主观题小分、选择导出哪些科目

### 前端组件
- `CreateExamGroupModal`：创建/编辑大考弹窗，含考试搜索选择器
- `ExamGroupDetailPage`：大考分析视图（概览+成绩 Tab）
- `GroupExportModal`：大考 ZIP 导出配置弹窗
- `ExamSelectPage` 更新：新增单科/大考分类切换
- `ExportModal` 更新：新增客观题小分/主观题小分胶囊列
- `App.tsx` 集成：大考创建模态框、大考分析视图、考试管理双模式

### 跨考试总分分析（合并自 main）

- **CrossExamTotalPage**：三种模式（按周自动打包 / 手动选考试 / 选择已存大考组）计算跨考总分排名
- 按日期范围自动关联一周内的考试，快速生成一周考试包总分
- 支持仅全科参加、仅部分参加等出席模式筛选
- 考试选择页新增「跨考总分」快捷入口
- API: `GET/POST/DELETE /api/analysis/cross-exam/groups`, `POST /api/analysis/cross-exam/total`
- DB: `exam_groups` 表新增 `source`/`start_date`/`end_date` 字段兼容两种用途

### 备案合规
- **ICP 备案信息**：登录页底部新增备案号展示（辽ICP备2026013340号 + 辽公网安备21020402001085号），`BeianFooter.tsx` 组件含工信部/公安备案双链接

### 性能优化
- **毛玻璃性能修复**：大量 `backdrop-filter: blur()` 改为 `opacity` 叠加，消除滚动/切换页面时的明显卡顿感（#115）

### Bug 修复
- **暗色主题残余硬编码**：CreateExamGroupModal、GroupExportModal 内联白色背景改为 CSS 变量，修复暗色模式下弹窗白块（#113）

### 开发者工具
- **Demo 测试数据集**：新增 `testdata/demo-exams/`，含可导入备份 ZIP、CSV 片段、种子脚本和验证脚本，覆盖单科/大考/跨考/并列排名/缺考/名次变化/小分导出等全场景（#116）

### 教师角色细化
- **组长/科任/班主任严格区分**：后端数据范围过滤逻辑完善，真正实现 `subject_teacher`（本科目本班）、`head_teacher`（本班全科）、`grade_leader`（全年全科）三级隔离；修复相关数据库查询值名问题（#114）
### 版本
- v1.4.7 → v1.5.0

## v1.4.7 (2026-06-20)

### 教师细分角色（权限数据范围）

- **教师三种细分角色**：管理员可在「教师管理」中设置三种角色，登录后自动限定数据可见范围
  - **学科老师**（`subject_teacher`）：仅限本学科本人所教班级的考试与成绩
  - **班主任**（`head_teacher`）：仅限所管班级全部科目考试与成绩（限本年级）
  - **学年主任**（`grade_leader`）：全年级全科目，不受限制
  - 未设置细分角色的教师保持原全权限，向后兼容
- **后端数据范围过滤**：所有 `/api/exams`、`/api/analysis/exams/:id/*`、`/api/exams/:id` 端点自动根据 `teacher_role` 过滤可见考试
- **数据库**：`users` 表新增 `teacher_role TEXT` 列；自动 migration
- **管理员 UI**：用户管理列表新增「教师细分」列；新建/编辑表单增加角色下拉；教师管理面板增加角色选择

### 暗色模式全面修复
- 15 处硬编码 `background: #fff` 改为 CSS 变量 `var(--surface)`
- 所有 TSX 组件内联 `#fff` 背景统一替换为 `var(--surface)`
- 表单元素（input/select/textarea/checkbox）暗色适配
- 模态卡片、面板、编辑区暗色适配
- SVG 答题卡预览页暗色适配（CSS 变量 + style 双保险）
- 侧栏渐变、badge 标签、下拉菜单暗色适配
- 背景图在暗色模式下叠加 `brightness(0.45)` 遮罩
- 追加 ~90 行 `[data-theme="dark"]` 集中覆盖规则

### 账号设置重构
- 左侧分类导航栏：阅卷设置 / 客户端设置 / AI 设置
- 选中项品牌色高亮 + 左边框指示
- 右侧内容面板按 Tab 切换，独立保存按钮
- 默认展开"阅卷设置"

### Gemini SDK 完整修复
- `providers.py`: 修复用户配置 Gemini 时走错 OpenAI 路径的致命 Bug
- `ai-providers.ts`: Gemini 不再强制要求 Base URL
- 前端 Gemini 选中时隐藏 Base URL 输入框，显示提示文案
- "如何填写？"帮助卡片更新：Gemini 标注为"无需填写"
- 新增 Google AI Studio 获取 API Key 指引

### Bug 修复
- **Markdown 链接解码错误**：`UserGuidePage.tsx` 处理本地 .md 相对链接，阻止 Electron file:// 协议下的乱码
- **学生导入去年级列**：CSV 模板从 `年级,班级,学号,姓名` → `班级,学号,姓名`，后端自动从"几年几班"解析年级
- **学生管理滚动容器**：年级/班级/花名册三栏添加 `max-height` 内滚动，不再拉伸整个页面
- **ESC 全局退出**：ESC 关闭成绩分析 detail / 赞助页 / 使用说明页，聚焦输入框时跳过
- **自动保存提示圆角容器**：`.autosave-status` 改为圆角 pill 样式

### 答题卡设计增强
- **题块自动命名**："一、单选（10题 50分）"实时生成，`toChinese(n)` 算法支持 1-100，增删块/改题型/改题数/改分值时自动刷新
- **块级编辑同步**：修改块级题型/选项数时自动同步到所有逐题配置
- **每题配置默认折叠**：按需展开/收起，减少设计器面板高度

### 夜间模式开关
- 账号设置 → 客户端设置 → 新增「夜间模式（实验性）」复选框
- 默认不启用，标注"⚠ 实验性功能，存在严重视觉问题"
- 不启用时顶部栏隐藏主题切换按钮
- localStorage 持久化存储

### 版本
- v1.4.6 → v1.4.7

### 日间/夜间模式
- 新增主题切换按钮：位于顶部栏右侧，☀️/🌙 SVG 图标即按钮，点击即时切换
- 完整深色色板：品牌色、中性色阶、阴影、毛玻璃效果全部适配暗色背景
- `data-theme="dark"` 属性挂载 html，`color-scheme` 同步，系统表单元素自动暗色
- 设置持久化：localStorage 保存选择，刷新后保持

### Bug 修复
- **答题卡放大控件无效**：`width` 百分比在 flex 容器中仍被约束 → 改用 `transform: scale()` 缩放图片
- **背景图被遮挡（四次修复）**：`body::before{z:-1}` → `body.style.background` → `insertBefore+#root z-index` → 最终 `body::after` 浮层覆盖（内容面板 15+ 处 `background:#fff` 把视口填满，背景放哪层都没用，必须浮在最上面用半透明穿透）
- **背景图透明度可调**：checkbox 开/关 → range 滑块 0%~50%，滑块拖动即时生效无需保存
- **上传自定义背景图**：设置面板新增上传按钮，`POST /api/users/me/background`，存储到 `data/answer-card/backgrounds/`
- **手动改分后赋分自动重算**：`recomputeRankings()` 末尾追加 `AssignedScoreService.recalculateAll()`

### 数据库 & API
- 新增 `users.background_opacity REAL DEFAULT 0`（旧 `show_background` 列自动迁移）
- `GET /api/app/background` 优先返回用户自定义背景
- `POST /api/users/me/background` multipart 上传（5MB, image/*）
- settings API 新增 `backgroundOpacity` 字段

## v1.4.5 (2026-06-19)

### AI 服务商配置优化
- 账号设置中 AI 服务商「如何填写？」改为独立卡片弹窗（createPortal），不再叠在设置上
- 移除旧 AI API Key 输入框（已被 AI 服务商完全替代）
- Base URL 保存时自动补齐 `/v1` 路径
- 哈基米合并为 Gemini，下拉选项简化为 GPT/DeepSeek/Gemini
- 修复保存 Gemini 时报错 `NOT NULL constraint failed: ai_providers.user_id`
- AI 分析接口错误信息中文化：区分连接失败/超时/404

### 成绩修改 + 逐题明细
- 数据库新增 `answer_overrides` 表 + 成绩表新增手动修改追踪字段
- API: 学生搜索、逐题改分、修改答案批量重算、班级均分统计
- `ScoreFixPage`: 双模式→搜索→逐题改分/答案编辑，内嵌答题卡（点击放大）
- `StudentScoreDetail`: 点击成绩表行→子页面，逐题得分+班级均分率+答题卡
- 成绩 Tab 栏右侧「分数有问题？」按钮（仅教师/管理员）

### 弹窗遮挡修复
- `ScoreFixPage` 图片放大、`ScanPreviewModal`、`ImportCardModal`、`StudentScoreDetail` 全部 `createPortal`
### 分数段动态化
- 硬编码 0-59/60-69/... 改为按 10 分一段自动生成，末段截止满分
- 0 人分段自动隐藏，颜色按位置（首段红/末段绿）

### 弹窗遮挡修复
- `ScoreFixPage` 图片放大、`ScanPreviewModal`、`ImportCardModal`、`StudentScoreDetail` 全部 `createPortal`
- 修改答案后自动调用评分引擎重算全部分数+排名

## v1.4.0 (2026-06-18)

### 缺陷修复 (2026-06-19)
- 导入答题卡创建考试时科目存为拼音（如 wuli）→ 改为优先用 `subjectLabel`（中文名）
- 新建考试默认状态从 `draft` 改为 `active`，避免阅卷后状态异常
- 阅卷流程 `prepareLayoutForCard` 增加 `normalizeCard` 调用，旧卡阅卷自动修复 null 数值

### 答题卡预览改造 (2026-06-19)
- 答题卡预览从新窗口打开改为页内叠加弹窗：半透明背景蒙层(z-index:99999)，支持多页纵向滚动
- 新建公共组件 `ScanPreviewModal.tsx`：PDF 风格预览，缩略图导航，PgUp/PgDn/ESC 快捷键
- ScannerPanel 和设计模式阅卷结果均迁移到新组件，删除旧 `StudentDetailModal` 内联代码
- 分析-成绩表格新增「答题卡」列：每行显示蓝色「预览」链接，点击弹出答题卡图片
- 按学生过滤：API 通过 scan_records 插入顺序与上传文件时间排序对齐，只返回该学生的答题卡页
- 新增 API: `GET /api/scanner/exam/:examId/student/:studentId/scans` + `GET /api/scanner/grading-image/:cardId/:fileName`
- 修复: 原查 scanner.db（空库），现从 recognition/uploads/:cardId/ 读取实际文件
- 修复: grading 持久化 file_path 改为存 multer 实际路径（新阅卷生效）
- 单面答题卡不显示"正面/反面"标识

### 导入答题卡模板增强 (2026-06-19)
- 导入 `.projectx-card.json` 后弹出 `ImportCardModal` 确认卡片
- 可修改：科目、考试名称、考试日期（内联日历选择器）
- 考试关联三选一：不创建 / 创建考试（留空默认同答题卡名）/ 关联已有考试
- 后端 import 端点支持 override 字段 + 自动创建/关联考试

### 成绩查看大改造
- 新增「考试选择页」：按学年、年级、学科三级筛选，卡片网格展示考试，含人数/均分/状态预览
- 考试管理从分析子Tab独立为顶层「考试管理」Tab，位于设计右侧
- 成绩查看页新增班级选择器（右上角），5个子Tab：概况、成绩、考试分析、AI分析、得分率
- 概况Tab重写：信息卡片 + 分数段水平条形图 + 箱型图 + 上次考试对比条

### 成绩表格增强
- 成绩表格支持排序：全年级按校排，单班级按班排
- 新增「名次变化」列：对比上次同科考试，↑进步/↓退步箭头 + 颜色
- 新增「偏差值/Z值/百分位排名」三选一（账户设置切换）
- 新增 API: `/api/analysis/exams/:id/score-table`

### 赋分引擎
- 新增三种赋分公式：等比例转换、线性公式(raw×0.7+30)、自定义表达式
- 赋分科目自动识别：化学、生物、地理、政治
- 赋分配置可在考试创建时和考后修改，实时批量重新计算
- DB: `student_scores.assigned_score`, `exams.assigned_formula`

### 导出系统扩展
- 导出模板系统：4个自定义模板槽，每个模板可命名并保存列配置
- 胶囊拖拽排序列：每列以胶囊形式展示，支持拖拽更换列序
- 数据预览：导出前预览前3行真实数据
- 侧表：可附加年级前N名参照表，N可手动输入，与主表间有空隙
- A4竖版适配：超出1页时警告提示
- 新增表: `export_templates`

### 账户设置
- 偏差值/Z值/百分位排名三选一
- 复核置信度阈值滑块 (0~1)
- DB: `users.score_display_mode`, `users.review_confidence_threshold`

### 数据库迁移
- student_scores 新增 assigned_score 列
- exams 新增 assigned_formula 列
- users 新增 score_display_mode, review_confidence_threshold 列
- 新增 export_templates 表
- 新增 ai_providers 表（多服务商配置）

### AI 多服务商扩展
- 支持 GPT / DeepSeek / 哈基米 / Gemini 四条AI分析线路，可自定义 Base URL
- 账号设置新增「AI 服务商」管理：添加/编辑/删除服务商配置
- AI 分析面板新增服务商下拉选择 + 模型输
- 数据库：ai_providers 表 (name, provider_type, base_url, api_key, models)
- API: GET/POST/PUT/DELETE /api/ai/providers

### 班级对比增强
- 考试分析Tab班级对比新增「对比基准班级」下拉，选择班级后显示均分差值
- 班级按年级分组展示（optgroup），未分配年级自动归入「无年级」
- 班级对比表支持行间均分差异着色（↑绿/↓红）

### 成绩表格增强
- 成绩表格新增「年级」列（通过 LEFT JOIN grades 获取）
- 概况Tab新增「年级前五/后五」排名（按分数排序）
- 概况Tab新增「进步前五/退步前五」排名（按名次变化排序）

### UX 修复
- 账号设置 Modal 使用 Portal 渲染到 body，修复 backdrop-filter 遮挡问题
- Z值/班级下拉框垂直对齐统一（padding + flex 居中）
- 考试管理表格样式统一为列表式（exam-list-table div 布局）
- 子Tab 文字与标题栏左右对齐
- 平均分卡片移除红色高亮框
- 导出按钮文字横向排列（whiteSpace: nowrap）

### Bug 修复
- **答题卡竖向排列修复**：客观题「竖向（4题一组）」不再将每道题的 A/B/C/D 选项完全纵向堆叠并独占整行，改为高考 AB 卡式 4 题一组纵向排布，每题选项仍保持横向小组选项
- **预览/PDF 坐标一致**：竖向模式继续由 `src/shared/layout.ts` 统一生成坐标，SVG 预览、PDF 导出和识别布局 JSON 共享同一排版结果
- **答题卡创建日期校验**：移除新建弹窗中 `new Date()` 的宽松失焦解析，避免 `777-01-01` 被自动规范为 `0777-01-01`；前端、保存接口和导入接口均校验真实日期与年份范围

### UX 交互一致性改进
- 客观题属性面板中「选项排列」的竖向选项更新为「竖向（4题一组）」，底部提示同步说明 AB 卡式小组排布规则
- 新建答题卡日期输入框在外部值变化时同步日历月份，非法手输日期失焦后回退到当前有效值，避免右侧预览/检查器显示异常年份

### 开发者
- `ObjectiveBlock`、`ObjectiveQuestionConfig` 新增可选字段 `optionLayout: "horizontal" | "vertical"`，缺省按 `"horizontal"`，旧答题卡 JSON 与数据库无需迁移
- `ObjectiveQuestionDefinition` 同步增加 `optionLayout`，由 `normalizeQuestionConfig` 按块级 → 单题级 → 默认值顺序解析；评分逻辑不受影响
- `layout.ts` 新增 `vertical-grid` 排列模式与 `isVerticalQuestion` 判定，竖向题走 4 题一组纵向排布路径

---

## v1.3.0 (2026-06-17)

### 学科答题卡模板
- 新增 `src/shared/cardTemplates.ts`，新建答题卡时可按科目自动生成语文、英语、数学、物理、化学、生物的常用题块结构
- 英语模板支持在新建弹窗中选择是否包含听力题 1-20
- 语文模板支持选择题统一置于卷首，或按原题号分散插入到主观题块之间
- 化学、生物等模板内置"解答题中的小空"样式，减少手动搭建填空线的重复操作

### 客观题题级配置与评分规则
- 客观题块新增 `questions` 明细，可为同一题块内的每道题独立设置题号、题型、选项数、分值、标准答案和评分规则
- 多选/不定项评分规则扩展为三类：按选对项数给分、按正确答案总数分档给分、固定部分分
- 评分规则支持"允许夹杂错误选项但按选对项数给分"的特殊口径，用于语文等题型
- 新增 `scripts/grading-rules-smoke.ts`，覆盖语文、数学、物理、生物典型部分得分规则

### 填空题与版式
- 主观题块新增 `blockKind`，区分"填空题"和"解答题"，避免仅靠标题猜测布局
- 填空题支持每个空单独保存标签、宽度和高度，布局与 PDF 预览会显示对应空号
- 布局引擎支持非连续客观题号、混合选项数和跨页续排，`layout.ts`、`pdf.ts`、前端 SVG 预览共用同一结构

### 删除保护与数据一致性
- 答题卡被考试引用时，直接删除会返回 409，并给出引用考试名称
- 删除答题卡时可选择"解绑考试并删除答题卡"或"连同引用考试一起删除"
- 删除考试时可选择仅删除考试并解除答题卡关联，或同时删除关联答题卡
- `exams.card_id` 改为可空，支持先保留考试记录再解除答题卡引用

### 数据库与文档
- 新增 `objective_questions` 表，保存题级客观题配置和 `scoring_rule_json`
- `subjective_blocks` 新增 `block_kind`，`subjective_questions` 新增 `blanks_label_style`、`blanks_items_json`
- README、架构、数据库、管理员、多端、账号和项目胶囊文档同步到 v1.3.0

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
- 新增成绩工具白名单：考试概览、分数分布、班级摘要、题目分析、排名分段、错误率高题目
- 成绩分析中的教学关注口径改为错误/低分率分档：30%-49% 低档、50%-69% 中档、70%+ 高档，避免把普通错题误标为复核风险
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
