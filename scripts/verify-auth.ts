/**
 * 三级账号控制系统 —— 自动化验证脚本
 * ----------------------------------------------------------------
 * 运行方式：
 *   npm install            # 首次需安装依赖（better-sqlite3 / bcryptjs）
 *   npm run verify:auth
 *
 * 该脚本会在临时数据库上端到端验证：
 *   1. 数据库初始化 + 默认管理员
 *   2. 角色权限模型（通配符、细粒度判定）
 *   3. 登录 / Token / 修改密码 / 会话吊销
 *   4. 管理员创建教师 / 学生、批量导入、改角色、禁用与启用
 *   5. 班级/年级/花名册管理
 *   6. 学生自助查分（ScoreRepository）
 *   7. 中间件 requirePermission / requireRole 的放行与拦截
 *
 * 全部用例通过则进程退出码为 0，否则为 1。
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// 必须在导入任何 db 模块前设置数据库路径（getDatabase 在模块求值期读取该变量）
const tmpDir = mkdtempSync(path.join(tmpdir(), "projectx-verify-"));
process.env.PROJECTX_DB_PATH = path.join(tmpDir, "verify.db");
// 验证脚本固定使用临时 SQLite，避免 cloud.env 中的 MariaDB 变量干扰
delete process.env.PROJECTX_MARIADB_HOST;
delete process.env.PROJECTX_MARIADB_PORT;
delete process.env.PROJECTX_MARIADB_USER;
delete process.env.PROJECTX_MARIADB_PASSWORD;
delete process.env.PROJECTX_MARIADB_DATABASE;
delete process.env.PROJECTX_MYSQL_HOST;

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(cond: boolean, label: string): void {
  if (cond) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  \x1b[31m✗\x1b[0m ${label}`);
  }
}

function section(title: string): void {
  console.log(`\n\x1b[36m== ${title} ==\x1b[0m`);
}

/** 用假的 req/res 调用中间件，返回 { status, body, passed(是否 next 放行) }。 */
async function runMiddleware(
  mw: (req: any, res: any, next: any) => void,
  user: any
): Promise<{ status: number | null; body: any; allowed: boolean }> {
  return new Promise((resolve) => {
    let status: number | null = null;
    let body: any = null;
    let allowed = false;
    const req: any = { user, headers: {}, query: {}, method: "GET" };
    const res: any = {
      status(code: number) {
        status = code;
        return res;
      },
      json(payload: any) {
        body = payload;
        resolve({ status, body, allowed });
      }
    };
    mw(req, res, () => {
      allowed = true;
      resolve({ status, body, allowed });
    });
  });
}

async function main(): Promise<void> {
  console.log(`使用临时数据库: ${process.env.PROJECTX_DB_PATH}`);

  const { initializeDatabase, ensureDefaultAdmin, getDatabase, closeDatabase } = await import(
    "../src/server/db/index"
  );
  const { AuthService } = await import("../src/server/services/AuthService");
  const { UserRepository } = await import("../src/server/repositories/UserRepository");
  const { ClassRepository } = await import("../src/server/repositories/ClassRepository");
  const { ScoreRepository } = await import("../src/server/repositories/ScoreRepository");
  const { AnalysisRepository } = await import("../src/server/repositories/AnalysisRepository");
  const { requirePermission, requireRole } = await import("../src/server/middleware/auth");
  const { requireExamAccess, getVisibleExamIds, canGradeBlock, hasViewPermission, hasGroupViewPermission } = await import(
    "../src/apps/answer-card/server/middleware"
  );
  const perms = await import("../src/server/auth/permissions");
  const { PERMISSIONS, ROLE_IDS, roleHasPermission, permissionsForRole, loadRolePermissions } = perms;

  // ── 1. 初始化 ─────────────────────────────────────────
  section("1. 数据库初始化与默认管理员");
  initializeDatabase();
  const bootstrap = await ensureDefaultAdmin();
  loadRolePermissions(true);
  const db = getDatabase();
  const roleCount = (db.prepare("SELECT COUNT(*) c FROM roles").get() as { c: number }).c;
  ok(roleCount === 3, `内置 3 个角色（实际 ${roleCount}）`);
  const adminRow = db.prepare("SELECT * FROM users WHERE username = 'admin'").get() as any;
  ok(Boolean(adminRow) && adminRow.role_id === ROLE_IDS.ADMIN, "默认管理员 admin 已创建且角色为 admin");

  // ── 2. 权限模型 ───────────────────────────────────────
  section("2. 角色权限模型");
  ok(roleHasPermission(ROLE_IDS.ADMIN, PERMISSIONS.USER_MANAGE), "管理员(*)拥有 user:manage");
  ok(roleHasPermission(ROLE_IDS.ADMIN, "any:thing"), "管理员(*)匹配任意权限");
  ok(roleHasPermission(ROLE_IDS.TEACHER, PERMISSIONS.CARD_WRITE), "教师拥有 card:write");
  ok(!roleHasPermission(ROLE_IDS.TEACHER, PERMISSIONS.USER_MANAGE), "教师不具备 user:manage");
  ok(roleHasPermission(ROLE_IDS.STUDENT, PERMISSIONS.SCORE_READ), "学生拥有 score:read");
  ok(!roleHasPermission(ROLE_IDS.STUDENT, PERMISSIONS.CARD_READ), "学生不具备 card:read");
  ok(permissionsForRole(ROLE_IDS.STUDENT).length === 1, "学生权限集合仅含 1 项");

  // ── 3. 登录 / Token / 改密 ────────────────────────────
  section("3. 登录 / Token / 修改密码");
  const auth = new AuthService();
  const badLogin = await auth.login("admin", "wrong-password");
  ok(!badLogin.success, "错误密码登录被拒绝");
  const bootstrapPassword = readFileSync(bootstrap.passwordFile, "utf8").trim();
  const adminLogin = await auth.login("admin", bootstrapPassword);
  ok(adminLogin.success && Boolean(adminLogin.token), "管理员使用一次性引导密码登录成功");
  ok(JSON.stringify(adminLogin.permissions) === JSON.stringify(["*"]), "登录响应携带权限 ['*']");
  const sessionUser = await auth.getUserByToken(adminLogin.token!);
  ok(sessionUser?.username === "admin", "Token 可换取当前用户");

  const userRepo = new UserRepository();

  // ── 4. 用户管理 ───────────────────────────────────────
  section("4. 管理员创建/管理教师与学生");
  const teacher = await userRepo.createUser({
    username: "t1001",
    password: "teach123",
    name: "王老师",
    role_id: ROLE_IDS.TEACHER
  });
  ok(teacher.role_name === "teacher", "创建教师账号成功");

  const student = await userRepo.createUser({
    username: "20260001",
    password: "20260001",
    name: "张三",
    role_id: ROLE_IDS.STUDENT,
    student_number: "20260001"
  });
  ok(student.role_name === "student", "创建学生账号成功");

  const stuLogin = await auth.login("20260001", "20260001");
  ok(stuLogin.success, "学生用学号登录成功");

  // 批量导入学生
  const batch = await userRepo.batchCreateStudents([
    { username: "20260002", name: "李四", student_number: "20260002" },
    { username: "20260003", name: "王五", student_number: "20260003" },
    { username: "20260001", name: "重复", student_number: "20260001" } // 重复应跳过
  ]);
  ok(batch.created === 2 && batch.skipped === 1, `批量导入：新增 ${batch.created} 跳过 ${batch.skipped}`);

  // 改密 + 会话吊销
  const changed = await auth.changePassword(student.id, "20260001", "newpass123");
  ok(changed.success, "学生修改密码成功");
  ok((await auth.getUserByToken(stuLogin.token!)) === null, "改密后旧会话被吊销");
  const reLogin = await auth.login("20260001", "newpass123");
  ok(reLogin.success, "用新密码重新登录成功");

  // 最后一名管理员保护（在 repo 层用 countByRole 模拟路由判断）
  const adminSummary = (await userRepo.countByRole()).find((r: any) => r.role_name === "admin");
  ok(adminSummary?.count === 1, "当前仅 1 名管理员（路由层将阻止其降级/禁用）");

  // 禁用与启用
  await userRepo.deactivateUser(teacher.id);
  ok(!(await userRepo.findByUsername("t1001")), "禁用后普通查询不可见");
  ok((await userRepo.findByIdIncludingInactive(teacher.id))?.is_active === 0, "管理员仍可见禁用账号");
  await userRepo.reactivateUser(teacher.id);
  ok((await userRepo.findByUsername("t1001"))?.is_active === 1, "重新启用成功");

  // ── 5. 班级 / 花名册 ──────────────────────────────────
  section("5. 年级 / 班级 / 花名册");
  const classRepo = new ClassRepository();
  const grade = await classRepo.createGrade("高一", 1);
  const klass = await classRepo.createClass(grade.id, "1班", 1);
  ok(klass.grade_name === "高一", "创建年级与班级成功");
  await classRepo.updateGrade(grade.id, "2024级");
  ok((await classRepo.findClassById(klass.id))?.grade_name === "2024级", "年级重命名同步到班级");
  const studentIds = (db.prepare("SELECT id FROM users WHERE role_id = 3").all() as Array<{ id: number }>).map(
    (r) => r.id
  );
  const added = await classRepo.addStudents(klass.id, studentIds);
  ok(added === studentIds.length, `花名册添加 ${added} 名学生`);
  ok((await classRepo.listStudents(klass.id)).length === studentIds.length, "花名册查询数量正确");
  ok(await classRepo.isStudentInClass(klass.id, student.id), "学生归属判定正确");
  await classRepo.removeStudent(klass.id, student.id);
  ok(!(await classRepo.isStudentInClass(klass.id, student.id)), "移除学生成功");
  // 学生迁移（#235）：跨班级/跨年级
  const grade2 = await classRepo.createGrade("高二", 2);
  const klass2 = await classRepo.createClass(grade2.id, "2班", 1);
  const mover = studentIds.find((sid) => sid !== student.id);
  await classRepo.moveStudent(klass.id, klass2.id, mover!);
  ok(await classRepo.isStudentInClass(klass2.id, mover!), "学生已迁移到目标班级");
  ok(!(await classRepo.isStudentInClass(klass.id, mover!)), "学生已从原班级移除");

  // ── 6. 学生自助查分 ───────────────────────────────────
  section("6. 学生自助查分");
  // 造一条考试 + 成绩（v2.4.0 起成绩默认不公布，学生端仅见 score_published=1 的考试；
  // 此处显式置 1 模拟教师完成「公布分数」动作，符合新业务规则）
  db.prepare("INSERT INTO answer_cards (id, title) VALUES ('99999999', '验证卷')").run();
  const examId = (
    db
      .prepare("INSERT INTO exams (name, card_id, subject, status, score_published) VALUES ('期中物理', '99999999', '物理', 'closed', 1)")
      .run().lastInsertRowid as number
  );
  const otherStudent = await userRepo.createUser({
    username: "20260009",
    password: "20260009",
    name: "赵六",
    role_id: ROLE_IDS.STUDENT,
    student_number: "20260009"
  });
  db.prepare(
    "INSERT INTO student_scores (exam_id, student_id, objective_score, subjective_score, total_score) VALUES (?,?,?,?,?)"
  ).run(examId, student.id, 60, 30, 90);
  db.prepare(
    "INSERT INTO student_scores (exam_id, student_id, objective_score, subjective_score, total_score) VALUES (?,?,?,?,?)"
  ).run(examId, otherStudent.id, 50, 20, 70);

  const scoreRepo = new ScoreRepository();
  const myScores = await scoreRepo.getStudentScores(student.id);
  ok(myScores.length === 1 && myScores[0].total_score === 90, "学生仅查到自己的成绩");
  ok(myScores[0].rank === 1 && myScores[0].class_size === 2, "即时排名计算正确（第1/共2）");
  ok(!(await scoreRepo.hasScore(student.id, examId + 999)), "不存在的考试返回无成绩");

  // ── 6.1 成绩分析趋势与统计 ─────────────────────────────
  section("6.1 Score analysis trend and summary");
  await classRepo.addStudents(klass.id, [student.id]);
  const extraA = await userRepo.createUser({
    username: "20260010",
    password: "20260010",
    name: "Extra A",
    role_id: ROLE_IDS.STUDENT,
    student_number: "20260010"
  });
  const extraB = await userRepo.createUser({
    username: "20260011",
    password: "20260011",
    name: "Extra B",
    role_id: ROLE_IDS.STUDENT,
    student_number: "20260011"
  });
  const trendExam1 = (
    db.prepare("INSERT INTO exams (name, card_id, subject, start_time, status) VALUES ('Trend 1', '99999999', 'TrendPhysics', '2026-01-01', 'closed')")
      .run().lastInsertRowid as number
  );
  const trendExam2 = (
    db.prepare("INSERT INTO exams (name, card_id, subject, start_time, status) VALUES ('Trend 2', '99999999', 'TrendPhysics', '2026-02-01', 'closed')")
      .run().lastInsertRowid as number
  );
  const insertScore = db.prepare(
    "INSERT INTO student_scores (exam_id, student_id, objective_score, subjective_score, total_score) VALUES (?,?,?,?,?)"
  );
  insertScore.run(trendExam1, student.id, 80, 0, 80);
  insertScore.run(trendExam1, otherStudent.id, 60, 0, 60);
  insertScore.run(trendExam2, student.id, 90, 0, 90);
  insertScore.run(trendExam2, otherStudent.id, 70, 0, 70);

  const summaryEvenExam = (
    db.prepare("INSERT INTO exams (name, card_id, subject, start_time, status) VALUES ('Summary Even', '99999999', 'TrendMath', '2026-03-01', 'closed')")
      .run().lastInsertRowid as number
  );
  insertScore.run(summaryEvenExam, student.id, 60, 0, 60);
  insertScore.run(summaryEvenExam, otherStudent.id, 70, 0, 70);
  insertScore.run(summaryEvenExam, extraA.id, 80, 0, 80);
  insertScore.run(summaryEvenExam, extraB.id, 90, 0, 90);

  const summaryOddExam = (
    db.prepare("INSERT INTO exams (name, card_id, subject, start_time, status) VALUES ('Summary Odd', '99999999', 'TrendMath', '2026-04-01', 'closed')")
      .run().lastInsertRowid as number
  );
  insertScore.run(summaryOddExam, student.id, 50, 0, 50);
  insertScore.run(summaryOddExam, otherStudent.id, 70, 0, 70);
  insertScore.run(summaryOddExam, extraA.id, 90, 0, 90);

  const analysisRepo = new AnalysisRepository();
  const trend = await analysisRepo.getScoreTrend("TrendPhysics");
  ok(trend.length === 2 && trend[0].examName === "Trend 1" && trend[1].examName === "Trend 2", "single-subject trend is ordered by exam time");
  ok(trend[0].gradeAvg === 70 && trend[1].gradeAvg === 80, "single-subject grade averages are correct");
  const classTrend = await analysisRepo.getScoreTrend("TrendPhysics", klass.id);
  ok(classTrend[0].classAvg === 80 && classTrend[0].classCount === 1, "single-subject class average filter is correct");
  const unknownTrend = await analysisRepo.getScoreTrend("TrendPhysics", 0);
  ok(unknownTrend[0].classAvg === 60 && unknownTrend[0].classCount === 1, "single-subject unknown class average filter is correct");
  const trendClasses = await analysisRepo.getExamClasses(trendExam1);
  ok(trendClasses.some((item) => item.classId === 0 && item.className === "未知班级"), "exam class list includes unknown class");
  ok((await analysisRepo.getScoreTrend("")).length === 0, "empty subject returns empty trend");
  ok((await analysisRepo.getScoreSummary(examId + 999)) === null, "score summary returns null without scores");

  const evenSummary = await analysisRepo.getScoreSummary(summaryEvenExam);
  ok(
    evenSummary?.min === 60 && evenSummary.q1 === 67.5 && evenSummary.median === 75 && evenSummary.q3 === 82.5 && evenSummary.max === 90 && evenSummary.avg === 75,
    "even-sized score summary is correct"
  );
  const oddSummary = await analysisRepo.getScoreSummary(summaryOddExam);
  ok(
    oddSummary?.min === 50 && oddSummary.q1 === 60 && oddSummary.median === 70 && oddSummary.q3 === 80 && oddSummary.max === 90 && oddSummary.avg === 70,
    "odd-sized score summary is correct"
  );
  const overviewWithSummary = await analysisRepo.getExamOverview(summaryEvenExam);
  ok(overviewWithSummary.scoreSummary?.median === 75, "exam overview includes score summary");
  const selectedClassOverview = await analysisRepo.getExamOverview(trendExam1, klass.id);
  ok(selectedClassOverview.scoreSummary?.avg === 80 && selectedClassOverview.overallScoreSummary?.avg === 70, "selected class overview keeps overall summary separate");

  const prevComparison = await analysisRepo.getPreviousExamComparison(trendExam2);
  ok(prevComparison.prevExamId === trendExam1 && prevComparison.prevExamName === "Trend 1", "previous exam comparison resolves prior exam");
  ok(prevComparison.avgScoreChange === 10 && prevComparison.passRateChange === 0, "previous exam comparison computes deltas");

  const { listReviewBlocks } = await import("../src/server/services/ReviewService");
  ok((await listReviewBlocks(trendExam1)).length === 0, "review block list empty without crops");

  // ── 6.2 首页仪表盘：最新出分（closed_at 写入点）────────────────
  section("6.2 Dashboard latest released exam (closed_at)");
  const { ExamRepository } = await import("../src/server/repositories/ExamRepository");
  const examRepo = new ExamRepository();

  const draftExamId = Number(
    db.prepare("INSERT INTO exams (name, card_id, subject, class_id, status) VALUES ('待结考', '99999999', '数学', ?, 'draft')")
      .run(klass.id).lastInsertRowid
  );
  await examRepo.updateStatus(draftExamId, "closed");
  const closedRow = db.prepare("SELECT closed_at FROM exams WHERE id = ?").get(draftExamId) as { closed_at: string | null };
  ok(Boolean(closedRow.closed_at), "updateStatus('closed') 写入 exams.closed_at");
  const firstClosedAt = closedRow.closed_at;
  await examRepo.updateStatus(draftExamId, "closed");
  const reopenedRow = db.prepare("SELECT closed_at FROM exams WHERE id = ?").get(draftExamId) as { closed_at: string | null };
  ok(reopenedRow.closed_at === firstClosedAt, "重复结考不覆盖首次出分时间");
  // 重新阅卷（grading → closed）视为新的出分：closed_at 刷新（先把 closed_at 拨回旧值以确定性验证）
  db.prepare("UPDATE exams SET closed_at = '2020-01-01 00:00:00' WHERE id = ?").run(draftExamId);
  await examRepo.updateStatus(draftExamId, "grading");
  await examRepo.updateStatus(draftExamId, "closed");
  const regradedRow = db.prepare("SELECT closed_at FROM exams WHERE id = ?").get(draftExamId) as { closed_at: string | null };
  ok(regradedRow.closed_at !== "2020-01-01 00:00:00" && Boolean(regradedRow.closed_at), "重新阅卷后再结考刷新出分时间");

  // ── 6.3 首页仪表盘：最新出分（角色可见范围）────────────────
  section("6.3 Dashboard latest released exam (role scope)");
  // 6.2 的待结考样例 closed_at=当前时间，会遮蔽本节的固定出分样例，先清理
  db.prepare("DELETE FROM exams WHERE id = ?").run(draftExamId);
  const { getDashboardData } = await import("../src/server/services/DashboardService");
  const class2 = await classRepo.createClass(grade.id, "2班", 2);

  const headTeacher = await userRepo.createUser({
    username: "t_ht", password: "ht123", name: "班主任", role_id: ROLE_IDS.TEACHER
  });
  const subjectTeacher = await userRepo.createUser({
    username: "t_st", password: "st123", name: "数学老师", role_id: ROLE_IDS.TEACHER
  });
  db.prepare("UPDATE users SET teacher_role = 'head_teacher' WHERE id = ?").run(headTeacher.id);
  db.prepare("UPDATE users SET teacher_role = 'subject_teacher', subject = '数学' WHERE id = ?").run(subjectTeacher.id);
  db.prepare("INSERT INTO teacher_classes (teacher_id, class_id, subject) VALUES (?, ?, ?)").run(headTeacher.id, klass.id, null);
  db.prepare("INSERT INTO teacher_classes (teacher_id, class_id, subject) VALUES (?, ?, ?)").run(subjectTeacher.id, klass.id, "数学");

  const insertReleased = db.prepare(
    "INSERT INTO exams (name, card_id, subject, class_id, status, closed_at) VALUES (?, '99999999', ?, ?, 'closed', ?)"
  );
  const releasePhysicsA = Number(insertReleased.run("A班物理", "物理", klass.id, "2026-07-02 09:00:00").lastInsertRowid);
  const releaseMathA = Number(insertReleased.run("A班数学", "数学", klass.id, "2026-07-01 09:00:00").lastInsertRowid);
  const releaseMathB = Number(insertReleased.run("B班数学", "数学", class2.id, "2026-07-03 09:00:00").lastInsertRowid);
  db.prepare("INSERT INTO exams (name, card_id, subject, class_id, status) VALUES ('A班英语', '99999999', '英语', ?, 'grading')")
    .run(klass.id);

  const dashAdminUser = { id: adminRow.id, role_id: ROLE_IDS.ADMIN, role_name: "admin" };
  const dashGradeLeaderUser = { id: teacher.id, role_id: ROLE_IDS.TEACHER, role_name: "teacher", teacher_role: "grade_leader", subject: null };
  const dashHeadTeacherUser = { id: headTeacher.id, role_id: ROLE_IDS.TEACHER, role_name: "teacher", teacher_role: "head_teacher", subject: null };
  const dashSubjectTeacherUser = { id: subjectTeacher.id, role_id: ROLE_IDS.TEACHER, role_name: "teacher", teacher_role: "subject_teacher", subject: "数学" };

  const adminDash = await getDashboardData(dashAdminUser);
  ok(adminDash.latestReleasedExam?.examId === releaseMathB, "管理员：最新出分=全校最新 closed（B班数学）");
  const gradeLeaderDash = await getDashboardData(dashGradeLeaderUser);
  ok(gradeLeaderDash.latestReleasedExam?.examId === releaseMathB, "年级主任：最新出分=全校最新 closed（同管理员）");
  const headDash = await getDashboardData(dashHeadTeacherUser);
  ok(headDash.latestReleasedExam?.examId === releasePhysicsA, "班主任：仅本班最新出分（A班物理）");
  const subjectDash = await getDashboardData(dashSubjectTeacherUser);
  ok(subjectDash.latestReleasedExam?.examId === releaseMathA, "科任老师：仅本人科目+班级最新出分（A班数学，排除更晚的物理）");
  ok(subjectDash.latestReleasedExam?.releasedAt === "2026-07-01 09:00:00", "科任老师：releasedAt 返回 closed_at");

  const emptyTeacher = await userRepo.createUser({
    username: "t_empty", password: "e123", name: "空老师", role_id: ROLE_IDS.TEACHER
  });
  db.prepare("UPDATE users SET teacher_role = 'subject_teacher', subject = '化学' WHERE id = ?").run(emptyTeacher.id);
  const emptyDash = await getDashboardData({ id: emptyTeacher.id, role_id: ROLE_IDS.TEACHER, role_name: "teacher", teacher_role: "subject_teacher", subject: "化学" });
  ok(emptyDash.latestReleasedExam === null, "无可见考试时 latestReleasedExam 为 null");
  ok(adminDash.stats.completedExams >= 3, "抽取后 stats 统计保持不变");

  section("7. 中间件 requirePermission / requireRole");
  const adminUser = { id: adminRow.id, role_id: ROLE_IDS.ADMIN, role_name: "admin" };
  const teacherUser = { id: teacher.id, role_id: ROLE_IDS.TEACHER, role_name: "teacher" };
  const studentUser = { id: student.id, role_id: ROLE_IDS.STUDENT, role_name: "student" };

  const userManage = requirePermission(PERMISSIONS.USER_MANAGE);
  ok((await runMiddleware(userManage, adminUser)).allowed, "管理员可访问用户管理");
  ok((await runMiddleware(userManage, teacherUser)).status === 403, "教师访问用户管理被 403");
  ok((await runMiddleware(userManage, studentUser)).status === 403, "学生访问用户管理被 403");
  ok((await runMiddleware(userManage, undefined)).status === 401, "未登录访问用户管理被 401");

  const gradeRead = requirePermission(PERMISSIONS.GRADE_READ);
  ok((await runMiddleware(gradeRead, teacherUser)).allowed, "教师可读成绩（代查）");
  ok((await runMiddleware(gradeRead, studentUser)).status === 403, "学生不可代查他人成绩");

  const classManage = requireRole("admin", "teacher");
  ok((await runMiddleware(classManage, teacherUser)).allowed, "教师可读班级（requireRole）");
  ok((await runMiddleware(classManage, studentUser)).status === 403, "学生读班级被拒绝（requireRole）");

  // 学生自助访问（天梯 / 逐题详情）：
  // GET 自己参加过的考试放行；未参加考试与写操作（改分）一律 403
  async function runExamAccess(user: any, method: string, url: string, examId: number) {
    return new Promise<{ status: number | null; allowed: boolean }>((resolve) => {
      let status: number | null = null;
      const req: any = { user, method, originalUrl: url, params: { examId: String(examId) } };
      const res: any = {
        status(code: number) { status = code; return res; },
        json() { resolve({ status, allowed: false }); }
      };
      requireExamAccess(req, res, () => resolve({ status, allowed: true }));
    });
  }
  ok(
    (await runExamAccess(studentUser, "GET", "/api/ladder/exams/" + examId, examId)).allowed,
    "学生 GET 自己参加过的考试被放行（天梯）"
  );
  ok(
    (await runExamAccess(studentUser, "GET", "/api/ladder/exams/" + (examId + 999), examId + 999)).status === 403,
    "学生 GET 未参加的考试被 403"
  );
  ok(
    (await runExamAccess(studentUser, "PUT", "/api/exams/" + examId + "/student/" + student.id + "/scores", examId)).status === 403,
    "学生写操作（改分）被 403"
  );

  // ── 8. #246 权限矩阵运行时消费 / 题块授权 / auto_delete 软删除 ──
  section("8. #246 permission matrix runtime + canGradeBlock + auto_delete visibility");
  const plainTeacherUser = { id: teacher.id, role_id: ROLE_IDS.TEACHER, role_name: "teacher", teacher_role: null, subject: null };

  // 8.1 普通教师（无 teacher_role）此前在 getVisibleExamIds 入口提前返回 null，矩阵对其完全失效
  ok((await getVisibleExamIds(plainTeacherUser)) === null, "#246 普通教师无矩阵记录 → 全可见（兼容保留）");
  db.prepare(
    "INSERT INTO teacher_permissions (teacher_id, can_view_scores, can_view_charts, can_view_students, can_grade, can_assign) VALUES (?, 0, 1, 1, 1, 1)"
  ).run(teacher.id);
  const quizExam246 = Number(
    db.prepare("INSERT INTO exams (name, card_id, subject, class_id, status, exam_mode) VALUES ('#246晨测', '99999999', '数学', ?, 'closed', 'quiz')").run(klass.id).lastInsertRowid
  );
  const plainVisible = await getVisibleExamIds(plainTeacherUser);
  ok(Array.isArray(plainVisible), "#246 普通教师存在禁止行 → 可见集合收敛为列表（不再提前返回 null）");
  ok(plainVisible != null && !plainVisible.includes(releasePhysicsA), "#246 普通教师矩阵禁止行生效：formal 考试被剔除");
  ok(plainVisible != null && plainVisible.includes(quizExam246), "#246 晨测（quiz）不受矩阵限制仍可见");

  // 8.2 can_view_charts / can_view_students 的运行时门（hasViewPermission）
  db.prepare(
    "INSERT INTO teacher_permissions (teacher_id, class_id, can_view_scores, can_view_charts, can_view_students, can_grade, can_assign) VALUES (?, ?, 1, 0, 1, 1, 1)"
  ).run(headTeacher.id, klass.id);
  ok(!(await hasViewPermission(dashHeadTeacherUser, releasePhysicsA, "can_view_charts")), "#246 班级维度关闭图表 → 匹配考试图表查看被拒");
  ok(await hasViewPermission(dashHeadTeacherUser, releasePhysicsA, "can_view_students"), "#246 学生名单未关闭 → 仍允许");
  ok(await hasViewPermission(dashAdminUser, releasePhysicsA, "can_view_charts"), "#246 管理员不受矩阵限制");

  // 8.3 canGradeBlock：已配置矩阵但未命中授权的教师不能再借「无分配记录」回退越权
  const matrixTeacher = await userRepo.createUser({ username: "t_mtx", password: "mtx123", name: "矩阵教师", role_id: ROLE_IDS.TEACHER });
  db.prepare(
    "INSERT INTO teacher_permissions (teacher_id, subject, can_view_scores, can_view_charts, can_view_students, can_grade, can_assign) VALUES (?, '化学', 1, 1, 1, 1, 1)"
  ).run(matrixTeacher.id);
  ok(!(await canGradeBlock({ id: matrixTeacher.id, role_name: "teacher" }, releaseMathB, "blk-246")), "#246 学科不匹配的矩阵教师批改未分配题块被拒（数学考试 vs 化学授权行）");
  const noGradeTeacher = await userRepo.createUser({ username: "t_nog", password: "nog123", name: "禁阅教师", role_id: ROLE_IDS.TEACHER });
  db.prepare(
    "INSERT INTO teacher_permissions (teacher_id, can_view_scores, can_view_charts, can_view_students, can_grade, can_assign) VALUES (?, 1, 1, 1, 0, 1)"
  ).run(noGradeTeacher.id);
  ok(!(await canGradeBlock({ id: noGradeTeacher.id, role_name: "teacher" }, releaseMathB, "blk-246")), "#246 can_grade=0 的全维度行不放行批改");
  const legacyTeacher = await userRepo.createUser({ username: "t_lgcy", password: "lg123", name: "旧部署教师", role_id: ROLE_IDS.TEACHER });
  ok(await canGradeBlock({ id: legacyTeacher.id, role_name: "teacher" }, releaseMathB, "blk-246"), "#246 未配置矩阵的旧部署教师仍可批改（兼容回退保留）");
  db.prepare("INSERT INTO review_assignments (exam_id, block_id, teacher_id) VALUES (?, ?, ?)").run(releaseMathB, "blk-246", matrixTeacher.id);
  ok(await canGradeBlock({ id: matrixTeacher.id, role_name: "teacher" }, releaseMathB, "blk-246"), "#246 显式分配的教师可批改");

  // 8.4 auto_delete 软删除可见性（可见集合 / 访问中间件 / 周审计 / 大考组统计）
  db.prepare("INSERT INTO exam_archives (exam_id, is_deleted, deleted_at) VALUES (?, 1, CURRENT_TIMESTAMP)").run(releaseMathA);
  const headVisibleAfter = await getVisibleExamIds(dashHeadTeacherUser);
  ok(headVisibleAfter != null && !headVisibleAfter.includes(releaseMathA), "#246 软删除考试从教师可见集合消失");
  ok((await runExamAccess(dashHeadTeacherUser, "GET", "/api/analysis/exams/" + releaseMathA, releaseMathA)).status === 404, "#246 非管理员直接访问软删除考试返回 404");
  ok((await runExamAccess(dashAdminUser, "GET", "/api/analysis/exams/" + releaseMathA, releaseMathA)).allowed, "#246 管理员仍可访问软删除考试（恢复通道）");

  const weekStart246 = "2026-07-06"; // 周一
  const softPendingQuiz = Number(db.prepare("INSERT INTO exams (name, card_id, subject, grade_id, status, exam_mode, created_at) VALUES ('#246软删未出分', '99999999', '数学', ?, 'grading', 'quiz', '2026-07-07 09:00:00')").run(grade.id).lastInsertRowid);
  db.prepare("INSERT INTO exam_archives (exam_id, is_deleted) VALUES (?, 1)").run(softPendingQuiz);
  const { WeeklyAuditService } = await import("../src/server/services/WeeklyAuditService");
  const weekly246 = new WeeklyAuditService();
  const wkCheck = await weekly246.checkWeekComplete(weekStart246);
  ok(wkCheck.complete && !wkCheck.pendingExamNames.includes("#246软删未出分"), "#246 软删除的未出分晨测不再阻塞周报发布");

  const keptQuiz = Number(db.prepare("INSERT INTO exams (name, card_id, subject, grade_id, status, exam_mode, created_at) VALUES ('#246留晨测', '99999999', '数学', ?, 'closed', 'quiz', '2026-07-08 09:00:00')").run(grade.id).lastInsertRowid);
  const softScoredQuiz = Number(db.prepare("INSERT INTO exams (name, card_id, subject, grade_id, status, exam_mode, created_at) VALUES ('#246软删有分', '99999999', '数学', ?, 'closed', 'quiz', '2026-07-09 09:00:00')").run(grade.id).lastInsertRowid);
  insertScore.run(keptQuiz, student.id, 8, 2, 10);
  insertScore.run(softScoredQuiz, student.id, 9, 1, 10);
  db.prepare("INSERT INTO exam_archives (exam_id, is_deleted) VALUES (?, 1)").run(softScoredQuiz);
  const ensured246 = await weekly246.ensureWeeklyQuizGroups(weekStart246);
  const gradeGroup246 = ensured246.find((g: { gradeId: number }) => g.gradeId === grade.id);
  ok(!!gradeGroup246, "#246 周报组已为该年级创建");
  if (gradeGroup246) {
    const memberRows246 = db.prepare("SELECT exam_id FROM exam_group_members WHERE group_id = ?").all(gradeGroup246.groupId) as Array<{ exam_id: number }>;
    const memberIds246 = memberRows246.map((m) => m.exam_id);
    ok(memberIds246.includes(keptQuiz) && !memberIds246.includes(softScoredQuiz), "#246 周报组收录留存晨测、不收录软删除晨测");
    // 组内残留软删除成员行（软删除发生在建组之后）时，统计入口同样剔除
    db.prepare("INSERT INTO exam_group_members (group_id, exam_id) VALUES (?, ?)").run(gradeGroup246.groupId, softScoredQuiz);
    const memberMap246 = await (analysisRepo as unknown as { getGroupMemberTrackMap: (gid: number) => Promise<Map<number, string>> }).getGroupMemberTrackMap(gradeGroup246.groupId);
    ok(memberMap246.has(keptQuiz) && !memberMap246.has(softScoredQuiz), "#246 大考组统计入口剔除软删除成员（即使组内残留成员行）");
  }

  // ── 9. #246 第二轮评审：编辑撤销旧授权 / 组级查看门 / 软删除组访问 / 恢复通道 ──
  section("9. #246 round-2: edit revoke / group view gates / soft-deleted group / restore");

  // 9.1 编辑权限范围按记录 ID 原地更新，旧维度授权不复残留
  const { upsertTeacherPermission, updateTeacherPermissionById } = await import("../src/server/routes/admin-permissions");
  const dbAdapter = (await import("../src/server/db")).getMysqlDb();
  const editTeacher = await userRepo.createUser({ username: "t_edit", password: "edit123", name: "编辑教师", role_id: ROLE_IDS.TEACHER });
  const editFlags = { can_view_scores: true, can_view_charts: true, can_view_students: true, can_grade: true, can_assign: true };
  await upsertTeacherPermission(dbAdapter, { teacher_id: editTeacher.id, grade_id: null, subject: "物理", class_id: null, block_id: null, ...editFlags });
  let matrixRows = db.prepare("SELECT * FROM teacher_permissions WHERE teacher_id = ?").all(editTeacher.id) as Array<Record<string, unknown>>;
  ok(matrixRows.length === 1, "#246r2 upsert 建立单条授权记录");
  const matrixRowId = Number(matrixRows[0].id);
  await updateTeacherPermissionById(dbAdapter, matrixRowId, { teacher_id: editTeacher.id, grade_id: null, subject: "生物", class_id: null, block_id: null, ...editFlags, can_view_charts: false });
  matrixRows = db.prepare("SELECT * FROM teacher_permissions WHERE teacher_id = ?").all(editTeacher.id) as Array<Record<string, unknown>>;
  ok(
    matrixRows.length === 1 && matrixRows[0].subject === "生物" && Number(matrixRows[0].can_view_charts) === 0,
    "#246r2 按记录 ID 编辑：维度与标志原地更新，旧维度授权（物理/图表=开）不复残留"
  );
  await upsertTeacherPermission(dbAdapter, { teacher_id: editTeacher.id, grade_id: null, subject: "化学", class_id: null, block_id: null, ...editFlags });
  let conflict409 = false;
  try {
    await updateTeacherPermissionById(dbAdapter, matrixRowId, { teacher_id: editTeacher.id, grade_id: null, subject: "化学", class_id: null, block_id: null, ...editFlags });
  } catch (err: any) {
    conflict409 = err?.status === 409;
  }
  ok(conflict409, "#246r2 编辑撞现有维度组合返回 409（不静默新增/保留）");
  db.prepare("DELETE FROM teacher_permissions WHERE teacher_id = ? AND subject = '化学'").run(editTeacher.id);

  // 9.2 大考组级查看门：任一有效成员考试未被 flag=1 授权覆盖即拒绝
  const insertGroup = db.prepare("INSERT INTO exam_groups (name) VALUES (?)");
  const insertGroupMember = db.prepare("INSERT INTO exam_group_members (group_id, exam_id) VALUES (?, ?)");
  const groupView246 = Number(insertGroup.run("#246r2查看门组").lastInsertRowid);
  insertGroupMember.run(groupView246, releasePhysicsA);
  insertGroupMember.run(groupView246, releaseMathB);
  ok(await hasGroupViewPermission(dashAdminUser, groupView246, "can_view_charts"), "#246r2 管理员组级查看不受限");
  ok(!(await hasGroupViewPermission(dashHeadTeacherUser, groupView246, "can_view_charts")), "#246r2 班级维度关图表：未覆盖成员（他班数学）→ 组级图表被拒");
  db.prepare(
    "INSERT INTO teacher_permissions (teacher_id, subject, can_view_scores, can_view_charts, can_view_students, can_grade, can_assign) VALUES (?, '数学', 1, 1, 1, 1, 1)"
  ).run(subjectTeacher.id);
  ok(!(await hasGroupViewPermission(dashSubjectTeacherUser, groupView246, "can_view_charts")), "#246r2 仅数学授权行：未覆盖成员（物理）→ 组级图表被拒");
  db.prepare(
    "INSERT INTO teacher_permissions (teacher_id, can_view_scores, can_view_charts, can_view_students, can_grade, can_assign) VALUES (?, 1, 1, 1, 1, 1)"
  ).run(subjectTeacher.id);
  ok(await hasGroupViewPermission(dashSubjectTeacherUser, groupView246, "can_view_charts"), "#246r2 补充全维度授权行后全部成员被覆盖 → 组级图表放行");

  // 9.3 软删除成员不再锁死整组（canReadGroup 与统计口径一致地过滤软删除成员）
  const { canReadGroup } = await import("../src/server/routes/exam-groups-helpers");
  const fakeReq = (u: unknown) => ({ user: u }) as never;
  const groupLock246 = Number(insertGroup.run("#246r2软删成员组").lastInsertRowid);
  insertGroupMember.run(groupLock246, releaseMathA);   // 已在 8.4 被软删除
  insertGroupMember.run(groupLock246, releasePhysicsA); // 班主任可见
  ok(await canReadGroup(fakeReq(dashHeadTeacherUser), groupLock246), "#246r2 组内含软删除成员：过滤后按有效成员判定，整组不再 403");
  const groupOnly246 = Number(insertGroup.run("#246r2越权成员组").lastInsertRowid);
  insertGroupMember.run(groupOnly246, releaseMathB);    // 他班考试，班主任不可见
  ok(!(await canReadGroup(fakeReq(dashHeadTeacherUser), groupOnly246)), "#246r2 有效但不可见的成员仍拒绝整组访问");

  // 9.4 软删除恢复通道（列表 + 恢复 + 审计 + 可见性回归 + 幂等）
  const { listSoftDeletedExams, restoreSoftDeletedExam } = await import("../src/server/db/cleanup");
  const softListBefore = await listSoftDeletedExams();
  ok(softListBefore.some((r) => r.examId === releaseMathA), "#246r2 软删除列表包含被清理考试");
  ok(await restoreSoftDeletedExam(releaseMathA, adminRow.id), "#246r2 恢复成功");
  ok(!(await restoreSoftDeletedExam(releaseMathA, adminRow.id)), "#246r2 重复恢复返回 false（幂等）");
  ok(
    !!db.prepare("SELECT 1 FROM entity_lifecycle_events WHERE entity_type = 'exam' AND entity_id = ? AND action = 'restore'").get(String(releaseMathA)),
    "#246r2 恢复写入 entity_lifecycle_events 审计"
  );
  const visRestored = await getVisibleExamIds(dashHeadTeacherUser);
  ok(visRestored != null && visRestored.includes(releaseMathA), "#246r2 恢复后教师可见集合重新包含该考试");
  ok((await listSoftDeletedExams()).every((r) => r.examId !== releaseMathA), "#246r2 软删除列表不再包含已恢复考试");

  closeDatabase();
}

main()
  .then(() => {
    console.log(`\n────────────────────────────────────────`);
    console.log(`结果：\x1b[32m${passed} 通过\x1b[0m，\x1b[31m${failed} 失败\x1b[0m`);
    if (failed > 0) {
      console.log("失败用例：\n  - " + failures.join("\n  - "));
    }
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    process.exit(failed > 0 ? 1 : 0);
  })
  .catch((err) => {
    console.error("\n\x1b[31m验证脚本异常：\x1b[0m", err);
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    process.exit(1);
  });
