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

  for (const student of allStudents) {
    const rank = ranks.get(student.id) ?? 1;
    await db.run(
      "UPDATE student_scores SET `rank` = ?, percentile = ? WHERE id = ?",
      rank,
      rankPercentile(rank, n),
      student.id
    );
  }

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
  return { rankingsRecalculated: true, assignedScoresRecalculated, assignedScoreError };
}
