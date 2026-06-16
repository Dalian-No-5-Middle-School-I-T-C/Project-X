import type { ClassScoreSummary, ScoreSummary } from "../../../../shared/types";

interface Props {
  summary: ScoreSummary | null;
  overallSummary: ScoreSummary | null;
  classSummaries: ClassScoreSummary[];
  selectedClassId?: string;
}

type PlotItem = {
  id: string;
  label: string;
  summary: ScoreSummary;
  active: boolean;
};

function formatScore(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function clampLabel(label: string): string {
  return label.length > 6 ? `${label.slice(0, 6)}...` : label;
}

export function AnalysisDistribution({ summary, overallSummary, classSummaries, selectedClassId = "" }: Props) {
  if (!summary || !overallSummary || summary.count === 0) return null;

  const items: PlotItem[] = [
    { id: "total", label: "总表", summary: overallSummary, active: selectedClassId === "" },
    ...classSummaries.map((item) => ({
      id: String(item.classId),
      label: item.className,
      summary: item.summary,
      active: selectedClassId === String(item.classId)
    }))
  ];

  const allScores = items.flatMap((item) => [
    item.summary.min,
    item.summary.q1,
    item.summary.median,
    item.summary.q3,
    item.summary.max,
    item.summary.avg
  ]);
  const minDomain = Math.min(...allScores);
  const maxDomain = Math.max(...allScores);
  const span = Math.max(maxDomain - minDomain, 1);
  const pad = span * 0.08;
  const domainMin = minDomain - pad;
  const domainMax = maxDomain + pad;

  const chartWidth = Math.max(420, items.length * 82 + 70);
  const chartHeight = 220;
  const axisX = 44;
  const top = 18;
  const bottom = 156;
  const boxWidth = 34;
  const xFor = (index: number) => axisX + 58 + index * 82;
  const yFor = (score: number) => {
    const ratio = (score - domainMin) / Math.max(domainMax - domainMin, 1);
    return bottom - ratio * (bottom - top);
  };

  const tickValues = Array.from(new Set([minDomain, summary.avg, maxDomain].map((value) => formatScore(value))));
  const labels = [
    { label: "最低", value: summary.min },
    { label: "Q1", value: summary.q1 },
    { label: "中位", value: summary.median },
    { label: "Q3", value: summary.q3 },
    { label: "最高", value: summary.max },
    { label: "均值", value: summary.avg }
  ];

  return (
    <div className="analysis-section">
      <div className="panel-title">分数统计分布</div>
      <div className="boxplot-card">
        <div className="boxplot-scroll">
          <svg width={chartWidth} height={chartHeight} viewBox={`0 0 ${chartWidth} ${chartHeight}`} className="boxplot-chart" role="img" aria-label="分数箱线图">
            <line x1={axisX} y1={top} x2={axisX} y2={bottom} className="boxplot-axis" />
            {tickValues.map((tick) => {
              const y = yFor(Number(tick));
              return (
                <g key={tick}>
                  <line x1={axisX - 5} y1={y} x2={axisX + 5} y2={y} className="boxplot-tick" />
                  <line x1={axisX + 6} y1={y} x2={chartWidth - 24} y2={y} className="boxplot-grid-line" />
                  <text x={axisX - 12} y={y + 4} textAnchor="end" className="boxplot-axis-label">
                    {tick}
                  </text>
                </g>
              );
            })}

            {items.map((item, index) => {
              const s = item.summary;
              const cx = xFor(index);
              const boxClass = item.active ? "boxplot-box boxplot-box-active" : "boxplot-box";
              const strokeClass = item.active ? "boxplot-whisker boxplot-active-stroke" : "boxplot-whisker";
              const medianClass = item.active ? "boxplot-median boxplot-active-stroke" : "boxplot-median";
              const meanClass = item.active ? "boxplot-mean boxplot-mean-active" : "boxplot-mean";
              return (
                <g key={item.id} className="boxplot-group">
                  <line x1={cx} y1={yFor(s.min)} x2={cx} y2={yFor(s.max)} className={strokeClass} />
                  <line x1={cx - 13} y1={yFor(s.min)} x2={cx + 13} y2={yFor(s.min)} className={strokeClass} />
                  <line x1={cx - 13} y1={yFor(s.max)} x2={cx + 13} y2={yFor(s.max)} className={strokeClass} />
                  <rect
                    x={cx - boxWidth / 2}
                    y={yFor(s.q3)}
                    width={boxWidth}
                    height={Math.max(yFor(s.q1) - yFor(s.q3), 1)}
                    rx={6}
                    className={boxClass}
                  />
                  <line x1={cx - boxWidth / 2 - 7} y1={yFor(s.median)} x2={cx + boxWidth / 2 + 7} y2={yFor(s.median)} className={medianClass} />
                  <circle cx={cx} cy={yFor(s.avg)} r={5.5} className={meanClass} />
                  <text x={cx} y={bottom + 22} textAnchor="middle" className={item.active ? "boxplot-class-label active" : "boxplot-class-label"}>
                    {clampLabel(item.label)}
                  </text>
                  <text x={cx} y={bottom + 38} textAnchor="middle" className="boxplot-count-label">
                    {s.count}人
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
        <div className="boxplot-summary-grid">
          {labels.map((item) => (
            <div key={item.label} className="boxplot-summary-item">
              <span>{item.label}</span>
              <strong>{formatScore(item.value)}</strong>
            </div>
          ))}
          <div className="boxplot-summary-item">
            <span>人数</span>
            <strong>{summary.count}</strong>
          </div>
        </div>
      </div>
    </div>
  );
}
