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
      {/* 后端截断线不切开同分并列，条数可能超过 10；标题说明多出来的人从哪来 */}
      {rows.length > 10 && (
        <div className="text-xs text-muted-foreground">
          前十 · 同分并列全显（共 {rows.length} 人）
        </div>
      )}
      {rows.map((row) => (
        <LadderRowItem key={row.studentId} row={row} maxScore={maxScore} />
      ))}
    </div>
  );
}
