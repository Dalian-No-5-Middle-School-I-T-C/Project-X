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
import type {
  AnswerCard,
  CombinedRecognitionResult,
  PageLayout,
  PageRenderBlock,
  RecognitionBlockCrop,
  Rect,
} from "../../../../shared/types";

export type ScanUploadCropImage = Omit<RecognitionBlockCrop, "path"> & { dataBase64: string };

export type ScanUploadPayload = CombinedRecognitionResult & { cropImages: ScanUploadCropImage[]; cardVersion?: string; correctionRevision?: number };

/**
 * Expected croppable segment: mirrors native `block_crops_from_page` in layout_io.cpp
 * (objective: items with valid questionNumber; subjective: questions with valid questionNumber;
 * frameRect preferred over rect; segmentIndex = 1-based index in page croppable list).
 */
export type ExpectedCropSegment = {
  pageNumber: number;
  segmentIndex: number;
  blockId: string;
  /** Sorted unique question numbers as strings (native normalizes via question_number_from_json). */
  questionKey: string;
};

/** Same nonempty check as C++ question_number_from_json → empty strings excluded from crops. */
function validQuestionNumberString(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") {
    const t = raw.trim();
    return t.length ? t : null;
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const s = String(raw).trim();
    return s.length ? s : null;
  }
  return null;
}

/**
 * Build expected segments for one layout page in native iteration order (blocks array order).
 */
export function expectedCropSegmentsForLayoutPage(layout: PageLayout): ExpectedCropSegment[] {
  const segments: ExpectedCropSegment[] = [];
  let segmentIndex = 0;
  for (const block of layout.blocks as PageRenderBlock[]) {
    if (block.type !== "objective" && block.type !== "subjective") continue;

    const nums: string[] = [];
    if (block.type === "objective") {
      for (const item of block.items ?? []) {
        const q = item.questionNumber;
        if (typeof q === "number" && q > 0) nums.push(String(q));
      }
    } else {
      for (const q of block.questions ?? []) {
        const s = validQuestionNumberString(q.questionNumber);
        if (s) nums.push(s);
      }
    }
    if (nums.length === 0) continue;

    const frame = "frameRect" in block && block.frameRect ? block.frameRect : null;
    const fallback = block.rect;
    const cropRect: Rect | undefined = frame ?? fallback;
    if (!cropRect) continue;

    segmentIndex += 1;
    const unique = Array.from(new Set(nums));
    unique.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    segments.push({
      pageNumber: layout.pageNumber,
      segmentIndex,
      blockId: block.blockId,
      questionKey: JSON.stringify(unique),
    });
  }
  return segments;
}

function segmentCompositeKey(segment: ExpectedCropSegment): string {
  return `${segment.pageNumber}|${segment.segmentIndex}|${segment.blockId}|${segment.questionKey}`;
}

type CropSegmentIdentity = {
  pageNumber: number;
  segmentIndex: number;
  blockId: string;
  questionKey: string;
};

function parseQuestionNumbersJson(raw: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: string[] = [];
  for (const el of parsed) {
    if (typeof el !== "string") return null;
    const t = el.trim();
    if (!t.length) return null;
    out.push(t);
  }
  const unique = Array.from(new Set(out));
  unique.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return unique;
}

function identityFromParsedRow(
  pageNumber: number,
  segmentIndex: number,
  blockId: string,
  questionNumbers: string[] | null,
): CropSegmentIdentity | null {
  if (!questionNumbers) return null;
  return {
    pageNumber,
    segmentIndex,
    blockId,
    questionKey: JSON.stringify(questionNumbers),
  };
}

/**
 * Persisted crops match layout when every expected segment has exactly one loaded crop with the same
 * composite key (page + global segmentIndex + blockId + question-number set). Extra DB rows are ignored
 * so non-croppable blocks (e.g. essay grid with no question numbers) do not cause false cache misses.
 */
export function cropsCompleteForLayout(
  layoutPage: PageLayout,
  loadedIdentities: CropSegmentIdentity[],
  dbRowCount: number,
): boolean {
  const expected = expectedCropSegmentsForLayoutPage(layoutPage);
  if (expected.length === 0) return false;

  const loadedByKey = new Map<string, number>();
  for (const id of loadedIdentities) {
    const key = segmentCompositeKey({
      pageNumber: id.pageNumber,
      segmentIndex: id.segmentIndex,
      blockId: id.blockId,
      questionKey: id.questionKey,
    });
    loadedByKey.set(key, (loadedByKey.get(key) ?? 0) + 1);
  }

  for (const segment of expected) {
    const key = segmentCompositeKey(segment);
    if (loadedByKey.get(key) !== 1) return false;
  }

  const expectedKeys = new Set(expected.map(segmentCompositeKey));
  let unmatchedLoaded = 0;
  for (const [key, count] of loadedByKey) {
    if (!expectedKeys.has(key)) unmatchedLoaded += count;
  }
  if (unmatchedLoaded > 0) return false;

  const consumedRows = [...loadedByKey.values()].reduce((a, b) => a + b, 0);
  if (consumedRows !== dbRowCount) return false;

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
  try {
    return await readScanUploadPayload(recordId);
  } catch (error) {
    // 这条路径上任何一步读不通都按「缓存未命中」处理：404 是客户端认识的合法降级信号（回本机
    // 重新识别），而 500 会让整页上传判定成失败。旧卷的 layout_json 解不出来、切块目录被清理等
    // 都属于「这份缓存不能用」，不是设备或数据故障，不该把作业打掉。
    console.warn(`[scanner] upload-payload 读取失败，按缓存未命中处理：${recordId}`, error);
    return null;
  }
}

async function readScanUploadPayload(recordId: string): Promise<ScanUploadPayload | null> {
  const db = getMysqlDb();
  if (db.hasOpenTransaction?.()) return null;
  const record = await getScanRecordWithResult(recordId);
  if (!record?.recognition) return null;
  if (record.ocr_status === "pending" || record.ocr_status === "processing" || record.ocr_status === "failed") return null;
  const recordStudentAtRead = record.student_id ?? null;

  const correction = await loadCorrectionPage("twain_scan_record", recordId, "");
  if (!correction?.recognition?.geometry) return null;

  // 快照里的坐标、题号与切块都是按「当时那版答题卡」算的。版本对不上（含旧库行没有版本）
  // 就不能当成当前卡的识别结果外发：入库口有 R35 版本门兜底，这里先把缓存关掉，
  // 让扫描端按现行版式重新识别，避免出现「按旧版卡识别的分数进了新版卡的正式成绩」。
  const card = await findCardForLayout(record.card_id);
  if (!card) return null;
  if (!correction.cardVersion || correction.cardVersion !== cardFingerprint(card)) return null;

  const layoutPageNumber = correction.layout.pageNumber;

  const recognition = { ...correction.recognition } as CombinedRecognitionResult;
  const correctionStudent = recognition.studentId?.value ? String(recognition.studentId.value) : null;
  // 订正快照与扫描主行可能在不同时刻提交：不能用较早读到的 student_id 覆盖较新的订正学号。
  if (recordStudentAtRead && correctionStudent && recordStudentAtRead !== correctionStudent) return null;
  if (!correctionStudent && recordStudentAtRead) {
    recognition.studentId = { status: "ok", value: recordStudentAtRead };
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
  const rowsAll = await getMysqlDb().all<CropRow>(
    `SELECT block_id, block_title, block_type, page_number, segment_index, question_numbers, rect_json, image_path, width_px, height_px, dpi
     FROM answer_block_crops WHERE source_type = 'twain_scan_record' AND source_record_id = ?
     ORDER BY page_number, segment_index, block_id`,
    recordId,
  );
  // 订正快照只存「这一排版页」的 layout；持久化切块表可能含同一记录关联的其它排版页行。
  // 完整性与缓存命中只校验本页期望段落 ↔ 本页行，避免跨页块凑齐 blockId 集合却漏段。
  const rows = rowsAll.filter(r => Number(r.page_number) === layoutPageNumber);
  const cropBase = path.resolve(blockCropsDir);
  const cropImages: ScanUploadCropImage[] = [];
  const loadedIdentities: CropSegmentIdentity[] = [];
  for (const row of rows) {
    const imagePath = path.resolve(row.image_path);
    if (!existsSync(imagePath) || !isInsideDir(cropBase, imagePath)) continue;
    const questionNumbers = parseQuestionNumbersJson(row.question_numbers);
    if (!questionNumbers) continue;
    let rect: Rect;
    try {
      rect = JSON.parse(row.rect_json) as Rect;
    } catch {
      continue;
    }
    const identity = identityFromParsedRow(
      row.page_number,
      row.segment_index,
      row.block_id,
      questionNumbers,
    );
    if (identity) loadedIdentities.push(identity);
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
  const layoutPage = correction.layout;
  if (!cropsCompleteForLayout(layoutPage, loadedIdentities, rows.length)) return null;
  // 组装这份 payload 期间，如果有写事务开过（订正重写快照会 bump revision），前面读到的行
  // 与刚读出来的切块文件就可能分属两个状态；事务还正开着则更直接——读到的可能是未提交数据。
  // 两种情况都按未命中处理，让扫描端重新识别，别把一次撕裂的中间态送进正式成绩。
  if (db.hasOpenTransaction?.()) return null;
  const settled = await db.get<{ revision: number; recognition_json: string }>(
    "SELECT revision, recognition_json FROM scan_correction_pages WHERE source_type='twain_scan_record' AND source_id=?",
    recordId,
  );
  if (!settled || Number(settled.revision) !== Number(correction.revision)) return null;
  let settledStudent: string | null = null;
  try {
    const parsed = JSON.parse(settled.recognition_json) as { studentId?: { value?: string | null } };
    settledStudent = parsed.studentId?.value ? String(parsed.studentId.value) : null;
  } catch {
    return null;
  }
  if (correctionStudent && settledStudent && correctionStudent !== settledStudent) return null;
  const recordStudentSettled = (await db.get<{ student_id: string | null }>(
    "SELECT student_id FROM twain_scan_records WHERE id = ?", recordId,
  ))?.student_id ?? null;
  if (recordStudentAtRead !== recordStudentSettled) return null;
  const payloadStudent = recognition.studentId?.value ? String(recognition.studentId.value) : null;
  if (recordStudentSettled && payloadStudent && recordStudentSettled !== payloadStudent) return null;
  if (settledStudent && payloadStudent && settledStudent !== payloadStudent) return null;
  return { ...recognition, cropImages, cardVersion: correction.cardVersion, correctionRevision: correction.revision };
}
