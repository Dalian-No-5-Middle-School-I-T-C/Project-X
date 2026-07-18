import { getMysqlDb, buildUpsertSQL } from "../db";
import type { DbAdapter } from "../db";
import { CardRepository } from "../repositories/CardRepository";
import { recomputeExamRankings, roundScore } from "./rankingUpdate";
import {
  listReviewBlockCrops
} from "./AnswerBlockCropService";
import { checkDisputeOnSubmit } from "./ArbitrationService";
import { getBlockConfig } from "./BlockGradingConfigService";
import type {
  ReviewBlockCropItem,
  ReviewBlockSummary,
  ReviewSubmitResult,
  ReviewSubmitScoreInput,
  ReviewTraceItem,
  ReviewRoundDetail
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
  block_type: string | null;
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
  totalObjective = roundScore(totalObjective);
  totalSubjective = roundScore(totalSubjective);
  const newTotal = roundScore(totalObjective + totalSubjective);

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
  let reviewRound = 1;
  let scoreBreakdown: Array<{ round: number; reviewerId: number; score: number; reviewedAt: string }> = [];
  let disputed = false;
  let disputeReason = "";

  await db.transaction(async (tx) => {
    // 读取已有评审轮次
    const existingCrop = await tx.get(
      "SELECT review_round, score_breakdown FROM answer_block_crops WHERE id = ?",
      params.cropId
    ) as { review_round: number; score_breakdown: string | null } | undefined;
    if (existingCrop) {
      reviewRound = (existingCrop.review_round ?? 0) + 1;
      if (existingCrop.score_breakdown) {
        try { scoreBreakdown = JSON.parse(existingCrop.score_breakdown); } catch { /* ignore */ }
      }
    }

    // 计算本轮总分
    for (const item of params.scores) {
      const maxScore = item.maxScore ?? maxScoreByQuestion.get(item.questionNumber) ?? item.score;
      const clampedScore = Math.max(0, Math.min(maxScore, item.score));
      totalScore += clampedScore;
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

    // 记录本轮评审
    scoreBreakdown.push({ round: reviewRound, reviewerId: params.userId, score: totalScore, reviewedAt: now });

    totalScore = await recomputeStudentTotals(tx, params.examId, crop.student_id!, params.userId, now);

    // 更新 answer_block_crops — CAS 检测防止并发覆盖
    const result = await tx.run(
      `UPDATE answer_block_crops
       SET status = ?, reviewer_id = ?, reviewed_at = ?, review_round = ?,
           score_breakdown = ?
       WHERE id = ? AND review_round = ?`,
      nextStatus,
      params.userId,
      now,
      reviewRound,
      JSON.stringify(scoreBreakdown),
      params.cropId,
      existingCrop?.review_round ?? 0
    );

    if (result.changes === 0) {
      throw new Error("该切块已被其他老师批阅，请刷新后重试");
    }
  });

  await recomputeExamRankings(db, params.examId);

  // 检测争议
  const blockType = crop.block_type ?? "subjective";
  const maxBlockScore = Array.from(maxScoreByQuestion.values()).reduce((a, b) => a + b, 0);
  const disputeCheck = await checkDisputeOnSubmit(
    params.examId, params.cropId, totalScore, params.userId,
    blockType, maxBlockScore, db
  );
  disputed = disputeCheck.disputed;
  disputeReason = disputeCheck.reason;

  // 如果争议，更新切块状态
  if (disputed && disputeCheck.arbitratorId) {
    await db.run(
      "UPDATE answer_block_crops SET status = 'disputed' WHERE id = ?",
      params.cropId
    );
  }

  return {
    ok: true,
    cropId: params.cropId,
    status: disputed ? "disputed" : nextStatus,
    totalScore,
    disputed,
    disputeReason,
    reviewRound,
    finalScore: disputeCheck.finalScore
  };
}

/** 获取阅卷溯源数据 */
export async function getReviewTrace(
  examId: number,
  blockId: string | undefined,
  db: DbAdapter = getMysqlDb()
): Promise<ReviewTraceItem[]> {
  let query = `
    SELECT abc.id AS crop_id, abc.student_id, u.name AS student_name,
           u.student_number, abc.block_title, abc.status,
           abc.score_breakdown, abc.final_score,
           arb.name AS resolved_by
    FROM answer_block_crops abc
    JOIN users u ON u.id = abc.student_id
    LEFT JOIN users arb ON arb.id = abc.final_score_by
    WHERE abc.exam_id = ?
  `;
  const params: unknown[] = [examId];

  if (blockId) {
    query += " AND abc.block_id = ?";
    params.push(blockId);
  }

  query += " ORDER BY u.student_number, abc.block_id";
  const rows = await db.all(query, ...params) as Array<{
    crop_id: string;
    student_id: number;
    student_name: string;
    student_number: string | null;
    block_title: string | null;
    status: string;
    score_breakdown: string | null;
    final_score: number | null;
    resolved_by: string | null;
  }>;

  return rows.map((row) => {
    let rounds: ReviewRoundDetail[] = [];
    if (row.score_breakdown) {
      try {
        const breakdown = JSON.parse(row.score_breakdown) as Array<{
          round: number; reviewerId: number; score: number; reviewedAt: string;
        }>;
        rounds = breakdown.map((b) => ({
          round: b.round,
          reviewerId: b.reviewerId,
          reviewerName: `教师${b.reviewerId}`,
          score: b.score,
          reviewedAt: b.reviewedAt
        }));
      } catch { /* ignore */ }
    }

    return {
      cropId: row.crop_id,
      studentId: row.student_id,
      studentName: row.student_name,
      studentNumber: row.student_number ?? "",
      blockTitle: row.block_title ?? "",
      rounds,
      finalScore: row.final_score,
      resolvedBy: row.resolved_by,
      status: row.status
    };
  });
}
