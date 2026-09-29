/**
 * 竞赛排名（competition ranking）：同分同名，下一名跳过。
 * 例如：1, 2, 2, 4, 5, 5, 7...
 * 与数学上的 dense ranking（1,2,2,3,4,4,5）不同。
 * 假设 rows 已按 score 降序排列。
 */
export function competitionRank<T>(
  rows: T[],
  score: (row: T) => number,
  setRank: (row: T, rank: number) => void
): void {
  let prevScore: number | null = null;
  let prevRank = 0;
  for (let i = 0; i < rows.length; i++) {
    const s = score(rows[i]);
    if (prevScore !== null && s === prevScore) {
      setRank(rows[i], prevRank);
    } else {
      const rank = i + 1;
      setRank(rows[i], rank);
      prevRank = rank;
    }
    prevScore = s;
  }
}

/** 天梯榜单常规长度 */
export const LADDER_TOP_N = 10;

/**
 * 天梯截断：取前 LADDER_TOP_N 名，但截断线不切开任何并列区间——
 * 第 10 条若与后一条同名次，就顺延到该并列组结束，同分学生不会被拆成「上榜 / 落榜」两半。
 * rows 需已按名次升序排列（与 competitionRank 的降序入参约定一致）。
 */
export function takeLadder<T>(
  rows: T[],
  rankOf: (row: T) => number,
  topN: number = LADDER_TOP_N
): T[] {
  let end = Math.min(topN, rows.length);
  while (end < rows.length && rankOf(rows[end]) === rankOf(rows[end - 1])) end += 1;
  return rows.slice(0, end);
}
