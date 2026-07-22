import { getMysqlDb, buildUpsertSQL } from "../db";
import type { DbAdapter } from "../db";
import { CardRepository } from "../repositories/CardRepository";
import { recomputeExamRankings, roundScore } from "./rankingUpdate";
import {
  listReviewBlockCrops
} from "./AnswerBlockCropService";
import { computeMultiReviewResult } from "./ArbitrationService";
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
       SUM(CASE WHEN abc.status = 'reviewed' THEN 1 ELSE 0 END) AS reviewedCount,
       COALESCE(MAX(bgc.has_half_point), 0) AS hasHalfPoint,
       COALESCE((
         SELECT SUM(mx) FROM (
           SELECT MAX(qs2.max_score) AS mx
           FROM question_scores qs2
           WHERE qs2.exam_id = abc.exam_id AND qs2.block_id = abc.block_id
           GROUP BY qs2.question_number
         )
       ), 0) AS maxScore
     FROM answer_block_crops abc
     LEFT JOIN block_grading_config bgc ON bgc.exam_id = abc.exam_id AND bgc.block_id = abc.block_id
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
    hasHalfPoint: number;
    maxScore: number;
  }>;

  return rows.map((row) => ({
    blockId: row.blockId,
    blockTitle: row.blockTitle ?? row.blockId,
    blockType: row.blockType,
    totalCount: Number(row.totalCount),
    pendingCount: Number(row.pendingCount),
    reviewedCount: Number(row.reviewedCount),
    hasHalfPoint: Number(row.hasHalfPoint ?? 0),
    maxScore: Number(row.maxScore ?? 0)
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

  // 读取评分配置（含 reviewMode）
  const blockType = crop.block_type ?? "subjective";
  let maxBlockScore = 0;
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
  maxBlockScore = Array.from(maxScoreByQuestion.values()).reduce((a, b) => a + b, 0);

  const config = await getBlockConfig(params.examId, crop.block_id ?? "", blockType, maxBlockScore, db);
  const reviewMode = config.reviewMode;

  const now = new Date().toISOString();
  const upsertCols = [
    "exam_id", "student_id", "question_number", "question_id", "block_id",
    "score", "max_score", "score_type", "manually_modified", "modified_by", "modified_at"
  ];
  const conflictCols = ["exam_id", "student_id", "question_number", "score_type"];
  const updateCols = ["score", "max_score", "manually_modified", "modified_by", "modified_at", "block_id"];
  const upsertSQL = buildUpsertSQL(db.dialect, "question_scores", upsertCols, conflictCols, updateCols);

  const submittedScores = params.scores.map((item) => {
    const maxScore = item.maxScore ?? maxScoreByQuestion.get(item.questionNumber) ?? item.score;
    return { ...item, maxScore, score: Math.max(0, Math.min(maxScore, item.score)) };
  });
  let totalScore = 0;
  let finalReviewRound = 0;
  let scoreBreakdown: Array<{ round: number; reviewerId: number; score: number; reviewedAt: string; questionScores: Record<string, number> }> = [];
  let disputed = false;
  let disputeReason = "";
  let finalScore: number | null = null;

  // P0-2: 争议检测 + 状态更新全部在事务内执行
  await db.transaction(async (tx) => {
    // 评分历史必须在事务内读取和追加；事务外快照会在并发提交时覆盖另一位教师的记录。
    const freshCrop = await tx.get(
      "SELECT review_round, score_breakdown, status FROM answer_block_crops WHERE id = ?",
      params.cropId
    ) as { review_round: number; score_breakdown: string | null; status: string | null } | undefined;
    const currentRound = freshCrop?.review_round ?? 0;
    if (!freshCrop) throw new Error("作答切块不存在");
    try { scoreBreakdown = freshCrop.score_breakdown ? JSON.parse(freshCrop.score_breakdown) : []; } catch { scoreBreakdown = []; }

    const reviewerIds = new Set(scoreBreakdown.map((b) => b.reviewerId));
    if (reviewerIds.has(params.userId)) throw new Error("您已对该题块评分，请勿重复提交");
    if (config.arbitratorId != null && config.arbitratorId === params.userId) throw new Error("您是该题块的仲裁人，不能参与初评");
    if (config.arbitratorId != null && reviewerIds.has(config.arbitratorId)) throw new Error("该题块的仲裁人已参与评分，需要更换仲裁人");

    // 争议卷被自动改派给第 3 位教师后，允许其提交追加的一轮复评
    const isDisputedRereview = freshCrop.status === "disputed" && !reviewerIds.has(params.userId);
    if ((scoreBreakdown.length >= reviewMode || currentRound >= reviewMode) && !isDisputedRereview) {
      throw new Error("该题块已达到评分上限，请刷新后重试");
    }

    totalScore = submittedScores.reduce((sum, item) => sum + item.score, 0);
    finalReviewRound = currentRound + 1;
    const questionScores = Object.fromEntries(submittedScores.map((item) => [String(item.questionNumber), item.score]));

    scoreBreakdown.push({ round: finalReviewRound, reviewerId: params.userId, score: totalScore, reviewedAt: now, questionScores });

    // 仅在所有轮次完成且无争议后才写正式分数，避免最后一评的分数提前影响排名。
    if (scoreBreakdown.length >= reviewMode) {
      const allScores = scoreBreakdown.map((b) => b.score);
      const disputeResult = computeMultiReviewResult(allScores, config.disputeThreshold, config.rounding);
      disputed = disputeResult.disputed;
      disputeReason = disputeResult.reason;
      if (!disputed) {
        finalScore = disputeResult.finalScore;
        const resolvedQuestionScores: Array<{ item: typeof submittedScores[number]; score: number }> = [];
        for (const item of submittedScores) {
          const values = scoreBreakdown.map((round) => round.questionScores?.[String(item.questionNumber)]).filter((v): v is number => typeof v === "number");
          if (values.length !== scoreBreakdown.length) throw new Error("历史评审缺少逐题分数，无法安全合并，请转仲裁处理");
          const resolved = computeMultiReviewResult(values, config.disputeThreshold, config.rounding);
          if (resolved.disputed || resolved.finalScore == null) {
            disputed = true;
            disputeReason = `第${item.questionNumber}题${resolved.reason}`;
            finalScore = null;
            break;
          }
          resolvedQuestionScores.push({ item, score: resolved.finalScore });
        }
        // Do not persist a partial set if a later question is disputed.
        if (!disputed) {
          for (const resolved of resolvedQuestionScores) {
            await tx.run(upsertSQL, params.examId, crop.student_id, resolved.item.questionNumber, null, crop.block_id, resolved.score, resolved.item.maxScore, resolved.item.scoreType, 1, params.userId, now);
          }
        }
        if (!disputed) totalScore = await recomputeStudentTotals(tx, params.examId, crop.student_id!, params.userId, now);
      }
    }

    // 确定下一状态
    const nextStatus = scoreBreakdown.length >= reviewMode
      ? (params.status ?? "reviewed")
      : "pending";

    // CAS 更新 — 防止并发覆盖
    const result = await tx.run(
      `UPDATE answer_block_crops
       SET status = ?, reviewer_id = ?, reviewed_at = ?, review_round = ?,
           score_breakdown = ?
       WHERE id = ? AND review_round = ?`,
      nextStatus,
      params.userId,
      now,
      finalReviewRound,
      JSON.stringify(scoreBreakdown),
      params.cropId,
      currentRound
    );

    if (result.changes === 0) {
      throw new Error("该切块已被其他老师批阅，请刷新后重试");
    }

    if (scoreBreakdown.length >= reviewMode) {
      if (disputed) {
        await tx.run("UPDATE answer_block_crops SET status = ? WHERE id = ?", "disputed", params.cropId);
        // 无仲裁人时，把争议卷自动改派给一位「已分配本题块且未评过该生」的教师（工作量均衡/加评）
        await autoAssignDisputedCrop(params.examId, crop.block_id ?? "", params.cropId, reviewerIds, tx);
      } else if (finalScore != null) {
        await tx.run(
          "UPDATE answer_block_crops SET final_score = ?, status = ? WHERE id = ?",
          finalScore,
          "reviewed",
          params.cropId
        );
      }
    }
  });

  // 排名重算在事务外（调用方应处理失败）
  await recomputeExamRankings(db, params.examId);

  return {
    ok: true,
    cropId: params.cropId,
    status: disputed ? "disputed" : (scoreBreakdown.length >= reviewMode ? "reviewed" : "pending"),
    totalScore,
    disputed,
    disputeReason,
    reviewRound: finalReviewRound,
    finalScore
  };
}

/**
 * 无仲裁人时，把争议卷自动改派给一位「已分配本题块且尚未评过该生」的教师，
 * 追加其到该教师的待批队列（auto_assigned=1），使其进度条加卷并可提交追加复评。
 * 若已分配教师都已评过该生（无可改派对象），则保持 disputed 进入人工争议池兜底。
 */
async function autoAssignDisputedCrop(
  examId: number,
  blockId: string,
  cropId: string,
  excludeReviewerIds: Set<number>,
  db: DbAdapter
): Promise<void> {
  const config = await getBlockConfig(examId, blockId, "answer", 0, db);
  if (config.arbitratorId != null || config.autoReassignNoArb !== 1) return;

  const crop = await db.get(
    "SELECT student_id FROM answer_block_crops WHERE id = ? AND exam_id = ?",
    cropId,
    examId
  ) as { student_id: number | null } | undefined;
  if (!crop?.student_id) return;

  const assignments = await db.all(
    "SELECT id, teacher_id, assigned_student_ids, auto_assigned FROM review_assignments WHERE exam_id = ? AND block_id = ?",
    examId,
    blockId
  ) as Array<{ id: number; teacher_id: number; assigned_student_ids: string | null; auto_assigned: number | null }>;

  const eligible = assignments.filter((a) => {
    if (excludeReviewerIds.has(a.teacher_id)) return false;
    const ids = a.assigned_student_ids ? (JSON.parse(a.assigned_student_ids) as number[]) : [];
    return !ids.includes(crop.student_id!);
  });
  if (eligible.length === 0) return; // 无合格教师 → 争议池兜底

  const target = eligible.reduce((a, b) =>
    (JSON.parse(a.assigned_student_ids ?? "[]") as number[]).length <=
    (JSON.parse(b.assigned_student_ids ?? "[]") as number[]).length
      ? a
      : b
  );
  const ids = [...(JSON.parse(target.assigned_student_ids ?? "[]") as number[]), crop.student_id];
  await db.run(
    "UPDATE review_assignments SET assigned_student_ids = ?, student_count = ?, auto_assigned = 1 WHERE id = ?",
    JSON.stringify(ids),
    ids.length,
    target.id
  );
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
