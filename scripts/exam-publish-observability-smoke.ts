/**
 * 「公布分数」可观测性回归（临时 SQLite 库 + 真实 HTTP + 源码静态断言）
 * ----------------------------------------------------------------
 * 背景：教师端点「公布分数」后没反应。生产构建 78d9b6a 里 handlePublishExam 的 catch
 * 只写应用根部页脚，确认框原地不动，所以服务端返回 409/403/500 时现场观感完全一样。
 *
 * 覆盖：
 *   A. 服务端契约——公布失败必须回**可读的、只给人数不给身份**的 message（前端就地渲染它）。
 *      缺成绩 / 无成绩记录 / 应考范围不可知 / 名单为空 / 未进入阅卷 / 幂等重放 / 批量整批拒绝。
 *   B. 撤回写回 score_published=2 并落审计 reason。
 *   C. 前端护栏——三处确认框都渲染 publishErr；成功宣称前必须复核刷新后的行状态；
 *      「无需等待所有应考学生出分」这句与后端校验相反的承诺不得再出现；
 *      列表接口失败不得静默清空。
 *
 * 不覆盖：真实浏览器渲染与指针交互、MariaDB 方言（见 scripts/verify-mariadb.ts）。
 *
 * 运行：npm run verify:exam-publish-observability
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import bcrypt from "bcryptjs";

const tmpDir = mkdtempSync(path.join(tmpdir(), "projectx-exam-publish-"));
process.env.PROJECTX_DB_PATH = path.join(tmpDir, "verify.db");
process.env.ANSWER_CARD_DATA_DIR = path.join(tmpDir, "data");
process.env.PROJECTX_AUTH_ENFORCE = "0"; // 本脚本只验公布契约与反馈，不重跑鉴权矩阵
for (const key of Object.keys(process.env)) {
  if (key.startsWith("PROJECTX_MARIADB_") || key.startsWith("PROJECTX_MYSQL_")) delete process.env[key];
}

let passed = 0, failed = 0;
function ok(cond: boolean, label: string): void {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${label}`); }
}
function section(title: string): void {
  console.log(`\n\x1b[36m== ${title} ==\x1b[0m`);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

let authToken = "";

async function post(base: string, url: string, body?: unknown) {
  const r = await fetch(`${base}${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
    body: JSON.stringify(body ?? {}),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) as Record<string, unknown> };
}

/** admin 首登会被强制改密（428），与 scripts/exam-paper-answer-key-smoke.ts 同一套绕法 */
async function loginAdmin(base: string, initial: string): Promise<string> {
  const doLogin = async (password: string) => {
    const r = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "admin", password }),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) as Record<string, unknown> };
  };
  const first = await doLogin(initial);
  if (first.body.token && !first.body.passwordChangeRequired) return first.body.token as string;
  await fetch(`${base}/api/auth/change-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${String(first.body.token ?? "")}` },
    body: JSON.stringify({ oldPassword: initial, newPassword: "PubObs@2026" }),
  }).catch(() => {});
  const retry = await doLogin("PubObs@2026");
  if (retry.body.token) return retry.body.token as string;
  throw new Error(`admin 登录失败：首次=${first.status}，重试=${retry.status}`);
}

async function main() {
  console.log(`临时库: ${process.env.PROJECTX_DB_PATH}`);
  const { initializeDatabase, ensureDefaultAdmin, getDatabase } = await import("../src/server/db/index");
  const { createApp } = await import("../src/apps/answer-card/server/index");

  initializeDatabase();
  const bootstrap = await ensureDefaultAdmin();
  const sqlite = getDatabase();

  const gradeId = Number(sqlite.prepare("INSERT INTO grades (name, sort_order, is_demo) VALUES ('公布可观测性年级', 1, 0)").run().lastInsertRowid);
  const classId = Number(sqlite.prepare("INSERT INTO classes (grade_id, name, sort_order, is_demo) VALUES (?, '公布可观测性班', 1, 0)").run(gradeId).lastInsertRowid);
  const emptyClassId = Number(sqlite.prepare("INSERT INTO classes (grade_id, name, sort_order, is_demo) VALUES (?, '空班', 2, 0)").run(gradeId).lastInsertRowid);
  // 学生姓名/学号刻意写得「独特」，用于断言 409 绝不把身份明细带进 message
  const names = ["缺分学生甲", "缺分学生乙", "有分学生丙"];
  const studentIds = names.map((name, i) => {
    const number = `9${String(70001 + i)}`;
    return Number(sqlite.prepare(
      "INSERT INTO users (username, password_hash, name, role_id, student_number, is_active) VALUES (?, ?, ?, 3, ?, 1)"
    ).run(number, bcrypt.hashSync(number, 10), name, number).lastInsertRowid);
  });
  for (const id of studentIds) sqlite.prepare("INSERT INTO class_students (class_id, student_id) VALUES (?, ?)").run(classId, id);

  const cardId = "PUBOBS01";
  sqlite.prepare(`INSERT INTO answer_cards (id, title, subject, subject_label, exam_date, paper_size, orientation, student_fields, student_number_digits, sided, layout_version, created_by)
    VALUES (?, '公布可观测性卡', 'math', '数学', '2026-10-14', 'A4', 'portrait', '{}', 5, 'single', 1, 1)`).run(cardId);
  // 不开自己的鉴权夹具：直接用 ensureDefaultAdmin 建出来的 admin 作为 created_by
  const adminId = Number(sqlite.prepare("SELECT id FROM users WHERE username='admin'").get().id);

  function insertExam(name: string, opts: { classId?: number; status?: string } = {}): number {
    return Number(sqlite.prepare(
      `INSERT INTO exams (name, card_id, grade_id, class_id, subject, start_time, status, score_published, exam_mode, created_by)
       VALUES (?, ?, ?, ?, '数学', CURRENT_TIMESTAMP, ?, 0, 'formal', ?)`
    ).run(name, cardId, gradeId, opts.classId ?? classId, opts.status ?? "closed", adminId).lastInsertRowid);
  }
  function score(examId: number, studentId: number, total: number): void {
    sqlite.prepare("INSERT INTO student_scores (exam_id, student_id, objective_score, subjective_score, total_score) VALUES (?, ?, ?, 0, ?)")
      .run(examId, studentId, total, total);
  }
  function freezeRoster(examId: number): void {
    // 与 ensureExamParticipants 的名册快照同源
    sqlite.prepare("INSERT INTO exam_participants (exam_id, student_id, source) SELECT ?, cs.student_id, 'roster' FROM class_students cs WHERE cs.class_id = ?")
      .run(examId, classId);
  }

  // ① 缺 2 名应考学生成绩  ② 全员有分  ③ 一份成绩都没有  ④ 名单为空  ⑤ 应考范围不可知  ⑥ 尚未进入阅卷
  const examMissing = insertExam("缺分考试");
  const examComplete = insertExam("完整考试");
  const examNoScore = insertExam("零分考试");
  const examEmptyRoster = insertExam("空名单考试", { classId: emptyClassId });
  const examNoScope = insertExam("无范围考试", { classId: null as unknown as number });
  const examDraft = insertExam("草稿考试", { status: "draft" });
  freezeRoster(examMissing); score(examMissing, studentIds[2], 88);
  freezeRoster(examComplete); studentIds.forEach((id, i) => score(examComplete, id, 60 + i));
  freezeRoster(examNoScore);
  // 名单为空必须**有成绩**才测得到：无成绩会先撞上「尚无成绩记录」那道更早的分支。
  // 现实对应「外班学生误入库」——有分数，但考试的班级名册里一个人没有。
  score(examEmptyRoster, studentIds[0], 55);
  sqlite.prepare("UPDATE exams SET class_id = NULL, grade_id = NULL WHERE id = ?").run(examNoScope);
  score(examNoScope, studentIds[0], 70); // 有成绩但应考范围未知

  const app = await createApp();
  const server: Server = await new Promise((resolve) => {
    const s = createServer(app);
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  authToken = await loginAdmin(base, readFileSync(bootstrap.passwordFile, "utf8").trim());

  section("A. 服务端契约：失败必须回可读 message（前端就地渲染的就是它）");

  const rMissing = await post(base, `/api/exams/${examMissing}/publish`);
  ok(rMissing.status === 409, "缺应考学生成绩 → 409");
  const msgMissing = String(rMissing.body.message ?? "");
  ok(msgMissing.includes("应考 3 人") && /缺 2 名/.test(msgMissing), `409 只给人数：${msgMissing.slice(0, 40)}…`);
  // PR #312 评审 B6：409 会原样出现在教师屏幕上，拼进姓名/学号等于批量外送未出分学生身份
  ok(!names.some((n) => msgMissing.includes(n)) && !/9700\d/.test(msgMissing),
    "409 message 不含任何学生姓名或学号（PII 闸门）");
  // 这一条是「点了没反应」的根：被拒绝的公布必须在事务开始前就抛出
  ok(!sqlite.prepare("SELECT id FROM exam_publish_events WHERE exam_id=?").all(examMissing).length,
    "被拒绝的公布不写 exam_publish_events（所以审计表查不到≠没点过）");

  const rNoScore = await post(base, `/api/exams/${examNoScore}/publish`);
  ok(rNoScore.status === 409 && String(rNoScore.body.message).includes("尚无成绩记录"), "零成绩 → 409「尚无成绩记录」");

  const rNoScope = await post(base, `/api/exams/${examNoScope}/publish`);
  ok(rNoScope.status === 409 && String(rNoScope.body.message).includes("未确定应考范围"), "应考范围不可知 → 409「未确定应考范围」");

  const rEmpty = await post(base, `/api/exams/${examEmptyRoster}/publish`);
  ok(rEmpty.status === 409 && String(rEmpty.body.message).includes("应考名单为空"), "名单为空 → 409「应考名单为空」");

  const rDraft = await post(base, `/api/exams/${examDraft}/publish`);
  ok(rDraft.status === 409 && String(rDraft.body.message).includes("尚未进入阅卷"), "未进入阅卷 → 409（前端禁用按钮的说明与它同口径）");

  const rBad = await post(base, "/api/exams/0/publish");
  ok(rBad.status === 400, "非法考试 ID → 400");

  section("B. 成功路径与幂等、撤回审计");

  const rOk = await post(base, `/api/exams/${examComplete}/publish`);
  ok(rOk.status === 200 && rOk.body.scorePublished === 1, "全员有分 → 200 且 scorePublished=1");
  ok(Number(sqlite.prepare("SELECT score_published FROM exams WHERE id=?").get(examComplete).score_published) === 1,
    "落库 score_published=1（前端复核的就是这个值）");

  const rReplay = await post(base, `/api/exams/${examComplete}/publish`);
  const publishRows = sqlite.prepare("SELECT id FROM exam_publish_events WHERE exam_id=? AND action='publish'").all(examComplete);
  ok(rReplay.status === 200 && publishRows.length === 1, "重复点公布 → 幂等 200，不重复写审计");

  const rUnpub = await post(base, `/api/exams/${examComplete}/unpublish`, { reason: "补录成绩" });
  ok(rUnpub.status === 200 && rUnpub.body.scorePublished === 2, "撤回 → 200 且 score_published=2（前端据此判「撤回未生效」）");
  const unpublishEvent = sqlite.prepare("SELECT reason FROM exam_publish_events WHERE exam_id=? AND action='unpublish'").get(examComplete) as { reason: string } | undefined;
  ok(unpublishEvent?.reason === "补录成绩", "撤回原因写入审计日志");
  const rUnpubAgain = await post(base, `/api/exams/${examComplete}/unpublish`);
  ok(rUnpubAgain.status === 400, "已撤回再撤回 → 400「仅已公布的成绩可撤回」");

  section("C. 批量公布：任一场缺人则整批拒绝，且逐场带上考试 id");

  const rBatch = await post(base, "/api/exams/publish-batch", { examIds: [examComplete, examMissing] });
  const batchMsg = String(rBatch.body.message ?? "");
  ok(rBatch.status === 409 && batchMsg.includes("以下考试无法公布成绩") && batchMsg.includes(`考试 ${examMissing}`),
    `批量 409 且点名到考试 id：${batchMsg.slice(0, 32)}…`);
  ok(Number(sqlite.prepare("SELECT score_published FROM exams WHERE id=?").get(examComplete).score_published) === 2,
    "整批拒绝时同批其它考试不被部分公布（原子性）");

  const rBatchMax = await post(base, "/api/exams/publish-batch", { examIds: Array.from({ length: 201 }, (_, i) => i + 1) });
  ok(rBatchMax.status === 400 && /一次最多批量公布 200 场/.test(String(rBatchMax.body.message)), "批量超上限 → 400 带明确上限说明");

  section("D. 前端护栏（源码静态断言）");

  const page = read("src/apps/answer-card/client/pages/ExamManagePage.tsx");
  const appSrc = read("src/apps/answer-card/client/App.tsx");

  ok(!page.includes("无需等待所有应考学生出分"),
    "已删除「无需等待所有应考学生出分」——该承诺与 assertScoresPublishable 相反");
  const errBlockCount = (page.match(/\{publishErr && \(/g) ?? []).length;
  ok(errBlockCount === 3, `单场/批量/撤回三处确认框都就地渲染 publishErr（命中 ${errBlockCount}/3）`);
  ok((page.match(/await loadExams\(\);/g) ?? []).length >= 3,
    "三条写路径都在宣称成功前刷新列表复核");
  ok(page.includes("公布未生效") && page.includes("撤回未生效"),
    "接口 200 但状态未落库时不谎报成功（自动撤回现场就是这种形态）");
  ok(page.includes("有 ${reverted.length}/${count} 场考试刷新后仍为"),
    "批量公布逐场复核，部分未生效要说出来");
  ok(/disabled=\{exam\.status !== "closed" && exam\.status !== "grading"\}/.test(page) && page.includes("需进入阅卷或已结考后才能公布成绩"),
    "禁用「公布分数」按钮附带原因说明（与服务端 409 文案同口径）");

  // 服务端通用错误分支接受空 message 字符串；空串会让 `{publishErr && …}` 整块不渲染，
  // 于是「点了没反应」以更隐蔽的方式复活。三处 catch 必须都过非空文案闸门。
  ok(/function publishFailureMessage/.test(page)
    && (page.match(/publishFailureMessage\(err, "/g) ?? []).length === 3
    && !/err instanceof Error \? err\.message : "(?:公布|批量公布|撤回)失败"/.test(page),
    "三处 catch 走 publishFailureMessage，空 message 也必有可读文案");

  // loadExams 静默清空会让「考试列表凭空变空」，非 401 失败必须发声
  const loadExamsBody = appSrc.slice(appSrc.indexOf("async function loadExams"), appSrc.indexOf("async function loadExams") + 900);
  ok(loadExamsBody.includes("考试列表加载失败") && loadExamsBody.includes("return []"),
    "loadExams 失败时写出原因并返回空数组供调用方复核");
  ok(!/catch\s*\{\s*setExams\(\[\]\)\s*\}/.test(loadExamsBody),
    "反向对照：旧的 `catch { setExams([]) }` 静默吞错已不存在");

  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  console.log(`\n${failed === 0 ? "\x1b[32m" : "\x1b[31m"}exam-publish-observability: ${passed} passed, ${failed} failed\x1b[0m`);
  process.exit(failed === 0 ? 0 : 1);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
