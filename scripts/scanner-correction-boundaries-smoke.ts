/** Exercise recovery and selected saves through real HTTP and persisted receipts. */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { startScannerFlowFixture } from "./scanner-upload-flow-fixture";
import type { CorrectionDocument } from "../src/shared/scanCorrection";
import type { CombinedRecognitionResult } from "../src/shared/types";
import type { DbAdapter } from "../src/server/db";

const fixture = await startScannerFlowFixture();
try {
  const info = await (await fetch(`${fixture.baseUrl}/test/fixture`)).json();
  const { getMysqlDb } = await import("../src/server/db");
  const { CardRepository } = await import("../src/server/repositories/CardRepository");
  const store = await import("../src/apps/answer-card/server/database/scan-store");
  const correction = await import("../src/server/services/scanCorrection");
  const { correctionProvenanceState } = await import("../src/server/services/scanCorrectionProvenance");
  const { processScannerSession } = await import("../src/server/services/scannerSubmissions");
  const { listPendingScans, confirmPendingScan } = await import("../src/server/services/scannerPending");
  const db = getMysqlDb(), card = (await new CardRepository().findById(info.cardId))!;
  const exam = (await db.get<{ id: number }>("SELECT id FROM exams WHERE card_id=?", card.id))!;
  const admin = await db.run("INSERT INTO users(username,password_hash,name,role_id) VALUES ('boundary-admin','disabled','边界验证',1)");
  const identity = { status: "verified", code: "QR_VERIFIED", cardId: card.id, pageNumber: 1 } as const;
  const recognition = (number: string, confidence = 1): CombinedRecognitionResult => ({
    status: "ok", pageNumber: 1, identity,
    geometry: { imageWidth: 2100, imageHeight: 2970, imageToLayout: [.1,0,0,0,.1,0,0,0,1], layoutToImage: [10,0,0,0,10,0,0,0,1] },
    studentId: { status: "ok", value: number }, questions: [{ questionNumber: 1, selectedOptions: ["A"], confidence }], subjectiveQuestions: [],
  });
  const original = await sharp({ create: { width: 2100, height: 2970, channels: 3, background: "white" } }).png().toBuffer();
  const changed = await sharp({ create: { width: 2100, height: 2970, channels: 3, background: "red" } }).png().toBuffer();
  async function createSession(name: string) {
    const session = await store.createSession(card.id, name);
    await db.run("UPDATE twain_scan_sessions SET card_version=?,version_source='native',status='completed' WHERE id=?", info.version, session.id);
    return session;
  }
  async function addPage(sessionId: string, number: string, index = 1, confidence = 1) {
    const imagePath = path.join(process.env.ANSWER_CARD_DATA_DIR!, `${sessionId}-${index}.png`);
    await writeFile(imagePath, original);
    const record = await store.createScanRecord({ sessionId, cardId: card.id, pageNum: index, imagePath });
    await db.run("UPDATE twain_scan_records SET student_id=?,identity_json=?,ocr_status='uploaded' WHERE id=?", number, JSON.stringify(identity), record.id);
    await store.upsertRecognitionResult({ scanRecordId: record.id, objectiveJson: JSON.stringify(recognition(number, confidence).questions), subjectiveJson: "[]" });
    return record;
  }
  const edits = (doc: CorrectionDocument) => doc.pages.map(page => ({
    sourceId: page.sourceId, revision: page.revision, selected: page.selected, touched: [],
    ...(page.recovery ? { recovery: { fingerprint: page.recovery.fingerprint, signature: page.recovery.signature, recognition: page.recognition } } : {}),
  }));
  async function request(sessionId: string, route: string, body: unknown, method = "POST") {
    const response = await fetch(`${fixture.baseUrl}/api/scanner/upload/sessions/${sessionId}/${route}`, {
      method, headers: { "X-Api-Key": info.key, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  const save = (sessionId: string, doc: CorrectionDocument) => request(sessionId, "groups/0/correction", { pages: edits(doc) }, "PUT");
  const complete = (sessionId: string, groupId: string) => request(sessionId, "complete", { cardVersion: info.version, groupId });
  const score = (number: string) => db.get<{ total_score: number }>("SELECT total_score FROM student_scores WHERE exam_id=? AND student_id=(SELECT id FROM users WHERE student_number=?)", exam.id, number);
  async function recover(sessionId: string, number: string) {
    const doc = await correction.sessionCorrection(card, sessionId, "0", true);
    assert(doc.pages.every(page => page.recovery));
    return correction.recognizeSessionCorrection(card, sessionId, "0", {
      version: doc.version, pages: doc.pages.map(page => ({ sourceId: page.sourceId, fingerprint: page.recovery!.fingerprint })),
    }, async () => recognition(number));
  }

  // Current-version recovery remains bound to its source before and after locking.
  const recovered = await createSession("current-version recovery boundaries");
  const recoveredPage = await addPage(recovered.id, "91001");
  await db.run("DELETE FROM exam_participants WHERE exam_id=? AND student_id=(SELECT id FROM users WHERE student_number='91001')", exam.id);
  assert.equal((await save(recovered.id, await recover(recovered.id, "91001"))).body.saved, false);
  const valid = await correction.sessionCorrection(card, recovered.id, "0", true);
  assert.equal(await correctionProvenanceState(db, card, recoveredPage.id), "valid");
  const storedBefore = await db.get("SELECT revision,recovery_fingerprint FROM scan_correction_pages WHERE source_id=?", recoveredPage.id);
  const staleToken = (await listPendingScans(exam.id)).find(item => item.sessionId === recovered.id)!.token;
  await writeFile(recoveredPage.image_path, changed);
  assert.equal(await correctionProvenanceState(db, card, recoveredPage.id), "invalid");
  assert((await correction.sessionCorrection(card, recovered.id, "0", true)).pages[0].recovery);
  assert.equal((await save(recovered.id, valid)).status, 409);
  await assert.rejects(confirmPendingScan(exam.id, recovered.id, "0", "accept", staleToken, admin.lastInsertRowid, null));
  const invalidItem = (await listPendingScans(exam.id)).find(item => item.sessionId === recovered.id)!;
  assert.match(invalidItem.issue!, /凭据已失效/);
  await assert.rejects(confirmPendingScan(exam.id, recovered.id, "0", "accept", invalidItem.token, admin.lastInsertRowid, null), /凭据已失效/);
  assert.deepEqual(await db.get("SELECT revision,recovery_fingerprint FROM scan_correction_pages WHERE source_id=?", recoveredPage.id), storedBefore);
  assert.equal(await score("91001") ?? null, null);
  // The complete endpoint also rejects a stale recovery on a correction receipt.
  await db.run("INSERT INTO exam_participants(exam_id,student_id,source) SELECT ?,id,'explicit' FROM users WHERE student_number='91001'", exam.id);
  await db.run("UPDATE scanner_submissions SET state='correction' WHERE session_id=?", recovered.id);
  await db.run("UPDATE twain_scan_records SET ocr_status='uploaded' WHERE id=?", recoveredPage.id);
  const staleComplete = await complete(recovered.id, "0");
  assert.equal(staleComplete.status, 409);
  assert.match(staleComplete.body.failures[0].message, /凭据已失效/);
  assert.equal(await score("91001") ?? null, null);
  await db.run("DELETE FROM exam_participants WHERE exam_id=? AND student_id=(SELECT id FROM users WHERE student_number='91001')", exam.id);
  await db.run("UPDATE scanner_submissions SET state='roster' WHERE session_id=?", recovered.id);

  await writeFile(recoveredPage.image_path, original);
  const transaction = db.transaction.bind(db);
  db.transaction = async <T>(fn: (tx: DbAdapter) => Promise<T>): Promise<T> => {
    await writeFile(recoveredPage.image_path, changed);
    return transaction(fn);
  };
  try {
    await assert.rejects(correction.saveSessionCorrection(card, recovered.id, "0", edits(valid), null, true), /凭据已失效/);
  } finally { db.transaction = transaction; }
  assert.deepEqual(await db.get("SELECT revision,recovery_fingerprint FROM scan_correction_pages WHERE source_id=?", recoveredPage.id), storedBefore);
  const fresh = await save(recovered.id, await recover(recovered.id, "91001"));
  assert.equal(fresh.status, 200); assert.equal(fresh.body.saved, false);
  const freshItem = (await listPendingScans(exam.id)).find(item => item.sessionId === recovered.id)!;
  assert.equal(freshItem.issue, undefined);
  await confirmPendingScan(exam.id, recovered.id, "0", "accept", freshItem.token, admin.lastInsertRowid, null);
  assert.equal(Number((await score("91001"))!.total_score), 5);

  // 带存疑的点名保存直接入库（issue #352 口径）：低置信度只是复核标记，不再拦正式成绩。
  const low = await createSession("unreviewed selected save");
  const lowPage = await addPage(low.id, "91002", 1, .1);
  await correction.storeCorrectionPage(card, "twain_scan_record", lowPage.id, recognition("91002", .1));
  await processScannerSession(card, low.id, "validate");
  await db.run("UPDATE scanner_submissions SET state='correction' WHERE session_id=?", low.id);
  const admitted = await complete(low.id, "0");
  assert.equal(admitted.status, 200, JSON.stringify(admitted.body));
  const admittedReceipt = await db.get<{ result_json: string }>("SELECT result_json FROM scanner_submissions WHERE session_id=?", low.id);
  assert.equal(JSON.parse(admittedReceipt!.result_json!).needsReviewCount, 1, "入库的回执仍带复核计数");
  assert.equal((await db.get<{ state: string }>("SELECT state FROM scanner_submissions WHERE session_id=?", low.id))!.state, "saved", "存疑卷点名保存即入库");
  assert.equal(Number((await score("91002"))!.total_score), 5, "存疑卷照常写正式成绩");
  // 入库之后本机订正让位给成绩修改侧，不能再改出两份不一致的成绩。
  const lowDoc = await correction.sessionCorrection(card, low.id, "0", true);
  const late = await request(low.id, "groups/0/correction", { pages: edits(lowDoc).map(page => ({ ...page, touched: page.selected })) }, "PUT");
  assert.equal(late.status, 409); assert.match(late.body.message, /已入库/);

  // An unrelated incomplete/blank-ID page cannot block or be rewritten by a named save.
  const partial = await createSession("selected save with broken sibling");
  await addPage(partial.id, "91003");
  const sibling = await addPage(partial.id, "91004", 2);
  await db.run("UPDATE twain_scan_records SET student_id=NULL WHERE id=?", sibling.id);
  await processScannerSession(card, partial.id, "validate");
  await db.run("UPDATE scanner_submissions SET state='correction' WHERE session_id=? AND group_id='0'", partial.id);
  assert.equal((await complete(partial.id, "1")).status, 409, "the blank-ID paper itself remains blocked");
  assert.equal((await complete(partial.id, "99")).status, 404);
  const selected = await complete(partial.id, "0");
  assert.equal(selected.status, 200, JSON.stringify(selected.body));
  assert.equal(Number((await score("91003"))!.total_score), 5);
  assert.equal((await db.get<{ ocr_status: string }>("SELECT ocr_status FROM twain_scan_records WHERE id=?", sibling.id))!.ocr_status, "uploaded");
  assert.equal(await score("91004") ?? null, null);
  // Retry is idempotent even while a different image is still awaiting upload.
  await db.run("UPDATE twain_scan_records SET ocr_status='pending' WHERE id=?", sibling.id);
  assert.equal((await complete(partial.id, "0")).status, 200);
  assert.equal((await complete(partial.id, "1")).status, 400);
  assert.equal((await request(partial.id, "complete", { cardVersion: info.version })).status, 400);
  assert.equal((await db.get<{ ocr_status: string }>("SELECT ocr_status FROM twain_scan_records WHERE id=?", sibling.id))!.ocr_status, "pending");

  // Sharing one in-flight session read must retain all papers and refresh next time.
  const cachedSession = await createSession("concurrent evidence reads");
  for (let index = 0; index < 4; index++) await addPage(cachedSession.id, `9100${index + 5}`, index + 1);
  await processScannerSession(card, cachedSession.id, "validate");
  await db.run("UPDATE scanner_submissions SET state='correction' WHERE session_id=?", cachedSession.id);
  const all = db.all.bind(db); let reads = 0;
  db.all = async <T>(sql: string, ...params: unknown[]): Promise<T[]> => {
    if (sql.includes("r.*,s.identity_mode,g.objective_json,g.subjective_json") && params.includes(cachedSession.id)) reads++;
    return all<T>(sql, ...params);
  };
  try {
    for (let refresh = 1; refresh <= 2; refresh++) {
      const items = (await listPendingScans(exam.id)).filter(item => item.sessionId === cachedSession.id);
      assert.equal(items.length, 4); assert(items.every(item => item.issue === undefined));
      assert.equal(new Set(items.map(item => item.token)).size, 4);
      assert.equal(reads, refresh, "one whole-session read per refresh");
    }
  } finally { db.all = all; }
  console.log(`PASS scanner correction boundaries (${db.dialect}): current-version provenance, lock-time source change, re-verification, selected-save rejection/recovery, sibling isolation and concurrent evidence cache`);
} finally { await fixture.close(); }
