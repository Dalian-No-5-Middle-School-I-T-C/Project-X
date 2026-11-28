/**
 * 统一的 student_scores 排名/百分位重算逻辑。
 *
 * 历史上 score-editing.ts 与 ReviewService.ts 各有一份重复实现，且都用
 * 顺序名次（i+1，同分不并列）与"百分位公式 B"，与项目其它位置
 * （ScoreRepository / LadderService / AnalysisRepository）使用的
 * competitionRank（同分并列）+ 百分位公式 A 不一致。
 *
 * 本模块收敛为单一实现：
 * - 名次：competitionRank（同分同名，下一名跳过）
 * - 百分位：公式 A `(total - rank) / (total - 1) * 100`（末名 0），并做下限裁剪
 * - total_score 入库前统一 roundScore，避免浮点误差破坏并列判定
 */
import type { DbAdapter } from "../db";
import { analysisCache } from "./analysisCache";
import { competitionRank } from "../../shared/ranking";
import { AssignedScoreService } from "./AssignedScoreService";

/** 与 shared/grading.ts 一致的 3 位小数舍入。 */
export function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** 公式 A 百分位（保留 1 位小数，下限 0）。 */
export function rankPercentile(rank: number, total: number): number {
  if (total <= 1) return 100;
  const raw = ((total - rank) / (total - 1)) * 100;
  return Math.max(0, Math.round(raw * 10) / 10);
}

/**
 * 重算某场考试所有学生的 rank / percentile，并触发赋分重算。
 * 使用 competitionRank，确保与全局排名逻辑一致。
 * 返回分项结果：排名失败会直接抛出（由调用方决定如何反馈）；
 * 赋分失败不再静默吞掉，通过 assignedScoresRecalculated / assignedScoreError 上报。
 */
export interface RankingRecalcResult {
  /** 排名/百分位是否成功更新（失败时 recomputeExamRankings 会抛出） */
  rankingsRecalculated: boolean;
  /** 赋分是否成功重算 */
  assignedScoresRecalculated: boolean;
  assignedScoreError?: string;
}

export async function recomputeExamRankings(db: DbAdapter, examId: number): Promise<RankingRecalcResult> {
  // 即使后续重算失败，也不能继续返回变更前的统计缓存。
  analysisCache.invalidateExam(examId);
  const allStudents = await db.all(
    "SELECT id, total_score FROM student_scores WHERE exam_id = ? ORDER BY total_score DESC",
    examId
  ) as Array<{ id: number; total_score: number }>;
  if (allStudents.length === 0) {
    return { rankingsRecalculated: true, assignedScoresRecalculated: true };
  }

  const n = allStudents.length;
  const ranks = new Map<number, number>();
  competitionRank(
    allStudents,
    (row) => roundScore(Number(row.total_score ?? 0)),
    (row, rank) => ranks.set(row.id, rank)
  );

  // 单条 CASE WHEN 批量更新，避免每名学生一次 UPDATE；两方言均支持绑定参数。
  const rankCases: string[] = [];
  const percentileCases: string[] = [];
  const params: unknown[] = [];
  const ids: number[] = [];
  for (const student of allStudents) {
    const rank = ranks.get(student.id) ?? 1;
    rankCases.push("WHEN ? THEN ?");
    percentileCases.push("WHEN ? THEN ?");
    params.push(student.id, rank, student.id, rankPercentile(rank, n));
    ids.push(student.id);
  }
  params.push(...ids);
  await db.run(
    `UPDATE student_scores
     SET \`rank\` = CASE id ${rankCases.join(" ")} ELSE \`rank\` END,
         percentile = CASE id ${percentileCases.join(" ")} ELSE percentile END
     WHERE id IN (${ids.map(() => "?").join(",")})`,
    ...params
  );

  let assignedScoresRecalculated = true;
  let assignedScoreError: string | undefined;
  try {
    const assignedService = new AssignedScoreService();
    await assignedService.recalculateAll(examId, db);
  } catch (err) {
    // 赋分失败不再静默：返回分项结果供调用方反馈（rankingsRecalculated 仍为 true）
    assignedScoresRecalculated = false;
    assignedScoreError = err instanceof Error ? err.message : String(err);
  }
  analysisCache.invalidateExam(examId);
  return { rankingsRecalculated: true, assignedScoresRecalculated, assignedScoreError };
}

type RankingWaiter = {
  request: number;
  resolve: (result: RankingRecalcResult) => void;
  reject: (error: unknown) => void;
};

type RankingQueueState = {
  requested: number;
  completed: number;
  running: boolean;
  waiters: RankingWaiter[];
};

const rankingQueues = new Map<number, RankingQueueState>();

/**
 * 按考试合并在途排名重算。请求落在同一次查询期间时只追加一次后续重算，
 * 每个调用方都等到覆盖自己提交序号的那一轮完成，避免复用旧 Promise 漏掉新分数。
 */
export function recomputeExamRankingsCoalesced(db: DbAdapter, examId: number): Promise<RankingRecalcResult> {
  let state = rankingQueues.get(examId);
  if (!state) {
    state = { requested: 0, completed: 0, running: false, waiters: [] };
    rankingQueues.set(examId, state);
  }
  state.requested += 1;
  const request = state.requested;
  const result = new Promise<RankingRecalcResult>((resolve, reject) => {
    state!.waiters.push({ request, resolve, reject });
  });
  if (!state.running) {
    state.running = true;
    void drainRankingQueue(state, db, examId);
  }
  return result;
}

async function drainRankingQueue(state: RankingQueueState, db: DbAdapter, examId: number): Promise<void> {
  while (state.requested > state.completed) {
    const target = state.requested;
    let result: RankingRecalcResult | undefined;
    let failure: unknown;
    try {
      result = await recomputeExamRankings(db, examId);
    } catch (error) {
      failure = error;
    }
    state.completed = target;
    const ready = state.waiters.filter((waiter) => waiter.request <= target);
    state.waiters = state.waiters.filter((waiter) => waiter.request > target);
    for (const waiter of ready) {
      if (result) waiter.resolve(result);
      else waiter.reject(failure);
    }
  }
  state.running = false;
  if (state.waiters.length === 0) rankingQueues.delete(examId);
}
