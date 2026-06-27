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

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// 必须在导入任何 db 模块前设置数据库路径（getDatabase 在模块求值期读取该变量）
const tmpDir = mkdtempSync(path.join(tmpdir(), "projectx-verify-"));
process.env.PROJECTX_DB_PATH = path.join(tmpDir, "verify.db");

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
  const perms = await import("../src/server/auth/permissions");
  const { PERMISSIONS, ROLE_IDS, roleHasPermission, permissionsForRole, loadRolePermissions } = perms;

  // ── 1. 初始化 ─────────────────────────────────────────
  section("1. 数据库初始化与默认管理员");
  initializeDatabase();
  await ensureDefaultAdmin();
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
  const adminLogin = await auth.login("admin", "admin123");
  ok(adminLogin.success && Boolean(adminLogin.token), "管理员正确密码登录成功");
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
  ok(auth.getUserByToken(stuLogin.token!) === null, "改密后旧会话被吊销");
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
  const studentIds = (db.prepare("SELECT id FROM users WHERE role_id = 3").all() as Array<{ id: number }>).map(
    (r) => r.id
  );
  const added = await classRepo.addStudents(klass.id, studentIds);
  ok(added === studentIds.length, `花名册添加 ${added} 名学生`);
  ok((await classRepo.listStudents(klass.id)).length === studentIds.length, "花名册查询数量正确");
  ok(await classRepo.isStudentInClass(klass.id, student.id), "学生归属判定正确");
  await classRepo.removeStudent(klass.id, student.id);
  ok(!(await classRepo.isStudentInClass(klass.id, student.id)), "移除学生成功");

  // ── 6. 学生自助查分 ───────────────────────────────────
  section("6. 学生自助查分");
  // 造一条考试 + 成绩
  db.prepare("INSERT INTO answer_cards (id, title) VALUES ('99999999', '验证卷')").run();
  const examId = (
    db
      .prepare("INSERT INTO exams (name, card_id, subject, status) VALUES ('期中物理', '99999999', '物理', 'closed')")
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
  ok(await analysisRepo.getScoreSummary(examId + 999) === null, "score summary returns null without scores");

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
