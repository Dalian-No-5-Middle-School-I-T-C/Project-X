import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { CombinedGradingRow } from "../src/shared/types";

const tempDir = mkdtempSync(path.join(tmpdir(), "projectx-security-critical-"));
process.env.PROJECTX_DB_PATH = path.join(tempDir, "projectx.db");
process.env.ANSWER_CARD_DATA_DIR = path.join(tempDir, "data");
process.env.USERPROFILE = path.join(tempDir, "home");
process.env.PROJECTX_AUTH_ENFORCE = "1";
process.env.PROJECTX_ENABLE_SCANNER = "false";
process.env.PROJECTX_ENABLE_SCANNER_CLIENT_API = "true";
for (const key of [
  "PROJECTX_MARIADB_HOST", "PROJECTX_MARIADB_PORT", "PROJECTX_MARIADB_USER",
  "PROJECTX_MARIADB_PASSWORD", "PROJECTX_MARIADB_DATABASE", "PROJECTX_MYSQL_HOST"
]) delete process.env[key];

let passed = 0;
const failures: string[] = [];

function check(condition: unknown, label: string): void {
  if (condition) {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failures.push(label);
    console.log(`  \x1b[31m✗\x1b[0m ${label}`);
  }
}

function section(label: string): void {
  console.log(`\n\x1b[36m== ${label} ==\x1b[0m`);
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function gradingRow(fileName: string, studentId: string | null, status: "ok" | "failed" = "ok"): CombinedGradingRow {
  return {
    fileName,
    studentId,
    recognitionStatus: status,
    score: status === "ok" ? 8 : 0,
    maxScore: 10,
    needsReviewCount: 0,
    issueCount: status === "ok" ? 0 : 1,
    questions: status === "ok" ? [{
      questionNumber: 1,
      selectedOptions: ["A"],
      correctOptions: ["A"],
      score: 8,
      maxScore: 10,
      confidence: 0.99,
      status: "correct",
      needsReview: false
    }] : [],
    objectiveScore: status === "ok" ? 8 : 0,
    objectiveMaxScore: 10,
    subjectiveScore: 0,
    subjectiveMaxScore: 0,
    totalScore: status === "ok" ? 8 : 0,
    totalMaxScore: 10,
    subjectiveQuestions: [],
    recognition: {
      status,
      cardId: "critical-card",
      questions: [],
      subjectiveQuestions: []
    }
  };
}

async function middlewareResult(
  middleware: (req: any, res: any, next: (error?: unknown) => void) => unknown,
  headers: Record<string, string>
): Promise<{ status: number | null; body: any; allowed: boolean }> {
  return new Promise((resolve, reject) => {
    let status: number | null = null;
    const req = { headers, query: {}, method: "POST", originalUrl: "/api/scanner/upload/sessions" };
    const res: any = {
      headersSent: false,
      status(code: number) { status = code; return res; },
      json(body: unknown) { res.headersSent = true; resolve({ status, body, allowed: false }); return res; }
    };
    Promise.resolve(middleware(req, res, (error?: unknown) => {
      if (error) reject(error);
      else resolve({ status, body: null, allowed: true });
    })).catch(reject);
  });
}

async function main(): Promise<void> {
  let server: Server | undefined;
  const {
    initializeDatabase, ensureDefaultAdmin, getBootstrapAdminPath, getDatabase,
    closeDatabase, hashPassword, verifyPassword
  } = await import("../src/server/db/index");
  const { createApp, persistGradingResults } = await import("../src/apps/answer-card/server/index");
  const { authService } = await import("../src/server/services/AuthService");
  const { UserRepository } = await import("../src/server/repositories/UserRepository");
  const { AssignedScoreService } = await import("../src/server/services/AssignedScoreService");
  const { dualAuth } = await import("../src/server/middleware/scanner-auth");

  try {
    initializeDatabase();
    const db = getDatabase();

    section("管理员安全初始化");
    const firstBootstrap = await ensureDefaultAdmin();
    const firstPassword = readFileSync(firstBootstrap.passwordFile, "utf8").trim();
    check(firstPassword.length >= 32 && firstPassword !== "admin123", "新库生成高熵一次性密码且不使用 admin123");
    check(existsSync(getBootstrapAdminPath()), "一次性密码写入数据库同目录");
    const initialAdmin = db.prepare("SELECT password_change_required FROM users WHERE username='admin'").get() as { password_change_required: number };
    check(initialAdmin.password_change_required === 1, "新管理员被标记为强制改密");

    db.prepare("UPDATE users SET password_hash=?, password_change_required=0 WHERE username='admin'").run(await hashPassword("admin123"));
    rmSync(getBootstrapAdminPath(), { force: true });
    const legacyRotation = await ensureDefaultAdmin();
    const rotatedPassword = readFileSync(legacyRotation.passwordFile, "utf8").trim();
    const rotatedHash = (db.prepare("SELECT password_hash FROM users WHERE username='admin'").get() as { password_hash: string }).password_hash;
    check(!(await verifyPassword("admin123", rotatedHash)) && await verifyPassword(rotatedPassword, rotatedHash), "旧 admin123 启动时自动轮换");

    rmSync(legacyRotation.passwordFile, { force: true });
    const recoveredBootstrap = await ensureDefaultAdmin();
    const recoveredPassword = readFileSync(recoveredBootstrap.passwordFile, "utf8").trim();
    const recoveredHash = (db.prepare("SELECT password_hash FROM users WHERE username='admin'").get() as { password_hash: string }).password_hash;
    check(recoveredPassword !== rotatedPassword && await verifyPassword(recoveredPassword, recoveredHash), "强制改密状态下引导文件丢失可安全恢复");

    const app = await createApp();
    server = app.listen(0);
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    section("远程扫描客户端接入模式");
    const scannerOrigin = "http://127.0.0.1:53147";
    const scannerHealth = await fetch(`${base}/api/app/health`, {
      headers: { Origin: scannerOrigin }
    });
    const scannerHealthBody = await scannerHealth.json() as {
      capabilities?: { scannerClientApi?: boolean; nativeScannerApi?: boolean };
    };
    check(
      scannerHealth.status === 200
        && scannerHealth.headers.get("access-control-allow-origin") === scannerOrigin
        && scannerHealthBody.capabilities?.scannerClientApi === true
        && scannerHealthBody.capabilities?.nativeScannerApi === false,
      "扫描客户端模式允许动态环回端口且不启用服务端 TWAIN"
    );
    const untrustedOriginHealth = await fetch(`${base}/api/app/health`, {
      headers: { Origin: "https://untrusted.example" }
    });
    check(
      untrustedOriginHealth.headers.get("access-control-allow-origin") === null,
      "扫描客户端模式不放行非白名单公网来源"
    );
    const scannerPreflight = await fetch(`${base}/api/scanner/upload/sessions`, {
      method: "OPTIONS",
      headers: {
        Origin: scannerOrigin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,x-api-key"
      }
    });
    check(
      scannerPreflight.status === 204
        && scannerPreflight.headers.get("access-control-allow-origin") === scannerOrigin,
      "扫描上传 API 预检请求通过"
    );

    const bootstrapLogin = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "admin", password: recoveredPassword })
    });
    const bootstrapBody = await bootstrapLogin.json() as { token: string; passwordChangeRequired: boolean };
    check(bootstrapLogin.status === 200 && bootstrapBody.passwordChangeRequired, "登录响应返回 passwordChangeRequired=true");
    const badTypeLogin = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: 12345, password: "x" })
    });
    check(badTypeLogin.status === 400, "非字符串 identifier 登录请求被 400 拒绝");
    const meResponse = await fetch(`${base}/api/auth/me`, { headers: authHeaders(bootstrapBody.token) });
    const meBody = await meResponse.json() as { passwordChangeRequired?: boolean };
    check(meResponse.status === 200 && meBody.passwordChangeRequired === true, "/api/auth/me 返回强制改密状态");
    const forcedBlocked = await fetch(`${base}/api/cards`, { headers: authHeaders(bootstrapBody.token) });
    const forcedBlockedBody = await forcedBlocked.json() as { code?: string };
    check(forcedBlocked.status === 428 && forcedBlockedBody.code === "PASSWORD_CHANGE_REQUIRED", "强制改密会话访问业务 API 被 428 拒绝");
    const changed = await fetch(`${base}/api/auth/change-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(bootstrapBody.token) },
      body: JSON.stringify({ oldPassword: recoveredPassword, newPassword: "CriticalAdmin-2026!" })
    });
    check(changed.status === 200 && !existsSync(getBootstrapAdminPath()), "改密成功后清除强制标记和引导文件");
    const staleSession = await fetch(`${base}/api/auth/me`, { headers: authHeaders(bootstrapBody.token) });
    check(staleSession.status === 401, "改密后旧管理员会话失效");
    const adminLogin = await authService.login("admin", "CriticalAdmin-2026!");
    const adminToken = adminLogin.token!;

    section("扫描双认证");
    const users = new UserRepository();
    const teacher = await users.createUser({ username: "critical-teacher", password: "teacher-pass", name: "教师", role_id: 2, teacher_role: "subject_teacher", subject: "数学" });
    const leader = await users.createUser({ username: "critical-leader", password: "leader-pass", name: "年级组长", role_id: 2, teacher_role: "grade_leader" });
    const student = await users.createUser({ username: "critical-student", password: "student-pass", name: "学生", role_id: 3, student_number: "S1001" });
    const rollbackStudent = await users.createUser({ username: "rollback-student", password: "student-pass", name: "回滚学生", role_id: 3, student_number: "S1002" });
    const teacherToken = (await authService.login(teacher.username, "teacher-pass")).token!;
    const leaderToken = (await authService.login(leader.username, "leader-pass")).token!;
    const studentToken = (await authService.login(student.username, "student-pass")).token!;
    db.prepare("INSERT INTO api_keys (name, api_key, scope, is_active) VALUES (?,?,?,1)").run("scanner", "key-scanner", "scanner");
    db.prepare("INSERT INTO api_keys (name, api_key, scope, is_active) VALUES (?,?,?,1)").run("full", "key-full", "full");
    db.prepare("INSERT INTO api_keys (name, api_key, scope, is_active) VALUES (?,?,?,1)").run("wrong", "key-wrong", "read");
    check((await middlewareResult(dualAuth, { "x-api-key": "key-scanner" })).allowed, "有效 scanner Key 可访问");
    check((await middlewareResult(dualAuth, { "x-api-key": "key-full" })).allowed, "有效 full Key 可访问");
    check((await middlewareResult(dualAuth, { authorization: `Bearer ${teacherToken}` })).allowed, "具备 grade:write 的教师 JWT 可访问");
    check((await middlewareResult(dualAuth, { authorization: `Bearer ${studentToken}` })).status === 403, "学生 JWT 无 Key 返回 403");
    check((await middlewareResult(dualAuth, { authorization: `Bearer ${teacherToken}`, "x-api-key": "fake-key" })).status === 401, "JWT 与伪 Key 同时存在时不回退 JWT");
    check((await middlewareResult(dualAuth, { authorization: `Bearer ${studentToken}`, "x-api-key": "fake-key" })).status === 401, "学生 JWT 加伪 Key 返回 401");
    check((await middlewareResult(dualAuth, { "x-api-key": "key-wrong" })).status === 403, "错误 scope 的 Key 返回 403");
    const remoteUploadSession = await fetch(`${base}/api/scanner/upload/sessions`, {
      method: "POST",
      headers: {
        Origin: scannerOrigin,
        "Content-Type": "application/json",
        "X-Api-Key": "key-scanner"
      },
      body: JSON.stringify({
        cardId: "critical-card",
        name: "远程扫描接入验收",
        dpi: 300,
        paperSize: "A4",
        pageCount: 1
      })
    });
    const remoteUploadBody = await remoteUploadSession.json() as {
      sessionId?: string;
      uploadTokens?: string[];
    };
    check(
      remoteUploadSession.status === 201
        && remoteUploadSession.headers.get("access-control-allow-origin") === scannerOrigin
        && remoteUploadBody.sessionId?.startsWith("scan_") === true
        && remoteUploadBody.uploadTokens?.length === 1,
      "有效 scanner Key 可从环回来源创建远程上传会话"
    );

    section("考试组权限与事务");
    let grade = db.prepare("SELECT id FROM grades ORDER BY id LIMIT 1").get() as { id: number } | undefined;
    if (!grade) {
      grade = { id: Number(db.prepare("INSERT INTO grades (name,sort_order) VALUES (?,?)").run("高一", 1).lastInsertRowid) };
    }
    const classA = Number(db.prepare("INSERT INTO classes (grade_id,name) VALUES (?,?)").run(grade.id, "安全A班").lastInsertRowid);
    const classB = Number(db.prepare("INSERT INTO classes (grade_id,name) VALUES (?,?)").run(grade.id, "安全B班").lastInsertRowid);
    db.prepare("INSERT INTO teacher_classes (teacher_id,class_id,subject) VALUES (?,?,?)").run(teacher.id, classA, "数学");
    db.prepare("INSERT INTO answer_cards (id,title,subject,subject_label) VALUES (?,?,?,?)").run("critical-card", "安全验收卡", "shuxue", "数学");
    const visibleExam = Number(db.prepare("INSERT INTO exams (name,card_id,grade_id,class_id,subject,status,created_by) VALUES (?,?,?,?,?,'active',?)").run("可见考试", "critical-card", grade.id, classA, "数学", teacher.id).lastInsertRowid);
    const hiddenExam = Number(db.prepare("INSERT INTO exams (name,card_id,grade_id,class_id,subject,status,created_by) VALUES (?,?,?,?,?,'active',?)").run("越权考试", "critical-card", grade.id, classB, "语文", leader.id).lastInsertRowid);

    async function createGroup(name: string, examIds: number[]): Promise<number> {
      const response = await fetch(`${base}/api/exam-groups`, {
        method: "POST", headers: { "Content-Type": "application/json", ...authHeaders(adminToken) },
        body: JSON.stringify({ name, examIds })
      });
      const body = await response.json() as { id: number };
      check(response.status === 201, `管理员创建考试组：${name}`);
      return body.id;
    }
    const visibleGroup = await createGroup("仅可见考试", [visibleExam]);
    await createGroup("混合考试", [visibleExam, hiddenExam]);
    await createGroup("空组", []);
    const studentGroups = await fetch(`${base}/api/exam-groups`, { headers: authHeaders(studentToken) });
    check(studentGroups.status === 403, "学生访问整个考试组接口被拒绝");
    const teacherGroups = await fetch(`${base}/api/exam-groups`, { headers: authHeaders(teacherToken) });
    const teacherGroupBody = await teacherGroups.json() as Array<{ id: number }>;
    check(teacherGroups.status === 200 && teacherGroupBody.length === 1 && teacherGroupBody[0].id === visibleGroup, "普通教师仅看到所有成员均可见的非空考试组");
    const teacherWrite = await fetch(`${base}/api/exam-groups`, {
      method: "POST", headers: { "Content-Type": "application/json", ...authHeaders(teacherToken) },
      body: JSON.stringify({ name: "教师越权组", examIds: [visibleExam] })
    });
    check(teacherWrite.status === 403, "普通教师不能创建考试组");
    const leaderWrite = await fetch(`${base}/api/exam-groups`, {
      method: "POST", headers: { "Content-Type": "application/json", ...authHeaders(leaderToken) },
      body: JSON.stringify({ name: "年级组长组", examIds: [visibleExam, hiddenExam] })
    });
    check(leaderWrite.status === 201, "年级组长可创建和关联考试组");
    const nonexistentAssociation = await fetch(`${base}/api/exam-groups/${visibleGroup}/exams`, {
      method: "POST", headers: { "Content-Type": "application/json", ...authHeaders(leaderToken) },
      body: JSON.stringify({ examIds: [visibleExam, 999999] })
    });
    const visibleMemberCount = (db.prepare("SELECT COUNT(*) count FROM exam_group_members WHERE group_id=?").get(visibleGroup) as { count: number }).count;
    check(nonexistentAssociation.status === 404 && visibleMemberCount === 1, "关联前整体校验 examIds，失败请求不产生部分写入");

    const rollbackGroup = await createGroup("回滚组", [hiddenExam]);
    db.exec(`CREATE TRIGGER critical_exam_delete_failure BEFORE DELETE ON exams WHEN OLD.id = ${hiddenExam} BEGIN SELECT RAISE(ABORT, 'forced rollback'); END;`);
    const rollbackDelete = await fetch(`${base}/api/exam-groups/${rollbackGroup}?deleteExams=1`, {
      method: "DELETE", headers: authHeaders(adminToken)
    });
    const rollbackState = db.prepare(`SELECT
      (SELECT COUNT(*) FROM exam_groups WHERE id=?) AS groups,
      (SELECT COUNT(*) FROM exam_group_members WHERE group_id=?) AS members,
      (SELECT COUNT(*) FROM exams WHERE id=?) AS exams`).get(rollbackGroup, rollbackGroup, hiddenExam) as { groups: number; members: number; exams: number };
    check(rollbackDelete.status === 500 && rollbackState.groups === 1 && rollbackState.members === 1 && rollbackState.exams === 1, "级联删除失败时组、成员和考试全部回滚");
    db.exec("DROP TRIGGER critical_exam_delete_failure");

    section("危险自定义赋分禁用");
    db.prepare("UPDATE exams SET assigned_formula=? WHERE id=?").run(JSON.stringify({ type: "custom", enabled: true, params: { expression: "process.exit()" } }), visibleExam);
    db.prepare("INSERT INTO student_scores (exam_id,student_id,total_score,assigned_score) VALUES (?,?,?,?)").run(visibleExam, student.id, 60, 77);
    const assigned = new AssignedScoreService();
    const customRaw = assigned.calculateAssignedScore(60, { type: "custom", enabled: true, params: { expression: "x*999" } }, { min: 0, max: 100, avg: 60, std: 0 });
    const customRecalc = await assigned.recalculateAll(visibleExam);
    const retainedAssigned = (db.prepare("SELECT assigned_score FROM student_scores WHERE exam_id=? AND student_id=?").get(visibleExam, student.id) as { assigned_score: number }).assigned_score;
    check(customRaw === 60 && customRecalc.updated === 0 && retainedAssigned === 77, "历史 custom 不执行、不重算且保留既有 assigned_score");
    check(assigned.calculateAssignedScore(50, { type: "proportional", enabled: true, params: { minIn: 0, maxIn: 100, minOut: 30, maxOut: 100 } }, { min: 0, max: 100, avg: 50, std: 1 }) === 65, "比例公式结果不回归");
    check(assigned.calculateAssignedScore(50, { type: "linear", enabled: true, params: { a: 0.7, b: 30 } }, { min: 0, max: 100, avg: 50, std: 1 }) === 65, "线性公式结果不回归");
    const formulaGet = await fetch(`${base}/api/exams/${visibleExam}/assigned-formula`, { headers: authHeaders(adminToken) });
    const formulaGetBody = await formulaGet.json() as { customFormulaDisabled?: boolean; presets?: Array<{ formula: { type: string } }> };
    check(formulaGetBody.customFormulaDisabled === true && !formulaGetBody.presets?.some((item) => item.formula.type === "custom"), "GET 保留历史配置但不再提供 custom 预设");
    const customPut = await fetch(`${base}/api/exams/${visibleExam}/assigned-formula`, {
      method: "PUT", headers: { "Content-Type": "application/json", ...authHeaders(adminToken) },
      body: JSON.stringify({ formula: { type: "custom", enabled: true, params: { expression: "x" } }, recalculate: true })
    });
    const customPutBody = await customPut.json() as { code?: string };
    check(customPut.status === 422 && customPutBody.code === "CUSTOM_FORMULA_DISABLED", "新增或重算 custom 返回 422 CUSTOM_FORMULA_DISABLED");

    section("阅卷完成语义与逐学生事务");
    function createExam(name: string, status = "active"): number {
      return Number(db.prepare("INSERT INTO exams (name,card_id,grade_id,class_id,subject,status,created_by) VALUES (?,?,?,?,?,?,?)")
        .run(name, "critical-card", grade.id, classA, "数学", status, teacher.id).lastInsertRowid);
    }
    const doneExam = createExam("全成功阅卷");
    const doneResult = await persistGradingResults(String(doneExam), [gradingRow("success.png", "S1001")], teacher.id);
    const doneState = db.prepare("SELECT status FROM exams WHERE id=?").get(doneExam) as { status: string };
    const doneBatch = db.prepare("SELECT status,success_count,failure_count FROM scan_batches WHERE id=?").get(doneResult.batchId) as { status: string; success_count: number; failure_count: number };
    check(doneResult.status === "done" && doneState.status === "closed" && doneBatch.status === "done" && doneBatch.success_count === 1 && doneBatch.failure_count === 0, "全部成功：批次 done、考试 closed、计数正确");

    const partialExam = createExam("单学生失败阅卷");
    db.exec(`CREATE TRIGGER critical_score_failure BEFORE INSERT ON question_scores WHEN NEW.student_id = ${rollbackStudent.id} BEGIN SELECT RAISE(ABORT, 'forced student rollback'); END;`);
    const partialResult = await persistGradingResults(String(partialExam), [
      gradingRow("kept.png", "S1001"), gradingRow("rolled-back.png", "S1002")
    ], teacher.id);
    db.exec("DROP TRIGGER critical_score_failure");
    const partialExamState = db.prepare("SELECT status FROM exams WHERE id=?").get(partialExam) as { status: string };
    const partialBatch = db.prepare("SELECT status,success_count,failure_count,error_summary FROM scan_batches WHERE id=?").get(partialResult.batchId) as { status: string; success_count: number; failure_count: number; error_summary: string };
    const keptScores = (db.prepare("SELECT COUNT(*) count FROM student_scores WHERE exam_id=?").get(partialExam) as { count: number }).count;
    const rolledBackRecords = (db.prepare("SELECT COUNT(*) count FROM scan_records WHERE batch_id=? AND student_id=?").get(partialResult.batchId, rollbackStudent.id) as { count: number }).count;
    check(partialResult.status === "partial" && partialExamState.status === "grading" && partialBatch.status === "partial", "部分成功：批次 partial、考试保持 grading");
    check(partialResult.persisted === 1 && partialResult.failedCount === 1 && keptScores === 1 && rolledBackRecords === 0, "失败学生的扫描、总分和题目分整体回滚，成功学生保留");
    check(partialResult.failed[0]?.code === "PERSISTENCE_FAILED" && Boolean(partialBatch.error_summary), "partial 返回稳定错误码并保存脱敏 error_summary");

    const errorExam = createExam("全部失败阅卷", "active");
    const errorResult = await persistGradingResults(String(errorExam), [
      gradingRow("unknown.png", "UNKNOWN"), gradingRow("recognition.png", null, "failed")
    ], teacher.id);
    const errorExamState = db.prepare("SELECT status FROM exams WHERE id=?").get(errorExam) as { status: string };
    const errorBatch = db.prepare("SELECT status,success_count,failure_count FROM scan_batches WHERE id=?").get(errorResult.batchId) as { status: string; success_count: number; failure_count: number };
    check(errorResult.status === "error" && errorResult.persisted === 0 && errorResult.failedCount === 2, "未知学生和识别失败均计入失败");
    check(errorExamState.status === "active" && errorBatch.status === "error" && errorBatch.success_count === 0 && errorBatch.failure_count === 2, "全部失败：批次 error、考试恢复调用前状态");

    console.log(`\n关键安全验收：${passed} 通过，${failures.length} 失败`);
    if (failures.length > 0) {
      for (const failure of failures) console.error(`  - ${failure}`);
      process.exitCode = 1;
    }
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    closeDatabase();
    // 等待 fire-and-forget 的「考试关闭自动备份」完成，避免与临时目录删除竞态
    // （否则会输出 AutoBackup 目录不存在的误导性错误日志）。
    await new Promise((resolve) => setTimeout(resolve, 600));
    // Windows 上备份连接可能仍占用文件句柄，仅对这种环境性 EPERM/EBUSY 告警，其余清理错误照常抛出
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EBUSY") {
        console.warn("[verify] 临时目录清理失败（Windows 句柄占用，可忽略）:", (error as Error).message);
      } else {
        throw error;
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
