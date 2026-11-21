import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { buildLayout } from "../src/shared/layout";
import { createDefaultCard } from "../src/shared/defaultCard";

const temp = await mkdtemp(path.join(tmpdir(), "projectx-essay-review-"));
process.chdir(temp);
process.env.PROJECTX_DB_PATH = path.join(temp, "review.db");
process.env.ANSWER_CARD_DATA_DIR = path.join(temp, "data");
process.env.PROJECTX_TOKEN_DIR = path.join(temp, "tokens");
process.env.PROJECTX_AUTH_ENFORCE = "1";
const mariadb = process.env.ESSAY_REVIEW_MARIADB === "1";
if (mariadb) {
  assert.equal(process.env.PROJECTX_MARIADB_HOST, "127.0.0.1");
  assert.match(process.env.PROJECTX_MARIADB_DATABASE ?? "", /^projectx_essay_review(?:_[a-z0-9]+)*$/);
} else {
  for (const key of Object.keys(process.env)) if (/^PROJECTX_(MARIADB|MYSQL)_/.test(key)) delete process.env[key];
}
const { getMysqlDb, hashPassword, closeDatabase } = await import("../src/server/db");
const db = getMysqlDb();
if (mariadb) assert.equal((await db.all("SHOW TABLES")).length, 0);
const { createApp } = await import("../src/apps/answer-card/server/index");
const { authService } = await import("../src/server/services/AuthService");
const { CardRepository } = await import("../src/server/repositories/CardRepository");
const { UserRepository } = await import("../src/server/repositories/UserRepository");
const { getPoolSummary, getPoolEntries, claimNextPaper, claimSpecificPaper, releasePaper } = await import("../src/server/services/ReviewPoolService");
const { listReviewBlocks, submitReviewCropScores } = await import("../src/server/services/ReviewService");
const { upsertBlockConfig } = await import("../src/server/services/BlockGradingConfigService");
const app = await createApp();
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
try {
  const card = createDefaultCard("00190281", "yuwen", "A3");
  const essayId = "chinese-essay";
  const normalId = "chinese-short";
  card.bodyBlocks = [
    { id: essayId, type: "subjective", title: "作文", blockKind: "essay", questions: [{
      id: "long-q", number: 1, score: 60, style: "plain_subjective", kind: "plain_box", minHeightMm: 40,
      essayGrid: { columns: 0, rows: 0, cellWidthMm: 7, cellHeightMm: 7, targetChars: 2300,
        showTitle: true, lineColor: "#a00000", lineWidthMm: 0.15, showFrame: true, showWordScale: true },
    }] },
    { id: normalId, type: "subjective", title: "简答", blockKind: "answer", questions: [{
      id: "short-q", number: 2, score: 5.5, style: "plain_subjective", kind: "plain_box", minHeightMm: 30,
    }] },
  ];
  const cards = new CardRepository(db);
  await cards.createCard(card);
  await cards.updateCard(card);
  const exam = (await db.run("INSERT INTO exams(name,card_id,exam_mode,status) VALUES (?,?,'quiz','grading')", "作文评阅", card.id)).lastInsertRowid;
  const pwd = randomUUID();
  const hash = await hashPassword(pwd);
  async function user(name: string, role: number, no: string | null = null) {
    return (await db.run("INSERT INTO users(username,name,password_hash,role_id,student_number) VALUES (?,?,?,?,?)", name, name, hash, role, no)).lastInsertRowid;
  }
  const a = await user("first", 2), b = await user("second", 2), arb = await user("arbitrator", 2);
  const student = await user("pupil", 3, "80001");
  const other = await user("another", 3, "80002");
  const tokens = new Map<string,string>();
  for (const username of ["first", "second", "arbitrator", "pupil", "another"]) {
    const login = await authService.login(username, pwd);
    assert.ok(login.token);
    tokens.set(username, login.token);
  }
  async function request(username: string, route: string, body?: object) {
    return fetch(base + route, { method: body ? "POST" : "GET", headers: {
      Authorization: "Bearer " + tokens.get(username), "Content-Type": "application/json",
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
  }
  for (const [teacher, ids] of [[a, [student]], [b, [other]]] as const) {
    await db.run("INSERT INTO review_assignments (exam_id,block_id,teacher_id,assigned_student_ids,student_count) VALUES (?,?,?,?,1)",
      exam, essayId, teacher, JSON.stringify(ids));
  }
  await upsertBlockConfig(exam, "__default__", { reviewMode: 2, scoringMode: "per_question", hasHalfPoint: 1 }, db);
  await db.run("INSERT INTO student_scores(exam_id,student_id,objective_score,subjective_score,total_score) VALUES (?,?,0,0,0)", exam, student);
  const parts = buildLayout(card).pages.flatMap(page => page.blocks.flatMap((block, i) =>
    block.blockId === essayId ? [{ id: randomUUID(), page: page.pageNumber, segment: i + 1 }] : []));
  assert.ok(parts.length > 3 && new Set(parts.map(p => p.page)).size > 1, "作文同时跨栏和跨页");
  const source = (page: number) => "page-" + page;
  const file = (id: string) => path.join(temp, id + ".png");
  async function insert(id: string, page: number, segment: number, block = essayId,
    sourceType = "twain_scan_record", recordId = source(page), owner = student) {
    await sharp({ create: { width: 9 + segment, height: 13 + page, channels: 3, background: "#459ABC" } }).png().toFile(file(id));
    await db.run(`INSERT INTO answer_block_crops(id,card_id,exam_id,student_id,student_number,source_type,source_record_id,
      block_id,block_title,block_type,page_number,segment_index,question_numbers,rect_json,image_path,width_px,height_px,dpi)
      VALUES (?,?,?,?,?,?,?,?,?,'subjective',?,?,?,'{}',?,?,?,150)`,
      id, card.id, exam, owner, owner === student ? "80001" : "80002", sourceType, recordId, block, block === essayId ? "作文" : "简答", page, segment,
      block === essayId ? "[1]" : "[2]", file(id), 9 + segment, 13 + page);
  }
  const pages = [...new Set(parts.map(p => p.page))].map(page => ({ recordId: source(page), pageNum: page, layoutPage: page, side: "front" }));
  const receipt = (pages: object[]) => db.run("UPDATE scanner_submissions SET pages_json=? WHERE exam_id=? AND group_id='first'", JSON.stringify(pages), exam);
  await db.run("INSERT INTO scanner_submissions(exam_id,session_id,group_id,student_number,state,pages_json) VALUES (?,'scanner','first','80001','saved',?)",exam,JSON.stringify(pages));
  const [first, ...rest] = parts;
  for (const p of [...rest].reverse()) await insert(p.id, p.page, p.segment);
  const pool = () => getPoolSummary(exam, essayId, a, db);
  assert.equal((await pool()).inPoolCount, 0);
  await assert.rejects(claimNextPaper(exam, essayId, a, db), /作文切图/);
  await insert(first.id, first.page, first.segment);
  await receipt(pages.slice(0, -1));
  await assert.rejects(claimNextPaper(exam, essayId, a, db), /归属/);
  await receipt(pages);
  assert.equal((await pool()).totalCount, 1);
  await rename(file(first.id), file(first.id) + ".pending");
  assert.equal((await pool()).inPoolCount, 0);
  await assert.rejects(claimNextPaper(exam, essayId, a, db), /文件缺失/);
  await rename(file(first.id) + ".pending", file(first.id));
  assert.equal((await pool()).inPoolCount, 1);
  const users = new UserRepository();
  await users.updateUser(student, { student_number: "80901" });
  await users.updateUser(other, { student_number: "80001" });
  assert.equal((await pool()).inPoolCount, 1, "改学号和旧号复用后领到原学生的作文");
  const renamed = await claimNextPaper(exam, essayId, a, db);
  assert.equal(renamed.studentId, student);
  assert.deepEqual(renamed.reviewImages?.map(p => p.id), parts.map(p => p.id));
  assert.equal(renamed.hasHalfPoint, 1, "领取结果继承考试的半分选项");
  assert.equal((await listReviewBlocks(exam, db)).find(r => r.blockId === essayId)?.hasHalfPoint, 1);
  await releasePaper(exam, essayId, renamed.id, a, db);

  // A second student's saved receipt uses the old number and different physical pages.
  // A replay claiming one of the first answer's pages is ambiguous until withdrawn.
  const otherPages = pages.map(p => ({ ...p, recordId: "second-" + p.recordId }));
  await db.run(`INSERT INTO scanner_submissions(exam_id,session_id,group_id,student_number,state,pages_json)
    VALUES (?,'second-scanner','second','80001','saved',?)`, exam, JSON.stringify(otherPages));
  assert.equal((await pool()).inPoolCount, 1);
  const conflictPages = [...otherPages];
  conflictPages[0] = pages[0];
  await db.run("UPDATE scanner_submissions SET pages_json=? WHERE exam_id=? AND group_id='second'", JSON.stringify(conflictPages), exam);
  assert.equal((await pool()).inPoolCount, 0);
  await db.run("UPDATE scanner_submissions SET state='superseded' WHERE exam_id=? AND group_id='second'", exam);
  assert.equal((await pool()).inPoolCount, 1);
  const last = parts.at(-1)!;
  // Pre-upgrade queue already has a claim on a continuation. Keep this unit's identity and vote history.
  await db.run("UPDATE answer_block_crops SET claimed_by=? WHERE id=?", a, last.id);
  const [legacy] = await getPoolEntries(exam, essayId, { claimedBy: a }, db);
  assert.equal(legacy.id, last.id);
  assert.deepEqual(legacy.reviewImages?.map(p => p.id), parts.map(p => p.id));
  assert.equal((await listReviewBlocks(exam, db)).find(r => r.blockId === essayId)?.totalCount, 1);
  await assert.rejects(claimSpecificPaper(exam, essayId, first.id, a, db), /整篇作文/);
  const submit = (id: string, teacher: number, score: number, isAdmin = false) => submitReviewCropScores({
    examId: exam, cropId: id, userId: teacher, isAdmin, scores: [{ questionNumber: 1, scoreType: "subjective", score }],
  }, db);
  await assert.rejects(submit(first.id, a, 19, true), /整篇作文/);
  const images = legacy.reviewImages!;
  for (const image of images) {
    const response = await request("first", image.imageUrl);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(file(image.id)));
    assert.equal((await request("second", image.imageUrl)).status, 403, "首评按学生切片");
    assert.equal((await request("another", image.imageUrl)).status, 403, "切图只供所属学生访问");
  }
  await rename(file(first.id), file(first.id) + ".pending");
  await assert.rejects(submit(last.id, a, 20), /文件缺失/);
  await rename(file(first.id) + ".pending", file(first.id));
  const submitUrl = `/api/review/exams/${exam}/block-crops/${last.id}/submit`;
  async function rejectDraft(reviewer: string, score: number) {
    const before = await db.get("SELECT claimed_by,review_round,score_breakdown,status FROM answer_block_crops WHERE id=?", last.id);
    const response = await request(reviewer, submitUrl, { scores: [{ questionNumber: 1, scoreType: "subjective", score }] });
    assert.equal(response.status, 422, await response.clone().text());
    const after = await db.get("SELECT claimed_by,review_round,score_breakdown,status FROM answer_block_crops WHERE id=?", last.id);
    assert.deepEqual(after, before);
    assert.equal(await db.get("SELECT score FROM question_scores WHERE exam_id=? AND student_id=? AND question_number=1", exam, student), null);
    assert.equal((await db.get("SELECT total_score FROM student_scores WHERE exam_id=? AND student_id=?", exam, student)).total_score, 0);
  }
  await rejectDraft("first", 20.25);
  assert.equal((await submit(last.id, a, 20.5)).status, "pending");
  const vote = await db.get("SELECT score_breakdown FROM answer_block_crops WHERE id=?", last.id);
  assert.equal(JSON.parse(vote.score_breakdown)[0].questionScores["1"], 20.5);
  await upsertBlockConfig(exam, essayId, { reviewMode: 2, scoringMode: "per_question", disputeThreshold: 1, arbitratorId: arb, hasHalfPoint: 0 }, db);
  assert.equal((await listReviewBlocks(exam, db)).find(r => r.blockId === essayId)?.hasHalfPoint, 0);
  for (const image of images) assert.equal((await request("second", image.imageUrl)).status, 200, "复核教师可阅读全文");
  const secondReview = await claimNextPaper(exam, essayId, b, db);
  assert.equal(secondReview.id, last.id);
  assert.equal(secondReview.hasHalfPoint, 0, "题块显式关闭半分覆盖考试默认设置");
  await rejectDraft("second", 42.5);
  assert.equal((await submit(last.id, b, 40)).status, "disputed");
  const disputesRoute = `/api/review-arbitration/exams/${exam}/disputes`;
  const disputes = (await (await request("arbitrator", disputesRoute)).json()).data;
  assert.deepEqual(disputes.map((d: { cropId: string }) => d.cropId), [last.id]);
  assert.deepEqual(disputes[0].reviewImages.map((p: { id: string }) => p.id), parts.map(p => p.id));
  for (const image of images) assert.equal((await request("arbitrator", image.imageUrl)).status, 200, "指定仲裁人可阅读全文");
  const resolve = (id: string) => request("arbitrator", `/api/review-arbitration/crops/${id}/resolve`, { questionScores: { 1: 32 } });
  assert.equal((await resolve(first.id)).status, 409);
  const resolved = await resolve(last.id);
  assert.equal(resolved.status, 200, await resolved.clone().text());
  assert.equal((await resolved.json()).finalScore, 32);
  assert.deepEqual(await db.all("SELECT question_number,score FROM question_scores WHERE exam_id=? AND student_id=?", exam, student), [{ question_number: 1, score: 32 }]);
  assert.equal((await db.get("SELECT total_score FROM student_scores WHERE exam_id=? AND student_id=?", exam, student)).total_score, 32);
  assert.equal((await pool()).reviewedCount, 1);
  await assert.rejects(claimNextPaper(exam, essayId, a, db), /暂无/);
  await insert("short-first", 1, 8, normalId);
  await insert("short-second", 2, 8, normalId);
  assert.equal((await getPoolSummary(exam, normalId, a, db)).totalCount, 2);
  await upsertBlockConfig(exam, normalId, { reviewMode: 2, rounding: "ceil", scoringMode: "per_question", hasHalfPoint: 0 }, db);
  const short = await claimNextPaper(exam, normalId, a, db);
  assert.notEqual(short.id, (await claimNextPaper(exam, normalId, b, db)).id);
  const submitFull = (teacher: string) => request(teacher, `/api/review/exams/${exam}/block-crops/${short.id}/submit`, {
    scores: [{ questionNumber: 2, scoreType: "subjective", score: 5.5 }],
  });
  const firstFull = await submitFull("first");
  assert.equal(firstFull.status, 200, await firstFull.clone().text());
  assert.equal((await firstFull.json()).status, "pending");
  await claimSpecificPaper(exam, normalId, short.id, b, db);
  const secondFull = await submitFull("second");
  assert.equal(secondFull.status, 200, await secondFull.clone().text());
  assert.equal((await secondFull.json()).finalScore, 5.5);
  assert.deepEqual(await db.get("SELECT score,max_score FROM question_scores WHERE exam_id=? AND student_id=? AND question_number=2", exam, student),
    { score: 5.5, max_score: 5.5 });
  // An import regrade keeps its earlier database rows. A missing page in the new
  // batch must not be replaced with a matching page from the student's older copy.
  async function importedBatch() {
    const batch = (await db.run("INSERT INTO scan_batches(exam_id,status) VALUES (?,'done')", exam)).lastInsertRowid;
    const records = new Map<number, string>();
    for (const page of pages) {
      const row = await db.run("INSERT INTO scan_records(batch_id,student_id,student_number) VALUES (?,?,'80002')", batch, other);
      records.set(page.layoutPage, String(row.lastInsertRowid));
    }
    return records;
  }
  const oldBatch = await importedBatch();
  for (const p of parts) await insert("old-" + p.id, p.page, p.segment, essayId, "scan_record", oldBatch.get(p.page), other);
  const newBatch = await importedBatch();
  for (const p of rest) await insert("new-" + p.id, p.page, p.segment, essayId, "scan_record", newBatch.get(p.page), other);
  await assert.rejects(claimNextPaper(exam, essayId, b, db), /作文切图/);
  await insert("new-" + first.id, first.page, first.segment, essayId, "scan_record", newBatch.get(first.page), other);
  await assert.rejects(claimSpecificPaper(exam, essayId, "old-" + first.id, b, db), /整篇作文/);
  await upsertBlockConfig(exam, essayId, { scoringMode: "block_total", reviewMode: 1 }, db);
  const imported = await claimNextPaper(exam, essayId, b, db);
  assert.deepEqual(imported.reviewImages?.map(p => p.id), parts.map(p => "new-" + p.id));
  const finished = await submitReviewCropScores({ examId: exam, cropId: imported.id, userId: b, blockTotalScore: 45,
    scores: [{ questionNumber: 1, score: 0, scoreType: "subjective" }] }, db);
  assert.equal(finished.finalScore, 45);
  assert.equal((await pool()).reviewedCount, 2);
  console.log(`${db.dialect}: ${parts.length} ordered panels, incomplete receipt and files, late first page, legacy claim, student renumbering and reuse, ambiguous replay, inherited half-point vote 20.5, invalid draft rejected with claim and votes retained, fractional full mark 5.5, arbitration 32, latest import 45`);
} finally {
  server.close();
  await once(server, "close");
  if (mariadb) await (await import("../src/server/db/mysql")).closeAdapter();
  else closeDatabase();
  await rm(temp, { recursive: true, force: true });
}
