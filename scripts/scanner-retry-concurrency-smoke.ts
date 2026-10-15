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
  const { enqueueScannerSubmission } = await import("../src/server/services/scannerSubmissions");
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

    // Failure handling must release the same queue and clear stale recognition.
    const failedSession = await store.createSession(card.id, "failed retry");
    const failedRecord = await store.createScanRecord({ sessionId: failedSession.id, cardId: card.id, pageNum: 1, imagePath });
    await runOcrOnSession(failedSession.id, card.id, () => {}, undefined, async () => { throw new Error("controlled native failure"); });
    assert.equal((await store.getScanRecordWithResult(failedRecord.id))!.ocr_status, "failed");
    await reached(enqueueScannerSubmission(async () => {}), "queue remains usable after native failure");
    console.log(`PASS scanner retry concurrency (${db.dialect}, native=${process.env.PROJECTX_RETRY_TEST_NATIVE === "1"}): in-flight OCR, partial writes, stale drafts, objective/subjective correction, teacher-first refusal and failure recovery`);
  }
} finally { await fixture.close(); }
