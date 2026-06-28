/**
 * 成绩天梯服务 —— 将现有排名数据转换为天梯前十榜单格式。
 */
import type {
  LadderRow,
  RankTrend,
  ScoreTableRow,
  CrossExamTotalRow,
} from "../../shared/types.js";
import { competitionRank } from "../../shared/ranking.js";

export class LadderService {
  /** 计算排名趋势 */
  static getRankTrend(rankChange: number | null): RankTrend {
    if (rankChange === null) return "new";
    if (rankChange > 0) return "up";
    if (rankChange < 0) return "down";
    return "same";
  }

  /** 根据排名和总人数计算百分位 */
  static percentile(rank: number, total: number): number {
    if (total <= 1) return 100;
    return Math.round(((total - rank) / (total - 1)) * 10000) / 100;
  }

  // ── 单场考试 ──

  static fromScoreTableRows(
    rows: ScoreTableRow[],
    totalCount: number,
    currentStudentId?: number,
  ): { top10: LadderRow[]; myRank: number | null; myScore: number | null } {
    const top10: LadderRow[] = rows.slice(0, 10).map((r) => ({
      rank: r.rank,
      studentId: r.studentId,
      studentNumber: r.studentNumber,
      studentName: r.studentName,
      className: r.className,
      classId: r.classId,
      gradeName: r.gradeName ?? null,
      totalScore: r.totalScore,
      assignedScore: r.assignedScore,
      classRank: r.classRank,
      rankTrend: LadderService.getRankTrend(r.rankChange),
      rankChange: r.rankChange,
      prevRank: r.prevRank,
      percentile: LadderService.percentile(r.rank, totalCount),
    }));

    const my = currentStudentId
      ? rows.find((r) => r.studentId === currentStudentId)
      : undefined;

    return {
      top10,
      myRank: my ? my.rank : null,
      myScore: my ? my.totalScore : null,
    };
  }

  // ── 跨考累计 ──

  static fromCrossExamRows(
    rows: CrossExamTotalRow[],
    totalCount: number,
    currentStudentId?: number,
  ): { top10: LadderRow[]; myRank: number | null; myScore: number | null } {
    // 按总分降序、学号升序稳定排序
    const sorted = [...rows].sort(
      (a, b) => b.totalScore - a.totalScore || a.studentNumber.localeCompare(b.studentNumber),
    );
    competitionRank(sorted, (r) => r.totalScore, (r: any, rank: number) => {
      r._rank = rank;
    });

    const top10: LadderRow[] = sorted.slice(0, 10).map((r) => {
      const rank = (r as any)._rank as number;
      return {
        rank,
        studentId: r.studentId,
        studentNumber: r.studentNumber,
        studentName: r.studentName,
        className: r.className,
        classId: r.classId,
        gradeName: r.gradeName,
        totalScore: r.totalScore,
        assignedScore: null,
        classRank: r.classRank,
        rankTrend: "new",
        rankChange: null,
        prevRank: null,
        percentile: LadderService.percentile(rank, totalCount),
      };
    });

    const my = currentStudentId
      ? sorted.find((r) => r.studentId === currentStudentId)
      : undefined;
    const myRank = my ? (my as any)._rank as number : null;
    const myScore = my ? my.totalScore : null;

    return { top10, myRank, myScore };
  }
}
