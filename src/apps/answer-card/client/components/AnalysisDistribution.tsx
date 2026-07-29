import { BarChart3 } from "lucide-react";
import type { ClassScoreSummary, ScoreSummary } from "../../../../shared/types";
import { formatScore } from "../util/format";

interface Props {
  summary: ScoreSummary | null;
  overallSummary: ScoreSummary | null;
  classSummaries: ClassScoreSummary[];
  selectedClassId?: string;
  onClassSelect?: (classId: string) => void;
}

type PlotItem = {
  id: string;
  label: string;
  summary: ScoreSummary;
  active: boolean;
};

function clampLabel(label: string): string {
  return label.length > 8 ? `${label.slice(0, 8)}…` : label;
}

export function AnalysisDistribution({
  summary,
  overallSummary,
  classSummaries,
  selectedClassId = "",
  onClassSelect
}: Props) {
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
  const pad = span * 0.1;
  const domainMin = minDomain - pad;
  const domainMax = maxDomain + pad;

  const chartWidth = Math.max(460, items.length * 88 + 80);
  const chartHeight = 248;
  const axisX = 48;
  const top = 20;
  const bottom = 168;
  const boxWidth = 36;
  const xFor = (index: number) => axisX + 62 + index * 88;
  const yFor = (score: number) => {
    const ratio = (score - domainMin) / Math.max(domainMax - domainMin, 1);
    return bottom - ratio * (bottom - top);
  };

  const tickValues = Array.from(
    new Set(
      [domainMin, summary.avg, domainMax].map((value) => Math.round(value * 10) / 10)
    )
  ).sort((a, b) => b - a);

  const labels = [
    { label: "最低", value: summary.min },
    { label: "Q1", value: summary.q1 },
    { label: "中位", value: summary.median },
    { label: "Q3", value: summary.q3 },
    { label: "最高", value: summary.max },
    { label: "均值", value: summary.avg }
  ];

  function handleSelect(item: PlotItem) {
    if (!onClassSelect) return;
    onClassSelect(item.id === "total" ? "" : item.id);
  }

  return (
    <div className="analysis-section">
      <div className="boxplot-header">
        <div className="panel-title" style={{ margin: 0 }}>
          <BarChart3 size={17} />
          分数统计分布
        </div>
        {onClassSelect && classSummaries.length > 0 && (
          <span className="boxplot-hint">点击柱形可筛选班级</span>
        )}
      </div>
      <div className="boxplot-card">
        <div className="boxplot-legend" aria-hidden="true">
          <span><i className="boxplot-legend-whisker" />极值</span>
          <span><i className="boxplot-legend-box" />四分位</span>
          <span><i className="boxplot-legend-median" />中位数</span>
          <span><i className="boxplot-legend-mean" />均值</span>
        </div>
        <div className="boxplot-scroll">
          <svg
            width={chartWidth}
            height={chartHeight}
            viewBox={`0 0 ${chartWidth} ${chartHeight}`}
            className="boxplot-chart"
            role="img"
            aria-label="分数箱线图"
          >
            <line x1={axisX} y1={top} x2={axisX} y2={bottom} className="boxplot-axis" />
            {tickValues.map((tick) => {
              const y = yFor(tick);
              return (
                <g key={tick}>
                  <line x1={axisX - 6} y1={y} x2={axisX + 6} y2={y} className="boxplot-tick" />
                  <line x1={axisX + 8} y1={y} x2={chartWidth - 20} y2={y} className="boxplot-grid-line" />
                  <text x={axisX - 10} y={y + 4} textAnchor="end" className="boxplot-axis-label">
                    {formatScore(tick)}
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
              const interactive = Boolean(onClassSelect);
              const title = `${item.label}：${s.count}人，均分 ${formatScore(s.avg)}，中位 ${formatScore(s.median)}`;

              return (
                <g
                  key={item.id}
                  className={`boxplot-group${item.active ? " boxplot-group-active" : ""}${interactive ? " boxplot-group-clickable" : ""}`}
                  role={interactive ? "button" : undefined}
                  tabIndex={interactive ? 0 : undefined}
                  aria-label={interactive ? `筛选 ${item.label}` : undefined}
                  aria-pressed={interactive ? item.active : undefined}
                  onClick={interactive ? () => handleSelect(item) : undefined}
                  onKeyDown={
                    interactive
                      ? (event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            handleSelect(item);
                          }
                        }
                      : undefined
                  }
                >
                  {interactive && (
                    <rect
                      x={cx - 40}
                      y={top - 4}
                      width={80}
                      height={bottom - top + 52}
                      fill="transparent"
                      className="boxplot-hit-area"
                    />
                  )}
                  <title>{title}</title>
                  <line x1={cx} y1={yFor(s.min)} x2={cx} y2={yFor(s.max)} className={strokeClass} />
                  <line x1={cx - 14} y1={yFor(s.min)} x2={cx + 14} y2={yFor(s.min)} className={strokeClass} />
                  <line x1={cx - 14} y1={yFor(s.max)} x2={cx + 14} y2={yFor(s.max)} className={strokeClass} />
                  <rect
                    x={cx - boxWidth / 2}
                    y={yFor(s.q3)}
                    width={boxWidth}
                    height={Math.max(yFor(s.q1) - yFor(s.q3), 2)}
                    rx={6}
                    className={boxClass}
                  />
                  <line
                    x1={cx - boxWidth / 2 - 8}
                    y1={yFor(s.median)}
                    x2={cx + boxWidth / 2 + 8}
                    y2={yFor(s.median)}
                    className={medianClass}
                  />
                  <circle cx={cx} cy={yFor(s.avg)} r={6} className={meanClass} />
                  <text
                    x={cx}
                    y={bottom + 24}
                    textAnchor="middle"
                    className={item.active ? "boxplot-class-label active" : "boxplot-class-label"}
                  >
                    {clampLabel(item.label)}
                  </text>
                  <text x={cx} y={bottom + 40} textAnchor="middle" className="boxplot-count-label">
                    {s.count}人 · μ{formatScore(s.avg)}
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
          <div className="boxplot-summary-item boxplot-summary-item-highlight">
            <span>人数</span>
            <strong>{summary.count}</strong>
          </div>
        </div>
      </div>
    </div>
  );
}
