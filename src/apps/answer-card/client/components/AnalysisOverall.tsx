import { useEffect, useState } from "react";
import { fetchJson } from "../auth/api";
import type {
  DistributionResult, ExamMetrics, GroupMetrics
} from "../../../../shared/types";
import type { HistogramBin, NormalityResult, QQPoint, ThresholdBand } from "../../../../shared/stats";
import { DifficultyBadge, DiscriminationBadge } from "./MetricBadge";
import { formatScore } from "../util/format";

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

  useEffect(() => {
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
      .then(([d, m]) => { setDistributions(Array.isArray(d) ? d : []); setMetrics(m as any); })
      .catch((e) => setError(e.message ?? "加载失败"))
      .finally(() => setLoading(false));
  }, [kind, examId, groupId, track]);

  if (loading) return <div style={{ padding: 30, textAlign: "center", color: "var(--muted)" }}>正在加载总体分析...</div>;
  if (error) return <div style={{ padding: 30, color: "#A32D2D" }}>{error}</div>;

  const isGroup = kind === "group";

  return (
    <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 20 }}>
      {/* 难度/区分度总览卡 */}
      <div className="analysis-section">
        <div className="panel-title">难度系数与区分度</div>
        {metrics && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
            <MetricCard label="难度系数 P">
              {metrics.difficulty.toFixed(3)}
            </MetricCard>
            <MetricCard label="区分度 D">
              {metrics.discrimination.toFixed(3)}
            </MetricCard>
            {isGroup ? (
              <>
                <MetricCard label="大考总分满分">{formatScore((metrics as GroupMetrics).totalFullScore)}</MetricCard>
                <MetricCard label="大考总均分">{formatScore((metrics as GroupMetrics).totalAvg)}</MetricCard>
                <MetricCard label="成员考试数">{String((metrics as GroupMetrics).memberCount)}</MetricCard>
              </>
            ) : (
              <>
                <MetricCard label="本卷满分">{formatScore((metrics as ExamMetrics).fullScore)}</MetricCard>
                <MetricCard label="平均得分">{formatScore((metrics as ExamMetrics).avgScore)}</MetricCard>
                <MetricCard label="参考人数">{String((metrics as ExamMetrics).gradedCount)}</MetricCard>
              </>
            )}
          </div>
        )}
        {isGroup && metrics && (metrics as GroupMetrics).subjects.length > 0 && (
          <div style={{ marginTop: 12, overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ background: "var(--bg-soft)", borderBottom: "2px solid var(--line)" }}>
                  <th style={thC}>科目</th><th style={thR}>满分</th><th style={thR}>均分</th>
                  <th style={thR}>难度系数 P</th><th style={thR}>区分度 D</th>
                </tr>
              </thead>
              <tbody>
                {(metrics as GroupMetrics).subjects.map((s) => (
                  <tr key={s.examId} style={{ borderTop: "1px solid var(--line)" }}>
                    <td style={tdC}>{s.subject}</td>
                    <td style={tdR}>{formatScore(s.fullScore)}</td>
                    <td style={tdR}>{formatScore(s.avgScore)}</td>
                    <td style={tdR}><DifficultyBadge value={s.difficulty ?? 0} bands={bands?.difficulty} /></td>
                    <td style={tdR}><DiscriminationBadge value={s.discrimination ?? 0} bands={bands?.discrimination} sampleSize={s.gradedCount} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 分布卡片列表 */}
      {distributions.map((d) => (
        <DistributionCard key={`${d.scope}-${d.scopeId}`} d={d} showTotalNote={!isGroup} bands={bands} />
      ))}
      {distributions.length === 0 && <div className="empty-text">暂无分布数据。</div>}
    </div>
  );
}

function MetricCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="analysis-card" style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 120 }}>
      <div style={{ fontSize: 12, color: "var(--muted)" }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: "var(--text-primary)" }}>{children}</div>
    </div>
  );
}

const thC: React.CSSProperties = { padding: "6px 10px", textAlign: "left", fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", whiteSpace: "nowrap" };
const thR: React.CSSProperties = { ...thC, textAlign: "right" };
const tdC: React.CSSProperties = { padding: "6px 10px", fontSize: 12, whiteSpace: "nowrap" };
const tdR: React.CSSProperties = { ...tdC, textAlign: "right" };

// ── 单个分布卡片：直方图+正态曲线、Q-Q、正态性检验表 ──
function DistributionCard({ d, showTotalNote, bands }: { d: DistributionResult; showTotalNote: boolean; bands?: { difficulty: ThresholdBand[]; discrimination: ThresholdBand[] } }) {
  const n = d.sampleSize;
  const smallSample = n > 0 && n < 30;
  return (
    <div className="analysis-section">
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div className="panel-title" style={{ margin: 0 }}>{d.label} 分布</div>
        <DifficultyBadge value={d.difficulty} bands={bands?.difficulty} />
        <DiscriminationBadge value={d.discrimination} bands={bands?.discrimination} sampleSize={n} />
        <span style={{ fontSize: 12, color: "var(--muted)" }}>样本 {n} · 均分 {formatScore(d.mean)} · 标准差 {formatScore(d.stdDev)}</span>
        {smallSample && <span style={{ fontSize: 11, color: "#E65100", border: "1px solid #E65100", borderRadius: 6, padding: "1px 6px" }}>样本量&lt;30，仅供参考</span>}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 12 }}>
        <HistogramChart bins={d.bins} mean={d.mean} stdDev={d.stdDev} sampleSize={n} segmentSize={d.segmentSize} />
        <QQChart qq={d.qq ?? []} />
      </div>

      <NormalityTable normality={d.normality} />

      <div style={{ marginTop: 10, fontSize: 12, color: "var(--muted)" }}>
        {d.assignedAvailable
          ? "已启用赋分：赋分分布已并入上方直方图（橙色为赋分后）。"
          : (d.scope === "total" && showTotalNote ? "总分分布仅大考可用；本次为普通考试，已省略。" : "未启用赋分：以上为原始分分布。")}
      </div>
    </div>
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
    <div>
      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 4 }}>直方图 + 正态曲线</div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", background: "var(--surface)", borderRadius: 8, border: "1px solid var(--line)" }}>
        {/* y 轴刻度 */}
        <line x1={pl} y1={pt} x2={pl} y2={pt + plotH} stroke="var(--line-strong)" />
        <line x1={pl} y1={pt + plotH} x2={pl + plotW} y2={pt + plotH} stroke="var(--line-strong)" />
        <text x={4} y={pt + 4} fontSize={10} fill="var(--muted)">{maxCount}</text>
        <text x={4} y={pt + plotH} fontSize={10} fill="var(--muted)">0</text>
        {bins.map((b, i) => {
          const x = pl + i * bw;
          const h = (b.count / maxCount) * plotH;
          return (
            <g key={i}>
              <rect x={x + 1} y={pt + plotH - h} width={Math.max(1, bw - 2)} height={h} fill="var(--brand)" opacity={0.55} />
              {i % Math.ceil(n / 12) === 0 && (
                <text x={x + bw / 2} y={pt + plotH + 14} fontSize={9} fill="var(--muted)" textAnchor="middle">{b.min}</text>
              )}
            </g>
          );
        })}
        <polyline points={curvePts.join(" ")} fill="none" stroke="#E65100" strokeWidth={2} />
        {bins.length > 0 && (
          <text x={pl + plotW} y={pt + plotH + 28} fontSize={9} fill="var(--muted)" textAnchor="end">{bins[bins.length - 1].max}</text>
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
      <div>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 4 }}>Q-Q 图</div>
        <div style={{ height: H, display: "flex", alignItems: "center", justifyContent: "center", border: "1px dashed var(--line-strong)", borderRadius: 8, color: "var(--muted)", fontSize: 12 }}>样本不足，无法绘制 Q-Q 图</div>
      </div>
    );
  }
  const xs = qq.map((p) => p.expected), ys = qq.map((p) => p.value);
  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  const ymin = Math.min(...ys), ymax = Math.max(...ys);
  const padX = (xmax - xmin) * 0.05 || 1, padY = (ymax - ymin) * 0.05 || 1;
  const sx = (x: number) => pl + ((x - (xmin - padX)) / ((xmax + padX) - (xmin - padX))) * plotW;
  const sy = (y: number) => pt + plotH - ((y - (ymin - padY)) / ((ymax + padY) - (ymin - padY))) * plotH;
  const pts = qq.map((p) => `${sx(p.expected).toFixed(1)},${sy(p.value).toFixed(1)}`).join(" ");
  // 参考线 y=x（数据空间），映射到屏幕
  const refPts = `${sx(xmin - padX).toFixed(1)},${sy(xmin - padY).toFixed(1)} ${sx(xmax + padX).toFixed(1)},${sy(ymax + padY).toFixed(1)}`;

  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 4 }}>Q-Q 图（样本 vs 理论正态）</div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", background: "var(--surface)", borderRadius: 8, border: "1px solid var(--line)" }}>
        <line x1={pl} y1={pt} x2={pl} y2={pt + plotH} stroke="var(--line-strong)" />
        <line x1={pl} y1={pt + plotH} x2={pl + plotW} y2={pt + plotH} stroke="var(--line-strong)" />
        <line x1={sx(xmin - padX)} y1={sy(ymin - padY)} x2={sx(xmax + padX)} y2={sy(ymax + padY)} stroke="var(--muted)" strokeDasharray="4 4" />
        {qq.map((p, i) => (
          <circle key={i} cx={sx(p.expected)} cy={sy(p.value)} r={2.5} fill="var(--brand)" opacity={0.7} />
        ))}
        <text x={pl + plotW} y={pt + plotH + 28} fontSize={9} fill="var(--muted)" textAnchor="end">理论分位 →</text>
        <text x={6} y={pt + 10} fontSize={9} fill="var(--muted)">样本值 →</text>
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
    <div style={{ marginTop: 12, overflowX: "auto" }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 4 }}>
        正态性检验 {normality.isNormal
          ? <span style={{ color: "var(--success)", fontSize: 12 }}>· 近似正态</span>
          : <span style={{ color: "#A32D2D", fontSize: 12 }}>· 偏离正态</span>}
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr style={{ background: "var(--bg-soft)", borderBottom: "2px solid var(--line)" }}>
            <th style={thC}>检验</th><th style={thR}>统计量</th><th style={thR}>p 值</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, stat, p]) => (
            <tr key={name} style={{ borderTop: "1px solid var(--line)" }}>
              <td style={tdC}>{name}</td><td style={tdR}>{stat}</td><td style={tdR}>{p}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>注：综合判定以 Shapiro-Francia 为主（p≥0.05 视为近似正态）；KS 为 Lilliefors 修正近似，p 值仅作参考；样本 &lt;5 时检验不可靠。</div>
    </div>
  );
}
