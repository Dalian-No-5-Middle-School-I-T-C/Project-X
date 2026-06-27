import type { LadderRow } from "../../../../shared/types";
import { LadderRowItem } from "./LadderRowItem";

interface Props {
  rows: LadderRow[];
}

export function LadderLeaderboard({ rows }: Props) {
  if (rows.length === 0) {
    return (
      <div className="scores-empty">
        <p>暂无排名数据</p>
      </div>
    );
  }

  // 满分取第一名分数作为基准
  const maxScore = rows[0]?.totalScore ?? 100;

  return (
    <div className="ladder-leaderboard">
      {rows.map((row) => (
        <LadderRowItem key={row.studentId} row={row} maxScore={maxScore} />
      ))}
    </div>
  );
}
