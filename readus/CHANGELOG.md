# Project-X CHANGELOG

## 2026-10-22：#349 交错客观/主观题块顺序保存后丢失

- **现象**：设计器里排成「一、二、三、四、五、六」（客观/主观交错），保存后重新打开、导出 PDF、`/layout` 和扫描识别都变成「先全部客观、再全部主观」。设计图与导出件不一致。
- **根因**：`bodyBlocks` 是交错数组，但落库拆成 `objective_blocks` / `subjective_blocks`；两个插入方法都把 `sort_order` 硬编码为 0，`findById()` 又固定先读客观表再读主观表，跨类型顺序没有落点。
- **修复**：保存时按 `bodyBlocks` 下标写整卡级 `sort_order`（跨两表连续唯一）；`findById()` 把两张表按 `sort_order` 合并。历史数据（`sort_order` 全 0 或按类型各自编号）继续按旧的分组顺序读取，重新保存后自动升级，不改变存量卡原有顺序。
- **影响范围**：PDF 导出、`/api/cards/:id/layout`、扫描识别、整卡订正、设计器重新加载。存量卡若已被错误分组，需老师重新拖动一次题块并保存——旧数据无法推断原本的交错意图。
- **验证**：新增 `verify:card-block-order`（临时 SQLite 隔离库）：交错块保存/读取往返、`buildLayout` 顺序、历史 0 序号兼容、历史卡重新保存升级；脚本在导入数据库模块前切到临时工作目录，并在首次写入前断言方言为 SQLite，避免本机 `config.yml` 的 remote 配置把回归写到真实库；`typecheck` 通过，CI 已接入。MariaDB 未在本机实跑（无客户端），读取路径为方言无关的 JS 合并，未新增列/迁移。

## 2026-10-20：#347 调班后历次考试跟随现班 + 原卷旋转查看

- **调班即回溯考试归属**：`reanchorStudentExamClasses` 在人工调班（迁移学生、加入班级、移出班级、导入新建班级关联）后，把该生全部考试的 `exam_class_memberships` 重写为调班后的班级，考号保持不变。此前 `captureExamClasses` 一旦为某场考试落过快照就永不改写，`preserveStudentExamHistory` 又把改动前的旧班级冻结进历史表，所以强基班调整、转班、留级跳级之后，历次考试与班级统计仍停在原班（issue #347 ①）。
- **回溯的取值口径**：只取该生仍在读的班级；考试范围（班级或年级）与现班不再重合时（跨年级调班、原班专属考试）仍归到现班，不让历史成绩落进筛选盲区。学生已无在读班级时保持原样（包括只剩归档关联的情况），不把历史改成「未知班级」或旧归档班；反过来，归属为「未知班级」的历史考试在被分配班级后会一并补上。班级排名与分数本身不在回溯范围内重算，按现有口径随成绩变化重算。
- **跟随归属的下游口径**：班级汇总、班级对比、梯队与年级梯子、成长曲线的班均分、成绩导出、按班筛选与钻取、重新判分后的归属全部按调班后的现班；实际参加名单（`exam_participants`）仍按考试记录存在与否判定，回溯班级不改名单人数。
- **调班接口的权限**：`POST /api/classes/:id/students/:studentId/move` 从只允许 `class:manage` 改为复用现有范围判断——管理员与持 `class:manage` 者直通；教师侧只放行源班班主任（按班关系 `teacher_classes.is_head_teacher` 指定，或显式 `teacher_role=班主任` 的旧数据兼容）与学年主任。源班级与目标班级都必须落在 `getAccessibleClassIds` 的范围内，并且无论范围是否为全校都要过源班级的 `can_view_students` 开关。未配置细分角色的旧数据教师即使在读取侧被兼容成全校可见，也不获得调班权；前端隐藏按钮不作为授权依据。
- **原卷旋转（issue #347 ③④）**：新增 `RotatedCardImage` / `RotationButtons`，扫描端「查看与订正异常卷」的改分画布、学号点选、整卡改分弹窗，以及网页端扫描原卷预览、答题卡放大查看和学生端「查看原卷」都可 90° 步进旋转。改分画布把图片与填涂格热区放进同一个 SVG 变换，旋转后点选坐标不变；旋转只影响显示，不写回图片、坐标或识别结果，弹窗关闭后复位。
- **#347 ②「无法确定考试归属」**：报告人复核为本场重复送卡，不是归属缺陷，本次不改代码。
- **PR #348 评审修复**：① 调班门不再把「范围不受限」当成「跳过其他权限检查」，学年主任也要过源班名单矩阵；班主任资格按源班关系判断，并补显式拒绝的 POST 回归；② `RotatedCardImage` 在图片加载成功时就记录尺寸——原先只在已请求旋转时才记录，导致「先看图再点旋转」的正常流程里同一个 `<img>` 不会再触发 load，旋转永远不生效；③ 90°/270° 时容器宽高比与 `viewBox` 同源互换（`rotationBox`），顺时针按钮与 SVG 正角度一致；④ 放大框 `contain` 模式给 SVG 旋转后的固有像素宽高，不再塌成替换元素默认小图；⑤ 媒体票据重签后的新地址写回组件状态，旋转后的 `<image>` 不再引用已淘汰的旧票据，且 SVG 分支的加载失败也会透传；⑥ 只剩归档关联时不再把历次考试改挂到旧归档班；⑦ 源班与目标班相同的重放请求在路由返回 400、仓储直接 no-op，不再触发历史归属回溯。
- **文档**：`AGENTS.md` 的班级口径、`readus/整卡改分说明.md`、`readus/原卷与逐题答案-使用说明.md` 同步改写。
- **验证**：`npm run typecheck`、`vite build --mode web`、`vite build --mode scanner` 通过；`verify:exam-class-memberships`（含回溯后的排名、对比、梯队、趋势、导出、筛选、重新判分与「只剩归档关联」断言）、`verify:class-archive`、`verify:permission-scope`（148/0，含调班显式拒绝与成功路径）、`verify:card-rotation-ui`、`verify:scan-correction`、`verify:scan-correction-security`、`verify:scanner-correction-safety`、`verify:scanner-postprocess-all` 均 ALL PASS。
- **已知限制**：以上验证只在 SQLite 上执行，本机没有 MariaDB 实例，MariaDB 方言分支未跑；调班入口目前只在「账号管理 → 班级管理」下（受 `user:manage` 门禁），教师虽已被接口允许，仍缺可见入口；真机扫描仪与浏览器端人工验收未做。

## 2026-10-22：#340 评审收口——背景上传与移除串行、单机清退入口隐藏

- **上传与移除不再交错**：`handleBgUpload` 与透明度 PATCH、移除 DELETE 进同一条队列；上传或移除进行中两个按钮与文件选择都禁用。避免 rename 晚于 DELETE 时「已移除」却仍有文件，或旧上传带走刚移除的图。
- **队列跨页面挂载共享**：写入队列提升为登录身份级（`backgroundWriteSession`），离开账号设置再返回时，新的 DELETE 仍排在旧实例的在途 PATCH 后面；身份切换后旧队列里尚未执行的任务直接丢弃，不会用新账号凭据落库。卸载时仍清理未发送的防抖定时器。
- **移除失败回填**：DELETE 失败时把本地透明度与浮层恢复到移除前，不再显示「已关闭」而服务端仍保留背景；删除文件改用 `rm(..., { force: true })`，双标签页并发删除不再因 ENOENT 返回 500。
- **免登录单机模式隐藏清退入口**：`GET /api/system-settings` 返回 `authenticated`，全局设置页只在有登录身份时渲染「清除学生历史背景」；后端匿名 401 保留。`ACCOUNT-CONTROL.md` 登记该边界与「已注销账号残留文件不在清退范围」。
- **验证**：`verify:student-web-settings` 新增管理员 `authenticated=true`、免登录 `authenticated=false`、跨挂载队列顺序与身份切换丢弃断言；`verify:auth`、`verify:security-critical`、`typecheck`、`build` 通过。未做真实浏览器与 iOS15 验收。

## 2026-10-18：#336 学生历史背景的清退入口

- 不在启动或迁移时删文件。学生已经看不到这些图，静默清盘会让人分不清教师的图有没有被一起带走。
- `DELETE /api/users/me/background`：登录用户删除自己的 `backgrounds/<userId>.jpg`，并把 `background_opacity` 归零。学生可以调，账号设置页不显示按钮；教师和管理员在背景区有「移除背景图」。
- `POST /api/admin/backgrounds/purge-students`（`system:manage`）：只删除当前学生角色的 `<id>.jpg`，只把这些账号的透明度归零。教师、管理员、临时文件和随包默认图都不动。全局设置页有确认对话框。

## 2026-10-18：#335 背景图上传上限改为三档

- `POST /api/users/me/background` 的体积闸门不再写死 5 MiB。`PROJECTX_BACKGROUND_UPLOAD_MIB` 默认 5、天花板 32；非法值回落默认并打印 `[background-upload-limits]`，超过天花板则夹紧。单一来源 `src/shared/backgroundUploadLimits.ts`。
- 超限仍是 413 `UPLOAD_ERROR`，文案带上当前生效上限，例如「上传文件超过大小限制（≤5 MiB）」。这句只属于背景图上传，其它 multer 闸门的文案不变。
- 账号设置接口多返回 `backgroundUploadLimit`，设置页在背景区注明「单张不超过 N MiB」。学生账号仍然不能上传。

## 2026-10-22：PR #344 恢复凭据与单卷保存边界修复

- 当前版本的未入库卷也校验既有恢复指纹；原图变化后重新显示核验入口，保存事务和确认入库拒绝失效凭据，普通保存不能重新盖章。上传完成入库也检查已有恢复指纹。
- 点名「保存此卷」仍有存疑题、实际没有入库时返回 409 和逐题确认提示；同会话其他卷缺学号、缺识别或未上传完成时，完整的所选卷可独立保存，其他卷的页面状态保持原样。
- 异常列表缓存正在执行的会话查询，同一刷新内并发处理多个回执时共用结果；下一次刷新重新读取。
- 新增 `verify:scanner-correction-boundaries`，通过 HTTP 和数据库终态覆盖当前版本凭据失效、取锁前原图变化、重新核验恢复、存疑题拒绝与确认后保存、单卷隔离、幂等重试和缓存并发。接入 SQLite 与 MariaDB CI。
- 本机 macOS / Node 24 / 隔离 SQLite：新增回归及 10 项既有专项通过，类型检查、Web、扫描端与服务端构建通过。MariaDB 验证由本提交 CI 执行。

## 2026-10-21：PR #344 旧卷订正凭据与异常卷队列收口

- **v64 之前保存的旧卷也要重新核验**：已入库旧卷的订正快照没有 `recovery_fingerprint` 时，不再当成普通扫描直接改正式成绩；打开成绩修改会返回「待核验」草稿，必须走签名补识别并保存后才能继续。`loadSessionCorrection` 与 `saveStudentCorrection` 共用同一判断，避免只在保存时才发现。
- **异常卷列表不再被 validate 回执灌满**：只保留 `held/roster/conflict/correction` 与「曾经入库过」的 pending；同一会话的页面、会话、卡片与分组在一次刷新内缓存，避免逐行重复读整会话。仅点过「校验」、尚未保存的正常卷仍留在扫描端待保存，不进教师异常队列。
- **单卷保存只回报本卷**：`saveGroupId` 指定时，`/complete` 与整卡订正返回的 results/failures 只包含该组；同会话其他组的名单或重复卷问题留给各自处理，不再把已成功保存的卷报成失败。
- **建表事实源补齐**：`scanCorrectionSchema()` 的 SQLite / MariaDB 共用 DDL 增加 `recovery_fingerprint`，v64 迁移继续做幂等补列；新库、老库升级与重放迁移走同一份列定义。
- **保留必要的一致性读取**：指纹包含保存后的 `revision`，因此写后加注仍要重新计算一次；没有复用写前哈希，避免把旧 revision 的指纹写回。
- **验证**：`verify:scanner-legacy-correction`（含迁移前无指纹→签名重识别→恢复可信）、`verify:scanner-batch-results`（新增双组单卷保存隔离）、`verify:scan-correction`、`verify:scan-correction-security`、`verify:scanner-correction-safety`、`verify:scanner-upload-flow`、`verify:scanner-pending`（本机在切图回滚清理断言处既有失败，已在干净 PR head 复现，与本次改动无关）与 `typecheck` 通过；MariaDB 方言未在本机运行。
## 2026-10-20：#345/#346 进步/退步按得分率判定 + 独立分析页交付收口

- **判定口径**：跨考试与跨学期的进步/退步一律按得分率变化（百分点）判定，阈值 ±3 pp，显著档 ±10 pp；缺满分时返回 null 并显示「—」，不虚构分母、不退回绝对分。服务端学生自助路径、React 页面、打印报告与独立分析页共用 `src/shared/scoreProgress.ts`。
- **独立分析页单文件交付**：`Grade-Analysis-System-mobile.html` 不再通过 `<script src="src/shared/scoreProgress.global.js">` 引用仓库内路径，生成包直接内联进页面；`scripts/sync-score-progress-browser.ts` 负责生成并内联，`verify:progress-score-rate` 校验内联内容与源码一致。按文档只复制 HTML 的部署方式不会再因 404 整页不初始化。
- **live 数据顺序**：`/api/exams` 与 `/api/scores/me` 都是最新在前，页面在 `fetchExams` / `fetchStudentScores` 统一整理为按考试时间升序；学生分析以该生实际有成绩的最近一场为锚点，缺考最新一场不再抛错或把方向算反。
- **零变化展示**：打印报告单与学期对比的得分率、总分、名次零变化统一显示「持平」，不再出现「↑ +0 pp」。
- **题块满分**：独立页题块判定只用题块自身满分，取不到即跳过并说明原因，不用整卷满分兜底。
- **验证**：`verify:progress-score-rate` 77 项通过，其中新增执行页面真实内联脚本的 live 顺序、缺考回退断言，以及打印报告单零变化的结构断言；`typecheck`、`build` 通过。未运行浏览器端到端与 MariaDB 专项。