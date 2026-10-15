/** Deterministic OCR/correction races on SQLite or an empty scanner MariaDB DB.
 * PROJECTX_RETRY_TEST_IMAGE + PROJECTX_RETRY_TEST_NATIVE=1 runs the real Windows OMR.
 * --prepare-native DIR exports the exact test card through the application's PDF path.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { startScannerFlowFixture } from "./scanner-upload-flow-fixture";
import { buildLayout } from "../src/shared/layout";
import { cardFingerprint } from "../src/shared/cardVersion";
import { correctionCells, toggleCorrectionCell } from "../src/shared/scanCorrection";
import type { CombinedRecognitionResult } from "../src/shared/types";

function gate() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}
async function reached(promise: Promise<unknown>, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 20000);
    })]);
  } finally { clearTimeout(timer); }
}

const fixture = await startScannerFlowFixture();
try {
  const info = await (await fetch(`${fixture.baseUrl}/test/fixture`)).json();
  const { getMysqlDb } = await import("../src/server/db");
  const { CardRepository } = await import("../src/server/repositories/CardRepository");
  const store = await import("../src/apps/answer-card/server/database/scan-store");
  const { runOcrOnSession } = await import("../src/apps/answer-card/server/scanner/scanner-service");
  const { recognizeAnswerCard } = await import("../src/apps/answer-card/server/recognition");
  const { sessionCorrection, saveSessionCorrection, studentCorrection, saveStudentCorrection, storeCorrectionPage } = await import("../src/server/services/scanCorrection");
  const { enqueueScannerSubmission, processScannerSession } = await import("../src/server/services/scannerSubmissions");
  const db = getMysqlDb(), repo = new CardRepository();
  const card = (await repo.findById(info.cardId))!;
  card.studentInfo.studentNumberDigits = 5;
  card.bodyBlocks.push({ id: "retry_manual", type: "subjective", title: "大题", questions: [
    { id: "retry_q2", number: 2, score: 30, style: "manual_score_grid", kind: "plain_box", minHeightMm: 30 },
  ] });
  await repo.updateCard(card);
  const current = (await repo.findById(card.id))!;
  const layout = buildLayout(current), cells = correctionCells(layout.pages[0]);
  const prepareIndex = process.argv.indexOf("--prepare-native");
  if (prepareIndex !== -1) {
    const out = path.resolve(process.argv[prepareIndex + 1]);
    await mkdir(out, { recursive: true });
    const { createPdf } = await import("../src/apps/answer-card/server/pdf");
    const pdf = createPdf(current);
    const saved = pipeline(pdf, createWriteStream(path.join(out, "并发回归答题卡.pdf")));
    pdf.end(); await saved;
    await writeFile(path.join(out, "layout.json"), JSON.stringify(layout));
    console.log(`PREPARED_NATIVE ${out}`);
  } else {
    const imagePath = process.env.PROJECTX_RETRY_TEST_IMAGE || path.join(process.env.ANSWER_CARD_DATA_DIR!, "retry.png");
    if (!process.env.PROJECTX_RETRY_TEST_IMAGE) await writeFile(imagePath, Buffer.from(info.images.original, "base64"));
    const session = await store.createSession(card.id, "OCR 与人工改分并发");
    await db.run("UPDATE twain_scan_sessions SET status='completed',card_version=?,version_source='upload' WHERE id=?", cardFingerprint(current), session.id);
    const record = await store.createScanRecord({ sessionId: session.id, cardId: card.id, pageNum: 1, imagePath });
    const exam = (await db.get<{ id: number }>("SELECT id FROM exams WHERE card_id=?", card.id))!;
    const student = (await db.get<{ id: number }>("SELECT id FROM users WHERE student_number='91001'"))!;
    const identity = { status: "verified", code: "QR_VERIFIED", cardId: card.id, pageNumber: 1 } as const;
    const ten = cells.find(c => c.type === "score_cell" && c.score === 10)!;
    const recognition: CombinedRecognitionResult = { status: "ok", pageNumber: 1, identity,
      geometry: { imageWidth: 2100, imageHeight: 2970, imageToLayout: [.1,0,0,0,.1,0,0,0,1], layoutToImage: [10,0,0,0,10,0,0,0,1] },
      studentId: { status: "ok", value: "91001" }, questions: [{ questionNumber: 1, selectedOptions: ["A"], confidence: 1 }],
      subjectiveQuestions: [{ blockId: "retry_manual", questionId: "retry_q2", questionNumber: 2, maxScore: 30, score: 10,
        status: "ok", confidence: 1, validCells: [{ score: 10, rect: ten.rect }], invalidCells: [] }],
    };
    await db.run("UPDATE twain_scan_records SET identity_json=?,student_id='91001',ocr_status='done' WHERE id=?", JSON.stringify(identity), record.id);
    await store.upsertRecognitionResult({ scanRecordId: record.id, objectiveJson: JSON.stringify(recognition.questions), subjectiveJson: JSON.stringify(recognition.subjectiveQuestions) });
    await storeCorrectionPage(current, "twain_scan_record", record.id, recognition);
    const oldPage = (await sessionCorrection(current, session.id, "0", false)).pages[0];
    const edit = (page: typeof oldPage) => {
      let selected = toggleCorrectionCell(current, page, page.selected, cells.find(c => c.type === "objective_option" && c.option === "B")!.id);
      selected = toggleCorrectionCell(current, page, selected, ten.id);
      selected = toggleCorrectionCell(current, page, selected, cells.find(c => c.type === "score_cell" && c.score === 20)!.id);
      return { sourceId: page.sourceId, revision: page.revision, selected };
    };

    // Pause once in the native call, then after the new snapshot is written but
    // before OCR metadata/answers are persisted. Both are real asynchronous gaps.
    const nativeEntered = gate(), releaseNative = gate(), snapshotWritten = gate(), releaseWrite = gate();
    const run = db.run.bind(db);
    let pauseWrite = true, staleSettled = false, freshSettled = false;
    db.run = async (sql, ...params) => {
      if (pauseWrite && sql.includes("SET student_id = ?, student_conf = ?") && params.at(-1) === record.id) {
        pauseWrite = false; snapshotWritten.open(); await releaseWrite.promise;
      }
      return run(sql, ...params);
    };
    let nativeCalls = 0;
    const retry = runOcrOnSession(session.id, card.id, () => {}, { recordIds: new Set([record.id]) }, async request => {
      nativeCalls++; nativeEntered.open(); await releaseNative.promise;
      const result = process.env.PROJECTX_RETRY_TEST_NATIVE === "1" ? await recognizeAnswerCard(request) : structuredClone(recognition);
      const recognized = result as CombinedRecognitionResult;
      assert.equal(recognized.studentId?.value, "91001");
      assert.deepEqual(recognized.questions[0].selectedOptions, ["A"]);
      assert.equal(recognized.subjectiveQuestions?.[0].score, 10);
      return result;
    });
    let stale: Promise<unknown> | undefined, fresh: Promise<unknown> | undefined;
    try {
      await reached(nativeEntered.promise, "native recognition entered");
      stale = saveSessionCorrection(current, session.id, "0", [edit(oldPage)], student.id)
        .then(() => { staleSettled = true; return null; }, error => { staleSettled = true; return error; });
      await delay(150);
      assert.equal(staleSettled, false, "human save must wait while native recognition is in flight");
      releaseNative.open();
      await reached(snapshotWritten.promise, "snapshot written before OCR answers");
      const freshPage = (await sessionCorrection(current, session.id, "0", false)).pages[0];
      fresh = saveSessionCorrection(current, session.id, "0", [edit(freshPage)], student.id)
        .then(value => { freshSettled = true; return value; }, error => { freshSettled = true; throw error; });
      await delay(150);
      assert.equal(freshSettled, false, "fresh human save must also wait until OCR answers/crops finish");
      releaseWrite.open();
      await reached(retry, "retry completes without nested-queue deadlock");
      assert.match(String(await stale), /已更新/, "pre-retry draft is rejected as stale");
      assert.equal((await fresh as { saved: boolean }).saved, true, "fresh human correction saves after recognition");
    } finally {
      releaseNative.open(); releaseWrite.open();
      await Promise.allSettled([retry, stale, fresh].filter(Boolean));
      db.run = run;
    }
    assert.equal(nativeCalls, 1);
    const corrected = (await studentCorrection(current, exam.id, student.id)).pages[0];
    assert.deepEqual(corrected.recognition.questions[0].selectedOptions, ["B"]);
    assert.equal(corrected.recognition.subjectiveQuestions?.[0].score, 20);
    const raw = (await store.getScanRecordWithResult(record.id))!.recognition!;
    assert.deepEqual(JSON.parse(raw.objective_json!)[0].selectedOptions, ["B"], "raw OCR agrees with the human snapshot");
    assert.equal(JSON.parse(raw.subjective_json!)[0].score, 20);
    assert.equal(Number((await db.get<{ total_score: number }>("SELECT total_score FROM student_scores WHERE exam_id=? AND student_id=?", exam.id, student.id))!.total_score), 20);

    // Reverse ordering: a queued teacher save publishes an authoritative result
    // before retry runs. Retry must refuse before calling the recognizer.
    await db.run("UPDATE exams SET score_published=1 WHERE id=?", exam.id);
    const held = gate(), release = gate();
    const blocker = enqueueScannerSubmission(async () => { held.open(); await release.promise; });
    await held.promise;
    const teacher = saveStudentCorrection(current, exam.id, student.id, [{ sourceId: corrected.sourceId, revision: corrected.revision,
      selected: toggleCorrectionCell(current, corrected, corrected.selected, cells.find(c => c.type === "objective_option" && c.option === "A")!.id) }], student.id);
    const refused = runOcrOnSession(session.id, card.id, () => {}, { recordIds: new Set([record.id]) }, async () => {
      throw new Error("published original must never reach native recognition");
    });
    release.open(); await blocker; await teacher;
    const beforeRefusal = JSON.stringify(await db.get("SELECT * FROM scan_correction_pages WHERE source_id=?", record.id));
    await refused;
    assert.equal(JSON.stringify(await db.get("SELECT * FROM scan_correction_pages WHERE source_id=?", record.id)), beforeRefusal);
    assert.equal(Number((await db.get<{ total_score: number }>("SELECT total_score FROM student_scores WHERE exam_id=? AND student_id=?", exam.id, student.id))!.total_score), 25);

    // Correct a withdrawn original while a real HTTP retry waits for its
    // eligibility preview. It must see the saved receipt, never the intermediate
    // corrected-but-pending state between snapshot commit and grade admission.
    await db.run("UPDATE exams SET score_published=0 WHERE id=?", exam.id);
    assert.equal(await db.get("SELECT id FROM exam_publish_events WHERE exam_id=?", exam.id), null);
    async function makeAttempt(name: string) {
      const attempt = await store.createSession(card.id, name);
      await db.run("UPDATE twain_scan_sessions SET status='completed',card_version=?,version_source='upload' WHERE id=?", cardFingerprint(current), attempt.id);
      const pageRecord = await store.createScanRecord({ sessionId: attempt.id, cardId: card.id, pageNum: 1, imagePath });
      const result = structuredClone(recognition);
      result.studentId = { status: "ok", value: "91002" };
      await db.run("UPDATE twain_scan_records SET identity_json=?,student_id='91002',ocr_status='done' WHERE id=?", JSON.stringify(identity), pageRecord.id);
      await store.upsertRecognitionResult({ scanRecordId: pageRecord.id, objectiveJson: JSON.stringify(result.questions), subjectiveJson: JSON.stringify(result.subjectiveQuestions) });
      await storeCorrectionPage(current, "twain_scan_record", pageRecord.id, result);
      await processScannerSession(current, attempt.id, "save");
      return { session: attempt, record: pageRecord };
    }
    const original = await makeAttempt("admission original");
    const duplicate = await makeAttempt("admission duplicate");
    const duplicatePage = (await sessionCorrection(current, duplicate.session.id, "0", false)).pages[0];
    const digit3 = cells.find(c => c.type === "student_digit" && c.digitIndex === 4 && c.digit === 3)!;
    assert.equal((await saveSessionCorrection(current, duplicate.session.id, "0", [{ sourceId: duplicatePage.sourceId,
      revision: duplicatePage.revision, selected: toggleCorrectionCell(current, duplicatePage, duplicatePage.selected, digit3.id) }], student.id)).saved, true);
    const originalPage = (await sessionCorrection(current, original.session.id, "0", false)).pages[0];
    const { default: express } = await import("express");
    const { createScannerRouter } = await import("../src/apps/answer-card/server/scanner");
    const { makeScannerAuth } = await import("../src/server/middleware/scanner-auth");
    const app = express(); app.use(express.json()); app.use("/api/scanner", makeScannerAuth(true), createScannerRouter(true));
    const http = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => http.once("listening", resolve));
    const correctionWritten = gate(), releaseCorrection = gate(), retryRead = gate();
    const transaction = db.transaction.bind(db), all = db.all.bind(db);
    let pauseCorrection = true;
    db.transaction = work => transaction(async tx => {
      let writesOriginal = false;
      const instrumented = new Proxy(tx, { get(target, key) {
        if (key === "run") return async (sql: string, ...params: unknown[]) => {
          if (sql.includes("SET student_id=?,ocr_status='review'") && params.includes(original.record.id)) writesOriginal = true;
          return target.run(sql, ...params);
        };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      } });
      const result = await work(instrumented);
      if (writesOriginal && pauseCorrection) {
        pauseCorrection = false; correctionWritten.open(); await releaseCorrection.promise;
      }
      return result;
    });
    db.all = async (sql, ...params) => {
      const rows = await all(sql, ...params);
      if (!pauseCorrection && sql.includes("SELECT r.*, s.identity_mode") && params.includes(original.session.id)) retryRead.open();
      return rows;
    };
    const correction = saveSessionCorrection(current, original.session.id, "0", [edit(originalPage)], student.id);
    void correction.catch(() => {});
    let retryRequest: Promise<Response> | undefined;
    try {
      await reached(correctionWritten.promise, "correction snapshots written before commit");
      retryRequest = fetch(`http://127.0.0.1:${(http.address() as { port: number }).port}/api/scanner/session/${original.session.id}/retry`, {
        method: "POST", headers: { "Content-Type": "application/json", "X-Api-Key": info.key }, body: JSON.stringify({ groupId: "0" }),
      });
      await reached(Promise.race([retryRead.promise, retryRequest.then(async response => {
        throw new Error(`Retry returned before reaching preview: ${response.status} ${await response.clone().text()}`);
      })]), "HTTP retry reaches the eligibility preview");
      // Let the route enqueue its preview while the correction still owns the queue.
      await new Promise<void>(resolve => setImmediate(resolve));
      releaseCorrection.open();
      await reached(correction, "correction and admission complete in one queue turn");
      assert.equal((await correction).saved, true);
      await reached(retryRequest, "queued HTTP retry completes");
      const response = await retryRequest;
      assert.equal(response.status, 409, "retry preview must observe completed admission and reject retry eligibility");
      assert.match((await response.json() as { message: string }).message, /未失败/);
      const originalStudent = (await db.get<{ id: number }>("SELECT id FROM users WHERE student_number='91002'"))!;
      assert.equal(Number((await db.get<{ total_score: number }>("SELECT total_score FROM student_scores WHERE exam_id=? AND student_id=?", exam.id, originalStudent.id))!.total_score), 20);
      const admitted = (await studentCorrection(current, exam.id, originalStudent.id)).pages[0];
      assert.deepEqual(admitted.recognition.questions[0].selectedOptions, ["B"]);
      assert.equal(admitted.recognition.subjectiveQuestions?.[0].score, 20);
      assert.equal((await db.get<{ state: string }>("SELECT state FROM scanner_submissions WHERE session_id=? AND group_id='0'", original.session.id))!.state, "saved");
      const originalRaw = (await store.getScanRecordWithResult(original.record.id))!.recognition!;
      assert.deepEqual(JSON.parse(originalRaw.objective_json!)[0].selectedOptions, ["B"]);
      assert.equal(JSON.parse(originalRaw.subjective_json!)[0].score, 20);
      console.log("PASS correction-to-admission handoff: concurrent HTTP retry rejected; corrected snapshot, OCR, receipt and grade preserved");
    } finally {
      releaseCorrection.open();
      await Promise.allSettled([correction, retryRequest].filter(Boolean));
      db.transaction = transaction; db.all = all;
      await new Promise<void>(resolve => http.close(() => resolve()));
    }

    // Failure handling must release the same queue and clear stale recognition.
    const failedSession = await store.createSession(card.id, "failed retry");
    const failedRecord = await store.createScanRecord({ sessionId: failedSession.id, cardId: card.id, pageNum: 1, imagePath });
    await runOcrOnSession(failedSession.id, card.id, () => {}, undefined, async () => { throw new Error("controlled native failure"); });
    assert.equal((await store.getScanRecordWithResult(failedRecord.id))!.ocr_status, "failed");
    await reached(enqueueScannerSubmission(async () => {}), "queue remains usable after native failure");
    console.log(`PASS scanner retry concurrency (${db.dialect}, native=${process.env.PROJECTX_RETRY_TEST_NATIVE === "1"}): in-flight OCR, partial writes, stale drafts, objective/subjective correction, teacher-first refusal and failure recovery`);
  }
} finally { await fixture.close(); }
