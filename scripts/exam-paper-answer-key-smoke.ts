/**
 * v54「显示原卷 + 逐题正确答案」冒烟验证（临时 SQLite 库 + 真实 HTTP）
 * ----------------------------------------------------------------
 * 覆盖：
 *   A. exams.show_original_paper 开关：编辑页 PATCH、公布表单「公布后显示原卷」
 *      （勾选/取消/旧客户端不带字段三种情形）、批量公布。
 *   B. 学生端四重硬门：软删除 / 本人成绩 / 成绩已公布 / 开关开启；
 *      未上传原卷图片 → hasOriginalPaper=false（客户端据此显示「原卷未上传」）；
 *      列表 paper_visible 与详情 paperVisible 两处入口标记必须与门同步。
 *   C. 逐题文字答案全量保存与按页归集（含稀疏原卷页码）；答案页上传/删除/累计上限（OCR 显式关闭）。
 *   D. OCR 文本解析器（区间式/单题式/全角数字/混合行）—— 纯函数断言。
 *   E. 删除考试后清理答案页文件目录。
 *   F. v68 答案原文件直发：exams.answer_key_mode 二选一、直发模式单独开门但原卷图片仍受
 *      「显示原卷」控制、答案文件按 DB 登记页码下发（图片内联 / DOCX 附件）、切回 text 不销毁数据。
 *
 * D 也通过默认上传入口识别一张答案图。MariaDB 的 v54/v68 断言见 scripts/verify-mariadb.ts。
 *
 * 运行：npm run verify:exam-paper
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { mock } from "node:test";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import AdmZip from "adm-zip";
import sharp from "sharp";
import PDFDocument from "pdfkit";
import { ZipFile } from "yauzl";

// 先在一个带 remote config.yml 的目录里确认配置能被读到，再切到干净临时目录。
// detectDialect 在导入数据库模块时就会看 cwd；漏掉这次 chdir 会连上业务库并可能轮换 admin 口令。
const dirtyCwd = mkdtempSync(path.join(tmpdir(), "projectx-exam-paper-dirty-"));
writeFileSync(path.join(dirtyCwd, "config.yml"), [
  "database:",
  "  mode: remote",
  "  remote:",
  "    host: 127.0.0.1",
  "    port: 1",
  "    database: must-not-touch",
  "    user: nobody",
  "    password: none",
].join("\n"), "utf8");
process.chdir(dirtyCwd);
const { readDbConfig } = await import("../src/server/db/config");
if (readDbConfig().mode !== "remote") {
  throw new Error("隔离回归的 config.yml 必须能被解析为 remote");
}
const tmpDir = mkdtempSync(path.join(tmpdir(), "projectx-exam-paper-"));
process.env.PROJECTX_DB_PATH = path.join(tmpDir, "verify.db");
process.env.PROJECTX_TOKEN_DIR = path.join(tmpDir, "tokens");
// 原卷/答案页文件也写进临时目录，避免污染仓库 data/
process.env.ANSWER_CARD_DATA_DIR = path.join(tmpDir, "data");
process.env.PROJECTX_PAPER_MAX_BYTES_PER_CARD_MIB = "1";
for (const key of Object.keys(process.env)) {
  if (key.startsWith("PROJECTX_MARIADB_") || key.startsWith("PROJECTX_MYSQL_")) delete process.env[key];
}
process.chdir(tmpDir);

let passed = 0, failed = 0;
function ok(cond: boolean, label: string): void {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${label}`); }
}
function section(title: string): void {
  console.log(`\n\x1b[36m== ${title} ==\x1b[0m`);
}

const DEMO_ADMIN_PASSWORD = "Admin@ExamPaper2026";

async function login(base: string, identifier: string, password: string) {
  const r = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier, password }),
  });
  const body = await r.json().catch(() => ({}));
  return { token: body.token as string | undefined, status: r.status, body };
}

async function loginAdmin(base: string, initial: string): Promise<string> {
  const first = await login(base, "admin", initial);
  if (first.token && !first.body?.passwordChangeRequired) return first.token;
  if (first.status === 428 || first.body?.code === "PASSWORD_CHANGE_REQUIRED" || first.body?.passwordChangeRequired) {
    await fetch(`${base}/api/auth/change-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${first.body?.token ?? ""}` },
      body: JSON.stringify({ oldPassword: initial, newPassword: DEMO_ADMIN_PASSWORD }),
    }).catch(() => {});
    const retry = await login(base, "admin", DEMO_ADMIN_PASSWORD);
    if (retry.token) return retry.token;
    throw new Error(`admin 自动改密失败：首次=${first.status}，重试=${retry.status}`);
  }
  throw new Error(`admin 登录失败: status=${first.status}`);
}

async function jpegBuffer(): Promise<Buffer> {
  return sharp({
    create: { width: 40, height: 30, channels: 3, background: { r: 250, g: 250, b: 250 } },
  }).jpeg().toBuffer();
}

async function jsonFetch(base: string, url: string, init: RequestInit = {}, token?: string) {
  const r = await fetch(`${base}${url}`, {
    ...init,
    headers: {
      ...(init.body && !(init.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
}

async function paperPdfFixture(pages: (string | Buffer)[]): Promise<Buffer> {
  const doc = new PDFDocument({ autoFirstPage: false });
  const chunks: Buffer[] = [];
  const result = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", chunk => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  for (const page of pages) {
    doc.addPage();
    if (typeof page === "string") doc.fontSize(8).text(page.match(/.{1,90}/g)?.join("\n") ?? "");
    else doc.image(page, { fit: [450, 600] });
  }
  doc.end();
  return result;
}

// Starts with two scanned images whose text is BACDB and ACCAB.
async function verifyPaperAnalysis(base: string, cardId: string, token: string, dir: string) {
  const { getMysqlDb } = await import("../src/server/db/mysql");
  const db = getMysqlDb();
  type Payload = { mode: string; paperText?: string; files?: { mimeType: string; base64: string }[] };
  const received: Payload[] = [];
  const sidecar = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ knowledgePoints: [] }));
  });
  await new Promise<void>((resolve, reject) => {
    sidecar.once("error", reject);
    sidecar.listen(0, "127.0.0.1", resolve);
  });
  const address = sidecar.address();
  if (!address || typeof address === "string") throw new Error("缺少本机测试端口");
  process.env.LLMCLIENT_AUTOSTART = "false";
  process.env.LLMCLIENT_URL = `http://127.0.0.1:${address.port}`;
  const provider = await db.run(
    "INSERT INTO ai_providers (user_id, name, provider_type, base_url, api_key, models, is_system, is_active, sort_order) VALUES (1, '原卷测试', 'deepseek', '', '', ?, 1, 1, -100)",
    JSON.stringify(["text"])
  );
  const paperPath = `/api/cards/${cardId}/paper`;
  const analyze = () => jsonFetch(base, `/api/cards/${cardId}/knowledge-points/analyze`, {
    method: "POST", body: JSON.stringify({ questionRange: "全部" }), signal: AbortSignal.timeout(30000),
  }, token);
  const upload = async (files: Buffer[], extension: "pdf" | "png", replace = true) => {
    if (replace) {
      const deleted = await jsonFetch(base, paperPath, { method: "DELETE", signal: AbortSignal.timeout(5000) }, token);
      if (deleted.status !== 200) throw new Error("清理测试卷失败");
    }
    const form = new FormData();
    files.forEach((file, i) => form.append("files", new Blob([new Uint8Array(file)]), `第${i + 1}件.${extension}`));
    const result = await jsonFetch(base, paperPath, { method: "POST", body: form, signal: AbortSignal.timeout(5000) }, token);
    if (result.status !== 200) throw new Error("原卷上传失败：" + JSON.stringify(result));
  };
  try {
    const sixPages = await paperPdfFixture(["P1", "P2", "P3", "P4", "P5", "P6"]);
    const shortPage = await paperPdfFixture(["X"]);
    const { default: tesseract } = await import("tesseract.js");
    const started = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const recognize = tesseract.recognize;
    const pause = mock.method(tesseract, "recognize", async (...args: Parameters<typeof recognize>) => {
      started.resolve();
      await resume.promise;
      return recognize(...args);
    }, { times: 1 });
    const analysis = analyze();
    try {
      await Promise.race([started.promise, analysis.then(result => { throw new Error("原卷未进入 OCR：" + JSON.stringify(result)); })]);
      await upload([sixPages, shortPage], "pdf");
    } finally {
      resume.resolve();
      pause.mock.restore();
    }
    const old = await analysis;
    ok(old.status === 200 && /BACDB[\s\S]*ACCAB/.test(received.at(-1)?.paperText ?? ""),
      "识别首页期间可更换整份原卷，知识点分析收到旧卷两页");
    const fresh = await analyze();
    ok(fresh.status === 200 && received.at(-1)?.paperText?.split(/\s+/).join(" ") === "P1 P2 P3 P4 P5 P6 X",
      "换卷后读取六页 PDF 全部文字并收录单字短页");

    const images = [];
    for (let n = 3; n <= 10; n++) {
      images.push(await sharp({ create: { width: 30, height: 20, channels: 3, background: { r: n * 20, g: 30, b: 60 } } }).png().toBuffer());
    }
    await upload(images, "png", false);
    await db.run("UPDATE ai_providers SET provider_type = 'openai' WHERE id = ?", provider.lastInsertRowid);
    const direct = await analyze();
    const actual = received.at(-1)?.files ?? [];
    const originals = [sixPages, shortPage, ...images.map((_, i) => readFileSync(path.join(dir, `original-${i + 3}.jpg`)))];
    ok(direct.status === 200 && actual.length === originals.length &&
      originals.every((file, i) => actual[i].base64 === file.toString("base64") && actual[i].mimeType === (i < 2 ? "application/pdf" : "image/jpeg")),
      "直传按数字页序提交两份独立 PDF 和第 3 至 10 页图片，每页仅发送一次");
    await db.run("UPDATE ai_providers SET provider_type = 'deepseek' WHERE id = ?", provider.lastInsertRowid);

    await upload([shortPage], "pdf");
    const single = await analyze();
    ok(single.status === 200 && received.at(-1)?.paperText === "X", "整卷只有一个字符时完整交给文本模型");
    const beforeIncomplete = received.length;
    const scannedQuestion = await sharp(Buffer.from(
      '<svg width="1000" height="220" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="white"/><text x="30" y="125" font-size="62">Question 2: calculate 3 + 4.</text></svg>'
    )).png().toBuffer();
    for (const [label, second] of [["扫描题页", scannedQuestion], ["空白页", ""]] as const) {
      await upload([await paperPdfFixture(["Question 1", second])], "pdf");
      const incomplete = await analyze();
      ok(incomplete.status === 422 && incomplete.body.error === "PDF_PAGE_NO_TEXT" &&
        incomplete.body.message.includes("第 2 页") && received.length === beforeIncomplete,
        `同一 PDF 中第二页是${label}时，告知页码并终止文字分析`);
    }
    const beforeLimits = received.length;
    const longPdf = await paperPdfFixture(["A".repeat(16500)]);
    await upload([longPdf, longPdf], "pdf");
    const characters = await analyze();
    ok(characters.status === 413 && characters.body.error === "PAPER_TOO_LARGE", "两份普通 PDF 累计超过 32000 字符时返回 413");
    const twentyOne = await paperPdfFixture(Array.from({ length: 21 }, (_, i) => `Page ${i + 1}`));
    await upload([twentyOne, twentyOne], "pdf");
    const pages = await analyze();
    ok(pages.status === 413 && pages.body.error === "PAPER_TOO_LARGE" && received.length === beforeLimits,
      "两份普通 PDF 合计 42 页时返回 413，超额原卷均未送达模型");
  } finally {
    await db.run("DELETE FROM ai_providers WHERE id = ?", provider.lastInsertRowid);
    sidecar.closeAllConnections();
    await new Promise<void>(resolve => sidecar.close(() => resolve()));
  }
}

async function main() {
  console.log(`临时库: ${process.env.PROJECTX_DB_PATH}`);
  const { detectDialect } = await import("../src/server/db/mysql");
  if (detectDialect() !== "sqlite") {
    throw new Error("默认回归必须在临时 SQLite 上运行：config.yml remote 配置未被隔离");
  }
  const { initializeDatabase, ensureDefaultAdmin, getDatabase, closeDatabase } = await import("../src/server/db/index");
  const { createApp } = await import("../src/apps/answer-card/server/index");
  const { getMysqlDb } = await import("../src/server/db");
  const { parseAnswerKeyText } = await import("../src/apps/answer-card/server/answer-key-ocr");
  const { answerKeyDir, answerKeysDir, paperDir, paperTmpDir } = await import("../src/apps/answer-card/server/storage");
  const { resolveAnswerKeyPageFile, resolveAnswerKeyPreviewFile } = await import("../src/server/services/ExamPaperViewService");

  initializeDatabase();
  const sqlite = getDatabase();
  const bootstrap = await ensureDefaultAdmin();

  // ── 夹具：一个班两名学生、一张卡、两场考试（B 场用于批量公布）────────
  const gradeId = Number(sqlite.prepare("INSERT INTO grades (name, sort_order, is_demo) VALUES ('原卷测试年级', 1, 0)").run().lastInsertRowid);
  const classId = Number(sqlite.prepare("INSERT INTO classes (grade_id, name, sort_order, is_demo) VALUES (?, '原卷测试班', 1, 0)").run(gradeId).lastInsertRowid);
  const s1 = Number(sqlite.prepare("INSERT INTO users (username, password_hash, name, role_id, student_number, is_active) VALUES ('50001', ?, '原卷学生甲', 3, '50001', 1)")
    .run(bcrypt.hashSync("50001", 10)).lastInsertRowid);
  const s2 = Number(sqlite.prepare("INSERT INTO users (username, password_hash, name, role_id, student_number, is_active) VALUES ('50002', ?, '原卷学生乙', 3, '50002', 1)")
    .run(bcrypt.hashSync("50002", 10)).lastInsertRowid);
  sqlite.prepare("INSERT INTO class_students (class_id, student_id) VALUES (?, ?)").run(classId, s1);
  sqlite.prepare("INSERT INTO class_students (class_id, student_id) VALUES (?, ?)").run(classId, s2);

  const cardId = "PAPERCARD01";
  sqlite.prepare(`INSERT INTO answer_cards (id, title, subject, subject_label, exam_date, paper_size, orientation, student_fields, student_number_digits, sided, layout_version, created_by)
    VALUES (?, '原卷测试卡', 'math', '数学', '2026-09-01', 'A4', 'portrait', '{}', 5, 'single', 1, 1)`).run(cardId);

  const adminId = Number(sqlite.prepare("SELECT id FROM users WHERE username='admin'").get().id);
  function insertExam(name: string, published: number): number {
    return Number(sqlite.prepare(
      `INSERT INTO exams (name, card_id, grade_id, class_id, subject, start_time, status, score_published, exam_mode, created_by)
       VALUES (?, ?, ?, ?, '数学', CURRENT_TIMESTAMP, 'closed', ?, 'formal', ?)`
    ).run(name, cardId, gradeId, classId, published, adminId).lastInsertRowid);
  }
  const examId = insertExam("原卷测试考试", 0);
  const batchExamId = insertExam("原卷批量考试", 0);
  sqlite.prepare("INSERT INTO student_scores (exam_id, student_id, objective_score, subjective_score, total_score) VALUES (?, ?, 85, 0, 85)").run(examId, s1);
  sqlite.prepare("INSERT INTO student_scores (exam_id, student_id, objective_score, subjective_score, total_score) VALUES (?, ?, 76, 0, 76)").run(examId, s2);
  sqlite.prepare("INSERT INTO student_scores (exam_id, student_id, objective_score, subjective_score, total_score) VALUES (?, ?, 90, 0, 90)").run(batchExamId, s1);
  // 公布要求「应考集合 ⊇ 已评分集合」：把两名有成绩的学生固化为应考名单
  sqlite.prepare("INSERT INTO exam_participants (exam_id, student_id, source) VALUES (?, ?, 'roster')").run(examId, s1);
  sqlite.prepare("INSERT INTO exam_participants (exam_id, student_id, source) VALUES (?, ?, 'roster')").run(examId, s2);
  sqlite.prepare("INSERT INTO exam_participants (exam_id, student_id, source) VALUES (?, ?, 'roster')").run(batchExamId, s1);

  const outsiderId = Number(sqlite.prepare("INSERT INTO users (username,password_hash,name,role_id,is_active) VALUES ('publish-outsider',?,'外部教师',2,1)")
    .run(bcrypt.hashSync("teacher-pass",10)).lastInsertRowid);
  const partialQuiz = insertExam("部分出分晨测",0);
  const ownedQuiz = insertExam("本人晨测",0);
  for (const id of [partialQuiz,ownedQuiz]) {
    sqlite.prepare("UPDATE exams SET exam_mode='quiz',status='grading' WHERE id=?").run(id);
    sqlite.prepare("INSERT INTO student_scores (exam_id,student_id,total_score) VALUES (?,?,85)").run(id,s1);
    for (const sid of [s1,s2]) sqlite.prepare("INSERT INTO exam_participants (exam_id,student_id,source) VALUES (?,?,'roster')").run(id,sid);
  }
  sqlite.prepare("UPDATE exams SET created_by=? WHERE id=?").run(outsiderId,ownedQuiz);
  const app = await createApp();
  const server: Server = await new Promise((resolve, reject) => {
    const s = createServer(app);
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const adminToken = await loginAdmin(base, readFileSync(bootstrap.passwordFile, "utf8").trim());
  const stuToken = (await login(base, "50001", "50001")).token!;
  const otherToken = (await login(base, "50002", "50002")).token!;
  ok(Boolean(adminToken && stuToken && otherToken), "admin / 两名学生登录成功");

  const outsiderToken = (await login(base,"publish-outsider","teacher-pass")).token!;
  ok(Boolean(outsiderToken),"无组织归属教师登录成功");
  const deniedSingle = await jsonFetch(base,`/api/exams/${partialQuiz}/publish`,{method:"POST",body:JSON.stringify({showOriginalPaper:true})},outsiderToken);
  ok(deniedSingle.status===403,"晨测可见不代表可公布：无归属教师单场发布返回 403");
  const deniedBatch = await jsonFetch(base,"/api/exams/publish-batch",{method:"POST",body:JSON.stringify({examIds:[ownedQuiz,partialQuiz],showOriginalPaper:true})},outsiderToken);
  ok(deniedBatch.status===403,"批量混入无权考试整批返回 403");
  for (const id of [partialQuiz,ownedQuiz]) {
    const row = sqlite.prepare("SELECT score_published,show_original_paper FROM exams WHERE id=?").get(id);
    ok(row.score_published===0 && row.show_original_paper!==1,"拒绝后不更改公布和原卷开关");
    ok(sqlite.prepare("SELECT COUNT(*) AS n FROM exam_publish_events WHERE exam_id=?").get(id).n===0,"拒绝后无公布审计写入");
  }
  const hiddenPaper = await jsonFetch(base,`/api/scores/me/exams/${partialQuiz}/paper`,{},stuToken);
  ok(hiddenPaper.status===404 && !hiddenPaper.body?.pages && !hiddenPaper.body?.answers,`越权公布被拒绝后学生不能读取原卷与答案（HTTP ${hiddenPaper.status}）`);
  const ownerPublished = await jsonFetch(base,`/api/exams/${ownedQuiz}/publish`,{method:"POST",body:"{}"},outsiderToken);
  ok(ownerPublished.status===200,"考试创建者仍可公布部分出分晨测");
  const patchExam = (body: unknown, token = adminToken) =>
    jsonFetch(base, `/api/exams/${examId}`, { method: "PATCH", body: JSON.stringify(body) }, token);
  const publish = (id: number, body: unknown, token = adminToken) =>
    jsonFetch(base, `/api/exams/${id}/publish`, { method: "POST", body: JSON.stringify(body ?? {}) }, token);
  const unpublish = (id: number, token = adminToken) =>
    jsonFetch(base, `/api/exams/${id}/unpublish`, { method: "POST", body: JSON.stringify({ reason: "smoke" }) }, token);
  const studentPaper = (token: string, id = examId) => jsonFetch(base, `/api/scores/me/exams/${id}/paper`, {}, token);
  /**
   * 读取两处「查看原卷」入口标记：列表逐条的 paper_visible、详情单场的 paperVisible。
   * 考试未公布时该行可能整个不出现在列表里 —— 对学生而言同样是「没有入口」，故按 0 计。
   */
  async function paperFlags(stuTok: string, id: number): Promise<{ listed: number; detail: number }> {
    const list = await jsonFetch(base, "/api/scores/me", {}, stuTok);
    const row = (list.body?.scores ?? []).find((s: { exam_id: number }) => s.exam_id === id);
    const one = await jsonFetch(base, `/api/scores/me/exams/${id}`, {}, stuTok);
    return { listed: Number(row?.paper_visible ?? 0), detail: Number(one.body?.paperVisible ?? 0) };
  }
  const showFlag = async (id = examId): Promise<number | null> =>
    Number((await getMysqlDb().get("SELECT show_original_paper FROM exams WHERE id = ?", id) as { show_original_paper: number }).show_original_paper);
  const publishedFlag = async (id = examId): Promise<number | null> =>
    Number((await getMysqlDb().get("SELECT score_published FROM exams WHERE id = ?", id) as { score_published: number }).score_published);

  // ── A. 开关与公布 ────────────────────────────────────
  section("A. 显示原卷开关（需求 1）");
  ok((await showFlag()) === 0, "新建考试默认 show_original_paper=0（默认关闭）");
  ok((await patchExam({ showOriginalPaper: true })).body?.show_original_paper === 1, "编辑页打开开关 → PATCH 生效");
  ok((await showFlag()) === 1, "DB 中开关已置 1");
  ok((await patchExam({ showOriginalPaper: false })).status === 200 && (await showFlag()) === 0, "编辑页关闭开关 → DB 置 0");
  ok((await patchExam({ showOriginalPaper: "yes" })).status === 400, "非布尔值开关 → 400");

  await unpublish(examId);
  await getMysqlDb().run("UPDATE exams SET score_published = 0 WHERE id = ?", examId);
  const pubOn = await publish(examId, { showOriginalPaper: true });
  ok(pubOn.status === 200 && (await publishedFlag()) === 1 && (await showFlag()) === 1, "公布时勾选「公布后显示原卷」→ score_published=1 且开关=1");
  await unpublish(examId);
  await getMysqlDb().run("UPDATE exams SET score_published = 0 WHERE id = ?", examId);
  const pubOff = await publish(examId, { showOriginalPaper: false });
  ok(pubOff.status === 200 && (await publishedFlag()) === 1 && (await showFlag()) === 0, "取消勾选 → score_published=1 但开关=0");
  await unpublish(examId);
  await getMysqlDb().run("UPDATE exams SET score_published = 0, show_original_paper = 1 WHERE id = ?", examId);
  const pubLegacy = await publish(examId, {});
  ok(pubLegacy.status === 200 && (await showFlag()) === 1, "旧客户端不带该字段公布 → 不改写开关（不误公开）");
  await unpublish(examId);
  await getMysqlDb().run("UPDATE exams SET score_published = 0, show_original_paper = 1 WHERE id = ?", examId);
  await getMysqlDb().run("UPDATE exams SET score_published = 0, show_original_paper = 0 WHERE id = ?", batchExamId);
  const batch = await jsonFetch(base, "/api/exams/publish-batch", {
    method: "POST",
    body: JSON.stringify({ examIds: [examId, batchExamId], showOriginalPaper: true }),
  }, adminToken);
  ok(batch.status === 200 && (await showFlag(examId)) === 1 && (await showFlag(batchExamId)) === 1, "批量公布带勾选 → 两场开关同时置 1");

  // ── B. 学生端硬门 ────────────────────────────────────
  section("B. 学生查看原卷的门（需求 3，后端强制）");
  await unpublish(examId);
  await getMysqlDb().run("UPDATE exams SET score_published = 0, show_original_paper = 1 WHERE id = ?", examId);
  ok((await studentPaper(stuToken)).status === 404, "成绩未公布 → 404");
  await getMysqlDb().run("UPDATE exams SET score_published = 1, show_original_paper = 0 WHERE id = ?", examId);
  const closedGate = await studentPaper(stuToken);
  ok(closedGate.status === 404 && String(closedGate.body?.message ?? "").includes("未开放"), "已公布但开关关闭 → 404 且提示未开放");
  await getMysqlDb().run("UPDATE exams SET show_original_paper = 1 WHERE id = ?", examId);
  const noPaper = await studentPaper(stuToken);
  ok(noPaper.status === 200 && noPaper.body?.hasOriginalPaper === false && (noPaper.body?.pages ?? []).length === 0, "开关开启但从未上传原卷 → 200 且 hasOriginalPaper=false（前端显示「原卷未上传」）");
  // 入口标记与 /paper 同一道门：列表 paper_visible、详情 paperVisible，前端不自行推断
  const listedOn = await paperFlags(stuToken, examId);
  ok(listedOn.listed === 1 && listedOn.detail === 1, "已公布 + 开关开 → 列表 paper_visible=1、详情 paperVisible=1");
  await getMysqlDb().run("UPDATE exams SET show_original_paper = 0 WHERE id = ?", examId);
  const listedOff = await paperFlags(stuToken, examId);
  ok(listedOff.listed === 0 && listedOff.detail === 0, "开关关闭 → 两处入口标记都归 0");
  await getMysqlDb().run("UPDATE exams SET score_published = 0 WHERE id = ?", examId);
  await getMysqlDb().run("UPDATE exams SET show_original_paper = 1 WHERE id = ?", examId);
  const listedUnpublished = await paperFlags(stuToken, examId);
  ok(listedUnpublished.listed === 0 && listedUnpublished.detail === 0, "成绩未公布 → 即使开关开着入口标记也是 0");
  await getMysqlDb().run("UPDATE exams SET score_published = 1 WHERE id = ?", examId);
  ok((await studentPaper(otherToken)).status === 200, "同班另一学生（有成绩）也可查看");
  await getMysqlDb().run("DELETE FROM student_scores WHERE exam_id = ? AND student_id = ?", examId, s2);
  ok((await studentPaper(otherToken)).status === 404, "无该场成绩的学生 → 404");
  await getMysqlDb().run("INSERT INTO student_scores (exam_id, student_id, objective_score, subjective_score, total_score) VALUES (?, ?, 76, 0, 76)", examId, s2);
  ok((await studentPaper("")).status === 401, "未认证 → 401");
  // 软删除考试对任何学生不可见
  await getMysqlDb().run("INSERT INTO exam_archives (exam_id, archive_path, is_deleted) VALUES (?, 'x', 1)", examId);
  ok((await studentPaper(stuToken)).status === 404, "软删除考试 → 404");
  await getMysqlDb().run("DELETE FROM exam_archives WHERE exam_id = ?", examId);

  // Use a normal document at the isolated process's exact expanded-byte limit.
  const { DOCX_LIMITS } = await import("../src/apps/answer-card/server/paper-docx");
  const document = new AdmZip();
  const parts = {
    "[Content_Types].xml": '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "_rels/.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/document.xml": '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>练习题</w:t></w:r></w:p></w:body></w:document>',
  };
  for (const [name, xml] of Object.entries(parts)) document.addFile(name, Buffer.from(xml));
  const docx = document.toBuffer();
  const paperPath = `/api/cards/${cardId}/paper`;
  const sendDocument = () => {
    const form = new FormData();
    form.append("files", new Blob([new Uint8Array(docx)]), "练习.docx");
    return jsonFetch(base, paperPath, { method: "POST", body: form }, adminToken);
  };
  const fullLimit = DOCX_LIMITS.expandedBytes;
  try {
    Object.assign(DOCX_LIMITS, { expandedBytes: Object.values(parts).reduce((n, xml) => n + Buffer.byteLength(xml), 0) });
    ok((await sendDocument()).status === 200, "普通 DOCX 恰好达到解压限额时上传成功");
    // Hold one archive read while a second teacher request saves another card.
    const notesCard = "PAPERNOTES02";
    sqlite.prepare("INSERT INTO answer_cards (id, title) VALUES (?, ?)").run(notesCard, "并发备注测试");
    const reading = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const openReadStream = ZipFile.prototype.openReadStream;
    const pause = mock.method(ZipFile.prototype, "openReadStream", function (this: ZipFile, ...args: unknown[]) {
      reading.resolve();
      void resume.promise.then(() => Reflect.apply(openReadStream, this, args));
    }, { times: 1 });
    const upload = sendDocument();
    const notesPath = `/api/cards/${notesCard}/paper/info`;
    const notes = "另一张卡已经确认的备注";
    try {
      await Promise.race([reading.promise, upload.then(() => { throw new Error("未读到已存的 DOCX"); })]);
      const saved = await jsonFetch(base, notesPath, {
        method: "PUT", body: JSON.stringify({ questionRange: "全部", extraNotes: notes }), signal: AbortSignal.timeout(10000),
      }, adminToken);
      ok(saved.status === 200 && saved.body.success === true, "读取原卷期间，另一张卡可成功保存备注");
    } finally {
      resume.resolve();
      pause.mock.restore();
    }
    const next = await upload;
    ok(next.status === 413 && next.body.code === "PAPER_TOO_LARGE", "追加普通 DOCX 超过整卷解压限额时返回 413");
    const savedNotes = await jsonFetch(base, notesPath, {}, adminToken);
    ok(savedNotes.status === 200 && savedNotes.body.extra_notes === notes, "超额 DOCX 被拒后，并发保存的备注可读");
    const info = await jsonFetch(base, paperPath + "/info", {}, adminToken);
    ok(info.body.pages?.length === 1 && readdirSync(paperDir(cardId)).length === 1 &&
      readFileSync(path.join(paperDir(cardId), "original.docx")).equals(docx) && readdirSync(paperTmpDir).length === 0,
    "拒绝后原页内容完整，页记录、原卷目录和暂存目录均无新增");
  } finally {
    Object.assign(DOCX_LIMITS, { expandedBytes: fullLimit });
    await jsonFetch(base, paperPath, { method: "DELETE" }, adminToken);
  }

  // 使用无系统字体依赖的矢量路径绘制标准印刷字符，避免不同 CI/OS 的默认 sans-serif 字体差异导致 OCR 漂移。
  const OCR_GLYPHS: Record<string, { w: number; d: string }> = {
    "0": { w: 47.3, d: "M23 -59.4Q34.5 -59.4 39.7 -49.9Q43.7 -42.6 43.7 -29.8Q43.7 -17.7 40.1 -9.8Q34.8 1.6 23 1.6Q12.2 1.6 7 -7.7Q2.7 -15.4 2.7 -28.5Q2.7 -38.6 5.3 -45.9Q10.2 -59.4 23 -59.4ZM22.9 -5.2Q28.7 -5.2 32.2 -10.3Q35.6 -15.5 35.6 -29.5Q35.6 -39.6 33.1 -46.2Q30.6 -52.7 23.4 -52.7Q16.9 -52.7 13.8 -46.5Q10.7 -40.3 10.7 -28.2Q10.7 -19.1 12.7 -13.6Q15.7 -5.2 22.9 -5.2Z" },
    "1": { w: 47.3, d: "M8.1 -42.1L8.1 -47.8Q16.2 -48.6 19.4 -50.4Q22.6 -52.3 24.2 -59.2L30.1 -59.2L30.1 0L22.1 0L22.1 -42.1Z" },
    "5": { w: 47.3, d: "M10.5 -15.1Q11.2 -8.8 16.4 -6.3Q19.1 -5.1 22.6 -5.1Q29.2 -5.1 32.4 -9.3Q35.6 -13.5 35.6 -18.7Q35.6 -24.9 31.8 -28.3Q28 -31.7 22.7 -31.7Q18.8 -31.7 16.1 -30.2Q13.3 -28.7 11.4 -26.1L4.9 -26.4L9.4 -58.4L40.3 -58.4L40.3 -51.2L15 -51.2L12.5 -34.7Q14.6 -36.3 16.4 -37.1Q19.8 -38.4 24.1 -38.4Q32.3 -38.4 38 -33.2Q43.7 -27.9 43.7 -19.8Q43.7 -11.4 38.5 -4.9Q33.2 1.5 21.8 1.5Q14.6 1.5 9 -2.6Q3.4 -6.7 2.7 -15.1Z" },
    "6": { w: 47.3, d: "M24.9 -59.7Q34.8 -59.7 38.7 -54.5Q42.7 -49.3 42.7 -43.9L35.3 -43.9Q34.6 -47.4 33.2 -49.4Q30.5 -53.1 25 -53.1Q18.7 -53.1 15 -47.3Q11.3 -41.5 10.9 -30.8Q13.5 -34.5 17.4 -36.4Q21 -38.1 25.4 -38.1Q32.8 -38.1 38.4 -33.3Q44 -28.5 44 -19.1Q44 -11 38.7 -4.7Q33.4 1.5 23.7 1.5Q15.3 1.5 9.3 -4.8Q3.2 -11.1 3.2 -26.1Q3.2 -37.2 5.9 -44.9Q11.1 -59.7 24.9 -59.7ZM24.3 -5.1Q30.2 -5.1 33.1 -9.1Q36.1 -13 36.1 -18.4Q36.1 -23 33.5 -27.1Q30.8 -31.3 23.9 -31.3Q19.1 -31.3 15.5 -28.1Q11.9 -24.9 11.9 -18.4Q11.9 -12.8 15.2 -8.9Q18.5 -5.1 24.3 -5.1Z" },
    "-": { w: 28.3, d: "M3.5 -27.5L24.4 -27.5L24.4 -19.8L3.5 -19.8Z" },
    "A": { w: 56.7, d: "M37.8 -25L28.5 -51.9L18.7 -25ZM24.2 -61L33.5 -61L55.7 0L46.6 0L40.4 -18.3L16.3 -18.3L9.7 0L1.2 0Z" },
    "B": { w: 56.7, d: "M29.4 -35.2Q34.6 -35.2 37.5 -36.6Q42.1 -38.9 42.1 -44.9Q42.1 -50.8 37.2 -52.9Q34.5 -54.1 29.1 -54.1L14.4 -54.1L14.4 -35.2ZM32.2 -7.1Q39.8 -7.1 43 -11.5Q45 -14.2 45 -18.2Q45 -24.8 39.1 -27.2Q35.9 -28.5 30.8 -28.5L14.4 -28.5L14.4 -7.1ZM6.3 -61L32.5 -61Q43.2 -61 47.7 -54.6Q50.3 -50.8 50.3 -45.9Q50.3 -40.1 47.1 -36.4Q45.4 -34.4 42.2 -32.8Q46.9 -31 49.2 -28.8Q53.3 -24.8 53.3 -17.8Q53.3 -11.9 49.6 -7.1Q44.1 0 32 0L6.3 0Z" },
    "C": { w: 61.4, d: "M32.2 -62.6Q43.7 -62.6 50.1 -56.5Q56.5 -50.4 57.2 -42.7L49.2 -42.7Q47.8 -48.6 43.7 -52Q39.6 -55.4 32.2 -55.4Q23.2 -55.4 17.7 -49.1Q12.2 -42.8 12.2 -29.7Q12.2 -19 17.2 -12.3Q22.2 -5.7 32.1 -5.7Q41.2 -5.7 46 -12.7Q48.5 -16.4 49.8 -22.4L57.8 -22.4Q56.7 -12.8 50.7 -6.3Q43.4 1.6 31.1 1.6Q20.5 1.6 13.2 -4.9Q3.7 -13.4 3.7 -31.1Q3.7 -44.6 10.9 -53.2Q18.6 -62.6 32.2 -62.6ZM30.5 -62.6Z" },
    "D": { w: 61.4, d: "M29.9 -7.1Q34.1 -7.1 36.8 -7.9Q41.6 -9.5 44.7 -14.2Q47.1 -17.8 48.2 -23.6Q48.8 -27.1 48.8 -30Q48.8 -41.3 44.3 -47.6Q39.8 -53.9 29.8 -53.9L15.1 -53.9L15.1 -7.1ZM6.8 -61L31.5 -61Q44.1 -61 51 -52Q57.2 -44 57.2 -31.4Q57.2 -21.7 53.6 -13.9Q47.1 0 31.5 0L6.8 0Z" },
    " ": { w: 23.6, d: "" },
  };
  const scanImage = (line: string) => {
    let x = 60;
    const paths: string[] = [];
    for (const ch of line) {
      const glyph = OCR_GLYPHS[ch];
      if (!glyph) throw new Error(`Missing vector glyph for OCR fixture char: ${ch}`);
      if (glyph.d) paths.push(`<path d="${glyph.d}" transform="translate(${x.toFixed(1)},145)" fill="#000"/>`);
      x += glyph.w;
    }
    return sharp(Buffer.from(
      `<svg width="1000" height="220" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#fff"/>${paths.join("")}</svg>`
    ));
  };
  const bigTiff = await scanImage("1-5 BACDB").tiff({ bigtiff: true, compression: "lzw" }).toBuffer();
  const secondPage = await scanImage("6-10 ACCAB").png().toBuffer();
  // A database failure after conversion must roll back just this upload.
  const converting = Promise.withResolvers<void>();
  const resumeConversion = Promise.withResolvers<void>();
  const toBuffer = sharp.prototype.toBuffer;
  const delayConversion = mock.method(sharp.prototype, "toBuffer", function (this: sharp.Sharp, ...args: unknown[]) {
    converting.resolve();
    return resumeConversion.promise.then(() => Reflect.apply(toBuffer, this, args));
  }, { times: 1 });
  sqlite.exec("CREATE TRIGGER paper_upload_failure BEFORE INSERT ON original_paper_pages BEGIN SELECT RAISE(ABORT,'test upload failure'); END");
  try {
    const form = new FormData();
    form.append("files", new Blob([bigTiff], { type: "image/tiff" }), "正常扫描件.tif");
    const attempt = jsonFetch(base, paperPath, { method: "POST", body: form }, adminToken);
    try {
      await Promise.race([converting.promise, attempt.then(() => { throw new Error("未进入扫描件转换"); })]);
      const edit = await jsonFetch(base, "/api/cards/PAPERNOTES02/paper/info", {
        method: "PUT", body: JSON.stringify({ questionRange: "全部", extraNotes: "图像转换期间保存" }), signal: AbortSignal.timeout(10000)
      }, adminToken);
      ok(edit.status === 200, "图像转换期间可保存其他卡备注");
    } finally {
      resumeConversion.resolve();
    }
    const response = await attempt;
    const notes = await jsonFetch(base, "/api/cards/PAPERNOTES02/paper/info", {}, adminToken);
    ok(response.status === 500 && notes.body.extra_notes === "图像转换期间保存",
      "转换后入库失败，独立请求已保存的备注保留");
    ok(readdirSync(paperTmpDir).length === 0 && readdirSync(paperDir(cardId)).length === 0,
      "转换后入库失败，生成的图片和配对 PDF 均清理");
  } finally {
    delayConversion.mock.restore();
    sqlite.exec("DROP TRIGGER paper_upload_failure");
  }
  const calibrationImage = await sharp(randomBytes(900 * 900), { raw: { width: 900, height: 900, channels: 1 } })
    .toColourspace("b-w").png().toBuffer();
  const calibration = new FormData();
  calibration.append("files", new Blob([new Uint8Array(calibrationImage)]), "灰度扫描校准.png");
  const measured = await jsonFetch(base, paperPath, { method: "POST", body: calibration }, adminToken);
  ok(calibrationImage.length < 1024 * 1024 && measured.status === 413 && measured.body.measuredAfterConversion === true,
    "输入小于 1 MiB，转换后的 JPEG 与 PDF 合计超出单卡额度时返回 413");
  ok((await jsonFetch(base, paperPath + "/info", {}, adminToken)).body.pages.length === 0
    && readdirSync(paperTmpDir).length === 0 && readdirSync(paperDir(cardId)).length === 0,
    "实际转换容量超额后，正式目录、暂存目录和页记录均为空");

  const bigPaper = new FormData();
  bigPaper.append("files", new Blob([bigTiff], { type: "image/tiff" }), "扫描原卷.tif");
  bigPaper.append("files", new Blob([secondPage], { type: "image/png" }), "第二页.png");
  const uploadedPaper = await jsonFetch(base, paperPath, { method: "POST", body: bigPaper }, adminToken);
  ok(uploadedPaper.status === 200 && uploadedPaper.body.count === 2, "单页 BigTIFF 和 PNG 按顺序上传为两页原卷");
  const paperPdf = await fetch(base + paperPath, { headers: { Authorization: `Bearer ${adminToken}` } });
  const pdf = Buffer.from(await paperPdf.arrayBuffer());
  ok(paperPdf.status === 200 && pdf.subarray(0, 5).toString() === "%PDF-", "BigTIFF 原卷可下载配对 PDF");
  const { autoExtractPaperText } = await import("../src/apps/answer-card/server/paper-ocr");
  const scanned = await autoExtractPaperText(cardId);
  ok(scanned.source === "ocr" && /BACDB[\s\S]*ACCAB/.test(scanned.text ?? ""), "纯文本分析按页识别两张原卷图片");
  const multiTiff = await sharp([bigTiff, secondPage], { join: { animated: true } }).tiff({ bigtiff: true }).toBuffer();
  const multiPaper = new FormData();
  multiPaper.append("files", new Blob([multiTiff], { type: "image/tiff" }), "两页原卷.tif");
  const rejectedTiff = await jsonFetch(base, paperPath, { method: "POST", body: multiPaper }, adminToken);
  const paperInfo = await jsonFetch(base, paperPath + "/info", {}, adminToken);
  ok(rejectedTiff.status === 400 && rejectedTiff.body.code === "MULTIPAGE_PAPER_IMAGE"
    && paperInfo.body.pages?.length === 2 && readdirSync(paperDir(cardId)).length === 4 && readdirSync(paperTmpDir).length === 0,
    "多页 BigTIFF 明确拒收，原卷只保留先前两页及其配对 PDF");
  const interrupted = new FormData();
  interrupted.append("files", new Blob([secondPage.subarray(0, Math.floor(secondPage.length / 2))], { type: "image/png" }), "传输中断.png");
  const invalidImage = await jsonFetch(base, paperPath, { method: "POST", body: interrupted }, adminToken);
  ok(invalidImage.status === 400 && invalidImage.body.code === "INVALID_PAPER_IMAGE" &&
    readdirSync(paperDir(cardId)).length === 4 && readdirSync(paperTmpDir).length === 0,
    "PNG 文件像素数据传输中断时返回图片格式错误，已上传原卷可保留");
  await verifyPaperAnalysis(base, cardId, adminToken, paperDir(cardId));
  await jsonFetch(base, paperPath, { method: "DELETE" }, adminToken);

  // 落一张真实的第 1 页原卷图片（走既有卡片级分页表）
  const dir = paperDir(cardId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "original.jpg"), await jpegBuffer());
  await getMysqlDb().run("INSERT INTO original_paper_pages (card_id, page_index, filename, stored_path) VALUES (?, 1, 'original.jpg', ?)", cardId, `papers/${cardId}/original.jpg`);
  const withPaper = await studentPaper(stuToken);
  const page0 = (withPaper.body?.pages ?? [])[0];
  ok(withPaper.status === 200 && withPaper.body?.hasOriginalPaper === true && page0?.pageIndex === 1, "上传过原卷图片 → pages 返回第 1 页");
  ok(page0?.imageUrl === `/api/scores/me/exams/${examId}/paper/pages/1/image`, "imageUrl 为考试级受控路径（不含文件名）");
  const imgRes = await fetch(`${base}${page0.imageUrl}`, { headers: { Authorization: `Bearer ${stuToken}` } });
  ok(imgRes.status === 200 && (imgRes.headers.get("content-type") ?? "").includes("image/jpeg"), "学生可取到原卷图片字节");
  const otherExam = Number(sqlite.prepare(
    `INSERT INTO exams (name, card_id, grade_id, class_id, subject, status, score_published, exam_mode, show_original_paper, created_by)
     VALUES ('越权测试考试', ?, ?, ?, '数学', 'closed', 1, 'formal', 1, ?)`
  ).run(cardId, gradeId, classId, adminId).lastInsertRowid);
  const traversal = await fetch(`${base}/api/scores/me/exams/${otherExam}/paper/pages/1/image`, { headers: { Authorization: `Bearer ${stuToken}` } });
  ok(traversal.status === 404, "学生无成绩的考试原卷页 → 404（图片路由同一套门）");
  const badPage = await fetch(`${base}/api/scores/me/exams/${examId}/paper/pages/99/image`, { headers: { Authorization: `Bearer ${stuToken}` } });
  ok(badPage.status === 404, "不存在的页码 → 404");
  const nonNumericPage = await fetch(`${base}/api/scores/me/exams/${examId}/paper/pages/..%2F..%2Fconfig/image`, { headers: { Authorization: `Bearer ${stuToken}` } });
  ok(nonNumericPage.status === 400 || nonNumericPage.status === 404, "路径穿越式页码 → 400/404（不接受文件名）");

  // ── C. 逐题答案与答案页 ──────────────────────────────
  section("C. 本次正确答案（需求 2/4）");
  const putAnswers = (body: unknown, token = adminToken) =>
    jsonFetch(base, `/api/exams/${examId}/answer-key`, { method: "PUT", body: JSON.stringify(body) }, token);
  const saved = await putAnswers({ answers: [
    { questionNumber: 1, answerText: "B", pageIndex: 1 },
    { questionNumber: 2, answerText: "光合作用  速率", pageIndex: 1 },
    { questionNumber: 5, answerText: "偏大", pageIndex: 1 },
  ] });
  ok(saved.status === 200 && (saved.body?.answers ?? []).length === 3, "逐题答案保存成功（3 题）");
  ok((saved.body?.answers ?? [])[1]?.answerText === "光合作用 速率", "答案文字仅折叠空白，不做任何对错解析");
  const replace = await putAnswers({ answers: [{ questionNumber: 1, answerText: "AC" }] });
  ok((replace.body?.answers ?? []).length === 1 && (await getMysqlDb().get("SELECT 1 AS x FROM exam_answer_keys WHERE exam_id = ? AND question_number = 2", examId)) === null, "再次全量保存 → 未提交的题号被删除");
  await putAnswers({ answers: [
    { questionNumber: 1, answerText: "B", pageIndex: 1 },
    { questionNumber: 2, answerText: "光合作用" },
    { questionNumber: 3, answerText: "偏大", pageIndex: 7 },
  ] });
  const withAnswers = await studentPaper(stuToken);
  const pageAnswers = (withAnswers.body?.pages ?? [])[0]?.answers ?? [];
  ok(pageAnswers.map((a: { questionNumber: number }) => a.questionNumber).join(",") === "1,2,3", "学生端按题号升序拿到答案，页码缺失/越界的题也渲染到现有页（不静默丢弃）");
  ok((withAnswers.body?.answers ?? []).length === 3, "全量 answers 字段同步返回（供「只看答案」列表）");
  ok(!JSON.stringify(withAnswers.body).includes("answer-key"), "学生 payload 不含教师答案页路径");
  ok((await putAnswers({ answers: [{ questionNumber: 0, answerText: "A" }] })).status === 400, "题号非法 → 400");
  ok((await putAnswers({ answers: [{ questionNumber: 1, answerText: "  " }] })).status === 400, "答案文字为空 → 400");
  ok((await putAnswers({ answers: [{ questionNumber: 1, answerText: "A" }, { questionNumber: 1, answerText: "B" }] })).status === 400, "题号重复 → 400");
  ok((await putAnswers({ answers: "x" })).status === 400, "answers 非数组 → 400");
  ok((await putAnswers({ answers: [] })).body?.saved === 0, "空数组 → 清空该场答案");

  await putAnswers({ answers: [{ questionNumber: 1, answerText: "B", pageIndex: 1 }] });
  const form = new FormData();
  form.append("files", new Blob([await jpegBuffer()], { type: "image/jpeg" }), "答案第1页.jpg");
  const uploaded = await fetch(`${base}/api/exams/${examId}/answer-key/pages?ocr=0`, {
    method: "POST", headers: { Authorization: `Bearer ${adminToken}` }, body: form,
  });
  const uploadBody = await uploaded.json().catch(() => ({}));
  ok(uploaded.status === 200 && (uploadBody?.pages ?? []).length === 1, "答案页上传成功（?ocr=0 跳过识别）");
  ok(uploadBody?.ocr === null, "ocr=0 时不返回识别结果");
  const teacherImage = await fetch(`${base}/api/exams/${examId}/answer-key/pages/1/image`, { headers: { Authorization: `Bearer ${adminToken}` } });
  ok(teacherImage.status === 200 && existsjpeg(teacherImage.headers.get("content-type")), "教师可核对答案页图片");
  const studentHitsAnswerKey = await fetch(`${base}/api/exams/${examId}/answer-key`, { headers: { Authorization: `Bearer ${stuToken}` } });
  ok(studentHitsAnswerKey.status === 403, "学生访问教师答案配置接口 → 403（权限不放开）");
  const ghostForm = new FormData();
  ghostForm.append("files", new Blob([await jpegBuffer()], { type: "image/jpeg" }), "不存在考试.jpg");
  const ghost = await fetch(`${base}/api/exams/999999/answer-key/pages?ocr=0`, {
    method: "POST", headers: { Authorization: `Bearer ${adminToken}` }, body: ghostForm,
  });
  ok(
    ghost.status === 404 && readdirSync(path.join(answerKeysDir, "_tmp")).length === 0,
    "考试不存在时上传 → 404 且不留 _tmp 暂存文件（multer 已落盘的文件同样要清）"
  );
  const list = await jsonFetch(base, `/api/exams/${examId}/answer-key`, {}, adminToken);
  ok(list.status === 200 && (list.body?.paperPages ?? []).length === 1 && (list.body?.answerPages ?? []).length === 1, "配置面板同时返回原卷页与答案页");
  ok(list.body?.hasOriginalPaper === true && list.body?.showOriginalPaper === 1, "面板回显开关与原卷状态");
  const deleted = await jsonFetch(base, `/api/exams/${examId}/answer-key/pages/1`, { method: "DELETE" }, adminToken);
  ok(deleted.status === 200 && (deleted.body?.answerPages ?? []).length === 0, "答案页删除后列表为空");
  const keptPage = await getMysqlDb().get("SELECT page_index FROM exam_answer_keys WHERE exam_id = ? AND question_number = 1", examId) as { page_index: number | null };
  ok(keptPage?.page_index === 1, "删除答案扫描页不动答案的原卷页归属（两种页码分属不同资产，不联动清空）");

  // 并发上传同一场考试：页码分配必须串行，否则两请求抢同一页码 + 同一 answerkey-<n> 文件名，
  // 失败方的回滚会删掉成功方的文件（或留下指向别人字节的记录）
  const concurrent = await Promise.all([1, 2].map(async (i) => {
    const f = new FormData();
    f.append("files", new Blob([await jpegBuffer()], { type: "image/jpeg" }), `并发第${i}页.jpg`);
    const r = await fetch(`${base}/api/exams/${examId}/answer-key/pages?ocr=0`, {
      method: "POST", headers: { Authorization: `Bearer ${adminToken}` }, body: f,
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }));
  const concurrentPages = ((await jsonFetch(base, `/api/exams/${examId}/answer-key`, {}, adminToken)).body?.answerPages ?? []) as Array<{ pageIndex: number; filename: string }>;
  ok(
    concurrent.every((r) => r.status === 200)
      && concurrentPages.length === 2
      && new Set(concurrentPages.map((p) => p.pageIndex)).size === 2
      && new Set(concurrentPages.map((p) => p.filename)).size === 2,
    "并发上传 → 两页各得独立页码与文件（不互相覆盖/回滚删除）"
  );
  for (const page of concurrentPages) {
    await jsonFetch(base, `/api/exams/${examId}/answer-key/pages/${page.pageIndex}`, { method: "DELETE" }, adminToken);
  }

  const farPaper = await putAnswers({ answers: [{ questionNumber: 9, answerText: "A", pageIndex: 11 }] });
  ok(farPaper.status === 200, "答案归属原卷第 11 页不被答案上传上限（10）截断");

  // 稀疏原卷页码（删掉中间页后可能只剩 [1,3]）：归属第 3 页的答案不能被塞进不存在的第 2 页
  await writeFile(path.join(dir, "original-3.jpg"), await jpegBuffer());
  await getMysqlDb().run("INSERT INTO original_paper_pages (card_id, page_index, filename, stored_path) VALUES (?, 3, 'original-3.jpg', ?)", cardId, `papers/${cardId}/original-3.jpg`);
  await putAnswers({ answers: [{ questionNumber: 4, answerText: "第三页答案", pageIndex: 3 }] });
  const sparse = await studentPaper(stuToken);
  const sparsePages = (sparse.body?.pages ?? []) as Array<{ pageIndex: number; answers: Array<{ questionNumber: number }> }>;
  const pageThree = sparsePages.find((item) => item.pageIndex === 3);
  ok(
    sparsePages.length === 2 && (pageThree?.answers ?? []).some((a) => a.questionNumber === 4),
    "原卷页码稀疏 [1,3] → 归属第 3 页的答案仍渲染在真实存在的第 3 页"
  );
  await putAnswers({ answers: [] });

  // 累计容量：分多次上传不能堆出第 11 页；页码始终保持最小空闲分配
  let filled = true;
  for (let i = 1; i <= 10; i++) {
    const f = new FormData();
    f.append("files", new Blob([await jpegBuffer()], { type: "image/jpeg" }), `累计第${i}页.jpg`);
    const r = await fetch(`${base}/api/exams/${examId}/answer-key/pages?ocr=0`, {
      method: "POST", headers: { Authorization: `Bearer ${adminToken}` }, body: f,
    });
    if (r.status !== 200) { ok(false, `分次补传到 10 页应全部成功（第 ${i} 次返回 ${r.status}）`); filled = false; break; }
  }
  if (filled) {
    const overflowForm = new FormData();
    overflowForm.append("files", new Blob([await jpegBuffer()], { type: "image/jpeg" }), "第11页.jpg");
    const overflow = await fetch(`${base}/api/exams/${examId}/answer-key/pages?ocr=0`, {
      method: "POST", headers: { Authorization: `Bearer ${adminToken}` }, body: overflowForm,
    });
    ok(overflow.status === 400, "累计第 11 页上传 → 400（上限按累计而非单批计）");
    ok(
      readdirSync(path.join(answerKeysDir, "_tmp")).length === 0,
      "累计超限被拒后不留 _tmp 暂存文件（重试不会堆积垃圾）"
    );
    const delMid = await jsonFetch(base, `/api/exams/${examId}/answer-key/pages/5`, { method: "DELETE" }, adminToken);
    ok(delMid.status === 200 && (delMid.body?.answerPages ?? []).length === 9, "中途页可删除（页码 1..10 全程可查看/删除）");
    const reuseForm = new FormData();
    reuseForm.append("files", new Blob([await jpegBuffer()], { type: "image/jpeg" }), "补位第5页.jpg");
    const reused = await fetch(`${base}/api/exams/${examId}/answer-key/pages?ocr=0`, {
      method: "POST", headers: { Authorization: `Bearer ${adminToken}` }, body: reuseForm,
    });
    const reusedBody = await reused.json().catch(() => ({}));
    ok(reused.status === 200 && (reusedBody?.pages ?? [])[0]?.pageIndex === 5, "删除后重传补位最小空闲页码（不再 MAX+1 越界）");
  }

  // ── C2. 失败上传残留与解析优先级（评审 P2 回归）────────
  section("C2. 答案页残留清理与解析优先级");
  const orphanExamId = insertExam("残留清理考试", 0);
  const orphanDir = answerKeyDir(orphanExamId);
  const answerKeyPageRows = (id: number): number =>
    Number(sqlite.prepare("SELECT COUNT(*) AS c FROM exam_answer_key_pages WHERE exam_id = ?").get(id).c);
  const residueFiles = (dir: string): string[] =>
    existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith("answerkey")) : [];

  // 「正常 JPG + 损坏 JPG」：整批失败，且已转好的那一页不能留在磁盘上当孤儿
  const mixedForm = new FormData();
  mixedForm.append("files", new Blob([await jpegBuffer()], { type: "image/jpeg" }), "正常页.jpg");
  mixedForm.append("files", new Blob([Buffer.from("definitely not a jpeg")], { type: "image/jpeg" }), "损坏页.jpg");
  const mixedUpload = await fetch(`${base}/api/exams/${orphanExamId}/answer-key/pages?ocr=0`, {
    method: "POST", headers: { Authorization: `Bearer ${adminToken}` }, body: mixedForm,
  });
  ok(mixedUpload.status === 400, `含非图片文件的上传整体返回 400（实际 ${mixedUpload.status}）`);
  ok(answerKeyPageRows(orphanExamId) === 0, "失败上传不写入任何答案页记录");
  ok(
    residueFiles(orphanDir).length === 0,
    `失败上传不留孤儿文件（实际残留：${residueFiles(orphanDir).join("、") || "无"}）`
  );

  // 重试：同页成功上传 PDF，并登记为 answerkey.pdf
  const pdfForm = new FormData();
  pdfForm.append("files", new Blob([Buffer.from("%PDF-1.4\n% smoke fixture\n")], { type: "application/pdf" }), "答案.pdf");
  const pdfUpload = await fetch(`${base}/api/exams/${orphanExamId}/answer-key/pages?ocr=0`, {
    method: "POST", headers: { Authorization: `Bearer ${adminToken}` }, body: pdfForm,
  });
  const pdfBody = await pdfUpload.json().catch(() => ({}));
  const pdfPage = (pdfBody?.pages ?? [])[0];
  ok(
    pdfUpload.status === 200 && pdfPage?.pageIndex === 1 && pdfPage?.filename === "answerkey.pdf",
    `重试上传 PDF 登记为 answerkey.pdf（实际 ${pdfPage?.filename ?? "无"}）`
  );

  // 手动植入修复前失败上传会留下的 answerkey.jpg：解析必须以 DB 登记文件为准
  await writeFile(path.join(orphanDir, "answerkey.jpg"), await jpegBuffer());
  const previewAfterResidue = await fetch(`${base}/api/exams/${orphanExamId}/answer-key/pages/1/image`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const previewType = previewAfterResidue.headers.get("content-type") ?? "";
  ok(
    previewAfterResidue.status === 200 && previewType.includes("pdf"),
    `同页存在 .jpg 残留时预览仍返回登记页（content-type=${previewType}）`
  );
  const orphanCfg = await jsonFetch(base, `/api/exams/${orphanExamId}/answer-key`, {}, adminToken);
  ok(
    (orphanCfg.body?.answerPages ?? [])[0]?.filename === "answerkey.pdf",
    "答案页列表同样以登记文件名为准，不被同页残留遮蔽"
  );

  // 有文件无 DB 记录 = 孤儿：预览与重识别都必须 404，不能再被当作已上传页读取
  await writeFile(path.join(orphanDir, "answerkey-9.jpg"), await jpegBuffer());
  const ghostPreview = await fetch(`${base}/api/exams/${orphanExamId}/answer-key/pages/9/image`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  ok(ghostPreview.status === 404, `无 DB 记录的残留文件不可预览（返回 ${ghostPreview.status}）`);
  const ghostReocr = await fetch(`${base}/api/exams/${orphanExamId}/answer-key/pages/9/ocr`, {
    method: "POST", headers: { Authorization: `Bearer ${adminToken}` },
  });
  ok(ghostReocr.status === 404, `无 DB 记录的残留文件不可重识别（返回 ${ghostReocr.status}）`);

  // ── D. OCR 文本解析（纯函数）──────────────────────────
  section("D. OCR 文本解析");
  const ocrExamId = insertExam("图片答案草稿", 1);
  const answerPng = await scanImage("1-5 BACDB").png().toBuffer();
  const answerImage = new FormData();
  answerImage.append("files", new Blob([answerPng], { type: "image/png" }), "答案.png");
  const recognized = await jsonFetch(base, `/api/exams/${ocrExamId}/answer-key/pages`, {
    method: "POST", body: answerImage,
  }, adminToken);
  const draft = recognized.body?.ocr?.[0]?.drafts ?? [];
  ok(recognized.status === 200 && draft.map((entry: { answerText: string }) => entry.answerText).join("") === "BACDB",
    `上传一张清晰答案图后得到五题 OCR 草稿（实际 status=${recognized.status}, ocr=${JSON.stringify(recognized.body?.ocr)}）`);

  const answerPagesPath = `/api/exams/${ocrExamId}/answer-key/pages`;
  const busyImage = new FormData();
  busyImage.append("files", new Blob([answerPng], { type: "image/png" }), "待识别.png");
  const { default: tesseract } = await import("tesseract.js");
  const ocrStarted = Promise.withResolvers<void>();
  const finishOcr = Promise.withResolvers<void>();
  const originalRecognize = tesseract.recognize;
  const pausedOcr = mock.method(tesseract, "recognize", async (...args: Parameters<typeof originalRecognize>) => {
    ocrStarted.resolve();
    await finishOcr.promise;
    return originalRecognize(...args);
  }, { times: 1 });
  const pendingPage = jsonFetch(base, answerPagesPath, { method: "POST", body: busyImage }, adminToken);
  let backup: Promise<Response> | undefined;
  const replacement = await sharp({ create: { width: 43, height: 31, channels: 3, background: "white" } }).png().toBuffer();
  try {
    await Promise.race([ocrStarted.promise, pendingPage.then(() => { throw new Error("答案页未开始识别"); })]);
    const activeTmp = readdirSync(path.join(answerKeysDir, "_tmp"));
    ok(activeTmp.length === 0, "识别期间上传暂存目录已清理");
    const busy = await jsonFetch(base, answerPagesPath + "/1/ocr", { method: "POST" }, adminToken);
    ok(busy.status === 429 && busy.body.code === "PAPER_OCR_BUSY", "并发重新识别得到可重试的忙碌响应");
    const removed = await jsonFetch(base, answerPagesPath + "/2", { method: "DELETE", signal: AbortSignal.timeout(5000) }, adminToken);
    ok(removed.status === 200, "图片 OCR 工作期间可以删除该页");
    const newFile = new FormData();
    newFile.append("files", new Blob([replacement], { type: "image/png" }), "替换页.png");
    const replaced = await jsonFetch(base, answerPagesPath + "?ocr=0", {
      method: "POST", body: newFile, signal: AbortSignal.timeout(5000),
    }, adminToken);
    ok(replaced.status === 200 && replaced.body.pages?.[0]?.pageIndex === 2, "识别期间同一页码可以上传新的 PNG");

    backup = fetch(base + "/api/db/backup", { headers: { Authorization: `Bearer ${adminToken}` } });
    const { isServiceMaintenanceActive } = await import("../src/server/lib/serviceTasks");
    const deadline = Date.now() + 5000;
    while (!isServiceMaintenanceActive() && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    ok(isServiceMaintenanceActive(), "并发备份已进入维护流程，等待识别请求结束");
  } finally {
    finishOcr.resolve();
    pausedOcr.mock.restore();
  }
  const finishedUpload = await pendingPage;
  const oldDraft = finishedUpload.body?.ocr?.[0];
  ok(finishedUpload.status === 200 && oldDraft?.recognized === false && oldDraft?.drafts?.length === 0 && oldDraft?.error,
    "旧识别返回时，同页已替换的答案不会生成草稿");
  if (backup) {
    const response = await backup;
    const data = new AdmZip(Buffer.from(await response.arrayBuffer()));
    const copy = data.readFile(`data/answer-card/answer-keys/${ocrExamId}/answerkey-2.png`);
    ok(response.status === 200 && copy?.equals(replacement), "备份保存替换后的答案文件");
  }
  const retry = await jsonFetch(base, answerPagesPath + "/1/ocr", { method: "POST" }, adminToken);
  ok(retry.status === 200 && retry.body.drafts?.map((entry: { answerText: string }) => entry.answerText).join("") === "BACDB",
    `并发替换结束后可重新识别，识别名额正常释放（实际 status=${retry.status}, body=${JSON.stringify(retry.body)}）`);
  const range = parseAnswerKeyText("1-5 BACDB\n6~10: CCBDA");
  ok(range.length === 10 && range[0].answerText === "B" && range[3].answerText === "D" && range[4].answerText === "B" && range[9].answerText === "A", "区间式「1-5 BACDB」「6~10: CCBDA」逐题展开");
  const single = parseAnswerKeyText("21. 叶绿体\n22、温度过高导致酶失活");
  ok(single.length === 2 && single[0].questionNumber === 21 && single[1].answerText.includes("酶失活"), "单题式「21. 答案」按行解析");
  const fullwidth = parseAnswerKeyText("１２．AB");
  ok(fullwidth.length === 1 && fullwidth[0].questionNumber === 12 && fullwidth[0].answerText === "AB", "全角题号与分隔符归一");
  const mixed = parseAnswerKeyText("一、选择题\n1．A 2．B 3．C\n11-13 ABD");
  ok(mixed.map((m) => m.questionNumber).join(",") === "1,2,3,11,12,13", "同一行多题 + 区间混排");
  ok(parseAnswerKeyText("1-5 BACD\n完全无关的一段说明文字").length === 0, "区间长度与选项数不匹配时不猜答案");
  ok(parseAnswerKeyText("").length === 0, "空文本 → 空草稿");

  // ── F. 答案原文件直发模式（v68）────────────────────────
  section("F. 答案原文件直发（需求：可不 OCR，直接把上传件发给学生）");
  const modeExamId = insertExam("答案直发考试", 1);
  sqlite.prepare("INSERT INTO student_scores (exam_id, student_id, objective_score, subjective_score, total_score) VALUES (?, ?, 88, 0, 88)").run(modeExamId, s1);
  sqlite.prepare("INSERT INTO exam_participants (exam_id, student_id, source) VALUES (?, ?, 'roster')").run(modeExamId, s1);
  const modePaper = (token = stuToken) => studentPaper(token, modeExamId);
  const patchMode = (body: unknown) =>
    jsonFetch(base, `/api/exams/${modeExamId}`, { method: "PATCH", body: JSON.stringify(body) }, adminToken);
  const putModeAnswers = (body: unknown) =>
    jsonFetch(base, `/api/exams/${modeExamId}/answer-key`, { method: "PUT", body: JSON.stringify(body) }, adminToken);
  const uploadModePage = async (blob: Blob, name: string) => {
    const form = new FormData();
    form.append("files", blob, name);
    const r = await fetch(`${base}/api/exams/${modeExamId}/answer-key/pages?ocr=0`, {
      method: "POST", headers: { Authorization: `Bearer ${adminToken}` }, body: form,
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const modeColumn = async (): Promise<string> =>
    String((await getMysqlDb().get("SELECT answer_key_mode FROM exams WHERE id = ?", modeExamId) as { answer_key_mode: string }).answer_key_mode);
  const modeShowColumn = async (): Promise<number> =>
    Number((await getMysqlDb().get("SELECT show_original_paper FROM exams WHERE id = ?", modeExamId) as { show_original_paper: number }).show_original_paper);

  ok((await modeColumn()) === "text" && (await modeShowColumn()) === 0, "新建考试默认 answer_key_mode='text'（v54 行为不变）");
  ok((await patchMode({ answerKeyMode: "pdf" })).status === 400, "非法模式 → 400");
  ok((await modeColumn()) === "text", "非法模式被拒后不落库");
  await putModeAnswers({ answers: [{ questionNumber: 1, answerText: "B" }, { questionNumber: 2, answerText: "大于 90" }] });
  const uploadedJpeg = await jpegBuffer();
  const pageImage = await uploadModePage(new Blob([uploadedJpeg], { type: "image/jpeg" }), "答案扫描页.jpg");
  const pageDocx = await uploadModePage(
    new Blob([Buffer.from("PK\x03\x04 fake docx fixture")], {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }),
    "答案.docx",
  );
  ok(pageImage.status === 200 && pageDocx.status === 200, "答案页上传（图片 + DOCX，?ocr=0 全程不识别）");

  await patchMode({ answerKeyMode: "file" });
  await getMysqlDb().run("UPDATE exams SET score_published = 0 WHERE id = ?", modeExamId);
  ok((await modePaper()).status === 404, "直发模式但成绩未公布 → 404（模式不绕公布门）");
  await getMysqlDb().run("UPDATE exams SET score_published = 1 WHERE id = ?", modeExamId);
  ok((await modeColumn()) === "file" && (await modeShowColumn()) === 0, "切模式不改「显示原卷」开关（两道闸互不越权）");
  const flagsFile = await paperFlags(stuToken, modeExamId);
  ok(flagsFile.listed === 1 && flagsFile.detail === 1, "已公布 + 直发模式（原卷开关仍关）→ 列表与详情入口标记都为 1");

  const fileView = await modePaper();
  const fileRows = (fileView.body?.answerFiles ?? []) as Array<{ pageIndex: number; filename: string; mimeType: string; isImage: boolean; fileUrl: string }>;
  ok(fileView.status === 200 && fileView.body?.answerKeyMode === "file", "/paper 回显 answerKeyMode='file'");
  ok((fileView.body?.answerFiles ?? []).length === 2 && fileRows[0]?.fileUrl === `/api/scores/me/exams/${modeExamId}/paper/answer-file/1`,
    "answerFiles 按页码给出受控 fileUrl（不含文件名）");
  ok(fileRows[0]?.isImage === true && fileRows[0]?.mimeType === "image/jpeg", "图片答案页标记为可内联（isImage + mime）");
  ok(fileRows[1]?.isImage === false && String(fileRows[1]?.mimeType).includes("wordprocessingml"), "DOCX 答案页标记为非图片并带真实 mime");
  ok((fileView.body?.answers ?? []).length === 0
    && ((fileView.body?.pages ?? []) as Array<{ answers: unknown[] }>).every((p) => (p.answers ?? []).length === 0),
    "直发模式不下发逐题文字答案（二选一，不是叠加）");
  ok(fileView.body?.hasOriginalPaper === false && (fileView.body?.pages ?? []).length === 0 && (fileView.body?.showOriginalPaper ?? 0) === 0,
    "「显示原卷」关闭时原卷页与 hasOriginalPaper 仍收着（直发不顺带泄露试卷）");

  const fileImageRes = await fetch(`${base}/api/scores/me/exams/${modeExamId}/paper/answer-file/1`, { headers: { Authorization: `Bearer ${stuToken}` } });
  const fileImageBytes = Buffer.from(await fileImageRes.arrayBuffer());
  ok(fileImageRes.status === 200 && (fileImageRes.headers.get("content-type") ?? "").includes("image/jpeg"), "学生可取到答案图片字节");
  ok(fileImageRes.headers.get("cache-control") === "private, no-store", "答案文件不进浏览器缓存，换账号不能命中上一名学生的字节");
  ok(fileImageBytes.equals(uploadedJpeg), "JPEG 原字节原样下发，不再二次压缩");
  {
    const registeredName = fileRows[0]?.filename;
    const registeredPath = registeredName ? path.join(answerKeyDir(modeExamId), registeredName) : "";
    const orphanName = registeredName?.replace(/\.[^.]+$/, ".pdf");
    const orphanPath = orphanName ? path.join(answerKeyDir(modeExamId), orphanName) : "";
    if (registeredPath && orphanPath && existsSync(registeredPath) && orphanName !== registeredName) {
      const registeredBytes = readFileSync(registeredPath);
      unlinkSync(registeredPath);
      writeFileSync(orphanPath, Buffer.from("%PDF-1.1 orphan answer"));
      const orphanRes = await fetch(`${base}/api/scores/me/exams/${modeExamId}/paper/answer-file/1`, { headers: { Authorization: `Bearer ${stuToken}` } });
      const orphanBody = await orphanRes.text();
      ok(orphanRes.status === 404 && !orphanBody.includes("%PDF"), "登记文件缺失时学生端不回退到其他扩展名的孤儿文件");
      const orphanView = await modePaper();
      const stillListed = ((orphanView.body?.answerFiles ?? []) as Array<{ pageIndex: number }>).some((row) => row.pageIndex === 1);
      ok(!stillListed, "学生答案列表不把孤儿文件当成已登记的第 1 页");
      writeFileSync(registeredPath, registeredBytes);
      unlinkSync(orphanPath);
      const restored = await fetch(`${base}/api/scores/me/exams/${modeExamId}/paper/answer-file/1`, { headers: { Authorization: `Bearer ${stuToken}` } });
      ok(restored.status === 200, "登记文件放回后学生端重新可取");
    } else {
      ok(false, "答案图片路径可用于孤儿回退回归");
    }
  }
  const uploadedPng = await sharp({
    create: { width: 80, height: 60, channels: 3, background: { r: 1, g: 2, b: 3 } },
  }).png().toBuffer();
  const pagePng = await uploadModePage(new Blob([uploadedPng], { type: "image/png" }), "答案原图.png");
  ok(pagePng.status === 200 && pagePng.body?.pages?.[0]?.filename === "answerkey-3.png", "PNG 按原扩展名登记，不再改写成 JPEG");
  const pngRes = await fetch(`${base}/api/scores/me/exams/${modeExamId}/paper/answer-file/3`, { headers: { Authorization: `Bearer ${stuToken}` } });
  const pngBytes = Buffer.from(await pngRes.arrayBuffer());
  ok(pngRes.status === 200 && (pngRes.headers.get("content-type") ?? "").includes("image/png") && pngBytes.equals(uploadedPng),
    "学生下载到的 PNG 与上传字节一致");
  const pngPreviewPath = path.join(answerKeyDir(modeExamId), "answerkey-3.preview.jpg");
  const teacherPng = await fetch(`${base}/api/exams/${modeExamId}/answer-key/pages/3/image`, { headers: { Authorization: `Bearer ${adminToken}` } });
  const teacherPngBytes = Buffer.from(await teacherPng.arrayBuffer());
  ok(existsSync(pngPreviewPath) && teacherPng.status === 200 && (teacherPng.headers.get("content-type") ?? "").includes("image/jpeg")
    && !teacherPngBytes.equals(uploadedPng),
    "教师预览与 OCR 走压缩派生图，不把原 PNG 当预览");
  const studentOriginal = resolveAnswerKeyPageFile(modeExamId, 3, "answerkey-3.png", { exact: true });
  ok(studentOriginal?.filename === "answerkey-3.png", "学生直发解析仍指向登记的原文件");

  const uploadedTiff = await sharp({
    create: { width: 80, height: 60, channels: 3, background: { r: 4, g: 5, b: 6 } },
  }).tiff().toBuffer();
  const pageTiff = await uploadModePage(new Blob([uploadedTiff], { type: "image/tiff" }), "答案扫描件.tiff");
  ok(pageTiff.status === 200 && pageTiff.body?.pages?.[0]?.filename === "answerkey-4.tiff",
    "TIFF 按原扩展名登记并生成教师预览");
  const tiffPreviewPath = path.join(answerKeyDir(modeExamId), "answerkey-4.preview.jpg");
  const teacherTiff = await fetch(`${base}/api/exams/${modeExamId}/answer-key/pages/4/image`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  ok(existsSync(tiffPreviewPath) && (teacherTiff.headers.get("content-type") ?? "").includes("image/jpeg"),
    "TIFF 的教师预览读取 JPEG 派生图");
  const tiffView = await modePaper();
  const tiffRow = ((tiffView.body?.answerFiles ?? []) as Array<{ pageIndex: number; filename: string; mimeType: string; isImage: boolean }>)
    .find((row) => row.pageIndex === 4);
  ok(tiffRow?.filename === "answerkey-4.tiff" && tiffRow?.mimeType === "image/tiff" && tiffRow?.isImage === false,
    "浏览器不支持的 TIFF 不下发为内联图片，学生端保留打开/下载入口");
  const tiffRes = await fetch(`${base}/api/scores/me/exams/${modeExamId}/paper/answer-file/4`, {
    headers: { Authorization: `Bearer ${stuToken}` },
  });
  const tiffBytes = Buffer.from(await tiffRes.arrayBuffer());
  ok(tiffRes.status === 200 && (tiffRes.headers.get("content-type") ?? "").includes("image/tiff") && tiffBytes.equals(uploadedTiff),
    "TIFF 原字节可供学生下载");

  // 模拟旧版本中途失败留下的同页图片派生图：下一份 PDF 占用该页时必须清掉旧 JPEG。
  await getMysqlDb().run("DELETE FROM exam_answer_key_pages WHERE exam_id = ? AND page_index = 4", modeExamId);
  const pagePdfAfterTiff = await uploadModePage(
    new Blob([Buffer.from("%PDF-1.4\n% replacement fixture\n")], { type: "application/pdf" }),
    "替换答案.pdf",
  );
  ok(pagePdfAfterTiff.status === 200 && pagePdfAfterTiff.body?.pages?.[0]?.filename === "answerkey-4.pdf",
    "同页后续上传 PDF 时重新占用该页");
  ok(!existsSync(tiffPreviewPath), "非图片替换图片时清理旧 JPEG 派生图，避免预览和 OCR 读错页");
  const teacherPdfAfterTiff = await fetch(`${base}/api/exams/${modeExamId}/answer-key/pages/4/image`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  ok((teacherPdfAfterTiff.headers.get("content-type") ?? "").includes("pdf"),
    "PDF/DOCX 预览直接返回登记文件，不复用残留图片");

  const historicalJpeg = await jpegBuffer();
  const historicalName = "answerkey-8.jpg";
  await writeFile(path.join(answerKeyDir(modeExamId), historicalName), historicalJpeg);
  const historicalPreview = resolveAnswerKeyPreviewFile(modeExamId, 8, historicalName);
  ok(historicalPreview?.filename === historicalName && !existsSync(path.join(answerKeyDir(modeExamId), "answerkey-8.preview.jpg")),
    "没有派生图的历史压缩 JPEG 继续用登记文件做预览");
  unlinkSync(path.join(answerKeyDir(modeExamId), historicalName));
  const delPng = await fetch(`${base}/api/exams/${modeExamId}/answer-key/pages/3`, {
    method: "DELETE", headers: { Authorization: `Bearer ${adminToken}` },
  });
  ok(delPng.status === 200 && !existsSync(pngPreviewPath) && !existsSync(path.join(answerKeyDir(modeExamId), "answerkey-3.png")),
    "删除答案页时一并清掉预览派生图");

  const fileDocxRes = await fetch(`${base}/api/scores/me/exams/${modeExamId}/paper/answer-file/2`, { headers: { Authorization: `Bearer ${stuToken}` } });
  ok(fileDocxRes.status === 200 && String(fileDocxRes.headers.get("content-disposition") ?? "").includes("attachment"),
    "DOCX 以附件下发（浏览器/小程序都渲染不了内联 docx）");
  const fileNoExam = await fetch(`${base}/api/scores/me/exams/${modeExamId}/paper/answer-file/9`, { headers: { Authorization: `Bearer ${stuToken}` } });
  ok(fileNoExam.status === 404, "未登记的页码 → 404（只认 DB，不按扩展名猜文件）");
  const fileBadPage = await fetch(`${base}/api/scores/me/exams/${modeExamId}/paper/answer-file/..%2F..%2F1`, { headers: { Authorization: `Bearer ${stuToken}` } });
  ok(fileBadPage.status === 400 || fileBadPage.status === 404, "路径穿越式页码 → 400/404");
  const noScoreStudent = await fetch(`${base}/api/scores/me/exams/${modeExamId}/paper/answer-file/1`, { headers: { Authorization: `Bearer ${otherToken}` } });
  ok(noScoreStudent.status === 404, "无该场成绩的学生取答案文件 → 404（同一套门）");
  const paperImageWhileHidden = await fetch(`${base}/api/scores/me/exams/${modeExamId}/paper/pages/1/image`, { headers: { Authorization: `Bearer ${stuToken}` } });
  ok(paperImageWhileHidden.status === 404, "直发模式独开时原卷图片路由也被挡住（答题卡确有 original.jpg）");

  await patchMode({ showOriginalPaper: true });
  const bothView = await modePaper();
  const bothAnswerPages = (bothView.body?.answerFiles ?? []) as Array<{ pageIndex: number }>;
  ok(bothView.status === 200 && bothView.body?.hasOriginalPaper === true
    && bothAnswerPages.map((page) => page.pageIndex).join(",") === "1,2,4"
    && ((bothView.body?.pages ?? [])[0]?.answers ?? []).length === 0,
    "「显示原卷」与直发模式同时开启 → 原卷页可见且仍不下发文字答案");
  const paperImageNow = await fetch(`${base}/api/scores/me/exams/${modeExamId}/paper/pages/1/image`, { headers: { Authorization: `Bearer ${stuToken}` } });
  ok(paperImageNow.status === 200, "开关开启后原卷图片恢复可取");

  const cfgView = await jsonFetch(base, `/api/exams/${modeExamId}/answer-key`, {}, adminToken);
  ok(cfgView.status === 200 && cfgView.body?.answerKeyMode === "file", "教师面板 GET 回显 answerKeyMode");

  await patchMode({ answerKeyMode: "text" });
  const backToText = await modePaper();
  ok((backToText.body?.answers ?? []).length === 2 && (backToText.body?.answerFiles ?? []).length === 0,
    "切回 text → 文字答案回来、文件不再下发（切换不销毁任何一侧数据）");
  const fileAfterSwitch = await fetch(`${base}/api/scores/me/exams/${modeExamId}/paper/answer-file/1`, { headers: { Authorization: `Bearer ${stuToken}` } });
  ok(fileAfterSwitch.status === 404, "切回 text 后答案文件路由关闭 → 404");
  const flagsText = await paperFlags(stuToken, modeExamId);
  ok(flagsText.listed === 1 && flagsText.detail === 1, "text 模式 + 显示原卷开启 → 入口标记仍为 1");
  await patchMode({ showOriginalPaper: false });
  const flagsClosed = await paperFlags(stuToken, modeExamId);
  ok(flagsClosed.listed === 0 && flagsClosed.detail === 0, "两闸都关 → 入口标记归 0");
  await getMysqlDb().run("UPDATE exams SET answer_key_mode = 'FILE', show_original_paper = 0, score_published = 1 WHERE id = ?", modeExamId);
  const dirtyFlags = await paperFlags(stuToken, modeExamId);
  const dirtyPaper = await modePaper();
  ok(dirtyFlags.listed === 0 && dirtyFlags.detail === 0 && dirtyPaper.status === 404,
    "脏值 FILE 按 text 处理，列表入口与 /paper 都不放行");

  const tiffPage = await uploadModePage(new Blob([multiTiff], { type: "image/tiff" }), "扫描答案.tiff");
  ok(tiffPage.status === 200 && tiffPage.body.count === 1, "多页 BigTIFF 答案可保存原件和预览");
  if (tiffPage.status === 200) {
    await patchMode({ answerKeyMode: "file" });
    const index = tiffPage.body.pages[0].pageIndex;
    const file = await fetch(`${base}/api/scores/me/exams/${modeExamId}/paper/answer-file/${index}`, {
      headers: { Authorization: `Bearer ${stuToken}` },
    });
    ok(file.status === 200 && Buffer.from(await file.arrayBuffer()).equals(multiTiff), "学生下载的多页 BigTIFF 与教师上传的原件逐字节一致");
    const preview = await fetch(`${base}/api/exams/${modeExamId}/answer-key/pages/${index}/image`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const meta = await sharp(Buffer.from(await preview.arrayBuffer())).metadata();
    ok(preview.status === 200 && meta.format === "jpeg" && meta.width === 1000 && meta.height === 220, "教师可预览多页 BigTIFF 的首页 JPEG");
  }

  // ── E. 删除考试时的文件清理 ──────────────────────────
  section("E. 删除考试清理答案页文件");
  ok(existsSync(answerKeyDir(examId)), "上传过答案页 → 考试答案目录存在");
  const delExam = await jsonFetch(base, `/api/exams/${examId}`, { method: "DELETE" }, adminToken);
  ok(delExam.status === 200 && !existsSync(answerKeyDir(examId)), "删除考试 → 答案页文件目录一并清理（机密原图不滞留磁盘）");

  // 反馈分支占用 v66/v67。已记下这两个版本号的库，答案直发必须仍以 v68 补列。
  section("G. 迁移号避开反馈 v66/v67");
  sqlite.exec("ALTER TABLE exams DROP COLUMN answer_key_mode");
  sqlite.prepare("DELETE FROM schema_migrations WHERE version = 68").run();
  sqlite.prepare("INSERT OR REPLACE INTO schema_migrations (version, name) VALUES (66, 'feedback-reports')").run();
  sqlite.prepare("INSERT OR REPLACE INTO schema_migrations (version, name) VALUES (67, 'feedback-attachments')").run();
  const { runMigrations } = await import("../src/server/db/migrations");
  runMigrations(sqlite);
  const examColumns = sqlite.prepare("PRAGMA table_info(exams)").all() as Array<{ name: string }>;
  ok(examColumns.some((column) => column.name === "answer_key_mode"),
    "v66 已被反馈迁移占用时，答案直发仍以 v68 补上 answer_key_mode");
  const feedbackVersion = sqlite.prepare("SELECT name FROM schema_migrations WHERE version = 66").get() as { name: string } | undefined;
  ok(feedbackVersion?.name === "feedback-reports", "已执行的 v66 保持反馈迁移的名字，不被答案直发覆盖");
  const answerKeyVersion = sqlite.prepare("SELECT name FROM schema_migrations WHERE version = 68").get() as { name: string } | undefined;
  ok(answerKeyVersion?.name === "exam-answer-key-mode", "答案直发登记为 v68 exam-answer-key-mode");

  console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDatabase();
  process.chdir(tmpdir());
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  if (failed > 0) process.exitCode = 1;
}

function existsjpeg(value: string | null): boolean {
  return String(value ?? "").includes("image/jpeg");
}

main().then(() => undefined).catch((err) => {
  console.error("冒烟测试异常:", err);
  process.exitCode = 1;
});
