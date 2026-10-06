import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
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
// 答题卡插图导入/上传预算（安全 R05）与媒体票据档位（安全 R30）同为三档设计，
// 宿主机变量会污染「按默认边界」的断言，名单由各模块的 ENV_VARS 常量反向锁定。
const cardAssetEnvVarsClearedHere = [
  "PROJECTX_CARD_ASSET_MAX_MIB", "PROJECTX_CARD_ASSET_MAX_COUNT",
  "PROJECTX_CARD_ASSET_TOTAL_MIB", "PROJECTX_CARD_ASSET_UPLOAD_MIB"
];
const mediaTicketEnvVarsClearedHere = [
  "PROJECTX_MEDIA_TICKET_TTL_SEC", "PROJECTX_MEDIA_TICKET_MAX_PER_USER", "PROJECTX_MEDIA_TICKET_MAX_TOTAL"
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
  ...wechatEnvVarsClearedHere,
  ...cardAssetEnvVarsClearedHere,
  ...mediaTicketEnvVarsClearedHere
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
    // 安全 R35：上传会话必须携带「扫描端正在用哪一版卡」，服务端拿自己那一版比对。
    const { cardFingerprint, parseCardVersion } = await import("../src/shared/cardVersion");
    const { CardRepository } = await import("../src/server/repositories/CardRepository");
    const serverCardVersion = async (cardId: string): Promise<string> => {
      const card = await new CardRepository().findById(cardId);
      if (!card) throw new Error(`测试前置条件缺失：答题卡 ${cardId} 不存在`);
      return cardFingerprint(card);
    };
    db.prepare("INSERT INTO answer_cards (id,title,subject,subject_label) VALUES (?,?,?,?)")
      .run("critical-remote-card", "远程接入验收卡", "shuxue", "数学");
    const remoteCardVersion = await serverCardVersion("critical-remote-card");
    const remoteUploadSession = await fetch(`${base}/api/scanner/upload/sessions`, {
      method: "POST",
      headers: {
        Origin: scannerOrigin,
        "Content-Type": "application/json",
        "X-Api-Key": "key-scanner"
      },
      body: JSON.stringify({
        cardId: "critical-remote-card",
        cardVersion: remoteCardVersion,
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

    // ── R35：扫描端必须声明「正在用哪一版卡」，服务端拿自己那一版比对后才建会话
    const createVersionedSession = async (cardVersion: unknown, cardId = "critical-remote-card") => {
      const response = await fetch(`${base}/api/scanner/upload/sessions`, {
        method: "POST",
        headers: { Origin: scannerOrigin, "Content-Type": "application/json", "X-Api-Key": "key-scanner" },
        body: JSON.stringify({ cardId, cardVersion, name: "R35 版本核验", dpi: 300, paperSize: "A4", pageCount: 1 })
      });
      const body = await response.json() as { code?: string; sessionId?: string };
      return { status: response.status, code: body.code ?? "", sessionId: body.sessionId ?? "" };
    };
    const noVersion = await createVersionedSession(undefined);
    check(noVersion.status === 400 && noVersion.code === "CARD_VERSION_REQUIRED" && noVersion.sessionId === "",
      "不带 cardVersion 的会话请求被 400 拒绝（此前扫描端用哪一版卡服务器无从知晓）");
    check((await createVersionedSession("")).status === 400, "空字符串 cardVersion 被 400 拒绝");
    check((await createVersionedSession("v2.6.0")).status === 400, "非指纹格式 cardVersion 被 400 拒绝");
    check((await createVersionedSession(remoteCardVersion.slice(0, 23))).status === 400
      && (await createVersionedSession(remoteCardVersion + "0")).status === 400,
      "长度不足或超出的 cardVersion 均被 400 拒绝（24 位十六进制之外一律不认）");
    const flipped = remoteCardVersion[0] === "f" ? "0" + remoteCardVersion.slice(1) : "f" + remoteCardVersion.slice(1);
    const mismatched = await createVersionedSession(flipped);
    check(mismatched.status === 409 && mismatched.code === "CARD_VERSION_MISMATCH" && mismatched.sessionId === "",
      "版本指纹对不上时返回 409（旧版卡识别出的成绩不允许入库）");
    check((await createVersionedSession(remoteCardVersion, "critical-no-such-card")).status === 404,
      "版本号合法但答题卡不存在时返回 404，不会被当作「版本一致」放行");
    check((db.prepare("SELECT COUNT(*) count FROM twain_scan_sessions WHERE card_id='critical-remote-card'").get() as { count: number }).count === 1,
      "被 R35 拒绝的请求没有留下半成品会话");
    check(parseCardVersion(" " + remoteCardVersion.toUpperCase() + " ") === remoteCardVersion
      && parseCardVersion("abc") === null && parseCardVersion(12345) === null && parseCardVersion(null) === null,
      "parseCardVersion 容忍大小写与首尾空白，其余一律判非法");

    // 指纹是「内容」的指纹：同一张卡两次计算一致，改答案/改布局会变，而本地导入重盖的时间戳不会
    const remoteCardOnce = await new CardRepository().findById("critical-remote-card");
    const fingerprintAgain = cardFingerprint(remoteCardOnce!);
    check(fingerprintAgain === cardFingerprint(remoteCardOnce!) && fingerprintAgain === remoteCardVersion,
      "同一张卡的指纹可重复计算，且与服务端核验用的值一致");
    const restamped = { ...remoteCardOnce!, updatedAt: "1999-01-01 00:00:00" } as typeof remoteCardOnce;
    check(cardFingerprint(restamped!) === remoteCardVersion,
      "updatedAt 不参与指纹（扫描端本地导入会重盖时间戳，若参与则每次上传都会被误判为版本不一致）");
    const editedKey = JSON.parse(JSON.stringify(remoteCardOnce!)) as typeof remoteCardOnce;
    if (Array.isArray((editedKey as { bodyBlocks?: unknown }).bodyBlocks) && (editedKey as { bodyBlocks: unknown[] }).bodyBlocks.length > 0) {
      ((editedKey as { bodyBlocks: Array<Record<string, unknown>> }).bodyBlocks[0]).changed = true;
    } else {
      (editedKey as { title?: string }).title = `${(editedKey as { title?: string }).title ?? ""}改`;
    }
    check(cardFingerprint(editedKey!) !== remoteCardVersion, "卡内容被改动后指纹随之改变");
    check(cardFingerprint(editedKey!).length === 24 && /^[0-9a-f]{24}$/.test(cardFingerprint(editedKey!)),
      "指纹为 24 位小写十六进制，可直接放进请求体与日志");

    // 评审 P1：同一张卡在客户端与服务端必须算出同一个指纹。两边的 JSON 文本相同，
    // 但内存形状不同——服务端从库里构造会带值为 undefined 的键，而这些键经 HTTP 到客户端时根本不存在。
    // 旧的 stableStringify 把前者编成 null、后者编成「没有这个键」，于是普通客观题/主观题卡一律 409。
    type VersionedCard = Parameters<typeof cardFingerprint>[0];
    const serverShapedCard = {
      id: "critical-remote-card",
      title: "规范化验收卡",
      subject: "shuxue",
      subjectLabel: "数学",
      examDate: null,
      paper: { pageSize: "A4", pages: [{ width: 210, height: 297, blanks: undefined }] },
      studentInfo: { items: [{ label: "姓名", field: undefined }] },
      bodyBlocks: [
        { type: "objective", id: "b1", answerKey: undefined, score: 2 },
        { type: "subjective", id: "b2", blocks: [undefined, { title: "作文" }] },
      ],
      sided: false,
      layoutVersion: 1,
    } as unknown as VersionedCard;
    // 客户端那一侧：同一份内容走一遍 JSON 往返，undefined 键被省略、数组里的 undefined 变 null
    const clientShapedCard = JSON.parse(JSON.stringify(serverShapedCard)) as VersionedCard;
    const clientShapedAgain = JSON.parse(JSON.stringify(clientShapedCard)) as VersionedCard;
    check(cardFingerprint(clientShapedCard) === cardFingerprint(serverShapedCard),
      "「带 undefined 键的服务端形状」与「省略这些键的客户端形状」指纹一致（评审 P1 的 409 根因）");
    check(cardFingerprint(clientShapedAgain) === cardFingerprint(clientShapedCard),
      "客户端形状再走一遍 JSON 仍是同一值——规范化是幂等的，不会在两边各自漂移");
    const keyOrderVariant = JSON.parse(
      `{"layoutVersion":1,"sided":false,"bodyBlocks":${JSON.stringify(serverShapedCard.bodyBlocks)},`
      + `"studentInfo":${JSON.stringify((serverShapedCard as { studentInfo: unknown }).studentInfo)},`
      + `"paper":${JSON.stringify((serverShapedCard as { paper: unknown }).paper)},`
      + `"examDate":null,"subjectLabel":"数学","subject":"shuxue","title":"规范化验收卡","id":"critical-remote-card"}`
    ) as VersionedCard;
    check(cardFingerprint(keyOrderVariant) === cardFingerprint(serverShapedCard),
      "键序不同不影响指纹（规范化只统一 undefined/null，不引入键序依赖）");
    const meaningfulAddition = JSON.parse(JSON.stringify(clientShapedCard)) as VersionedCard;
    (meaningfulAddition as { studentInfo: Record<string, unknown> }).studentInfo.extra = "新字段";
    check(cardFingerprint(meaningfulAddition) !== cardFingerprint(serverShapedCard),
      "反向对照：真正的内容差异（多出且有值的字段）照样改变指纹——规范化没有把校验变成空转");
    const nullVsMissingArrayElement = JSON.parse(JSON.stringify(serverShapedCard)) as VersionedCard;
    (nullVsMissingArrayElement as { bodyBlocks: unknown[] }).bodyBlocks[1].blocks = [null, { title: "作文" }];
    check(cardFingerprint(nullVsMissingArrayElement) === cardFingerprint(serverShapedCard),
      "数组里的 undefined 与 null 经 JSON 同形（元素位置的 undefined 编成 null）");

    // 完成会话时再核一次：建会话之后服务器上的卡被改了，就不能把旧版结果落库
    const completeWithVersion = async (sessionId: string, cardVersion: unknown) => {
      const response = await fetch(`${base}/api/scanner/upload/sessions/${encodeURIComponent(sessionId)}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Api-Key": "key-scanner" },
        body: JSON.stringify(cardVersion === undefined ? {} : { cardVersion })
      });
      const body = await response.json() as { code?: string };
      return { status: response.status, code: body.code ?? "" };
    };
    const versionedSession = await createVersionedSession(remoteCardVersion);
    check(versionedSession.status === 201 && versionedSession.sessionId !== "", "版本一致的会话正常创建（201）");
    const completeNoVersion = await completeWithVersion(versionedSession.sessionId, undefined);
    check(completeNoVersion.status === 400 && completeNoVersion.code === "CARD_VERSION_REQUIRED",
      "完成阶段缺少 cardVersion 同样被 400 拒绝");
    const completeMismatch = await completeWithVersion(versionedSession.sessionId, flipped);
    check(completeMismatch.status === 409 && completeMismatch.code === "CARD_VERSION_MISMATCH",
      "完成阶段版本不一致返回 409，不会触发识别入库");
    check(db.prepare("SELECT status FROM twain_scan_sessions WHERE id=?").get(versionedSession.sessionId)
      && (db.prepare("SELECT status FROM twain_scan_sessions WHERE id=?").get(versionedSession.sessionId) as { status: string }).status !== "completed",
      "被 R35 拦下的会话不会被标记为已完成");
    db.prepare("DELETE FROM twain_scan_records WHERE session_id=?").run(versionedSession.sessionId);
    db.prepare("DELETE FROM twain_scan_sessions WHERE id=?").run(versionedSession.sessionId);

    // 扫描端接线：三处入口都要把「本机这一版卡的指纹」带上，否则服务端只能 400
    const uploadManagerSource = readFileSync(path.resolve("src/apps/answer-card/client/lib/scannerUploadManager.ts"), "utf8");
    const scannerPanelSource = readFileSync(path.resolve("src/apps/answer-card/client/components/ScannerPanel.tsx"), "utf8");
    const scannerWorkspaceSource = readFileSync(path.resolve("src/apps/answer-card/client/components/ScannerWorkspace.tsx"), "utf8");
    const scannerSyncSource = readFileSync(path.resolve("src/apps/answer-card/client/lib/scannerSync.ts"), "utf8");
    const scannerAppSource = readFileSync(path.resolve("src/apps/answer-card/client/ScannerApp.tsx"), "utf8");
    check(/cardVersion:\s*j\.cardVersion/.test(uploadManagerSource)
      && /cardVersion:\s*string/.test(uploadManagerSource)
      && /未能确定本机答题卡版本/.test(uploadManagerSource),
      "上传管理器在建会话与完成会话时都带 cardVersion，缺失时先失败而不是静默上传");
    check(/cardFingerprint\(card\)/.test(scannerPanelSource) && /cardVersion/.test(scannerPanelSource),
      "扫描仪直扫入口按服务端返回的卡计算指纹后交给上传管理器");
    check(/cardVersion:\s*cardFingerprint\(card\)/.test(scannerWorkspaceSource),
      "导入图片入口同样携带卡版本指纹");
    check(!/fetchCardByIdSynced\s*\(/.test(scannerSyncSource + scannerAppSource)
      && /fetchCardDetailSynced/.test(scannerSyncSource) && /stale/.test(scannerAppSource),
      "选卡走 fetchCardDetailSynced：命中离线缓存时先告知版本可能过期，而不是拿旧卡直接开工");

    section("考试组权限与事务");
    let grade = db.prepare("SELECT id FROM grades ORDER BY id LIMIT 1").get() as { id: number } | undefined;
    if (!grade) {
      grade = { id: Number(db.prepare("INSERT INTO grades (name,sort_order) VALUES (?,?)").run("高一", 1).lastInsertRowid) };
    }
    const classA = Number(db.prepare("INSERT INTO classes (grade_id,name) VALUES (?,?)").run(grade.id, "安全A班").lastInsertRowid);
    const classB = Number(db.prepare("INSERT INTO classes (grade_id,name) VALUES (?,?)").run(grade.id, "安全B班").lastInsertRowid);
    db.prepare("INSERT INTO teacher_classes (teacher_id,class_id,subject) VALUES (?,?,?)").run(teacher.id, classA, "数学");
    db.prepare("INSERT INTO answer_cards (id,title,subject,subject_label) VALUES (?,?,?,?)").run("critical-card", "安全验收卡", "shuxue", "数学");
    const criticalCardVersion = await serverCardVersion("critical-card");
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
          cardId: "critical-card", cardVersion: criticalCardVersion, name: "安全批次验收", dpi: 300, paperSize: "A4",
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

    // ── PR #312 复核 P2：建会话的入口也要过考试范围
    // 卡号在请求体里、此刻又还没有 sessionId，`/sessions/:sessionId` 那组范围中间件挂不上来；
    // R35 的版本核验只证明「这张卡是真的」。三者叠加时，能读卡但不在该考试范围内的教师
    // 可以反复建会话——页上传会被 403 挡住，但 session 与最多 MAX_SCAN_SESSION_PAGES 条
    // 待上传记录/令牌已经落库了。
    const scopeSessions = rowCount("SELECT COUNT(*) count FROM twain_scan_sessions");
    const scopeRecords = rowCount("SELECT COUNT(*) count FROM twain_scan_records");
    const outOfScopeSession = await fetch(`${base}/api/scanner/upload/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(teacherToken) },
      body: JSON.stringify({
        cardId: "critical-card", cardVersion: criticalCardVersion,
        name: "越权建会话", pageCount: MAX_SCAN_SESSION_PAGES
      })
    });
    const sessionScopeBody = JSON.stringify(await outOfScopeSession.json().catch(() => ({})));
    check(outOfScopeSession.status === 403
      && rowCount("SELECT COUNT(*) count FROM twain_scan_sessions") === scopeSessions
      && rowCount("SELECT COUNT(*) count FROM twain_scan_records") === scopeRecords,
      `越权教师为「另一场考试也在用」的答题卡建会话被 ${outOfScopeSession.status} 拒绝，且不落 session 与待上传记录`);
    check(!sessionScopeBody.includes(criticalCardVersion.slice(0, 12)),
      "范围拒绝的响应里不含服务器侧版本指纹（越权者连这张卡当前是哪一版都读不到）");
    // 设计内的机器入口不能被误伤：同一个卡号、同一份体，带扫描端 API Key 仍然建得起来
    const bypassSession = await newScanSession();
    check(bypassSession.status === 201
      && rowCount("SELECT COUNT(*) count FROM twain_scan_sessions") === scopeSessions + 1,
      "扫描端 API Key 凭据建会话不受本次收口影响（isApiClient 直连是设计内行为）");
    db.prepare("DELETE FROM twain_scan_records WHERE session_id=?").run(bypassSession.sessionId);
    db.prepare("DELETE FROM twain_scan_sessions WHERE id=?").run(bypassSession.sessionId);

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

    // ── CR14：暂存区不计入长期容量
    const { paperTmpDir } = await import("../src/apps/answer-card/server/storage");
    check(paperTmpDir === r14TmpDir
      && path.dirname(paperTmpDir) === path.join(process.env.ANSWER_CARD_DATA_DIR!, "papers"),
      "暂存目录由 storage 单点定义，且确实落在容量扫描的根目录里（跳过它才是真跳过，而不是路径拼错）");
    const cr14BeforeStaging = await readPapersTotalBytes();
    const cr14StagingFile = path.join(paperTmpDir, "cr14-staging.tmp");
    writeFileSync(cr14StagingFile, Buffer.alloc(4096, 3));
    invalidatePaperUsageCache();
    const cr14AfterStaging = await readPapersTotalBytes();
    writeFileSync(path.join(r10Dir, "original-3.jpg"), Buffer.alloc(4096, 5));
    invalidatePaperUsageCache();
    const cr14AfterRealPage = await readPapersTotalBytes();
    rmSync(cr14StagingFile);
    invalidatePaperUsageCache();
    check(cr14AfterStaging.bytes === cr14BeforeStaging.bytes
      && cr14AfterRealPage.bytes >= cr14BeforeStaging.bytes + 4096,
      "同体积的两份数据：暂存件不计入全局容量、已落盘页计入（否则并发上传会把自己算两次，把别人挤在门外）");

    // ── CR14：转换后按实测复测并回滚
    const { assertWrittenPaperWithinQuota, PaperQuotaRollbackError } = await import("../src/apps/answer-card/server/paperQuota");
    const cr14Limits = {
      maxPaperPagesPerCard: 60,
      maxPaperBytesPerCard: 1024 * 1024,
      maxPaperBytesTotal: 204800 * 1024 * 1024,
    };
    const cr14EmptyCard = { cardPages: 0, cardBytes: 0, totalBytes: 0, totalExact: true };
    // 评审给的真实观测：844 KiB 的 JPEG 输入落成 jpg + 配对 PDF 后实测约 1.41 MiB
    const cr14ByInput = evaluatePaperQuota(cr14EmptyCard, { pages: 1, bytes: 844 * 1024 }, cr14Limits);
    const cr14ByOutput = evaluatePaperQuota(cr14EmptyCard, { pages: 1, bytes: Math.round(1.41 * 1024 * 1024) }, cr14Limits);
    check(cr14ByInput.ok === true && cr14ByOutput.ok === false && cr14ByOutput.reason === "card-bytes",
      "同一份上传：按输入 844KiB 放行、按落盘实测 1.41MiB 拒绝（放大倍数没法估，只能写完再量）");
    const cr14Admission = await readPaperQuota(quotaDb, r10CardId);
    let cr14Rollback: unknown = null;
    try {
      await assertWrittenPaperWithinQuota(quotaDb, r10CardId, cr14Admission,
        { pages: 1, bytes: 6144 },
        { ...cr14Limits, maxPaperBytesPerCard: 4096 });
    } catch (error) { cr14Rollback = error; }
    check(cr14Rollback instanceof PaperQuotaRollbackError
      && (cr14Rollback as { reason?: string }).reason === "card-bytes"
      && !containsHostPath((cr14Rollback as Error).message),
      "落盘后复测越界 → 抛出带回滚原因的专属错误（路由据此撤销事务、删掉已写文件并回 413）");
    let cr14WithinQuota = true;
    try {
      await assertWrittenPaperWithinQuota(quotaDb, r10CardId, cr14Admission, { pages: 1, bytes: 6144 }, cr14Limits);
    } catch { cr14WithinQuota = false; }
    check(cr14WithinQuota, "实测仍在额度内时不触发回滚：放大是常态，不是拒绝的理由");

    // ── 请求预算与 multer 错误回调的先后（PR #312 复核）：413 已经给出后不得再回一次 400
    const expressModule = await import("express");
    const multerModule = await import("multer");
    const { isUploadAlreadyRejected } = await import("../src/server/lib/uploadBudget");
    const doubleTmp = path.join(tempDir, "multer-double-tmp");
    mkdirSync(doubleTmp, { recursive: true });
    const doubleCallbacks: string[] = [];
    const doubleApp = expressModule.default();
    // 与 paper-routes.ts 完全同形的链：预算 → multer → 手写错误回调（先清临时件，再决定是否响应）
    const mountGuardedUpload = (routePath: string, budgetBytes: number, fileSizeBytes: number): void => {
      const upload = multerModule.default({ dest: doubleTmp, limits: { fileSize: fileSizeBytes, files: 8 } });
      doubleApp.post(routePath, requestUploadBudget({ maxTotalBytes: budgetBytes, label: "回归上传" }),
        (req: any, res: any, next: any) => {
          upload.array("files", 8)(req, res, (err: unknown) => {
            const partial: Array<{ path: string }> = req.files ?? (req.file ? [req.file] : []);
            for (const file of partial) {
              try { unlinkSync(file.path); } catch { /* multer 已回收或文件不存在 */ }
            }
            doubleCallbacks.push(`${routePath}|${err ? String((err as Error).message) : "ok"}|${res.headersSent ? "answered" : "fresh"}`);
            if (err) {
              if (isUploadAlreadyRejected(req, res)) return;
              res.status(400).json({ error: String((err as Error).message) });
              return;
            }
            next();
          });
        },
        (_req: any, res: any) => { res.json({ ok: true }); });
    };
    mountGuardedUpload("/budget-first", 900, 4096);
    mountGuardedUpload("/filesize-first", 100_000, 500);
    const doubleServer = doubleApp.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => doubleServer.once("listening", resolve));
    const doublePort = (doubleServer.address() as { port: number }).port;
    const rawHttp = await import("node:http");
    const multipartPart = (boundary: string, bytes: number, last: boolean): Buffer => Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="p${bytes}.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      Buffer.alloc(bytes, 97),
      Buffer.from(last ? `\r\n--${boundary}--\r\n` : "\r\n"),
    ]);
    // 分块发送且不报 Content-Length：预算只能在流式接收中途判负，这才撞得上 multer 的断流回调
    const chunkedUpload = (routePath: string, parts: Buffer[]): Promise<{ status: number; text: string }> =>
      new Promise((resolve) => {
        const outbound = rawHttp.request({
          host: "127.0.0.1", port: doublePort, path: routePath, method: "POST",
          // 每条请求各用一条连接：上一条被预算断开后，keep-alive 池里那只半死的 socket
          // 会被复用，客户端只会看到 ECONNRESET——那测的是连接复用，不是这里要的响应行为。
          agent: false,
          headers: { "Content-Type": "multipart/form-data; boundary=pxdouble", "Transfer-Encoding": "chunked" },
        }, (incoming) => {
          let text = "";
          incoming.setEncoding("utf8");
          incoming.on("data", (chunk) => { text += chunk; });
          incoming.on("end", () => resolve({ status: incoming.statusCode ?? 0, text }));
        });
        outbound.on("error", () => resolve({ status: 0, text: "" }));
        for (const part of parts) outbound.write(part);
        outbound.end();
      });
    const budgetFirst = await chunkedUpload("/budget-first", [
      multipartPart("pxdouble", 800, false), multipartPart("pxdouble", 800, false), multipartPart("pxdouble", 800, true),
    ]);
    check(budgetFirst.status === 413
      && (JSON.parse(budgetFirst.text || "{}") as { code?: string }).code === "UPLOAD_BUDGET_EXCEEDED",
      "预算中途判负后客户端拿到的是 413 而不是被 multer 断流错误改写成 400");
    check(doubleCallbacks.some((entry) => entry.startsWith("/budget-first|") && entry.endsWith("|answered")),
      "危险是真存在的：multer 的断流回调确实在 413 之后才到达（守卫不是在防一个不会发生的分支）");
    const fileSizeFirst = await chunkedUpload("/filesize-first", [multipartPart("pxdouble", 800, true)]);
    check(fileSizeFirst.status === 400
      && (JSON.parse(fileSizeFirst.text || "{}") as { error?: string }).error?.includes("File too large") === true,
      `multer 自己的单文件上限仍然照旧回 400（守卫没有把正常拒绝一起吞掉，实际 ${fileSizeFirst.status}/${fileSizeFirst.text.slice(0, 40) || "无正文"})`);
    const stillAlive = await chunkedUpload("/budget-first", [multipartPart("pxdouble", 100, true)]);
    check(stillAlive.status === 200 && stillAlive.text.includes("true"),
      "二次响应被挡下后服务进程照常可用（ERR_HTTP_HEADERS_SENT 打穿的就是这一条）");
    await new Promise((resolve) => setTimeout(resolve, 200));
    const doubleResidue = readdirSync(doubleTmp, { withFileTypes: true }).filter((entry) => entry.isFile()).length;
    doubleServer.close();
    check(doubleResidue === 0,
      "跳过响应并不跳过临时件回收：被预算拒掉的请求依旧不在 _tmp 留副本（R14 与「不要二次响应」互不影响）");
    const paperRouteSrc = readFileSync(path.join(process.cwd(), "src/apps/answer-card/server/routes/paper-routes.ts"), "utf8");
    const guardAt = paperRouteSrc.indexOf("isUploadAlreadyRejected(req, res)");
    const rejectAt = paperRouteSrc.indexOf("原卷上传失败");
    check(guardAt > 0 && rejectAt > guardAt
      && paperRouteSrc.indexOf("discardStoredPaths") < guardAt,
      "真实原卷路由同形：临时件清理在前、守卫在 400 之前（回归链与线上代码不是两套写法）");

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

    // ── PR #312 复核 P2：queued → running 的交接期间名额不能出现空隙
    // CR8 的账本是「queued 任务行 + success IS NULL 运行行」两段接力，但旧实现先改状态、
    // 运行行要等 trackAnalysisCall 才插——中间那一刻两条腿都不占位，并发提交读到空账本就能超放。
    const handoffJob = Number(db.prepare(
      "INSERT INTO ai_analysis_jobs (exam_id,status,created_by) VALUES (?, 'queued', ?)")
      .run(visibleExam, teacher.id).lastInsertRowid);
    const { claimAiAnalysisJobForRun } = await import("../src/server/services/aiAnalysisJobs");
    const handoffBefore = await readAiQuotaSnapshot(quotaDb, teacher.id);
    const handoff = await claimAiAnalysisJobForRun(handoffJob, { examId: visibleExam });
    const handoffAfter = await readAiQuotaSnapshot(quotaDb, teacher.id);
    const handoffState = db.prepare("SELECT status FROM ai_analysis_jobs WHERE id=?")
      .get(handoffJob) as { status: string };
    const handoffRun = db.prepare("SELECT user_id, feature, stage, success FROM ai_analysis_runs WHERE id=?")
      .get(handoff.runId) as { user_id: number; feature: string; stage: string; success: number | null };
    check(handoffBefore.activeJobsForUser === 1 && handoffBefore.queuedJobs!.user === 1
      && handoffBefore.inFlightRuns!.user === 0,
      "交接前任务只在「排队」这一侧占位（否则下面数的是残留而不是接力）");
    check(handoffState.status === "running" && handoffRun.success === null
      && handoffAfter.queuedJobs!.user === 0 && handoffAfter.inFlightRuns!.user === 1
      && handoffAfter.activeJobsForUser === handoffBefore.activeJobsForUser,
      "交接把两笔写入合成一步：任务离开 queued 的同一刻在途行已存在，名额总数不变、既不空洞也不双计");
    check(handoffRun.user_id === teacher.id && handoffRun.feature === "exam_analysis"
      && handoffRun.stage === "request",
      "交接建出的运行行按任务创建者归因，观测口径与 trackAnalysisCall 自建的一致");
    await finalizeAiRun(handoff.runId, { success: true, latencyMs: 1 });
    const handoffReleased = await readAiQuotaSnapshot(quotaDb, teacher.id);
    check(handoffState.status === "running" && handoffReleased.activeJobsForUser === 0,
      "运行行回填后名额释放，任务停在 running 不会长期占用（回填既是埋点也是释放）");
    db.prepare("DELETE FROM ai_analysis_jobs WHERE id=?").run(handoffJob);
    db.prepare("DELETE FROM ai_analysis_runs WHERE id=?").run(handoff.runId);

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
    // 响应头立刻给出、正文 60 毫秒后才结束：只有「槽位一直占到正文读完」才不会让并发闸门形同虚设
    const splitProbe = nodeHttp.createServer((_req, res) => {
      observedConcurrent += 1;
      peakConcurrent = Math.max(peakConcurrent, observedConcurrent);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"errcode":');
      setTimeout(() => {
        res.end("0}");
        observedConcurrent -= 1;
      }, 60);
    });
    await new Promise<void>((resolve) => wechatProbe.listen(0, "127.0.0.1", resolve));
    await new Promise<void>((resolve) => hangProbe.listen(0, "127.0.0.1", resolve));
    await new Promise<void>((resolve) => splitProbe.listen(0, "127.0.0.1", resolve));
    const wechatProbePort = (wechatProbe.address() as { port: number }).port;
    const hangProbePort = (hangProbe.address() as { port: number }).port;
    const splitProbePort = (splitProbe.address() as { port: number }).port;
    await Promise.all(Array.from({ length: WECHAT_MAX_CONCURRENT_REQUESTS * 3 }, async () => {
      const response = await wechatThrottle.wechatFetch(`http://127.0.0.1:${wechatProbePort}/token`);
      await response.json();
    }));
    check(peakConcurrent > 1 && peakConcurrent <= WECHAT_MAX_CONCURRENT_REQUESTS,
      "批量公布时的出站呼叫确实受并发闸门约束（超过微信频控只会换来 45009，受害的是全校推送）");
    observedConcurrent = 0;
    peakConcurrent = 0;
    await Promise.all(Array.from({ length: WECHAT_MAX_CONCURRENT_REQUESTS * 3 }, async () => {
      const response = await wechatThrottle.wechatFetch(`http://127.0.0.1:${splitProbePort}/token`);
      await response.json();
    }));
    check(peakConcurrent <= WECHAT_MAX_CONCURRENT_REQUESTS,
      "「响应头先到、正文后到」的请求依旧只占一个槽位（闸门若在读体前放行，服务端会同时看到 12 条在途连接）");
    let timeoutError: unknown = null;
    const timeoutStarted = Date.now();
    try {
      await wechatThrottle.wechatFetch(`http://127.0.0.1:${hangProbePort}/jscode2session`, {}, 400);
    } catch (error) { timeoutError = error; }
    check(timeoutError instanceof wechatThrottle.WechatTimeoutError
      && Date.now() - timeoutStarted < 3000,
      "半挂连接在预算内被判超时（此前不带信号的 fetch 会永久占住这个请求）");

    // ── CR15：响应头给得出来、正文永不结束的呼叫
    // 打桩 fetch 而不是再造一个 server：这条断言要证明的是「截止点由读侧自己守着」，
    // 一个完全不理会 AbortSignal 的响应体才是唯一能排除传输层侥幸的样本。
    const realGlobalFetch = globalThis.fetch;
    const stallBudgetMs = 250;
    let stubInvocations = 0;
    const headOnlyStub = (async () => {
      stubInvocations += 1;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode('{"errcode":')); /* 永不 close */ },
      }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const healthyStub = (async () => {
      stubInvocations += 1;
      return new Response('{"errcode":0}', { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    globalThis.fetch = headOnlyStub;
    const stallStarted = Date.now();
    try {
      const stallResults = await Promise.allSettled(
        Array.from({ length: WECHAT_MAX_CONCURRENT_REQUESTS + 2 }, () =>
          wechatThrottle.wechatFetch("https://wechat.invalid/cgi-bin/token", {}, stallBudgetMs))
      );
      const stallElapsed = Date.now() - stallStarted;
      check(stallResults.every((r) => r.status === "rejected"
        && r.reason instanceof wechatThrottle.WechatTimeoutError
        && (r.reason as Error).message.includes("正文")),
        "只给响应头、正文半挂的微信呼叫照样按预算判超时（超时此前只覆盖到响应头）");
      // 「闸门覆盖正文」由上面 splitProbe 那条按连接数实测的断言负责；这里要守的是另一半：
      // 预算是「排队 + 请求」的总预算，排在后面的请求不会因为排队就拿到第二份时间。
      check(stubInvocations === WECHAT_MAX_CONCURRENT_REQUESTS + 2
        && stallElapsed >= stallBudgetMs && stallElapsed < stallBudgetMs * 3,
        `半挂的正文按预算整体判负（${stallElapsed}ms / ${stubInvocations} 路），既不无限等待也不逐波累加`);
      // 失败路径必须归还槽位：把闸门装满一次，若泄漏这里会永远等下去。
      globalThis.fetch = healthyStub;
      const refilled = Promise.all(Array.from({ length: WECHAT_MAX_CONCURRENT_REQUESTS }, () =>
        wechatThrottle.wechatFetch("https://wechat.invalid/cgi-bin/token", {}, 2000).then((r) => r.json())));
      const revived = await Promise.race([
        refilled,
        new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 3000)),
      ]);
      check(revived !== "hung" && Array.isArray(revived) && revived.length === WECHAT_MAX_CONCURRENT_REQUESTS,
        "正文超时的失败路径把槽位归还了闸门（占着的槽位不回收 = 之后全校推送都发不出去）");
    } finally {
      globalThis.fetch = realGlobalFetch;
      wechatProbe.close();
      hangProbe.close();
      splitProbe.close();
    }

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

    section("答题卡插图导入与资源端点（安全 R05）、URL 凭据收紧与单次票据（安全 R30）");
    {
      // ── R05：导入预算三档（默认 / 环境变量 / 天花板）──
      const {
        CARD_ASSET_ENV_VARS, DEFAULT_CARD_ASSET_LIMITS, resolveCardAssetLimits, describeCardAssetLimits,
        MAX_CARD_ASSET_BYTES, MAX_CARD_ASSETS_PER_IMPORT, MAX_CARD_ASSETS_TOTAL_BYTES, MAX_CARD_ASSET_UPLOAD_BYTES
      } = await import("../src/shared/cardAssetLimits");
      const {
        MEDIA_TICKET_ENV_VARS, DEFAULT_MEDIA_TICKET_LIMITS, resolveMediaTicketLimits, describeMediaTicketLimits,
        MEDIA_TICKET_TTL_SECONDS
      } = await import("../src/shared/mediaTicketLimits");
      const MIB = 1024 * 1024;
      check(CARD_ASSET_ENV_VARS.slice().sort().join() === cardAssetEnvVarsClearedHere.slice().sort().join()
        && CARD_ASSET_ENV_VARS.every((name) => !(name in process.env)),
        "脚本清理的 PROJECTX_CARD_ASSET_* 名单与限制表逐一对应，宿主机变量不会渗入默认档位断言");
      check(MEDIA_TICKET_ENV_VARS.slice().sort().join() === mediaTicketEnvVarsClearedHere.slice().sort().join()
        && MEDIA_TICKET_ENV_VARS.every((name) => !(name in process.env)),
        "脚本清理的 PROJECTX_MEDIA_TICKET_* 名单与限制表逐一对应");
      check(MAX_CARD_ASSET_BYTES === DEFAULT_CARD_ASSET_LIMITS.maxAssetBytes
        && MAX_CARD_ASSETS_PER_IMPORT === DEFAULT_CARD_ASSET_LIMITS.maxAssetsPerImport
        && MAX_CARD_ASSETS_TOTAL_BYTES === DEFAULT_CARD_ASSET_LIMITS.maxAssetsTotalBytes
        && MAX_CARD_ASSET_UPLOAD_BYTES === DEFAULT_CARD_ASSET_LIMITS.maxAssetUploadBytes
        && resolveCardAssetLimits({}).notices.length === 0,
        "未配置时按默认预算生效：单图 6MiB / 单次导入 200 条 / 导入累计 8MiB / 上传 12MiB");
      check(resolveCardAssetLimits({ PROJECTX_CARD_ASSET_MAX_MIB: "2", PROJECTX_CARD_ASSET_MAX_COUNT: "5" }).limits.maxAssetBytes === 2 * MIB
        && resolveCardAssetLimits({ PROJECTX_CARD_ASSET_MAX_MIB: "2" }).limits.maxAssetBytes === 2 * MIB,
        "PROJECTX_CARD_ASSET_* 在天花板内可覆盖默认值");
      check(resolveCardAssetLimits({ PROJECTX_CARD_ASSET_MAX_MIB: "abc" }).limits.maxAssetBytes === DEFAULT_CARD_ASSET_LIMITS.maxAssetBytes
        && resolveCardAssetLimits({ PROJECTX_CARD_ASSET_MAX_COUNT: "0" }).limits.maxAssetsPerImport === DEFAULT_CARD_ASSET_LIMITS.maxAssetsPerImport
        && resolveCardAssetLimits({ PROJECTX_CARD_ASSET_MAX_COUNT: "-3" }).notices.length >= 1,
        "非法覆盖值（非数字 / 0 / 负数）回落默认值并留告警，不会把闸门关掉");
      check(resolveCardAssetLimits({ PROJECTX_CARD_ASSET_MAX_MIB: "999999" }).limits.maxAssetBytes === 512 * MIB
        && resolveCardAssetLimits({ PROJECTX_CARD_ASSET_MAX_COUNT: "999999" }).limits.maxAssetsPerImport === 2000
        && resolveCardAssetLimits({ PROJECTX_CARD_ASSET_UPLOAD_MIB: "999999" }).limits.maxAssetUploadBytes === 512 * MIB,
        "超天花板的覆盖值被夹紧（512MiB / 2000 条 / 512MiB）");
      check(describeCardAssetLimits().includes("单图 ≤6MiB") && describeCardAssetLimits().includes("上传 ≤12MiB"),
        `启动摘要可读：${describeCardAssetLimits()}`);
      check(resolveMediaTicketLimits({ PROJECTX_MEDIA_TICKET_TTL_SEC: "60" }).limits.ttlSeconds === 60
        && resolveMediaTicketLimits({ PROJECTX_MEDIA_TICKET_TTL_SEC: "99999" }).limits.ttlSeconds === 3600
        && resolveMediaTicketLimits({}).limits.ttlSeconds === DEFAULT_MEDIA_TICKET_LIMITS.ttlSeconds
        && MEDIA_TICKET_TTL_SECONDS === DEFAULT_MEDIA_TICKET_LIMITS.ttlSeconds,
        `票据寿命默认 300s、可覆盖、天花板 3600s；当前生效 ${describeMediaTicketLimits()}`);

      // ── R05：判定函数——扩展名白名单 + 魔数一致，SVG/HTML 一律出局 ──
      const { imageContentTypeFor, detectImageLabel, rejectReasonForImportedAsset } =
        await import("../src/apps/answer-card/server/validate-upload");
      const { cardAssetsDir } = await import("../src/apps/answer-card/server/storage");
      const pngBytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 0x20)]);
      const htmlBytes = Buffer.from("<script>fetch('/api/users',{headers:{authorization:x}})</script>", "utf8");
      const jpegBytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("JFIF", "ascii"), Buffer.alloc(48, 0x20)]);
      check(imageContentTypeFor("a.png") === "image/png" && imageContentTypeFor("a.jpeg") === "image/jpeg",
        "图片扩展名映射到闭合的 Content-Type");
      check(imageContentTypeFor("evil.html") === null && imageContentTypeFor("payload.svg") === null
        && imageContentTypeFor("noext") === null,
        "HTML/SVG/无扩展名不在映射内（SVG 本身即脚本载体，永久排除）");
      check(detectImageLabel(pngBytes) === "PNG" && detectImageLabel(htmlBytes) === null,
        "魔数识别只对图片返回标签");
      check(rejectReasonForImportedAsset("ok.png", pngBytes) === null,
        "扩展名与魔数一致的图片资源通过判定");
      check(String(rejectReasonForImportedAsset("evil.html", htmlBytes)).includes("不支持的资源类型"),
        "非图片扩展名被拒");
      check(String(rejectReasonForImportedAsset("fake.png", htmlBytes)).includes("不是受支持的图片格式"),
        "纯文本改名为 .png 因魔数不合格被拒");
      check(String(rejectReasonForImportedAsset("lying.png", jpegBytes)).includes("JPEG")
        && String(rejectReasonForImportedAsset("lying.png", jpegBytes)).includes(".png"),
        "「扩展名与真实图片类型不一致」（JPEG 冒充 PNG）也被拒——魔数合格但扩展名说谎同样不合格");

      // ── R05：真实导入端点（混合三类资源：合规图 / HTML 扩展名 / 伪装图）──
      const exported = await fetch(`${base}/api/cards/CRITICALCARD001/export`, { headers: authHeaders(adminToken) });
      check(exported.status === 200, "导出既有卡得到可回灌的 .projectx-card 信封");
      const envelope = await exported.json() as { format: string; version: number; card: unknown; layout: unknown; assets?: Record<string, string> };
      const cardCountBefore = (db.prepare("SELECT COUNT(*) count FROM answer_cards").get() as { count: number }).count;
      const importResponse = await fetch(`${base}/api/cards/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(adminToken) },
        body: JSON.stringify({
          ...envelope,
          card: { ...(envelope.card as { id?: string; title?: string; subject?: string; bodyBlocks?: unknown[] }), title: "R05 导入资源校验" },
          assets: {
            "ok.png": pngBytes.toString("base64"),
            "evil.html": htmlBytes.toString("base64"),
            "fake.png": htmlBytes.toString("base64"),
            "lying.png": jpegBytes.toString("base64")
          }
        })
      });
      const importBody = await importResponse.json() as { id?: string; warnings?: { rejectedAssets?: Array<{ name: string; reason: string }> } };
      const rejected = (importBody.warnings?.rejectedAssets ?? []).map((item) => item.name).sort().join(",");
      check(importResponse.status === 201 && !!importBody.id, "导入本身成功（不合规资源只拒收该资源，不作废整张卡）");
      check(rejected === "evil.html,fake.png,lying.png",
        `不合规资源逐条拒收并回传原因（实际拒绝：${rejected || "无"}）`);
      const importedAssetDir = cardAssetsDir(importBody.id ?? "none");
      check(!!importBody.id && existsSync(path.join(importedAssetDir, "ok.png"))
        && !existsSync(path.join(importedAssetDir, "evil.html"))
        && !existsSync(path.join(importedAssetDir, "fake.png"))
        && !existsSync(path.join(importedAssetDir, "lying.png")),
        "落盘只剩合规图片，伪装/超限资源未进入数据目录");

      // ── R05：资源端点——非图片扩展名 404，图片响应带 nosniff 与响应级 CSP ──
      const assetCardId = importBody.id ?? "none";
      const htmlAsset = await fetch(`${base}/api/assets/${assetCardId}/evil.html`, { headers: authHeaders(adminToken) });
      check(htmlAsset.status === 404, "资源端点拒绝按非图片类型提供内容（历史脏数据也拿不到同源 HTML）");
      const imageAsset = await fetch(`${base}/api/assets/${assetCardId}/ok.png`, { headers: authHeaders(adminToken) });
      check(imageAsset.status === 200 && imageAsset.headers.get("x-content-type-options") === "nosniff"
        && /default-src 'none'/.test(imageAsset.headers.get("content-security-policy") ?? "")
        && imageAsset.headers.get("content-type") === "image/png",
        "图片响应显式声明类型，并叠加 nosniff + 只出图的 CSP/sandbox");
      const traversal = await fetch(`${base}/api/assets/${assetCardId}/..%2F..%2Fprojectx.db`, { headers: authHeaders(adminToken) });
      check(traversal.status === 404 || traversal.status === 400, "资源端点的路径穿越尝试被拒");

      // ── R05：条数上限在落库前判定，超预算不留半成品卡 ──
      const overQuotaAssets: Record<string, string> = {};
      for (let i = 0; i <= MAX_CARD_ASSETS_PER_IMPORT; i++) overQuotaAssets[`a${i}.png`] = pngBytes.toString("base64");
      const overQuota = await fetch(`${base}/api/cards/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(adminToken) },
        body: JSON.stringify({ ...envelope, assets: overQuotaAssets })
      });
      const cardCountAfter = (db.prepare("SELECT COUNT(*) count FROM answer_cards").get() as { count: number }).count;
      check(overQuota.status === 413 && cardCountAfter === cardCountBefore + 1,
        `超过 ${MAX_CARD_ASSETS_PER_IMPORT} 条的导入被 413 拒收且不落库（本次仅新增上一张合规卡那一行）`);

      // ── R05：与请求体上限的关系（文档口径的技术佐证）──
      // 单图默认预算 6MiB，base64 后约 8MiB，正好撞上全局 express.json 的 8mb：
      // 也就是说「导入侧」真正的天花板是请求体，把本模块数字调大并不能导入更大的包。
      const oversizedSingle = await fetch(`${base}/api/cards/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(adminToken) },
        body: JSON.stringify({ ...envelope, assets: { "huge.png": Buffer.alloc(MAX_CARD_ASSET_BYTES + 96 * 1024, 0x41).toString("base64") } })
      });
      check(oversizedSingle.status === 413,
        `单图超出请求体预算时先被 body-parser 判 413（实际 ${oversizedSingle.status}），与「放宽本模块数字无效」的说明一致`);

      // ── R30：?token= 只承认媒体白名单 ──
      const { isUrlCredentialAllowedPath } = await import("../src/server/lib/mediaAllowlist");
      check(isUrlCredentialAllowedPath("/api/cards/CRITICALCARD001/export") && isUrlCredentialAllowedPath("/api/scanner/progress/s1")
        && isUrlCredentialAllowedPath("/api/answer-block-crops/c1/image"),
        "PDF/导出/SSE/切块图仍在只读媒体白名单内（浏览器自发请求不受影响）");
      check(!isUrlCredentialAllowedPath("/api/users") && !isUrlCredentialAllowedPath("/api/scores/me/exams/1/paper/blocks/b1/image")
        && !isUrlCredentialAllowedPath("/api/export/students.csv") && !isUrlCredentialAllowedPath("/api/health"),
        "数据类 GET、无路由的路径与 CSV 导出（走请求头）都不接受 URL 凭据");
      const tokenOnMedia = await fetch(`${base}/api/cards/CRITICALCARD001/export?token=${adminToken}`);
      check(tokenOnMedia.status === 200, "白名单内端点仍可用 ?token=（PDF/图片/SSE 不因收紧而坏掉）");
      const tokenOnData = await fetch(`${base}/api/users?token=${adminToken}`);
      check(tokenOnData.status === 401, "同一枚主令牌用于非媒体 GET 被拒——一次 URL 泄漏不再等于全量只读权限");

      // ── R30：单次资源票据的绑定关系（纯函数 + 真实签发端点）──
      const {
        issueMediaTicket, resolveMediaTicket, revokeMediaTicketsForUser, __resetMediaTicketsForTests
      } = await import("../src/server/services/mediaTicket");
      __resetMediaTicketsForTests();
      const snapshot = {
        id: 9001, username: "crit-ticket", name: "票据回归", role_id: 2, role_name: "teacher",
        student_number: null, teacher_role: null, subject: null, password_change_required: false
      };
      const boundPath = "/api/cards/CRITICALCARD001/pdf";
      const issued = issueMediaTicket(snapshot, boundPath);
      check(!!issued && issued!.path === boundPath && issued!.ttlSeconds === MEDIA_TICKET_TTL_SECONDS,
        "票据签发成功并绑定具体路径与寿命");
      check(resolveMediaTicket(issued!.ticket, "GET", boundPath)?.id === 9001, "票据对其绑定路径放行");
      check(resolveMediaTicket(issued!.ticket, "GET", "/api/cards/CRITICALCARD001/export") === null,
        "同一票据改读另一条媒体路径被拒（票据不是缩小版的主令牌）");
      check(resolveMediaTicket(issued!.ticket, "POST", boundPath) === null, "票据只读：写方法一律拒绝");
      check(resolveMediaTicket(issued!.ticket, "GET", boundPath, Date.now() + (MEDIA_TICKET_TTL_SECONDS + 1) * 1000) === null,
        "超过 TTL 后同一票据失效");
      check(issueMediaTicket(snapshot, "/api/users") === null && issueMediaTicket(snapshot, "not-a-path") === null,
        "非媒体路径与非法入参不签发票据");
      const ticketProbe = { ...snapshot, id: 9002 };
      const firstTicket = issueMediaTicket(ticketProbe, "/api/cards/CRITICALCARD001/pdf");
      issueMediaTicket(ticketProbe, "/api/cards/CRITICALCARD001/layout");
      check(revokeMediaTicketsForUser(9002) === 2
        && resolveMediaTicket(firstTicket!.ticket, "GET", "/api/cards/CRITICALCARD001/pdf") === null,
        "登出/改密作废该用户全部票据（已签出的 2 张一次清空）");
      __resetMediaTicketsForTests();

      const issueHttp = await fetch(`${base}/api/auth/media-ticket`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(adminToken) },
        body: JSON.stringify({ path: "/api/cards/CRITICALCARD001/export" })
      });
      const issueHttpBody = await issueHttp.json() as { ticket?: string; path?: string };
      check(issueHttp.status === 200 && !!issueHttpBody.ticket && issueHttpBody.path === "/api/cards/CRITICALCARD001/export",
        "签发端点走完整鉴权链路，返回票据与绑定路径");
      const viaTicket = await fetch(`${base}/api/cards/CRITICALCARD001/export?mt=${issueHttpBody.ticket}`);
      check(viaTicket.status === 200, "凭票据访问其绑定路径成功（等价于该用户亲自请求）");
      const ticketReplay = await fetch(`${base}/api/users?mt=${issueHttpBody.ticket}`);
      check(ticketReplay.status === 401, "票据用于另一条路径被拒");
      const badScope = await fetch(`${base}/api/auth/media-ticket`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(adminToken) },
        body: JSON.stringify({ path: "/api/users" })
      });
      const badScopeBody = await badScope.json() as { code?: string };
      check(badScope.status === 400 && badScopeBody.code === "MEDIA_TICKET_SCOPE_INVALID",
        "请求为数据端点签发票据被 400 拒绝");
      const anonymousIssue = await fetch(`${base}/api/auth/media-ticket`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "/api/cards/1/pdf" })
      });
      check(anonymousIssue.status === 401, "未登录不能签发票据");

      // ── 评审 P1：票据必须随账号撤销失效，并按「当前」账号状态与角色判定 ──
      // 中间件级别的驱动器：真实 HTTP 只能看到状态码，看不到 req.user 被挂成了谁，
      // 而「降权后仍沿用旧角色」正是身份问题，所以直接喂一个带 ?mt= 的请求给 authMiddleware。
      const { authMiddleware } = await import("../src/server/middleware/auth");
      const runTicketAuth = async (ticketValue: string, pathname: string) => {
        const probe: any = {
          method: "GET", headers: {}, query: { mt: ticketValue }, baseUrl: "", path: pathname,
        };
        let statusCode: number | null = null;
        let allowed = false;
        // 中间件两条出路都要落定：next()（认下身份）或 res.status().json()（拒绝）。
        // 少认一条，这里就挂在一个永远不会来的回调上。
        await new Promise<void>((resolve) => {
          let settled = false;
          const done = () => { if (!settled) { settled = true; resolve(); } };
          const res: any = {
            status(code: number) { statusCode = code; return res; },
            json() { done(); return res; },
          };
          authMiddleware(probe, res, () => { allowed = true; done(); });
        });
        return { user: probe.user as { role_id: number; role_name: string } | undefined, statusCode, allowed };
      };

      // (1) 统一撤销入口：管理端「重置密码」走 revokeUserTokens，票据要跟着一起作废
      const revokeUser = await users.createUser({
        username: "ticket-revoke", password: "revoke-pass", name: "票据撤销教师",
        role_id: 2, teacher_role: "subject_teacher", subject: "数学",
      });
      const revokePath = "/api/cards/CRITICALCARD001/export";
      const revokeTicket = issueMediaTicket({
        id: revokeUser.id, username: revokeUser.username, name: revokeUser.name,
        role_id: revokeUser.role_id, role_name: revokeUser.role_name ?? "teacher",
        student_number: revokeUser.student_number ?? null, teacher_role: revokeUser.teacher_role ?? null,
        subject: revokeUser.subject ?? null, password_change_required: Boolean(revokeUser.password_change_required),
      }, revokePath);
      const beforeReset = await fetch(`${base}/api/cards/CRITICALCARD001/export?mt=${revokeTicket!.ticket}`);
      check(beforeReset.status !== 401 && !!resolveMediaTicket(revokeTicket!.ticket, "GET", revokePath),
        `撤销前票据可用（状态 ${beforeReset.status}，不是 401 就说明身份被认下了）`);
      const resetResp = await fetch(`${base}/api/users/${revokeUser.id}/reset-password`, {
        method: "POST", headers: authHeaders(adminToken),
      });
      const afterReset = await fetch(`${base}/api/cards/CRITICALCARD001/export?mt=${revokeTicket!.ticket}`);
      check(resetResp.status === 200 && afterReset.status === 401
        && resolveMediaTicket(revokeTicket!.ticket, "GET", revokePath) === null,
        "「重置密码」同时吊销该用户的票据（此前只清 tokenStore，旧链接在剩余寿命内仍读得到资源）");

      // (2) 实时核对：票据记录本身仍是签发时的快照，身份由中间件回库取现状
      const liveUser = await users.createUser({
        username: "ticket-live", password: "live-pass", name: "票据现状教师",
        role_id: 2, teacher_role: "subject_teacher", subject: "数学",
      });
      const livePath = "/api/cards/CRITICALCARD001/pdf";
      const liveTicket = issueMediaTicket({
        id: liveUser.id, username: liveUser.username, name: liveUser.name,
        role_id: 2, role_name: "teacher", student_number: null, teacher_role: "subject_teacher",
        subject: "数学", password_change_required: false,
      }, livePath);
      const asTeacher = await runTicketAuth(liveTicket!.ticket, livePath);
      check(asTeacher.allowed && asTeacher.user?.role_id === 2, "票据命中时按当前身份挂载（教师）");
      check(resolveMediaTicket(liveTicket!.ticket, "GET", livePath)?.role_id === 2,
        "票据服务自身仍返回签发时的快照——评审 P1 的根因；撤销与实时核对都发生在认证中间件，不能把它当边界");
      db.prepare("UPDATE users SET role_id = ? WHERE id = ?").run(3, liveUser.id);
      const afterDemote = await runTicketAuth(liveTicket!.ticket, livePath);
      check(afterDemote.user?.role_id === 3 && afterDemote.user?.role_name === "student",
        "账号被降权后，同一张未过期票据立即以新角色判定（旧行为：沿用签发时的教师角色）");
      db.prepare("UPDATE users SET is_active = 0 WHERE id = ?").run(liveUser.id);
      const afterDisable = await runTicketAuth(liveTicket!.ticket, livePath);
      check(afterDisable.user === undefined && resolveMediaTicket(liveTicket!.ticket, "GET", livePath) === null,
        "账号被停用后票据不再冒领身份，并且该用户的票据被就地清空（不等到自然过期）");
      db.prepare("UPDATE users SET is_active = 1 WHERE id = ?").run(liveUser.id);
      const afterReenable = await runTicketAuth(liveTicket!.ticket, livePath);
      check(afterReenable.user === undefined, "重新启用账号不会让已作废的票据复活（撤销是持久的）");

      // ── R30：日志脱敏（URL 里的凭据不得进日志/错误堆栈）──
      const { redactUrlCredentials, redactAuthorizationHeader, safeErrorForLog } = await import("../src/server/lib/logRedaction");
      const redacted = redactUrlCredentials("GET /api/cards/1/pdf?token=abcdefghijklmnop&mt=qwertyuiopasdf 500");
      check(redacted.includes("token=abcdef***") && redacted.includes("mt=qwerty***") && !redacted.includes("abcdefghijklmnop"),
        `token/mt 值只留前 6 位：${redacted}`);
      check(redactUrlCredentials("/api/x?a=1&b=2") === "/api/x?a=1&b=2", "无凭据的 URL 原样保留");
      check(redactAuthorizationHeader(`Bearer ${adminToken}`) === `Bearer ${adminToken.slice(0, 6)}***`
        && !redactAuthorizationHeader(`Bearer ${adminToken}`).includes(adminToken.slice(6)),
        "Authorization 头值只保留前 6 位，日志里读不出完整令牌");
      const rawError = new Error(`request failed https://x/api/auth/me?token=${adminToken}`);
      const safeError = safeErrorForLog(rawError) as Error;
      check(safeError.message !== rawError.message && !safeError.message.includes(adminToken)
        && !(safeError.stack ?? "").includes(adminToken) && rawError.message.includes(adminToken),
        "错误副本的 message 与 stack 均已脱敏，原始对象保持不变供上层判型");

      // ── R17：前端 CSV 导出一律走 csvCell ──
      const { csvCell } = await import("../src/shared/csv");
      const downloadSource = readFileSync(path.resolve("src/apps/answer-card/client/util/download.ts"), "utf8");
      check(csvCell("=SUM(1+1)") === "\"'=SUM(1+1)\"" && csvCell("8/10") === "\"'\t8/10\"" && csvCell("a\"b") === "\"a\"\"b\"",
        "csvCell 对公式前缀加单引号、对「8/10」类日期歧义加制表符（前导 TAB 同样触发单引号防公式），并整体加引号转义");
      check(/row\.map\(csvCell\)/.test(downloadSource) && !/function esc\(/.test(downloadSource),
        "downloadCsv 已改用共享 csvCell，本地弱转义函数已移除");

      // ── R44：逐题 optionLayout 在归一化中不再丢失 ──
      const { normalizeObjectiveQuestions } = await import("../src/shared/grading");
      const normalized = normalizeObjectiveQuestions({
        id: "r44-block", type: "objective", title: "一、单选", mode: "single",
        questionStart: 1, questionCount: 2, optionCount: 4, scorePerQuestion: 5, optionLayout: "horizontal",
        questions: [
          { questionNumber: 1, optionLayout: "vertical" },
          { questionNumber: 2 }
        ]
      } as never);
      check(normalized[0]?.optionLayout === "vertical" && normalized[1]?.optionLayout === "horizontal",
        "逐题版式保留（第 1 题 vertical、第 2 题继承块级 horizontal），保存-读取往返不再压平");

      // ── R46：不定项模式拼写的统一判定入口 ──
      const { objectiveModeLabel, isMultiSelectMode } = await import("../src/shared/objectiveMode");
      check(objectiveModeLabel("indefinite") === "不定项" && objectiveModeLabel("multiple") === "多选"
        && objectiveModeLabel("single") === "单选" && objectiveModeLabel("indeterminate") === "不定项",
        "名称映射同时认 canonical 与历史拼写（此前合法的不定项只能落到兜底「客观题」）");
      check(isMultiSelectMode("indefinite") === true && isMultiSelectMode("indeterminate") === true
        && isMultiSelectMode("single") === false,
        "多选判定不再漏掉 canonical 的 indefinite 拼写");
    }

    section("Electron 渲染进程权限默认拒绝（安全 R23）与库路径诊断（安全 R31）");
    {
      // ── R23：三个权限处理器一律拒绝 + 主框架跨源导航收口 ──
      const electronMain = readFileSync(path.resolve("electron/main.cjs"), "utf8");
      execFileSync(process.execPath, ["--check", path.resolve("electron/main.cjs")], { windowsHide: true });
      check(true, "electron/main.cjs 语法可解析（node --check）");

      const policyBody = electronMain.slice(
        electronMain.indexOf("function installDevicePermissionPolicy()"),
        electronMain.indexOf("function createWindow"),
      );
      check(policyBody.length > 0 && policyBody.indexOf("function createWindow") === -1,
        "installDevicePermissionPolicy 定义在 createWindow 之前");
      check(/setPermissionRequestHandler\([\s\S]*?callback\(false\);/.test(policyBody)
        && (policyBody.match(/callback\(true\)/g) ?? []).length === 1
        && /TRUSTED_PERMISSIONS\.has\(permission\) && isTrustedPermissionOrigin\(details\?\.requestingUrl\)\)\s*\{[\s\S]{0,160}?callback\(true\);/.test(policyBody),
        "权限请求处理器默认 callback(false)，唯一的放行分支是「可信来源 + 写剪贴板」白名单（CR #313 P2-7：全拒把现场排障入口堵死了）");
      check((policyBody.match(/\breturn true\b/g) ?? []).length === 1
        && /isTrustedPermissionOrigin\(requestingOrigin\)\) return true;/.test(policyBody),
        "反向对照：整段策略里唯一的 return true 挂在检查处理器的白名单分支上（其余分支与设备枚举仍是拒绝）");
      check(/setPermissionCheckHandler\([\s\S]*?return false;/.test(policyBody)
        && /setDevicePermissionHandler\([\s\S]*?return false;/.test(policyBody),
        "权限检查与设备授权处理器一律返回 false（USB/串口/摄像头等不落到默认放行）");
      const readyBody = electronMain.slice(electronMain.indexOf("app.whenReady().then(async () => {"));
      check(readyBody.indexOf("installDevicePermissionPolicy();") > -1
        && readyBody.indexOf("installDevicePermissionPolicy();") < readyBody.indexOf("await createWindow();"),
        "权限策略在 createWindow 之前安装（窗口加载页面时策略已生效）");
      check(/contextIsolation: true/.test(electronMain) && /nodeIntegration: false/.test(electronMain)
        && /sandbox: true/.test(electronMain),
        "webPreferences 仍是 contextIsolation + sandbox + 关闭 nodeIntegration");
      const navBody = electronMain.slice(electronMain.indexOf('mainWindow.webContents.on("will-navigate"'));
      check(navBody.indexOf("event.preventDefault();") > -1
        && /const ALLOWED_EXTERNAL_SCHEMES = new Set\(\["https:"\]\)/.test(electronMain),
        "主框架跨源导航被拦下，只有 https 交系统浏览器（与 setWindowOpenHandler 同一套口径）");
      check(!/webContents\.on\("will-navigate"[\s\S]{0,200}?return;[\s\S]{0,80}?\}\);/.test(electronMain)
        && !/setWindowOpenHandler\(\(\) => \(\{ action: "allow" \}\)\)/.test(electronMain),
        "导航/新窗口处理没有退化成无条件放行");

      // ── R31：默认库路径依赖 cwd，启动时必须把「用哪个库、是否存在」说出来 ──
      const { diagnoseProjectDbPath, candidateProjectDbPaths, resolveProjectDbPath } = await import("../src/server/db/paths");
      const savedDbPath = process.env.PROJECTX_DB_PATH;
      const probeRoot = mkdtempSync(path.join(tempDir, "dbpath-"));
      // 造一个「同机另有库」的目录树：probeRoot/data/projectx.db 与 probeRoot/app/data/projectx.db
      mkdirSync(path.join(probeRoot, "data"), { recursive: true });
      writeFileSync(path.join(probeRoot, "data", "projectx.db"), "");
      const appDir = path.join(probeRoot, "app", "srv", "db");
      mkdirSync(appDir, { recursive: true });
      mkdirSync(path.join(probeRoot, "app", "data"), { recursive: true });
      writeFileSync(path.join(probeRoot, "app", "data", "projectx.db"), "");

      const candidates = candidateProjectDbPaths(appDir);
      check(candidates.length === 4 && candidates.every((c) => path.isAbsolute(c) && c.endsWith(path.join("data", "projectx.db"))),
        `向上四级探测候选库，全部为绝对路径（实际 ${candidates.length} 个）`);
      check(candidates.includes(path.join(probeRoot, "data", "projectx.db"))
        && candidates.includes(path.join(probeRoot, "app", "data", "projectx.db")),
        "候选包含各级 data/projectx.db（不写死任何厂商路径）");

      try {
        // 显式指定 + 文件存在 → 无提示
        process.env.PROJECTX_DB_PATH = path.join(probeRoot, "data", "projectx.db");
        const explicitOk = diagnoseProjectDbPath({ searchFromDir: appDir });
        check(explicitOk.explicit === true && explicitOk.exists === true && explicitOk.warnings.length === 0,
          "显式 PROJECTX_DB_PATH 指向既有库 → 不产生提示");

        // 显式指定但文件不存在 → 必须提示「将新建空库」
        process.env.PROJECTX_DB_PATH = path.join(probeRoot, "data", "typo.db");
        const explicitMissing = diagnoseProjectDbPath({ searchFromDir: appDir });
        check(explicitMissing.exists === false
          && explicitMissing.warnings.some((w) => w.includes("PROJECTX_DB_PATH") && w.includes("不存在")),
          "显式路径指向不存在的文件 → 提示将新建空库（路径拼写/挂载点复核）");

        // 未显式指定 + cwd 下没有库 → 必须同时提示「新建空库」与「同机另发现候选」
        delete process.env.PROJECTX_DB_PATH;
        const previousCwd = process.cwd();
        process.chdir(mkdtempSync(path.join(tempDir, "cwd-")));
        try {
          const implicit = diagnoseProjectDbPath({ searchFromDir: appDir });
          check(implicit.explicit === false && implicit.exists === false,
            "未设置 PROJECTX_DB_PATH 时按 cwd 推导，且该路径当前不存在");
          check(implicit.warnings.some((w) => w.includes("新建空库") && w.includes("PROJECTX_DB_PATH")),
            "未显式指定且库不存在 → 提示将新建空库并给出显式设置 PROJECTX_DB_PATH 的处置");
          check(implicit.candidates.length >= 2
            && implicit.warnings.some((w) => w.includes(`同机另发现 ${implicit.candidates.length} 个`)),
            `探测到 ${implicit.candidates.length} 个同机候选库 → 提示确认选中的是预期的那个`);
          check(!implicit.candidates.includes(path.resolve(implicit.resolved)),
            "候选列表不含当前解析出的路径本身（不自我重复提示）");
          check(!existsSync(implicit.resolved) && !existsSync(path.dirname(implicit.resolved)),
            "诊断是只读的：不创建目录、不新建库文件、不打开数据库");
          check(resolveProjectDbPath() === path.join(process.cwd(), "data", "projectx.db"),
            "诊断不改变解析结果（仍是 cwd 推导）");
        } finally {
          process.chdir(previousCwd);
        }
      } finally {
        if (savedDbPath === undefined) delete process.env.PROJECTX_DB_PATH;
        else process.env.PROJECTX_DB_PATH = savedDbPath;
      }
      check(resolveProjectDbPath() === path.resolve(savedDbPath ?? ""),
        "断言结束后 PROJECTX_DB_PATH 已还原（不影响本脚本后续用例）");

      // ── R31：getDatabase 必须在建库之前先打印诊断 ──
      const dbIndexSource = readFileSync(path.resolve("src/server/db/index.ts"), "utf8");
      const getDbBody = dbIndexSource.slice(dbIndexSource.indexOf("export function getDatabase()"));
      check(getDbBody.indexOf("diagnoseProjectDbPath()") > -1
        && getDbBody.indexOf("diagnoseProjectDbPath()") < getDbBody.indexOf("mkdirSync(")
        && getDbBody.indexOf("diagnoseProjectDbPath()") < getDbBody.indexOf("new Database("),
        "getDatabase 在 mkdirSync / new Database 之前打印 [db-path] 诊断（新建空库事后看不出原因）");
      check(/\[db-path\]/.test(getDbBody), "诊断日志带 [db-path] 前缀，便于现场按标签过滤");

      // ── R38：兜底强杀的身份校验断言在 verify:scanner-cancel 里，这里锁住源码不退化 ──
      const bridgeSource = readFileSync(
        path.resolve("src/apps/answer-card/server/scanner/twain-bridge.ts"), "utf8");
      check(/taskkill/.test(bridgeSource)
        && bridgeSource.indexOf("decideForceKill(") < bridgeSource.indexOf('execFile("taskkill"'),
        "taskkill 之前必须先过 decideForceKill 判定（R38：认不出身份就不杀）");
      check(/matchesBridgeProcess[\s\S]{0,600}?parentPid !== expected\.parentPid[\s\S]{0,400}?IDENTITY_TOLERANCE_MS/.test(bridgeSource),
        "身份判定同时校验父 PID、可执行路径与启动时刻偏差");
      check(/retireActiveScan\(sessionId\)/.test(bridgeSource)
        && !/activeScans\.delete\(sessionId\);\s*\n\s*\}/.test(bridgeSource.slice(bridgeSource.indexOf("child.on(\"close\""))),
        "close/error 走 retireActiveScan（清注册项 + 清兜底定时器），不再裸 delete");

      // ── R40：TWAIN DSM 只从规范化后的受信绝对路径加载 ──
      // 真机功能验证（Windows x64 + ia32 各自 list 出 KODAK i3000）见 SECURITY-AUDIT-NOTES；
      // 这里锁源码不退化：一旦有人把裸名候选或 LoadLibraryW 加回来，CWD/PATH 又成了加载点。
      const twainSource = readFileSync(
        path.resolve("native/ScannerBridge/scanner-bridge/twain_controller.cpp"), "utf8");
      const bridgeMainSource = readFileSync(
        path.resolve("native/ScannerBridge/scanner-bridge/main.cpp"), "utf8");
      check(!/LoadLibraryW\s*\(/.test(twainSource) && !/LoadLibraryA\s*\(/.test(twainSource),
        "R40：不再用 LoadLibraryW/A 加载 DSM（它们会把裸名交给默认搜索顺序，含 CWD 与 PATH）");
      check(/LoadLibraryExW\([^;]*LOAD_LIBRARY_SEARCH_DEFAULT_DIRS\s*\|\s*LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR/.test(twainSource),
        "R40：DSM 依赖搜索被限制在受信目录（LOAD_LIBRARY_SEARCH_DEFAULT_DIRS | DLL_LOAD_DIR）");
      check(!/candidates\[\]\s*=\s*\{[\s\S]*?L"TWAINDSM\.dll"/.test(twainSource)
        && /candidates\.push_back\(absolutePath\(/.test(twainSource),
        "R40：候选全部由 absolutePath 生成，没有裸名 TWAINDSM.dll / twain_32.dll");
      check(/isAbsoluteWinPath\(envPath\)/.test(twainSource)
        && twainSource.indexOf("isAbsoluteWinPath(envPath)") < twainSource.indexOf("candidates.push_back(resolved)"),
        "R40：TWAIN_DSM_DLL 环境覆盖必须是绝对路径，相对值/裸名被忽略并记进诊断");
      check(/isUsableDllFile\(candidate/.test(twainSource) && /finalLowerPath\(candidate\)/.test(twainSource)
        && /已离开安装目录/.test(twainSource),
        "R40：包内 DSM 要求是非空常规文件，且 junction/符号链接解析后仍在安装目录内");
      check(/SetDefaultDllDirectories\(LOAD_LIBRARY_SEARCH_DEFAULT_DIRS\)/.test(bridgeMainSource)
        && bridgeMainSource.indexOf("SetDefaultDllDirectories") < bridgeMainSource.indexOf("args.push_back(toUtf8(argv[i]))"),
        "R40：桥接进程启动即收紧全局 DLL 搜索目录，早于任何命令分发");
      for (const arch of ["win-x64", "win-ia32"] as const) {
        const stagedDir = path.resolve("resources/native", arch);
        if (!existsSync(path.join(stagedDir, "scanner-bridge.exe"))) continue;
        check(existsSync(path.join(stagedDir, "TWAINDSM.dll")),
          `R40：已打包的 ${arch} 产物目录里带着 TWAINDSM.dll（缺失时现场只能报错，不能退回搜索路径）`);
      }

      // ── R19：原生识别器在解码与矩阵分配之前必须自己收口 ──
      // 真机功能验证（x64 + ia32 各自跑「超大图片/超大布局/越界 DPI 安全退出 + 三档约定」45 项）
      // 在 `npm run verify:recognizer-limits`；这里锁构建接线与调用顺序，防止改了源码却漏掉模块或漏重建。
      const limitsSource = readFileSync(
        path.resolve("native/AnswerCardRecognizer/answer-card-recognizer/recognizer_limits.cpp"), "utf8");
      const vcxprojSource = readFileSync(
        path.resolve("native/AnswerCardRecognizer/answer-card-recognizer/answer-card-recognizer.vcxproj"), "utf8");
      check(/<ClCompile Include="recognizer_limits\.cpp" \/>/.test(vcxprojSource)
        && /<ClInclude Include="recognizer_limits\.hpp" \/>/.test(vcxprojSource),
        "R19：recognizer_limits 已挂进 vcxproj（漏挂就等于静默编译出没有边界的识别器）");
      const limitEnvNames = [...new Set(limitsSource.match(/PROJECTX_RECOGNIZER_[A-Z_]+/g) ?? [])].sort();
      const readmeSource = readFileSync(path.resolve("README.md"), "utf8");
      check(limitEnvNames.length === 7
        && limitEnvNames.every((name) => readmeSource.includes(name)),
        `R19：识别器 7 个档位环境变量与 README 表格一致（源码 ${limitEnvNames.length} 个）`);
      const limitRows = [...limitsSource.matchAll(
        /\{LimitKey::(\w+),\s*"(PROJECTX_RECOGNIZER_[A-Z_]+)",\s*"[^"]*",\s*([^,]+),\s*([^,}]+)\}/g)];
      check(limitRows.length === 7 && limitRows.every((row) => row[2].startsWith("PROJECTX_RECOGNIZER_")),
        `R19：7 个档位都写成「默认值 + 环境变量 + 天花板」三档（实际解析到 ${limitRows.length} 行）`);
      const ceilingsBelowDefault = limitRows.filter((row) => {
        const fallback = Number(row[3].replace(/LL/g, "").trim());
        const ceiling = Number(row[4].replace(/LL/g, "").trim());
        return Number.isFinite(fallback) && Number.isFinite(ceiling) && ceiling < fallback;
      }).map((row) => row[2]);
      check(ceilingsBelowDefault.length === 0,
        `R19：每档的安全天花板都不低于默认值（否则默认值自己就会被夹紧：${ceilingsBelowDefault.join(", ") || "无"}）`);
      check(/kIs64Bit \? 100000000LL : 40000000LL/.test(limitsSource),
        "R19：像素档位按位宽分档（32 位扫描端只有 2GB 地址空间，档位必须更低）");
      const recognizerVisionSource = readFileSync(
        path.resolve("native/AnswerCardRecognizer/answer-card-recognizer/vision_utils.cpp"), "utf8");
      check(!/std::istreambuf_iterator/.test(recognizerVisionSource)
        && recognizerVisionSource.indexOf("read_capped_file(path, limits.max_image_bytes") >= 0
        && recognizerVisionSource.indexOf("read_capped_file") < recognizerVisionSource.indexOf("cv::imdecode(buffer"),
        "R19：图片先按字节上限整份读入、再按头部声明尺寸预检，最后才 imdecode");
      check(recognizerVisionSource.indexOf("assert_pixel_budget") >= 0
        && recognizerVisionSource.indexOf("assert_pixel_budget") < recognizerVisionSource.indexOf("cv::warpPerspective"),
        "R19：warpPerspective 之前先过像素预算，输出尺寸不再由「布局 mm × DPI」直接决定");
      const recognizerLayoutSource = readFileSync(
        path.resolve("native/AnswerCardRecognizer/answer-card-recognizer/layout_io.cpp"), "utf8");
      check(!/input >> layout/.test(recognizerLayoutSource)
        && /read_capped_file\(layout_path, recognizer_limits\(\)\.max_layout_bytes/.test(recognizerLayoutSource),
        "R19：布局 JSON 先按字节上限读入再解析，不再让 nlohmann 在任意大小文本上建 DOM");
      check(recognizerLayoutSource.indexOf("assert_recognizer_dpi(dpi)") >= 0
        && recognizerLayoutSource.indexOf("assert_recognizer_dpi(dpi)") < recognizerLayoutSource.indexOf("std::llround(width_mm"),
        "R19：layout_pixel_size 先校 DPI 档位与毫米档位，再做 mm→px 换算（防 int 溢出成负尺寸）");
      check((recognizerLayoutSource.match(/assert_array_size\(/g) ?? []).length >= 9,
        "R19：布局里每个外部数组（pages/markers/blocks/items/options/questions/scoreCells/elements）都过条数上限");
      const recognizerMainSource = readFileSync(
        path.resolve("native/AnswerCardRecognizer/answer-card-recognizer/main.cpp"), "utf8");
      check(/SetErrorMode\(SEM_FAILCRITICALERRORS \| SEM_NOGPFAULTERRORBOX\)/.test(recognizerMainSource)
        && /\[recognizer-limits\]/.test(recognizerMainSource),
        "R19：子进程禁用模态错误框（否则调用方白等 30s 超时）并把生效档位写到 stderr");
      for (const arch of ["win-x64", "win-ia32"] as const) {
        check(existsSync(path.resolve("resources/native", arch, "answer-card-recognizer.exe")),
          `R19：${arch} 的识别器产物在包内（改了 C++ 记得 npm run native:build:${arch === "win-x64" ? "x64" : "ia32"} 重建）`);
      }

      // ── R32：跨机明文 HTTP 上不得发送账号与 API Key ──
      // 运行时证据（真实 http 服务 + 本机局域网地址，断言「服务端一个请求都没收到」）
      // 在 `npm run verify:insecure-remote-transport`；这里锁三个发送点都接了闸门，防止只改一处。
      const transportSource = readFileSync(
        path.resolve("src/apps/answer-card/client/lib/remoteCredentialTransport.ts"), "utf8");
      const apiSource = readFileSync(path.resolve("src/apps/answer-card/client/auth/api.ts"), "utf8");
      const uploadManagerSource = readFileSync(
        path.resolve("src/apps/answer-card/client/lib/scannerUploadManager.ts"), "utf8");
      const serverConfigSource = readFileSync(
        path.resolve("src/apps/answer-card/client/components/ServerConfigDialog.tsx"), "utf8");
      const scannerModeSource = readFileSync(
        path.resolve("src/apps/answer-card/client/lib/scannerMode.ts"), "utf8");

      // 用返回的 reason 字面量定序：isLoopbackHost/includes 在文件里还有定义处与白名单函数，
      // 按标识符找会先撞上定义，看不出判定顺序。
      const orderHttps = transportSource.indexOf('reason: "https"');
      const orderLoopback = transportSource.indexOf('reason: "loopback"');
      const orderAllowance = transportSource.indexOf('reason: "explicit-allowance"');
      const orderBlocked = transportSource.indexOf('reason: "blocked-plaintext"');
      check(orderHttps >= 0 && orderHttps < orderLoopback && orderLoopback < orderAllowance
        && orderAllowance < orderBlocked,
        "R32：判定顺序是 https → 回环 → 显式勾选，三档之外一律拒绝（blocked-plaintext 是兜底分支）");
      check(!/grantedHosts\.some\(|startsWith\(target\.host|includes\(target\.host\.split/.test(transportSource)
        && /return grantedHosts\.includes\(target\.host\);/.test(transportSource),
        "R32：白名单按 host:port 全等比对，没有通配或同网段推断（换端口/换主机都不继承同意）");
      check(/allowed: false,\s*\n\s*reason: "unparsable"/.test(transportSource)
        && /if \(!target\) \{/.test(transportSource),
        "R32：解析不出目标时按拒绝处理，不把 Key 送进看不懂的目标");

      check(apiSource.indexOf("assertCredentialTransportAllowed(base)") >= 0
        && apiSource.indexOf("assertCredentialTransportAllowed(base)") < apiSource.indexOf('headers.set("X-Api-Key", apiKey)'),
        "R32：remoteScannerFetch 在附加 X-Api-Key 之前先过闸门");
      check(/wantsCredential = Boolean\(apiKey\) \|\| headers\.has\("X-Api-Key"\) \|\| headers\.has\("Authorization"\)/.test(apiSource),
        "R32：闸门认「任何凭据」，不只认自己塞的那把 Key（调用方自带的 Authorization 同样被拦）");
      check(apiSource.indexOf("isRuntimeTransportAllowed") >= 0
        && (apiSource.match(/isRuntimeTransportAllowed\(\)/g) ?? []).length >= 2,
        "R32：URL 凭据（?mt= / ?token=）两条路径也过闸门——明文链路上宁可 401，也不把令牌写进 URL");
      check(/function assertRuntimeConfiguredTransportAllowed\(\): void \{\s*\n\s*if \(isScannerBuild\(\)\) return;\s*\n\s*const runtimeBase = readServerUrl\(\);/.test(apiSource)
        && /`VITE_PROJECTX_API_BASE` 不在此列/.test(apiSource),
        "R32：闸门只管运行时填写的地址，构建期写死的 VITE_PROJECTX_API_BASE 不受影响（内网 Web 部署不会被堵死且无从勾选）");

      check(uploadManagerSource.indexOf("assertCredentialTransportAllowed(j.remoteBase)") >= 0
        && uploadManagerSource.indexOf("assertCredentialTransportAllowed(j.remoteBase)")
          < uploadManagerSource.indexOf('headers.set("X-Api-Key", j.apiKey)'),
        "R32：上传管理器的快照路径按**建任务时**的地址判定，先配 https 建任务再改 http 也绕不过去");
      check(/return Promise\.reject\(error\);/.test(uploadManagerSource),
        "R32：闸门失败走 rejected promise，不逃出队列的错误处理");

      check(/decision\.reason === "blocked-plaintext" && !allowInsecure/.test(serverConfigSource)
        && serverConfigSource.indexOf("blocked-plaintext") < serverConfigSource.indexOf("saveUrl(serverUrl)"),
        "R32：跨机明文未勾选时「保存配置」直接拒绝，不会存下一个注定发不出 Key 的地址");
      check(serverConfigSource.indexOf("revokeInsecureTransportAllowance()") >= 0
        && serverConfigSource.indexOf("grantInsecureTransportAllowance(loadUrl())")
          > serverConfigSource.indexOf("revokeInsecureTransportAllowance()"),
        "R32：保存时先清空历史明文同意、再只给当前 host:port 记一笔（改回 https 即撤销）");
      check(/setAllowInsecure\(false\);/.test(serverConfigSource) && /hostRef\.current === typedHost/.test(serverConfigSource),
        "R32：地址 host 一变就清掉勾选——同意不随地址搬家");
      check(/const sendKey = Boolean\(key\) && maySendCredential;/.test(serverConfigSource),
        "R32：「测试连接」在未勾选时只做无凭据探测，不把 Key 试出去");

      check(/return `http:\/\/\$\{trimmed\}`;/.test(scannerModeSource),
        "R32：normalizeServerUrl 仍会为缺 scheme 的地址补 http://（v2.5.6 的现场修复不能因这条整改回退，明文由闸门负责拦）");

      const deployGuideSource = readFileSync(path.resolve("deploy-guide.md"), "utf8");
      check(deployGuideSource.includes("R32") && /扫描端接入必须走 HTTPS/.test(deployGuideSource),
        "R32：部署指南写明扫描接入需 HTTPS，以及扫描端会拒绝明文发送 Key");
    }

    section("演示数据凭据与导入闸门（安全 R33/R48）");
    {
      // 运行时证据（真实建库、真实 bcrypt、零改动快照）在 `npm run verify:demo-credentials`；
      // 这里锁的是「代码形状」：口令来源、教师角色、闸门位置、每个写块路径的归属判据，
      // 以及文档里不再把公开口令当成生产可用值——这些都是回归时最容易被顺手改掉的点。
      const policySource = readFileSync(path.resolve("src/server/services/demo/demoDataPolicy.ts"), "utf8");
      const demoServiceSource = readFileSync(path.resolve("src/server/services/DemoDataService.ts"), "utf8");
      const cardIdsSource = readFileSync(path.resolve("src/server/services/demo/demoCardIds.ts"), "utf8");
      const backupRouteSource = readFileSync(path.resolve("src/server/routes/backup.ts"), "utf8");
      const settingsPageSource = readFileSync(
        path.resolve("src/apps/answer-card/client/components/GlobalSettingsPage.tsx"), "utf8");
      const seedScriptSource = readFileSync(path.resolve("testdata/demo-exams/scripts/seed.ts"), "utf8");
      const readmeSource = readFileSync(path.resolve("README.md"), "utf8");

      // ── R33：口令来源与教师可见范围 ──
      check(/password: fixedCredentials \? LEGACY_PUBLIC_DEMO_TEACHER_PASSWORD : generateBootstrapAdminPassword\(\)/
        .test(demoServiceSource),
        "R33：演示教师口令默认走随机生成，固定口令只在显式开关下使用（默认分支不是 teacher123）");
      check(!demoServiceSource.includes('"teacher123"') && !demoServiceSource.includes("'teacher123'"),
        "R33：DemoDataService 里没有硬编码的公开演示口令字面量");
      check(/\.\.\.\(fixedCredentials \? \{ password: num \} : \{\}\)/.test(demoServiceSource),
        "R33：演示学生口令只在固定凭据模式下才等于学号，默认交给 batchCreateStudents 随机生成");
      check((demoServiceSource.match(/teacher_role/g) ?? []).length >= 3
        && /"subject_teacher"/.test(demoServiceSource),
        "R33：演示教师的 INSERT 与 UPDATE 都写 teacher_role='subject_teacher'（不再命中「未配置角色=全校可见」兼容分支）");
      check(demoServiceSource.includes('"teacher_classes"')
        && demoServiceSource.indexOf("insertTeacherClass, teacherId, class1.id") >= 0
        && demoServiceSource.indexOf("insertTeacherClass, teacherId, class2.id") >= 0,
        "R33：演示教师任课到两个演示班级——subject_teacher 的可见范围来自 teacher_classes，且恰好圈在演示数据里");
      check(demoServiceSource.includes("encryptField(row.password)")
        && demoServiceSource.includes("initial_password"),
        "R33：随机口令加密存入 users.initial_password，管理员可从既有「导出账密」查回（不需要新的明文通道）");

      // ── R33：开关默认关闭、非法值不放宽 ──
      check(/if \(!raw\) return false;/.test(policySource)
        && /if \(TRUTHY\.has\(raw\)\) return true;\s*\n\s*if \(FALSY\.has\(raw\)\) return false;/.test(policySource),
        "R33：两个演示开关未设即关闭，取值只认 1/true/yes/on 与 0/false/no/off");
      check(/warnOnce\(`bad-\$\{name\}`/.test(policySource) && /按关闭处理/.test(policySource),
        "R33：开关取值非法时打印 [demo-policy] 并按关闭处理，绝不静默放宽");
      check(/DEMO_POLICY_ENV_VARS/.test(policySource),
        "R33：模块声明自己的环境变量清单，供 verify 脚本断言「清空的变量 == 声明的变量」");

      // ── R33：闸门在任何写入之前 ──
      const gateAt = demoServiceSource.indexOf("await assertDemoImportAllowed(db, options);");
      check(gateAt >= 0
        && gateAt < demoServiceSource.indexOf("await ensureCrossExamTables(db);")
        && gateAt < demoServiceSource.indexOf("await cleanupDemoData(db);"),
        "R33/R48：三道闸全部在建表与 cleanupDemoData 之前判完，拒绝时库里一个字节都没动");
      check(/await assertDemoCardIdsFree\(db\);\s*\n\s*await assertDemoTeacherUsernamesAvailable\(db\);\s*\n\s*await assertDemoImportConfirmed\(db, options\?\.confirmedProductionImport\);/
        .test(demoServiceSource),
        "R33/R48：闸门按「卡号冲突 → 保留用户名被占 → 生产库需确认」顺序执行，三条都在同一个入口里");
      check(/DEMO_CARD_ID_CONFLICT/.test(demoServiceSource) && /DEMO_TEACHER_USERNAME_TAKEN/.test(demoServiceSource)
        && /DEMO_IMPORT_REQUIRES_CONFIRMATION/.test(demoServiceSource),
        "R33/R48：三种拒绝各带独立错误码，前端与运维能区分处置");
      check(/status: 409/.test(demoServiceSource),
        "R33/R48：拒绝是 409（请求本身可修正），不是 500（看起来像服务坏了）");

      // ── R33：接口与前端不把口令写进日志 ──
      check(/teacherCredentials: stats\.teacherCredentials\.map\(\(\{ username, fixed \}\) => \(\{ username, fixed \}\)\)/
        .test(backupRouteSource),
        "R33：响应体的 stats 里剥掉口令明文，只在 message 里出现一次（避免同一份口令被抓包/前端日志带走两遍）");
      check(!/console\.(log|warn|error)\([^)]*credentials/.test(backupRouteSource),
        "R33：服务端日志不打印演示口令");
      check(/confirm === DEMO_IMPORT_PRODUCTION_CONFIRM/.test(backupRouteSource),
        "R33：确认串按常量比对，路由里没有第二份硬编码字面量");
      check(settingsPageSource.includes("DEMO_IMPORT_REQUIRES_CONFIRMATION")
        && settingsPageSource.includes("postImportDemo(err.confirm)"),
        "R33：前端在 409 时二次确认并回传服务端给的确认串，不自己拼字面量");

      // ── R48：卡号清单同源 + 每条写块路径都过归属判据 ──
      check(/export const DEMO_CARD_IDS/.test(demoServiceSource)
        && /DEMO_REVIEW_CARD_ID,/.test(demoServiceSource),
        "R48：DemoDataService 导出全部演示卡号清单（含网阅卡），与闸门比对用的是同一份");
      check(/"88000001"/.test(cardIdsSource) && /"88000002"/.test(cardIdsSource) && /"88000999"/.test(cardIdsSource),
        "R48：固定演示卡号集中在 demoCardIds.ts 单一来源（此前散落在各 seeder 里，改一处漏三处）");
      check(/Number\(row\.is_demo\) === 1/.test(cardIdsSource) && /SELECT is_demo FROM answer_cards WHERE id = \?/.test(cardIdsSource),
        "R48：isDemoCard 只认 is_demo 归属标记，不按卡号前缀猜——真实卡拿到 88000001 也不算演示卡");
      for (const file of ["essayDemo.ts", "fillBlankDemo.ts", "reviewDemo.ts"]) {
        const src = readFileSync(path.resolve(`src/server/services/demo/${file}`), "utf8");
        check(/if \(!\(await isDemoCard\(db, /.test(src),
          `R48：${file} 在写演示题块前先过 isDemoCard（纵深防线，不只依赖导入前的整单拒绝）`);
      }
      check(demoServiceSource.indexOf("if (!(await isDemoCard(db, cardId))) return;") >= 0,
        "R48：ensureDemoObjectiveBlock 同样跳过非演示卡——那正是会写入标准答案 A/B/C/D/A 的地方");

      // ── 文档口径：公开口令不再被当成生产可用值 ──
      check(!/\| `demo-teacher` \| `teacher123` \|/.test(readmeSource),
        "R33：README 的登录表不再把 teacher123 列为演示教师口令");
      check(readmeSource.includes("PROJECTX_DEMO_FIXED_CREDENTIALS")
        && readmeSource.includes("PROJECTX_DEMO_ALLOW_PRODUCTION_IMPORT"),
        "R33：README 写明两个演示开关及默认值（布尔开关，非法值按关闭处理）");
      check(/仅限隔离测试库/.test(seedScriptSource) && /process\.env\[DEMO_FIXED_CREDENTIALS_ENV\] = "1"/.test(seedScriptSource),
        "R33：只有测试数据包的 seed.ts 会打开固定凭据开关，且打印「仅限隔离测试库」警告");
    }

    // ── 评审 CR #313 P2：扫描端客户端与原生侧的九项回归 ──
    section("评审 CR #313 P2：票据缓存上限 / 卸载保存版本回写 / 明文许可保持 / 皮肤护栏 / BMP 与 junction / 剪贴板");
    {
      // 这九项都在客户端或原生进程里，服务端 HTTP 看不到（<img> 的 401、C++ 的尺寸预检、
      // Electron 的权限回调都不经过这里起的测试服务），所以锁的是「改动确实还在代码里」：
      // 只查标识符会被重命名糊过去，因此按语句形态与先后顺序断言，并各留一条反向对照。
      const p2ApiSource = readFileSync(path.resolve("src/apps/answer-card/client/auth/api.ts"), "utf8");
      const p2RetrySource = readFileSync(
        path.resolve("src/apps/answer-card/client/lib/mediaTicketRetry.ts"), "utf8");
      const p2GradeSource = readFileSync(
        path.resolve("src/apps/answer-card/client/components/GradePanel.tsx"), "utf8");
      const p2PaperSource = readFileSync(
        path.resolve("src/apps/answer-card/client/components/StudentExamPaper.tsx"), "utf8");
      const p2AppSource = readFileSync(path.resolve("src/apps/answer-card/client/App.tsx"), "utf8");
      const p2ServerConfigSource = readFileSync(
        path.resolve("src/apps/answer-card/client/components/ServerConfigDialog.tsx"), "utf8");
      const p2ScannerPanelSource = readFileSync(
        path.resolve("src/apps/answer-card/client/components/ScannerPanel.tsx"), "utf8");
      const p2ElectronSource = readFileSync(path.resolve("electron/main.cjs"), "utf8");
      const p2VisionSource = readFileSync(
        path.resolve("native/AnswerCardRecognizer/answer-card-recognizer/vision_utils.cpp"), "utf8");
      const p2TwainSource = readFileSync(
        path.resolve("native/ScannerBridge/scanner-bridge/twain_controller.cpp"), "utf8");

      // P2-3（上限与服务端对齐）：档位必须来自 shared/mediaTicketLimits，不能在客户端另写一个 8
      check(/import \{ MEDIA_TICKET_MAX_PER_USER \} from "[^"]*shared\/mediaTicketLimits"/.test(p2ApiSource)
        && /const TICKET_CACHE_CAP = Math\.max\(1, MEDIA_TICKET_MAX_PER_USER\);/.test(p2ApiSource)
        && !/ticketCache\.size > 8\b/.test(p2ApiSource),
        "P2-3：客户端上限取自服务端同一档位模块（写死 8 的话，运维调档就悄悄失效了）");
      check(/while \(ticketCache\.size > TICKET_CACHE_CAP\)/.test(p2ApiSource)
        && /if \(entry\.expiresAt < oldestExpiry\)/.test(p2ApiSource),
        "P2-3：超出上限按「最早过期」驱逐，与服务端的驱逐策略同形（客户端持有的票据 ⊆ 服务端持有的）");
      check((p2ApiSource.match(/ticketCache\.set\(/g) ?? []).length === 1
        && p2ApiSource.indexOf("function rememberTicket") < p2ApiSource.indexOf("ticketCache.set("),
        "P2-3：票据只经 rememberTicket 一个入口写入缓存——绕过它写入就等于绕过上限");

      // P2-3（重签退路）：force 不得回落旧票，且重签前必须剥掉已有凭据
      check(/async function ensureMediaTicket\(pathname: string, force = false\)/.test(p2ApiSource)
        && /const fallback = force \? null : cached\?\.ticket \?\? null;/.test(p2ApiSource),
        "P2-3：强制重签失败时不回落旧票（回落就是让调用方再撞一次 401）");
      check((p2ApiSource.match(/const resolved = stripUrlCredentials\(apiUrl\(url\)\);/g) ?? []).length === 2
        && !/appendQuery\(apiUrl\(url\)/.test(p2ApiSource),
        "P2-3：拼票据的两个入口都先剥旧凭据（否则 ?mt=a&mt=b 会被 Express 解析成数组而判非法）");

      // P2-3（<img> 侧）：只重试一次、只对带票据的 URL 重试
      check(/if \(!failedUrl\.includes\("mt="\)\) return false;/.test(p2RetrySource)
        && /element\.dataset\[MEDIA_IMAGE_RETRY_KEY\] === failedUrl/.test(p2RetrySource)
        && /element\.dataset\[MEDIA_IMAGE_RETRY_KEY\] = failedUrl;/.test(p2RetrySource),
        "P2-3：图片重签以「失败的那个 URL」为一次性闸门（401→重签→401 不会变成无限循环）");
      check(p2RetrySource.indexOf("invalidateMediaTicket(failedUrl)") < p2RetrySource.indexOf("resignMediaTicketUrl(failedUrl)"),
        "P2-3：重签前先作废缓存里的旧票（顺序反了就会把刚签到的新票删掉）");
      check(/retryMediaTicketImage\(event\.currentTarget\)/.test(p2GradeSource)
        && /if \(retryMediaTicketImage\(event\.currentTarget\)\) return;\s*\n\s*setFailed\(true\);/.test(p2PaperSource),
        "P2-3：切块图与学生卷页面图都挂了 onError 重签（只修一处，另一处照样白屏）");

      // P2-1：卸载前的自动保存必须把服务端返回的新 revision 接住
      const p2FlushAt = /keepalive: true\s*\}\)\.then\(async \(response\) => \{/.test(p2AppSource);
      check(p2FlushAt
        && /const saved = await response\.json\(\)\.catch\(\(\) => null\)/.test(p2AppSource),
        "P2-1：卸载前那次 PUT 读取响应体接住新 revision（不读的话本地版本停在改动前，导出被自己的闸门拦住）");
      check(/latestCardRef\.current = \{ \.\.\.latestCardRef\.current!, revision: saved\.revision \};/.test(p2AppSource)
        && /setCard\(\(current\) => \(current \? \{ \.\.\.current, revision: saved\.revision \} : current\)\);/.test(p2AppSource),
        "P2-1：新 revision 同时落到 latestCardRef 与 card state（只更新一处，另一处仍是旧版本）");
      check(/saved && typeof saved\.revision === "number"\s*\n\s*&& editRevisionRef\.current === revision\s*\n\s*&& latestCardRef\.current\?\.id === saved\.id/.test(p2AppSource),
        "P2-1：回写仍受世代与卡片身份约束——迟到的响应不能覆盖更新的一轮改动");

      // P2-2：命中显式许可的地址原样再保存一次，不能把许可抹掉
      check(/decision\.reason === "blocked-plaintext" \|\| decision\.reason === "explicit-allowance"/.test(p2ServerConfigSource)
        && /if \(keepAllowance\) grantInsecureTransportAllowance\(loadUrl\(\)\);/.test(p2ServerConfigSource)
        && !/if \(decision\.reason === "blocked-plaintext"\) grantInsecureTransportAllowance/.test(p2ServerConfigSource),
        "P2-2：补发许可的条件含 explicit-allowance（旧写法只认 blocked-plaintext，原样再存一次就丢掉正在用的许可）");
      check(p2ServerConfigSource.indexOf("revokeInsecureTransportAllowance()")
        < p2ServerConfigSource.indexOf("if (keepAllowance) grantInsecureTransportAllowance"),
        "P2-2：先清历史许可、再按当前地址补发（顺序反了会把新许可一并清掉）");

      // P2-4：Web 端的皮肤回写必须有登录瞬态护栏
      check(/import \{ skinPatchDecision \} from "\.\/lib\/skinPatchGuard"/.test(p2AppSource)
        && /const decision = skinPatchDecision\(skinPatchPrevUserRef\.current, userId, skin, serverSkin, chosen\);/.test(p2AppSource)
        && /skinPatchPrevUserRef\.current = decision\.nextPrevUserId;/.test(p2AppSource),
        "P2-4：Web 端与扫描端共用同一护栏函数（各写一份判断，两边就会各自漂移）");
      check(!/if \(!user\) return;\s*\n\s*const serverSkin = user\.themeSkin \|\| DEFAULT_SKIN;\s*\n\s*if \(skin === serverSkin\) return;/.test(p2AppSource),
        "P2-4：反向对照：旧的「闭包 skin ≠ 账号就 PATCH」裸判断已经不在（正是交替回写的根因）");

      // P2-5：biHeight 是有符号 INT32，负值表示 top-down 行序
      check(/static_cast<long long>\(static_cast<int32_t>\(read_le\(buffer, 22, 4\)\)\)/.test(p2VisionSource)
        && /raw_height < 0 \? -raw_height : raw_height/.test(p2VisionSource)
        && !/return \{ read_le\(buffer, 18, 4\), read_le\(buffer, 22, 4\) \};/.test(p2VisionSource),
        "P2-5：BMP 高度按有符号读取并取绝对值（无符号读法把 -3000 变成 4294963000，合法 top-down 图被判伪造）");
      check(/static_cast<long long>\(read_le\(buffer, 18, 4\)\)/.test(p2VisionSource),
        "P2-5：宽度仍按无符号读——R19 对伪造尺寸的防护不受影响");

      // P2-6：junction 过的安装目录，两边都要解析成真实路径再比
      check(p2TwainSource.indexOf("std::wstring realInstallDirLower(") >= 0
        && /const std::wstring realExeDir = realInstallDirLower\(exeDir\);/.test(p2TwainSource)
        && /isUnderDir\(real, realExeDir\)/.test(p2TwainSource),
        "P2-6：随包 DSM 的归属判断比的是「真实路径 vs 真实路径」（拿逻辑目录比，junction 安装会误拒合法随包 DLL）");
      check(/if \(real\.empty\(\) \|\| !isUnderDir\(real, realExeDir\)\)/.test(p2TwainSource),
        "P2-6：DLL 侧解析失败仍然拒绝加载——只有目录侧允许退回逻辑路径");
      // 全量复检补的一条：finalLowerPath 原先用 (0, FILE_ATTRIBUTE_NORMAL) 打开句柄，
      // 目录句柄不带 backup 语义时 CreateFileW 直接失败（本机实测 ERROR_ACCESS_DENIED / gle=5），
      // 于是 realInstallDirLower 永远退回逻辑路径——「两边都解析成真实路径」只是纸面成立，
      // junction 安装目录照样被误拒。断言锁住打开方式，别让下一次重构又把它改回去。
      const p2FinalPathFn = (p2TwainSource.match(/std::wstring finalLowerPath[\s\S]*?\n\}/) ?? [""])[0];
      check(/FILE_READ_ATTRIBUTES/.test(p2FinalPathFn) && /FILE_FLAG_BACKUP_SEMANTICS/.test(p2FinalPathFn)
        && !/FILE_ATTRIBUTE_NORMAL/.test(p2FinalPathFn),
        "P2-6：真实路径解析按「只读属性 + backup 语义」打开（无此语义打不开目录，junction 修复形同未修）");

      // P2-7：默认拒绝里只留「可信来源 + 写剪贴板」这一条白名单
      check(/const TRUSTED_PERMISSIONS = new Set\(\["clipboard-sanitized-write", "clipboard-write"\]\);/.test(p2ElectronSource)
        && !/new Set\(\[[^\]]*clipboard-read/.test(p2ElectronSource),
        "P2-7：放行的只有写剪贴板，读剪贴板仍在全拒之列（读会把用户复制过的任何东西交给页面）");
      check((p2ElectronSource.match(/TRUSTED_PERMISSIONS\.has\(permission\) && isTrustedPermissionOrigin/g) ?? []).length === 2,
        "P2-7：请求处理器与检查处理器共用同一判断（只改一处会出现「检查通过、请求被拒」的错位）");
      check(/trustedOrigins\.add\(baseOrigin\)/.test(p2ElectronSource)
        && /return trustedOrigins\.has\(normalized\);/.test(p2ElectronSource)
        && /normalized = new URL\(origin\)\.origin;/.test(p2ElectronSource)
        && !/trustedOrigins\.has\([^)]*startsWith/.test(p2ElectronSource),
        "P2-7：可信来源就是壳自己加载的那个 origin，先 new URL().origin 归一化再精确比对（前缀匹配会把 evil.com 放进来）");
      check(/if \(!copied\) copied = copyViaTextarea\(text\);/.test(p2ScannerPanelSource)
        && /const ok = document\.execCommand\("copy"\);/.test(p2ScannerPanelSource)
        && /setDiagCopied\(copied\);/.test(p2ScannerPanelSource)
        && !/^\s*document\.execCommand\("copy"\);/m.test(p2ScannerPanelSource)
        && !/setDiagCopied\(true\);/.test(p2ScannerPanelSource),
        "P2-7：回退路径以 execCommand 的真实返回值为准（忽略返回值就会在复制失败时显示「已复制」）");
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
