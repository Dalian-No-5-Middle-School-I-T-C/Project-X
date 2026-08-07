import { useCallback, useEffect, useState } from "react";
import { fetchJson } from "../auth/api";
import type {
  DistributionResult, ExamMetrics, GroupMetrics
} from "../../../../shared/types";
import type { HistogramBin, NormalityResult, QQPoint, ThresholdBand } from "../../../../shared/stats";
import { DifficultyBadge, DiscriminationBadge } from "./MetricBadge";
import { formatScore } from "../util/format";
import {
  Badge,
  EmptyState,
  ErrorState,
  StatCard,
  StatCardRow,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableWrap,
} from "./ui/v2";

/**
 * AnalysisOverall —— T2 迁移（T03 主分析页 + 图表子树）
 *
 * 换肤范围（功能守恒，接口/路由/权限零改动）：
 *  · 统计口径、请求编排（distribution × mode + metrics）逐行保留
 *  · 内联 `MetricCard`（.analysis-card + 行内 style）→ v2 `StatCard` / `StatCardRow`
 *  · 两张手写 `<table>`（thC/thR/tdC/tdR style 常量）→ v2 `Table` 原语
 *  · 直方图 / Q-Q 图仍走手写 SVG（图形几何与 chart.js 语义不同，不套 Chart 适配器），
 *    但描边/填充全部换成语义 class：`stroke-border-strong` / `fill-chart-1` /
 *    正态曲线 `stroke-chart-3`，不再出现旧品牌变量与硬编码橙色
 *  · 「样本量<30」提示 → `Badge tone="warning"`；正态/偏离结论 → success / danger 语义色
 *  · 合并 main：#177 文理分科筛选（track 参数，仅 group 生效）
 */

interface Props {
  kind: "exam" | "group";
  examId?: number;
  groupId?: number;
  /** 文理分科筛选（Issue #177，仅 group 生效） */
  track?: "all" | "arts" | "science";
  bands?: { difficulty: ThresholdBand[]; discrimination: ThresholdBand[] };
}

function normalPdf(x: number, mean: number, sd: number): number {
  if (sd <= 0) return 0;
  const z = (x - mean) / sd;
  return Math.exp(-0.5 * z * z) / (sd * Math.sqrt(2 * Math.PI));
}

export function AnalysisOverall({ kind, examId, groupId, track = "all", bands }: Props) {
  const [distributions, setDistributions] = useState<DistributionResult[]>([]);
  const [metrics, setMetrics] = useState<ExamMetrics | GroupMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    setLoading(true); setError("");
    const base = kind === "exam" ? `/api/analysis/exams/${examId}` : `/api/exam-groups/${groupId}`;
    const trackSuffix = kind === "group" ? `&track=${track}` : "";
    const distPromises = kind === "exam"
      ? Promise.all([
          fetchJson<DistributionResult[]>(`${base}/distribution?mode=subject`),
          fetchJson<DistributionResult[]>(`${base}/distribution?mode=class`),
        ]).then(([s, c]) => [...s, ...c])
      : Promise.all([
          fetchJson<DistributionResult[]>(`${base}/distribution?mode=total${trackSuffix}`),
          fetchJson<DistributionResult[]>(`${base}/distribution?mode=subject${trackSuffix}`),
          fetchJson<DistributionResult[]>(`${base}/distribution?mode=class${trackSuffix}`),
        ]).then(([t, s, c]) => [...t, ...s, ...c]);
    const metricPromise = fetchJson<ExamMetrics | GroupMetrics>(`${base}/metrics${kind === "group" ? `?track=${track}` : ""}`);

    Promise.all([distPromises, metricPromise])
      .then(([d, m]) => { setDistributions(Array.isArray(d) ? d : []); setMetrics(m as ExamMetrics | GroupMetrics); })
      .catch((e) => setError(e instanceof Error ? e.message : "加载失败"))
      .finally(() => setLoading(false));
  }, [kind, examId, groupId, track]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="p-8 text-center text-sm text-muted-foreground">正在加载总体分析...</div>;
  if (error) return <ErrorState description={error} onRetry={load} />;

  const isGroup = kind === "group";

  return (
    <div className="flex flex-col gap-5 p-6">
      {/* 难度/区分度总览卡 */}
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-foreground">难度系数与区分度</h3>
        {metrics && (
          <StatCardRow>
            <StatCard label="难度系数 P" value={metrics.difficulty.toFixed(3)} />
            <StatCard label="区分度 D" value={metrics.discrimination.toFixed(3)} />
            {isGroup ? (
              <>
                <StatCard label="大考总分满分" value={formatScore((metrics as GroupMetrics).totalFullScore)} />
                <StatCard label="大考总均分" value={formatScore((metrics as GroupMetrics).totalAvg)} />
                <StatCard label="成员考试数" value={String((metrics as GroupMetrics).memberCount)} />
              </>
            ) : (
              <>
                <StatCard label="本卷满分" value={formatScore((metrics as ExamMetrics).fullScore)} />
                <StatCard label="平均得分" value={formatScore((metrics as ExamMetrics).avgScore)} />
                <StatCard label="参考人数" value={String((metrics as ExamMetrics).gradedCount)} />
              </>
            )}
          </StatCardRow>
        )}
        {isGroup && metrics && (metrics as GroupMetrics).subjects.length > 0 && (
          <TableWrap className="mt-3">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>科目</TableHead>
                  <TableHead numeric>满分</TableHead>
                  <TableHead numeric>均分</TableHead>
                  <TableHead numeric>难度系数 P</TableHead>
                  <TableHead numeric>区分度 D</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(metrics as GroupMetrics).subjects.map((s) => (
                  <TableRow key={s.examId}>
                    <TableCell>{s.subject}</TableCell>
                    <TableCell numeric>{formatScore(s.fullScore)}</TableCell>
                    <TableCell numeric>{formatScore(s.avgScore)}</TableCell>
                    <TableCell numeric>
                      <DifficultyBadge value={s.difficulty ?? 0} bands={bands?.difficulty} />
                    </TableCell>
                    <TableCell numeric>
                      <DiscriminationBadge value={s.discrimination ?? 0} bands={bands?.discrimination} sampleSize={s.gradedCount} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableWrap>
        )}
      </section>

      {/* 分布卡片列表 */}
      {distributions.map((d) => (
        <DistributionCard key={`${d.scope}-${d.scopeId}`} d={d} showTotalNote={!isGroup} bands={bands} />
      ))}
      {distributions.length === 0 && <EmptyState size="sm" title="暂无分布数据" description="完成阅卷后即可查看总体分布。" />}
    </div>
  );
}

// ── 单个分布卡片：直方图+正态曲线、Q-Q、正态性检验表 ──
function DistributionCard({ d, showTotalNote, bands }: { d: DistributionResult; showTotalNote: boolean; bands?: { difficulty: ThresholdBand[]; discrimination: ThresholdBand[] } }) {
  const n = d.sampleSize;
  const smallSample = n > 0 && n < 30;
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-border-subtle bg-card p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-sm font-semibold text-foreground">{d.label} 分布</h3>
        <DifficultyBadge value={d.difficulty} bands={bands?.difficulty} />
        <DiscriminationBadge value={d.discrimination} bands={bands?.discrimination} sampleSize={n} />
        <span className="text-xs tabular-nums text-muted-foreground">
          样本 {n} · 均分 {formatScore(d.mean)} · 标准差 {formatScore(d.stdDev)}
        </span>
        {smallSample && <Badge tone="warning" dot>样本量&lt;30，仅供参考</Badge>}
      </div>

      <div className="mt-3 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <HistogramChart bins={d.bins} mean={d.mean} stdDev={d.stdDev} sampleSize={n} segmentSize={d.segmentSize} />
        <QQChart qq={d.qq ?? []} />
      </div>

      <NormalityTable normality={d.normality} />

      <p className="mt-2 text-xs text-muted-foreground">
        {d.assignedAvailable
          ? "已启用赋分：赋分分布已并入上方直方图（橙色为赋分后）。"
          : (d.scope === "total" && showTotalNote ? "总分分布仅大考可用；本次为普通考试，已省略。" : "未启用赋分：以上为原始分分布。")}
      </p>
    </section>
  );
}

function HistogramChart({ bins, mean, stdDev, sampleSize, segmentSize }: { bins: HistogramBin[]; mean: number; stdDev: number; sampleSize: number; segmentSize: number }) {
  const W = 680, H = 260, pl = 36, pr = 12, pt = 12, pb = 40;
  const plotW = W - pl - pr, plotH = H - pt - pb;
  const maxCount = Math.max(1, ...bins.map((b) => b.count));
  const n = bins.length || 1;
  const bw = plotW / n;
  const y = (c: number) => pt + plotH - (c / maxCount) * plotH;
  const curvePts: string[] = [];
  bins.forEach((b, i) => {
    const center = (b.min + b.max) / 2;
    const expected = normalPdf(center, mean, stdDev) * sampleSize * segmentSize;
    const x = pl + (i + 0.5) * bw;
    curvePts.push(`${x.toFixed(1)},${y(Math.min(expected, maxCount)).toFixed(1)}`);
  });

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-semibold text-secondary-foreground">直方图 + 正态曲线</span>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full rounded-md border border-border-subtle bg-card"
        role="img"
        aria-label="分数直方图与理论正态曲线"
      >
        {/* 坐标轴 */}
        <line x1={pl} y1={pt} x2={pl} y2={pt + plotH} className="stroke-border-strong" />
        <line x1={pl} y1={pt + plotH} x2={pl + plotW} y2={pt + plotH} className="stroke-border-strong" />
        <text x={4} y={pt + 4} fontSize={10} className="fill-muted-foreground tabular-nums">{maxCount}</text>
        <text x={4} y={pt + plotH} fontSize={10} className="fill-muted-foreground tabular-nums">0</text>
        {bins.map((b, i) => {
          const x = pl + i * bw;
          const h = (b.count / maxCount) * plotH;
          return (
            <g key={`${b.min}-${b.max}`}>
              <rect
                x={x + 1}
                y={pt + plotH - h}
                width={Math.max(1, bw - 2)}
                height={h}
                className="fill-chart-1 opacity-55"
              />
              {i % Math.ceil(n / 12) === 0 && (
                <text x={x + bw / 2} y={pt + plotH + 14} fontSize={9} textAnchor="middle" className="fill-muted-foreground tabular-nums">{b.min}</text>
              )}
            </g>
          );
        })}
        <polyline points={curvePts.join(" ")} fill="none" strokeWidth={2} className="stroke-chart-3" />
        {bins.length > 0 && (
          <text x={pl + plotW} y={pt + plotH + 28} fontSize={9} textAnchor="end" className="fill-muted-foreground tabular-nums">{bins[bins.length - 1].max}</text>
        )}
      </svg>
    </div>
  );
}

function QQChart({ qq }: { qq: QQPoint[] }) {
  const W = 680, H = 260, pl = 40, pr = 12, pt = 12, pb = 36;
  const plotW = W - pl - pr, plotH = H - pt - pb;
  if (qq.length < 3) {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-xs font-semibold text-secondary-foreground">Q-Q 图</span>
        <div className="flex h-65 items-center justify-center rounded-md border border-dashed border-border-strong text-xs text-muted-foreground">
          样本不足，无法绘制 Q-Q 图
        </div>
      </div>
    );
  }
  const xs = qq.map((p) => p.expected), ys = qq.map((p) => p.value);
  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  const ymin = Math.min(...ys), ymax = Math.max(...ys);
  const padX = (xmax - xmin) * 0.05 || 1, padY = (ymax - ymin) * 0.05 || 1;
  const sx = (x: number) => pl + ((x - (xmin - padX)) / ((xmax + padX) - (xmin - padX))) * plotW;
  const sy = (v: number) => pt + plotH - ((v - (ymin - padY)) / ((ymax + padY) - (ymin - padY))) * plotH;

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-semibold text-secondary-foreground">Q-Q 图（样本 vs 理论正态）</span>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full rounded-md border border-border-subtle bg-card"
        role="img"
        aria-label="样本分位与理论正态分位对照图"
      >
        <line x1={pl} y1={pt} x2={pl} y2={pt + plotH} className="stroke-border-strong" />
        <line x1={pl} y1={pt + plotH} x2={pl + plotW} y2={pt + plotH} className="stroke-border-strong" />
        <line
          x1={sx(xmin - padX)} y1={sy(ymin - padY)} x2={sx(xmax + padX)} y2={sy(ymax + padY)}
          strokeDasharray="4 4"
          className="stroke-muted-foreground"
        />
        {qq.map((p, i) => (
          <circle key={i} cx={sx(p.expected)} cy={sy(p.value)} r={2.5} className="fill-chart-1 opacity-70" />
        ))}
        <text x={pl + plotW} y={pt + plotH + 28} fontSize={9} textAnchor="end" className="fill-muted-foreground">理论分位 →</text>
        <text x={6} y={pt + 10} fontSize={9} className="fill-muted-foreground">样本值 →</text>
      </svg>
    </div>
  );
}

function NormalityTable({ normality }: { normality: NormalityResult }) {
  const fmt = (v: number | null) => (v == null ? "—" : (Math.abs(v) < 0.001 ? "0" : v.toFixed(3)));
  const rows: Array<[string, string, string]> = [
    ["Shapiro-Francia", `W=${fmt(normality.shapiroFrancia.W)}`, `p=${fmt(normality.shapiroFrancia.pValue)}`],
    ["Kolmogorov-Smirnov", `D=${fmt(normality.kolmogorovSmirnov.D)}`, `p=${fmt(normality.kolmogorovSmirnov.pValue)}`],
    ["Anderson-Darling", `A²=${fmt(normality.andersonDarling.A2)}`, `p=${fmt(normality.andersonDarling.pValue)}`],
    ["偏度 Skewness", fmt(normality.skewness), ""],
    ["峰度 Kurtosis", fmt(normality.kurtosis), ""],
  ];
  return (
    <div className="mt-3 flex flex-col gap-1">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-secondary-foreground">
        正态性检验
        {normality.isNormal
          ? <Badge tone="success" dot>近似正态</Badge>
          : <Badge tone="danger" dot>偏离正态</Badge>}
      </div>
      <TableWrap>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>检验</TableHead>
              <TableHead numeric>统计量</TableHead>
              <TableHead numeric>p 值</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(([name, stat, p]) => (
              <TableRow key={name}>
                <TableCell>{name}</TableCell>
                <TableCell numeric>{stat}</TableCell>
                <TableCell numeric>{p}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableWrap>
      <p className="mt-1 text-xs text-muted-foreground">注：p≥0.05 视为不拒绝正态假设（常规阈值）。</p>
    </div>
  );
}
