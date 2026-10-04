import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { CombinedGradingRow, RecognitionBlockCrop, StudentTrendPoint } from "../src/shared/types";

const tempDir = mkdtempSync(path.join(tmpdir(), "projectx-security-critical-"));
process.env.PROJECTX_DB_PATH = path.join(tempDir, "projectx.db");
process.env.ANSWER_CARD_DATA_DIR = path.join(tempDir, "data");
process.env.USERPROFILE = path.join(tempDir, "home");
process.env.PROJECTX_AUTH_ENFORCE = "1";
process.env.PROJECTX_ENABLE_SCANNER = "false";
process.env.PROJECTX_ENABLE_SCANNER_CLIENT_API = "true";
// 单账号并发进度流上限收紧到 2，便于断言「换 batchId 也绕不过」（PR280 评审 P1）
process.env.ANSWER_CARD_MAX_PROGRESS_STREAMS_PER_USER = "2";
// R22/R28 上传上限覆盖位：宿主机若设置了任一档位，本脚本所有「按默认上限边界」的断言都会失真，
// 因此必须先清掉。这份名单与 shared/scanUploadLimits 的 LIMIT_DEFS 靠下面的一致性断言锁定。
const uploadEnvVarsClearedHere = [
  "PROJECTX_UPLOAD_MAX_SCAN_IMAGE_MIB", "PROJECTX_UPLOAD_MAX_SESSION_PAGES",
  "PROJECTX_UPLOAD_MAX_CROPS_PER_REQUEST", "PROJECTX_UPLOAD_MAX_CROP_IMAGE_MIB",
  "PROJECTX_UPLOAD_MAX_CROPS_TOTAL_MIB", "PROJECTX_UPLOAD_MAX_PAGE_REQUEST_TOTAL_MIB",
  "PROJECTX_UPLOAD_MAX_BATCH_FILES", "PROJECTX_UPLOAD_MAX_BATCH_TOTAL_MIB"
];
// 试卷池持有量配额（安全 R15）同样是「默认值 + 环境变量 + 天花板」三档，宿主机变量会污染默认档位断言。
const reviewPoolEnvVarsClearedHere = ["PROJECTX_REVIEW_MAX_HELD_PER_BLOCK", "PROJECTX_REVIEW_MAX_HELD_TOTAL"];
for (const key of [
  "PROJECTX_MARIADB_HOST", "PROJECTX_MARIADB_PORT", "PROJECTX_MARIADB_USER",
  "PROJECTX_MARIADB_PASSWORD", "PROJECTX_MARIADB_DATABASE", "PROJECTX_MYSQL_HOST",
  // R01 逃生阀：宿主机若已设置该变量会污染随机口令断言，测试内自行显式设置/清除
  "PROJECTX_ADMIN_PASSWORD",
  ...uploadEnvVarsClearedHere,
  ...reviewPoolEnvVarsClearedHere
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
    const readAdminHash = () => (db.prepare("SELECT password_hash FROM users WHERE username='admin'").get() as { password_hash: string }).password_hash;
    const readAdminFlag = () => (db.prepare("SELECT password_change_required FROM users WHERE username='admin'").get() as { password_change_required: number }).password_change_required;
    const readBootstrapFile = () => readFileSync(getBootstrapAdminPath(), "utf8").trim();

    const firstBootstrap = await ensureDefaultAdmin();
    const firstPassword = readBootstrapFile();
    check(
      firstBootstrap.rotated && firstPassword.length >= 16 && firstPassword !== "admin123",
      "新库使用一次性随机口令（不再落任何公开固定值）"
    );
    check(existsSync(getBootstrapAdminPath()), "初始密码写入数据库同目录引导文件");
    check(readAdminFlag() === 1, "新管理员被标记为强制改密");

    // R01 核心：引导文件是引导态口令的唯一事实源，重启不得恢复到任何固定值。
    const hashAfterFirst = readAdminHash();
    const repeatBootstrap = await ensureDefaultAdmin();
    check(
      !repeatBootstrap.rotated && readAdminHash() === hashAfterFirst && readBootstrapFile() === firstPassword,
      "引导态库重复启动不轮换口令、不重写引导文件（旧行为是每次重置回 admin123 并吊销全部会话）"
    );

    // 升级场景：存量引导态库 + 文件里仍是历史公开口令 → 当场换发新随机口令。
    db.prepare("UPDATE users SET password_hash=?, password_change_required=1 WHERE username='admin'").run(await hashPassword("admin123"));
    writeFileSync(getBootstrapAdminPath(), "admin123\n", { encoding: "utf8" });
    const upgradedBootstrap = await ensureDefaultAdmin();
    const upgradedPassword = readBootstrapFile();
    check(
      upgradedBootstrap.rotated && upgradedPassword !== "admin123"
        && readAdminFlag() === 1 && await verifyPassword(upgradedPassword, readAdminHash()),
      "升级时残留的历史公开口令 admin123 被立即失效并换发随机口令"
    );
    check(!(await verifyPassword("admin123", readAdminHash())), "admin123 不再能作为管理员口令");

    // 存量库迁移：停留在强制改密引导态的旧随机密码且引导文件丢失 → 换发新的随机口令（自愈）
    db.prepare("UPDATE users SET password_hash=?, password_change_required=1 WHERE username='admin'").run(await hashPassword("Legacy-Random-Pw"));
    rmSync(getBootstrapAdminPath(), { force: true });
    const recoveredBootstrap = await ensureDefaultAdmin();
    const recoveredPassword = readBootstrapFile();
    check(
      recoveredBootstrap.rotated && recoveredPassword !== "admin123" && recoveredPassword !== "Legacy-Random-Pw"
        && readAdminFlag() === 1 && await verifyPassword(recoveredPassword, readAdminHash()),
      "引导文件缺失的存量库换发新的随机口令并可据此登录"
    );

    // 库换了但引导文件没换（例如跨机还原备份）：文件口令与哈希对不上时必须换发，
    // 否则会出现「文件里的口令登录不进去」这种无人能自愈的锁死。
    const staleFilePassword = readBootstrapFile();
    db.prepare("UPDATE users SET password_hash=?, password_change_required=1 WHERE username='admin'").run(await hashPassword("From-Other-Machine-Pw"));
    const mismatchBootstrap = await ensureDefaultAdmin();
    const mismatchPassword = readBootstrapFile();
    check(
      mismatchBootstrap.rotated && mismatchPassword !== staleFilePassword
        && await verifyPassword(mismatchPassword, readAdminHash()),
      "引导文件与库中哈希不匹配时换发新口令（跨机还原不会把管理员锁死）"
    );

    // 逃生阀：显式提供 PROJECTX_ADMIN_PASSWORD 时口令由环境变量决定，且不写引导文件。
    process.env.PROJECTX_ADMIN_PASSWORD = "Deploy-Hatch-2026!";
    const hatchBootstrap = await ensureDefaultAdmin();
    check(
      hatchBootstrap.rotated && !existsSync(getBootstrapAdminPath())
        && readAdminFlag() === 1 && await verifyPassword("Deploy-Hatch-2026!", readAdminHash()),
      "PROJECTX_ADMIN_PASSWORD 指定引导态口令且不写引导文件"
    );
    const hatchRepeat = await ensureDefaultAdmin();
    check(!hatchRepeat.rotated, "环境变量口令与库中哈希一致时重复启动幂等（不轮换、不吊销会话）");
    delete process.env.PROJECTX_ADMIN_PASSWORD;
    // 撤掉逃生阀后回到「文件缺失即自愈」语义，为下面的登录链路准备随机口令
    await ensureDefaultAdmin();
    const loginPassword = readBootstrapFile();

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

    const legacyLogin = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "admin", password: "admin123" })
    });
    check(legacyLogin.status === 401, "历史公开口令 admin123 经 HTTP 登录被 401 拒绝");

    const bootstrapLogin = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "admin", password: loginPassword })
    });
    const bootstrapBody = await bootstrapLogin.json() as { token: string; passwordChangeRequired: boolean };
    check(bootstrapLogin.status === 200 && bootstrapBody.passwordChangeRequired === true, "引导文件随机口令登录后强制改密");
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
      body: JSON.stringify({ oldPassword: loginPassword, newPassword: "CriticalAdmin-2026!" })
    });
    check(changed.status === 200 && !existsSync(getBootstrapAdminPath()), "改密成功后清除强制标记和引导文件");
    const staleSession = await fetch(`${base}/api/auth/me`, { headers: authHeaders(bootstrapBody.token) });
    check(staleSession.status === 401, "改密后旧管理员会话失效");
    const adminLogin = await authService.login("admin", "CriticalAdmin-2026!");
    const adminToken = adminLogin.token!;

    // R01 接管链回归：完成首次改密后，重启既不能改写口令，也不能让公开凭据重新取得所有权。
    const ownedHash = readAdminHash();
    const afterChangeBootstrap = await ensureDefaultAdmin();
    check(
      !afterChangeBootstrap.rotated && readAdminHash() === ownedHash && readAdminFlag() === 0
        && !existsSync(getBootstrapAdminPath()),
      "已改密账号重启后口令、改密标记与引导文件均保持改密后的状态"
    );
    check((await authService.login("admin", "admin123")).success === false, "历史公开口令无法登录已改密的管理员");
    check(Boolean((await authService.login("admin", "CriticalAdmin-2026!")).token), "改密后的口令在重启后持续有效");

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

    section("判分上传文件类型（云端安全检查 #33）");
    const recognitionUploadDir = path.join(process.env.ANSWER_CARD_DATA_DIR!, "recognition", "uploads", "critical-card");
    const forgedForm = new FormData();
    forgedForm.append("files", new Blob(
      [Buffer.from("<html><script>fetch('/api/users')</script></html>")],
      { type: "text/html" }
    ), "payload.html");
    const forgedUpload = await fetch(`${base}/api/cards/critical-card/grading`, {
      method: "POST",
      headers: authHeaders(teacherToken),
      body: forgedForm
    });
    check(forgedUpload.status === 400, "判分上传拒绝非图片文件（魔数校验）");
    const leftoverUploads = existsSync(recognitionUploadDir) ? readdirSync(recognitionUploadDir) : [];
    check(leftoverUploads.length === 0, `被拒绝的上传不残留文件 (实际 ${leftoverUploads.join(",") || "无"})`);

    section("判分上传考试范围（云端安全检查 #05/#10）");
    const pngUploadForm = (examId: number): FormData => {
      const form = new FormData();
      form.append("files", new Blob(
        [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
        { type: "image/png" }
      ), "page.png");
      form.append("examId", String(examId));
      return form;
    };
    const outOfScopeUpload = await fetch(`${base}/api/cards/critical-card/grading`, {
      method: "POST", headers: authHeaders(teacherToken), body: pngUploadForm(hiddenExam)
    });
    const outOfScopeBody = await outOfScopeUpload.json() as { message?: string };
    check(outOfScopeUpload.status === 403 && (outOfScopeBody.message ?? "").includes("权限不足"),
      "越权考试的判分上传被 403 拒绝（不再静默改状态/写成绩）");
    db.prepare("INSERT INTO answer_cards (id,title,subject,subject_label) VALUES (?,?,?,?)")
      .run("other-card", "另一张答题卡", "shuxue", "数学");
    const otherCardExam = Number(db.prepare("INSERT INTO exams (name,card_id,grade_id,class_id,subject,status,created_by) VALUES (?,?,?,?,?,'active',?)")
      .run("他卡考试", "other-card", grade.id, classA, "数学", teacher.id).lastInsertRowid);
    const mismatchUpload = await fetch(`${base}/api/cards/critical-card/grading`, {
      method: "POST", headers: authHeaders(teacherToken), body: pngUploadForm(otherCardExam)
    });
    const mismatchBody = await mismatchUpload.json() as { message?: string };
    check(mismatchUpload.status === 400 && (mismatchBody.message ?? "").includes("未关联该答题卡"),
      "考试与答题卡不匹配的判分上传被 400 拒绝");
    // card_id 为 NULL 的考试（答题卡删除后 unlinkExams 产生）同样必须拒绝，不得用 URL 里的卡写入成绩
    const unlinkedExam = Number(db.prepare("INSERT INTO exams (name,card_id,grade_id,class_id,subject,status,created_by) VALUES (?,NULL,?,?,?,'active',?)")
      .run("未关联答题卡的考试", grade.id, classA, "数学", teacher.id).lastInsertRowid);
    const unlinkedUpload = await fetch(`${base}/api/cards/critical-card/grading`, {
      method: "POST", headers: authHeaders(teacherToken), body: pngUploadForm(unlinkedExam)
    });
    const unlinkedBody = await unlinkedUpload.json() as { message?: string };
    check(unlinkedUpload.status === 400 && (unlinkedBody.message ?? "").includes("未关联该答题卡"),
      "考试未关联答题卡（card_id 为 NULL）的判分上传被 400 拒绝");

    section("扫描接入：令牌重放、越权读取与上传预算（安全 R02/R04/R07/R22/R28）");
    const {
      MAX_SCAN_SESSION_PAGES, MAX_CROP_IMAGE_BYTES, MAX_CROPS_PER_REQUEST,
      resolveScanUploadLimits, describeScanUploadLimits, DEFAULT_SCAN_UPLOAD_LIMITS, SCAN_UPLOAD_ENV_VARS
    } = await import("../src/shared/scanUploadLimits");
    const { parseScanSessionPageCount } = await import("../src/server/routes/scanner-upload");
    const { persistAnswerBlockCrops, isInsideDir } = await import("../src/server/services/AnswerBlockCropService");
    const { requestUploadBudget } = await import("../src/server/lib/uploadBudget");
    const { blockCropsDir } = await import("../src/apps/answer-card/server/storage");
    const dataRoot = process.env.ANSWER_CARD_DATA_DIR!;
    const scannerUploadsDir = path.join(dataRoot, "scanner-uploads");
    mkdirSync(scannerUploadsDir, { recursive: true });
    // 带 PNG 魔数的最小正文：扫描页与切块都要过 `isValidImageBuffer`
    const pngBytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(64, 0x20)
    ]);
    const scannerKeyHeaders = { "X-Api-Key": "key-scanner" };
    const rowCount = (sql: string, ...args: unknown[]) =>
      (db.prepare(sql).get(...args) as { count: number }).count;
    async function newScanSession(pageCount?: number | string): Promise<{ status: number; sessionId: string; token: string }> {
      const response = await fetch(`${base}/api/scanner/upload/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...scannerKeyHeaders },
        body: JSON.stringify({
          cardId: "critical-card", name: "安全批次验收", dpi: 300, paperSize: "A4",
          ...(pageCount === undefined ? {} : { pageCount })
        })
      });
      const body = await response.json() as { sessionId?: string; uploadTokens?: string[] };
      return { status: response.status, sessionId: body.sessionId ?? "", token: body.uploadTokens?.[0] ?? "" };
    }
    const cropsUrl = (sessionId: string, recordId: string) =>
      `${base}/api/scanner/upload/sessions/${encodeURIComponent(sessionId)}/pages/${encodeURIComponent(recordId)}/crops`;
    const validManifest = (fileName: string) => ({
      blockId: "r07-block", blockTitle: "第 1 题", blockType: "objective",
      pageNumber: 1, segmentIndex: 0, questionNumbers: [1],
      rect: { x: 0, y: 0, width: 40, height: 40 },
      widthPx: 40, heightPx: 40, dpi: 300, fileName
    });

    // ── R22：会话页数上界（pageCount 决定一次性写入的记录数与令牌数）
    const overPageSession = await newScanSession(MAX_SCAN_SESSION_PAGES + 1);
    check(overPageSession.status === 400, `pageCount=${MAX_SCAN_SESSION_PAGES + 1} 被 400 拒绝（此前无任何上限）`);
    check((await newScanSession("1e9")).status === 400, "pageCount=\"1e9\" 被 400 拒绝");
    check((await newScanSession(1.5)).status === 400, "非整数 pageCount 被 400 拒绝");
    check((await newScanSession(0)).status === 400, "pageCount=0 被 400 拒绝");
    check(rowCount("SELECT COUNT(*) count FROM twain_scan_sessions") === 1,
      "非法 pageCount 的请求不产生半成品会话（此前会先建会话再落任意多行）");
    const maxPageSession = await newScanSession(MAX_SCAN_SESSION_PAGES);
    const maxPageRecords = rowCount("SELECT COUNT(*) count FROM twain_scan_records WHERE session_id=?", maxPageSession.sessionId);
    const maxPageRow = db.prepare("SELECT page_count FROM twain_scan_sessions WHERE id=?").get(maxPageSession.sessionId) as { page_count: number };
    check(maxPageSession.status === 201 && maxPageRecords === MAX_SCAN_SESSION_PAGES
      && Number(maxPageRow.page_count) === MAX_SCAN_SESSION_PAGES,
      `上界内的 ${MAX_SCAN_SESSION_PAGES} 页会话正常创建：令牌数与待上传记录数一致`);
    check(parseScanSessionPageCount(undefined) === 1 && parseScanSessionPageCount("") === 1
      && parseScanSessionPageCount(2.5) === null && parseScanSessionPageCount(-1) === null,
      "缺省页数仍按 1 页处理，小数与负数被判定为非法");
    db.prepare("DELETE FROM twain_scan_records WHERE session_id=?").run(maxPageSession.sessionId);
    db.prepare("DELETE FROM twain_scan_sessions WHERE id=?").run(maxPageSession.sessionId);

    // ── 上限可配置（安全 R22/R28 的三档设计）：默认值 / 环境变量覆盖 / 非法回落 / 天花板夹紧
    check(SCAN_UPLOAD_ENV_VARS.slice().sort().join() === uploadEnvVarsClearedHere.slice().sort().join()
      && SCAN_UPLOAD_ENV_VARS.every((name) => !(name in process.env)),
      "脚本清理的 PROJECTX_UPLOAD_* 名单与限制表逐一对应，宿主机变量不会渗入默认上限断言");
    const asString = (limits: Record<string, number>) => JSON.stringify(limits);
    const untouched = resolveScanUploadLimits({});
    check(asString(untouched.limits) === asString(DEFAULT_SCAN_UPLOAD_LIMITS) && untouched.notices.length === 0,
      "全部未配置时按默认上限生效且无告警（原卷 50MiB / 会话 200 页 / 切块 50 张·12MiB·160MiB / 批量 300 张·1GiB）");
    const overridden = resolveScanUploadLimits({
      PROJECTX_UPLOAD_MAX_SESSION_PAGES: "500",
      PROJECTX_UPLOAD_MAX_CROPS_TOTAL_MIB: "512",
      PROJECTX_UPLOAD_MAX_CROP_IMAGE_MIB: "1.5"
    });
    check(overridden.limits.maxScanSessionPages === 500
      && overridden.limits.maxCropsTotalBytes === 512 * 1024 * 1024
      && overridden.limits.maxCropImageBytes === Math.round(1.5 * 1024 * 1024)
      && overridden.notices.length === 3 && overridden.notices.every((n) => n.includes("覆盖")),
      "合法的环境变量按 MiB/个数被采纳，并逐项留下覆盖记录");
    const invalid = resolveScanUploadLimits({
      PROJECTX_UPLOAD_MAX_SCAN_IMAGE_MIB: "abc",
      PROJECTX_UPLOAD_MAX_BATCH_FILES: "0",
      PROJECTX_UPLOAD_MAX_PAGE_REQUEST_TOTAL_MIB: "-8"
    });
    check(asString(invalid.limits) === asString(DEFAULT_SCAN_UPLOAD_LIMITS)
      && invalid.notices.length === 3
      && invalid.notices.every((n) => n.includes("按默认值")),
      "非数字、0、负数一律回落默认值（打错一个数字不会把保护关掉）");
    const clamped = resolveScanUploadLimits({
      PROJECTX_UPLOAD_MAX_SESSION_PAGES: "999999",
      PROJECTX_UPLOAD_MAX_CROPS_TOTAL_MIB: "999999"
    });
    check(clamped.limits.maxScanSessionPages === 2000
      && clamped.limits.maxCropsTotalBytes === 2048 * 1024 * 1024
      && clamped.notices.length === 2 && clamped.notices.every((n) => n.includes("天花板")),
      "超过安全天花板的配置被夹紧而不是照单全收（放宽有上界）");
    const describeText = describeScanUploadLimits();
    check(describeText.includes("50MiB") && describeText.includes("≤200")
      && describeText.includes("≤300") && describeText.includes("1024MiB"),
      "启动摘要按当前生效值输出，运维无需读代码即可确认闸门档位");

    // ── 试卷池持有量配额（安全 R15）：与上传上限同一套三档设计
    const {
      MAX_HELD_PAPERS_PER_BLOCK, MAX_HELD_PAPERS_TOTAL,
      resolveReviewPoolLimits, DEFAULT_REVIEW_POOL_LIMITS, REVIEW_POOL_ENV_VARS, describeReviewPoolLimits
    } = await import("../src/shared/reviewPoolLimits");
    const poolEnvNames = Object.values(REVIEW_POOL_ENV_VARS);
    check(poolEnvNames.slice().sort().join() === reviewPoolEnvVarsClearedHere.slice().sort().join()
      && poolEnvNames.every((name) => !(name in process.env)),
      "脚本清理的试卷池配额变量名单与限制表逐一对应，宿主机变量不会渗入默认档位断言");
    check(MAX_HELD_PAPERS_PER_BLOCK === DEFAULT_REVIEW_POOL_LIMITS.maxHeldPapersPerBlock
      && MAX_HELD_PAPERS_TOTAL === DEFAULT_REVIEW_POOL_LIMITS.maxHeldPapersTotal
      && resolveReviewPoolLimits({}).notices.length === 0,
      "未配置时按默认持有量配额生效（题块 20 份 / 全局 60 份）");
    check(resolveReviewPoolLimits({ PROJECTX_REVIEW_MAX_HELD_PER_BLOCK: "3" }).limits.maxHeldPapersPerBlock === 3
      && resolveReviewPoolLimits({ PROJECTX_REVIEW_MAX_HELD_TOTAL: "-1" }).limits.maxHeldPapersTotal === 60
      && resolveReviewPoolLimits({ PROJECTX_REVIEW_MAX_HELD_TOTAL: "999999" }).limits.maxHeldPapersTotal === 2000,
      "持有量配额可收紧、非法值回落默认、超天花板被夹紧（放宽有上界）");
    check(describeReviewPoolLimits().includes("maxHeldPapersPerBlock=20"),
      "试卷池配额进入启动摘要，与上传上限一致的可见性");

    // ── R04：记录/会话级接口收敛到考试范围（critical-card 被可见/越权两场考试复用）
    const r04Session = await newScanSession();
    const scanImagePath = path.join(scannerUploadsDir, "r04-page.png");
    writeFileSync(scanImagePath, pngBytes);
    db.prepare("UPDATE twain_scan_records SET image_path=?, ocr_status='uploaded' WHERE id=?")
      .run(scanImagePath, r04Session.token);
    const teacherImage = await fetch(`${base}/api/scanner/upload/records/${r04Session.token}/image`, {
      headers: authHeaders(teacherToken)
    });
    const teacherImageBody = await teacherImage.json().catch(() => null) as { message?: string } | null;
    check(teacherImage.status === 403 && (teacherImageBody?.message ?? "").includes("权限不足"),
      "教师不能按记录 ID 读走「另一场越权考试也在用」的答题卡原卷图片");
    const adminImage = await fetch(`${base}/api/scanner/upload/records/${r04Session.token}/image`, {
      headers: authHeaders(adminToken)
    });
    check(adminImage.status === 200 && (adminImage.headers.get("content-type") ?? "").startsWith("image/"),
      "全量权限账号仍可正常读取原卷图片（阅卷预览未被误伤）");
    const teacherScanView = await fetch(`${base}/api/scanner/scan/${r04Session.sessionId}`, {
      headers: authHeaders(teacherToken)
    });
    check(teacherScanView.status === 403, "扫描会话详情同样受考试范围约束（此前只要扫描侧凭据即可读）");
    const adminScanView = await fetch(`${base}/api/scanner/scan/${r04Session.sessionId}`, {
      headers: authHeaders(adminToken)
    });
    const adminScanText = await adminScanView.text();
    check(adminScanView.status === 200 && adminScanText.includes("hasImage")
      && !adminScanText.includes("image_path") && !adminScanText.includes(dataRoot),
      "会话详情不再外发服务端绝对路径，改以 hasImage + scan-image 预览");
    const outsideFile = path.join(tempDir, "outside-data-dir.png");
    writeFileSync(outsideFile, pngBytes);
    db.prepare("UPDATE twain_scan_records SET image_path=? WHERE id=?").run(outsideFile, r04Session.token);
    const outsideImage = await fetch(`${base}/api/scanner/upload/records/${r04Session.token}/image`, {
      headers: authHeaders(adminToken)
    });
    check(outsideImage.status === 404, "记录中的图片路径指向数据目录之外时返回 404（不再外送任意文件）");
    db.prepare("UPDATE twain_scan_records SET image_path=? WHERE id=?").run(scanImagePath, r04Session.token);
    const teacherDelete = await fetch(`${base}/api/scanner/record/${r04Session.token}`, {
      method: "DELETE", headers: authHeaders(teacherToken)
    });
    check(teacherDelete.status === 403
      && rowCount("SELECT COUNT(*) count FROM twain_scan_records WHERE id=?", r04Session.token) === 1,
      "越权教师不能按记录 ID 删除扫描记录，被拒请求不产生任何写入");

    // ── R02：会话进入终态后，页面/切块上传令牌失效
    const r02Session = await newScanSession();
    db.prepare("UPDATE twain_scan_sessions SET status='completed' WHERE id=?").run(r02Session.sessionId);
    const replayPageForm = new FormData();
    replayPageForm.append("image", new Blob([pngBytes], { type: "image/png" }), "page.png");
    replayPageForm.append("token", r02Session.token);
    replayPageForm.append("pageNum", "1");
    const replayPage = await fetch(`${base}/api/scanner/upload/sessions/${r02Session.sessionId}/pages`, {
      method: "POST", headers: scannerKeyHeaders, body: replayPageForm
    });
    const replayPageBody = await replayPage.json() as { message?: string };
    check(replayPage.status === 409 && (replayPageBody.message ?? "").includes("新建扫描会话"),
      "会话完成后的页面上传被 409 拒绝，并提示改建新会话（此前旧令牌可静默覆盖已判分页面）");
    const replayCropForm = new FormData();
    replayCropForm.append("crops", new Blob([pngBytes], { type: "image/png" }), "crop.png");
    replayCropForm.append("manifest", JSON.stringify([validManifest("crop.png")]));
    const replayCrops = await fetch(cropsUrl(r02Session.sessionId, r02Session.token), {
      method: "POST", headers: scannerKeyHeaders, body: replayCropForm
    });
    check(replayCrops.status === 409, "会话完成后的切块上传也被 409 拒绝（阅卷图不可静默替换）");

    // ── R07：切块清单字段收敛，落盘路径由服务端决定
    const r07Session = await newScanSession();
    db.prepare("UPDATE twain_scan_records SET ocr_status='uploaded', identity_json=?, student_id=? WHERE id=?")
      .run(JSON.stringify({ status: "verified", code: "OK", cardId: "critical-card", pageNumber: 1 }), "S1001", r07Session.token);
    const evilManifestForm = new FormData();
    evilManifestForm.append("crops", new Blob([pngBytes], { type: "image/png" }), "crop.png");
    evilManifestForm.append("manifest", JSON.stringify([{ ...validManifest("crop.png"), pageNumber: "../../evil" }]));
    const evilManifest = await fetch(cropsUrl(r07Session.sessionId, r07Session.token), {
      method: "POST", headers: scannerKeyHeaders, body: evilManifestForm
    });
    const evilManifestBody = await evilManifest.json() as { message?: string };
    check(evilManifest.status === 400 && (evilManifestBody.message ?? "").includes("切块清单无效"),
      "清单里的 pageNumber=\"../../evil\" 被 400 拒绝（不再参与落盘文件名）");
    const escapedTarget = path.join(dataRoot, "..", "r07-escaped.png");
    const pathOverrideForm = new FormData();
    pathOverrideForm.append("crops", new Blob([pngBytes], { type: "image/png" }), "crop.png");
    pathOverrideForm.append("manifest", JSON.stringify([
      { ...validManifest("crop.png"), path: escapedTarget, imagePath: escapedTarget, extra: "x" }
    ]));
    const pathOverride = await fetch(cropsUrl(r07Session.sessionId, r07Session.token), {
      method: "POST", headers: scannerKeyHeaders, body: pathOverrideForm
    });
    const pathOverrideBody = await pathOverride.json() as { ok?: boolean; count?: number };
    const storedCrop = db.prepare(
      "SELECT image_path FROM answer_block_crops WHERE source_type='twain_scan_record' AND source_record_id=?"
    ).get(r07Session.token) as { image_path: string } | undefined;
    check(pathOverride.status === 200 && pathOverrideBody.count === 1
      && !existsSync(escapedTarget) && Boolean(storedCrop) && isInsideDir(blockCropsDir, storedCrop!.image_path),
      "客户端上报的 path 被丢弃：切块只写进服务端决定的切块目录");
    const r07TempDir = path.join(scannerUploadsDir, "crops-temp",
      path.basename(r07Session.sessionId), path.basename(r07Session.token));
    check(!existsSync(r07TempDir), "切块临时目录不残留（此前每次重试都在盘上留一份副本）");
    const unitSourcePath = path.join(scannerUploadsDir, "r07-unit-source.png");
    writeFileSync(unitSourcePath, pngBytes);
    const evilRawCrop = {
      blockId: "r07-unit-block", blockTitle: "", blockType: "objective",
      pageNumber: "../../evil", segmentIndex: "../x", questionNumbers: [1],
      rect: { x: 0, y: 0, width: 1, height: 1 }, widthPx: 10, heightPx: 10, dpi: 300,
      path: unitSourcePath
    } as unknown as RecognitionBlockCrop;
    const unitStats = await persistAnswerBlockCrops({
      cardId: "critical-card", sourceType: "twain_scan_record",
      sourceRecordId: "r07-service-unit", crops: [evilRawCrop]
    });
    const unitCrop = db.prepare("SELECT image_path FROM answer_block_crops WHERE source_record_id=?")
      .get("r07-service-unit") as { image_path: string } | undefined;
    check(unitStats.persisted === 1 && Boolean(unitCrop) && isInsideDir(blockCropsDir, unitCrop!.image_path)
      && !unitCrop!.image_path.includes("..") && existsSync(unitCrop!.image_path),
      "服务层兜底：绕过路由校验的越界清单也被收敛到切块目录内");
    check(isInsideDir(dataRoot, path.join(dataRoot, "a.png")) && !isInsideDir(dataRoot, `${dataRoot}-backup/a.png`)
      && !isInsideDir(dataRoot, path.join(dataRoot, "..", "etc", "passwd")),
      "目录判定同时拒绝同前缀兄弟目录与向上穿越");

    // ── R28：文件数量、单文件与「整次请求累计」三级上限
    const tooManyForm = new FormData();
    for (let i = 0; i <= MAX_CROPS_PER_REQUEST; i++) {
      tooManyForm.append("crops", new Blob([pngBytes], { type: "image/png" }), `crop-${i}.png`);
    }
    tooManyForm.append("manifest", "[]");
    const tooManyCrops = await fetch(cropsUrl(r07Session.sessionId, r07Session.token), {
      method: "POST", headers: scannerKeyHeaders, body: tooManyForm
    });
    check(tooManyCrops.status === 400, `一次携带 ${MAX_CROPS_PER_REQUEST + 1} 张切块被 400 拒绝（数量上限）`);
    const oversizedForm = new FormData();
    oversizedForm.append("crops", new Blob([Buffer.alloc(MAX_CROP_IMAGE_BYTES + 1024, 0x89)], { type: "image/png" }), "big.png");
    oversizedForm.append("manifest", "[]");
    const oversizedCrop = await fetch(cropsUrl(r07Session.sessionId, r07Session.token), {
      method: "POST", headers: scannerKeyHeaders, body: oversizedForm
    });
    check(oversizedCrop.status === 413, `单张切块超过 ${Math.round(MAX_CROP_IMAGE_BYTES / 1024 / 1024)} MiB 被 413 拒绝`);
    const express = (await import("express")).default;
    const budgetApp = express();
    budgetApp.use(requestUploadBudget({ maxTotalBytes: 1024, label: "预算验收" }));
    budgetApp.post("/budget", (_req, res) => { res.json({ ok: true }); });
    const budgetServer = budgetApp.listen(0);
    await new Promise<void>((resolve) => budgetServer.once("listening", resolve));
    const budgetBase = `http://127.0.0.1:${(budgetServer.address() as { port: number }).port}`;
    const withinBudget = await fetch(`${budgetBase}/budget`, {
      method: "POST", body: Buffer.from("x".repeat(128))
    });
    check(withinBudget.status === 200, "累计预算内的请求正常放行（不误伤小文件上传）");
    let overBudgetStatus = 0;
    let overBudgetCode = "";
    try {
      const overBudget = await fetch(`${budgetBase}/budget`, { method: "POST", body: Buffer.from("y".repeat(4096)) });
      overBudgetStatus = overBudget.status;
      overBudgetCode = ((await overBudget.json() as { code?: string }).code) ?? "";
    } catch { /* 超预算后连接会被断开：状态码/错误码已取到即可 */ }
    check(overBudgetStatus === 413 && overBudgetCode === "UPLOAD_BUDGET_EXCEEDED",
      `累计字节超预算的请求返回 413 UPLOAD_BUDGET_EXCEEDED (实际 ${overBudgetStatus}/${overBudgetCode || "无错误码"})`);
    budgetServer.close();

    section("阅卷进度流订阅上限（云端安全检查 #22 / PR280 评审 P1）");
    const streamAbort = new AbortController();
    const openStream = (batchId: string): Promise<Response> => fetch(
      `${base}/api/cards/critical-card/grading/progress/${batchId}`,
      { headers: authHeaders(teacherToken), signal: streamAbort.signal }
    );
    const streamA = await openStream("review-stream-a");
    const streamB = await openStream("review-stream-b");
    check(streamA.status === 200 && streamB.status === 200, "限额内可建立进度流（2/2）");
    const streamC = await openStream("review-stream-c");
    check(streamC.status === 429, "第 3 条进度流即使换 batchId 也被 429 拒绝（单账号配额）");
    streamAbort.abort();

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

    // Publish through the real HTTP routes between score-writing transactions.
    // The next student write must withdraw that publication in its own transaction.
    const { getMysqlDb } = await import("../src/server/db");
    const adapter = getMysqlDb();
    // 收紧发布校验：中途公布必须「应考集合 ⊆ 已评分集合」，因此在两名学生都出分后才放行，
    // 再由第三次写分（同一学生重判）验证撤回仍然在同一事务内原子生效。
    const raceClass = Number(db.prepare("INSERT INTO classes (grade_id,name) VALUES (?,?)").run(grade.id, "写分间隙班").lastInsertRowid);
    db.prepare("INSERT INTO class_students (class_id,student_id) VALUES (?,?)").run(raceClass, student.id);
    db.prepare("INSERT INTO class_students (class_id,student_id) VALUES (?,?)").run(raceClass, rollbackStudent.id);
    for (const batchPublish of [false, true]) {
      const raceExam = Number(db.prepare("INSERT INTO exams (name,card_id,grade_id,class_id,subject,status,created_by) VALUES (?,?,?,?,?,?,?)")
        .run(`写分期间公布-${batchPublish}`, "critical-card", grade.id, raceClass, "数学", "active", teacher.id).lastInsertRowid);
      const originalTransaction = adapter.transaction.bind(adapter);
      let publishedBetweenRows = false;
      adapter.transaction = async (fn) => {
        const value = await originalTransaction(fn);
        const count = (db.prepare("SELECT COUNT(*) AS n FROM student_scores WHERE exam_id=?").get(raceExam) as { n: number }).n;
        if (!publishedBetweenRows && count === 2) {
          publishedBetweenRows = true;
          const response = await fetch(`${base}/api/exams/${batchPublish ? "publish-batch" : `${raceExam}/publish`}`, {
            method: "POST", headers: { ...authHeaders(teacherToken), "Content-Type": "application/json" },
            ...(batchPublish ? { body: JSON.stringify({ examIds: [raceExam] }) } : {}),
          });
          check(response.status === 200, `写分间隙${batchPublish ? "批量" : "单场"}公布成功`);
        }
        return value;
      };
      try {
        const firstRun = await persistGradingResults(String(raceExam), [gradingRow("first.png", "S1001")], teacher.id);
        const secondRun = await persistGradingResults(String(raceExam), [gradingRow("second.png", "S1002")], teacher.id);
        const thirdRun = await persistGradingResults(String(raceExam), [gradingRow("third.png", "S1001")], teacher.id);
        check(publishedBetweenRows && firstRun.persisted === 1 && secondRun.persisted === 1 && thirdRun.persisted === 1,
          "逐学生写入之间有公布间隙（第三次写分前撤回）");
        const state = db.prepare("SELECT score_published FROM exams WHERE id=?").get(raceExam) as { score_published: number };
        check(state.score_published === 0, "后续学生写入原子撤回中途公布");
        const audit = db.prepare(
          "SELECT actor_id FROM exam_publish_events WHERE exam_id=? AND action='unpublish' AND actor_id=? LIMIT 1"
        ).get(raceExam, teacher.id) as { actor_id: number } | undefined;
        check(audit?.actor_id === teacher.id, "写分撤回保留操作者审计");
      } finally {
        adapter.transaction = originalTransaction;
      }
    }

    const errorExam = createExam("全部失败阅卷", "active");
    const errorResult = await persistGradingResults(String(errorExam), [
      gradingRow("unknown.png", "UNKNOWN"), gradingRow("recognition.png", null, "failed")
    ], teacher.id);
    const errorExamState = db.prepare("SELECT status FROM exams WHERE id=?").get(errorExam) as { status: string };
    const errorBatch = db.prepare("SELECT status,success_count,failure_count FROM scan_batches WHERE id=?").get(errorResult.batchId) as { status: string; success_count: number; failure_count: number };
    check(errorResult.status === "error" && errorResult.persisted === 0 && errorResult.failedCount === 2, "未知学生和识别失败均计入失败");
    check(errorExamState.status === "active" && errorBatch.status === "error" && errorBatch.success_count === 0 && errorBatch.failure_count === 2, "全部失败：批次 error、考试恢复调用前状态");

    section("并发判分只产生一次结考备份（PR280 评审 P1：结考判断必须原子）");
    {
      const parallelExam = createExam("并发判分备份");
      const [parallelA, parallelB] = await Promise.all([
        persistGradingResults(String(parallelExam), [gradingRow("parallel-a.png", "S1001")], teacher.id),
        persistGradingResults(String(parallelExam), [gradingRow("parallel-b.png", "S1001")], teacher.id)
      ]);
      check(parallelA.status === "done" && parallelB.status === "done", "并发两次判分均完成");
      const backupDir = path.join(process.env.ANSWER_CARD_DATA_DIR!, "backups");
      const parallelBackups = (): string[] => existsSync(backupDir)
        ? readdirSync(backupDir).filter((name) => name.startsWith(`projectx_exam${parallelExam}_`))
        : [];
      for (let i = 0; i < 40 && parallelBackups().length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 50));
      // 备份是 fire-and-forget：再等一拍，让可能出现的重复备份有机会落盘
      await new Promise((resolve) => setTimeout(resolve, 400));
      check(parallelBackups().length === 1,
        `并发判分只产生 1 份结考备份（实际 ${parallelBackups().length}：${parallelBackups().join(",") || "无"}）`);
    }

    section("顺序重判（closed → partial → done 循环）不重复产生结考备份（PR280 第五轮评审 P1）");
    {
      const rerunExam = createExam("顺序重判备份");
      const backupDir = path.join(process.env.ANSWER_CARD_DATA_DIR!, "backups");
      const rerunBackups = (): string[] => existsSync(backupDir)
        ? readdirSync(backupDir).filter((name) => name.startsWith(`projectx_exam${rerunExam}_`))
        : [];
      const waitForBackup = async (): Promise<void> => {
        for (let i = 0; i < 40 && rerunBackups().length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 50));
        // 备份是 fire-and-forget：再等一拍，让可能出现的重复备份有机会落盘
        await new Promise((resolve) => setTimeout(resolve, 400));
      };

      // 第一次完整判分：结考并备份
      const firstRun = await persistGradingResults(String(rerunExam), [gradingRow("rerun-1.png", "S1001")], teacher.id);
      await waitForBackup();
      check(firstRun.status === "done" && rerunBackups().length === 1,
        `首次结考产生 1 份备份（实际 ${rerunBackups().length}）`);

      // 重新阅卷部分失败：状态回到 grading（下一轮若只看紧邻状态就会被当成首次结考）
      db.exec(`CREATE TRIGGER critical_rerun_failure BEFORE INSERT ON question_scores WHEN NEW.student_id = ${rollbackStudent.id} BEGIN SELECT RAISE(ABORT, 'forced student rollback'); END;`);
      const partialRun = await persistGradingResults(String(rerunExam), [
        gradingRow("rerun-2.png", "S1001"), gradingRow("rerun-2-bad.png", "S1002")
      ], teacher.id);
      db.exec("DROP TRIGGER critical_rerun_failure");
      const rerunState = db.prepare("SELECT status FROM exams WHERE id=?").get(rerunExam) as { status: string };
      check(partialRun.status === "partial" && rerunState.status === "grading", "重判部分失败：批次 partial、考试回到 grading");

      // 重试成功：此前已有 done 批次（持久化标记），不得再产生第二份备份
      const retryRun = await persistGradingResults(String(rerunExam), [gradingRow("rerun-3.png", "S1001")], teacher.id);
      await waitForBackup();
      check(retryRun.status === "done" && rerunBackups().length === 1,
        `partial → done 重试后仍只有 1 份结考备份（实际 ${rerunBackups().length}：${rerunBackups().join(",") || "无"}）`);
    }

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
      const restoreUrl = `${base}/api/analysis/exams/${visibleExam}/ai-analysis`;
      const ownLatest = await fetch(restoreUrl, { headers: authHeaders(teacherToken) }).then(r => r.json()) as any;
      check(ownLatest.job?.id === newJobId, "重新进入分析页可恢复当前用户的最新任务");
      const otherLatest = await fetch(restoreUrl, { headers: authHeaders(adminToken) }).then(r => r.json()) as any;
      check(otherLatest.job === null, "恢复入口不会混入其他用户的分析");
      check((await fetch(restoreUrl, { headers: authHeaders(teacher2Token) })).status === 403, "恢复入口拒绝不可见考试");
      check((await fetch(`${restoreUrl}?classId=invalid`, { headers: authHeaders(teacherToken) })).status === 400, "恢复入口拒绝非法班级参数");
      const classJob = await createAiAnalysisJob({ examId: visibleExam, classId: classA, createdBy: teacher.id });
      const restoredClass = await fetch(`${restoreUrl}?classId=${classA}`, { headers: authHeaders(teacherToken) }).then(r => r.json()) as any;
      const restoredAll = await fetch(restoreUrl, { headers: authHeaders(teacherToken) }).then(r => r.json()) as any;
      check(restoredClass.job?.id === classJob && restoredAll.job?.id === newJobId, "班级报告与全体报告独立恢复");
      db.prepare("UPDATE ai_analysis_jobs SET status='done',result=? WHERE id=?").run(JSON.stringify({ model: "persist-test", report: { overallJudgement: "已保存报告" } }), classJob);
      const restoredDone = await fetch(`${restoreUrl}?classId=${classA}`, { headers: authHeaders(teacherToken) }).then(r => r.json()) as any;
      check(restoredDone.job?.result?.report?.overallJudgement === "已保存报告", "恢复接口返回已持久化报告内容");
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

    // ── 发布路径前置：应考名单 ──
    // 公布/撤回/批量公布端点的「批改完整性」校验依赖班级名册（class_students）。
    // 名册插入必须先于所有发布路径断言，否则前段用例因“应考名单为空”被 409 拒绝，
    // 后续审计/保留策略断言连锁失败。
    db.prepare("INSERT INTO class_students (class_id,student_id) VALUES (?,?)").run(classA, student.id);

    section("成绩公布门控与审计原子性");
    {
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

      // 草稿不可公布，阅卷中已有成绩允许教师主动公布。
      const publishDraft = await fetch(`${base}/api/exams/${draftExam}/publish`, { method: "POST", headers: authHeaders(teacherToken) });
      const publishGrading = await fetch(`${base}/api/exams/${gradingExam}/publish`, { method: "POST", headers: authHeaders(teacherToken) });
      check(publishDraft.status === 409 && publishGrading.status === 200, "草稿仍拒绝公布，阅卷中已有成绩允许公布");

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

    // 收紧后的发布校验：名单未全部出分拒绝；缺考者走应考名单剔除；无成绩拒绝；批量整体拒绝无部分写入。
    section("发布完整性校验与空成绩拦截");
    {
      const auditCount = (examId: number): number =>
        (db.prepare("SELECT COUNT(*) AS c FROM exam_publish_events WHERE exam_id = ?").get(examId) as { c: number }).c;
      const scoreCount = (examId: number): number =>
        (db.prepare("SELECT COUNT(*) AS c FROM student_scores WHERE exam_id = ?").get(examId) as { c: number }).c;
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

      // 单场：无成绩拒绝；1/2 人出分同样拒绝（应考集合 ⊆ 已评分集合）。
      const publishNoScore = await fetch(`${base}/api/exams/${noScoreExam}/publish`, { method: "POST", headers: authHeaders(teacherToken) });
      const publishPartial = await fetch(`${base}/api/exams/${partialScoreExam}/publish`, { method: "POST", headers: authHeaders(teacherToken) });
      const publishPartialBody = await publishPartial.json() as { message?: string };
      check(publishNoScore.status === 409 && auditCount(noScoreExam) === 0, "closed 但无成绩记录：单场公布被 409 拒绝且不写审计");
      check(publishPartial.status === 409 && auditCount(partialScoreExam) === 0 && /不完整|缺/.test(String(publishPartialBody.message || "")),
        "收紧：仅 1/2 人出分 → 409 且提示缺应考学生成绩");

      // 名单齐全可公布
      const fullScoreExam = seedRosterExam("公布门控-P1完整");
      for (const sid of [rosterStudent1.id, rosterStudent2.id]) {
        db.prepare("INSERT INTO student_scores (exam_id, student_id, objective_score, subjective_score, total_score) VALUES (?,?,?,?,?)")
          .run(fullScoreExam, sid, 40, 20, 60);
      }
      const publishFull = await fetch(`${base}/api/exams/${fullScoreExam}/publish`, { method: "POST", headers: authHeaders(teacherToken) });
      check(publishFull.status === 200 && auditCount(fullScoreExam) === 1, "应考名单全部出分：单场公布成功并写入审计");

      // 批量：任一场缺人 → 整体 409，已完整场次也不得被部分写入
      const batchIncomplete = await fetch(`${base}/api/exams/publish-batch`, {
        method: "POST", headers: { "Content-Type": "application/json", ...authHeaders(teacherToken) },
        body: JSON.stringify({ examIds: [partialScoreExam, noScoreExam] })
      });
      check(batchIncomplete.status === 409 && auditCount(partialScoreExam) === 0 && auditCount(noScoreExam) === 0,
        "批量含未完整场次：整体 409 且无任何审计写入");

      // 缺考学生按 #248 §3.2 从应考名单剔除后即可公布（显式名单优先于名册快照）
      db.prepare("DELETE FROM exam_participants WHERE exam_id = ?").run(partialScoreExam);
      db.prepare("INSERT INTO exam_participants (exam_id, student_id, source) VALUES (?,?,'explicit')")
        .run(partialScoreExam, rosterStudent1.id);
      const publishAfterRemoval = await fetch(`${base}/api/exams/${partialScoreExam}/publish`, { method: "POST", headers: authHeaders(teacherToken) });
      check(publishAfterRemoval.status === 200 && auditCount(partialScoreExam) === 1,
        "缺考者从应考名单剔除后公布成功（显式名单优先）");

      // 阅卷中（未结考）名单齐全仍可公布，且公布不为任何人补造成绩行
      const gradingComplete = seedRosterExam("阅卷中名单齐全");
      db.prepare("UPDATE exams SET status = 'grading' WHERE id = ?").run(gradingComplete);
      db.prepare("INSERT INTO student_scores (exam_id, student_id, total_score) VALUES (?,?,?)").run(gradingComplete, rosterStudent1.id, 60);
      db.prepare("INSERT INTO student_scores (exam_id, student_id, total_score) VALUES (?,?,?)").run(gradingComplete, rosterStudent2.id, 55);
      const publishGrading = await fetch(`${base}/api/exams/${gradingComplete}/publish`, { method: "POST", headers: authHeaders(teacherToken) });
      check(publishGrading.status === 200 && auditCount(gradingComplete) === 1, "阅卷中名单齐全即可公布，无需结考");
      check(scoreCount(gradingComplete) === 2, "公布不为未出分学生创建零分记录");
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
      check(pubBypass.status === 409 && auditCnt(p1ExamBypass)===0 && /不完整|缺/.test(String(pubBypassBody.message||"")), "A/C 凑数绕过：单场公布被 409 拒绝且提示缺应考学生成绩");

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
      const remBody = await remPublish.json() as { message?: string };
      check(remPublish.status===409 && /不完整|缺/.test(String(remBody.message||"")), "收紧：快照仍含已调走的 B，缺 B 成绩 → 拒绝公布");
      check(Boolean(db.prepare("SELECT 1 FROM exam_participants WHERE exam_id=? AND student_id=?").get(remExam, sRemB.id)), "拒绝公布不移除原应考名单中的 B");
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
        (await fetch(`${base}/api/exams/${visibleExam}/participant-search?q=%E5%AD%A6`, { headers: authHeaders(teacherToken) })).status === 403,
        "名单关闭教师：应考名单搜索同样被 can_view_students 门拦截"
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
      // 旁路读取学生姓名/考号与（未公布）成绩。
      // （classA↔student 名册已作为发布路径前置统一插入，此处不再重复。）
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

      // PR280 第四轮评审 P1：可见性 ≠ 写权限 —— 矩阵 can_grade=0 必须拦住判分入库
      db.prepare("UPDATE teacher_permissions SET can_grade = 0 WHERE teacher_id = ? AND subject = '数学' AND class_id = ?").run(teacher.id, classA);
      const deniedGradeUpload = await fetch(`${base}/api/cards/critical-card/grading`, {
        method: "POST", headers: authHeaders(teacherToken), body: pngUploadForm(visibleExam)
      });
      check(deniedGradeUpload.status === 403, "判分禁止教师：矩阵 can_grade=0 时判分上传被 403 拒绝");
      db.prepare("UPDATE teacher_permissions SET can_grade = 1 WHERE teacher_id = ? AND subject = '数学' AND class_id = ?").run(teacher.id, classA);
      const allowedGradeUpload = await fetch(`${base}/api/cards/critical-card/grading`, {
        method: "POST", headers: authHeaders(teacherToken), body: pngUploadForm(visibleExam)
      });
      check(allowedGradeUpload.status !== 403, "恢复 can_grade=1 后判分上传不再被矩阵门拒绝");

      // PR280 第五轮评审 P1：整卷上传会写入全部客观题与主观题成绩并撤回已公布状态，
      // 因此只接受「不限题块」的授权 —— 仅有单个题块授权的教师不得借整卷接口覆盖其它题块
      db.prepare("UPDATE teacher_permissions SET block_id = 'crit-block-a' WHERE teacher_id = ? AND subject = '数学' AND class_id = ?").run(teacher.id, classA);
      const blockScopedUpload = await fetch(`${base}/api/cards/critical-card/grading`, {
        method: "POST", headers: authHeaders(teacherToken), body: pngUploadForm(visibleExam)
      });
      check(blockScopedUpload.status === 403, "仅单题块授权（block_id 非空）：整卷判分上传被 403 拒绝");
      db.prepare("UPDATE teacher_permissions SET block_id = NULL WHERE teacher_id = ? AND subject = '数学' AND class_id = ?").run(teacher.id, classA);

      // PR280 第五轮评审 P1：仅有题块级网阅分配（review_assignments）、未配置矩阵的教师
      // 同样只是题块级授权，不得借整卷判分接口覆盖其它题块
      db.prepare("INSERT INTO review_assignments (exam_id, block_id, teacher_id) VALUES (?, 'crit-block-a', ?)").run(visibleExam, plainTeacher.id);
      const blockAssignedUpload = await fetch(`${base}/api/cards/critical-card/grading`, {
        method: "POST", headers: authHeaders(plainToken), body: pngUploadForm(visibleExam)
      });
      check(blockAssignedUpload.status === 403, "仅题块级网阅分配（review_assignments）未配置矩阵：整卷判分上传被 403 拒绝");
      db.prepare("DELETE FROM review_assignments WHERE exam_id = ? AND teacher_id = ?").run(visibleExam, plainTeacher.id);
      const blockAssignmentClearedUpload = await fetch(`${base}/api/cards/critical-card/grading`, {
        method: "POST", headers: authHeaders(plainToken), body: pngUploadForm(visibleExam)
      });
      check(blockAssignmentClearedUpload.status !== 403, "题块分配移除后整卷判分上传不再被题块门拒绝");

      // 分配给别人时，未获分配的教师同样不能借整卷上传覆盖该题块。
      db.prepare("INSERT INTO review_assignments (exam_id, block_id, teacher_id) VALUES (?, 'crit-block-a', ?)").run(visibleExam, teacher.id);
      const unassignedUpload = await fetch(`${base}/api/cards/critical-card/grading`, {
        method: "POST", headers: authHeaders(plainToken), body: pngUploadForm(visibleExam)
      });
      check(unassignedUpload.status === 403, "题块分配给他人：无矩阵且未获分配的教师整卷上传被拒绝");
      db.prepare("INSERT INTO teacher_permissions (teacher_id, can_grade, block_id) VALUES (?, 1, NULL)").run(plainTeacher.id);
      const explicitlyGrantedUpload = await fetch(`${base}/api/cards/critical-card/grading`, {
        method: "POST", headers: authHeaders(plainToken), body: pngUploadForm(visibleExam)
      });
      check(explicitlyGrantedUpload.status !== 403, "题块分配存在时，显式整卷授权仍可上传");
      db.prepare("DELETE FROM teacher_permissions WHERE teacher_id = ?").run(plainTeacher.id);
      db.prepare("DELETE FROM review_assignments WHERE exam_id = ? AND teacher_id = ?").run(visibleExam, teacher.id);

      // PR280 第五轮评审 P2：修改用户角色不会清理历史矩阵行，遗留 can_grade=0
      // 不得把管理员与学年主任等特权阅卷人挡在门外
      const adminId = (db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id: number }).id;
      const stalePermSql = "INSERT INTO teacher_permissions (teacher_id, grade_id, subject, class_id, can_view_scores, can_view_charts, can_view_students, can_grade, can_assign) VALUES (?,?,?,?,1,1,1,0,0)";
      db.prepare(stalePermSql).run(adminId, grade.id, "数学", classA);
      db.prepare(stalePermSql).run(leader.id, grade.id, "数学", classA);
      const adminStaleUpload = await fetch(`${base}/api/cards/critical-card/grading`, {
        method: "POST", headers: authHeaders(adminToken), body: pngUploadForm(visibleExam)
      });
      const leaderStaleUpload = await fetch(`${base}/api/cards/critical-card/grading`, {
        method: "POST", headers: authHeaders(leaderToken), body: pngUploadForm(visibleExam)
      });
      check(adminStaleUpload.status !== 403 && leaderStaleUpload.status !== 403,
        `管理员/学年主任遗留 can_grade=0 矩阵行时仍可判分上传（实际 admin=${adminStaleUpload.status}/leader=${leaderStaleUpload.status}）`);
      db.prepare("DELETE FROM teacher_permissions WHERE teacher_id IN (?, ?)").run(adminId, leader.id);

      // 清理矩阵行（本段置于末尾，避免影响其它用例的可见性判定）
      db.prepare("DELETE FROM teacher_permissions WHERE teacher_id = ? AND subject = '数学' AND class_id = ?").run(teacher.id, classA);
      // 矩阵移除后（未配置矩阵兼容放行）代查恢复正常
      const proxyAfterClearResp = await fetch(`${base}/api/scores/students/${student.id}`, { headers: authHeaders(teacherToken) });
      check(proxyAfterClearResp.status === 200, "矩阵移除后教师成绩代查恢复可用（未配置矩阵兼容放行）");
    }

    // ── 评审 P1：创建考试显式指定保留策略仅管理员 ──
    // POST /api/exams 此前只受 examGate（EXAM_WRITE）保护，普通教师可越权挂上
    // 自动归档/删除策略；PATCH 更新接口已限定仅管理员，此处把创建接口校验对齐。
    section("评审：创建考试显式保留策略仅管理员");
    {
      const policyRow = db.prepare("SELECT id FROM data_retention_policies ORDER BY id LIMIT 1").get() as { id: number } | undefined;
      const policyId = policyRow?.id ?? 1;
      db.prepare("INSERT OR IGNORE INTO answer_cards (id, title, subject, subject_label) VALUES ('CRITICALCARD001', '保留策略回归卡', 'shuxue', '数学')").run();

      // 注：三个用例均显式携带应考范围（gradeId/classId）——创建接口的 SCOPE_REQUIRED
      // 完整性校验先于保留策略权限校验执行，缺范围会以 400 掩盖真实的 403/201 断言。
      const teacherCreatePolicy = await fetch(`${base}/api/exams`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(teacherToken) },
        body: JSON.stringify({ name: "crit-教师越权策略", cardId: "CRITICALCARD001", mode: "formal", gradeId: grade.id, classId: classA, retentionPolicyId: policyId })
      });
      const teacherCreatePolicyBody = await teacherCreatePolicy.json() as { message?: string };
      check(
        teacherCreatePolicy.status === 403 && (teacherCreatePolicyBody.message ?? "").includes("仅管理员"),
        "教师创建考试时显式指定保留策略被 403 拒绝"
      );

      const teacherCreateDefault = await fetch(`${base}/api/exams`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(teacherToken) },
        body: JSON.stringify({ name: "crit-教师默认策略", cardId: "CRITICALCARD001", mode: "formal", gradeId: grade.id, classId: classA })
      });
      check(teacherCreateDefault.status === 201, "教师创建考试（未指定保留策略）仍可成功");

      const adminCreatePolicy = await fetch(`${base}/api/exams`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(adminToken) },
        body: JSON.stringify({ name: "crit-管理员指定策略", cardId: "CRITICALCARD001", mode: "formal", gradeId: grade.id, classId: classA, retentionPolicyId: policyId })
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
