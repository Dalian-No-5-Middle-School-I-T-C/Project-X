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
