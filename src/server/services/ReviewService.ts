import { getMysqlDb, buildUpsertSQL } from "../db";
import type { DbAdapter } from "../db";
import { CardRepository } from "../repositories/CardRepository";
import { recomputeExamRankings, roundScore } from "./rankingUpdate";
import {
  listReviewBlockCrops
} from "./AnswerBlockCropService";
import { computeMultiReviewResult } from "./ArbitrationService";
import { getBlockConfig } from "./BlockGradingConfigService";
import { validateScoringModeConsistency, validateBlockTotalCoverage, type ScoringMode } from "./scoringModeValidator";
import type {
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
  claimed_by?: number | null;
};

async function recomputeStudentTotals(
  tx: DbAdapter,
  examId: number,
  studentId: number
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

  // 网阅提交属于自动评分流程，不标记 manually_modified（保留既有手动修改审计语义）。
  await tx.run(
    `UPDATE student_scores
     SET objective_score = ?, subjective_score = ?, total_score = ?
     WHERE exam_id = ? AND student_id = ?`,
    totalObjective,
    totalSubjective,
    newTotal,
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
  if (studentIds.length > 0) {
    const placeholders = studentIds.map(() => "?").join(",");
    const rows = await db.all(
      `SELECT id, name FROM users WHERE id IN (${placeholders})`,
      ...studentIds
    ) as Array<{ id: number; name: string }>;
    for (const row of rows) nameById.set(row.id, row.name);
  }

  return crops.map((crop) => ({
    ...crop,
    studentName: crop.studentId != null ? (nameById.get(crop.studentId) ?? null) : null
  }));
}

/**
 * 题块总分模式拆分（#187 设计）：将整个题块的合计分分配到各小题。
 * - distribution='proportional'：按各小题满分占题块满分的比例分配（默认）。
 * - distribution='equal'：忽略满分，均匀分配到各小题。
 * - 每题得分 clamp 到该小题权威满分 [0, max]。
 * - 末题/余数兜底，保证拆分合计精确等于题块总分（step 粒度内）。
 * step 为最小分值粒度：允许 0.5 时取 0.5，否则取 1。
 */
export function splitBlockTotal(
  blockTotal: number,
  items: ReviewSubmitScoreInput[],
  maxScoreByQuestion: Map<number, number>,
  maxBlockScore: number,
  step: number,
  distribution: "proportional" | "equal"
): Map<number, number> {
  const result = new Map<number, number>();
  const nums = items.map((it) => it.questionNumber);
  if (nums.length === 0) return result;

  const sumMax = nums.reduce((acc, q) => acc + (maxScoreByQuestion.get(q) ?? 0), 0);
  const raw = nums.map((q) => {
    if (distribution === "equal") {
      return blockTotal / nums.length;
    }
    const max = maxScoreByQuestion.get(q) ?? 0;
    const denom = maxBlockScore > 0 ? maxBlockScore : sumMax || 1;
    return (blockTotal * max) / denom;
  });

  // 先按 step 取整并 clamp 到 [0, max]
  const rounded = raw.map((r, i) => {
    const max = maxScoreByQuestion.get(nums[i]) ?? 0;
    return Math.max(0, Math.min(Math.round(r / step) * step, max));
  });

  // 修正取整漂移，使合计精确等于题块总分（从末题向前吸收余量）
  let residual =
    Math.round((blockTotal - rounded.reduce((a, b) => a + b, 0)) / step) * step;
  for (let i = nums.length - 1; i >= 0 && Math.abs(residual) > 1e-9; i--) {
    const before = rounded[i];
    const max = maxScoreByQuestion.get(nums[i]) ?? 0;
    const next = Math.max(0, Math.min(before + residual, max));
    residual -= next - before;
    rounded[i] = next;
  }

  nums.forEach((q, i) => result.set(q, rounded[i]));
  return result;
}

export async function submitReviewCropScores(params: {
  examId: number;
  cropId: string;
  scores: ReviewSubmitScoreInput[];
  status?: string;
  userId: number;
  /** 题块总分模式（#187）：整个题块的合计分，后端按比例拆分到各小题 */
  blockTotalScore?: number;
  /** Issue #174: 管理员提交他人已领取试卷时放行（一般由强制释放流程处理） */
  isAdmin?: boolean;
}, db: DbAdapter = getMysqlDb()): Promise<ReviewSubmitResult> {
  const crop = await db.get(
    "SELECT * FROM answer_block_crops WHERE id = ? AND exam_id = ?",
    params.cropId,
    params.examId
  ) as CropRow | undefined;
  if (!crop) throw new Error("作答切块不存在");
  if (!crop.student_id) throw new Error("该切块未关联学生，无法阅卷");

  // Issue #174: 已领取的试卷只能由领取人提交（管理员除外），防止并发冲突覆盖
  if (!params.isAdmin && crop.claimed_by !== params.userId) {
    throw new ReviewValidationError(crop.claimed_by == null
      ? "该试卷尚未领取，无法提交；请先从试卷池领取"
      : "该试卷已被其他教师领取，无法提交；请先从试卷池领取");
  }

  const exam = await db.get("SELECT card_id FROM exams WHERE id = ?", params.examId) as { card_id: string | null } | undefined;
  if (!exam?.card_id) throw new Error("考试未关联答题卡");

  const cardRepo = new CardRepository();
  const card = await cardRepo.findById(exam.card_id);
  if (!card) throw new Error("答题卡不存在");

  // 读取评分配置（含 reviewMode）
  const blockType = crop.block_type ?? "subjective";
  const targetBlockId = crop.block_id ?? "";
  // 仅取当前题块计算满分，避免把整张答题卡的满分当作单题块满分。
  // 兜底：若按 block_id 找不到（答题卡被替换/编辑而 crop 未重建的异常态），
  // 退回同类型首个题块，避免整批改卷因硬抛错而全部失败。
  const targetBlock =
    card.bodyBlocks.find((b) => b.id === targetBlockId) ??
    card.bodyBlocks.find((b) => b.type === blockType);
  let maxBlockScore = 0;
  const maxScoreByQuestion = new Map<number, number>();
  if (targetBlock) {
    if (targetBlock.type === "objective") {
      for (const def of objectiveQuestionDefinitions(targetBlock)) {
        maxScoreByQuestion.set(def.questionNumber, Number(def.score ?? 0));
      }
    } else if (targetBlock.type === "subjective") {
      for (const question of targetBlock.questions ?? []) {
        const qNum = typeof question.number === "number" ? question.number : parseInt(String(question.number), 10);
        if (Number.isFinite(qNum)) maxScoreByQuestion.set(qNum, Number(question.score ?? 0));
      }    }
  }
  maxBlockScore = Array.from(maxScoreByQuestion.values()).reduce((a, b) => a + b, 0);

  // 兜底：卡内题块缺失（演示数据 / 答题卡被编辑后旧切块未重建）时，
  // 以落库的逐题满分作为权威满分，避免整块卷子因「题号不在范围」而无法提交。
  if (maxScoreByQuestion.size === 0) {
    const qsRows = await db.all(
      `SELECT question_number, MAX(max_score) AS max_score
       FROM question_scores
       WHERE exam_id = ? AND student_id = ? AND block_id = ?
       GROUP BY question_number`,
      params.examId,
      crop.student_id,
      crop.block_id ?? ""
    ) as Array<{ question_number: number; max_score: number | null }>;
    for (const row of qsRows) {
      const qNum = Number(row.question_number);
      const max = Number(row.max_score);
      if (Number.isFinite(qNum) && Number.isFinite(max) && max > 0) {
        maxScoreByQuestion.set(qNum, max);
      }
    }
    maxBlockScore = Array.from(maxScoreByQuestion.values()).reduce((a, b) => a + b, 0);
  }

  const config = await getBlockConfig(params.examId, crop.block_id ?? "", blockType, maxBlockScore, db);
  const reviewMode = config.reviewMode;
  const scoringMode: ScoringMode = config.scoringMode === "per_question" ? "per_question" : "block_total";

  // 入参校验：逐条检查 scores 的结构和数值合法性
  const seenQuestions = new Set<number>();
  for (const item of params.scores) {
    const qNum = Number(item.questionNumber);
    if (!Number.isFinite(qNum) || qNum <= 0) {
      throw new ReviewValidationError(`无效的题号: ${item.questionNumber}`);
    }
    if (seenQuestions.has(qNum)) {
      throw new ReviewValidationError(`题号 ${qNum} 重复提交`);
    }
    seenQuestions.add(qNum);
    const max = maxScoreByQuestion.get(qNum);
    if (max == null || max <= 0) {
      throw new ReviewValidationError(`题号 ${qNum} 不在答题卡题目范围内`);
    }
    // 逐题模式：校验逐题 score 的有限值和范围；题块总分模式由 blockTotalScore 统一校验
    if (scoringMode === "per_question") {
      const score = Number(item.score);
      if (!Number.isFinite(score)) {
        throw new ReviewValidationError(`题号 ${qNum} 的分数不是有效数字`);
      }
      if (score < 0 || score > max) {
        throw new ReviewValidationError(`题号 ${qNum} 的分数 ${score} 超出有效范围 [0, ${max}]`);
      }
    }
  }

  const now = new Date().toISOString();
  const upsertCols = [
    "exam_id", "student_id", "question_number", "question_id", "block_id",
    "score", "max_score", "score_type", "manually_modified", "modified_by", "modified_at"
  ];
  const conflictCols = ["exam_id", "student_id", "question_number", "score_type"];
  const updateCols = ["score", "max_score", "manually_modified", "modified_by", "modified_at", "block_id"];
  const upsertSQL = buildUpsertSQL(db.dialect, "question_scores", upsertCols, conflictCols, updateCols);

  // ── 题块总分模式（#187）与逐题模式（#186）兼容 ──
  // 优先采用题块总分：前端只提交一个合计分，后端按比例拆分到各小题并写入正确的逐题满分。
  // 未提交题块总分时（如 OnlineReviewPanel 逐题输入），按逐题校验的严格模式处理。
  const step = config.hasHalfPoint ? 0.5 : 1;
  const distribution = config.scoreDistribution === "equal" ? "equal" : "proportional";
  // 评分模式双向校验（PR #189 修复：原实现只校验 per_question 单方向，
  // 导致 block_total + 仅逐题分数也能通过，scoringMode 形同虚设）
  // 把 blockTotalScore 归一化为「是否合法提交」(null/undefined/NaN 视为未提交)
  const blockTotalScoreNum = params.blockTotalScore == null ? Number.NaN : Number(params.blockTotalScore);
  const hasBlockTotalScore = Number.isFinite(blockTotalScoreNum);
  const consistency = validateScoringModeConsistency(scoringMode, hasBlockTotalScore);
  if (!consistency.ok) throw new Error(consistency.error);
  const submittedScores: Array<{ questionNumber: number; scoreType: string; score: number; maxScore: number }> =
    params.blockTotalScore != null
      ? (() => {
          const total = Number(params.blockTotalScore);
          if (!Number.isFinite(total) || total < -1e-9) throw new Error("题块总分无效");
          if (total > maxBlockScore + 1e-6) {
            throw new Error(`题块总分不能超过本题块满分 ${maxBlockScore}`);
          }
          if (Math.abs(total - Math.round(total / step) * step) > 1e-9) {
            throw new Error(`题块总分必须是 ${step} 分的整数倍`);
          }
          // 题号集合校验：题块总分代表整个题块，提交项必须恰好覆盖本题块的权威小题，
          // 且每题只允许出现一次（否则 totalScore 虚高且 scoreBreakdown 内部不一致）。
          const authoritativeNums = Array.from(maxScoreByQuestion.keys());
          const coverage = validateBlockTotalCoverage(authoritativeNums, params.scores);
          if (!coverage.ok) throw new Error(coverage.error);
          const split = splitBlockTotal(
            Math.round(total * 100) / 100,
            params.scores,
            maxScoreByQuestion,
            maxBlockScore,
            step,
            distribution
          );
          return params.scores.map((item) => {
            const qNum = item.questionNumber;
            const max = maxScoreByQuestion.get(qNum) ?? 0;
            const score = Math.max(0, Math.min(max, split.get(qNum) ?? 0));
            return { questionNumber: qNum, scoreType: String(item.scoreType), score, maxScore: max };
          });
        })()
      : params.scores.map((item) => {
          const authoritative = maxScoreByQuestion.get(item.questionNumber);
          // #186 严格校验：逐题模式若显式携带 maxScore，必须与权威逐题满分一致
          if (item.maxScore != null && authoritative != null && Math.abs(item.maxScore - authoritative) > 1e-6) {
            throw new Error(`第${item.questionNumber}题满分应为 ${authoritative}，提交值为 ${item.maxScore}`);
          }
          const maxScore = item.maxScore ?? authoritative ?? item.score;
          return {
            questionNumber: item.questionNumber,
            scoreType: String(item.scoreType),
            score: Math.max(0, Math.min(maxScore, item.score)),
            maxScore
          };
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
      "SELECT review_round, score_breakdown, status, claimed_by FROM answer_block_crops WHERE id = ?",
      params.cropId
    ) as { review_round: number; score_breakdown: string | null; status: string | null; claimed_by: number | null } | undefined;
    const currentRound = freshCrop?.review_round ?? 0;
    if (!freshCrop) throw new Error("作答切块不存在");
    if (!params.isAdmin && freshCrop.claimed_by !== params.userId) {
      throw new ReviewValidationError("试卷领取状态已变更，请刷新后重新领取");
    }
    try { scoreBreakdown = freshCrop.score_breakdown ? JSON.parse(freshCrop.score_breakdown) : []; } catch { scoreBreakdown = []; }

    const reviewerIds = new Set(scoreBreakdown.map((b) => b.reviewerId));
    // 争议卷回退给原老师时（含自动回退），允许其追加复评以打破僵局；其余情况禁止重复提交
    if (reviewerIds.has(params.userId) && freshCrop.status !== "disputed") {
      throw new Error("您已对该题块评分，请勿重复提交");
    }
    if (config.arbitratorId != null && config.arbitratorId === params.userId) throw new Error("您是该题块的仲裁人，不能参与初评");
    if (config.arbitratorId != null && reviewerIds.has(config.arbitratorId)) throw new Error("该题块的仲裁人已参与评分，需要更换仲裁人");

    // 争议卷（含自动改派/回退给原老师）允许追加复评以打破僵局；
    // 限制最多比正常模式多 2 轮，避免两教师在争议卷上无限互评
    const maxDisputedRounds = reviewMode + 2;
    const isDisputedRereview = freshCrop.status === "disputed" && scoreBreakdown.length < maxDisputedRounds;
    if ((scoreBreakdown.length >= reviewMode || currentRound >= reviewMode) && !isDisputedRereview) {
      throw new Error("该题块已达到评分上限，请刷新后重试");
    }

    totalScore = submittedScores.reduce((sum, item) => sum + item.score, 0);
    finalReviewRound = currentRound + 1;
    const questionScores = Object.fromEntries(submittedScores.map((item) => [String(item.questionNumber), item.score]));

    scoreBreakdown.push({ round: finalReviewRound, reviewerId: params.userId, score: totalScore, reviewedAt: now, questionScores });

    // 仅在所有轮次完成且无争议后才写正式分数，避免最后一评的分数提前影响排名。
    // Issue #174: 提交后清空领取标记。
    // pending 回到试卷池等待下一轮复核；reviewed/disputed 离开可领集合。
    await tx.run(
      "UPDATE answer_block_crops SET claimed_by = NULL, claimed_at = NULL WHERE id = ?",
      params.cropId
    );

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
        if (!disputed) totalScore = await recomputeStudentTotals(tx, params.examId, crop.student_id!);
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
        // 无仲裁人时，把争议卷自动改派：优先「已分配本题块且未评过该生」的教师，不足则回退原老师（自动过程）
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

  // 排名重算在事务外（赋分重算可能涉及独立连接）；失败时降级返回，
  // 不把“分数已落库但排名未更新”伪装成完全成功。
  let rankingsRecalculated = true;
  let rankingError: string | undefined;
  let assignedScoresRecalculated = true;
  let assignedScoreError: string | undefined;
  try {
    const recalc = await recomputeExamRankings(db, params.examId);
    rankingsRecalculated = recalc.rankingsRecalculated;
    assignedScoresRecalculated = recalc.assignedScoresRecalculated;
    assignedScoreError = recalc.assignedScoreError;
  } catch (err) {
    rankingsRecalculated = false;
    rankingError = err instanceof Error ? err.message : String(err);
    assignedScoresRecalculated = false;
    assignedScoreError = rankingError;
    console.error(`[Review] 排名重算失败 exam=${params.examId} crop=${params.cropId}:`, err);
  }

  return {
    ok: true,
    cropId: params.cropId,
    status: disputed ? "disputed" : (scoreBreakdown.length >= reviewMode ? "reviewed" : "pending"),
    totalScore,
    disputed,
    disputeReason,
    reviewRound: finalReviewRound,
    finalScore,
    rankingsRecalculated,
    rankingError,
    assignedScoresRecalculated,
    assignedScoreError
  };
}

/**
 * 无仲裁人时，把争议卷自动改派：
 *  1) 优先改派给「已分配本题块且尚未评过该生」的教师（工作量均衡，追加其待批队列 auto_assigned=1）；
 *  2) 兜底：若本题块已分配教师数不足（都已评过该生，无合格的新教师），自动把争议卷回退给
 *     「原老师」（最初评过该生的教师），不再限制其是否已评过 —— 这是一个自动过程，
 *     让原老师在争议卷上追加一轮复评以打破僵局。若连已分配教师都没有，则保持 disputed 进入人工争议池。
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
    "SELECT student_id, score_breakdown FROM answer_block_crops WHERE id = ? AND exam_id = ?",
    cropId,
    examId
  ) as { student_id: number | null; score_breakdown: string | null } | undefined;
  if (!crop?.student_id) return;

  const assignments = await db.all(
    "SELECT id, teacher_id, assigned_student_ids, auto_assigned FROM review_assignments WHERE exam_id = ? AND block_id = ?",
    examId,
    blockId
  ) as Array<{ id: number; teacher_id: number; assigned_student_ids: string | null; auto_assigned: number | null }>;

  // 优先：已分配本题块、未参与过本生评分、且未产生争议的教师（工作量均衡）
  const eligible = assignments.filter((a) => {
    if (excludeReviewerIds.has(a.teacher_id)) return false;
    const ids = a.assigned_student_ids ? (JSON.parse(a.assigned_student_ids) as number[]) : [];
    return !ids.includes(crop.student_id!);
  });

  let target: { id: number; teacher_id: number; assigned_student_ids: string | null; auto_assigned: number | null } | null =
    eligible.length > 0
      ? eligible.reduce((a, b) =>
          (JSON.parse(a.assigned_student_ids ?? "[]") as number[]).length <=
          (JSON.parse(b.assigned_student_ids ?? "[]") as number[]).length
            ? a
            : b
        )
      : null;

  // 兜底：本题块已分配教师不足（都已评过该生），自动回退给「原老师」（最初评过该生的教师）
  if (!target) {
    let originalTeacherId: number | null = null;
    try {
      const breakdown = crop.score_breakdown
        ? (JSON.parse(crop.score_breakdown) as Array<{ reviewerId: number }>)
        : [];
      if (breakdown.length > 0) originalTeacherId = breakdown[0].reviewerId;
    } catch {
      originalTeacherId = null;
    }
    // 若评分历史缺失，退而求其次：取最初（非自动改派）持有该生的分配教师
    if (originalTeacherId == null) {
      const orig = assignments.find((a) => {
        if (a.auto_assigned === 1) return false;
        const ids = a.assigned_student_ids ? (JSON.parse(a.assigned_student_ids) as number[]) : [];
        return ids.includes(crop.student_id!);
      });
      originalTeacherId = orig?.teacher_id ?? null;
    }
    if (originalTeacherId != null) {
      target = assignments.find((a) => a.teacher_id === originalTeacherId) ?? null;
    }
    // 仍无明确目标则落到工作量最轻的已分配教师，确保争议卷一定被回退而非滞留
    if (!target && assignments.length > 0) {
      target = assignments.reduce((a, b) =>
        (JSON.parse(a.assigned_student_ids ?? "[]") as number[]).length <=
        (JSON.parse(b.assigned_student_ids ?? "[]") as number[]).length
          ? a
          : b
      );
    }
  }

  if (!target) return; // 连已分配教师都没有 → 争议池兜底

  const existingIds = JSON.parse(target.assigned_student_ids ?? "[]") as number[];
  const ids = existingIds.includes(crop.student_id!)
    ? existingIds
    : [...existingIds, crop.student_id!];
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

  // 批量解析评审人姓名，避免逐条查 users（N+1）
  const reviewerIds = new Set<number>();
  for (const row of rows) {
    if (!row.score_breakdown) continue;
    try {
      const breakdown = JSON.parse(row.score_breakdown) as Array<{ reviewerId?: number }>;
      for (const b of breakdown) if (typeof b.reviewerId === "number") reviewerIds.add(b.reviewerId);
    } catch { /* ignore malformed */ }
  }
  const reviewerNameById = new Map<number, string>();
  if (reviewerIds.size > 0) {
    const placeholders = Array.from(reviewerIds).map(() => "?").join(",");
    const reviewers = await db.all(
      `SELECT id, name FROM users WHERE id IN (${placeholders})`,
      ...Array.from(reviewerIds)
    ) as Array<{ id: number; name: string }>;
    for (const r of reviewers) reviewerNameById.set(r.id, r.name);
  }

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
          reviewerName: reviewerNameById.get(b.reviewerId) ?? `教师${b.reviewerId}`,
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
