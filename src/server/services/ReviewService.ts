import { getMysqlDb, buildUpsertSQL } from "../db";
import type { DbAdapter } from "../db";
import { CardRepository } from "../repositories/CardRepository";
import { AssignedScoreService } from "./AssignedScoreService";
import {
  listReviewBlockCrops
} from "./AnswerBlockCropService";
import type {
  ReviewBlockCropItem,
  ReviewBlockSummary,
  ReviewSubmitResult,
  ReviewSubmitScoreInput
} from "../../shared/types";
import { objectiveQuestionDefinitions } from "../../shared/grading";

type CropRow = {
  id: string;
  card_id: string;
  exam_id: number | null;
  student_id: number | null;
  student_number: string | null;
  block_id: string;
  block_title: string | null;
  status: string | null;
};

async function recomputeStudentTotals(
  tx: DbAdapter,
  examId: number,
  studentId: number,
  userId: number,
  now: string
): Promise<number> {
  const rows = await tx.all(
    "SELECT score, score_type FROM question_scores WHERE exam_id = ? AND student_id = ?",
    examId,
    studentId
  ) as Array<{ score: number; score_type: string }>;

  let totalObjective = 0;
  let totalSubjective = 0;
  for (const row of rows) {
    if (row.score_type === "objective") totalObjective += Number(row.score ?? 0);
    else totalSubjective += Number(row.score ?? 0);
  }
  const newTotal = totalObjective + totalSubjective;

  await tx.run(
    `UPDATE student_scores
     SET objective_score = ?, subjective_score = ?, total_score = ?,
         manually_modified = 1, modified_by = ?, modified_at = ?
     WHERE exam_id = ? AND student_id = ?`,
    totalObjective,
    totalSubjective,
    newTotal,
    userId,
    now,
    examId,
    studentId
  );

  return newTotal;
}

async function recomputeRankings(db: DbAdapter, examId: number): Promise<void> {
  const allStudents = await db.all(
    "SELECT id, total_score FROM student_scores WHERE exam_id = ? ORDER BY total_score DESC",
    examId
  ) as Array<{ id: number; total_score: number }>;
  if (allStudents.length === 0) return;

  const n = allStudents.length;
  for (let i = 0; i < allStudents.length; i += 1) {
    const rank = i + 1;
    const percentile = n > 1 ? Math.round((1 - i / n) * 1000) / 10 : 100;
    await db.run(
      "UPDATE student_scores SET `rank` = ?, percentile = ? WHERE id = ?",
      rank,
      percentile,
      allStudents[i].id
    );
  }

  try {
    const assignedService = new AssignedScoreService();
    await assignedService.recalculateAll(examId);
  } catch {
    // optional assigned score
  }
}

export async function listReviewBlocks(examId: number, db: DbAdapter = getMysqlDb()): Promise<ReviewBlockSummary[]> {
  const rows = await db.all(
    `SELECT
       abc.block_id AS blockId,
       MAX(abc.block_title) AS blockTitle,
       MAX(abc.block_type) AS blockType,
       COUNT(*) AS totalCount,
       SUM(CASE WHEN COALESCE(abc.status, 'ready') IN ('ready', 'pending') THEN 1 ELSE 0 END) AS pendingCount,
       SUM(CASE WHEN abc.status = 'reviewed' THEN 1 ELSE 0 END) AS reviewedCount
     FROM answer_block_crops abc
     WHERE abc.exam_id = ?
     GROUP BY abc.block_id
     ORDER BY abc.block_id`,
    examId
  ) as Array<{
    blockId: string;
    blockTitle: string | null;
    blockType: string;
    totalCount: number;
    pendingCount: number;
    reviewedCount: number;
  }>;

  return rows.map((row) => ({
    blockId: row.blockId,
    blockTitle: row.blockTitle ?? row.blockId,
    blockType: row.blockType,
    totalCount: Number(row.totalCount),
    pendingCount: Number(row.pendingCount),
    reviewedCount: Number(row.reviewedCount)
  }));
}

export async function listReviewBlockCropItems(
  params: { examId: number; blockId?: string; classId?: number; status?: string },
  db: DbAdapter = getMysqlDb()
): Promise<ReviewBlockCropItem[]> {
  const crops = await listReviewBlockCrops(params, db);
  if (crops.length === 0) return [];

  const studentIds = Array.from(new Set(crops.map((crop) => crop.studentId).filter((id): id is number => id != null)));
  const nameById = new Map<number, string>();
  for (const studentId of studentIds) {
    const row = await db.get("SELECT name FROM users WHERE id = ?", studentId) as { name: string } | undefined;
    if (row) nameById.set(studentId, row.name);
  }

  return crops.map((crop) => ({
    ...crop,
    studentName: crop.studentId != null ? (nameById.get(crop.studentId) ?? null) : null
  }));
}

export async function submitReviewCropScores(params: {
  examId: number;
  cropId: string;
  scores: ReviewSubmitScoreInput[];
  status?: string;
  userId: number;
}, db: DbAdapter = getMysqlDb()): Promise<ReviewSubmitResult> {
  const crop = await db.get(
    "SELECT * FROM answer_block_crops WHERE id = ? AND exam_id = ?",
    params.cropId,
    params.examId
  ) as CropRow | undefined;
  if (!crop) throw new Error("作答切块不存在");
  if (!crop.student_id) throw new Error("该切块未关联学生，无法阅卷");

  const exam = await db.get("SELECT card_id FROM exams WHERE id = ?", params.examId) as { card_id: string | null } | undefined;
  if (!exam?.card_id) throw new Error("考试未关联答题卡");

  const cardRepo = new CardRepository();
  const card = await cardRepo.findById(exam.card_id);
  if (!card) throw new Error("答题卡不存在");

  const maxScoreByQuestion = new Map<number, number>();
  for (const block of card.bodyBlocks) {
    if (block.type === "objective") {
      for (const def of objectiveQuestionDefinitions(block)) {
        maxScoreByQuestion.set(def.questionNumber, Number(def.score ?? 0));
      }
    } else if (block.type === "subjective") {
      for (const question of block.questions ?? []) {
        const qNum = typeof question.number === "number" ? question.number : parseInt(String(question.number), 10);
        if (Number.isFinite(qNum)) maxScoreByQuestion.set(qNum, Number(question.score ?? 0));
      }
    }
  }

  const now = new Date().toISOString();
  const nextStatus = params.status ?? "reviewed";
  const upsertCols = [
    "exam_id", "student_id", "question_number", "question_id", "block_id",
    "score", "max_score", "score_type", "manually_modified", "modified_by", "modified_at"
  ];
  const conflictCols = ["exam_id", "student_id", "question_number", "score_type"];
  const updateCols = ["score", "max_score", "manually_modified", "modified_by", "modified_at", "block_id"];
  const upsertSQL = buildUpsertSQL(db.dialect, "question_scores", upsertCols, conflictCols, updateCols);

  let totalScore = 0;
  await db.transaction(async (tx) => {
    for (const item of params.scores) {
      const maxScore = item.maxScore ?? maxScoreByQuestion.get(item.questionNumber) ?? item.score;
      const clampedScore = Math.max(0, Math.min(maxScore, item.score));
      await tx.run(
        upsertSQL,
        params.examId,
        crop.student_id,
        item.questionNumber,
        null,
        crop.block_id,
        clampedScore,
        maxScore,
        item.scoreType,
        1,
        params.userId,
        now
      );
      await tx.run(
        `INSERT INTO answer_overrides (exam_id, card_id, question_number, score_type, override_type, old_value, new_value, created_by, created_at)
         VALUES (?, ?, ?, ?, 'review_score', NULL, ?, ?, ?)`,
        params.examId,
        exam.card_id,
        item.questionNumber,
        item.scoreType,
        JSON.stringify(clampedScore),
        params.userId,
        now
      );
    }

    totalScore = await recomputeStudentTotals(tx, params.examId, crop.student_id!, params.userId, now);
    await tx.run(
      "UPDATE answer_block_crops SET status = ? WHERE id = ?",
      nextStatus,
      params.cropId
    );
  });

  await recomputeRankings(db, params.examId);

  return {
    ok: true,
    cropId: params.cropId,
    status: nextStatus,
    totalScore
  };
}
