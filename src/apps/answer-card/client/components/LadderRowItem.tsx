import { ArrowDown, ArrowUp, Crown, Medal, Minus, Trophy } from "lucide-react";
import type { LadderRow } from "../../../../shared/types";

interface Props {
  row: LadderRow;
  maxScore: number;
}

const TOP_COLORS: Record<number, { bg: string; text: string; icon: React.ReactNode }> = {
  1: {
    bg: "linear-gradient(135deg, #FFD700, #FFA500)",
    text: "#5C3D00",
    icon: <Crown size={16} fill="#FFD700" stroke="#B8860B" />,
  },
  2: {
    bg: "linear-gradient(135deg, #E8E8E8, #B0B0B0)",
    text: "#3A3A3A",
    icon: <Medal size={16} fill="#C0C0C0" stroke="#808080" />,
  },
  3: {
    bg: "linear-gradient(135deg, #E8A960, #CD853F)",
    text: "#3D2000",
    icon: <Trophy size={16} fill="#CD853F" stroke="#8B6914" />,
  },
};

export function LadderRowItem({ row, maxScore }: Props) {
  const topStyle = TOP_COLORS[row.rank];
  const isTop3 = row.rank <= 3;

  const trendIcon =
    row.rankTrend === "up" ? (
      <span className="ladder-trend ladder-trend-up">
        <ArrowUp size={12} /> {row.rankChange ?? ""}
      </span>
    ) : row.rankTrend === "down" ? (
      <span className="ladder-trend ladder-trend-down">
        <ArrowDown size={12} /> {Math.abs(row.rankChange ?? 0)}
      </span>
    ) : row.rankTrend === "new" ? (
      <span className="ladder-trend ladder-trend-new">NEW</span>
    ) : (
      <span className="ladder-trend ladder-trend-same">
        <Minus size={12} />
      </span>
    );

  const progressPct = maxScore > 0 ? Math.min(100, Math.round((row.totalScore / maxScore) * 100)) : 0;

  return (
    <div className={`ladder-row ${isTop3 ? `ladder-row-top-${row.rank}` : ""}`}>
      {/* 排名号 */}
      <div
        className="ladder-rank-badge"
        style={
          isTop3
            ? { background: topStyle.bg, color: topStyle.text }
            : undefined
        }
      >
        {isTop3 ? topStyle.icon : <span className="ladder-rank-num">{row.rank}</span>}
      </div>

      {/* 连接线 */}
      <div className="ladder-connector" />

      {/* 主体信息 */}
      <div className="ladder-row-body">
        <div className="ladder-row-info">
          <span className="ladder-student-name">{row.studentName}</span>
          <span className="ladder-student-class">
            {row.gradeName ? `${row.gradeName} · ` : ""}{row.className}
          </span>
        </div>

        <div className="ladder-row-right">
          <span className="ladder-score">{row.totalScore}</span>
          <span className="ladder-score-unit">分</span>
          <div className="ladder-row-extra">
            {trendIcon}
            <span className="ladder-class-rank">班排 {row.classRank}</span>
          </div>
        </div>
      </div>

      {/* 进度条 */}
      <div className="ladder-progress">
        <div
          className={`ladder-progress-fill ${isTop3 ? `ladder-progress-top-${row.rank}` : ""}`}
          style={{ width: `${progressPct}%` }}
        />
      </div>

      {/* 可展开的科目明细（大考组/跨考场景） */}
      {row.subjectScores && row.subjectScores.length > 0 && (
        <div className="ladder-subjects">
          {row.subjectScores.map((s, i) => (
            <span key={i} className="ladder-subject-chip">
              {s.subject}: {s.score}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
