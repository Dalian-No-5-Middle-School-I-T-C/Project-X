import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getScanRecordWithResult } from "../database/scan-store";
import { loadCorrectionPage } from "../../../../server/services/scanCorrection";
import { getMysqlDb } from "../../../../server/db";
import { isInsideDir } from "../../../../server/services/AnswerBlockCropService";
import type { ScanPageScope } from "../../../../server/middleware/scanner-scope";
import { findCardForLayout } from "../card-layout";
import { cardFingerprint } from "../../../../shared/cardVersion";
import { buildLayout } from "../../../../shared/layout";
import { blockCropsDir } from "../storage";
import type { AnswerCard, CombinedRecognitionResult, PageLayout, RecognitionBlockCrop, Rect } from "../../../../shared/types";

export type ScanUploadCropImage = Omit<RecognitionBlockCrop, "path"> & { dataBase64: string };

export type ScanUploadPayload = CombinedRecognitionResult & { cropImages: ScanUploadCropImage[] };

function expectedCropBlockIds(layout: PageLayout): Set<string> {
  const ids = new Set<string>();
  for (const block of layout.blocks) {
    if (block.type === "subjective" || block.type === "objective") ids.add(block.blockId);
  }
  return ids;
}

function cropsCompleteForLayout(layout: PageLayout, cropImages: ScanUploadCropImage[], rowCount: number): boolean {
  if (cropImages.length !== rowCount || cropImages.length === 0) return false;
  const expected = expectedCropBlockIds(layout);
  if (!expected.size) return false;
  const loaded = new Set(cropImages.map(c => c.blockId));
  for (const blockId of expected) {
    if (!loaded.has(blockId)) return false;
  }
  return true;
}

/** Same block scope as GET /record/:recordId — upload must not leak other teachers' crops or scores. */
export function scopeScanUploadPayload(
  payload: ScanUploadPayload,
  scope: ScanPageScope | null,
  card: AnswerCard | null,
  layoutPage: number,
): ScanUploadPayload {
  if (!scope?.restricted) return payload;
  const blocks = scope.blocks;
  const subjectiveQuestions = (payload.subjectiveQuestions ?? []).filter(q => blocks.has(String(q.blockId ?? "")));
  let questions = payload.questions ?? [];
  if (card) {
    const allowedNumbers = new Set<number>();
    for (const page of buildLayout(card).pages) {
      if (page.pageNumber !== layoutPage) continue;
      for (const block of page.blocks) {
        if (!blocks.has(block.blockId)) continue;
        if (block.type === "objective") {
          for (const item of block.items) allowedNumbers.add(item.questionNumber);
        }
      }
    }
    questions = questions.filter(q => allowedNumbers.has(q.questionNumber));
  } else {
    questions = [];
  }
  const cropImages = payload.cropImages.filter(c => blocks.has(c.blockId));
  return { ...payload, subjectiveQuestions, questions, cropImages };
}

/**
 * Reuse scan-time OMR + persisted block crops for remote upload (no second native run).
 *
 * 这份结果会直接变成正式成绩，所以只允许读「已提交」的那一份：SQLite 是一条连接，
 * 别人 BEGIN..COMMIT 之间的读能撞见未提交（甚至随后回滚）的订正标记与切块。这里不排
 * 扫描提交链（链上可能压着整场 OCR，会把上传拖成串行），改成按连接语义自查：
 *  1) 进函数时这条连接上有事务 → 缓存未命中；
 *  2) 组装完再问一次：期间有事务开过，或快照 revision 已经变了（订正写的就是这一列）
 *     → 同样按未命中处理。
 * 未命中不是失败：扫描端会退回本机重新识别，代价是一次 OMR，而不是一次错判的成绩。
 * MariaDB 走连接池，其它连接只看得到已提交快照，`hasOpenTransaction()` 恒为 false。
 */
export async function resolveScanUploadPayload(recordId: string): Promise<ScanUploadPayload | null> {
  const db = getMysqlDb();
  if (db.hasOpenTransaction?.()) return null;
  const record = await getScanRecordWithResult(recordId);
  if (!record?.recognition) return null;
  if (record.ocr_status === "pending" || record.ocr_status === "processing" || record.ocr_status === "failed") return null;

  const correction = await loadCorrectionPage("twain_scan_record", recordId, "");
  if (!correction?.recognition?.geometry) return null;

  // 快照里的坐标、题号与切块都是按「当时那版答题卡」算的。版本对不上（含旧库行没有版本）
  // 就不能当成当前卡的识别结果外发：入库口有 R35 版本门兜底，这里先把缓存关掉，
  // 让扫描端按现行版式重新识别，避免出现「按旧版卡识别的分数进了新版卡的正式成绩」。
  const card = await findCardForLayout(record.card_id);
  if (!card) return null;
  if (!correction.cardVersion || correction.cardVersion !== cardFingerprint(card)) return null;

  const recognition = { ...correction.recognition } as CombinedRecognitionResult;
  if (!recognition.studentId?.value && record.student_id) {
    recognition.studentId = { status: "ok", value: record.student_id };
  }
  if (recognition.status !== "ok" && recognition.status !== "partial") {
    recognition.status = record.ocr_status === "review" ? "partial" : "ok";
  }

  type CropRow = {
    block_id: string;
    block_title: string | null;
    block_type: string;
    page_number: number;
    segment_index: number;
    question_numbers: string;
    rect_json: string;
    image_path: string;
    width_px: number;
    height_px: number;
    dpi: number;
  };
  const rows = await getMysqlDb().all<CropRow>(
    `SELECT block_id, block_title, block_type, page_number, segment_index, question_numbers, rect_json, image_path, width_px, height_px, dpi
     FROM answer_block_crops WHERE source_type = 'twain_scan_record' AND source_record_id = ?
     ORDER BY page_number, segment_index, block_id`,
    recordId,
  );
  const cropBase = path.resolve(blockCropsDir);
  const cropImages: ScanUploadCropImage[] = [];
  for (const row of rows) {
    const imagePath = path.resolve(row.image_path);
    if (!existsSync(imagePath) || !isInsideDir(cropBase, imagePath)) continue;
    let questionNumbers: Array<number | string>;
    try {
      questionNumbers = JSON.parse(row.question_numbers) as Array<number | string>;
    } catch {
      continue;
    }
    let rect: Rect;
    try {
      rect = JSON.parse(row.rect_json) as Rect;
    } catch {
      continue;
    }
    cropImages.push({
      blockId: row.block_id,
      blockTitle: row.block_title ?? "",
      blockType: row.block_type,
      pageNumber: row.page_number,
      segmentIndex: row.segment_index,
      questionNumbers,
      rect,
      widthPx: row.width_px,
      heightPx: row.height_px,
      dpi: row.dpi,
      dataBase64: (await readFile(imagePath)).toString("base64"),
    });
  }

  // Incomplete or missing persisted crops → cache miss; client re-runs native recognition with includeCrops.
  if (!cropsCompleteForLayout(correction.layout, cropImages, rows.length)) return null;
  // 组装这份 payload 期间，如果有写事务开过（订正重写快照会 bump revision），前面读到的行
  // 与刚读出来的切块文件就可能分属两个状态；事务还正开着则更直接——读到的可能是未提交数据。
  // 两种情况都按未命中处理，让扫描端重新识别，别把一次撕裂的中间态送进正式成绩。
  if (db.hasOpenTransaction?.()) return null;
  const settled = await db.get<{ revision: number }>(
    "SELECT revision FROM scan_correction_pages WHERE source_type='twain_scan_record' AND source_id=?", recordId);
  if (Number(settled?.revision) !== Number(correction.revision)) return null;
  return { ...recognition, cropImages };
}
