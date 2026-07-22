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
  BodyBlock,
  ReviewBlockCropItem,
  ReviewBlockSummary,
  ReviewSubmitResult,
  ReviewSubmitScoreInput,
  ReviewTraceItem,
  ReviewRoundDetail
} from "../../shared/types";
import { objectiveQuestionDefinitions } from "../../shared/grading";

export class ReviewValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewValidationError";
  }
}

type AuthoritativeQuestion = {
  questionNumber: number;
  maxScore: number;
  scoreType: "objective" | "subjective";
};

function buildBlockQuestionMap(block: BodyBlock): Map<number, AuthoritativeQuestion> {
  const map = new Map<number, AuthoritativeQuestion>();
  if (block.type === "objective") {
    for (const def of objectiveQuestionDefinitions(block)) {
      map.set(def.questionNumber, {
        questionNumber: def.questionNumber,
        maxScore: Number(def.score ?? 0),
        scoreType: "objective"
      });
    }
  } else {
    for (const question of block.questions ?? []) {
      const qNum = typeof question.number === "number" ? question.number : parseInt(String(question.number), 10);
      if (Number.isFinite(qNum)) {
        map.set(qNum, { questionNumber: qNum, maxScore: Number(question.score ?? 0), scoreType: "subjective" });
      }
    }
  }
  return map;
}

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

  const targetBlock = card.bodyBlocks.find((b) => b.id === crop.block_id);
  if (!targetBlock) throw new ReviewValidationError("题块配置不存在，无法校验分数");
  const blockQuestionMap = buildBlockQuestionMap(targetBlock);
  if (blockQuestionMap.size === 0) throw new ReviewValidationError("题块未配置题目，无法校验分数");
  if (params.scores.length > blockQuestionMap.size) {
    throw new ReviewValidationError(`分数项数（${params.scores.length}）超过题块题目数（${blockQuestionMap.size}）`);
  }
  for (const item of params.scores) {
    const qNum = Number(item.questionNumber);
    const auth = blockQuestionMap.get(qNum);
    if (!auth) {
      throw new ReviewValidationError(`题号 ${item.questionNumber} 不属于该题块`);
    }
    if (item.scoreType !== auth.scoreType) {
      throw new ReviewValidationError(`题号 ${item.questionNumber} 的题型与题块配置不符`);
    }
    if (item.maxScore != null && Number(item.maxScore) !== auth.maxScore) {
      throw new ReviewValidationError(`题号 ${item.questionNumber} 的满分与服务器配置不一致`);
    }
    const score = Number(item.score);
    if (!Number.isFinite(score) || score < 0 || score > auth.maxScore) {
      throw new ReviewValidationError(`题号 ${item.questionNumber} 的分数超出有效范围 [0, ${auth.maxScore}]`);
    }
  }

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
    const auth = blockQuestionMap.get(Number(item.questionNumber))!;
    return { ...item, maxScore: auth.maxScore, score: Number(item.score) };
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
      "SELECT review_round, score_breakdown FROM answer_block_crops WHERE id = ?",
      params.cropId
    ) as { review_round: number; score_breakdown: string | null } | undefined;
    const currentRound = freshCrop?.review_round ?? 0;
    if (!freshCrop) throw new Error("作答切块不存在");
    try { scoreBreakdown = freshCrop.score_breakdown ? JSON.parse(freshCrop.score_breakdown) : []; } catch { scoreBreakdown = []; }

    if (scoreBreakdown.length >= reviewMode || currentRound >= reviewMode) {
      throw new Error("该题块已达到评分上限，请刷新后重试");
    }
    const reviewerIds = new Set(scoreBreakdown.map((b) => b.reviewerId));
    if (reviewerIds.has(params.userId)) throw new Error("您已对该题块评分，请勿重复提交");
    if (config.arbitratorId != null && config.arbitratorId === params.userId) throw new Error("您是该题块的仲裁人，不能参与初评");
    if (config.arbitratorId != null && reviewerIds.has(config.arbitratorId)) throw new Error("该题块的仲裁人已参与评分，需要更换仲裁人");

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
