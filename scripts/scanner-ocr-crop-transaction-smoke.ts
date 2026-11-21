/** Local OCR relocates block crops before the INSERT transaction and binds BIGINT correction revisions. */
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { startScannerFlowFixture } from "./scanner-upload-flow-fixture";
import { cardFingerprint } from "../src/shared/cardVersion";
import { blockCropsDir, safeId } from "../src/apps/answer-card/server/storage";
import type { CombinedRecognitionResult } from "../src/shared/types";

const fixture = await startScannerFlowFixture();
try {
  const info = await (await fetch(`${fixture.baseUrl}/test/fixture`)).json();
  const { getMysqlDb } = await import("../src/server/db");
  const { CardRepository } = await import("../src/server/repositories/CardRepository");
  const store = await import("../src/apps/answer-card/server/database/scan-store");
  const { runOcrOnSession } = await import("../src/apps/answer-card/server/scanner/scanner-service");
  const { correctionPageRevision } = await import("../src/server/services/scanCorrection");
  const { isInsideDir } = await import("../src/server/services/AnswerBlockCropService");
  const db = getMysqlDb(), repo = new CardRepository();
  const card = (await repo.findById(info.cardId))!;
  const imagePath = path.join(process.env.ANSWER_CARD_DATA_DIR!, "ocr-crop-txn.png");
  await writeFile(imagePath, Buffer.from(info.images.original, "base64"));
  const cropPath = path.join(process.env.ANSWER_CARD_DATA_DIR!, "ocr-crop-txn-block.png");
  await writeFile(cropPath, await sharp({ create: { width: 16, height: 16, channels: 3, background: "#2244aa" } }).png().toBuffer());
  const session = await store.createSession(card.id, "OCR crop staging");
  await db.run("UPDATE twain_scan_sessions SET status='completed',card_version=?,version_source='upload' WHERE id=?", cardFingerprint(card), session.id);
  const record = await store.createScanRecord({ sessionId: session.id, cardId: card.id, pageNum: 1, imagePath });
  const identity = { status: "verified", code: "QR_VERIFIED", cardId: card.id, pageNumber: 1 } as const;
  const recognition: CombinedRecognitionResult = {
    status: "ok", pageNumber: 1, identity,
    geometry: { imageWidth: 2100, imageHeight: 2970, imageToLayout: [.1,0,0,0,.1,0,0,0,1], layoutToImage: [10,0,0,0,10,0,0,0,1] },
    studentId: { status: "ok", value: "91001" },
    questions: [{ questionNumber: 1, selectedOptions: ["A"], confidence: 1 }],
    subjectiveQuestions: [],
    blockCrops: [{
      blockId: "flow_q", blockTitle: "选择题", blockType: "objective", pageNumber: 1, segmentIndex: 0,
      questionNumbers: [1], rect: { x: 0, y: 0, width: 10, height: 10 }, path: cropPath, widthPx: 16, heightPx: 16, dpi: 300,
    }],
  };
  const storageDir = path.join(blockCropsDir, safeId(card.id), `twain_scan_record_${safeId(record.id)}`);
  let stagedBeforeTx = false;
  const transaction = db.transaction.bind(db);
  db.transaction = async work => {
    const files = existsSync(storageDir) ? readdirSync(storageDir).filter(name => name.endsWith(".png")) : [];
    stagedBeforeTx = files.length > 0;
    return transaction(work);
  };
  await runOcrOnSession(session.id, card.id, () => {}, { recordIds: new Set([record.id]) }, async () => structuredClone(recognition));
  db.transaction = transaction;
  assert.equal(stagedBeforeTx, true, "OCR must relocate crop files into storage before the INSERT transaction");
  const revision = await correctionPageRevision("twain_scan_record", record.id, db);
  assert.ok((revision ?? 0) > 2_147_483_647);
  const crop = await db.get<{ image_path: string; correction_revision: number | null }>(
    "SELECT image_path, correction_revision FROM answer_block_crops WHERE source_record_id=?",
    record.id,
  );
  assert.ok(crop?.image_path && isInsideDir(blockCropsDir, crop.image_path));
  assert.equal(Number(crop!.correction_revision), revision);
  console.log(`PASS scanner OCR crop transaction (${db.dialect}): staged files before BEGIN; revision/crop pairing intact`);

  await db.run(
    `INSERT INTO answer_block_crops (
      id, card_id, exam_id, student_id, student_number, source_type, source_record_id,
      block_id, block_title, block_type, page_number, segment_index,
      question_numbers, rect_json, image_path, width_px, height_px, dpi, status, review_round,
      correction_revision
    )
    SELECT 'decoy-crop', card_id, exam_id, student_id, student_number, source_type, source_record_id,
      'decoy_block', block_title, block_type, page_number, segment_index,
      question_numbers, rect_json, image_path, width_px, height_px, dpi, status, review_round, 1
    FROM answer_block_crops WHERE source_record_id = ?`,
    record.id,
  );
  const { sessionCorrection, saveSessionCorrection } = await import("../src/server/services/scanCorrection");
  const document = await sessionCorrection(card, session.id, "0", false);
  const page = document.pages.find((item) => item.sourceId === record.id);
  assert.ok(page, "OCR page must be editable");
  await saveSessionCorrection(card, session.id, "0", [{
    sourceId: page.sourceId, revision: page.revision, selected: page.selected,
  }], null);
  const savedRevision = await correctionPageRevision("twain_scan_record", record.id, db);
  assert.notEqual(savedRevision, revision, "saving a correction must advance the page revision");
  const paired = await db.get<{ correction_revision: number }>(
    "SELECT correction_revision FROM answer_block_crops WHERE source_record_id = ? AND block_id = 'flow_q'",
    record.id,
  );
  const decoy = await db.get<{ correction_revision: number }>(
    "SELECT correction_revision FROM answer_block_crops WHERE id = 'decoy-crop'",
  );
  assert.equal(Number(paired?.correction_revision), savedRevision,
    "mark-only correction must keep the current crops reusable");
  assert.equal(Number(decoy?.correction_revision), 1,
    "crops from another recognition revision must not be stamped onto the new snapshot");
  console.log(`PASS scanner OCR crop transaction (${db.dialect}): teacher correction keeps paired crops and leaves other revisions`);

  const cropFile = crop!.image_path;
  await assert.rejects(db.transaction(async (tx) => {
    const { invalidateScanRecognitionInTransaction } = await import("../src/server/services/scannerSubmissions");
    await invalidateScanRecognitionInTransaction(tx, session.id, record.id);
    throw new Error("rollback invalidate");
  }), /rollback invalidate/);
  assert.equal(existsSync(cropFile), true, "rolled-back invalidate must keep the crop file");
  assert.ok(await db.get("SELECT id FROM answer_block_crops WHERE source_record_id = ? AND block_id = 'flow_q'", record.id));

  const { invalidateScanRecognitionInQueue } = await import("../src/server/services/scannerSubmissions");
  await invalidateScanRecognitionInQueue(session.id, record.id);
  assert.equal(existsSync(cropFile), false, "committed invalidate must remove crop files that no row references");
  assert.equal(await db.get("SELECT id FROM answer_block_crops WHERE source_record_id = ?", record.id), null);
  console.log(`PASS scanner OCR crop transaction (${db.dialect}): invalidate removes crop files only after commit`);
} finally {
  await fixture.close();
}
