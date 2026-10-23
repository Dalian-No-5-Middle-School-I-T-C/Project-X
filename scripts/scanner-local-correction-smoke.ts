/** Authenticated scanner corrections after card sync, with no local exam or roster. */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { startScannerFlowFixture } from "./scanner-upload-flow-fixture";
import { createDefaultCard } from "../src/shared/defaultCard";
import { cardFingerprint } from "../src/shared/cardVersion";
import { buildLayout } from "../src/shared/layout";
import { correctionCells, toggleCorrectionCell, type CorrectionDocument } from "../src/shared/scanCorrection";
import type { CombinedRecognitionResult } from "../src/shared/types";

const fixture = await startScannerFlowFixture(0, "127.0.0.1", { localScanner: true });
try {
  const { getMysqlDb, hashPassword } = await import("../src/server/db");
  const { authService } = await import("../src/server/services/AuthService");
  const { CardRepository } = await import("../src/server/repositories/CardRepository");
  const { storeCorrectionPage } = await import("../src/server/services/scanCorrection");
  const store = await import("../src/apps/answer-card/server/database/scan-store");
  const db = getMysqlDb(), repo = new CardRepository();
  const password = "Local-Correction-Test-2026!", hash = await hashPassword(password);
  const tokens: Record<string, string> = {};
  for (const [name, roleId] of [["admin", 1], ["teacher", 2], ["student", 3]] as const) {
    await db.run("INSERT INTO users(username,password_hash,name,role_id) VALUES (?,?,?,?)", `local_${name}`, hash, name, roleId);
    const login = await authService.login(`local_${name}`, password);
    assert(login.success && login.token); tokens[name] = login.token;
  }
  const card = createDefaultCard("91519002");
  card.studentInfo.studentNumberDigits = 5;
  card.bodyBlocks = [{ id: "local_obj", type: "objective", title: "local", questionStart: 1, questionCount: 1,
    optionCount: 4, mode: "single", scorePerQuestion: 5, answerKey: { "1": ["A"] }, density: "normal" }];
  await repo.createCard(card); await repo.updateCard(card);
  const current = (await repo.findById(card.id))!, version = cardFingerprint(current);
  const session = await store.createSession(card.id, "synced card without local exam");
  await db.run("UPDATE twain_scan_sessions SET status='completed',card_version=? WHERE id=?", version, session.id);
  const imagePath = path.join(process.env.ANSWER_CARD_DATA_DIR!, "local.png");
  await writeFile(imagePath, await sharp({ create: { width: 210, height: 297, channels: 3, background: "white" } }).png().toBuffer());
  const record = await store.createScanRecord({ sessionId: session.id, cardId: card.id, pageNum: 1, imagePath });
  const recognition: CombinedRecognitionResult = { status: "ok", pageNumber: 1,
    identity: { status: "verified", code: "QR_VERIFIED", cardId: card.id, pageNumber: 1 },
    geometry: { imageWidth: 210, imageHeight: 297, imageToLayout: [1,0,0,0,1,0,0,0,1], layoutToImage: [1,0,0,0,1,0,0,0,1] },
    studentId: { status: "ok", value: "91001" }, questions: [{ questionNumber: 1, selectedOptions: ["B"], confidence: 1 }], subjectiveQuestions: [] };
  await db.run("UPDATE twain_scan_records SET student_id='91001',ocr_status='done',identity_json=? WHERE id=?", JSON.stringify(recognition.identity), record.id);
  await store.upsertRecognitionResult({ scanRecordId: record.id, objectiveJson: JSON.stringify(recognition.questions), subjectiveJson: "[]" });
  await storeCorrectionPage(current, "twain_scan_record", record.id, recognition);
  const url = `${fixture.baseUrl}/api/scanner/session/${session.id}/groups/0/correction`;
  const request = (role: string, method = "GET", body?: unknown, target = url) => fetch(target, { method,
    headers: { Authorization: `Bearer ${tokens[role]}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await request("student")).status, 403);
  assert.equal((await request("teacher")).status, 200);
  const read = await request("admin"); assert.equal(read.status, 200, await read.clone().text());
  const doc = await read.json() as CorrectionDocument;
  assert.equal(doc.pages.length, 1);
  assert.equal((await request("admin", "GET", undefined, fixture.baseUrl + doc.pages[0].imageUrl)).status, 200);
  const page = doc.pages[0], a = correctionCells(buildLayout(current).pages[0]).find(c => c.type === "objective_option" && c.option === "A")!;
  const edit = { sourceId: page.sourceId, revision: page.revision, selected: toggleCorrectionCell(current, page, page.selected, a.id) };
  const saved = await request("teacher", "PUT", { pages: [edit], draft: true });
  assert.equal(saved.status, 200, await saved.clone().text()); assert.equal((await saved.json()).drafted, true);
  const reopened = await (await request("teacher")).json() as CorrectionDocument;
  assert.deepEqual(reopened.pages[0].recognition.questions[0].selectedOptions, ["A"]);
  assert(reopened.pages[0].revision > page.revision);
  assert.equal((await request("teacher", "PUT", { pages: [edit], draft: true })).status, 409);
  const standalone = await request("admin", "PUT", { pages: [{ sourceId: page.sourceId,
    revision: reopened.pages[0].revision, selected: reopened.pages[0].selected }] });
  assert.equal(standalone.status, 200, await standalone.clone().text());
  assert.equal((await standalone.json()).saved, false, "the standalone editor keeps corrected marks until upload");
  assert.equal(await db.get("SELECT id FROM student_scores WHERE student_id IN (SELECT id FROM users WHERE student_number='91001')"), null);
  assert.equal((await request("admin", "GET", undefined, url.replace("/session/", "/upload/sessions/"))).status, 409, "server-side correction still requires an exam");
  const firstExam = await db.run("INSERT INTO exams(name,card_id,status) VALUES (?,?,'grading')", "first", card.id);
  const secondExam = await db.run("INSERT INTO exams(name,card_id,status) VALUES (?,?,'grading')", "second", card.id);
  const ambiguous = await request("admin");
  assert.equal(ambiguous.status, 200, "multiple candidate exams must not block local card correction");
  const ambiguousDoc = await ambiguous.json() as CorrectionDocument;
  const ambiguousSave = await request("admin", "PUT", { pages: ambiguousDoc.pages.map(p => ({
    sourceId: p.sourceId, revision: p.revision, selected: p.selected })) });
  assert.equal(ambiguousSave.status, 200, "ambiguous ownership must still allow saving the local card");
  assert.equal((await ambiguousSave.json() as { saved: boolean }).saved, false, "ambiguous ownership must not admit grades");
  assert.equal(await db.get("SELECT id FROM student_scores WHERE exam_id IN (?,?)", firstExam.lastInsertRowid, secondExam.lastInsertRowid), null,
    "ambiguous local correction must never write formal grades");
  // 只有单题块授权的教师：看得到考试，但不能借归属歧义读改整张卡。
  const scoped = await db.run("INSERT INTO users(username,password_hash,name,role_id) VALUES ('local_blockscoped',?,'单题块教师',2)", hash);
  await db.run("INSERT INTO teacher_permissions(teacher_id,block_id,can_grade,can_view_scores) VALUES (?,?,?,?)", scoped.lastInsertRowid, "local_obj", 1, 1);
  const scopedLogin = await authService.login("local_blockscoped", password);
  assert(scopedLogin.success && scopedLogin.token);
  assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${scopedLogin.token}` } })).status, 403,
    "block-scoped teachers must not correct an ambiguous whole card");
  // 有整卷授权（这里是考试创建者）的教师仍可用，说明收口没有把正常改分也挡掉。
  const owner = await db.run("INSERT INTO users(username,password_hash,name,role_id) VALUES ('local_owner',?,'整卷教师',2)", hash);
  await db.run("UPDATE exams SET created_by=? WHERE id IN (?,?)", owner.lastInsertRowid, firstExam.lastInsertRowid, secondExam.lastInsertRowid);
  const ownerLogin = await authService.login("local_owner", password);
  assert(ownerLogin.success && ownerLogin.token);
  assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${ownerLogin.token}` } })).status, 200,
    "teachers with whole-exam grading access keep the ambiguous correction available");
  await db.run("UPDATE exams SET created_by=NULL WHERE id IN (?,?)", firstExam.lastInsertRowid, secondExam.lastInsertRowid);
  // 会话曾绑定第二场考试，而那场已被保留策略清理：不能把这张卡改挂到仍在用的第一场上。
  await db.run("INSERT INTO exam_archives(exam_id,is_deleted,deleted_at) VALUES (?,1,CURRENT_TIMESTAMP)", secondExam.lastInsertRowid);
  await db.run("INSERT INTO scanner_submissions(exam_id,session_id,group_id,student_number,state,pages_json) VALUES (?,?,?,'91001','saved','{}')",
    secondExam.lastInsertRowid, session.id, "0");
  assert.equal((await request("teacher")).status, 404, "archived bindings must not be re-homed onto another active exam");
  assert.equal((await request("admin")).status, 200, "admins keep the CR4 read-through on cleaned exams");
  await db.run("DELETE FROM scanner_submissions WHERE exam_id=? AND session_id=?", secondExam.lastInsertRowid, session.id);
  await db.run("DELETE FROM exam_archives WHERE exam_id=?", secondExam.lastInsertRowid);
  await db.run("DELETE FROM exams WHERE id=?", secondExam.lastInsertRowid);
  await db.run("INSERT INTO exam_archives(exam_id,is_deleted,deleted_at) VALUES (?,1,CURRENT_TIMESTAMP)", firstExam.lastInsertRowid);
  assert.equal((await request("teacher")).status, 404, "a cleaned exam must not become an unbound local scan");
  console.log(`PASS scanner local correction: ${db.dialect}; authenticated card-only sync, image, draft persistence, stale edits, student/anonymous/remote/ambiguous/deleted scope`);
} finally { await fixture.close(); }
