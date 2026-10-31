/**
 * 【临时脚本 · UI 验收】答案「原文件直发」主站渲染服务
 * ----------------------------------------------------------------
 * 需求：主站考试管理 → 原卷答案 → 本次正确答案，过去只能强制 OCR，现在要能选「直接上传原文件」，
 *       小程序与学生端看到的就是上传时的格式。本脚本只负责把这条链路跑到**可被真实浏览器渲染**的状态：
 *   - 临时 SQLite 库 + 临时数据目录（不碰仓库 data/，也不碰 3306 上的服务）
 *   - 两场已公布考试：A=逐题文字（含原卷页与逐题答案）、B=原文件直发（jpg + docx 各一页）
 *   - 保持监听，供 scripts/answer-key-mode-ui-shoot.cjs 用 Electron 登录后截图
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/answer-key-mode-ui-server.ts
 * 可选：PX_UI_PORT（默认 5178）
 * 账号：admin / Ui-Answer-Key-2026 · 学生 50001 / 50001
 *
 * 说明：这是验收夹具，不是回归用例（断言在 exam-paper-answer-key-smoke.ts 与 verify-mariadb.ts）。
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import bcrypt from "bcryptjs";
import sharp from "sharp";

const PORT = Number(process.env.PX_UI_PORT || 5178);
const ADMIN_PASSWORD = "Ui-Answer-Key-2026";

// 原工作目录若有 database.mode=remote 的 config.yml，detectDialect 会选 MariaDB，
// 随后 ensureDefaultAdmin 可能改写业务库管理员口令。先确认陷阱配置可读，再切到无配置的临时目录。
const dirtyCwd = mkdtempSync(path.join(tmpdir(), "projectx-answerkey-ui-dirty-"));
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
const tmpDir = mkdtempSync(path.join(tmpdir(), "projectx-answerkey-ui-"));
process.env.PROJECTX_DB_PATH = path.join(tmpDir, "ui.db");
process.env.PROJECTX_TOKEN_DIR = path.join(tmpDir, "tokens");
process.env.ANSWER_CARD_DATA_DIR = path.join(tmpDir, "data");
for (const key of Object.keys(process.env)) {
  if (key.startsWith("PROJECTX_MARIADB_") || key.startsWith("PROJECTX_MYSQL_")) delete process.env[key];
}
process.chdir(tmpDir);

const { detectDialect } = await import("../src/server/db/mysql");
if (detectDialect() !== "sqlite") {
  throw new Error("验收夹具必须在临时 SQLite 上运行：config.yml remote 配置未被隔离");
}
const { initializeDatabase, ensureDefaultAdmin, getDatabase, getMysqlDb } = await import("../src/server/db/index");
const { createApp } = await import("../src/apps/answer-card/server/index");

initializeDatabase();
const sqlite = getDatabase();
const bootstrap = await ensureDefaultAdmin();

const gradeId = Number(sqlite.prepare("INSERT INTO grades (name, sort_order, is_demo) VALUES ('直发验收年级', 1, 0)").run().lastInsertRowid);
const classId = Number(sqlite.prepare("INSERT INTO classes (grade_id, name, sort_order, is_demo) VALUES (?, '直发验收班', 1, 0)").run(gradeId).lastInsertRowid);
const student = Number(sqlite
  .prepare("INSERT INTO users (username, password_hash, name, role_id, student_number, is_active) VALUES ('50001', ?, '直发学生甲', 3, '50001', 1)")
  .run(bcrypt.hashSync("50001", 10)).lastInsertRowid);
sqlite.prepare("INSERT INTO class_students (class_id, student_id) VALUES (?, ?)").run(classId, student);

function insertCard(id: string, title: string): string {
  sqlite
    .prepare(`INSERT INTO answer_cards (id, title, subject, subject_label, exam_date, paper_size, orientation, student_fields, student_number_digits, sided, layout_version, created_by)
      VALUES (?, ?, 'math', ?, ?, 'A4', 'portrait', '{}', 5, 'single', 1, 1)`)
    .run(id, title, title, "2026-10-20");
  return id;
}

function insertExam(name: string, cardId: string): number {
  const info = sqlite
    .prepare("INSERT INTO exams (name, card_id, subject, grade_id, class_id, status, exam_mode, score_published, created_by) VALUES (?, ?, '数学', ?, ?, 'closed', 'formal', 1, 1)")
    .run(name, cardId, gradeId, classId);
  const examId = Number(info.lastInsertRowid);
  sqlite.prepare("INSERT INTO student_scores (exam_id, student_id, objective_score, subjective_score, total_score) VALUES (?, ?, 58, 27, 85)").run(examId, student);
  sqlite.prepare("INSERT INTO exam_participants (exam_id, student_id, source) VALUES (?, ?, 'roster')").run(examId, student);
  return examId;
}

const textCard = insertCard("UICARDTEXT", "逐题文字验收卡");
const fileCard = insertCard("UICARDFILE", "答案直发验收卡");
const examText = insertExam("逐题文字考试（A卷）", textCard);
const examFile = insertExam("原文件直发考试（B卷）", fileCard);

/** 用 SVG 画出「像一份真答案」的图，截图才看得出排版是否被压扁 */
async function pageJpeg(label: string, lines: string[]): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="480">
    <rect width="720" height="480" fill="#f7f5ef"/>
    <rect x="18" y="18" width="684" height="444" fill="none" stroke="#c9c4b8" stroke-width="2"/>
    <text x="40" y="66" font-family="sans-serif" font-size="28" fill="#2b2b2b">${label}</text>
    ${lines.map((line, i) => `<text x="40" y="${116 + i * 42}" font-family="sans-serif" font-size="22" fill="#404040">${line}</text>`).join("\n    ")}
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toBuffer();
}

const server = createServer(await createApp());
await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${PORT}`;

async function login(identifier: string, password: string) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier, password }),
  });
  const body = (await res.json().catch(() => ({}))) as { token?: string; passwordChangeRequired?: boolean; code?: string };
  return { status: res.status, body };
}

/** admin 首登带着一次性口令：命中 428 就走改密再登（与冒烟脚本同一套流程） */
async function loginAdmin(initial: string): Promise<string> {
  const first = await login("admin", initial);
  if (first.body.token && !first.body.passwordChangeRequired) return first.body.token;
  if (first.status === 428 || first.body.code === "PASSWORD_CHANGE_REQUIRED" || first.body.passwordChangeRequired) {
    await fetch(`${base}/api/auth/change-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${first.body.token ?? ""}` },
      body: JSON.stringify({ oldPassword: initial, newPassword: ADMIN_PASSWORD }),
    }).catch(() => {});
    const retry = await login("admin", ADMIN_PASSWORD);
    if (retry.body.token) return retry.body.token;
    throw new Error(`admin 改密后登录失败：首次=${first.status} 重试=${retry.status}`);
  }
  throw new Error(`admin 登录失败：status=${first.status} body=${JSON.stringify(first.body)}`);
}

const adminToken = await loginAdmin(readFileSync(bootstrap.passwordFile, "utf8").trim());

async function upload(url: string, parts: Array<{ name: string; type: string; bytes: Buffer }>): Promise<number> {
  const form = new FormData();
  for (const part of parts) form.append("files", new Blob([part.bytes], { type: part.type }), part.name);
  const res = await fetch(`${base}${url}`, { method: "POST", headers: { Authorization: `Bearer ${adminToken}` }, body: form });
  if (!res.ok) throw new Error(`${url} → ${res.status}: ${await res.text()}`);
  return res.status;
}

const json = (url: string, method: string, body: unknown) =>
  fetch(`${base}${url}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify(body),
  }).then((r) => r.json());

// A 卷：显示原卷 + 逐题文字答案（v54 的既有形态）
await upload(`/api/cards/${textCard}/paper`, [
  { name: "原卷第1页.jpg", type: "image/jpeg", bytes: await pageJpeg("A 卷 原卷 第 1 页", ["1. 设函数 f(x)=x²-2x，求最小值。", "2. 已知等比数列 {aₙ}，a₁=2，q=3，求 a₄。"]) },
]);
await json(`/api/exams/${examText}`, "PATCH", { showOriginalPaper: true });
await json(`/api/exams/${examText}/answer-key`, "PUT", {
  answers: [
    { questionNumber: 1, answerText: "-1（x=1 时取得）", pageIndex: 1 },
    { questionNumber: 2, answerText: "54", pageIndex: 1 },
  ],
});
await upload(`/api/exams/${examText}/answer-key/pages?ocr=0`, [
  { name: "A卷答案页.jpg", type: "image/jpeg", bytes: await pageJpeg("A 卷 答案（教师核对用）", ["1. -1", "2. 54"]) },
]);

// B 卷：答案原文件直发（学生看到的就是这两份文件），且不开「显示原卷」
await upload(`/api/exams/${examFile}/answer-key/pages?ocr=0`, [
  { name: "B卷答案扫描页.jpg", type: "image/jpeg", bytes: await pageJpeg("B 卷 答案 第 1 页（扫描件）", ["1. B", "2. ACD", "3. 见下方解析", "4. √3"]) },
  {
    name: "B卷答案解析.docx",
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    bytes: Buffer.from("PK\u0003\u0004 word docx fixture for UI preview"),
  },
]);
await json(`/api/exams/${examFile}`, "PATCH", { answerKeyMode: "file" });

console.log("┌─ 答案直发 UI 验收服务已就绪 ─────────────────────────");
console.log(`├─ 临时库: ${process.env.PROJECTX_DB_PATH}`);
console.log(`├─ 数据目录: ${process.env.ANSWER_CARD_DATA_DIR}`);
console.log(`├─ 地址: ${base}（需已 vite build --mode web，产物在 dist/web）`);
console.log(`├─ 教师: admin / ${ADMIN_PASSWORD}   学生: 50001 / 50001`);
console.log(`├─ A 卷 examId=${examText}（逐题文字 + 显示原卷）`);
console.log(`└─ B 卷 examId=${examFile}（答案原文件直发，原卷未开放）`);
console.log(`    模式列现值: ${JSON.stringify((await getMysqlDb().get("SELECT answer_key_mode, show_original_paper FROM exams WHERE id = ?", examFile) as object))}`);
