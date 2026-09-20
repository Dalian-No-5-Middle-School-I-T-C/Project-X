# 27 MariaDB演示导入创建固定密码高权限用户

- 原标题：MariaDB demo import creates fixed-password privileged users
- 云端级别：中危（Medium）
- 原始报告：[打开报告](https://chatgpt.com/codex/cloud/security/findings/21326d21a1488191bcd906f1c163d604?repo=https%3A%2F%2Fgithub.com%2FDalian-No-5-Middle-School-I-T-C%2FProject-X&sev=&page=2)
- 关联提交：[274b282](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/commit/274b2823616075d9f5a70037e6ac429e2c47570e)

- 页面时间：2026 年 8 月 18 日 21:44（原页面未注明时区）。
- 操作者：NaOH1g。

## 概要

此问题由本次修改引入。MariaDB 管理员现在能够把使用固定凭据的演示教师导入实际认证及角色权限体系。应将功能限制在明确的非生产模式，使用随机、一次性且强制更换的密码，或严格限定在演示范围内的角色。创建账号之后才显示警告不足以构成防护。

此前 POST /api/db/import-demo 明确拒绝 MariaDB。本次提交移除检查，直接调用 seedDemoData，使集中式 MariaDB 实例也能执行导入，且可能通过文档中的代理或隧道公开。种子创建 demo-teacher 和 demo-teacher-2，密码固定为 teacher123，省略 teacher_role 和 password_change_required；MariaDB 默认值使其处于活动状态，无需改密即可使用。管理员导入后，知道公开凭据的匿名网络用户就能登录。普通教师兼容语义返回不受限制的考试可见性，默认角色拥有答题卡、考试及成绩读写能力，可能泄露可识别身份的答卷和未发布记录，或广泛修改成绩及考试。导入端点确实仅管理员可用，因此需要管理员先使用该功能；但可预测凭据警告在创建之后才返回，不是强制控制。移除数据库方言拒绝逻辑专门为 MariaDB 引入了风险，SQLite 此前已经存在相同的不安全账号行为。

## 验证

1. 确认 MariaDB 新增可执行路径且没有生产模式限制：父版本的拒绝逻辑被移除，当前版本直接调用种子服务。
2. 固定插入语句和 MariaDB 默认值确定了可预测的活动教师账号，且没有强制改密；共享路径动态验证观察到该账号状态。
3. 生产登录返回 200，没有密码重置要求，获得答题卡、考试及成绩六项读写权限。
4. 普通种子教师能够影响演示数据集之外的数据，枚举并修改独立的非演示、未发布正式考试。
5. 执行可行范围内最有力的现实测试，即真实 Express 端到端验证；由于没有 MariaDB 环境，精确的 MariaDB 执行仍是剩余缺口。

### 验证输出结果

原页面提供验证输出入口；附件内容未包含在已归档的页面正文中。

## 证据注释

1. 没有 teacher_role 的教师，其可见范围限制返回 null，表示兼容访问全部考试。
2. 默认教师包含答题卡、考试及成绩读写权限。
3. 省略字段默认 password_change_required=0、is_active=1、teacher_role=null，使账号立即可用。
4. 路由支持 MariaDB 并立即写入种子数据，固定凭据警告在成功创建之后才返回。
5. 创建两个密码为 teacher123 的教师，没有设置改密要求或细分角色。

## 攻击路径分析

技术后果仍为高：固定凭据取得具有广泛读写权限和无限制考试可见性的身份，真实 HTTP 验证证明了读取及修改无关非演示考试。最终不按“仅高权限用户”排除，因为管理员不是攻击者：特权导入创建长期认证弱点，随后由匿名远程用户利用，产生已证明的身份和授权提升。但发生可能性为中而非高，因为需要生产 MariaDB 管理员主动导入、账号持续存在、网络可达，以及没有用户名冲突。按矩阵，高影响与中等可能性得到中危。

### 路径

匿名远程用户 → 提交公开固定凭据 → 公开登录接口 → 活动账号通过 bcrypt 验证 → MariaDB 中的 demo-teacher／teacher123 → 获得无需强制改密的会话 → 具有答题卡、考试及成绩读写权限的教师 → 兼容可见范围为 null → 缺少 teacher_role 被解释为可访问全部考试 → 角色及对象检查广泛放行 → 读取和修改非演示考试。

攻击过程：学校管理员使用 MariaDB 演示导入按钮后，互联网匿名用户以公开的 demo-teacher／teacher123 登录。种子将固定密码哈希，插入两个普通教师，省略 teacher_role、改密和活动字段；MariaDB 默认值使其成为活动、免改密的普通教师。默认权限与 null 范围结合，允许访问全部考试。真实 HTTP 验证启用认证，观察到 passwordChangeRequired=false 及预期权限，并读取和修改无关的非演示草稿正式考试。动态运行使用 SQLite；MariaDB 可达性由旧拒绝逻辑移除、getMysqlDb、MariaDB INSERT IGNORE 生成及明确默认值静态确立。仅管理员、开发者子菜单、登录限流、可清除及响应警告降低发生可能性，却没有切断导入后的攻击链：警告出现得太晚，已知密码无需猜测，is_demo 标记和清除能力也不会限制账号存续期间的访问。

## 发生可能性

原栏标注 High（高），正文最终校准为中。账号存在后，只需简单远程已知凭据登录，不需要暴力破解或事先认证，文档也支持公网部署。但最高权限管理员必须主动在 MariaDB 执行开发模式导入，界面要求确认，后续可以清除，已有用户名冲突还可能改变结果，因此降低为中。这些前提有实质意义但现实可行，并非不可达攻击链。攻击向量为远程网络。

## 影响程度

高。攻击者取得实例级教师权限，而不是只能访问演示记录。角色读写权限和 null 角色移除正式考试范围限制，可以泄露可识别答卷和未发布记录，修改考试元数据及判分数据。影响跨越他人身份和学校记录，不是仅影响本人。

## 假设条件

- 高权限管理员在 MariaDB 上运行导入。
- 服务通过文档中的 HTTPS 代理或 Cloudflare，可供潜在用户访问。
- demo-teacher 不存在会使 INSERT IGNORE 保留不同凭据的冲突。
- 默认认证保持开启；关闭认证只会使固定凭据变得不必要，不会缓解广泛暴露。

原文另列前提：

- 管理员主动 POST 导入。
- 使用新支持的 MariaDB。
- 演示账号处于活动状态，尚未通过 clear-demo 清除。
- 登录接口网络可达。
- 不存在不兼容的同名账号冲突。

## 控制措施

- 导入要求认证、USER_MANAGE 和 SYSTEM_MANAGE。
- 只在管理员开发者子菜单中可见，并要求确认。
- 登录检查 bcrypt 和活动状态。
- 登录限制为每 15 分钟每 IP 60 次、每账号 10 次。
- 普通 API 默认要求认证并检查角色。
- 待改密账号被阻止访问普通 API。
- 使用 is_demo 标记，管理员可以清除。
- 127.0.0.1 服务由文档中的代理或隧道暴露。
- 响应警告不要在生产使用可预测凭据，但警告在创建后才出现。

## 盲点

- 没有 MariaDB 服务器或容器运行时，共享 HTTP、认证、角色权限、范围及修改路径只在 SQLite 上执行。
- MariaDB 行为通过拒绝逻辑移除、适配器、INSERT IGNORE 和默认值静态确认，没有动态完成所有支持版本的种子写入。
- 文档支持公网模式，不证明某个具体实例当前公开。
- 不知道生产 MariaDB 管理员使用开发导入的频率。
- INSERT IGNORE 可能保留已有 demo-teacher，利用取决于最终账号状态。

## 证据代码

文件名后的数字是该片段在报告所关联提交中的首行行号；不连续的片段分别列出。

### [src/apps/answer-card/server/middleware.ts:49](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/274b2823616075d9f5a70037e6ac429e2c47570e/src/apps/answer-card/server/middleware.ts#L49)

~~~~typescript
/**
 * Returns the set of exam IDs visible to the current teacher.
 * - admin / grade_leader → null (all visible)
 * - head_teacher → own classes + created exams
 * - subject_teacher → own subject + classes + created exams
 * - plain teacher (no teacher_role) → null (back-compat)
 *
 * #178 双模式：quiz（晨测）考试对教师全量可见（放开精细权限），
 * formal（大考）继续按 teacher_role + teacher_permissions 精细过滤。
 */
export async function getVisibleExamIds(user: express.Request["user"]): Promise<number[] | null> {
  if (!user || user.role_name === "admin") return null;
  if (user.role_name !== "teacher") return null;
  if (!user.teacher_role) return null; // plain teacher: all visible (back-compat)
~~~~

### [src/server/auth/permissions.ts:63](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/274b2823616075d9f5a70037e6ac429e2c47570e/src/server/auth/permissions.ts#L63)

~~~~typescript
/**
 * 角色 → 默认权限映射。
 */
export const DEFAULT_ROLE_PERMISSIONS: Record<string, string[]> = {
  admin: ["*"],
  teacher: [
    PERMISSIONS.CARD_READ,
    PERMISSIONS.CARD_WRITE,
    PERMISSIONS.EXAM_READ,
    PERMISSIONS.EXAM_WRITE,
    PERMISSIONS.GRADE_READ,
    PERMISSIONS.GRADE_WRITE
  ],
~~~~

### [src/server/db/schema.mariadb.sql:31](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/274b2823616075d9f5a70037e6ac429e2c47570e/src/server/db/schema.mariadb.sql#L31)

~~~~sql
CREATE TABLE IF NOT EXISTS users (
    id               INT AUTO_INCREMENT PRIMARY KEY,
    username         VARCHAR(100) NOT NULL UNIQUE,
    password_hash    VARCHAR(255) NOT NULL,
    name             VARCHAR(100) NOT NULL,
    role_id          INT NOT NULL,
    student_number   VARCHAR(50) UNIQUE,
    track            VARCHAR(20),                 -- 文理分科：arts 文科 / science 理科（仅学生，Issue #177）
    subject          VARCHAR(50),
    initial_password VARCHAR(255),
    score_display_mode VARCHAR(20) DEFAULT 'zscore',
    review_confidence_threshold DOUBLE DEFAULT 0.12,
    ai_api_key       TEXT,
    background_opacity DOUBLE DEFAULT 0,
    email            VARCHAR(255),
    phone            VARCHAR(50),
    teacher_role     VARCHAR(50),
    password_change_required TINYINT DEFAULT 0,
    -- v9: 原卷偏好
    require_original_paper TINYINT DEFAULT 1,
    highlight_missing_paper TINYINT DEFAULT 1,
    is_active        TINYINT DEFAULT 1,
    show_tab_bar     TINYINT DEFAULT 0,             -- v1.9.0: 底部导航栏开关
    theme_skin       VARCHAR(32) DEFAULT 'paper-edge', -- v2.1.0: 前端皮肤 ID；v2.3.0 默认改为 'paper-edge'（纸锋；'flat'=明澈 可选）
    is_demo          TINYINT NOT NULL DEFAULT 0,     -- v1.9.6: 1=演示数据（clearDemoData 仅按此标记清理）
~~~~

### [src/server/routes/backup.ts:293](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/274b2823616075d9f5a70037e6ac429e2c47570e/src/server/routes/backup.ts#L293)

~~~~typescript
/**
 * POST /api/db/import-demo
 * 一键导入演示测试数据（「演示-」前缀，幂等，不覆盖现有数据，无需重启）
 * 支持 SQLite 与 MariaDB 双方言（DemoDataService 已双后端化）。
 *
 * 鉴权：路由级 requirePermission(USER_MANAGE) 已过滤非管理员；此路由额外要求
 * SYSTEM_MANAGE「系统维护（数据清理、归档等）」权限，作为「最高权限管理员」语义闸口。
 * 当前仅 admin（持 "*" 通配）能通过；未来若要拆分管理子角色，SYSTEM_MANAGE 可单独授予。
 */
router.post("/import-demo", requirePermission(PERMISSIONS.SYSTEM_MANAGE), async (_req: Request, res: Response) => {
  try {
    const stats = await seedDemoData();
    res.json({
      ok: true,
      message: `演示数据已重置并重新导入：${stats.exams} 场考试 / 16 名学生 / ${stats.groups} 个合集（教师 demo-teacher，密码 teacher123）。⚠️ 原有「演示-」前缀数据（含在其上完成的阅卷/改分）会被清空并更换考试 ID；演示账号凭据固定且可预测，仅限测试环境使用，请勿在生产环境导入。`,
      stats
~~~~

### [src/server/services/DemoDataService.ts:332](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/274b2823616075d9f5a70037e6ac429e2c47570e/src/server/services/DemoDataService.ts#L332)

~~~~typescript
  const teacherPasswordHash = await hashPassword("teacher123");
  const created = await db.transaction(async (tx) => {
    const gradeResult = await tx.run("INSERT INTO grades (name, sort_order, is_demo) VALUES (?, ?, 1)", "高一(演示)", 1);
    const gradeId = Number(gradeResult.lastInsertRowid);
    const class1Result = await tx.run("INSERT INTO classes (grade_id, name, sort_order, is_demo) VALUES (?, ?, ?, 1)", gradeId, "演示1班", 1);
    const class1Id = Number(class1Result.lastInsertRowid);
    const class2Result = await tx.run("INSERT INTO classes (grade_id, name, sort_order, is_demo) VALUES (?, ?, ?, 1)", gradeId, "演示2班", 2);
    const class2Id = Number(class2Result.lastInsertRowid);
    const insertTeacher = buildInsertIgnore(tx.dialect, "users", ["username", "password_hash", "name", "role_id", "subject", "is_demo"]);
    await tx.run(insertTeacher, "demo-teacher", teacherPasswordHash, "演示教师", ROLE_IDS.TEACHER, "数学", 1);
    await tx.run(insertTeacher, "demo-teacher-2", teacherPasswordHash, "演示教师乙", ROLE_IDS.TEACHER, "数学", 1);
~~~~
