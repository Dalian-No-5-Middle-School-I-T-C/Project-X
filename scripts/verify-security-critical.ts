import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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
const reviewPoolEnvVarsClearedHere = ["PROJECTX_REVIEW_MAX_HELD_PER_BLOCK", "PROJECTX_REVIEW_MAX_HELD_TOTAL", "PROJECTX_REVIEW_CLAIM_LOCK_TIMEOUT_MS"];
// 备份恢复解压预算（安全 R43）同样是「默认值 + 环境变量 + 天花板」三档，宿主机变量会污染按默认预算的断言。
const restoreZipEnvVarsClearedHere = [
  "PROJECTX_RESTORE_ZIP_MAX_ENTRIES", "PROJECTX_RESTORE_ZIP_MAX_ENTRY_MIB", "PROJECTX_RESTORE_ZIP_MAX_TOTAL_MIB",
  "PROJECTX_RESTORE_ZIP_MAX_RATIO"
];
// 原卷累计容量（R10/R14）、AI 配额（R11）、微信出站档位（R20）共用同一套三档设计：
// 宿主机若设置了任一档位，本脚本「按默认边界」的断言全部失真，必须先清掉，
// 再由下面的一致性断言把这份名单与各模块的 LIMIT_DEFS 锁死。
const paperStorageEnvVarsClearedHere = [
  "PROJECTX_PAPER_MAX_FILE_MIB", "PROJECTX_PAPER_MAX_REQUEST_MIB", "PROJECTX_PAPER_MAX_FILES_PER_REQUEST",
  "PROJECTX_PAPER_MAX_PAGES_PER_CARD", "PROJECTX_PAPER_MAX_BYTES_PER_CARD_MIB", "PROJECTX_PAPER_MAX_TOTAL_MIB"
];
const aiQuotaEnvVarsClearedHere = [
  "PROJECTX_AI_MAX_ACTIVE_JOBS_PER_USER", "PROJECTX_AI_MAX_ACTIVE_JOBS_GLOBAL",
  "PROJECTX_AI_MAX_RUNS_PER_HOUR", "PROJECTX_AI_MAX_TOKENS_PER_DAY",
  "PROJECTX_AI_ACTIVE_RUN_STALE_MS", "PROJECTX_AI_ADMISSION_LOCK_TIMEOUT_MS"
];
const wechatEnvVarsClearedHere = [
  "PROJECTX_WECHAT_TIMEOUT_MS", "PROJECTX_WECHAT_BIND_MAX_PER_HOUR",
  "PROJECTX_WECHAT_BIND_MAX_GLOBAL_PER_MINUTE", "PROJECTX_WECHAT_MAX_CONCURRENT"
];
for (const key of [
  "PROJECTX_MARIADB_HOST", "PROJECTX_MARIADB_PORT", "PROJECTX_MARIADB_USER",
  "PROJECTX_MARIADB_PASSWORD", "PROJECTX_MARIADB_DATABASE", "PROJECTX_MYSQL_HOST",
  // R01 逃生阀：宿主机若已设置该变量会污染随机口令断言，测试内自行显式设置/清除
  "PROJECTX_ADMIN_PASSWORD",
  ...uploadEnvVarsClearedHere,
  ...reviewPoolEnvVarsClearedHere,
  ...restoreZipEnvVarsClearedHere,
  ...paperStorageEnvVarsClearedHere,
  ...aiQuotaEnvVarsClearedHere,
  ...wechatEnvVarsClearedHere
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
      MAX_HELD_PAPERS_PER_BLOCK, MAX_HELD_PAPERS_TOTAL, CLAIM_LOCK_TIMEOUT_MS,
      resolveReviewPoolLimits, DEFAULT_REVIEW_POOL_LIMITS, REVIEW_POOL_ENV_VARS, describeReviewPoolLimits
    } = await import("../src/shared/reviewPoolLimits");
    const poolEnvNames = Object.values(REVIEW_POOL_ENV_VARS);
    check(poolEnvNames.slice().sort().join() === reviewPoolEnvVarsClearedHere.slice().sort().join()
      && poolEnvNames.every((name) => !(name in process.env)),
      "脚本清理的试卷池配额变量名单与限制表逐一对应，宿主机变量不会渗入默认档位断言");
    check(MAX_HELD_PAPERS_PER_BLOCK === DEFAULT_REVIEW_POOL_LIMITS.maxHeldPapersPerBlock
      && MAX_HELD_PAPERS_TOTAL === DEFAULT_REVIEW_POOL_LIMITS.maxHeldPapersTotal
      && CLAIM_LOCK_TIMEOUT_MS === DEFAULT_REVIEW_POOL_LIMITS.claimLockTimeoutMs
      && resolveReviewPoolLimits({}).notices.length === 0,
      "未配置时按默认持有量配额与领取锁预算生效（题块 20 份 / 全局 60 份 / 锁等待 3000 毫秒）");
    check(resolveReviewPoolLimits({ PROJECTX_REVIEW_MAX_HELD_PER_BLOCK: "3" }).limits.maxHeldPapersPerBlock === 3
      && resolveReviewPoolLimits({ PROJECTX_REVIEW_MAX_HELD_TOTAL: "-1" }).limits.maxHeldPapersTotal === 60
      && resolveReviewPoolLimits({ PROJECTX_REVIEW_MAX_HELD_TOTAL: "999999" }).limits.maxHeldPapersTotal === 2000,
      "持有量配额可收紧、非法值回落默认、超天花板被夹紧（放宽有上界）");
    check(resolveReviewPoolLimits({ PROJECTX_REVIEW_CLAIM_LOCK_TIMEOUT_MS: "500" }).limits.claimLockTimeoutMs === 500
      && resolveReviewPoolLimits({ PROJECTX_REVIEW_CLAIM_LOCK_TIMEOUT_MS: "0" }).limits.claimLockTimeoutMs === 3000
      && resolveReviewPoolLimits({ PROJECTX_REVIEW_CLAIM_LOCK_TIMEOUT_MS: "abc" }).notices[0].includes("按默认值")
      && resolveReviewPoolLimits({ PROJECTX_REVIEW_CLAIM_LOCK_TIMEOUT_MS: "999999" }).limits.claimLockTimeoutMs === 30000,
      "领取锁预算同样三档：可收紧、设 0 不会关掉临界区、超天花板被夹紧");
    check(describeReviewPoolLimits().includes("maxHeldPapersPerBlock=20")
      && describeReviewPoolLimits().includes("claimLockTimeoutMs=3000"),
      "试卷池配额与锁预算进入启动摘要，与上传上限一致的可见性");

    // ── 备份恢复解压预算与运维错误脱敏（安全 R43 / R25）
    const {
      resolveRestoreZipLimits, DEFAULT_RESTORE_ZIP_LIMITS, RESTORE_ZIP_ENV_VARS, describeRestoreZipLimits,
      MAX_RESTORE_ZIP_ENTRIES, MAX_RESTORE_ZIP_ENTRY_BYTES, MAX_RESTORE_ZIP_TOTAL_BYTES, MAX_RESTORE_ZIP_RATIO
    } = await import("../src/shared/restoreZipLimits");
    check(RESTORE_ZIP_ENV_VARS.slice().sort().join() === restoreZipEnvVarsClearedHere.slice().sort().join()
      && RESTORE_ZIP_ENV_VARS.every((name) => !(name in process.env)),
      "脚本清理的 PROJECTX_RESTORE_ZIP_* 名单与解压预算表逐一对应，宿主机变量不会渗入默认预算断言");
    check(MAX_RESTORE_ZIP_ENTRIES === DEFAULT_RESTORE_ZIP_LIMITS.maxZipEntries && MAX_RESTORE_ZIP_ENTRIES === 20000
      && MAX_RESTORE_ZIP_ENTRY_BYTES === 1024 * 1024 * 1024 && MAX_RESTORE_ZIP_TOTAL_BYTES === 6144 * 1024 * 1024,
      "未配置时按默认解压预算生效（2 万条目 / 单条 1GiB / 累计 6GiB），上传侧 128MiB 不再是唯一的闸");
    check(resolveRestoreZipLimits({ PROJECTX_RESTORE_ZIP_MAX_ENTRIES: "100" }).limits.maxZipEntries === 100
      && resolveRestoreZipLimits({ PROJECTX_RESTORE_ZIP_MAX_TOTAL_MIB: "abc" }).limits.maxTotalUncompressedBytes
        === DEFAULT_RESTORE_ZIP_LIMITS.maxTotalUncompressedBytes
      && resolveRestoreZipLimits({ PROJECTX_RESTORE_ZIP_MAX_ENTRY_MIB: "999999" }).limits.maxEntryUncompressedBytes
        === 8192 * 1024 * 1024,
      "解压预算可收紧、非法值回落默认、超天花板被夹紧（一个拼错的数字关不掉保护）");
    check(MAX_RESTORE_ZIP_RATIO === DEFAULT_RESTORE_ZIP_LIMITS.maxCompressionRatio
      && MAX_RESTORE_ZIP_RATIO === 1032
      && resolveRestoreZipLimits({ PROJECTX_RESTORE_ZIP_MAX_RATIO: "8" }).limits.maxCompressionRatio === 8
      && resolveRestoreZipLimits({ PROJECTX_RESTORE_ZIP_MAX_RATIO: "0" }).limits.maxCompressionRatio === 1032
      && resolveRestoreZipLimits({ PROJECTX_RESTORE_ZIP_MAX_RATIO: "abc" }).notices[0].includes("按默认值")
      && resolveRestoreZipLimits({ PROJECTX_RESTORE_ZIP_MAX_RATIO: "999999" }).limits.maxCompressionRatio === 1032
      && resolveRestoreZipLimits({ PROJECTX_RESTORE_ZIP_MAX_RATIO: "999999" }).notices[0].includes("天花板"),
      "最坏展开比同样三档：可收紧、设 0 与非法值不会关掉预估、超天花板被夹紧（1032:1 是 DEFLATE 的物理上界，放宽没有意义）");
    check(describeRestoreZipLimits().includes("≤20000") && describeRestoreZipLimits().includes("6144MiB")
      && describeRestoreZipLimits().includes("1032"),
      "解压预算与最坏展开比进入启动摘要");
    const {
      classifyEntryName, resolveEntryDest, checkEntryBudget, worstCaseEntryBytes, extractZipWithinBudget, RestoreZipError
    } = await import("../src/server/services/restoreZip");
    const { sanitizeOpsMessage, containsHostPath } = await import("../src/server/lib/opsErrorMessage");
    const AdmZip = (await import("adm-zip")).default;
    const rejectStatus = (run: () => void): number => {
      try { run(); return 0; } catch (err) { return err instanceof RestoreZipError ? err.status : -1; }
    };

    check(classifyEntryName("metadata.json").safe && classifyEntryName("data/answer-card/papers/a.png").safe,
      "合法条目名通过解压前的路径判定");
    check(!classifyEntryName("../escape.txt").safe && !classifyEntryName("data/../../escape.txt").safe
      && !classifyEntryName("/etc/passwd").safe && !classifyEntryName("C:\\Windows\\x.db").safe
      && !classifyEntryName("..\\escape.txt").safe,
      "相对越界、绝对路径、Windows 盘名与反斜杠写法全部判为非法（此前是剥掉前缀继续解，等于默认目录可被改写）");
    const r43Dir = path.join(tempDir, "r43-restore");
    mkdirSync(r43Dir, { recursive: true });
    const goodZip = new AdmZip();
    goodZip.addFile("metadata.json", Buffer.from(JSON.stringify({ version: 1, files: [] })));
    goodZip.addFile("data/answer-card/papers/p1.png", pngBytes);
    check(rejectStatus(() => extractZipWithinBudget(goodZip.toBuffer(), r43Dir)) === 0
      && existsSync(path.join(r43Dir, "data", "answer-card", "papers", "p1.png")),
      "预算内的正常备份逐条落盘（收紧没有打断恢复主流程）");
    const slipZip = new AdmZip();
    slipZip.addFile("metadata.json", Buffer.from(JSON.stringify({ version: 1 })));
    // adm-zip 的写入端会把条目名归一化（`../x` → `x`），所以伪造越界条目只能直接改 ZIP 字节：
    // 等长替换（13 字符 → 13 字符）不会破坏 CRC 与偏移，解出来的 entryName 就是 `../r43esc.png`。
    const renameZipEntry = (zipBuf: Buffer, from: string, to: string): Buffer => {
      if (from.length !== to.length) throw new Error("等长替换才能保持 ZIP 头部偏移");
      const out = Buffer.from(zipBuf);
      const needle = Buffer.from(from, "latin1");
      const repl = Buffer.from(to, "latin1");
      for (let at = out.indexOf(needle); at >= 0; at = out.indexOf(needle, at + needle.length)) {
        repl.copy(out, at);
      }
      return out;
    };
    const slipBody = (() => {
      const inner = new AdmZip();
      inner.addFile("safe-name.png", pngBytes);
      return renameZipEntry(inner.toBuffer(), "safe-name.png", "../r43esc.png");
    })();
    check(rejectStatus(() => extractZipWithinBudget(slipBody, r43Dir)) === 400
      && !existsSync(path.join(tempDir, "r43esc.png")),
      "含 .. 越界条目的备份被 400 整体拒绝，而不是跳过该条目后继续恢复出半成品");
    check(rejectStatus(() => resolveEntryDest(r43Dir, "C:\\Windows\\x.db")) === 400, "盘符绝对路径条目被拒绝");
    check(rejectStatus(() => checkEntryBudget({ entries: 0, bytes: 0 }, MAX_RESTORE_ZIP_ENTRIES + 1, 0, 0)) === 413
      && rejectStatus(() => checkEntryBudget({ entries: 0, bytes: 0 }, 1, MAX_RESTORE_ZIP_ENTRY_BYTES + 1, 0)) === 413
      && rejectStatus(() => checkEntryBudget(
        { entries: 0, bytes: MAX_RESTORE_ZIP_TOTAL_BYTES - 1024 }, 1, 0, 4096)) === 413,
      "条目数 / 单条解压体积 / 累计解压体积三道预算各自越界即 413（ZIP 头声明的体积不再被无条件相信）");
    check(rejectStatus(() => {
      const state = { entries: 0, bytes: 0 };
      checkEntryBudget(state, 1, 1, MAX_RESTORE_ZIP_ENTRY_BYTES + 1);
    }) === 413, "头部声明很小、实际读出体积巨大的谎报条目同样被拦下");
    // PR #312 CR13：把「解压后体积」这一栏改成 0，就是解压炸弹的谎报签名——解压库把输出上限
    // 设为声明值，声明 0 等于不封顶（adm-zip 0.6.0 的 Inflater 正是只在声明值 >0 时才设上限，
    // 0.6.1 才有 1 字节地板；本仓库不依赖库版本，预估越界就在 getData() 之前拒掉）。
    // 写入端永远写诚实头部，所以谎报只能靠改 ZIP 字节伪造：偏移量在头结构里是定长 4 字节字段，
    // 归零不改动长度，其余偏移与 CRC 全部保持自洽，adm-zip 仍能正常索引出这一条。
    const wipeUncompressedSize = (zipBuf: Buffer): Buffer => {
      const out = Buffer.from(zipBuf);
      const wipe = (signature: number[], fieldOffset: number) => {
        const sig = Buffer.from(signature);
        for (let at = out.indexOf(sig); at >= 0; at = out.indexOf(sig, at + 1)) out.writeUInt32LE(0, at + fieldOffset);
      };
      wipe([0x50, 0x4b, 0x01, 0x02], 24); // 中央目录：解压后体积
      wipe([0x50, 0x4b, 0x03, 0x04], 22); // 本地头：同一栏
      return out;
    };
    // 2 MiB 伪随机负载压不动（DEFLATE 输出≈原体积），所以它的压缩栏是诚实的大数，解压栏被谎报为 0。
    const liarPayload = Buffer.alloc(2 * 1024 * 1024);
    for (let i = 0; i < liarPayload.length; i += 4) liarPayload.writeUInt32LE((i * 2654435761) >>> 0, i);
    const liarZip = (() => {
      const pack = new AdmZip();
      pack.addFile("liar.bin", liarPayload);
      return pack.toBuffer();
    })();
    const liarEntries = new AdmZip(wipeUncompressedSize(liarZip)).getEntries();
    check(liarEntries.length === 1 && Number(liarEntries[0].header.size) === 0
      && Number(liarEntries[0].header.compressedSize) > 1024 * 1024,
      "伪造包仍被 adm-zip 索引为一条「声明 0 字节、压缩负载 2 MiB」的条目（伪造没有把包直接解坏）");
    const r43LiarDir = path.join(tempDir, "r43-liar");
    mkdirSync(r43LiarDir, { recursive: true });
    let liarError: RestoreZipError | null = null;
    try {
      extractZipWithinBudget(wipeUncompressedSize(liarZip), r43LiarDir);
    } catch (err) {
      liarError = err instanceof RestoreZipError ? err : null;
      if (!liarError) throw err;
    }
    check(liarError !== null && liarError.status === 413 && !containsHostPath(liarError.message),
      "谎报条目在进入解压前就被 413 拒掉，而不是解完才发现（状态码 413 而非库自身封顶的 400，证明确实拦在 getData 之前）");
    check(liarError !== null && liarError.message.includes("声明为 0") && !liarError.message.includes("liar.bin"),
      "拒绝消息说明是谎报签名，且不带条目名以外的主机路径信息");
    check(!existsSync(path.join(r43LiarDir, "liar.bin")) && readdirSync(r43LiarDir).length === 0,
      "被拒的谎报包没有落盘任何文件");
    check(worstCaseEntryBytes(8, 1024, 0) === 1024 * MAX_RESTORE_ZIP_RATIO
      && worstCaseEntryBytes(0, 1024, 0) === 1024
      && worstCaseEntryBytes(8, 1024, 5) === 5
      && worstCaseEntryBytes(99, 1024, 0) === 0,
      "最坏展开预估只在「声明为 0」时生效：DEFLATE 按倍率、STORED 按负载本身、诚实声明照声明算、未知方法不预估");
    const r43HonestDir = path.join(tempDir, "r43-honest");
    mkdirSync(r43HonestDir, { recursive: true });
    check(rejectStatus(() => extractZipWithinBudget(liarZip, r43HonestDir)) === 0
      && readFileSync(path.join(r43HonestDir, "liar.bin")).equals(liarPayload),
      "同一份包只要头部诚实就照常恢复（收紧只针对谎报，不误伤真实备份）");
    const corruptStatus = rejectStatus(() =>
      extractZipWithinBudget(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(512, 0x41)]), r43Dir));
    check(corruptStatus === 400 || corruptStatus === 0,
      "损坏 ZIP 只会被判为格式非法或无条目可解，不会抛出未分类错误变成 500");
    const r43Http = await fetch(`${base}/api/db/restore`, {
      method: "POST",
      headers: { ...authHeaders(adminToken), "Content-Type": "application/zip" },
      body: slipBody
    });
    const r43HttpBody = await r43Http.json() as { code?: string; message?: string };
    check(r43Http.status === 400 && r43HttpBody.code === "RESTORE_ZIP_REJECTED"
      && !containsHostPath(r43HttpBody.message ?? "") && !(r43HttpBody.message ?? "").includes(tempDir),
      "恢复接口按解压预算 400 拒绝，且响应体不带出服务端目录");
    const r43Teacher = await fetch(`${base}/api/db/restore`, {
      method: "POST",
      headers: { ...authHeaders(teacherToken), "Content-Type": "application/zip" },
      body: slipZip.toBuffer()
    });
    check(r43Teacher.status === 403, "恢复接口仍只对具备系统管理权限的账号开放（预算闸门口没有扩大攻击面）");
    const leakyCopy = "ENOENT: no such file or directory, copyfile '/var/lib/projectx/data/projectx.db' -> "
      + "'C:\\Users\\teacher\\AppData\\Local\\Temp\\projectx-restore-1\\projectx.db'";
    const leakyCleaned = sanitizeOpsMessage(leakyCopy, { fallback: "导入失败" });
    check(!containsHostPath(leakyCleaned) && leakyCleaned.includes("ENOENT"),
      "恢复失败摘要保留错误类别（ENOENT）但抹掉 POSIX 与 Windows 绝对路径");
    const mysqlLeak = "ERROR 1045 (28000): Access denied for user 'projectx_app'@'10.0.0.7' (using password: YES)";
    const mysqlCleaned = sanitizeOpsMessage(mysqlLeak, { fallback: "数据库导入失败" });
    check(!mysqlCleaned.includes("projectx_app") && !mysqlCleaned.includes("10.0.0.7")
      && mysqlCleaned.includes("1045"),
      "mysql 导入失败摘要不再外送数据库账号与内网主机，仅保留错误码");
    check(sanitizeOpsMessage("read ECONNRESET", { fallback: "导入失败" }) === "read ECONNRESET"
      && sanitizeOpsMessage("", { fallback: "导入失败" }) === "导入失败",
      "无路径信息的安全摘要保持原样，空消息回落到固定文案");

    // ── 原卷累计容量与上传残留（安全 R10 / R14）
    const {
      PAPER_STORAGE_ENV_VARS, DEFAULT_PAPER_STORAGE_LIMITS, resolvePaperStorageLimits,
      describePaperStorageLimits, MAX_PAPER_FILE_BYTES, MAX_PAPER_PAGES_PER_CARD, MAX_PAPER_FILES_PER_REQUEST
    } = await import("../src/shared/paperStorageLimits");
    check(PAPER_STORAGE_ENV_VARS.slice().sort().join() === paperStorageEnvVarsClearedHere.slice().sort().join()
      && PAPER_STORAGE_ENV_VARS.every((name) => !(name in process.env)),
      "脚本清理的 PROJECTX_PAPER_* 名单与容量表逐一对应，宿主机变量不会渗入默认容量断言");
    check(MAX_PAPER_FILE_BYTES === DEFAULT_PAPER_STORAGE_LIMITS.maxPaperFileBytes
      && MAX_PAPER_PAGES_PER_CARD === DEFAULT_PAPER_STORAGE_LIMITS.maxPaperPagesPerCard
      && resolvePaperStorageLimits({}).notices.length === 0,
      "未配置时按默认原卷容量档位生效（单文件 50MiB / 单卡 60 页），且不产生告警噪音");
    check(resolvePaperStorageLimits({ PROJECTX_PAPER_MAX_PAGES_PER_CARD: "8" }).limits.maxPaperPagesPerCard === 8
      && resolvePaperStorageLimits({ PROJECTX_PAPER_MAX_FILE_MIB: "abc" }).limits.maxPaperFileBytes
        === DEFAULT_PAPER_STORAGE_LIMITS.maxPaperFileBytes
      && resolvePaperStorageLimits({ PROJECTX_PAPER_MAX_TOTAL_MIB: "999999" }).limits.maxPaperBytesTotal
        === 204800 * 1024 * 1024,
      "容量可收紧、非法值回落默认、超天花板被夹紧（一个拼错的数字关不掉容量保护）");
    check(describePaperStorageLimits().includes("≤60") && describePaperStorageLimits().includes("20480MiB"),
      "原卷容量档位进入启动摘要");

    const {
      evaluatePaperQuota, purgeStaleTmpUploads, readPaperQuota, readPapersTotalBytes, invalidatePaperUsageCache
    } = await import("../src/apps/answer-card/server/paperQuota");
    const r10Limits = { maxPaperPagesPerCard: 3, maxPaperBytesPerCard: 4096, maxPaperBytesTotal: 8192 };
    check(evaluatePaperQuota(
      { cardPages: 2, cardBytes: 100, totalBytes: 100, totalExact: true }, { pages: 1, bytes: 0 }, r10Limits).ok === true,
      "恰好补满上限的上传放行：磁盘实测可能只是下界，等于上限时宁可不拒");
    const r10Pages = evaluatePaperQuota(
      { cardPages: 3, cardBytes: 0, totalBytes: 0, totalExact: true }, { pages: 1, bytes: 0 }, r10Limits);
    const r10CardBytes = evaluatePaperQuota(
      { cardPages: 0, cardBytes: 4096, totalBytes: 0, totalExact: true }, { pages: 1, bytes: 1 }, r10Limits);
    const r10TotalBytes = evaluatePaperQuota(
      { cardPages: 0, cardBytes: 0, totalBytes: 8192, totalExact: true }, { pages: 1, bytes: 1 }, r10Limits);
    check(!r10Pages.ok && r10Pages.reason === "pages" && !r10CardBytes.ok && r10CardBytes.reason === "card-bytes"
      && !r10TotalBytes.ok && r10TotalBytes.reason === "total-bytes",
      "页数 / 单卡体积 / 全局体积三条容量线各自越界时给出对应原因（此前只有「单文件 50MB」一道闸）");
    check(!containsHostPath(r10Pages.message) && r10Pages.message.includes("PROJECTX_PAPER_MAX_PAGES_PER_CARD"),
      "容量拒绝文案只给档位与调整入口，不外泄服务端目录");

    const r10CardId = "critical-r10-card";
    const r10Dir = path.join(process.env.ANSWER_CARD_DATA_DIR!, "papers", r10CardId);
    mkdirSync(r10Dir, { recursive: true });
    writeFileSync(path.join(r10Dir, "original-1.jpg"), Buffer.alloc(3072, 7));
    writeFileSync(path.join(r10Dir, "original-1.pdf"), Buffer.alloc(1024, 7));
    db.prepare("INSERT INTO original_paper_pages (card_id, page_index, filename, stored_path) VALUES (?,?,?,?)")
      .run(r10CardId, 1, "original-1.jpg", `papers/${r10CardId}/original-1.jpg`);
    const quotaDb = (await import("../src/server/db")).getMysqlDb();
    const r10Snapshot = await readPaperQuota(quotaDb, r10CardId);
    check(r10Snapshot.cardPages === 1 && r10Snapshot.cardBytes === 4096,
      "单卡占用按磁盘实测：配生的 PDF 与 jpg 一并计入（表里没有体积列，加列对存量部署等于没保护）");
    const r10BeforeTotal = await readPapersTotalBytes();
    writeFileSync(path.join(r10Dir, "original-2.jpg"), Buffer.alloc(2048, 1));
    const r10CachedTotal = await readPapersTotalBytes();
    invalidatePaperUsageCache();
    const r10FreshTotal = await readPapersTotalBytes();
    check(r10CachedTotal.bytes === r10BeforeTotal.bytes && r10FreshTotal.bytes >= r10BeforeTotal.bytes + 2048,
      "全局用量走 TTL 缓存、上传/删除后即时失效（否则每次上传都要全目录走一遍）");

    const r14TmpDir = path.join(process.env.ANSWER_CARD_DATA_DIR!, "papers", "_tmp");
    mkdirSync(r14TmpDir, { recursive: true });
    const r14Stale = path.join(r14TmpDir, "r14-stale.tmp");
    const r14Fresh = path.join(r14TmpDir, "r14-fresh.tmp");
    writeFileSync(r14Stale, "stale");
    writeFileSync(r14Fresh, "fresh");
    const r14Old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    utimesSync(r14Stale, r14Old, r14Old);
    mkdirSync(path.join(r14TmpDir, "r14-subdir"), { recursive: true });
    check(await purgeStaleTmpUploads(r14TmpDir) === 1 && !existsSync(r14Stale)
      && existsSync(r14Fresh) && existsSync(path.join(r14TmpDir, "r14-subdir")),
      "滞留临时件按存活期清理：新件与目录不被动（不会误删正在上传的请求）");
    // 清掉上一步留下的样例，让 `_tmp` 回到空目录，下面「越界上传后残留为 0」才是真边界
    rmSync(r14Fresh);
    rmSync(path.join(r14TmpDir, "r14-subdir"), { recursive: true });
    const r14Form = new FormData();
    for (let i = 0; i < MAX_PAPER_FILES_PER_REQUEST + 1; i += 1) {
      r14Form.append("files", new Blob([pngBytes], { type: "image/png" }), `r14-${i}.png`);
    }
    const r14Overflow = await fetch(`${base}/api/cards/critical-r14-card/paper`, {
      method: "POST", headers: authHeaders(teacherToken), body: r14Form
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const r14Residue = existsSync(r14TmpDir)
      ? readdirSync(r14TmpDir, { withFileTypes: true }).filter((entry) => entry.isFile()).length : 0;
    check(r14Overflow.status === 400,
      `超过每请求文件数时原卷上传被拒（实际 ${r14Overflow.status}）`);
    check(r14Residue === 0,
      "multer 越界拒绝后临时目录不留已落盘文件（越界重试不再是免费的填满磁盘攻击）");

    // ── AI 计费与并发配额（安全 R11）
    const {
      AI_QUOTA_ENV_VARS, DEFAULT_AI_QUOTA_LIMITS, resolveAiQuotaLimits, describeAiQuotaLimits,
      MAX_AI_ACTIVE_JOBS_PER_USER, MAX_AI_ACTIVE_JOBS_GLOBAL, MAX_AI_RUNS_PER_USER_HOUR, MAX_AI_TOKENS_PER_USER_DAY,
      AI_ACTIVE_RUN_STALE_MS, AI_ADMISSION_LOCK_TIMEOUT_MS
    } = await import("../src/shared/aiQuotaLimits");
    check(AI_QUOTA_ENV_VARS.slice().sort().join() === aiQuotaEnvVarsClearedHere.slice().sort().join()
      && AI_QUOTA_ENV_VARS.every((name) => !(name in process.env)),
      "脚本清理的 PROJECTX_AI_* 名单与配额表逐一对应，宿主机变量不会渗入默认配额断言");
    check(MAX_AI_ACTIVE_JOBS_PER_USER === DEFAULT_AI_QUOTA_LIMITS.maxActiveJobsPerUser
      && MAX_AI_TOKENS_PER_USER_DAY === 1000000
      && AI_ACTIVE_RUN_STALE_MS === DEFAULT_AI_QUOTA_LIMITS.activeRunStaleMs
      && AI_ADMISSION_LOCK_TIMEOUT_MS === DEFAULT_AI_QUOTA_LIMITS.admissionLockTimeoutMs,
      "未配置时按默认 AI 配额生效（单用户 2 个在途 / 24 小时 100 万 tokens / 占位 5 分钟失效 / 等锁 2 秒）");
    check(resolveAiQuotaLimits({ PROJECTX_AI_MAX_RUNS_PER_HOUR: "3" }).limits.maxRunsPerUserHour === 3
      && resolveAiQuotaLimits({ PROJECTX_AI_MAX_TOKENS_PER_DAY: "0" }).limits.maxTokensPerUserDay
        === DEFAULT_AI_QUOTA_LIMITS.maxTokensPerUserDay
      && resolveAiQuotaLimits({ PROJECTX_AI_MAX_ACTIVE_JOBS_GLOBAL: "99999" }).limits.maxActiveJobsGlobal === 100
      && resolveAiQuotaLimits({ PROJECTX_AI_ACTIVE_RUN_STALE_MS: "60000" }).limits.activeRunStaleMs === 60000
      && resolveAiQuotaLimits({ PROJECTX_AI_ACTIVE_RUN_STALE_MS: "-1" }).limits.activeRunStaleMs
        === DEFAULT_AI_QUOTA_LIMITS.activeRunStaleMs
      && resolveAiQuotaLimits({ PROJECTX_AI_ADMISSION_LOCK_TIMEOUT_MS: "999999" }).limits.admissionLockTimeoutMs === 30000,
      "AI 配额可收紧、非法值回落默认、超天花板被夹紧（含在途失效窗口与等锁预算两档新档位）");
    check(describeAiQuotaLimits().includes("≤2") && describeAiQuotaLimits().includes("1000000")
      && describeAiQuotaLimits().includes("300 秒") && describeAiQuotaLimits().includes("2 秒"),
      "AI 配额档位（含在途占位窗口与等锁预算）进入启动摘要");
    const { evaluateAiQuota, readAiQuotaSnapshot, reserveAiCall, AiQuotaError } = await import("../src/server/services/aiQuota");
    check(evaluateAiQuota({
      activeJobsForUser: MAX_AI_ACTIVE_JOBS_PER_USER - 1, activeJobsGlobal: 0, runsLastHour: 0, tokensLastDay: 0
    }).ok === true, "未到并发线的用户照常提交分析（配额没有变成默认拒绝）");
    const aiUserJobs = evaluateAiQuota({
      activeJobsForUser: MAX_AI_ACTIVE_JOBS_PER_USER, activeJobsGlobal: 0, runsLastHour: 0, tokensLastDay: 0
    });
    const aiGlobalJobs = evaluateAiQuota({
      activeJobsForUser: 0, activeJobsGlobal: MAX_AI_ACTIVE_JOBS_GLOBAL, runsLastHour: 0, tokensLastDay: 0
    });
    const aiRuns = evaluateAiQuota({
      activeJobsForUser: 0, activeJobsGlobal: 0, runsLastHour: MAX_AI_RUNS_PER_USER_HOUR, tokensLastDay: 0
    });
    const aiTokens = evaluateAiQuota({
      activeJobsForUser: 0, activeJobsGlobal: 0, runsLastHour: 0, tokensLastDay: MAX_AI_TOKENS_PER_USER_DAY
    });
    check(!aiUserJobs.ok && aiUserJobs.reason === "maxActiveJobsPerUser"
      && !aiGlobalJobs.ok && aiGlobalJobs.reason === "maxActiveJobsGlobal"
      && !aiRuns.ok && aiRuns.reason === "maxRunsPerUserHour"
      && !aiTokens.ok && aiTokens.reason === "maxTokensPerUserDay",
      "并发（单用户/全局）与计费（次/天 tokens）四条线各自越界时给出对应原因");
    check([aiUserJobs, aiGlobalJobs, aiRuns, aiTokens].every((verdict) => !("ok" in verdict && verdict.ok))
      && aiTokens.retryAfterSeconds === 86400 && aiUserJobs.retryAfterSeconds === 30
      && !containsHostPath(aiTokens.message),
      "拒绝按维度给出重试间隔（并发 30 秒、日用量 24 小时），文案不含主机信息");
    const r11JobA = Number(db.prepare("INSERT INTO ai_analysis_jobs (exam_id,status,created_by) VALUES (?, 'queued', ?)")
      .run(visibleExam, teacher.id).lastInsertRowid);
    const r11JobB = Number(db.prepare("INSERT INTO ai_analysis_jobs (exam_id,status,created_by) VALUES (?, 'running', ?)")
      .run(visibleExam, teacher.id).lastInsertRowid);
    const r11Base = await readAiQuotaSnapshot(quotaDb, teacher.id);
    // 观测记录的 created_at 有两种真实形态：列默认值（SQLite 写空格分隔的 UTC）与应用侧 ISO。
    // 窗口判定必须都算进来，否则配额在 SQLite 上「看着生效、实际恒为 0」。
    // success 显式给 1：这些行代表「已结算的历史用量」，只进计费维度，不占并发名额。
    const r11RunIds: number[] = [];
    const insertR11Run = (tokensIn: number, tokensOut: number, createdAtSql: string, ...extra: unknown[]): void => {
      r11RunIds.push(Number(db.prepare(
        `INSERT INTO ai_analysis_runs (user_id, feature, success, tokens_in, tokens_out, created_at) VALUES (?,?,1,?,?,${createdAtSql})`)
        .run(teacher.id, "exam_analysis", tokensIn, tokensOut, ...extra).lastInsertRowid));
    };
    insertR11Run(1200, 300, "CURRENT_TIMESTAMP");
    insertR11Run(500, 200, "?", new Date().toISOString());
    // 窗口外的两条（24 小时之外）：证明统计是真窗口而不是全表
    insertR11Run(90000, 90000, "?", new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString());
    insertR11Run(80000, 80000, "?",
      new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19));
    // 在途行（success IS NULL）：PR #312 CR8 后它就是同步调用占住的名额
    const r11PendingRun = Number(db.prepare(
      "INSERT INTO ai_analysis_runs (user_id, feature, stage, success) VALUES (?, 'knowledge_points', 'request', NULL)")
      .run(teacher.id).lastInsertRowid);
    r11RunIds.push(r11PendingRun);
    const r11Snapshot = await readAiQuotaSnapshot(quotaDb, teacher.id);
    // 该教师此时有：1 个 queued 任务、1 个 running 任务、1 条在途运行行。
    // 名额必须是 2 而不是 3——running 任务行不自己占位，它占的是那条在途运行行（CR8 的分工）。
    check(r11Snapshot.queuedJobs!.user === r11Base.queuedJobs!.user
      && r11Snapshot.inFlightRuns!.user === r11Base.inFlightRuns!.user + 1
      && r11Snapshot.activeJobsForUser === r11Snapshot.queuedJobs!.user + r11Snapshot.inFlightRuns!.user
      && r11Snapshot.activeJobsForUser === r11Base.activeJobsForUser + 1
      && r11Snapshot.activeJobsGlobal >= r11Snapshot.activeJobsForUser
      && r11Snapshot.runsLastHour === r11Base.runsLastHour + 3
      && r11Snapshot.tokensLastDay === r11Base.tokensLastDay + 2200,
      "并发名额 = 排队任务 + 在途调用（running 的任务行由它的运行行接手，不重复占位）；已结算行只进计费维度，两种时间格式都计入、窗口外的两条不计");
    // 崩溃残留的在途行（没人回填 success）不能永久压着名额：超过失效窗口就不再占用，
    // 但它确实发起过一次调用，计费账本里仍然算数。
    const r11ZombieRun = Number(db.prepare(
      "INSERT INTO ai_analysis_runs (user_id, feature, success, created_at) VALUES (?,?,NULL,?)")
      .run(teacher.id, "knowledge_points", new Date(Date.now() - (AI_ACTIVE_RUN_STALE_MS + 60_000)).toISOString())
      .lastInsertRowid);
    const r11ZombieSnapshot = await readAiQuotaSnapshot(quotaDb, teacher.id);
    check(r11ZombieSnapshot.inFlightRuns!.user === r11Snapshot.inFlightRuns!.user
      && r11ZombieSnapshot.activeJobsForUser === r11Snapshot.activeJobsForUser
      && r11ZombieSnapshot.runsLastHour === r11Snapshot.runsLastHour + 1,
      "在途占位有失效窗口：超时残留不再压着并发名额，但依然计入调用次数");
    check((await readAiQuotaSnapshot(quotaDb, null)).activeJobsForUser === 0
      && (await readAiQuotaSnapshot(quotaDb, -1)).tokensLastDay === 0,
      "无身份调用不虚构他人账本（读的是 0，而不是把全表当成某人用量）");
    check((await readAiQuotaSnapshot(quotaDb, student.id)).activeJobsForUser === 0
      && (await readAiQuotaSnapshot(quotaDb, student.id)).runsLastHour === 0,
      "配额按人归因：教师占满不会把学生一起挡在门外");
    const r11Http = await fetch(`${base}/api/analysis/exams/${visibleExam}/ai-analysis`, {
      method: "POST", headers: { "Content-Type": "application/json", ...authHeaders(teacherToken) }, body: "{}"
    });
    const r11Body = await r11Http.json().catch(() => ({})) as { code?: string; message?: string };
    check(r11Http.status === 429 && r11Body.code === "AI_QUOTA_EXCEEDED"
      && Number(r11Http.headers.get("retry-after")) === 30,
      "并发配额已满时提交分析返回 429 + Retry-After，而不是排到队列里再慢慢失败");
    check(!(r11Body.message ?? "").includes(tempDir) && !containsHostPath(r11Body.message ?? ""),
      "配额拒绝响应不带服务端目录");
    // 学生入口：先让该学生「有成绩 + 成绩已公布」，请求才会走到配额闸门（此前的 403 是查分门）。
    // 用一个临时考试，避免给可见考试插入未评分的应考记录干扰后续断言。
    const r11StuExam = Number(db.prepare(
      "INSERT INTO exams (name,card_id,grade_id,class_id,subject,status,score_published,created_by) VALUES (?,?,?,?,?,'closed',1,?)")
      .run("配额专用考试", "critical-card", grade.id, classA, "数学", teacher.id).lastInsertRowid);
    db.prepare("INSERT INTO student_scores (exam_id, student_id, total_score) VALUES (?,?,?)")
      .run(r11StuExam, student.id, 88);
    const r11StudentJobs: number[] = [];
    for (let i = 0; i < MAX_AI_ACTIVE_JOBS_PER_USER; i += 1) {
      r11StudentJobs.push(Number(db.prepare("INSERT INTO ai_analysis_jobs (exam_id,status,created_by) VALUES (?, 'queued', ?)")
        .run(r11StuExam, student.id).lastInsertRowid));
    }
    const r11JobCountBefore = Number((db.prepare("SELECT COUNT(*) AS c FROM ai_analysis_jobs").get() as { c: number }).c);
    const r11Student = await fetch(`${base}/api/scores/me/exams/${r11StuExam}/ai-analysis`, {
      method: "POST", headers: { "Content-Type": "application/json", ...authHeaders(studentToken) }, body: "{}"
    });
    const r11StudentBody = await r11Student.json().catch(() => ({})) as { code?: string; message?: string };
    check(r11Student.status === 429 && r11StudentBody.code === "AI_QUOTA_EXCEEDED"
      && Number((db.prepare("SELECT COUNT(*) AS c FROM ai_analysis_jobs").get() as { c: number }).c) === r11JobCountBefore,
      `学生入口走的是同一道闸门，被拒请求不落任务行（实际 ${r11Student.status}）`);
    db.prepare("DELETE FROM ai_analysis_jobs WHERE id IN (?,?)").run(r11JobA, r11JobB);
    for (const jobId of r11StudentJobs) db.prepare("DELETE FROM ai_analysis_jobs WHERE id=?").run(jobId);
    db.prepare("DELETE FROM student_scores WHERE exam_id=?").run(r11StuExam);
    db.prepare("DELETE FROM exams WHERE id=?").run(r11StuExam);
    db.prepare(`DELETE FROM ai_analysis_runs WHERE id IN (${[...r11RunIds, r11ZombieRun].map(() => "?").join(",")})`)
      .run(...r11RunIds, r11ZombieRun);
    check(AiQuotaError.name === "AiQuotaError", "配额错误类型可被路由单独识别（不会与 AI 服务故障混为一谈）");

    // ── PR #312 CR9：并发准入必须原子「检查 + 占位」
    // 旧的写法是先 assertAiQuota 再建任务：一波并发请求读到的是同一份空账本，
    // 12 个请求会全部放行（评审实测活动任务达到 11，上限 8）。现在只有名额内的能成。
    check((await readAiQuotaSnapshot(quotaDb, teacher.id)).activeJobsForUser === 0,
      "并发突发前教师账本已清空（否则下面数的是残留而不是突发）");
    const { reserveAiAnalysisJob } = await import("../src/server/services/aiAnalysisJobs");
    const { finalizeAiRun } = await import("../src/server/services/aiTelemetry");
    const r11BurstSize = MAX_AI_ACTIVE_JOBS_PER_USER + 4;
    const r11JobBurst = await Promise.allSettled(
      Array.from({ length: r11BurstSize }, () => reserveAiAnalysisJob({ examId: visibleExam, createdBy: teacher.id }))
    );
    const admittedValue = (r: PromiseSettledResult<number>): number | null => (r.status === "fulfilled" ? r.value : null);
    const r11JobAdmitted = r11JobBurst.map(admittedValue).filter((v): v is number => v !== null);
    const r11QueuedNow = Number((db.prepare(
      "SELECT COUNT(*) AS c FROM ai_analysis_jobs WHERE created_by = ? AND status = 'queued'")
      .get(teacher.id) as { c: number }).c);
    check(r11JobAdmitted.length === MAX_AI_ACTIVE_JOBS_PER_USER && r11QueuedNow === MAX_AI_ACTIVE_JOBS_PER_USER
      && r11JobBurst.every((r) => r.status === "fulfilled" || r.reason instanceof AiQuotaError),
      `并发提交 ${r11BurstSize} 次只放行名额内的 ${r11JobAdmitted.length} 个，其余以配额错误拒绝且不落任务行`);
    // 同步入口（不建任务行）走的是同一条准入链，两个维度共用同一份名额
    const r11SyncBurst = await Promise.allSettled(
      Array.from({ length: r11BurstSize }, () => reserveAiCall(quotaDb, teacher.id, { feature: "knowledge_points" }))
    );
    const r11PendingRows = Number((db.prepare(
      "SELECT COUNT(*) AS c FROM ai_analysis_runs WHERE user_id = ? AND success IS NULL")
      .get(teacher.id) as { c: number }).c);
    check(r11SyncBurst.every((r) => r.status === "rejected") && r11PendingRows === 0,
      `任务名额被突发占满时，同步调用同样被挡在门外且不写占位行（实际放行 ${r11SyncBurst.filter((r) => r.status === "fulfilled").length} 个）`);
    for (const jobId of r11JobAdmitted) db.prepare("DELETE FROM ai_analysis_jobs WHERE id=?").run(jobId);
    const r11SyncBurst2 = await Promise.allSettled(
      Array.from({ length: r11BurstSize }, () => reserveAiCall(quotaDb, teacher.id, { feature: "knowledge_points" }))
    );
    const r11SyncAdmitted = r11SyncBurst2.map(admittedValue).filter((v): v is number => v !== null);
    check(r11SyncAdmitted.length === MAX_AI_ACTIVE_JOBS_PER_USER
      && r11SyncBurst2.every((r) => r.status === "fulfilled" || r.reason instanceof AiQuotaError)
      && Number((db.prepare("SELECT COUNT(*) AS c FROM ai_analysis_runs WHERE user_id = ? AND success IS NULL")
        .get(teacher.id) as { c: number }).c) === MAX_AI_ACTIVE_JOBS_PER_USER,
      `清空任务名额后再突发同步调用：只放行 ${MAX_AI_ACTIVE_JOBS_PER_USER} 个在途占位（CR8：它们过去完全不占名额）`);
    for (const runId of r11SyncAdmitted) await finalizeAiRun(runId, { success: true, latencyMs: 1 });
    check((await readAiQuotaSnapshot(quotaDb, teacher.id)).activeJobsForUser === 0,
      "在途行回填即释放名额：完成/失败的回填不只是埋点");
    db.prepare("DELETE FROM ai_analysis_runs WHERE user_id = ? AND feature = 'knowledge_points'").run(teacher.id);

    // ── 微信出站超时、并发与绑定配额（安全 R20）
    const {
      WECHAT_ENV_VARS, DEFAULT_WECHAT_LIMITS, resolveWechatLimits, describeWechatLimits,
      WECHAT_REQUEST_TIMEOUT_MS, MAX_WECHAT_BIND_PER_USER_HOUR, MAX_WECHAT_BIND_GLOBAL_PER_MINUTE,
      WECHAT_MAX_CONCURRENT_REQUESTS
    } = await import("../src/shared/wechatLimits");
    check(WECHAT_ENV_VARS.slice().sort().join() === wechatEnvVarsClearedHere.slice().sort().join()
      && WECHAT_ENV_VARS.every((name) => !(name in process.env)),
      "脚本清理的 PROJECTX_WECHAT_* 名单与档位表逐一对应，宿主机变量不会渗入默认出站断言");
    check(WECHAT_REQUEST_TIMEOUT_MS === DEFAULT_WECHAT_LIMITS.requestTimeoutMs
      && WECHAT_MAX_CONCURRENT_REQUESTS === DEFAULT_WECHAT_LIMITS.maxConcurrentRequests,
      "未配置时按默认出站档位生效（8 秒超时 / 并发 4 / 单账号 1 小时 10 次绑定）");
    check(resolveWechatLimits({ PROJECTX_WECHAT_TIMEOUT_MS: "1500" }).limits.requestTimeoutMs === 1500
      && resolveWechatLimits({ PROJECTX_WECHAT_TIMEOUT_MS: "1" }).limits.requestTimeoutMs
        === DEFAULT_WECHAT_LIMITS.requestTimeoutMs
      && resolveWechatLimits({ PROJECTX_WECHAT_MAX_CONCURRENT: "9999" }).limits.maxConcurrentRequests === 32,
      "出站档位可收紧、低于最小可用值回落默认、超天花板被夹紧");
    check(describeWechatLimits().includes(`${WECHAT_REQUEST_TIMEOUT_MS}ms`) && describeWechatLimits().includes("绑定"),
      "微信出站档位进入启动摘要");
    const wechatThrottle = await import("../src/server/services/wechatThrottle");
    let bindAccepted = 0;
    let bindError: unknown = null;
    try {
      for (let i = 0; i < MAX_WECHAT_BIND_PER_USER_HOUR + 1; i += 1) {
        wechatThrottle.takeWechatBindAttempt(700001);
        bindAccepted += 1;
      }
    } catch (error) { bindError = error; }
    check(bindAccepted === MAX_WECHAT_BIND_PER_USER_HOUR && bindError instanceof wechatThrottle.WechatThrottleError
      && bindError.status === 429 && bindError.retryAfterSeconds === 3600
      && !containsHostPath(bindError.message),
      "单账号绑定按小时配额逐次放行到线即拒（无配额时一个脚本就能把 AppID 当日额度打空）");
    wechatThrottle.resetWechatThrottleCounters();
    let globalError: unknown = null;
    try {
      for (let i = 0; i < MAX_WECHAT_BIND_GLOBAL_PER_MINUTE + 1; i += 1) {
        wechatThrottle.takeWechatBindAttempt(700100 + i); // 每个用户只试一次：越过的是全校线
      }
    } catch (error) { globalError = error; }
    check(globalError instanceof wechatThrottle.WechatThrottleError
      && (globalError as Error).message.includes("全校"),
      "全校每分钟总量单独成线（换账号也绕不出去，微信侧频控是按 AppID 算的）");
    wechatThrottle.resetWechatThrottleCounters();
    const nodeHttp = await import("node:http");
    let observedConcurrent = 0;
    let peakConcurrent = 0;
    const wechatProbe = nodeHttp.createServer((req, res) => {
      observedConcurrent += 1;
      peakConcurrent = Math.max(peakConcurrent, observedConcurrent);
      setTimeout(() => {
        observedConcurrent -= 1;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ errcode: 0 }));
      }, 60);
    });
    const hangProbe = nodeHttp.createServer(() => { /* 永不响应：模拟微信侧半挂连接 */ });
    await new Promise<void>((resolve) => wechatProbe.listen(0, "127.0.0.1", resolve));
    await new Promise<void>((resolve) => hangProbe.listen(0, "127.0.0.1", resolve));
    const wechatProbePort = (wechatProbe.address() as { port: number }).port;
    const hangProbePort = (hangProbe.address() as { port: number }).port;
    await Promise.all(Array.from({ length: WECHAT_MAX_CONCURRENT_REQUESTS * 3 }, async () => {
      const response = await wechatThrottle.wechatFetch(`http://127.0.0.1:${wechatProbePort}/token`);
      await response.json();
    }));
    check(peakConcurrent > 1 && peakConcurrent <= WECHAT_MAX_CONCURRENT_REQUESTS,
      "批量公布时的出站呼叫确实受并发闸门约束（超过微信频控只会换来 45009，受害的是全校推送）");
    let timeoutError: unknown = null;
    const timeoutStarted = Date.now();
    try {
      await wechatThrottle.wechatFetch(`http://127.0.0.1:${hangProbePort}/jscode2session`, {}, 400);
    } catch (error) { timeoutError = error; }
    wechatProbe.close();
    hangProbe.close();
    check(timeoutError instanceof wechatThrottle.WechatTimeoutError
      && Date.now() - timeoutStarted < 3000,
      "半挂连接在预算内被判超时（此前不带信号的 fetch 会永久占住这个请求）");

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

    // ── CR2（PR #312 复核）：/complete 部分失败的中间态里，已入库成绩的页面同样不可被上传改写
    // 只看 session.status / record.ocr_status 会漏掉这一态：分组已 saved，会话却没进终态。
    const partialSession = await newScanSession();
    const partialStatus = (db.prepare("SELECT ocr_status FROM twain_scan_records WHERE id=?").get(partialSession.token) as { ocr_status: string }).ocr_status;
    db.prepare("INSERT INTO scanner_submissions (exam_id, session_id, group_id, student_number, state, pages_json) VALUES (?,?,?,?,'saved',?)")
      .run(visibleExam, partialSession.sessionId, "0", "S1001",
        JSON.stringify([{ recordId: partialSession.token, pageNum: 1, side: "front", layoutPage: 1 }]));
    const partialSessionRow = db.prepare("SELECT status FROM twain_scan_sessions WHERE id=?").get(partialSession.sessionId) as { status: string };
    check(partialSessionRow.status !== "completed" && partialStatus !== "completed",
      `夹具自校验：会话停留在部分失败中间态（会话 ${partialSessionRow.status} / 页面 ${partialStatus}）`);
    const savedPageForm = new FormData();
    savedPageForm.append("image", new Blob([pngBytes], { type: "image/png" }), "page.png");
    savedPageForm.append("token", partialSession.token);
    savedPageForm.append("pageNum", "1");
    const savedPageReplay = await fetch(`${base}/api/scanner/upload/sessions/${partialSession.sessionId}/pages`, {
      method: "POST", headers: scannerKeyHeaders, body: savedPageForm
    });
    const savedPageBody = await savedPageReplay.json() as { code?: string; message?: string; examId?: number };
    check(savedPageReplay.status === 409 && savedPageBody.code === "SCAN_PAGE_SAVED",
      `已入库回执的页面上传被 409 SCAN_PAGE_SAVED（实际 ${savedPageReplay.status} ${savedPageBody.code ?? ""}）`);
    check(Number(savedPageBody.examId) === visibleExam, "拒绝响应带上归属考试编号，扫描端能定位是哪场考试的成绩已入库");
    const savedCropForm = new FormData();
    savedCropForm.append("crops", new Blob([pngBytes], { type: "image/png" }), "crop.png");
    savedCropForm.append("manifest", JSON.stringify([validManifest("crop.png")]));
    const savedCrops = await fetch(cropsUrl(partialSession.sessionId, partialSession.token), {
      method: "POST", headers: scannerKeyHeaders, body: savedCropForm
    });
    check(savedCrops.status === 409, "同页切块上传也被拒（阅卷人看到的图不可静默替换）");
    check((db.prepare("SELECT ocr_status FROM twain_scan_records WHERE id=?").get(partialSession.token) as { ocr_status: string }).ocr_status === partialStatus,
      "被拒的上传不产生任何改写，已入库成绩对应的页面原样保留");

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
