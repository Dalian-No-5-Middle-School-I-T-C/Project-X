import type { LadderRow } from "../../../../shared/types";
import { EmptyState } from "./ui/v2";
import { LadderRowItem } from "./LadderRowItem";

interface Props {
  rows: LadderRow[];
}

export function LadderLeaderboard({ rows }: Props) {
  if (rows.length === 0) {
    return <EmptyState size="sm" title="暂无排名数据" />;
  }

  // 满分取第一名分数作为基准
  const maxScore = rows[0]?.totalScore ?? 100;

  return (
    <div className="flex flex-col gap-3">
      {rows.map((row) => (
        <LadderRowItem key={row.studentId} row={row} maxScore={maxScore} />
      ))}
    </div>
  );
}
