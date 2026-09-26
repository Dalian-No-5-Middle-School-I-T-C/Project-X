/**
 * v53「显示原卷 + 逐题正确答案」冒烟验证（临时 SQLite 库 + 真实 HTTP）
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
 *
 * 不覆盖：tesseract.js 真实识别（需要 WASM 与数秒耗时，接口以 ?ocr=0 调用）、
 *         MariaDB 方言（见 scripts/verify-mariadb.ts 的 v53 断言）。
 *
 * 运行：npm run verify:exam-paper
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import bcrypt from "bcryptjs";
import sharp from "sharp";

const tmpDir = mkdtempSync(path.join(tmpdir(), "projectx-exam-paper-"));
process.env.PROJECTX_DB_PATH = path.join(tmpDir, "verify.db");
// 原卷/答案页文件也写进临时目录，避免污染仓库 data/
process.env.ANSWER_CARD_DATA_DIR = path.join(tmpDir, "data");
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
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
}

async function main() {
  console.log(`临时库: ${process.env.PROJECTX_DB_PATH}`);
  const { initializeDatabase, ensureDefaultAdmin, getDatabase, closeDatabase } = await import("../src/server/db/index");
  const { createApp } = await import("../src/apps/answer-card/server/index");
  const { getMysqlDb } = await import("../src/server/db");
  const { parseAnswerKeyText } = await import("../src/apps/answer-card/server/answer-key-ocr");
  const { answerKeyDir, answerKeysDir, paperDir } = await import("../src/apps/answer-card/server/storage");

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

  const app = await createApp();
  const server: Server = await new Promise((resolve) => {
    const s = createServer(app);
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const adminToken = await loginAdmin(base, readFileSync(bootstrap.passwordFile, "utf8").trim());
  const stuToken = (await login(base, "50001", "50001")).token!;
  const otherToken = (await login(base, "50002", "50002")).token!;
  ok(Boolean(adminToken && stuToken && otherToken), "admin / 两名学生登录成功");

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

  // ── D. OCR 文本解析（纯函数）──────────────────────────
  section("D. OCR 文本解析");
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

  // ── E. 删除考试时的文件清理 ──────────────────────────
  section("E. 删除考试清理答案页文件");
  ok(existsSync(answerKeyDir(examId)), "上传过答案页 → 考试答案目录存在");
  const delExam = await jsonFetch(base, `/api/exams/${examId}`, { method: "DELETE" }, adminToken);
  ok(delExam.status === 200 && !existsSync(answerKeyDir(examId)), "删除考试 → 答案页文件目录一并清理（机密原图不滞留磁盘）");

  console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDatabase();
  rmSync(tmpDir, { recursive: true, force: true });
  if (failed > 0) process.exitCode = 1;
}

function existsjpeg(value: string | null): boolean {
  return String(value ?? "").includes("image/jpeg");
}

main().then(() => undefined).catch((err) => {
  console.error("冒烟测试异常:", err);
  process.exitCode = 1;
});
