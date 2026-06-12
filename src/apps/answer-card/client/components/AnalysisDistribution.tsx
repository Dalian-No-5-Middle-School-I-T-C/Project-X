import type { ExamOverview } from "../../../../shared/types";

interface Props {
  distribution: ExamOverview["distribution"];
}

export function AnalysisDistribution({ distribution }: Props) {
  if (!distribution || distribution.length === 0) return null;

  const maxCount = Math.max(...distribution.map((d) => d.count), 1);
  const barWidth = 40;
  const barGap = 12;
  const barMaxHeight = 120;
  const chartWidth = distribution.length * (barWidth + barGap);
  const chartHeight = barMaxHeight + 48;

  return (
    <div className="analysis-section">
      <div className="panel-title">分数分布</div>
      <svg viewBox={`0 0 ${chartWidth + 20} ${chartHeight}`} className="distribution-chart">
        {distribution.map((d, idx) => {
          const barH = (d.count / maxCount) * barMaxHeight;
          const x = 10 + idx * (barWidth + barGap);
          const y = chartHeight - 24 - barH;
          return (
            <g key={d.range}>
              <rect
                x={x}
                y={y}
                width={barWidth}
                height={barH}
                rx={4}
                fill={barH / barMaxHeight > 0.5 ? "#23574d" : "#86b3a8"}
              />
              <text
                x={x + barWidth / 2}
                y={y - 6}
                textAnchor="middle"
                fontSize="11"
                fill="#66746f"
              >
                {d.count}
              </text>
              <text
                x={x + barWidth / 2}
                y={chartHeight - 6}
                textAnchor="middle"
                fontSize="11"
                fill="#66746f"
              >
                {d.range}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
