import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { CombinedGradingRow, StudentTrendPoint } from "../src/shared/types";

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
    check(firstPassword === "admin123", "新库使用固定初始密码 admin123");
    check(existsSync(getBootstrapAdminPath()), "初始密码写入数据库同目录引导文件");
    const initialAdmin = db.prepare("SELECT password_change_required FROM users WHERE username='admin'").get() as { password_change_required: number };
    check(initialAdmin.password_change_required === 1, "新管理员被标记为强制改密");

    // 存量库迁移：停留在强制改密引导态的旧随机密码（含引导文件丢失）→ 启动时重置为固定初始密码
    db.prepare("UPDATE users SET password_hash=?, password_change_required=1 WHERE username='admin'").run(await hashPassword("Legacy-Random-Pw"));
    rmSync(getBootstrapAdminPath(), { force: true });
    const recoveredBootstrap = await ensureDefaultAdmin();
    const recoveredPassword = readFileSync(recoveredBootstrap.passwordFile, "utf8").trim();
    const recoveredHash = (db.prepare("SELECT password_hash FROM users WHERE username='admin'").get() as { password_hash: string }).password_hash;
    check(
      recoveredBootstrap.rotated && recoveredPassword === "admin123"
        && (db.prepare("SELECT password_change_required FROM users WHERE username='admin'").get() as { password_change_required: number }).password_change_required === 1
        && await verifyPassword("admin123", recoveredHash),
      "强制改密状态的存量库启动时重置为固定初始密码"
    );

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
        && scannerHealth.headers.get("x-content-type-options") === "nosniff"
        && scannerHealth.headers.get("referrer-policy") === "no-referrer"
        && scannerHealthBody.capabilities?.scannerClientApi === true
        && scannerHealthBody.capabilities?.nativeScannerApi === false,
      "扫描客户端模式允许动态环回端口且不启用服务端 TWAIN"
    );
    const csp = scannerHealth.headers.get("content-security-policy") ?? "";
    check(
      csp.includes("default-src 'self'") && csp.includes("connect-src 'self' http: https:"),
      "CSP 保持 default-src 'self' 并显式放行 connect-src http/https（扫描远程上传/跨域部署不被阻断）"
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
        && scannerPreflight.headers.get("access-control-allow-origin") === scannerOrigin
        && scannerPreflight.headers.get("x-content-type-options") === "nosniff"
        && scannerPreflight.headers.get("referrer-policy") === "no-referrer",
      "扫描上传 API 预检请求通过且携带安全响应头"
    );

    const bootstrapLogin = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "admin", password: recoveredPassword })
    });
    const bootstrapBody = await bootstrapLogin.json() as { token: string; passwordChangeRequired: boolean };
    check(bootstrapLogin.status === 200 && bootstrapBody.passwordChangeRequired === true, "固定初始密码登录后强制改密");
    const badTypeLogin = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: 12345, password: "x" })
    });
    check(badTypeLogin.status === 400, "非字符串 identifier 登录请求被 400 拒绝");
    const noBodyLogin = await fetch(`${base}/api/auth/login`, { method: "POST" });
    check(noBodyLogin.status === 400, "无请求体登录请求被 400 拒绝");
    const emptyBodyLogin = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    check(emptyBodyLogin.status === 400, "空请求体登录请求被 400 拒绝");
    const badPasswordLogin = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "admin", password: 123 })
    });
    check(badPasswordLogin.status === 400, "非字符串 password 登录请求被 400 拒绝");
    const badJsonLogin = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: "{"
    });
    const badJsonBody = await badJsonLogin.json() as { code?: string };
    check(
      badJsonLogin.status === 400 && badJsonBody.code === "INVALID_JSON"
        && badJsonLogin.headers.get("x-content-type-options") === "nosniff"
        && badJsonLogin.headers.get("referrer-policy") === "no-referrer",
      "非法 JSON 返回 400 INVALID_JSON 且携带安全响应头"
    );
    const oversized = await fetch(`${base}/api/review/exams/1/block-crops/1/submit`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: "x".repeat(70 * 1024) })
    });
    check(
      oversized.status === 413
        && oversized.headers.get("x-content-type-options") === "nosniff"
        && oversized.headers.get("referrer-policy") === "no-referrer",
      "请求体超限返回 413 且携带安全响应头"
    );
    const meResponse = await fetch(`${base}/api/auth/me`, { headers: authHeaders(bootstrapBody.token) });
    const meBody = await meResponse.json() as { passwordChangeRequired?: boolean };
    check(meResponse.status === 200 && meBody.passwordChangeRequired === true, "/api/auth/me 返回强制改密状态");
    const cardsBlocked = await fetch(`${base}/api/cards`, { headers: authHeaders(bootstrapBody.token) });
    const cardsBlockedBody = await cardsBlocked.json() as { code?: string };
    check(cardsBlocked.status === 428 && cardsBlockedBody.code === "PASSWORD_CHANGE_REQUIRED", "强制改密会话访问业务 API 被 428 拒绝");
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

    section("扫描原图保留期与阅卷保护");
    {
      const { runCleanup } = await import("../src/server/db/cleanup");
      const activeExam = createExam("清理保护-阅卷中", "grading");
      const closedExam = createExam("清理保护-已关闭", "closed");
      const activeBatch = Number(db.prepare("INSERT INTO scan_batches (exam_id, name) VALUES (?, 'protect-active')").run(activeExam).lastInsertRowid);
      const closedBatch = Number(db.prepare("INSERT INTO scan_batches (exam_id, name) VALUES (?, 'protect-closed')").run(closedExam).lastInsertRowid);
      const past = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
      const activeFile = path.join(tempDir, "active-scan.png");
      const closedFile = path.join(tempDir, "closed-scan.png");
      writeFileSync(activeFile, "png");
      writeFileSync(closedFile, "png");
      db.prepare("INSERT INTO scan_records (batch_id, file_path, file_name, expires_at) VALUES (?,?,?,?)").run(activeBatch, activeFile, "active.png", past);
      db.prepare("INSERT INTO scan_records (batch_id, file_path, file_name, expires_at) VALUES (?,?,?,?)").run(closedBatch, closedFile, "closed.png", past);
      await runCleanup(30);
      const activeRow = db.prepare("SELECT file_path FROM scan_records WHERE batch_id=?").get(activeBatch) as { file_path: string | null };
      const closedRow = db.prepare("SELECT file_path FROM scan_records WHERE batch_id=?").get(closedBatch) as { file_path: string | null };
      check(activeRow.file_path === activeFile && existsSync(activeFile), "阅卷中考试的过期扫描图不被清理");
      check(closedRow.file_path === null && !existsSync(closedFile), "已关闭考试的过期扫描图按保留期清理");
    }

    section("AI 任务状态隔离与越权访问");
    {
      const { createAiAnalysisJob } = await import("../src/server/services/aiAnalysisJobs");

      // #1 创建新任务不得把已在运行/排队中的既有任务误标为失败
      const runningJob = Number(db.prepare("INSERT INTO ai_analysis_jobs (exam_id,status,created_by) VALUES (?, 'running', ?)").run(visibleExam, teacher.id).lastInsertRowid);
      const queuedJob = Number(db.prepare("INSERT INTO ai_analysis_jobs (exam_id,status,created_by) VALUES (?, 'queued', ?)").run(visibleExam, teacher.id).lastInsertRowid);
      const newJobId = await createAiAnalysisJob({ examId: visibleExam, createdBy: teacher.id });
      const runningState = (db.prepare("SELECT status FROM ai_analysis_jobs WHERE id=?").get(runningJob) as { status: string }).status;
      const queuedState = (db.prepare("SELECT status FROM ai_analysis_jobs WHERE id=?").get(queuedJob) as { status: string }).status;
      check(runningState === "running" && queuedState === "queued", "创建新任务不会把运行中/排队中的既有任务误标为失败");

      // #2 任务轮询 IDOR：非创建者且考试/考试组不可见时拒绝
      const teacher2 = await users.createUser({ username: "critical-teacher2", password: "teacher-pass", name: "外班教师", role_id: 2, teacher_role: "subject_teacher", subject: "语文" });
      db.prepare("INSERT INTO teacher_classes (teacher_id,class_id,subject) VALUES (?,?,?)").run(teacher2.id, classB, "语文");
      const teacher2Token = (await authService.login(teacher2.username, "teacher-pass")).token!;
      check((await fetch(`${base}/api/analysis/ai-analysis/jobs/${newJobId}`, { headers: authHeaders(teacherToken) })).status === 200, "创建者可轮询自己的任务");
      check((await fetch(`${base}/api/analysis/ai-analysis/jobs/${newJobId}`, { headers: authHeaders(teacher2Token) })).status === 403, "对不可见考试的非创建者教师轮询返回 403");
      check((await fetch(`${base}/api/analysis/ai-analysis/jobs/${newJobId}`, { headers: authHeaders(leaderToken) })).status === 200, "年级组长（全量可见）可轮询非本人任务");
      check((await fetch(`${base}/api/analysis/ai-analysis/jobs/${newJobId}`, { headers: authHeaders(adminToken) })).status === 200, "管理员可轮询任意任务");
      check((await fetch(`${base}/api/analysis/ai-analysis/jobs/999999`, { headers: authHeaders(teacherToken) })).status === 404, "轮询不存在的任务返回 404");
      const leaderExamJob = await createAiAnalysisJob({ examId: hiddenExam, createdBy: leader.id });
      check((await fetch(`${base}/api/analysis/ai-analysis/jobs/${leaderExamJob}`, { headers: authHeaders(studentToken) })).status === 403, "未参加考试的学生轮询他人任务返回 403");
      const groupJob = await createAiAnalysisJob({ groupId: visibleGroup, createdBy: teacher.id });
      const pollGroupTeacher2 = await fetch(`${base}/api/analysis/ai-analysis/jobs/${groupJob}`, { headers: authHeaders(teacher2Token) });
      const pollGroupLeader = await fetch(`${base}/api/analysis/ai-analysis/jobs/${groupJob}`, { headers: authHeaders(leaderToken) });
      check(pollGroupTeacher2.status === 403 && pollGroupLeader.status === 200, "考试组任务按组成员可见性二次校验");
    }

    section("学生成长曲线可见范围");
    {
      // 外班学生：仅在语文/外班考试有成绩，对数学教师不可见
      const hiddenScoreStudent = await users.createUser({ username: "critical-hidden", password: "student-pass", name: "外班学生", role_id: 3, student_number: "S2001" });
      db.prepare("INSERT INTO student_scores (exam_id,student_id,total_score) VALUES (?,?,?)").run(hiddenExam, hiddenScoreStudent.id, 90);
      const leaderTrendForeign = await fetch(`${base}/api/analysis/students/${hiddenScoreStudent.id}/trend`, { headers: authHeaders(leaderToken) });
      const leaderTrendForeignBody = await leaderTrendForeign.json() as StudentTrendPoint[];
      const teacherTrendForeign = await fetch(`${base}/api/analysis/students/${hiddenScoreStudent.id}/trend`, { headers: authHeaders(teacherToken) });
      check(leaderTrendForeign.status === 200 && leaderTrendForeignBody.some((p) => p.examId === hiddenExam), "全量可见角色可读取外班学生完整曲线");
      check(teacherTrendForeign.status === 403, "仅在外班考试有成绩的学生对受限教师返回 403");

      // 本班学生：历史里既有可见考试（visibleExam / 阅卷考试）也有不可见 hiddenExam，曲线必须被裁剪
      db.prepare("INSERT INTO student_scores (exam_id,student_id,total_score) VALUES (?,?,?)").run(hiddenExam, student.id, 85);
      const teacherTrendOwn = await fetch(`${base}/api/analysis/students/${student.id}/trend`, { headers: authHeaders(teacherToken) });
      const teacherTrendOwnBody = await teacherTrendOwn.json() as StudentTrendPoint[];
      check(
        teacherTrendOwn.status === 200
          && teacherTrendOwnBody.length > 0
          && teacherTrendOwnBody.some((p) => p.examId === visibleExam)
          && !teacherTrendOwnBody.some((p) => p.examId === hiddenExam),
        "本班学生曲线只包含教师可见考试的数据（过滤掉不可见考试）"
      );
    }

    section("成绩公布门控与审计原子性");
    {
      // v48 发布完整性要求应考范围非空；本段只验证公布门控/审计，先准备最小班级名册。
      db.prepare("INSERT OR IGNORE INTO class_students (class_id, student_id) VALUES (?, ?)").run(classA, student.id);
      const seedPublishExam = (name: string, status: string, scorePublished: number): number => {
        const cardId = `pub-card-${Math.random().toString(36).slice(2, 8)}`;
        db.prepare("INSERT INTO answer_cards (id, title) VALUES (?, ?)").run(cardId, name);
        return Number(db.prepare(
          "INSERT INTO exams (name, card_id, grade_id, class_id, subject, status, score_published, created_by) VALUES (?,?,?,?,?,?,?,?)"
        ).run(name, cardId, grade.id, classA, "数学", status, scorePublished, teacher.id).lastInsertRowid);
      };
      const draftExam = seedPublishExam("公布门控-草稿", "draft", 0);
      const gradingExam = seedPublishExam("公布门控-阅卷中", "grading", 0);
      const closedExam = seedPublishExam("公布门控-已结考", "closed", 0);
      const closedExam2 = seedPublishExam("公布门控-已结考2", "closed", 0);
      for (const examId of [draftExam, gradingExam, closedExam, closedExam2]) {
        db.prepare("INSERT INTO student_scores (exam_id, student_id, objective_score, subjective_score, total_score) VALUES (?,?,?,?,?)")
          .run(examId, student.id, 40, 20, 60);
      }
      const auditCount = (examId: number): number =>
        (db.prepare("SELECT COUNT(*) AS c FROM exam_publish_events WHERE exam_id = ?").get(examId) as { c: number }).c;

      // [P1] 草稿/阅卷中考试不可公布（防提前暴露）
      const publishDraft = await fetch(`${base}/api/exams/${draftExam}/publish`, { method: "POST", headers: authHeaders(teacherToken) });
      const publishGrading = await fetch(`${base}/api/exams/${gradingExam}/publish`, { method: "POST", headers: authHeaders(teacherToken) });
      check(publishDraft.status === 409 && publishGrading.status === 409, "草稿/阅卷中考试公布被 409 拒绝");

      // 未公布时学生端完全不可见（列表 + 逐题明细）
      const meBefore = await fetch(`${base}/api/scores/me`, { headers: authHeaders(studentToken) });
      const meBeforeBody = await meBefore.json() as { scores: Array<{ exam_id: number }> };
      check(meBefore.status === 200 && !meBeforeBody.scores.some((s) => s.exam_id === closedExam), "未公布考试不出现在学生成绩列表");
      const detailBefore = await fetch(`${base}/api/scores/me/exams/${closedExam}`, { headers: authHeaders(studentToken) });
      check(detailBefore.status === 404, "未公布考试学生逐题明细 404");

      // 已结考公布：状态与审计在同一事务（[P1] 原子性）
      const publishClosed = await fetch(`${base}/api/exams/${closedExam}/publish`, { method: "POST", headers: authHeaders(teacherToken) });
      check(publishClosed.status === 200 && auditCount(closedExam) === 1, "已结考公布成功且写入 1 条审计");
      const republish = await fetch(`${base}/api/exams/${closedExam}/publish`, { method: "POST", headers: authHeaders(teacherToken) });
      check(republish.status === 200 && auditCount(closedExam) === 1, "重复公布幂等且不重复写审计");

      const meAfter = await fetch(`${base}/api/scores/me`, { headers: authHeaders(studentToken) });
      const meAfterBody = await meAfter.json() as { scores: Array<{ exam_id: number }> };
      check(meAfter.status === 200 && meAfterBody.scores.some((s) => s.exam_id === closedExam), "公布后考试出现在学生成绩列表");

      // 批量：含未结考 → 整体 409 且不写任何审计
      const auditBeforeFailBatch = auditCount(closedExam);
      const batchFail = await fetch(`${base}/api/exams/publish-batch`, {
        method: "POST", headers: { "Content-Type": "application/json", ...authHeaders(teacherToken) },
        body: JSON.stringify({ examIds: [draftExam, closedExam] })
      });
      check(batchFail.status === 409 && auditCount(closedExam) === auditBeforeFailBatch, "批量含未结考整体 409 且未写审计");

      // 批量：已公布的跳过，只处理未公布并逐场写审计
      const batchOk = await fetch(`${base}/api/exams/publish-batch`, {
        method: "POST", headers: { "Content-Type": "application/json", ...authHeaders(teacherToken) },
        body: JSON.stringify({ examIds: [closedExam, closedExam2] })
      });
      const batchOkBody = await batchOk.json() as { publishedCount: number };
      check(batchOk.status === 200 && batchOkBody.publishedCount === 1 && auditCount(closedExam2) === 1, "批量公布只处理未公布考试且逐场写审计");

      // 撤回：状态与审计原子；学生立即不可见；未公布撤回 400
      const unpublish = await fetch(`${base}/api/exams/${closedExam}/unpublish`, {
        method: "POST", headers: { "Content-Type": "application/json", ...authHeaders(teacherToken) },
        body: JSON.stringify({ reason: "成绩有误" })
      });
      check(unpublish.status === 200 && auditCount(closedExam) === 2, "撤回成功且写入审计");
      const detailAfterUnpublish = await fetch(`${base}/api/scores/me/exams/${closedExam}`, { headers: authHeaders(studentToken) });
      check(detailAfterUnpublish.status === 404, "撤回后学生逐题明细立即 404");
      const unpublishAgain = await fetch(`${base}/api/exams/${closedExam}/unpublish`, { method: "POST", headers: authHeaders(teacherToken) });
      check(unpublishAgain.status === 400, "未公布状态撤回被 400 拒绝");

      // 重新公布后触发重新阅卷：自动撤回并记审计，避免学生看到半成品
      const republishAgain = await fetch(`${base}/api/exams/${closedExam}/publish`, { method: "POST", headers: authHeaders(teacherToken) });
      check(republishAgain.status === 200 && auditCount(closedExam) === 3, "撤回后重新公布成功继续记审计");
      await persistGradingResults(String(closedExam), [], teacher.id);
      const examRow = db.prepare("SELECT status, score_published FROM exams WHERE id = ?").get(closedExam) as { status: string; score_published: number };
      const autoUnpublishAudit = db.prepare(
        "SELECT reason FROM exam_publish_events WHERE exam_id = ? AND action = 'unpublish' AND reason = '重新阅卷自动撤回'"
      ).get(closedExam);
      check(examRow.score_published === 0 && examRow.status === "closed", "重新阅卷自动撤回已公布成绩（score_published=0）");
      check(Boolean(autoUnpublishAudit), "自动撤回写入审计事件");
    }

    // ── 评审 P1：成绩发布未校验「批改完整性」——closed 但无成绩/部分成绩必须拒绝 ──
    // 统一校验「批改完成」：成绩记录为空或低于应考学生数（班级名册）时，单场与批量公布
    // 均返回 409 且不写任何审计事件；补全成绩后恢复正常公布。
    section("评审：成绩公布批改完整性校验");
    {
      const auditCount = (examId: number): number =>
        (db.prepare("SELECT COUNT(*) AS c FROM exam_publish_events WHERE exam_id = ?").get(examId) as { c: number }).c;
      const publishClass = Number(db.prepare("INSERT INTO classes (grade_id,name) VALUES (?,?)").run(grade.id, "安全C班").lastInsertRowid);
      const rosterStudent1 = await users.createUser({ username: "crit-roster1", password: "student-pass", name: "批改名单生1", role_id: 3, student_number: "S3001" });
      const rosterStudent2 = await users.createUser({ username: "crit-roster2", password: "student-pass", name: "批改名单生2", role_id: 3, student_number: "S3002" });
      db.prepare("INSERT INTO class_students (class_id,student_id) VALUES (?,?)").run(publishClass, rosterStudent1.id);
      db.prepare("INSERT INTO class_students (class_id,student_id) VALUES (?,?)").run(publishClass, rosterStudent2.id);

      const seedRosterExam = (name: string): number => {
        const cardId = `pub-card-${Math.random().toString(36).slice(2, 8)}`;
        db.prepare("INSERT INTO answer_cards (id, title) VALUES (?, ?)").run(cardId, name);
        return Number(db.prepare(
          "INSERT INTO exams (name, card_id, grade_id, class_id, subject, status, score_published, created_by) VALUES (?,?,?,?,?,'closed',0,?)"
        ).run(name, cardId, grade.id, publishClass, "数学", teacher.id).lastInsertRowid);
      };
      const noScoreExam = seedRosterExam("公布门控-P1无成绩");
      const partialScoreExam = seedRosterExam("公布门控-P1部分成绩");
      db.prepare("INSERT INTO student_scores (exam_id, student_id, objective_score, subjective_score, total_score) VALUES (?,?,?,?,?)")
        .run(partialScoreExam, rosterStudent1.id, 40, 20, 60);

      // 单场：无成绩 / 部分成绩（1/2 人）→ 409 且不写审计
      const publishNoScore = await fetch(`${base}/api/exams/${noScoreExam}/publish`, { method: "POST", headers: authHeaders(teacherToken) });
      const publishPartial = await fetch(`${base}/api/exams/${partialScoreExam}/publish`, { method: "POST", headers: authHeaders(teacherToken) });
      check(publishNoScore.status === 409 && auditCount(noScoreExam) === 0, "closed 但无成绩记录：单场公布被 409 拒绝且不写审计");
      check(publishPartial.status === 409 && auditCount(partialScoreExam) === 0, "closed 但成绩部分（1/2 人）：单场公布被 409 拒绝且不写审计");

      // 批量：含不完整考试 → 整体 409，完整考试也不被写入（无部分发布）
      const fullScoreExam = seedRosterExam("公布门控-P1完整");
      for (const sid of [rosterStudent1.id, rosterStudent2.id]) {
        db.prepare("INSERT INTO student_scores (exam_id, student_id, objective_score, subjective_score, total_score) VALUES (?,?,?,?,?)")
          .run(fullScoreExam, sid, 40, 20, 60);
      }
      const batchIncomplete = await fetch(`${base}/api/exams/publish-batch`, {
        method: "POST", headers: { "Content-Type": "application/json", ...authHeaders(teacherToken) },
        body: JSON.stringify({ examIds: [partialScoreExam, fullScoreExam] })
      });
      check(batchIncomplete.status === 409 && auditCount(partialScoreExam) === 0 && auditCount(fullScoreExam) === 0, "批量含部分成绩：整体 409 且完整考试也不被发布（无部分写入）");

      // 补全成绩后放行（回归：批改完整的考试可正常公布）
      db.prepare("INSERT INTO student_scores (exam_id, student_id, objective_score, subjective_score, total_score) VALUES (?,?,?,?,?)")
        .run(partialScoreExam, rosterStudent2.id, 30, 20, 50);
      const publishCompleted = await fetch(`${base}/api/exams/${partialScoreExam}/publish`, { method: "POST", headers: authHeaders(teacherToken) });
      check(publishCompleted.status === 200 && auditCount(partialScoreExam) === 1, "补全成绩后单场公布成功并写入审计");
    }

    // ── 评审 P1-1：发布完整性集合校验与扫描入库拒识（A/B 名册 + A/C 成绩绕过）──
    // 原逻辑只比人数（COUNT scored vs COUNT roster），外班/误识别 C 可凑数绕过 B 缺失；
    // 现改为集合校验：应考集合 ⊆ 已评分集合；扫描入库拒绝非应考学生；快照在首次入库/公布时固化。
    section("评审 P1-1：发布完整性集合校验与扫描入库拒识（A/B + A/C 绕过回归）");
    {
      const auditCnt = (examId: number): number =>
        (db.prepare("SELECT COUNT(*) AS c FROM exam_publish_events WHERE exam_id = ?").get(examId) as { c: number }).c;
      const p1Class = Number(db.prepare("INSERT INTO classes (grade_id,name) VALUES (?,?)").run(grade.id, "安全P1班").lastInsertRowid);
      const p1OtherClass = Number(db.prepare("INSERT INTO classes (grade_id,name) VALUES (?,?)").run(grade.id, "安全P1外班").lastInsertRowid);
      const p1A = await users.createUser({ username: "crit-p1-A", password: "student-pass", name: "P1-A", role_id: 3, student_number: "SP1A" });
      const p1B = await users.createUser({ username: "crit-p1-B", password: "student-pass", name: "P1-B", role_id: 3, student_number: "SP1B" });
      const p1C = await users.createUser({ username: "crit-p1-C", password: "student-pass", name: "P1-C外班", role_id: 3, student_number: "SP1C" });
      db.prepare("INSERT INTO class_students (class_id,student_id) VALUES (?,?)").run(p1Class, p1A.id);
      db.prepare("INSERT INTO class_students (class_id,student_id) VALUES (?,?)").run(p1Class, p1B.id);
      db.prepare("INSERT INTO class_students (class_id,student_id) VALUES (?,?)").run(p1OtherClass, p1C.id);
      const p1Card = `p1-card-${Math.random().toString(36).slice(2,6)}`;
      db.prepare("INSERT INTO answer_cards (id,title) VALUES (?,?)").run(p1Card, "P1绕过卡");
      const p1ExamBypass = Number(db.prepare("INSERT INTO exams (name,card_id,grade_id,class_id,subject,status,score_published,created_by) VALUES (?,?,?,?,?,'closed',0,?)").run("P1-绕过单场", p1Card, grade.id, p1Class, "数学", teacher.id).lastInsertRowid);
      db.prepare("INSERT INTO student_scores (exam_id, student_id, objective_score, subjective_score, total_score) VALUES (?,?,?,?,?)").run(p1ExamBypass, p1A.id, 40,20,60);
      db.prepare("INSERT INTO student_scores (exam_id, student_id, objective_score, subjective_score, total_score) VALUES (?,?,?,?,?)").run(p1ExamBypass, p1C.id, 30,20,50);
      const pubBypass = await fetch(`${base}/api/exams/${p1ExamBypass}/publish`, { method:"POST", headers: authHeaders(teacherToken) });
      const pubBypassBody = await pubBypass.json() as { message?: string };
      check(pubBypass.status === 409 && auditCnt(p1ExamBypass)===0 && String(pubBypassBody.message||"").includes("SP1B"), "A/C 凑数绕过：单场公布被 409 拒绝且提示缺 B");

      const p1Complete = Number(db.prepare("INSERT INTO exams (name,card_id,grade_id,class_id,subject,status,score_published,created_by) VALUES (?,?,?,?,?,'closed',0,?)").run("P1-完整", p1Card, grade.id, p1Class, "数学", teacher.id).lastInsertRowid);
      db.prepare("INSERT INTO student_scores (exam_id, student_id, objective_score, subjective_score, total_score) VALUES (?,?,?,?,?)").run(p1Complete, p1A.id, 40,20,60);
      db.prepare("INSERT INTO student_scores (exam_id, student_id, objective_score, subjective_score, total_score) VALUES (?,?,?,?,?)").run(p1Complete, p1B.id, 40,20,60);
      const batchBypass = await fetch(`${base}/api/exams/publish-batch`, { method:"POST", headers:{ "Content-Type":"application/json", ...authHeaders(teacherToken)}, body: JSON.stringify({ examIds:[p1ExamBypass, p1Complete] })});
      check(batchBypass.status === 409 && auditCnt(p1ExamBypass)===0 && auditCnt(p1Complete)===0, "A/C 凑数绕过：批量公布整体 409 且无部分写入");

      // 扫描入库拒识：persistGradingResults 对同一班级考试录入外班学生 C 应被拒绝
      const p1IngestExam = Number(db.prepare("INSERT INTO exams (name,card_id,grade_id,class_id,subject,status,score_published,created_by) VALUES (?,?,?,?,?,'active',0,?)").run("P1-入库拒识", p1Card, grade.id, p1Class, "数学", teacher.id).lastInsertRowid);
      const ingestRes = await persistGradingResults(String(p1IngestExam), [gradingRow("a.png","SP1A"), gradingRow("c.png","SP1C")], teacher.id);
      const hasCScore = (db.prepare("SELECT 1 FROM student_scores WHERE exam_id=? AND student_id=?").get(p1IngestExam, p1C.id) as any);
      check(ingestRes.persisted===1 && ingestRes.failedCount===1 && ingestRes.failed.some(f=>f.code==="STUDENT_NOT_IN_EXAM") && !hasCScore, "扫描入库拒识：外班学生 C 的入库被拒绝，仅 A 持久化");

      // 快照语义：首次入库后调班（新增 D）不应改变历史判断
      const snapClass = Number(db.prepare("INSERT INTO classes (grade_id,name) VALUES (?,?)").run(grade.id, "安全P1快照班").lastInsertRowid);
      const sSnapA = await users.createUser({ username: "crit-snap-A", password:"student-pass", name:"SnapA", role_id:3, student_number:"SSNA"});
      const sSnapB = await users.createUser({ username: "crit-snap-B", password:"student-pass", name:"SnapB", role_id:3, student_number:"SSNB"});
      const sSnapD = await users.createUser({ username: "crit-snap-D", password:"student-pass", name:"SnapD新增", role_id:3, student_number:"SSND"});
      db.prepare("INSERT INTO class_students (class_id,student_id) VALUES (?,?)").run(snapClass, sSnapA.id);
      db.prepare("INSERT INTO class_students (class_id,student_id) VALUES (?,?)").run(snapClass, sSnapB.id);
      const snapCard = `snap-card-${Math.random().toString(36).slice(2,6)}`;
      db.prepare("INSERT INTO answer_cards (id,title) VALUES (?,?)").run(snapCard, "快照卡");
      const snapExam = Number(db.prepare("INSERT INTO exams (name,card_id,grade_id,class_id,subject,status,score_published,created_by) VALUES (?,?,?,?,?,'active',0,?)").run("P1-快照", snapCard, grade.id, snapClass, "数学", teacher.id).lastInsertRowid);
      // 首次入库仅 A（固化快照为 A/B 2 人）
      const snapFirst = await persistGradingResults(String(snapExam), [gradingRow("snap-a.png","SSNA")], teacher.id);
      void snapFirst;
      // 调班：新增 D 到班级（快照应仍为 2 人，不含 D）
      db.prepare("INSERT INTO class_students (class_id,student_id) VALUES (?,?)").run(snapClass, sSnapD.id);
      const snapRows = db.prepare("SELECT COUNT(*) AS c FROM exam_participants WHERE exam_id=?").get(snapExam) as { c:number };
      check(Number(snapRows.c)===2, "快照固化：入库后调班新增不改快照（仍为 2 人）");
      // 补录 B 后应可公布（D 不要求）
      db.prepare("INSERT INTO student_scores (exam_id, student_id, objective_score, subjective_score, total_score) VALUES (?,?,?,?,?)").run(snapExam, sSnapB.id, 40,20,60);
      db.prepare("UPDATE exams SET status='closed' WHERE id=?").run(snapExam);
      const snapPublish = await fetch(`${base}/api/exams/${snapExam}/publish`, { method:"POST", headers: authHeaders(teacherToken) });
      check(snapPublish.status===200, "快照语义：补录 B 后公布成功（新增 D 不要求）");
      // 反向：调班移除后仍要求已快照学生（再建一门测试移除）
      const snap2Class = Number(db.prepare("INSERT INTO classes (grade_id,name) VALUES (?,?)").run(grade.id, "安全P1移除班").lastInsertRowid);
      const sRemA = await users.createUser({ username:"crit-rem-A", password:"student-pass", name:"RemA", role_id:3, student_number:"SRMA"});
      const sRemB = await users.createUser({ username:"crit-rem-B", password:"student-pass", name:"RemB", role_id:3, student_number:"SRMB"});
      db.prepare("INSERT INTO class_students (class_id,student_id) VALUES (?,?)").run(snap2Class, sRemA.id);
      db.prepare("INSERT INTO class_students (class_id,student_id) VALUES (?,?)").run(snap2Class, sRemB.id);
      const remCard = `rem-card-${Math.random().toString(36).slice(2,6)}`;
      db.prepare("INSERT INTO answer_cards (id,title) VALUES (?,?)").run(remCard, "移除卡");
      const remExam = Number(db.prepare("INSERT INTO exams (name,card_id,grade_id,class_id,subject,status,score_published,created_by) VALUES (?,?,?,?,?,'active',0,?)").run("P1-移除仍要求", remCard, grade.id, snap2Class, "数学", teacher.id).lastInsertRowid);
      // 首次入库固化快照（A/B 2 人）
      await persistGradingResults(String(remExam), [gradingRow("rem-a.png","SRMA")], teacher.id);
      // 调班移除 B（快照应仍保留 B）
      db.prepare("DELETE FROM class_students WHERE class_id=? AND student_id=?").run(snap2Class, sRemB.id);
      db.prepare("UPDATE exams SET status='closed' WHERE id=?").run(remExam);
      const remPublish = await fetch(`${base}/api/exams/${remExam}/publish`, { method:"POST", headers: authHeaders(teacherToken) });
      check(remPublish.status===409, "快照语义：调班移除后仍要求已固化学生（缺 B 仍 409）");
    }

    // ── 评审 P1：发布后手动改分/改答案/仲裁/网阅/赋分不会自动撤回并写审计 ──
    // 所有写分路径统一接 markScoreMutated：已公布（score_published=1）考试一有
    // 真实成绩变更 → 同一事务自动置 0 + 写 unpublish 审计（reason 标识变更来源）。
    section("评审：已公布考试成绩修改自动撤回");
    {
      const auditCount = (examId: number): number =>
        (db.prepare("SELECT COUNT(*) AS c FROM exam_publish_events WHERE exam_id = ?").get(examId) as { c: number }).c;
      const scorePublishedOf = (examId: number): number =>
        (db.prepare("SELECT score_published FROM exams WHERE id = ?").get(examId) as { score_published: number }).score_published;
      const unpublishReasons = (examId: number): Array<string | null> =>
        (db.prepare("SELECT reason FROM exam_publish_events WHERE exam_id = ? AND action = 'unpublish'").all(examId) as Array<{ reason: string | null }>).map((r) => r.reason);
      const publishMutationExam = (examId: number): Promise<Response> =>
        fetch(`${base}/api/exams/${examId}/publish`, { method: "POST", headers: authHeaders(teacherToken) });

      // 种子：独立班级 + 1 名学生；卡带客观题 7（答案 B）与主观题 8/9
      const mutateClass = Number(db.prepare("INSERT INTO classes (grade_id,name) VALUES (?,?)").run(grade.id, "安全D班").lastInsertRowid);
      const mutateStudent = await users.createUser({ username: "crit-mutate", password: "student-pass", name: "改分测试生", role_id: 3, student_number: "S3003" });
      db.prepare("INSERT INTO class_students (class_id,student_id) VALUES (?,?)").run(mutateClass, mutateStudent.id);
      const mutateCardId = "crit-mutate-card";
      db.prepare("INSERT INTO answer_cards (id, title) VALUES (?, ?)").run(mutateCardId, "改分撤回卡");
      db.prepare("INSERT INTO objective_blocks (id, card_id, sort_order, title, question_start, question_count, option_count, mode, score_per_question) VALUES ('crit-mutate-obj', ?, 0, '选择题', 7, 1, 4, 'single', 10)").run(mutateCardId);
      db.prepare("INSERT INTO objective_answer_keys (block_id, question_number, correct_options) VALUES ('crit-mutate-obj', 7, '[\"B\"]')").run();
      db.prepare("INSERT INTO objective_questions (block_id, question_number, sort_order, mode, option_count, score) VALUES ('crit-mutate-obj', 7, 0, 'single', 4, 10)").run();
      const mutateExam = Number(db.prepare(
        "INSERT INTO exams (name, card_id, grade_id, class_id, subject, status, score_published, created_by) VALUES (?,?,?,?,?,'closed',0,?)"
      ).run("公布门控-改分撤回", mutateCardId, grade.id, mutateClass, "数学", teacher.id).lastInsertRowid);
      db.prepare("INSERT INTO student_scores (exam_id, student_id, objective_score, subjective_score, total_score) VALUES (?,?,?,?,?)")
        .run(mutateExam, mutateStudent.id, 0, 20, 20);
      db.prepare("INSERT INTO question_scores (exam_id, student_id, question_number, score, max_score, score_type, block_id) VALUES (?,?,?,?,?,?,?)")
        .run(mutateExam, mutateStudent.id, 8, 12, 20, "subjective", "D");
      db.prepare("INSERT INTO question_scores (exam_id, student_id, question_number, score, max_score, score_type, block_id) VALUES (?,?,?,?,?,?,?)")
        .run(mutateExam, mutateStudent.id, 9, 12, 20, "subjective", "RVW");

      // 仲裁/网阅种子：切块 + 配置 + 分配
      db.prepare(
        `INSERT INTO answer_block_crops (id, card_id, exam_id, student_id, student_number, source_type, source_record_id, block_id, block_type, page_number, segment_index, question_numbers, rect_json, image_path, width_px, height_px, dpi, status, review_round, claimed_by)
         VALUES ('crit-crop-arb', ?, ?, ?, 'S3003', 'test', 'r-arb', 'ARB', 'subjective', 1, 0, '[8]', '{}', '', 0, 0, 300, 'disputed', 0, ?)`
      ).run(mutateCardId, mutateExam, mutateStudent.id, teacher.id);
      db.prepare(
        `INSERT INTO answer_block_crops (id, card_id, exam_id, student_id, student_number, source_type, source_record_id, block_id, block_type, page_number, segment_index, question_numbers, rect_json, image_path, width_px, height_px, dpi, status, review_round, claimed_by)
         VALUES ('crit-crop-rvw', ?, ?, ?, 'S3003', 'test', 'r-rvw', 'RVW', 'subjective', 1, 0, '[9]', '{}', '', 0, 0, 300, 'ready', 0, ?)`
      ).run(mutateCardId, mutateExam, mutateStudent.id, teacher.id);
      db.prepare("INSERT INTO block_grading_config (exam_id, block_id, arbitrator_id, review_mode, scoring_mode) VALUES (?, 'ARB', ?, 1, 'block_total')").run(mutateExam, teacher.id);
      db.prepare("INSERT INTO block_grading_config (exam_id, block_id, review_mode, scoring_mode) VALUES (?, 'RVW', 1, 'per_question')").run(mutateExam);
      db.prepare("INSERT INTO review_assignments (exam_id, block_id, teacher_id) VALUES (?, 'RVW', ?)").run(mutateExam, teacher.id);

      check((await publishMutationExam(mutateExam)).status === 200, "改分撤回用例：考试正常公布");

      // 1) 逐题改分（分数变化）→ 自动撤回 + 审计
      const editResp = await fetch(`${base}/api/exams/${mutateExam}/student/${mutateStudent.id}/scores`, {
        method: "PUT", headers: { "Content-Type": "application/json", ...authHeaders(teacherToken) },
        body: JSON.stringify({ scores: [{ questionNumber: 8, scoreType: "subjective", score: 10 }] })
      });
      check(editResp.status === 200 && scorePublishedOf(mutateExam) === 0, "已公布考试逐题改分：score_published 自动置 0");
      check(unpublishReasons(mutateExam).includes("手动改分自动撤回"), "逐题改分写入 unpublish 审计（reason=手动改分自动撤回）");

      // 2) 重新公布 → 修改答案（真实变化）→ 自动撤回 + 审计
      await publishMutationExam(mutateExam);
      const answerResp = await fetch(`${base}/api/exams/${mutateExam}/answers`, {
        method: "PUT", headers: { "Content-Type": "application/json", ...authHeaders(teacherToken) },
        body: JSON.stringify({ answers: { "7": ["A"] } })
      });
      check(answerResp.status === 200 && scorePublishedOf(mutateExam) === 0, "已公布考试修改答案：score_published 自动置 0");
      check(unpublishReasons(mutateExam).includes("修改答案自动撤回"), "修改答案写入 unpublish 审计（reason=修改答案自动撤回）");

      // 3) 重新公布 → 答案与当前一致 → 不算成绩变更，不撤回（防误伤）
      await publishMutationExam(mutateExam);
      const auditsBeforeNoop = auditCount(mutateExam);
      const noopResp = await fetch(`${base}/api/exams/${mutateExam}/answers`, {
        method: "PUT", headers: { "Content-Type": "application/json", ...authHeaders(teacherToken) },
        body: JSON.stringify({ answers: { "7": ["A"] } })
      });
      check(noopResp.status === 200 && scorePublishedOf(mutateExam) === 1 && auditCount(mutateExam) === auditsBeforeNoop, "答案未变化（与当前一致）：不撤回不写审计");

      // 4) 仲裁提交最终分 → 自动撤回 + 审计
      const arbResp = await fetch(`${base}/api/review-arbitration/crops/crit-crop-arb/resolve`, {
        method: "POST", headers: { "Content-Type": "application/json", ...authHeaders(teacherToken) },
        body: JSON.stringify({ score: 15 })
      });
      check(arbResp.status === 200 && scorePublishedOf(mutateExam) === 0, "仲裁提交最终分：score_published 自动置 0");
      check(unpublishReasons(mutateExam).includes("仲裁提交自动撤回"), "仲裁提交写入 unpublish 审计（reason=仲裁提交自动撤回）");

      // 5) 网阅评分提交（最终分落库）→ 自动撤回 + 审计
      await publishMutationExam(mutateExam);
      const reviewResp = await fetch(`${base}/api/review/exams/${mutateExam}/block-crops/crit-crop-rvw/submit`, {
        method: "POST", headers: { "Content-Type": "application/json", ...authHeaders(teacherToken) },
        body: JSON.stringify({ scores: [{ questionNumber: 9, scoreType: "subjective", score: 14 }], status: "reviewed" })
      });
      check(reviewResp.status === 200 && scorePublishedOf(mutateExam) === 0, "网阅评分提交：score_published 自动置 0");
      check(unpublishReasons(mutateExam).includes("网阅评分自动撤回"), "网阅评分写入 unpublish 审计（reason=网阅评分自动撤回）");

      // 6) 赋分重算 / 禁用 → 自动撤回 + 审计
      await publishMutationExam(mutateExam);
      const recalcResp = await fetch(`${base}/api/exams/${mutateExam}/assigned-formula`, {
        method: "PUT", headers: { "Content-Type": "application/json", ...authHeaders(teacherToken) },
        body: JSON.stringify({ formula: { type: "proportional", enabled: true, params: { minIn: 0, maxIn: 20, minOut: 10, maxOut: 20 } }, recalculate: true })
      });
      check(recalcResp.status === 200 && scorePublishedOf(mutateExam) === 0, "赋分重算：score_published 自动置 0");
      check(unpublishReasons(mutateExam).includes("赋分重算自动撤回"), "赋分重算写入 unpublish 审计（reason=赋分重算自动撤回）");
      await publishMutationExam(mutateExam);
      const disableResp = await fetch(`${base}/api/exams/${mutateExam}/assigned-formula`, {
        method: "PUT", headers: { "Content-Type": "application/json", ...authHeaders(teacherToken) },
        body: JSON.stringify({ formula: { type: "proportional", enabled: false, params: {} } })
      });
      check(disableResp.status === 200 && scorePublishedOf(mutateExam) === 0, "赋分禁用：score_published 自动置 0");
      check(unpublishReasons(mutateExam).includes("赋分禁用自动撤回"), "赋分禁用写入 unpublish 审计（reason=赋分禁用自动撤回）");
    }

    // ── 评审 P1：批量公布绕过软删除过滤 + 未授权 ID 枚举 ──
    section("评审：批量公布软删除与可见性过滤");
    {
      const auditCount = (examId: number): number =>
        (db.prepare("SELECT COUNT(*) AS c FROM exam_publish_events WHERE exam_id = ?").get(examId) as { c: number }).c;
      const softCardId = "crit-soft-card";
      db.prepare("INSERT INTO answer_cards (id, title) VALUES (?, ?)").run(softCardId, "软删除公布卡");
      const softExam = Number(db.prepare(
        "INSERT INTO exams (name, card_id, grade_id, class_id, subject, status, score_published, created_by) VALUES (?,?,?,?,?,'closed',0,?)"
      ).run("公布门控-软删除", softCardId, grade.id, classA, "数学", teacher.id).lastInsertRowid);
      db.prepare("INSERT INTO student_scores (exam_id, student_id, objective_score, subjective_score, total_score) VALUES (?,?,?,?,?)")
        .run(softExam, student.id, 40, 20, 60);
      db.prepare("INSERT INTO exam_archives (exam_id, is_deleted, deleted_at) VALUES (?, 1, CURRENT_TIMESTAMP)").run(softExam);

      // 单场访问基线：软删除对教师 404（与 requireExamAccess 一致）
      check((await fetch(`${base}/api/exams/${softExam}/publish`, { method: "POST", headers: authHeaders(teacherToken) })).status === 404, "软删除考试单场公布对教师 404（基线）");
      // 批量：教师/管理员均 400（视同不存在），且不写任何审计
      const teacherBatch = await fetch(`${base}/api/exams/publish-batch`, {
        method: "POST", headers: { "Content-Type": "application/json", ...authHeaders(teacherToken) },
        body: JSON.stringify({ examIds: [softExam] })
      });
      const adminBatch = await fetch(`${base}/api/exams/publish-batch`, {
        method: "POST", headers: { "Content-Type": "application/json", ...authHeaders(adminToken) },
        body: JSON.stringify({ examIds: [softExam] })
      });
      check(teacherBatch.status === 400 && adminBatch.status === 400 && auditCount(softExam) === 0, "软删除考试批量公布（教师/管理员）均被 400 拒绝且不写审计");

      // 枚举封堵：无权访问/不存在的考试 ID 在「存在性/状态校验」之前先被 403 拒绝
      const deniedExamBatch = await fetch(`${base}/api/exams/publish-batch`, {
        method: "POST", headers: { "Content-Type": "application/json", ...authHeaders(teacherToken) },
        body: JSON.stringify({ examIds: [hiddenExam] })
      });
      const ghostExamBatch = await fetch(`${base}/api/exams/publish-batch`, {
        method: "POST", headers: { "Content-Type": "application/json", ...authHeaders(teacherToken) },
        body: JSON.stringify({ examIds: [999999] })
      });
      check(deniedExamBatch.status === 403 && ghostExamBatch.status === 403, "无权访问/不存在的考试 ID 批量公布均 403（不泄露状态与存在性）");

      // 恢复（删除软删除标记）后批量公布恢复正常
      db.prepare("DELETE FROM exam_archives WHERE exam_id = ?").run(softExam);
      const restoredBatch = await fetch(`${base}/api/exams/publish-batch`, {
        method: "POST", headers: { "Content-Type": "application/json", ...authHeaders(teacherToken) },
        body: JSON.stringify({ examIds: [softExam] })
      });
      check(restoredBatch.status === 200 && auditCount(softExam) === 1, "软删除解除后批量公布恢复成功并写审计");
    }

    // ── 评审 P1：can_view_students=0 名单旁路收口 ──
    // 考试详情 results / 考生搜索 / 成绩导出 / 跨考总分，四入口在名单查看被关闭时全部收敛
    section("评审：can_view_students 名单旁路收口");
    {
      // teacher（数学/classA）配置矩阵行：成绩与图表可看、学生名单关闭
      db.prepare(
        "INSERT INTO teacher_permissions (teacher_id, grade_id, subject, class_id, can_view_scores, can_view_charts, can_view_students, can_grade, can_assign) VALUES (?,?,?,?,1,1,0,1,1)"
      ).run(teacher.id, grade.id, "数学", classA);
      const detailResp = await fetch(`${base}/api/exams/${visibleExam}`, { headers: authHeaders(teacherToken) });
      const detailBody = await detailResp.json() as Record<string, unknown>;
      check(detailResp.status === 200 && !("results" in detailBody), "名单关闭教师：考试详情不再返回 results（学生名单+分数）");
      check(
        (await fetch(`${base}/api/exams/${visibleExam}/students/search?q=%E5%AD%A6`, { headers: authHeaders(teacherToken) })).status === 403,
        "名单关闭教师：考生搜索被 can_view_students 门拦截"
      );
      check(
        (await fetch(`${base}/api/export/exams/${visibleExam}/scores`, {
          method: "POST",
          headers: { ...authHeaders(teacherToken), "Content-Type": "application/json" },
          body: JSON.stringify({ columns: ["studentName", "totalScore"] })
        })).status === 403,
        "名单关闭教师：成绩 Excel 导出被双查看门拦截"
      );
      check(
        (await fetch(`${base}/api/analysis/cross-exam/total`, {
          method: "POST",
          headers: { ...authHeaders(teacherToken), "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "selected", examIds: [visibleExam] })
        })).status === 403,
        "名单关闭教师：跨考总分被 can_view_students 收敛拦截"
      );
      const adminDetailResp = await fetch(`${base}/api/exams/${visibleExam}`, { headers: authHeaders(adminToken) });
      const adminDetailBody = await adminDetailResp.json() as Record<string, unknown>;
      check(adminDetailResp.status === 200 && Array.isArray(adminDetailBody.results), "管理员不受名单门限制：考试详情仍返回 results");
      // 学生角色：/api/exams 命名空间由 examGate（EXAM_READ）整体拦截，
      // 无法借考试详情端点读取全班成绩单（handler 内亦保留 isStaff 纵深防御）
      const studentDetailResp = await fetch(`${base}/api/exams/${visibleExam}`, { headers: authHeaders(studentToken) });
      check(studentDetailResp.status === 403, "学生角色：考试详情端点被 examGate 拦截（无法读取全班成绩单）");

      // 评审 P1：成绩代查接口（/api/scores/students/:studentId 及逐题明细）此前只查
      // 班级/年级关系与考试可见范围，叠加 #246 矩阵门 —— 名单关闭的教师不能借代查
      // 旁路读取学生姓名/考号与（未公布）成绩
      db.prepare("INSERT OR IGNORE INTO class_students (class_id, student_id) VALUES (?, ?)").run(classA, student.id);
      const proxyListResp = await fetch(`${base}/api/scores/students/${student.id}`, { headers: authHeaders(teacherToken) });
      const proxyDetailResp = await fetch(`${base}/api/scores/students/${student.id}/exams/${visibleExam}`, { headers: authHeaders(teacherToken) });
      check(proxyListResp.status === 403 && proxyDetailResp.status === 403, "名单关闭教师：成绩代查列表/逐题明细被矩阵门 403 拒绝");
      const adminProxyListResp = await fetch(`${base}/api/scores/students/${student.id}`, { headers: authHeaders(adminToken) });
      check(adminProxyListResp.status === 200, "管理员不受矩阵门限制：成绩代查仍可用");

      // 评审 P1：普通教师（无 teacher_role）曾回退「全校可见」完全绕过矩阵 ——
      // 配置矩阵禁止行（数学/classA 成绩+名单关闭）后代查必须被 403 拒绝
      const plainTeacher = await users.createUser({ username: "crit-plain", password: "teacher-pass", name: "普通教师", role_id: 2 });
      const plainToken = (await authService.login(plainTeacher.username, "teacher-pass")).token!;
      db.prepare(
        "INSERT INTO teacher_permissions (teacher_id, grade_id, subject, class_id, can_view_scores, can_view_charts, can_view_students, can_grade, can_assign) VALUES (?,?,?,?,0,0,0,1,1)"
      ).run(plainTeacher.id, grade.id, "数学", classA);
      const plainProxyResp = await fetch(`${base}/api/scores/students/${student.id}`, { headers: authHeaders(plainToken) });
      check(plainProxyResp.status === 403, "普通教师（无 teacher_role）+ 矩阵禁止行：代查被 403 拒绝（不再全校可见）");
      db.prepare("DELETE FROM teacher_permissions WHERE teacher_id = ?").run(plainTeacher.id);
      const plainProxyRestoredResp = await fetch(`${base}/api/scores/students/${student.id}`, { headers: authHeaders(plainToken) });
      check(plainProxyRestoredResp.status === 200, "普通教师矩阵移除后代查恢复可用（未配置矩阵兼容放行）");

      // 清理矩阵行（本段置于末尾，避免影响其它用例的可见性判定）
      db.prepare("DELETE FROM teacher_permissions WHERE teacher_id = ? AND subject = '数学' AND class_id = ?").run(teacher.id, classA);
      // 矩阵移除后（未配置矩阵兼容放行）代查恢复正常
      const proxyAfterClearResp = await fetch(`${base}/api/scores/students/${student.id}`, { headers: authHeaders(teacherToken) });
      check(proxyAfterClearResp.status === 200, "矩阵移除后教师成绩代查恢复可用（未配置矩阵兼容放行）");
      db.prepare("DELETE FROM class_students WHERE class_id = ? AND student_id = ?").run(classA, student.id);
    }

    // ── 评审 P1：创建考试显式指定保留策略仅管理员 ──
    // POST /api/exams 此前只受 examGate（EXAM_WRITE）保护，普通教师可越权挂上
    // 自动归档/删除策略；PATCH 更新接口已限定仅管理员，此处把创建接口校验对齐。
    section("评审：创建考试显式保留策略仅管理员");
    {
      const policyRow = db.prepare("SELECT id FROM data_retention_policies ORDER BY id LIMIT 1").get() as { id: number } | undefined;
      const policyId = policyRow?.id ?? 1;
      db.prepare("INSERT OR IGNORE INTO answer_cards (id, title, subject, subject_label) VALUES ('CRITICALCARD001', '保留策略回归卡', 'shuxue', '数学')").run();

      const teacherCreatePolicy = await fetch(`${base}/api/exams`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(teacherToken) },
        body: JSON.stringify({ name: "crit-教师越权策略", cardId: "CRITICALCARD001", gradeId: grade.id, classId: classA, mode: "formal", retentionPolicyId: policyId })
      });
      const teacherCreatePolicyBody = await teacherCreatePolicy.json() as { message?: string };
      check(
        teacherCreatePolicy.status === 403 && (teacherCreatePolicyBody.message ?? "").includes("仅管理员"),
        "教师创建考试时显式指定保留策略被 403 拒绝"
      );

      const teacherCreateDefault = await fetch(`${base}/api/exams`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(teacherToken) },
        body: JSON.stringify({ name: "crit-教师默认策略", cardId: "CRITICALCARD001", gradeId: grade.id, classId: classA, mode: "formal" })
      });
      check(teacherCreateDefault.status === 201, "教师创建考试（未指定保留策略）仍可成功");

      const adminCreatePolicy = await fetch(`${base}/api/exams`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(adminToken) },
        body: JSON.stringify({ name: "crit-管理员指定策略", cardId: "CRITICALCARD001", gradeId: grade.id, classId: classA, mode: "formal", retentionPolicyId: policyId })
      });
      const adminCreatePolicyBody = await adminCreatePolicy.json() as { id?: number; retention_policy_id?: number | null };
      check(
        adminCreatePolicy.status === 201 && adminCreatePolicyBody.retention_policy_id === policyId,
        "管理员创建考试显式指定保留策略成功且绑定生效"
      );
    }

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
