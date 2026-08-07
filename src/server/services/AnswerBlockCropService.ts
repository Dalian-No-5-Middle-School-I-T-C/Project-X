import { existsSync } from "node:fs";
import { copyFile, mkdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getMysqlDb } from "../db";
import type { DbAdapter } from "../db";
import { blockCropsDir, safeId } from "../../apps/answer-card/server/storage";
import type { AnswerBlockCrop, AnswerBlockCropSourceType, RecognitionBlockCrop, Rect } from "../../shared/types";
import { CardRepository } from "../repositories/CardRepository";
import { objectiveQuestionDefinitions } from "../../shared/grading";
import type { AnswerCard } from "../../shared/types";

type CropRow = {
  id: string;
  card_id: string;
  exam_id: number | null;
  student_id: number | null;
  student_number: string | null;
  source_type: AnswerBlockCropSourceType;
  source_record_id: string;
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
  status: string | null;
  score?: number | null;
  max_score?: number | null;
  claimed_by?: number | null;
  claimed_at?: string | null;
  claim_count?: number;
};

export type PersistAnswerBlockCropsParams = {
  cardId: string;
  examId?: number | null;
  studentId?: number | null;
  studentNumber?: string | null;
  sourceType: AnswerBlockCropSourceType;
  sourceRecordId: string | number;
  crops?: RecognitionBlockCrop[] | null;
};

function cropImageUrl(id: string): string {
  return `/api/answer-block-crops/${encodeURIComponent(id)}/image`;
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function toAnswerBlockCrop(row: CropRow): AnswerBlockCrop {
  return {
    id: row.id,
    cardId: row.card_id,
    examId: row.exam_id,
    studentId: row.student_id,
    studentNumber: row.student_number,
    sourceType: row.source_type,
    sourceRecordId: row.source_record_id,
    blockId: row.block_id,
    blockTitle: row.block_title ?? "",
    blockType: row.block_type,
    pageNumber: Number(row.page_number),
    segmentIndex: Number(row.segment_index),
    questionNumbers: parseJson<Array<number | string>>(row.question_numbers, []),
    rect: parseJson<Rect>(row.rect_json, { x: 0, y: 0, width: 0, height: 0 }),
    imageUrl: cropImageUrl(row.id),
    widthPx: Number(row.width_px),
    heightPx: Number(row.height_px),
    dpi: Number(row.dpi),
    status: row.status ?? "ready",
    score: row.score ?? null,
    maxScore: row.max_score ?? null,
    claimedBy: row.claimed_by ?? null,
    claimedAt: row.claimed_at ?? null,
    claimCount: row.claim_count ?? 0
  };
}

async function moveCropFile(sourcePath: string, targetPath: string): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true });
  try {
    await rename(sourcePath, targetPath);
  } catch {
    await copyFile(sourcePath, targetPath);
    await unlink(sourcePath).catch(() => {});
  }
}

function targetFileName(crop: RecognitionBlockCrop, index: number): string {
  const block = safeId(crop.blockId) || "block";
  return `p${crop.pageNumber}_s${crop.segmentIndex}_${String(index + 1).padStart(2, "0")}_${block}.png`;
}

export async function persistAnswerBlockCrops(
  params: PersistAnswerBlockCropsParams,
  db: DbAdapter = getMysqlDb()
): Promise<AnswerBlockCrop[]> {
  const crops = params.crops ?? [];
  const sourceRecordId = String(params.sourceRecordId);
  await db.run(
    "DELETE FROM answer_block_crops WHERE source_type = ? AND source_record_id = ?",
    params.sourceType,
    sourceRecordId
  );

  if (crops.length === 0) return [];

  const finalRows: AnswerBlockCrop[] = [];
  const movedPaths: string[] = [];
  const targetDir = path.join(blockCropsDir, safeId(params.cardId), `${params.sourceType}_${safeId(sourceRecordId)}`);
  await mkdir(targetDir, { recursive: true });

  try {
    for (let index = 0; index < crops.length; index += 1) {
      const crop = crops[index];
      if (!crop?.path || !existsSync(crop.path) || !crop.blockId || !Array.isArray(crop.questionNumbers) || crop.questionNumbers.length === 0) {
        continue;
      }

      const id = randomUUID();
      const targetPath = path.join(targetDir, targetFileName(crop, index));
      await moveCropFile(crop.path, targetPath);
      movedPaths.push(targetPath);

      await db.run(
        `INSERT INTO answer_block_crops (
          id, card_id, exam_id, student_id, student_number, source_type, source_record_id,
          block_id, block_title, block_type, page_number, segment_index,
          question_numbers, rect_json, image_path, width_px, height_px, dpi, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        params.cardId,
        params.examId ?? null,
        params.studentId ?? null,
        params.studentNumber ?? null,
        params.sourceType,
        sourceRecordId,
        crop.blockId,
        crop.blockTitle ?? "",
        crop.blockType,
        crop.pageNumber,
        crop.segmentIndex,
        JSON.stringify(crop.questionNumbers),
        JSON.stringify(crop.rect),
        targetPath,
        crop.widthPx,
        crop.heightPx,
        crop.dpi,
        "ready"
      );

      finalRows.push(toAnswerBlockCrop({
        id,
        card_id: params.cardId,
        exam_id: params.examId ?? null,
        student_id: params.studentId ?? null,
        student_number: params.studentNumber ?? null,
        source_type: params.sourceType,
        source_record_id: sourceRecordId,
        block_id: crop.blockId,
        block_title: crop.blockTitle ?? "",
        block_type: crop.blockType,
        page_number: crop.pageNumber,
        segment_index: crop.segmentIndex,
        question_numbers: JSON.stringify(crop.questionNumbers),
        rect_json: JSON.stringify(crop.rect),
        image_path: targetPath,
        width_px: crop.widthPx,
        height_px: crop.heightPx,
        dpi: crop.dpi,
        status: "ready"
      }));
    }
  } catch (error) {
    await Promise.all(movedPaths.map((targetPath) => unlink(targetPath).catch(() => {})));
    throw error;
  }

  return finalRows;
}

export async function getAnswerBlockCropFile(id: string, db: DbAdapter = getMysqlDb()): Promise<string | null> {
  const row = await db.get("SELECT image_path FROM answer_block_crops WHERE id = ?", id) as { image_path: string } | undefined;
  return row?.image_path ?? null;
}

export async function listAnswerBlockCropsForStudent(
  examId: number,
  studentId: number,
  db: DbAdapter = getMysqlDb()
): Promise<AnswerBlockCrop[]> {
  const rows = await db.all(
    `SELECT * FROM answer_block_crops
     WHERE exam_id = ? AND student_id = ?
     ORDER BY page_number, segment_index, block_title`,
    examId,
    studentId
  ) as CropRow[];
  return withQuestionScores(rows, examId, db);
}

export async function listReviewBlockCrops(
  params: { examId: number; blockId?: string; classId?: number; status?: string; cropId?: string },
  db: DbAdapter = getMysqlDb()
): Promise<AnswerBlockCrop[]> {
  const filters = ["abc.exam_id = ?"];
  const values: unknown[] = [params.examId];
  if (params.blockId) {
    filters.push("abc.block_id = ?");
    values.push(params.blockId);
  }
  if (params.status) {
    filters.push("abc.status = ?");
    values.push(params.status);
  }
  if (params.classId) {
    filters.push("EXISTS (SELECT 1 FROM class_students cs WHERE cs.student_id = abc.student_id AND cs.class_id = ?)");
    values.push(params.classId);
  }
  if (params.cropId) {
    filters.push("abc.id = ?");
    values.push(params.cropId);
  }

  const rows = await db.all(
    `SELECT abc.*
     FROM answer_block_crops abc
     WHERE ${filters.join(" AND ")}
     ORDER BY abc.block_id, abc.student_number, abc.page_number, abc.segment_index`,
    ...values
  ) as CropRow[];
  return withQuestionScores(rows, params.examId, db);
}

/** 读取某考试各题块的 has_half_point，供打分面板判断 0.5 行 */
async function blockHasHalfPointMap(examId: number, db: DbAdapter): Promise<Map<string, number>> {
  const configs = await db.all(
    "SELECT block_id, has_half_point FROM block_grading_config WHERE exam_id = ?",
    examId
  ) as Array<{ block_id: string; has_half_point: number }>;
  const map = new Map<string, number>();
  for (const c of configs) map.set(c.block_id, c.has_half_point ?? 0);
  return map;
}

function blockMaxScoreFromCard(card: AnswerCard): Map<string, number> {
  const map = new Map<string, number>();
  for (const block of card.bodyBlocks) {
    let sum = 0;
    if (block.type === "objective") {
      for (const def of objectiveQuestionDefinitions(block)) sum += Number(def.score ?? 0);
    } else if (block.type === "subjective") {
      for (const q of block.questions ?? []) sum += Number(q.score ?? 0);
    }
    map.set(block.id, sum);
  }
  return map;
}

async function withQuestionScores(rows: CropRow[], examId: number, db: DbAdapter): Promise<AnswerBlockCrop[]> {
  if (rows.length === 0) return [];
  const studentIds = Array.from(new Set(rows.map((row) => row.student_id).filter((id): id is number => id != null)));
  const scoresByStudent = new Map<number, Array<{ question_number: number; score: number | null; max_score: number | null }>>();

  for (const studentId of studentIds) {
    const scores = await db.all(
      "SELECT question_number, score, max_score FROM question_scores WHERE exam_id = ? AND student_id = ?",
      examId,
      studentId
    ) as Array<{ question_number: number; score: number | null; max_score: number | null }>;
    scoresByStudent.set(studentId, scores);
  }

  const halfMap = await blockHasHalfPointMap(examId, db);

  let blockMaxMap: Map<string, number> | null = null;
  try {
    const exam = await db.get("SELECT card_id FROM exams WHERE id = ?", examId) as { card_id: string | null } | undefined;
    if (exam?.card_id) {
      const card = await new CardRepository().findById(exam.card_id);
      if (card) blockMaxMap = blockMaxScoreFromCard(card);
    }
  } catch { /* 题块权威满分缺失时退回历史行为 */ }

  return rows.map((row) => {
    const crop = toAnswerBlockCrop(row);
    crop.hasHalfPoint = halfMap.get(row.block_id) ?? 0;
    const questionSet = new Set(crop.questionNumbers.map((item) => String(item)));
    const scores = row.student_id != null
      ? (scoresByStudent.get(row.student_id) ?? []).filter((score) => questionSet.has(String(score.question_number)))
      : [];
    if (scores.length > 0) {
      crop.score = scores.reduce((sum, score) => sum + Number(score.score ?? 0), 0);
      crop.maxScore = scores.reduce((sum, score) => sum + Number(score.max_score ?? 0), 0);
    } else if (blockMaxMap) {
      crop.maxScore = blockMaxMap.get(row.block_id) ?? crop.maxScore ?? 0;
    }
    return crop;
  });
}
