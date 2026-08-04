import { BarChart3 } from "lucide-react";
import type { ClassScoreSummary, ScoreSummary } from "../../../../shared/types";
import { cn } from "../lib/utils";
import { formatScore } from "../util/format";

/**
 * 班级分数箱线图（手绘 SVG）。
 *
 * 迁移说明：保留原 SVG 绘制与「点击柱形筛选班级」交互，
 * 仅把 `boxplot-*` 旧工具类换成 Tailwind 语义类
 * （描边/网格/文字走 border-*、foreground、muted-foreground 系列），
 * 全文件零硬编码十六进制、零内联 style。
 */

interface Props {
  summary: ScoreSummary | null;
  overallSummary: ScoreSummary | null;
  classSummaries: ClassScoreSummary[];
  selectedClassId?: string;
  onClassSelect?: (classId: string) => void;
  /** 是否渲染组件内部标题（默认 true）。外层已有标题时传 false 避免重复 */
  showTitle?: boolean;
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
  onClassSelect,
  showTitle = true,
}: Props) {
  if (!summary || !overallSummary || summary.count === 0) return null;

  const items: PlotItem[] = [
    {
      id: "total",
      label: "总表",
      summary: overallSummary,
      active: selectedClassId === "",
    },
    ...classSummaries.map((item) => ({
      id: String(item.classId),
      label: item.className,
      summary: item.summary,
      active: selectedClassId === String(item.classId),
    })),
  ];

  const allScores = items.flatMap((item) => [
    item.summary.min,
    item.summary.q1,
    item.summary.median,
    item.summary.q3,
    item.summary.max,
    item.summary.avg,
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
      [domainMin, summary.avg, domainMax].map(
        (value) => Math.round(value * 10) / 10,
      ),
    ),
  ).sort((a, b) => b - a);

  const labels = [
    { label: "最低", value: summary.min },
    { label: "Q1", value: summary.q1 },
    { label: "中位", value: summary.median },
    { label: "Q3", value: summary.q3 },
    { label: "最高", value: summary.max },
    { label: "均值", value: summary.avg },
  ];

  function handleSelect(item: PlotItem) {
    if (!onClassSelect) return;
    onClassSelect(item.id === "total" ? "" : item.id);
  }

  return (
    <div className="flex min-h-0 flex-col gap-3">
      {(showTitle || (onClassSelect && classSummaries.length > 0)) && (
        <div className="flex items-center justify-between gap-3">
          {showTitle ? (
            <div className="flex items-center gap-2 text-base font-semibold text-foreground">
              <BarChart3 className="size-4 text-muted-foreground" />
              分数统计分布
            </div>
          ) : (
            <span />
          )}
          {onClassSelect && classSummaries.length > 0 && (
            <span className="shrink-0 text-xs text-muted-foreground">
              点击柱形可筛选班级
            </span>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col rounded-lg border border-border-subtle bg-card p-4">
        <div
          className="mb-2.5 flex flex-wrap items-center gap-3.5 text-xs text-muted-foreground"
          aria-hidden="true"
        >
          <span className="inline-flex items-center gap-1.5">
            <i className="inline-block h-3.5 w-0.5 rounded-full bg-border-strong" />
            极值
          </span>
          <span className="inline-flex items-center gap-1.5">
            <i className="inline-block h-3 w-4 rounded-xs border-2 border-border-strong bg-secondary" />
            四分位
          </span>
          <span className="inline-flex items-center gap-1.5">
            <i className="inline-block h-[3px] w-4.5 rounded-full bg-foreground" />
            中位数
          </span>
          <span className="inline-flex items-center gap-1.5">
            <i className="inline-block size-2.5 rounded-full border-2 border-card bg-chart-1 ring-1 ring-chart-1" />
            均值
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden text-center">
          <svg
            width={chartWidth}
            height={chartHeight}
            viewBox={`0 0 ${chartWidth} ${chartHeight}`}
            className="inline-block max-w-none"
            role="img"
            aria-label="分数箱线图"
          >
            <line
              x1={axisX}
              y1={top}
              x2={axisX}
              y2={bottom}
              className="stroke-border-strong"
              strokeWidth={1.6}
            />
            {tickValues.map((tick) => {
              const y = yFor(tick);
              return (
                <g key={tick}>
                  <line
                    x1={axisX - 6}
                    y1={y}
                    x2={axisX + 6}
                    y2={y}
                    className="stroke-border-strong"
                    strokeWidth={1.6}
                  />
                  <line
                    x1={axisX + 8}
                    y1={y}
                    x2={chartWidth - 20}
                    y2={y}
                    className="stroke-border-subtle"
                    strokeWidth={1}
                  />
                  <text
                    x={axisX - 10}
                    y={y + 4}
                    textAnchor="end"
                    className="fill-foreground text-xs font-semibold tabular-nums"
                  >
                    {formatScore(tick)}
                  </text>
                </g>
              );
            })}

            {items.map((item, index) => {
              const s = item.summary;
              const cx = xFor(index);
              const interactive = Boolean(onClassSelect);
              const title = `${item.label}：${s.count}人，均分 ${formatScore(s.avg)}，中位 ${formatScore(s.median)}`;

              return (
                <g
                  key={item.id}
                  className={cn("group", interactive && "cursor-pointer")}
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
                      className="fill-transparent outline-none"
                    />
                  )}
                  <title>{title}</title>
                  <line
                    x1={cx}
                    y1={yFor(s.min)}
                    x2={cx}
                    y2={yFor(s.max)}
                    className={cn(
                      item.active ? "stroke-primary" : "stroke-border-strong",
                    )}
                    strokeWidth={1.6}
                  />
                  <line
                    x1={cx - 14}
                    y1={yFor(s.min)}
                    x2={cx + 14}
                    y2={yFor(s.min)}
                    className={cn(
                      item.active ? "stroke-primary" : "stroke-border-strong",
                    )}
                    strokeWidth={1.6}
                  />
                  <line
                    x1={cx - 14}
                    y1={yFor(s.max)}
                    x2={cx + 14}
                    y2={yFor(s.max)}
                    className={cn(
                      item.active ? "stroke-primary" : "stroke-border-strong",
                    )}
                    strokeWidth={1.6}
                  />
                  <rect
                    x={cx - boxWidth / 2}
                    y={yFor(s.q3)}
                    width={boxWidth}
                    height={Math.max(yFor(s.q1) - yFor(s.q3), 2)}
                    rx={6}
                    className={cn(
                      item.active
                        ? "fill-accent stroke-primary"
                        : "fill-secondary stroke-border-strong group-hover:fill-muted",
                    )}
                    strokeWidth={item.active ? 2.2 : 1.8}
                  />
                  <line
                    x1={cx - boxWidth / 2 - 8}
                    y1={yFor(s.median)}
                    x2={cx + boxWidth / 2 + 8}
                    y2={yFor(s.median)}
                    className={cn(
                      item.active ? "stroke-primary" : "stroke-foreground",
                    )}
                    strokeWidth={2.6}
                  />
                  <circle
                    cx={cx}
                    cy={yFor(s.avg)}
                    r={6}
                    className={cn(
                      "stroke-card",
                      item.active ? "fill-primary" : "fill-chart-1",
                    )}
                    strokeWidth={2.2}
                  />
                  <text
                    x={cx}
                    y={bottom + 24}
                    textAnchor="middle"
                    className={cn(
                      "font-bold",
                      item.active
                        ? "fill-primary text-[13px]"
                        : "fill-foreground text-xs",
                    )}
                  >
                    {clampLabel(item.label)}
                  </text>
                  <text
                    x={cx}
                    y={bottom + 40}
                    textAnchor="middle"
                    className="fill-muted-foreground text-[11px] tabular-nums"
                  >
                    {s.count}人 · μ{formatScore(s.avg)}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>

        <div className="mt-2.5 grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-7">
          {labels.map((item) => (
            <div
              key={item.label}
              className="flex min-w-0 flex-col gap-0.5 rounded-md border border-border-subtle bg-secondary px-2 py-2.5"
            >
              <span className="text-[11px] text-muted-foreground">
                {item.label}
              </span>
              <strong className="text-sm font-semibold tabular-nums text-foreground">
                {formatScore(item.value)}
              </strong>
            </div>
          ))}
          <div className="flex min-w-0 flex-col gap-0.5 rounded-md border border-accent-border bg-accent px-2 py-2.5">
            <span className="text-[11px] text-muted-foreground">人数</span>
            <strong className="text-sm font-semibold tabular-nums text-foreground">
              {summary.count}
            </strong>
          </div>
        </div>
      </div>
    </div>
  );
}
