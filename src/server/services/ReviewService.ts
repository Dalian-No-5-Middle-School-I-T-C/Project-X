import { essayReviewIssue, loadEssayReviews, reviewUnitPredicate } from "./essayReview";
import { databaseTimestamp } from "../db/timestamp";
import { getMysqlDb, buildUpsertSQL } from "../db";
import type { DbAdapter } from "../db";
import { CardRepository } from "../repositories/CardRepository";
import { recomputeExamRankingsCoalesced, roundScore } from "./rankingUpdate";
import { markScoreMutated } from "./examPublishEvents";
import { canGradeBlock } from "../../apps/answer-card/server/middleware";
import {
  listReviewBlockCrops
} from "./AnswerBlockCropService";
import { computeMultiReviewResult } from "./ArbitrationService";
import { getBlockConfig, loadHalfPointRule } from "./BlockGradingConfigService";
import { loadReviewQuestionContracts } from "./ReviewQuestionContractService";
import { REVIEW_AMENDMENT_WINDOW_MS } from "../../shared/reviewPoolLimits";
import { validateScoringModeConsistency, validateBlockTotalCoverage, type ScoringMode } from "./scoringModeValidator";
import type {
  ReviewBlockCropItem,
  ReviewBlockSummary,
  ReviewSubmitResult,
  ReviewSubmitScoreInput,
  ReviewTraceItem,
  ReviewRoundDetail,
  ReviewScoreBreakdownEntry,
  RecentReviewedCrop
} from "../../shared/types";

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
): Promise<{ totalScore: number; changed: boolean }> {
  const previous = await tx.get<{ total_score: number | null }>(
    "SELECT total_score FROM student_scores WHERE exam_id = ? AND student_id = ?",
    examId,
    studentId
  );
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

  return {
    totalScore: newTotal,
    changed: previous == null || roundScore(Number(previous.total_score ?? 0)) !== newTotal
  };
}

export async function listReviewBlocks(
  examId: number,
  db: DbAdapter = getMysqlDb(),
  permittedBlockIds?: string[] | null
): Promise<ReviewBlockSummary[]> {
  // 安全 R03：题块级阅卷人只应看到自己被分配的题块（空集合 = 看不到任何题块）。
  if (permittedBlockIds && permittedBlockIds.length === 0) return [];
  const blockFilter = permittedBlockIds
    ? ` AND abc.block_id IN (${permittedBlockIds.map(() => "?").join(",")})`
    : "";
  const rows = await db.all(
    `SELECT
       abc.block_id AS blockId,
       MAX(abc.block_title) AS blockTitle,
       MAX(abc.block_type) AS blockType,
       COUNT(*) AS totalCount,
       SUM(CASE WHEN COALESCE(abc.status, 'ready') IN ('ready', 'pending') THEN 1 ELSE 0 END) AS pendingCount,
       SUM(CASE WHEN abc.status = 'reviewed' THEN 1 ELSE 0 END) AS reviewedCount
     FROM answer_block_crops abc
     WHERE abc.exam_id = ? AND ${reviewUnitPredicate("abc")}${blockFilter}
     GROUP BY abc.block_id
     ORDER BY abc.block_id`,
    examId, ...(permittedBlockIds ?? [])
  ) as Array<{
    blockId: string;
    blockTitle: string | null;
    blockType: string;
    totalCount: number;
    pendingCount: number;
    reviewedCount: number;
  }>;

  if (rows.length === 0) return [];

  // 逐题满分契约由统一规则生成：答题卡优先，question_scores 仅作旧卡兜底。
  const contracts = await loadReviewQuestionContracts(examId, db, rows.map((row) => row.blockId));
  const hasHalfPoint = await loadHalfPointRule(examId, db);

  return rows.map((row) => ({
    blockId: row.blockId,
    blockTitle: row.blockTitle ?? row.blockId,
    blockType: row.blockType,
    totalCount: Number(row.totalCount),
    pendingCount: Number(row.pendingCount),
    reviewedCount: Number(row.reviewedCount),
    hasHalfPoint: hasHalfPoint(row.blockId),
    maxScore: contracts.get(row.blockId)?.maxScore ?? 0,
    questions: contracts.get(row.blockId)?.questions ?? []
  }));
}

export async function listReviewBlockCropItems(
  params: {
    examId: number; blockId?: string; blockIds?: string[]; classId?: number; status?: string;
    /** 精确读取一组切块（最近已批回看等按需场景） */
    cropIds?: string[];
    /** 逐生分配切片（评审 B1），透传给 `listReviewBlockCrops` */
    assignedSlice?: { sql: string; params: unknown[] } | null;
  },
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
 * 本人最近已批的记录（最后一票属于本人、卷仍在已批状态）。
 *
 * 用于限时改票与回看：只按 reviewed_at 倒序取一页候选，再在内存里核对
 * score_breakdown 的最后一条，避免把「已由他人终评」的卷子误当成可改。
 */
export async function listRecentReviewedCrops(
  examId: number,
  blockId: string,
  teacherId: number,
  limit: number = 20,
  db: DbAdapter = getMysqlDb()
): Promise<RecentReviewedCrop[]> {
  const candidateLimit = Math.max(limit * 5, 60);
  const rows = await db.all(
    `SELECT id, score_breakdown, reviewed_at
     FROM answer_block_crops
     WHERE exam_id = ? AND block_id = ? AND status = 'reviewed' AND review_round > 0
     ORDER BY reviewed_at DESC
     LIMIT ?`,
    examId,
    blockId,
    candidateLimit
  ) as Array<{ id: string; score_breakdown: string | Array<ReviewScoreBreakdownEntry> | null; reviewed_at: string | null }>;

  const eligible: Array<{
    cropId: string;
    vote: ReviewScoreBreakdownEntry;
    deadline: number;
  }> = [];
  for (const row of rows) {
    let breakdown: ReviewScoreBreakdownEntry[] = [];
    try {
      const parsed: unknown = typeof row.score_breakdown === "string"
        ? JSON.parse(row.score_breakdown)
        : row.score_breakdown;
      if (Array.isArray(parsed)) breakdown = parsed as ReviewScoreBreakdownEntry[];
    } catch {
      continue;
    }
    const last = breakdown.at(-1);
    if (!last || Number(last.reviewerId) !== teacherId) continue;
    const reviewedAt = Date.parse(last.reviewedAt);
    if (!Number.isFinite(reviewedAt)) continue;
    eligible.push({ cropId: row.id, vote: last, deadline: reviewedAt + REVIEW_AMENDMENT_WINDOW_MS });
    if (eligible.length >= limit) break;
  }
  if (eligible.length === 0) return [];

  const items = await listReviewBlockCropItems({
    examId,
    blockId,
    cropIds: eligible.map((entry) => entry.cropId)
  }, db);
  const byId = new Map(items.map((item) => [item.id, item]));
  return eligible.flatMap((entry) => {
    const item = byId.get(entry.cropId);
    if (!item) return [];
    return [{
      ...item,
      myLastVote: entry.vote,
      expectedVersion: `${entry.vote.round}:${entry.vote.reviewedAt}`,
      amendmentDeadline: new Date(entry.deadline).toISOString(),
      canAmend: Date.now() <= entry.deadline
    }];
  });
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
  const nums = items.map((it) => it.questionNumber).sort((a, b) => a - b);
  if (nums.length === 0) return result;

  const maxima = nums.map(q => maxScoreByQuestion.get(q) ?? 0);
  const sumMax = maxima.reduce((sum, max) => sum + max, 0);
  if (Math.abs(blockTotal - sumMax) <= 1e-9) {
    return new Map(nums.map((q, i) => [q, maxima[i]]));
  }
  const raw = maxima.map(max => {
    if (distribution === "equal") {
      return blockTotal / nums.length;
    }
    const denom = maxBlockScore > 0 ? maxBlockScore : sumMax || 1;
    return (blockTotal * max) / denom;
  });

  // 先在各题完整步长内分配，避免被小数满分截断后合计多出半步。
  const stepMaxima = maxima.map(max => Math.floor(max / step) * step);
  const rounded = raw.map((r, i) => Math.max(0, Math.min(Math.round(r / step) * step, stepMaxima[i])));

  // 修正取整漂移，使合计精确等于题块总分（从末题向前吸收余量）
  let residual = roundScore(blockTotal - rounded.reduce((a, b) => a + b, 0));
  for (let i = nums.length - 1; i >= 0 && residual !== 0; i--) {
    const next = Math.max(0, Math.min(rounded[i] + residual, stepMaxima[i]));
    residual = roundScore(residual - (next - rounded[i]));
    rounded[i] = next;
  }

  const scores = residual > 0 ? splitAboveStepMaxima(maxima, step, blockTotal) : rounded;
  nums.forEach((q, i) => result.set(q, scores[i]));
  return result;
}

/** 完整步长已用完。从全满分往下扣，每题可不扣，或扣满分的小数尾差加若干完整步长。 */
function splitAboveStepMaxima(maxima: number[], step: number, total: number): number[] {
  // 成绩合计保留三位小数。只搜索「满分合计 − 提交分」，其上界是题数 × 步长，与卷面总分无关。
  const scale = 1000;
  const stepUnits = step * scale;
  const maxUnits = maxima.map(max => Math.round(max * scale));
  const tails = maxUnits.map(max => max % stepUnits);
  let unit = stepUnits;
  for (let tail of tails) {
    while (tail) [unit, tail] = [tail, unit % tail];
  }
  const deficit = (maxUnits.reduce((sum, max) => sum + max, 0) - Math.round(total * scale)) / unit;
  const unreachable = () => new ReviewValidationError(`题块总分无法按 ${step} 分步长和各题满分拆分，请调整给分`);
  if (!Number.isInteger(deficit) || deficit < 0) throw unreachable();
  const stride = stepUnits / unit;
  const questionAt = new Int32Array(deficit + 1);
  const previous = new Int32Array(deficit + 1);
  const nearest = new Int32Array(stride);
  questionAt[0] = -1;
  for (let i = 0; i < maxima.length && !questionAt[deficit]; i++) {
    const tail = tails[i] / unit;
    const maxDeduction = maxUnits[i] / unit;
    nearest.fill(-1);
    for (let p = 0; p + tail <= deficit; p++) {
      const residue = p % stride;
      // 同余类中最近的旧状态即可判断能否在本题满分内扣到目标。跳过本轮新状态，每题只用一次。
      if (questionAt[p] && questionAt[p] !== i + 1) nearest[residue] = p;
      const from = nearest[residue];
      const amount = p + tail;
      if (!questionAt[amount] && from >= 0 && amount - from <= maxDeduction) {
        questionAt[amount] = i + 1;
        previous[amount] = from;
      }
    }
  }
  if (!questionAt[deficit]) throw unreachable();
  const scores = [...maxima];
  for (let d = deficit; d > 0; d = previous[d]) {
    const i = questionAt[d] - 1;
    scores[i] = (maxUnits[i] - (d - previous[d]) * unit) / scale;
  }
  const allocated = scores.reduce((sum, score) => sum + score, 0);
  if (Math.abs(allocated - total) > 1e-9 || scores.some((score, i) => score > maxima[i])) throw unreachable();
  return scores;
}

/** `answer_block_crops.score_breakdown` 的单条评阅记录（落库结构，与 demo/reviewDemo.ts 保持一致） */
type ReviewBreakdownEntry = ReviewScoreBreakdownEntry;

/**
 * 安全 R47：把评阅历史收敛为「每位评阅人的最后一票」。
 *
 * 争议卷会回退给原老师追加复评以打破僵局，但复评是修正自己那张票，不是多出一票。
 * 历史实现把 `score_breakdown` 的每一条都当独立投票：A=10、B=4 触发争议后，A 再提交一次
 * 就成了 [10,4,10] 三票，中位数/均值被同一人重复计票拉向自己——原老师可以靠重复提交
 * 把争议判成自己想要的结果。这里按 reviewerId 取最后一轮，并保持首次出现顺序，
 * 供总票聚合与逐题合并共同使用。
 */
function latestVotesByReviewer(breakdown: ReviewBreakdownEntry[]): ReviewBreakdownEntry[] {
  const lastByReviewer = new Map<number, ReviewBreakdownEntry>();
  const firstSeen = new Map<number, number>();
  breakdown.forEach((entry, index) => {
    if (!firstSeen.has(entry.reviewerId)) firstSeen.set(entry.reviewerId, index);
    const prev = lastByReviewer.get(entry.reviewerId);
    if (!prev || Number(entry.round) >= Number(prev.round)) lastByReviewer.set(entry.reviewerId, entry);
  });
  return [...lastByReviewer.values()]
    .sort((a, b) => (firstSeen.get(a.reviewerId) ?? 0) - (firstSeen.get(b.reviewerId) ?? 0));
}

function isOnScoreStep(score: number, step: number): boolean {
  return Math.abs(score - Math.round(score / step) * step) <= 1e-9;
}

type ReviewActor = {
  id: number;
  role_id?: number;
  role_name?: string;
  teacher_role?: string | null;
};

type ReviewSubmissionParams = {
  examId: number;
  cropId: string;
  scores: ReviewSubmitScoreInput[];
  status?: string;
  userId: number;
  /** 题块总分模式（#187）：整个题块的合计分，后端按比例拆分到各小题 */
  blockTotalScore?: number;
  /** Issue #174: 管理员提交他人已领取试卷时放行（一般由强制释放流程处理） */
  isAdmin?: boolean;
  amendment?: {
    expectedVersion: string;
    user: ReviewActor;
  };
};

async function persistReviewVote(params: ReviewSubmissionParams, db: DbAdapter): Promise<ReviewSubmitResult> {
  const amendment = params.amendment;
  const crop = await db.get(
    "SELECT * FROM answer_block_crops WHERE id = ? AND exam_id = ?",
    params.cropId,
    params.examId
  ) as CropRow | undefined;
  if (!crop) throw new Error("作答切块不存在");
  if (!crop.student_id) throw new Error("该切块未关联学生，无法阅卷");

  // 普通提交必须持有试卷；限时改票面向已批回看，不重新领取。
  if (!amendment && !params.isAdmin && crop.claimed_by !== params.userId) {
    throw new ReviewValidationError(crop.claimed_by == null
      ? "该试卷尚未领取，无法提交；请先从试卷池领取"
      : "该试卷已被其他教师领取，无法提交；请先从试卷池领取");
  }

  const exam = await db.get("SELECT card_id FROM exams WHERE id = ?", params.examId) as { card_id: string | null } | undefined;
  if (!exam?.card_id) throw new Error("考试未关联答题卡");

  const cardRepo = new CardRepository(db);
  const card = await cardRepo.findById(exam.card_id);
  if (!card) throw new Error("答题卡不存在");

  // 读取评分配置（含 reviewMode）
  const blockType = crop.block_type ?? "subjective";
  const targetBlockId = crop.block_id ?? "";
  // 仅取当前题块计算满分；与汇总、队列共用同一份权威契约。
  const targetBlock =
    card.bodyBlocks.find((b) => b.id === targetBlockId) ??
    card.bodyBlocks.find((b) => b.type === blockType);
  const contract = (await loadReviewQuestionContracts(params.examId, db, [targetBlockId])).get(targetBlockId);
  const maxScoreByQuestion = new Map<number, number>((contract?.questions ?? []).map((question) => [question.questionNumber, question.maxScore]));
  const zeroMaxQuestions = contract?.zeroQuestionNumbers ?? new Set<number>();
  const maxBlockScore = contract?.maxScore ?? 0;
  const scores = params.scores.filter(item => !zeroMaxQuestions.has(Number(item.questionNumber)));

  if (targetBlock?.type === "subjective" && targetBlock.blockKind === "essay"
    && (scores.length !== 1 || Number(scores[0].questionNumber) !== Number(targetBlock.questions[0]?.number)
      || scores[0].scoreType !== "subjective")) {
    throw new ReviewValidationError("请为作文题提交一个主观题分数");
  }
  const config = await getBlockConfig(params.examId, crop.block_id ?? "", blockType, maxBlockScore, db);
  const reviewMode = config.reviewMode;
  const step = config.hasHalfPoint ? 0.5 : 1;
  const scoringMode: ScoringMode = config.scoringMode === "per_question" ? "per_question" : "block_total";

  // 入参校验：逐条检查 scores 的结构和数值合法性
  const seenQuestions = new Set<number>();
  for (const item of scores) {
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
      // A question with a fractional maximum can always receive its full mark.
      if (score !== max && !isOnScoreStep(score, step)) {
        throw new ReviewValidationError(`第 ${qNum} 题得分须为 ${step} 分的整数倍或该题满分 ${max}`);
      }
    }
  }

  const now = databaseTimestamp();
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
  const distribution = config.scoreDistribution === "equal" ? "equal" : "proportional";
  // 评分模式双向校验（PR #189 修复：原实现只校验 per_question 单方向，
  // 导致 block_total + 仅逐题分数也能通过，scoringMode 形同虚设）
  // 把 blockTotalScore 归一化为「是否合法提交」(null/undefined/NaN 视为未提交)
  const blockTotalScoreNum = params.blockTotalScore == null ? Number.NaN : Number(params.blockTotalScore);
  const hasBlockTotalScore = Number.isFinite(blockTotalScoreNum);
  const consistency = validateScoringModeConsistency(scoringMode, hasBlockTotalScore);
  if (!consistency.ok) throw new ReviewValidationError(consistency.error);
  const authoritativeNums = Array.from(maxScoreByQuestion.keys());
  if (scoringMode === "per_question") {
    const coverage = validateBlockTotalCoverage(authoritativeNums, scores);
    if (!coverage.ok) throw new ReviewValidationError(coverage.error);
  }
  const submittedScores: Array<{ questionNumber: number; scoreType: string; score: number; maxScore: number }> =
    params.blockTotalScore != null
      ? (() => {
          const total = Number(params.blockTotalScore);
          if (!Number.isFinite(total) || total < -1e-9) throw new ReviewValidationError("题块总分无效");
          if (total > maxBlockScore + 1e-6) {
            throw new ReviewValidationError(`题块总分不能超过本题块满分 ${maxBlockScore}`);
          }
          const isFullMark = Math.abs(total - maxBlockScore) <= 1e-9;
          if (!isFullMark && !isOnScoreStep(total, step)) {
            throw new ReviewValidationError(`题块总分必须是 ${step} 分的整数倍或题块满分 ${maxBlockScore}`);
          }
          // 题号集合校验：题块总分代表整个题块，提交项必须恰好覆盖本题块的权威小题，
          // 且每题只允许出现一次（否则 totalScore 虚高且 scoreBreakdown 内部不一致）。
          const coverage = validateBlockTotalCoverage(authoritativeNums, scores);
          if (!coverage.ok) throw new ReviewValidationError(coverage.error);
          const split = splitBlockTotal(
            isFullMark ? maxBlockScore : roundScore(total),
            scores,
            maxScoreByQuestion,
            maxBlockScore,
            step,
            distribution
          );
          return scores.map((item) => {
            const qNum = item.questionNumber;
            const max = maxScoreByQuestion.get(qNum) ?? 0;
            const score = Math.max(0, Math.min(max, split.get(qNum) ?? 0));
            return { questionNumber: qNum, scoreType: String(item.scoreType), score, maxScore: max };
          });
        })()
      : scores.map((item) => {
          const authoritative = maxScoreByQuestion.get(item.questionNumber);
          // #186 严格校验：逐题模式若显式携带 maxScore，必须与权威逐题满分一致
          if (item.maxScore != null && authoritative != null && Math.abs(item.maxScore - authoritative) > 1e-6) {
            throw new ReviewValidationError(`第${item.questionNumber}题满分应为 ${authoritative}，提交值为 ${item.maxScore}`);
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
  let reachedFinalRound = false;
  let scoreBreakdown: ReviewBreakdownEntry[] = [];
  let disputed = false;
  let disputeReason = "";
  let finalScore: number | null = null;
  let formalTotalChanged = false;

  // P0-2: 争议检测 + 状态更新全部在事务内执行
  await db.transaction(async (tx) => {
    if (targetBlock?.type === "subjective" && targetBlock.blockKind === "essay") {
      await tx.run("UPDATE exams SET id=id WHERE id=?", params.examId);
      const essays = await loadEssayReviews(tx, params.examId, targetBlockId, crop.student_id!);
      const unit = essays.get(params.cropId);
      const issue = unit ? essayReviewIssue(unit, params.cropId) : "作文切图归属已变更，请重新领取";
      if (issue) throw new ReviewValidationError(issue);
    }
    // 评分历史、改票版本、领取/完成状态与题块归属必须在同一事务内复核。
    const freshCrop = await tx.get(
      `SELECT exam_id, block_id, review_round, score_breakdown, status, claimed_by
       FROM answer_block_crops WHERE id = ?`,
      params.cropId
    ) as {
      exam_id: number | null;
      block_id: string;
      review_round: number;
      score_breakdown: string | Array<ReviewBreakdownEntry> | null;
      status: string | null;
      claimed_by: number | null;
    } | undefined;
    const currentRound = freshCrop?.review_round ?? 0;
    if (!freshCrop) throw new Error("作答切块不存在");
    if (freshCrop.exam_id !== params.examId || freshCrop.block_id !== targetBlockId) {
      throw new ReviewValidationError("试卷题块归属已变更，请刷新后重试");
    }
    if (amendment) {
      if (!(await canGradeBlock(amendment.user, params.examId, targetBlockId, tx))) {
        throw new ReviewValidationError("权限不足：你当前不可阅此题块");
      }
      if (freshCrop.status !== "reviewed" || freshCrop.claimed_by != null) {
        throw new ReviewValidationError("该卷当前不是可改票的已批状态");
      }
    } else if (!params.isAdmin && freshCrop.claimed_by !== params.userId) {
      throw new ReviewValidationError("试卷领取状态已变更，请刷新后重新领取");
    }
    try {
      const parsed: unknown = typeof freshCrop.score_breakdown === "string"
        ? JSON.parse(freshCrop.score_breakdown)
        : freshCrop.score_breakdown;
      scoreBreakdown = Array.isArray(parsed) ? parsed as ReviewBreakdownEntry[] : [];
    } catch {
      scoreBreakdown = [];
    }

    const reviewerIds = new Set(scoreBreakdown.map((b) => b.reviewerId));
    if (amendment) {
      const last = scoreBreakdown.at(-1);
      if (!last || last.reviewerId !== params.userId) {
        throw new ReviewValidationError("该卷已有其他评阅人的更新，不能修改旧票");
      }
      const version = `${last.round}:${last.reviewedAt}`;
      if (amendment.expectedVersion !== version) {
        throw new ReviewValidationError("改票版本已过期，请刷新最近已批记录后重试");
      }
      const reviewedAt = Date.parse(last.reviewedAt);
      const nowMs = Date.parse(now);
      if (!Number.isFinite(reviewedAt) || !Number.isFinite(nowMs) || nowMs > reviewedAt + REVIEW_AMENDMENT_WINDOW_MS) {
        throw new ReviewValidationError("已超过限时改票窗口，不能再修改此票");
      }
    } else {
      // 争议卷回退给原老师时（含自动回退），允许其追加复评以打破僵局；其余情况禁止重复提交
      if (reviewerIds.has(params.userId) && freshCrop.status !== "disputed") {
        throw new Error("您已对该题块评分，请勿重复提交");
      }
      // 争议卷（含自动改派/回退给原老师）允许追加复评以打破僵局；
      // 限制最多比正常模式多 2 轮，避免两教师在争议卷上无限互评
      const maxDisputedRounds = reviewMode + 2;
      const isDisputedRereview = freshCrop.status === "disputed" && scoreBreakdown.length < maxDisputedRounds;
      if ((reviewerIds.size >= reviewMode || currentRound >= reviewMode) && !isDisputedRereview) {
        throw new Error("该题块已达到评分上限，请刷新后重试");
      }
    }
    if (config.arbitratorId != null && config.arbitratorId === params.userId) throw new ReviewValidationError("您是该题块的仲裁人，不能参与初评");
    if (config.arbitratorId != null && reviewerIds.has(config.arbitratorId)) throw new Error("该题块的仲裁人已参与评分，需要更换仲裁人");

    totalScore = submittedScores.reduce((sum, item) => sum + item.score, 0);
    finalReviewRound = currentRound + 1;
    const questionScores = Object.fromEntries(submittedScores.map((item) => [String(item.questionNumber), item.score]));

    scoreBreakdown.push({ round: finalReviewRound, reviewerId: params.userId, score: totalScore, reviewedAt: now, questionScores });

    // R47：票数按评阅人去重（每人取其最后一轮），改票/复评不叠加票数，
    // 也不能因为历史行数达到评阅轮数就提前写正式分。
    const effectiveVotes = latestVotesByReviewer(scoreBreakdown);
    reachedFinalRound = effectiveVotes.length >= reviewMode;

    // 仅在所有轮次完成且无争议后才写正式分数，避免最后一评的分数提前影响排名。
    // Issue #174: 提交后清空领取标记。
    // pending 回到试卷池等待下一轮复核；reviewed/disputed 离开可领集合。
    await tx.run(
      "UPDATE answer_block_crops SET claimed_by = NULL, claimed_at = NULL WHERE id = ?",
      params.cropId
    );

    if (reachedFinalRound) {
      const allScores = effectiveVotes.map((b) => b.score);
      const disputeResult = computeMultiReviewResult(allScores, config.disputeThreshold, config.rounding);
      disputed = disputeResult.disputed;
      disputeReason = disputeResult.reason;
      if (!disputed) {
        const resolvedQuestionScores: Array<{ item: typeof submittedScores[number]; score: number }> = [];
        for (const item of submittedScores) {
          const values = effectiveVotes.map((round) => round.questionScores?.[String(item.questionNumber)]).filter((v): v is number => typeof v === "number");
          if (values.length !== effectiveVotes.length) throw new Error("历史评审缺少逐题分数，无法安全合并，请转仲裁处理");
          const resolved = computeMultiReviewResult(values, config.disputeThreshold, config.rounding);
          if (resolved.disputed || resolved.finalScore == null) {
            disputed = true;
            disputeReason = `第${item.questionNumber}题${resolved.reason}`;
            break;
          }
          resolvedQuestionScores.push({ item, score: Math.min(resolved.finalScore, item.maxScore) });
        }
        // Do not persist a partial set if a later question is disputed.
        if (!disputed) {
          finalScore = roundScore(resolvedQuestionScores.reduce((sum, question) => sum + question.score, 0));
          for (const resolved of resolvedQuestionScores) {
            await tx.run(upsertSQL, params.examId, crop.student_id, resolved.item.questionNumber, null, crop.block_id, resolved.score, resolved.item.maxScore, resolved.item.scoreType, 1, params.userId, now);
          }
          const totals = await recomputeStudentTotals(tx, params.examId, crop.student_id!);
          totalScore = totals.totalScore;
          formalTotalChanged = totals.changed;
          // 评审 P1：仅当本轮评阅写下正式分数并重算总分时才视为成绩变更 →
          // 同一事务内按管理员策略处理公布状态
          await markScoreMutated(tx, params.examId, params.userId, "review_submit");
        }
      }
    }

    // 确定下一状态
    const nextStatus = reachedFinalRound
      ? (params.status ?? "reviewed")
      : "pending";

    // CAS 更新 — 防止并发覆盖
    const result = await tx.run(
      `UPDATE answer_block_crops
       SET status = ?, reviewer_id = ?, reviewed_at = ?, review_round = ?,
           score_breakdown = ?
       WHERE id = ? AND review_round = ?${amendment ? " AND status = 'reviewed' AND claimed_by IS NULL" : ""}`,
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

    if (reachedFinalRound) {
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
    if (formalTotalChanged) {
      const recalc = await recomputeExamRankingsCoalesced(db, params.examId);
      rankingsRecalculated = recalc.rankingsRecalculated;
      assignedScoresRecalculated = recalc.assignedScoresRecalculated;
      assignedScoreError = recalc.assignedScoreError;
    }
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
    status: disputed ? "disputed" : (reachedFinalRound ? "reviewed" : "pending"),
    totalScore,
    disputed,
    disputeReason,
    reviewRound: finalReviewRound,
    finalScore,
    rankingsRecalculated,
    rankingError,
    assignedScoresRecalculated,
    assignedScoreError,
    amendmentDeadline: amendment ? new Date(Date.parse(now) + REVIEW_AMENDMENT_WINDOW_MS).toISOString() : undefined
  };
}

export type SubmitReviewCropScoresParams = Omit<ReviewSubmissionParams, "amendment">;

export async function submitReviewCropScores(
  params: SubmitReviewCropScoresParams,
  db: DbAdapter = getMysqlDb()
): Promise<ReviewSubmitResult> {
  return persistReviewVote(params, db);
}

/** 最近已批的限时改票：保留历史票，追加同一评阅人的修订票。 */
export async function amendReviewCropScores(
  params: Omit<SubmitReviewCropScoresParams, "status" | "isAdmin"> & {
    expectedVersion: string;
    user: ReviewActor;
  },
  db: DbAdapter = getMysqlDb()
): Promise<ReviewSubmitResult> {
  return persistReviewVote({
    ...params,
    amendment: { expectedVersion: params.expectedVersion, user: params.user }
  }, db);
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
  db: DbAdapter = getMysqlDb(),
  permittedBlockIds?: string[] | null,
  // 安全 B1：题块级 + 逐生切片级双重收口。溯源表比切块清单更敏感（全卷每题得分 + 评审人），
  // 但两者此前都只收到题块粒度，同块不同切片的学生的分数与轨迹照样读得到。
  assignedSlice?: { sql: string; params: unknown[] } | null
): Promise<ReviewTraceItem[]> {
  let query = `
    SELECT abc.id AS crop_id, abc.student_id, u.name AS student_name,
           u.student_number, abc.block_id, abc.block_title, abc.status,
           abc.score_breakdown, abc.final_score,
           arb.name AS resolved_by
    FROM answer_block_crops abc
    JOIN users u ON u.id = abc.student_id
    LEFT JOIN users arb ON arb.id = abc.final_score_by
    WHERE abc.exam_id = ? AND (${reviewUnitPredicate("abc")} OR abc.review_round > 0)
  `;
  const params: unknown[] = [examId];

  if (blockId) {
    query += " AND abc.block_id = ?";
    params.push(blockId);
  }
  // 安全 R03：题块级阅卷人的溯源只覆盖本人被分配的题块（空集合 = 无行）。
  if (permittedBlockIds) {
    if (permittedBlockIds.length === 0) return [];
    query += ` AND abc.block_id IN (${permittedBlockIds.map(() => "?").join(",")})`;
    params.push(...permittedBlockIds);
  }
  // 安全 B1：题块内再按逐生分配切片收口（同块不同教师的两半学生互相读不到分数与轨迹）
  if (assignedSlice) {
    query += ` AND ${assignedSlice.sql}`;
    params.push(...assignedSlice.params);
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
