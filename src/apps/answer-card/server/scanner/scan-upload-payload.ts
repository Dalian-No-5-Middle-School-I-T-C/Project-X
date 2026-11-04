import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getScanRecordWithResult } from "../database/scan-store";
import { loadCorrectionPage } from "../../../../server/services/scanCorrection";
import { getMysqlDb } from "../../../../server/db";
import { isInsideDir } from "../../../../server/services/AnswerBlockCropService";
import type { ScanPageScope } from "../../../../server/middleware/scanner-scope";
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

/** Reuse scan-time OMR + persisted block crops for remote upload (no second native run). */
export async function resolveScanUploadPayload(recordId: string): Promise<ScanUploadPayload | null> {
  const record = await getScanRecordWithResult(recordId);
  if (!record?.recognition) return null;
  if (record.ocr_status === "pending" || record.ocr_status === "processing" || record.ocr_status === "failed") return null;

  const correction = await loadCorrectionPage("twain_scan_record", recordId, "");
  if (!correction?.recognition?.geometry) return null;

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
  return { ...recognition, cropImages };
}
