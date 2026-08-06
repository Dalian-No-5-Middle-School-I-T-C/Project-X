import { ArrowDown, ArrowUp, Crown, Medal, Minus, Trophy } from "lucide-react";
import type { ReactNode } from "react";
import type { LadderRow } from "../../../../shared/types";
import { cn } from "../lib/utils";

interface Props {
  row: LadderRow;
  maxScore: number;
}

// 前三名徽章/进度条的语义配色：金=warning 琥珀、银=secondary、铜=muted
const TOP_STYLES: Record<
  number,
  { badge: string; bar: string; icon: ReactNode }
> = {
  1: {
    badge: "bg-warning-soft text-warning-foreground border-warning-border",
    bar: "bg-warning",
    icon: <Crown size={16} className="text-warning-foreground" />,
  },
  2: {
    badge: "bg-secondary text-secondary-foreground border-border",
    bar: "bg-muted-foreground",
    icon: <Medal size={16} className="text-secondary-foreground" />,
  },
  3: {
    badge: "bg-muted text-muted-foreground border-border",
    bar: "bg-muted-foreground",
    icon: <Trophy size={16} className="text-muted-foreground" />,
  },
};

export function LadderRowItem({ row, maxScore }: Props) {
  const topStyle = TOP_STYLES[row.rank];
  const isTop3 = row.rank <= 3;

  const trendIcon =
    row.rankTrend === "up" ? (
      <span className="inline-flex items-center gap-0.5 text-xs font-medium text-success">
        <ArrowUp size={12} /> {row.rankChange ?? ""}
      </span>
    ) : row.rankTrend === "down" ? (
      <span className="inline-flex items-center gap-0.5 text-xs font-medium text-destructive-fg">
        <ArrowDown size={12} /> {Math.abs(row.rankChange ?? 0)}
      </span>
    ) : row.rankTrend === "new" ? (
      <span className="inline-flex items-center gap-0.5 text-xs font-medium text-info-foreground">
        NEW
      </span>
    ) : (
      <span className="inline-flex items-center gap-0.5 text-xs font-medium text-muted-foreground">
        <Minus size={12} />
      </span>
    );

  // 进度条宽度 = 分数占第一名比例，运行时动态值，无法用静态工具类表达
  const progressPct =
    maxScore > 0 ? Math.min(100, Math.round((row.totalScore / maxScore) * 100)) : 0;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4">
      {/* 排名号 + 主体 */}
      <div className="flex items-center gap-3">
        <div
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-md border",
            isTop3 ? topStyle.badge : "bg-secondary text-secondary-foreground border-border",
          )}
        >
          {isTop3 ? (
            topStyle.icon
          ) : (
            <span className="text-sm font-semibold tabular-nums">{row.rank}</span>
          )}
        </div>

        <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-medium text-foreground">{row.studentName}</span>
            <span className="truncate text-xs text-muted-foreground">
              {row.gradeName ? `${row.gradeName} · ` : ""}
              {row.className}
            </span>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <span className="text-lg font-semibold tabular-nums text-foreground">
              {row.totalScore}
            </span>
            <span className="text-xs text-muted-foreground">分</span>
            <div className="flex items-center gap-2">
              {trendIcon}
              <span className="text-xs text-muted-foreground">班排 {row.classRank}</span>
            </div>
          </div>
        </div>
      </div>

      {/* 进度条 */}
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
        <div
          className={cn("h-full rounded-full", isTop3 ? topStyle.bar : "bg-primary")}
          style={{ width: `${progressPct}%` }}
        />
      </div>

      {/* 科目明细（大考组/跨考场景） */}
      {row.subjectScores && row.subjectScores.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {row.subjectScores.map((s, i) => (
            <span
              key={i}
              className="rounded-md border border-border bg-secondary px-2 py-0.5 text-xs text-secondary-foreground"
            >
              {s.subject}: {s.score}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
