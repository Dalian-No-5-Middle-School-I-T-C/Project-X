/** Structurally invalid ID corrections must never withdraw another saved grade. */
import assert from "node:assert/strict";
import { startScannerFlowFixture } from "./scanner-upload-flow-fixture";

const fixture = await startScannerFlowFixture();
try {
  const info = await (await fetch(`${fixture.baseUrl}/test/fixture`)).json();
  const { getMysqlDb } = await import("../src/server/db");
  const { CardRepository } = await import("../src/server/repositories/CardRepository");
  const { processScannerSession } = await import("../src/server/services/scannerSubmissions");
  const store = await import("../src/apps/answer-card/server/database/scan-store");
  const db = getMysqlDb();
  const autoUnpublish = process.env.TEST_AUTO_UNPUBLISH === "1";
  const publicationAfterMutation = autoUnpublish ? 0 : 1;
  if (autoUnpublish) await db.run("INSERT INTO system_settings (`key`, value) VALUES ('auto_unpublish_on_score_change', '1')");

  const card = (await new CardRepository().findById(info.cardId))!;
  const exam = (await db.get<{ id: number }>("SELECT id FROM exams WHERE card_id=?", card.id))!;
  const owner = (await db.get<{ id: number }>("SELECT id FROM users WHERE student_number='91001'"))!;
  async function makeSession(name: string, number: string) {
    const session = await store.createSession(card.id, name);
    await db.run("UPDATE twain_scan_sessions SET card_version=?,version_source='upload' WHERE id=?", info.version, session.id);
    const record = await store.createScanRecord({ sessionId: session.id, cardId: card.id, pageNum: 1, imagePath: name + '.png' });
    await db.run("UPDATE twain_scan_records SET identity_json=? WHERE id=?", JSON.stringify({ status: "verified", code: "QR_VERIFIED", cardId: card.id, pageNumber: 1 }), record.id);
    await store.updateScanOcrResult(record.id, number, 1, "uploaded");
    await store.upsertRecognitionResult({ scanRecordId: record.id, objectiveJson: JSON.stringify([{ questionNumber: 1, selectedOptions: ["A"], confidence: 1 }]), subjectiveJson: "[]", gradeStatus: "recognized" });
    return { session, record };
  }
  const original = await makeSession("saved-original", "91001");
  assert.equal((await processScannerSession(card, original.session.id, "save")).results[0].saved, true);
  await db.run("UPDATE student_scores SET total_score=4,objective_score=4,assigned_score=82,manually_modified=1 WHERE exam_id=? AND student_id=?", exam.id, owner.id);
  await db.run("UPDATE question_scores SET score=4,manually_modified=1 WHERE exam_id=? AND student_id=?", exam.id, owner.id);
  await db.run(`INSERT INTO answer_block_crops
    (id,card_id,exam_id,student_id,source_type,source_record_id,block_id,block_type,page_number,segment_index,question_numbers,image_path,width_px,height_px,dpi,rect_json)
    VALUES ('original-crop',?,?,?,'twain_scan_record',?,'flow_q','objective',1,0,'[1]','original-crop.png',1,1,300,'{}')`, card.id, exam.id, owner.id, original.record.id);
  await db.run("UPDATE exams SET score_published=1,assigned_formula=? WHERE id=?", JSON.stringify({ type: "custom", enabled: true, params: {}, expression: "raw * 2" }), exam.id);
  const protectedState = async () => JSON.stringify(await Promise.all(
    ["student_scores", "question_scores", "exams", "scanner_submissions", "answer_block_crops", "exam_publish_events"].map(table => db.all(`SELECT * FROM ${table} ORDER BY ${table === "scanner_submissions" ? "exam_id,session_id,group_id" : "id"}`))));
  async function correct(sessionId: string, number: string, groupId = "0") {
    return fetch(`${fixture.baseUrl}/api/scanner/upload/sessions/${sessionId}/correct`, { method: "POST", headers: { "X-Api-Key": info.key, "Content-Type": "application/json" }, body: JSON.stringify({ groupId, studentId: number }) });
  }
  // Correcting a healthy sibling also processes the batch: an invalid sibling
  // must not get a duplicate receipt merely because its number matches a grade.
  const mixed = await makeSession("mixed-invalid-sibling", "91001");
  await db.run("UPDATE twain_scan_records SET identity_json=? WHERE id=?", JSON.stringify({ status: "rejected", code: "CARD_MISMATCH" }), mixed.record.id);
  const sibling = await store.createScanRecord({ sessionId: mixed.session.id, cardId: card.id, pageNum: 2, imagePath: 'valid-sibling.png' });
  await db.run("UPDATE twain_scan_records SET identity_json=? WHERE id=?", JSON.stringify({ status: "verified", code: "QR_VERIFIED", cardId: card.id, pageNumber: 1 }), sibling.id);
  await store.updateScanOcrResult(sibling.id, "91002", 1, "uploaded");
  await store.upsertRecognitionResult({ scanRecordId: sibling.id, objectiveJson: '[]', subjectiveJson: '[]' });
  const businessState = async () => JSON.stringify(await Promise.all(["student_scores", "question_scores", "exams", "answer_block_crops", "exam_publish_events"].map(table => db.all(`SELECT * FROM ${table} ORDER BY id`))));
  const mixedBefore = await businessState();
  assert.equal((await correct(mixed.session.id, "91003", "1")).status, 200);
  assert.equal(await businessState(), mixedBefore);
  assert.equal(await db.get("SELECT * FROM scanner_submissions WHERE session_id=? AND group_id='0'", mixed.session.id), null);
  for (const kind of ["wrong-card", "wrong-page", "strict-missing-qr", "failed-ocr", "missing-recognition", "malformed-recognition", "invalid-answer-shape", "repeated-page"] as const) {
    const { session, record } = await makeSession(kind, "91002");
    if (kind === "wrong-card" || kind === "wrong-page" || kind === "strict-missing-qr") {
      const identity = kind === "strict-missing-qr" ? { status: "unverified", code: "QR_MISSING" }
        : { status: "verified", code: "QR_VERIFIED", cardId: kind === "wrong-card" ? "other-card" : card.id, pageNumber: kind === "wrong-page" ? 2 : 1 };
      await db.run("UPDATE twain_scan_records SET identity_json=? WHERE id=?", JSON.stringify(identity), record.id);
    }
    if (kind === "failed-ocr") await db.run("UPDATE twain_scan_records SET ocr_status='failed',ocr_error='Image markers unavailable' WHERE id=?", record.id);
    if (kind === "missing-recognition") await db.run("DELETE FROM twain_recognition_results WHERE scan_record_id=?", record.id);
    if (kind === "malformed-recognition") await db.run("UPDATE twain_recognition_results SET objective_json='invalid-json' WHERE scan_record_id=?", record.id);
    if (kind === "invalid-answer-shape") await db.run("UPDATE twain_recognition_results SET objective_json='[null]' WHERE scan_record_id=?", record.id);
    if (kind === "repeated-page") {
      const duplicate = await store.createScanRecord({ sessionId: session.id, cardId: card.id, pageNum: 1, imagePath: 'repeated.png' });
      await db.run("UPDATE twain_scan_records SET identity_json=? WHERE id=?", JSON.stringify({ status: "verified", code: "QR_VERIFIED", cardId: card.id, pageNumber: 1 }), duplicate.id);
      await store.updateScanOcrResult(duplicate.id, "91002", 1, "uploaded");
      await store.upsertRecognitionResult({ scanRecordId: duplicate.id, objectiveJson: '[]', subjectiveJson: '[]' });
    }
    const before = await protectedState();
    const response = await correct(session.id, "91001");
    assert([200, 409].includes(response.status));
    assert.equal(await protectedState(), before, `${kind}: correcting an unsavable paper must preserve every saved grade, receipt, crop and publication field`);
    for (const mode of ["validate", "save"] as const) {
      const batch = await processScannerSession(card, session.id, mode);
      assert.equal(batch.results.length, 0);
      assert.equal(batch.failures.length, 1);
      assert.equal(await protectedState(), before, `${kind}: ${mode} must not mutate protected business data`);
    }
  }
  // A complete valid duplicate still withdraws both attempts for teacher review.
  const valid = await makeSession("valid-duplicate", "91002");
  assert.equal((await correct(valid.session.id, "91001")).status, 200);
  assert.equal(await db.get("SELECT id FROM student_scores WHERE exam_id=? AND student_id=?", exam.id, owner.id), null);
  assert.equal(Number((await db.get<{ score_published: number }>("SELECT score_published FROM exams WHERE id=?", exam.id))!.score_published), publicationAfterMutation);
  assert.equal((await db.all("SELECT * FROM scanner_submissions WHERE exam_id=? AND student_number='91001' AND state='conflict'", exam.id)).length, 2);
  console.log(`PASS scanner correction safety: ${db.dialect}, eight invalid structures preserve saved manual grades/publication; valid duplicate remains reviewable`);
} finally { await fixture.close(); }
