/** Isolated HTTP/DB regression. Set SCANNER_BATCH_MARIADB=1 with a fresh
 * projectx_scanner_batch_* database to exercise MariaDB; otherwise uses temp SQLite. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import express from "express";
import { createDefaultCard } from "../src/shared/defaultCard";
import { buildLayout } from "../src/shared/layout";
import { collectSessionResults } from "../src/apps/answer-card/server/scanner/session-results";
import { applyScanStudentId, type ScanBatchResponse } from "../src/shared/scanPages";
import type { CombinedRecognitionResult } from "../src/shared/types";

await mkdir("data", { recursive: true });
const root = await mkdtemp(path.resolve("data/scanner-batch-"));
process.env.ANSWER_CARD_DATA_DIR = path.join(root, "cards");
process.env.PROJECTX_DB_PATH = path.join(root, "scanner.db");
process.env.PROJECTX_AUTH_ENFORCE = "0"; // Existing local-mode scenarios below.
// config.yml is resolved from cwd; isolate it as well as the DB and card files.
process.chdir(root);
if (process.env.SCANNER_BATCH_MARIADB === "1") {
  assert.equal(process.env.PROJECTX_MARIADB_HOST, "127.0.0.1");
  assert.match(process.env.PROJECTX_MARIADB_DATABASE ?? "", /^projectx_scanner_batch_[a-z0-9_]+$/);
} else {
  for (const name of Object.keys(process.env)) if (/^PROJECTX_(MARIADB|MYSQL)_/.test(name)) delete process.env[name];
}

const { initializeDatabase, getMysqlDb, closeDatabase, initMariadbSchema } = await import("../src/server/db");
const { resetAdapter } = await import("../src/server/db/mysql");
initializeDatabase();
const db = getMysqlDb();
if (process.env.SCANNER_BATCH_MARIADB === "1") await initMariadbSchema();
const store = await import("../src/apps/answer-card/server/database/scan-store");
async function createVerifiedRecord(params: Parameters<typeof store.createScanRecord>[0]) {
  const record = await store.createScanRecord(params);
  const identity_json = JSON.stringify({ status: "verified", code: "QR_VERIFIED", cardId: params.cardId, pageNumber: 1 });
  await db.run("UPDATE twain_scan_records SET identity_json = ? WHERE id = ?", identity_json, record.id);
  return { ...record, identity_json };
}
const { saveCard, cardPath } = await import("../src/apps/answer-card/server/storage");
const { CardRepository } = await import("../src/server/repositories/CardRepository");
const { createScannerRouter } = await import("../src/apps/answer-card/server/scanner");
const card = createDefaultCard("91512001");
card.title = "扫描失败恢复验证";
card.bodyBlocks = [{ id: "batch_q", type: "objective", title: "选择题", questionStart: 1, questionCount: 1,
  optionCount: 4, mode: "single", scorePerQuestion: 5, answerKey: { "1": ["A"] }, density: "normal" }];
assert.equal(buildLayout(card).pages.length, 1);
await new CardRepository().createCard(card);
await new CardRepository().updateCard(card);
assert.equal(existsSync(cardPath(card.id)), false, "Database cards need no legacy JSON copy");
const role = await db.get<{ id: number }>("SELECT id FROM roles WHERE name = 'student'");
assert(role);
const users: number[] = [];
for (const studentNumber of ["91001", "91002", "91003"]) {
  const row = await db.run("INSERT INTO users (username,password_hash,name,role_id,student_number) VALUES (?,?,?,?,?)",
    `batch_${studentNumber}`, "test-no-login", `测试${studentNumber}`, role.id, studentNumber);
  users.push(row.lastInsertRowid);
}
const exam = await db.run("INSERT INTO exams (name,card_id,status) VALUES (?,?,'draft')", "扫描验证", card.id);
for (const id of users) await db.run("INSERT INTO exam_participants (exam_id,student_id,source) VALUES (?,?,'explicit')", exam.lastInsertRowid, id);
const session = await store.createSession(card.id, "batch");
const records = [];
for (let i = 0; i < users.length; i++) {
  const record = await createVerifiedRecord({ sessionId: session.id, cardId: card.id, pageNum: i + 1, imagePath: path.join(root, `page_${i}.png`) });
  await store.updateScanOcrResult(record.id, `9100${i + 1}`, 1, "done");
  await store.upsertRecognitionResult({ scanRecordId: record.id,
    objectiveJson: JSON.stringify([{ questionNumber: 1, selectedOptions: ["A"], confidence: 1 }]),
    subjectiveJson: "[]", gradeStatus: "done" });
  records.push(record);
}
await store.updateSessionStatus(session.id, "completed");
const app = express();
app.use(express.json());
const { makeScannerAuth } = await import("../src/server/middleware/scanner-auth");
app.use("/secured/scanner", makeScannerAuth(true), createScannerRouter(false));
app.use("/api/scanner", createScannerRouter(false));
app.use("/twain/scanner", createScannerRouter(true));
const { default: uploadRouter } = await import("../src/server/routes/scanner-upload");
const { hashSecret } = await import("../src/server/lib/field-crypto");
await db.run("INSERT INTO api_keys (name, api_key, scope, is_active) VALUES (?,?,?,1)", "isolated-test", hashSecret("scanner-test-only"), "scanner");
app.use("/api/scanner/upload", uploadRouter);
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(500).json({ message: err.message }));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(resolve => server.once("listening", resolve));
const address = server.address() as { port: number };
const url = `http://127.0.0.1:${address.port}/api/scanner/session/${session.id}/results`;
async function request(method = "GET") {
  const res = await fetch(url, { method });
  const body = await res.json();
  assert(res.ok, JSON.stringify(body));
  return body as ScanBatchResponse;
}
async function scoreCount() { return Number((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM student_scores WHERE exam_id = ?", exam.lastInsertRowid))!.n); }
try {
  // Synced cards exist only in the DB, just as in the desktop scanner.
  const previewResponse = await fetch(`${url}?previewOnly=1`);
  assert.equal(previewResponse.status, 200, await previewResponse.clone().text());
  const preview = await previewResponse.json() as ScanBatchResponse;
  assert.equal(preview.results.length, 3);
  assert.equal(preview.results[0].totalScore, 5);
  assert.equal(await scoreCount(), 0, "Remote upload preview must not save grades");
  const retryResponse = await fetch(`http://127.0.0.1:${address.port}/twain/scanner/session/${session.id}/retry`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ groupId: "missing" }),
  });
  assert.equal(retryResponse.status, 409, "Retry must find the DB card before validating the failed group");
  assert.match((await retryResponse.json()).message, /此答题卡未失败/);
  // A stale file must never override the current database answer key.
  const staleCard = structuredClone(card);
  const staleBlock = staleCard.bodyBlocks[0];
  assert.equal(staleBlock.type, "objective");
  if (staleBlock.type === "objective") staleBlock.answerKey = { "1": ["B"] };
  await saveCard(staleCard);
  assert.equal((await request()).results[0].totalScore, 5, "Ignore stale JSON answer keys");
  await unlink(cardPath(card.id));

  // Real bearer authentication on both route mounts; denials precede any mutation.
  const { authService } = await import("../src/server/services/AuthService");
  // Keep ephemeral login tokens in memory; never write the operator's token store.
  Reflect.set(authService, "scheduleSave", () => {});
  const { hashPassword } = await import("../src/server/db");
  const teacherRole = await db.get<{ id: number }>("SELECT id FROM roles WHERE name = 'teacher'");
  assert(teacherRole);
  const password = "isolated-scanner-test-password";
  const teacher = await db.run("INSERT INTO users (username,password_hash,name,role_id,teacher_role,subject,password_change_required) VALUES (?,?,?,?,?,?,0)",
    "scanner-restricted", await hashPassword(password), "Restricted", teacherRole.id, "subject_teacher", "math");
  const login = await authService.login("scanner-restricted", password);
  assert(login.token);
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: `Bearer ${login.token}`, "Content-Type": "application/json" };
  const snapshot = async () => JSON.stringify(await Promise.all([
    db.all("SELECT * FROM student_scores"), db.all("SELECT * FROM question_scores"),
    db.all("SELECT * FROM exams"), db.all("SELECT * FROM scanner_submissions"),
    db.all("SELECT * FROM twain_scan_records"),
  ]));
  const protectedPaths = [
    `/secured/scanner/session/${session.id}/results`,
    `/secured/scanner/session/${session.id}/validate`,
    `/secured/scanner/session/${session.id}/retry`,
    `/secured/scanner/legacy/${exam.lastInsertRowid}/1/save`,
    `/api/scanner/upload/sessions/${session.id}/complete`,
    `/api/scanner/upload/sessions/${session.id}/correct`,
    `/api/scanner/upload/sessions/${session.id}/pages`,
    `/api/scanner/upload/sessions/${session.id}/pages/${records[0].id}/crops`,
    `/api/scanner/upload/legacy/${exam.lastInsertRowid}/1/save`,
  ];
  process.env.PROJECTX_AUTH_ENFORCE = "1";
  const beforeDenied = await snapshot();
  for (const route of protectedPaths) {
    const response = await fetch(base + route, { method: "POST", headers, body: JSON.stringify({ groupId: "0", studentId: "91002" }) });
    assert.equal(response.status, 403, `${route}: deny out-of-scope teacher`);
  }
  assert.equal(await snapshot(), beforeDenied, "Denied requests leave all scores, publication, receipts and recognition unchanged");
  // A visible exam still requires grading permission for every scored block.
  await db.run("UPDATE exams SET created_by = ? WHERE id = ?", teacher.lastInsertRowid, exam.lastInsertRowid);
  await db.run("INSERT INTO teacher_permissions (teacher_id,block_id,can_grade) VALUES (?,?,1)", teacher.lastInsertRowid, "other-block");
  const deniedBlock = await fetch(base + protectedPaths[0], { method: "POST", headers });
  assert.equal(deniedBlock.status, 403, "Visibility does not grant whole-paper write access");
  await db.run("UPDATE teacher_permissions SET block_id = ? WHERE teacher_id = ?", "batch_q", teacher.lastInsertRowid);
  assert.equal((await fetch(`${base}/secured/scanner/session/${session.id}/validate`, { method: "POST", headers })).status, 200, "Whole-paper grader is allowed");
  assert.equal((await fetch(base + protectedPaths[0], { method: "POST", headers: { ...headers, "X-Api-Key": "invalid" } })).status, 401, "Unverified API key cannot bypass scope");
  assert.equal((await fetch(base + protectedPaths[0], { method: "POST" })).status, 401, "Anonymous enforced requests denied");
  await db.run("UPDATE exams SET created_by = NULL WHERE id = ?", exam.lastInsertRowid);
  await db.run("DELETE FROM teacher_permissions WHERE teacher_id = ?", teacher.lastInsertRowid);
  process.env.PROJECTX_AUTH_ENFORCE = "0";

  const initial = await request();
  assert.equal(initial.results.length, 3);
  assert.equal(await scoreCount(), 0, "Preview must not save grades");

  // Malformed JSON is isolated inside the card loop; later students still grade.
  await db.run("UPDATE twain_recognition_results SET objective_json = ? WHERE scan_record_id = ?", "{broken", records[1].id);
  const broken = await request();
  assert.deepEqual(broken.results.map(r => r.studentId), ["91001", "91003"]);
  assert.equal(broken.failures[0].pages[0].recordId, records[1].id);
  const partial = await request("POST");
  assert.equal(partial.failures.length, 1);
  assert.equal(await scoreCount(), 2, "Save all successful cards while keeping the failure");
  assert.equal((await request()).failures.length, 1, "Partial cache must not hide the failure");

  await db.run("UPDATE twain_recognition_results SET objective_json = ? WHERE scan_record_id = ?",
    JSON.stringify([{ questionNumber: 1, selectedOptions: ["A"], confidence: 1 }]), records[1].id);
  // A successful card manually adjusted after saving must not be overwritten by retrying others.
  await db.run("UPDATE student_scores SET total_score = 4 WHERE exam_id = ? AND student_id = ?", exam.lastInsertRowid, users[0]);
  const recovered = await request("POST");
  assert.equal(recovered.results.length, 3);
  assert.equal(await scoreCount(), 3);
  assert.equal((await db.get<{ total_score: number }>("SELECT total_score FROM student_scores WHERE exam_id = ? AND student_id = ?", exam.lastInsertRowid, users[0]))!.total_score, 4);

  // Force an actual DB failure for the first student, then check that later cards commit.
  await db.run("DELETE FROM twain_student_grading_results WHERE session_id = ?", session.id);
  await db.run("DELETE FROM question_scores WHERE exam_id = ?", exam.lastInsertRowid);
  await db.run("DELETE FROM student_scores WHERE exam_id = ?", exam.lastInsertRowid);
  if (db.dialect === "sqlite") {
    await db.exec(`CREATE TRIGGER scanner_batch_failure BEFORE INSERT ON student_scores WHEN NEW.student_id = ${users[0]} BEGIN SELECT RAISE(ABORT, 'injected card failure'); END`);
  } else {
    await db.exec(`CREATE TRIGGER scanner_batch_failure BEFORE INSERT ON student_scores FOR EACH ROW BEGIN IF NEW.student_id = ${users[0]} THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'injected card failure'; END IF; END`);
  }
  const saved = await request("POST");
  assert.equal(saved.failures[0].stage, "saving");
  assert.deepEqual(saved.results.map(r => r.studentId), ["91002", "91003"]);
  assert.equal(await scoreCount(), 2);
  await db.exec("DROP TRIGGER scanner_batch_failure");
  assert.equal((await request("POST")).failures.length, 0);
  assert.equal(await scoreCount(), 3);

  const raw = (await store.listScanRecordsGroupedByStudent(session.id)).flatMap(g => g.records);
  for (const identity of [null, { status: "rejected", code: "CARD_MISMATCH" },
    { status: "verified", cardId: "wrong", pageNumber: 1 }, { status: "verified", cardId: card.id, pageNumber: 2 }]) {
    const invalid = structuredClone(raw);
    invalid[0].identity_json = identity ? JSON.stringify(identity) : null;
    let saved = 0;
    const checked = await collectSessionResults(card, invalid, [], async () => { saved++; });
    assert.equal(checked.failures.length, 1, "Wrong/missing identity must block cached grades even with manual student ID");
    assert.equal(saved, 2);
  }
  const compatible = structuredClone(raw);
  compatible[0].identity_json = JSON.stringify({ status: "unverified", code: "QR_MISSING" });
  assert.equal((await collectSessionResults(card, compatible, [])).failures.length, 1);
  compatible[0].identity_mode = "legacy";
  assert.equal((await collectSessionResults(card, compatible, [])).failures.length, 0);
  assert.equal((await store.createSession(card.id, "strict default")).identity_mode, "strict");
  assert.equal((await store.createSession(card.id, "legacy explicit", { identityMode: "legacy" })).identity_mode, "legacy");
  const missing = structuredClone(raw);
  missing[1].recognition = null; missing[1].student_id = null; missing[1].ocr_status = "failed";
  const result = await collectSessionResults(card, missing, []);
  assert.equal(result.results.length, 2);
  assert.equal(result.failures[0].pages[0].recordId, records[1].id, "Unrecognized cards must be listed");
  const duplicate = structuredClone(raw); duplicate[1].student_id = duplicate[0].student_id;
  assert.equal((await collectSessionResults(card, duplicate, [])).failures.length, 2, "Duplicate student cards must not silently merge");
  const duplex = structuredClone(card); duplex.sided = "double";
  const objective = duplex.bodyBlocks[0];
  assert(objective.type === "objective");
  for (let count = 10; count <= 400 && buildLayout(duplex).pages.length < 2; count += 10) objective.questionCount = count;
  assert.equal(buildLayout(duplex).pages.length, 2, "Duplex fixture should span two layout pages");
  const twoCards = [
    { ...raw[0], id: "front1", page_num: 1, side: "front" as const },
    { ...raw[0], id: "back1", page_num: 1, side: "back" as const, student_id: null },
    { ...raw[2], id: "front2", page_num: 2, side: "front" as const },
    { ...raw[2], id: "back2", page_num: 2, side: "back" as const, student_id: null },
  ];
  for (const record of twoCards) record.identity_json = JSON.stringify({ status: "verified", code: "QR_VERIFIED", cardId: duplex.id, pageNumber: record.side === "back" ? 2 : 1 });
  const paired = await collectSessionResults(duplex, [...twoCards].reverse(), []);
  assert.equal(paired.results.length, 2, "Sort actual same-number front/back records and inherit within card");
  assert.deepEqual(paired.results[0].pages.map(p => p.layoutPage), [1, 2]);
  const missingBack = await collectSessionResults(duplex, twoCards.filter(r => r.id !== "back1"), []);
  assert.equal(missingBack.failures.length, 1, "Missing back must not become a partial successful grade");
  assert.equal(missingBack.results[0].studentId, "91003", "Missing back must not shift the next card's pairing");
  const conflict = structuredClone(twoCards); conflict[1].student_id = "99999";
  assert.equal((await collectSessionResults(duplex, conflict, [])).failures.length, 1, "Conflicting IDs must not split a physical card into students");

  const idOnly: CombinedRecognitionResult = { status: "failed", message: "Student ID recognition failed.",
    quality: { matchCount: 6, missingRoles: [] }, studentId: { status: "failed", value: null }, questions: [], subjectiveQuestions: [] };
  applyScanStudentId(idOnly, "91002");
  assert.equal(idOnly.status, "ok", "Manual ID correction resolves only an ID-only native failure");
  for (const message of ["Unable to find enough layout markers", "Cannot read image", "Student ID recognition failed."]) {
    const damaged: CombinedRecognitionResult = { status: "failed", message, quality: {}, questions: [], subjectiveQuestions: [] };
    applyScanStudentId(damaged, "91002");
    assert.equal(damaged.status, "failed", "ID correction must not clear image/marker failures or absent quality evidence");
  }
  const { processScannerSession } = await import("../src/server/services/scannerSubmissions");
  async function makeSession(numbers: string[]) {
    const s = await store.createSession(card.id, "duplicate-test");
    for (const [index, number] of numbers.entries()) {
      const record = await createVerifiedRecord({ sessionId: s.id, cardId: card.id, pageNum: index + 1, imagePath: path.join(root, `retained-${s.id}-${index}.png`) });
      await store.updateScanOcrResult(record.id, number, 1, "uploaded");
      await store.upsertRecognitionResult({ scanRecordId: record.id, objectiveJson: JSON.stringify([{ questionNumber: 1, selectedOptions: [index ? "B" : "A"], confidence: 1 }]), subjectiveJson: "[]", gradeStatus: "recognized" });
    }
    await store.updateSessionStatus(s.id, "completed");
    return s;
  }
  async function remote(sid: string, endpoint = "complete", body?: unknown) {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/scanner/upload/sessions/${sid}/${endpoint}`, {
      method: "POST", headers: { "X-Api-Key": "scanner-test-only", "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json() as ScanBatchResponse };
  }
  // A scanner key can save a new student's result after partial publication,
  // but cannot expose that score without a fresh teacher publication.
  const laterStudent = await db.run("INSERT INTO users (username,password_hash,name,role_id,student_number) VALUES (?,?,?,?,?)",
    "later-scanner-result", "test", "后续扫描", role.id, "91888");
  await db.run("INSERT INTO exam_participants (exam_id,student_id,source) VALUES (?,?,'explicit')", exam.lastInsertRowid, laterStudent.lastInsertRowid);
  await db.run("UPDATE exams SET status='grading', score_published=1 WHERE id=?", exam.lastInsertRowid);
  const laterSession = await makeSession(["91888"]);
  const laterSaved = await remote(laterSession.id);
  assert.equal(laterSaved.status, 200);
  assert(await db.get("SELECT id FROM student_scores WHERE exam_id=? AND student_id=?", exam.lastInsertRowid, laterStudent.lastInsertRowid));
  assert.equal((await db.get<{ score_published: number }>("SELECT score_published FROM exams WHERE id=?", exam.lastInsertRowid))!.score_published, 0);
  assert.equal((await db.all("SELECT id FROM exam_publish_events WHERE exam_id=? AND reason=?", exam.lastInsertRowid, "扫描成绩入库自动撤回")).length, 1);
  const { ScoreRepository } = await import("../src/server/repositories/ScoreRepository");
  assert.equal((await new ScoreRepository().getStudentScores(Number(laterStudent.lastInsertRowid))).length, 0, "New scanner score stays hidden from students");
  await db.run("UPDATE exams SET score_published=1 WHERE id=?", exam.lastInsertRowid);
  assert.equal((await remote(laterSession.id)).status, 200);
  assert.equal((await db.get<{ score_published: number }>("SELECT score_published FROM exams WHERE id=?", exam.lastInsertRowid))!.score_published, 1, "Saved receipt replay does not mutate scores or withdraw publication");
  const { persistScannerResultToMainDb } = await import("../src/server/services/scannerResultPersistence");
  const savedResult = (await processScannerSession(card, laterSession.id)).results[0];
  await db.run("UPDATE exams SET status='grading' WHERE id=?", exam.lastInsertRowid);
  const beforeScore = await db.get("SELECT total_score FROM student_scores WHERE exam_id=? AND student_id=?", exam.lastInsertRowid, laterStudent.lastInsertRowid);
  await assert.rejects(db.transaction(async tx => {
    await persistScannerResultToMainDb(card.id, { ...savedResult, totalScore: 123, totalMaxScore: savedResult.maxScore,
      pages: [], objectiveQuestions: [], subjectiveQuestions: [] }, true, { db: tx, examId: Number(exam.lastInsertRowid) });
    throw new Error("forced scanner save rollback");
  }), /forced scanner save rollback/);
  assert.deepEqual(await db.get("SELECT total_score FROM student_scores WHERE exam_id=? AND student_id=?", exam.lastInsertRowid, laterStudent.lastInsertRowid), beforeScore);
  assert.equal((await db.get<{ score_published: number }>("SELECT score_published FROM exams WHERE id=?", exam.lastInsertRowid))!.score_published, 1, "Failed save rolls back publication withdrawal too");
  assert.equal((await db.all("SELECT id FROM exam_publish_events WHERE exam_id=? AND reason=?", exam.lastInsertRowid, "扫描成绩入库自动撤回")).length, 1, "Failed save leaves no withdrawal audit");
  await db.run("UPDATE exams SET score_published=0 WHERE id=?", exam.lastInsertRowid);
  // A saved receipt owns its crops even after closure or reuse of the card.
  const cropId = "receipt-bound-crop";
  await db.run(`INSERT INTO answer_block_crops
    (id, card_id, source_type, source_record_id, block_id, block_type, page_number,
     segment_index, question_numbers, rect_json, image_path, width_px, height_px, dpi)
    VALUES (?, ?, 'twain_scan_record', ?, 'batch_q', 'objective', 1, 0, '[1]', '{}', 'test.png', 1, 1, 300)`,
    cropId, card.id, records[0].id);
  await db.run("UPDATE twain_scan_records SET ocr_status = 'uploaded' WHERE session_id = ?", session.id);
  await db.run("UPDATE exams SET status = 'closed' WHERE id = ?", exam.lastInsertRowid);
  async function assertCropOwner(message: string) {
    const response = await remote(session.id);
    assert.equal(response.status, 200, JSON.stringify(response.data));
    const crop = await db.get<{ exam_id: number; student_id: number }>("SELECT exam_id, student_id FROM answer_block_crops WHERE id = ?", cropId);
    assert.equal(Number(crop?.exam_id), Number(exam.lastInsertRowid), message);
    assert.equal(Number(crop?.student_id), users[0]);
  }
  await assertCropOwner("Closed-exam retries must bind previously unbound crops to the saved receipt");
  const otherExam = await db.run("INSERT INTO exams (name,card_id,status) VALUES (?,?,'grading')", "复用答题卡", card.id);
  await db.run("INSERT INTO student_scores (exam_id,student_id,total_score) VALUES (?,?,2)", otherExam.lastInsertRowid, users[0]);
  await assertCropOwner("Retrying exam A must not move its crops to active exam B");
  await db.run("UPDATE exams SET status = 'grading' WHERE id = ?", exam.lastInsertRowid);
  await db.run("UPDATE answer_block_crops SET exam_id = NULL, student_id = NULL WHERE id = ?", cropId);
  await assertCropOwner("Multiple active exams must not suppress binding to the saved receipt");
  await db.run("DELETE FROM exams WHERE id = ?", otherExam.lastInsertRowid);
  await db.run("UPDATE exams SET status = 'grading' WHERE id = ?", exam.lastInsertRowid);

  const unmatched = await makeSession(["91999"]);
  // Simulate a misleading cache from the old implementation: it must not suppress saving.
  await store.upsertStudentGradingResult({ sessionId: unmatched.id, studentId: "91999", objectiveJson: "[]", subjectiveJson: "[]", totalScore: 5, maxScore: 5 });
  assert.equal((await processScannerSession(card, unmatched.id, "save")).failures[0].stage, "saving");
  const outsider = await db.run("INSERT INTO users (username,password_hash,name,role_id,student_number) VALUES (?,?,?,?,?)", "outsider", "test", "外班", role.id, "91999");
  assert.equal((await processScannerSession(card, unmatched.id, "save")).failures[0].stage, "saving", "Out-of-roster scores cannot claim saved");
  await db.run("INSERT INTO exam_participants (exam_id,student_id,source) VALUES (?,?,'explicit')", exam.lastInsertRowid, outsider.lastInsertRowid);
  assert.equal((await processScannerSession(card, unmatched.id, "save")).results[0].saved, true, "Roster repair must really retry persistence");

  const newCard = createDefaultCard("91512002");
  const noExam = await store.createSession(newCard.id, "unlinked");
  const unlinkedRecord = await createVerifiedRecord({ sessionId: noExam.id, cardId: newCard.id, pageNum: 1, imagePath: "unlinked.png" });
  await store.updateScanOcrResult(unlinkedRecord.id, "91001", 1, "done");
  await store.upsertRecognitionResult({ scanRecordId: unlinkedRecord.id, objectiveJson: "[]", subjectiveJson: "[]" });
  newCard.bodyBlocks = card.bodyBlocks;
  assert.equal((await processScannerSession(newCard, noExam.id, "save")).failures[0].stage, "saving", "Unlinked cards must not be saved");

  await db.run("UPDATE exams SET status = 'closed', score_published = 1 WHERE id = ?", exam.lastInsertRowid);
  const duplicateSession = await makeSession(["91001", "91001"]);
  const rejected = await remote(duplicateSession.id);
  assert.equal(rejected.status, 409);
  assert.equal(rejected.data.failures.length, 2);
  assert.equal(rejected.data.results.length, 0, "Never merge best answers across duplicate attempts");
  assert.equal(rejected.data.failures[0].conflicts!.length, 3, "Both new attempts and the previously saved original are shown");
  assert(rejected.data.failures[0].conflicts!.some(c => c.sessionId === session.id && c.previouslySaved && c.pages[0].recordId === records[0].id));
  assert.equal(await db.get("SELECT id FROM student_scores WHERE exam_id = ? AND student_id = ?", exam.lastInsertRowid, users[0]), null);
  assert.equal((await db.all("SELECT id FROM question_scores WHERE exam_id = ? AND student_id = ?", exam.lastInsertRowid, users[0])).length, 0);
  assert(await store.getScanRecordWithResult(records[0].id), "Keep original recognition for correction");
  assert.equal((await db.get<{ score_published: number }>("SELECT score_published FROM exams WHERE id = ?", exam.lastInsertRowid))!.score_published, 0);
  assert(await db.get("SELECT id FROM exam_publish_events WHERE exam_id = ? AND reason = ?", exam.lastInsertRowid, "扫描重复学号自动撤回"), "Withdrawal must retain publication audit");
  assert((await request()).failures.some(f => f.studentId === "91001"), "Old session must show the saved original as a problem too");
  for (const [groupId, number] of ["91991", "91992"].entries()) {
    const student = await db.run("INSERT INTO users (username,password_hash,name,role_id,student_number) VALUES (?,?,?,?,?)", number, "test", number, role.id, number);
    await db.run("INSERT INTO exam_participants (exam_id,student_id,source) VALUES (?,?,'explicit')", exam.lastInsertRowid, student.lastInsertRowid);
    assert.equal((await remote(duplicateSession.id, "correct", { groupId: String(groupId), studentId: number })).status, 200);
  }
  const corrected = await remote(duplicateSession.id);
  assert.equal(corrected.status, 200);
  const oldPreview = await request();
  assert(oldPreview.results.some(r => r.studentId === "91001" && !r.saved), "Resolved old attempt needs explicit saving");
  assert(oldPreview.reviewCards?.some(c => c.sessionId === session.id && c.previouslySaved), "Do not lose withdrawn old cards when new IDs are corrected");
  assert.equal((await request("POST")).failures.length, 0);
  assert.equal((await remote(duplicateSession.id)).status, 200, "Reposting same submission is idempotent, not a duplicate");

  const parallelNumber = "91993";
  const parallelUser = await db.run("INSERT INTO users (username,password_hash,name,role_id,student_number) VALUES (?,?,?,?,?)", parallelNumber, "test", parallelNumber, role.id, parallelNumber);
  await db.run("INSERT INTO exam_participants (exam_id,student_id,source) VALUES (?,?,'explicit')", exam.lastInsertRowid, parallelUser.lastInsertRowid);
  const first = await makeSession([parallelNumber]); const second = await makeSession([parallelNumber]);
  await Promise.all([remote(first.id), remote(second.id)]);
  assert.equal(await db.get("SELECT id FROM student_scores WHERE exam_id = ? AND student_id = ?", exam.lastInsertRowid, parallelUser.lastInsertRowid), null, "Concurrent duplicate sessions must not leave a normal score");
  // Existing installations: a verified cache belongs to the same original, not a duplicate.
  await db.run("DELETE FROM scanner_submissions WHERE session_id = ?", unmatched.id);
  assert.equal((await processScannerSession(card, unmatched.id, "save")).failures.length, 0, "Upgrade a verified legacy original without withdrawing it");
  const legacyUser = await db.run("INSERT INTO users (username,password_hash,name,role_id,student_number) VALUES (?,?,?,?,?)", "legacy", "test", "legacy", role.id, "91994");
  const legacyCorrected = await db.run("INSERT INTO users (username,password_hash,name,role_id,student_number) VALUES (?,?,?,?,?)", "legacy-fixed", "test", "legacy-fixed", role.id, "91995");
  for (const id of [legacyUser.lastInsertRowid, legacyCorrected.lastInsertRowid]) await db.run("INSERT INTO exam_participants (exam_id,student_id,source) VALUES (?,?,'explicit')", exam.lastInsertRowid, id);
  await db.run("INSERT INTO student_scores (exam_id,student_id,objective_score,subjective_score,total_score) VALUES (?,?,3,0,3)", exam.lastInsertRowid, legacyUser.lastInsertRowid);
  await db.run("INSERT INTO question_scores (exam_id,student_id,question_number,score,max_score,score_type) VALUES (?,?,1,3,5,'objective')", exam.lastInsertRowid, legacyUser.lastInsertRowid);
  const legacyNew = await makeSession(["91994"]);
  const legacyConflict = await remote(legacyNew.id);
  assert.equal(legacyConflict.status, 409);
  assert(legacyConflict.data.failures[0].conflicts?.some(c => c.sessionId.startsWith("legacy:") && c.totalScore === 3));
  const { recoverLegacyScannerSubmission } = await import("../src/server/services/scannerSubmissions");
  await recoverLegacyScannerSubmission(Number(exam.lastInsertRowid), String(legacyUser.lastInsertRowid), "91995");
  await recoverLegacyScannerSubmission(Number(exam.lastInsertRowid), String(legacyUser.lastInsertRowid));
  assert.equal((await db.get<{ total_score: number }>("SELECT total_score FROM student_scores WHERE exam_id = ? AND student_id = ?", exam.lastInsertRowid, legacyCorrected.lastInsertRowid))!.total_score, 3, "Restore exactly the teacher-reviewed legacy snapshot");
  assert.equal((await remote(legacyNew.id)).status, 200);
  const repeatedPage = await createVerifiedRecord({ sessionId: session.id, cardId: card.id, pageNum: 1, imagePath: "duplicate-page.png" });
  await store.updateScanOcrResult(repeatedPage.id, "91001", 1, "done");
  await store.upsertRecognitionResult({ scanRecordId: repeatedPage.id, objectiveJson: "[]", subjectiveJson: "[]" });
  assert((await processScannerSession(card, session.id, "validate")).failures.some(f => f.message.includes("重复页")));
  assert.equal(await db.get("SELECT id FROM student_scores WHERE exam_id = ? AND student_id = ?", exam.lastInsertRowid, users[0]), null, "Repeated pages cannot leave an older score normal");
  // Remote ingress rejects missing/wrong evidence and invalidates a previous successful upload.
  const uploadSession = await store.createSession(card.id, "qr-upload");
  const uploadRecord = await createVerifiedRecord({ sessionId: uploadSession.id, cardId: card.id, pageNum: 1, imagePath: "pending.png" });
  const { default: sharp } = await import("sharp");
  const image = await sharp({ create: { width: 20, height: 20, channels: 3, background: "white" } }).png().toBuffer();
  async function uploadIdentity(identity: unknown) {
    const form = new FormData();
    form.append("image", new Blob([image]), "scan.png"); form.append("token", uploadRecord.id);
    form.append("pageNum", "1"); form.append("side", "front");
    form.append("recognition", JSON.stringify({ status: "ok", studentId: { status: "ok", value: "91001" }, questions: [], subjectiveQuestions: [], identity }));
    return fetch(`${base}/api/scanner/upload/sessions/${uploadSession.id}/pages`, { method: "POST", headers: { "X-Api-Key": "scanner-test-only" }, body: form });
  }
  assert.equal((await uploadIdentity({ status: "verified", code: "QR_VERIFIED", cardId: card.id, pageNumber: 1 })).status, 200);
  assert(await store.getScanRecordWithResult(uploadRecord.id));
  assert.equal((await uploadIdentity({ status: "verified", code: "QR_VERIFIED", cardId: "wrong-card", pageNumber: 1 })).status, 409);
  assert.equal((await store.getScanRecordWithResult(uploadRecord.id))?.recognition, null);
  assert.equal((await uploadIdentity(undefined)).status, 400);
  assert.equal((await uploadIdentity({ status: "unverified", code: "QR_MISSING" })).status, 409);
  await db.run("UPDATE twain_scan_sessions SET identity_mode = 'legacy' WHERE id = ?", uploadSession.id);
  assert.equal((await uploadIdentity({ status: "unverified", code: "QR_MISSING" })).status, 200);
  assert.equal((await uploadIdentity({ status: "verified", code: "QR_VERIFIED", cardId: card.id, pageNumber: 2 })).status, 409);

  // A failed retry invalidates all cached recognition before manual ID correction.
  const retrySession = await store.createSession(card.id, "qr retry");
  const retryRecord = await createVerifiedRecord({ sessionId: retrySession.id, cardId: card.id, pageNum: 1, imagePath: path.join(root, "missing-scan.png") });
  await store.updateScanOcrResult(retryRecord.id, "91001", 1, "done");
  await store.upsertRecognitionResult({ scanRecordId: retryRecord.id, objectiveJson: "[]", subjectiveJson: "[]", totalScore: 5 });
  await store.upsertStudentGradingResult({ sessionId: retrySession.id, studentId: "91001", totalScore: 5, pageCount: 1 });
  await db.run(`INSERT INTO answer_block_crops (id,card_id,source_type,source_record_id,block_id,block_type,page_number,segment_index,question_numbers,rect_json,image_path,width_px,height_px,dpi)
    VALUES (?,?,'twain_scan_record',?,'test','objective',1,0,'[1]','{}','stale.png',10,10,200)`, "qr-stale-crop", card.id, retryRecord.id);
  const { runOcrOnSession } = await import("../src/apps/answer-card/server/scanner/scanner-service");
  await runOcrOnSession(retrySession.id, card.id, () => {}, { recordIds: new Set([retryRecord.id]), studentId: "91001" });
  const failedRetry = await store.getScanRecordWithResult(retryRecord.id);
  assert.equal(failedRetry?.ocr_status, "failed");
  assert.equal(failedRetry?.recognition, null);
  assert.equal(failedRetry?.identity_json, null);
  assert.equal(await db.get("SELECT id FROM answer_block_crops WHERE id = ?", "qr-stale-crop"), null);
  assert.equal((await db.all("SELECT * FROM twain_student_grading_results WHERE session_id = ?", retrySession.id)).length, 0);
  const savedRetryUser = await db.run("INSERT INTO users (username,password_hash,name,role_id,student_number) VALUES (?,?,?,?,?)", "qr-retry-student", "test", "二维码重试", role.id, "91996");
  await db.run("INSERT INTO exam_participants (exam_id,student_id,source) VALUES (?,?,'explicit')", exam.lastInsertRowid, savedRetryUser.lastInsertRowid);
  const savedRetry = await makeSession(["91996"]);
  assert.equal((await remote(savedRetry.id)).status, 200);
  assert(await db.get("SELECT id FROM student_scores WHERE exam_id = ? AND student_id = ?", exam.lastInsertRowid, savedRetryUser.lastInsertRowid));
  await db.run("UPDATE exams SET score_published = 1 WHERE id = ?", exam.lastInsertRowid);
  const savedRetryRecord = (await store.listScanRecords(savedRetry.id))[0];
  await runOcrOnSession(savedRetry.id, card.id, () => {}, { recordIds: new Set([savedRetryRecord.id]), studentId: "91996" });
  assert.equal(await db.get("SELECT id FROM student_scores WHERE exam_id = ? AND student_id = ?", exam.lastInsertRowid, savedRetryUser.lastInsertRowid), null, "Failed retry withdraws its previously saved score");
  assert.equal((await store.getScanRecordWithResult(savedRetryRecord.id))?.ocr_status, "failed");
  assert(await db.get("SELECT id FROM exam_publish_events WHERE exam_id = ? AND reason = ?", exam.lastInsertRowid, "扫描重新识别自动撤回"));
  assert.equal((await db.get<{ result_json: string | null }>("SELECT result_json FROM scanner_submissions WHERE session_id = ?", savedRetry.id))?.result_json, null);
  const identityRejected: CombinedRecognitionResult = { status: "failed", message: "Student ID recognition failed.", identity: { status: "rejected", code: "CARD_MISMATCH" },
    quality: { matchCount: 6, missingRoles: [] }, questions: [], subjectiveQuestions: [] };
  applyScanStudentId(identityRejected, "91001");
  assert.equal(identityRejected.status, "failed");
  assert.equal(identityRejected.studentId, undefined);
  console.log(`PASS scanner batch HTTP + ${db.dialect}: isolated saving, missing users/exams/roster, duplicate old/new withdrawal, retained evidence, correction, idempotency, concurrent submissions`);
} finally {
  await db.exec("DROP TRIGGER IF EXISTS scanner_batch_failure");
  await new Promise<void>(resolve => server.close(() => resolve()));
  resetAdapter();
  closeDatabase();
}
