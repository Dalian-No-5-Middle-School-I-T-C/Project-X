/**
 * 成绩分析统计工具（零依赖，前后端共用）
 *
 * 提供：描述统计、难度系数 P、区分度 D（极端组法）、分数段直方图、
 * Q-Q 图数据、正态性检验（Shapiro-Francia / Kolmogorov-Smirnov / Anderson-Darling）、
 * 偏度/峰度，以及难度/区分度档位判定。
 *
 * 所有函数均为纯函数，便于单测与确定性计算。
 */

// ── 基础描述统计 ──────────────────────────────────

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** 总体标准差（除以 n） */
export function stdDev(values: number[]): number {
  if (values.length === 0) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((a, b) => a + (b - m) * (b - m), 0) / values.length);
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  if (values.length === 1) return values[0];
  const s = [...values].sort((a, b) => a - b);
  const index = (s.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return s[lower];
  return s[lower] + (s[upper] - s[lower]) * (index - lower);
}

export function skewness(values: number[]): number {
  if (values.length < 3) return 0;
  const m = mean(values);
  const sd = stdDev(values);
  if (sd === 0) return 0;
  const n = values.length;
  const sum = values.reduce((a, b) => a + Math.pow((b - m) / sd, 3), 0);
  return (n / ((n - 1) * (n - 2))) * sum;
}

export function kurtosis(values: number[]): number {
  if (values.length < 4) return 0;
  const m = mean(values);
  const sd = stdDev(values);
  if (sd === 0) return 0;
  const n = values.length;
  const sum = values.reduce((a, b) => a + Math.pow((b - m) / sd, 4), 0);
  return ((n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3))) * sum - (3 * (n - 1) * (n - 1)) / ((n - 2) * (n - 3));
}

// ── 难度系数 P ───────────────────────────────────

/**
 * 难度系数 P = 平均得分 / 满分（0-1）。保留 3 位。
 * 满分 ≤ 0 时返回 0（无法评估难度）。
 */
export function difficulty(avgScore: number, fullScore: number): number {
  if (!(fullScore > 0) || !Number.isFinite(avgScore)) return 0;
  return Math.round((avgScore / fullScore) * 1000) / 1000;
}

// ── 区分度 D（极端组法）───────────────────────────

/**
 * 极端组法区分度：给定「指标得分序列」与对应的「分组基准总分序列」，
 * 按总分降序取前/后 ratio 比例的学生，D = 高分组指标均分 - 低分组指标均分，
 * 再除以该指标的满分，归一化到 [-1, 1] 区间（通常 0-1）。
 *
 * @param itemScores  每个学生在「该指标（某题）」上的得分（与 totals 同序）
 * @param totals      每个学生的「分组基准总分」
 * @param maxScore    该指标的满分（用于归一化 D）
 * @param ratio       极端组比例，默认 0.27
 */
export function discriminationByExtremeGroup(
  itemScores: number[],
  totals: number[],
  maxScore: number,
  ratio: number = 0.27
): number {
  if (itemScores.length !== totals.length || itemScores.length === 0) return 0;
  if (!(maxScore > 0)) return 0;
  // 按总分降序排列，取极端组
  const idx = itemScores.map((_, i) => i).sort((a, b) => totals[b] - totals[a]);
  const k = Math.max(1, Math.floor(idx.length * ratio));
  const high = idx.slice(0, k);
  const low = idx.slice(idx.length - k);
  const avg = (arr: number[]) => arr.reduce((s, i) => s + itemScores[i], 0) / arr.length;
  const d = avg(high) - avg(low);
  return Math.round((d / maxScore) * 1000) / 1000;
}

// ── 分数段直方图 ──────────────────────────────────

export interface HistogramBin {
  range: string;
  min: number;
  max: number;
  count: number;
}

/** 按固定段长生成直方图（与现有 generateDistributionRanges 口径一致） */
export function histogram(values: number[], fullScore: number, segmentSize: number): HistogramBin[] {
  const step = Math.max(1, Math.round(segmentSize));
  const bins: HistogramBin[] = [];
  for (let min = 0; min < fullScore; min += step) {
    const max = Math.min(min + step - 1, fullScore);
    bins.push({ range: `${min}-${max}`, min, max, count: 0 });
  }
  if (bins.length === 0) bins.push({ range: `0-${fullScore}`, min: 0, max: fullScore, count: 0 });
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    const bi = Math.min(bins.length - 1, Math.floor(v / step));
    bins[bi].count++;
  }
  return bins;
}

// ── Q-Q 图数据 ────────────────────────────────────

export interface QQPoint {
  /** 样本分位值 */
  value: number;
  /** 理论正态分布分位值 */
  expected: number;
}

/** 生成 Q-Q 图数据：样本升序值 vs 标准正态 Blom 分数期望 */
export function qqPlot(values: number[], meanVal?: number, sdVal?: number): QQPoint[] {
  const n = values.length;
  if (n === 0) return [];
  const sorted = [...values].sort((a, b) => a - b);
  const m = meanVal ?? mean(sorted);
  const sd = sdVal ?? stdDev(sorted);
  const out: QQPoint[] = [];
  for (let i = 0; i < n; i++) {
    // Blom 绘图位置
    const p = (i + 1 - 0.375) / (n + 0.25);
    out.push({ value: sorted[i], expected: m + sd * normalQuantile(p) });
  }
  return out;
}

/** 标准正态分位数（逆 CDF），Acklam 近似 */
export function normalQuantile(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  const ph = 1 - pl;
  let q: number;
  if (p < pl) {
    const x = Math.sqrt(-2 * Math.log(p));
    q = (((((c[0] * x + c[1]) * x + c[2]) * x + c[3]) * x + c[4]) * x + c[5]) / ((((d[0] * x + d[1]) * x + d[2]) * x + d[3]) * x + 1);
  } else if (p <= ph) {
    const x = p - 0.5;
    const r = x * x;
    q = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * x / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const x = Math.sqrt(-2 * Math.log(1 - p));
    q = -(((((c[0] * x + c[1]) * x + c[2]) * x + c[3]) * x + c[4]) * x + c[5]) / ((((d[0] * x + d[1]) * x + d[2]) * x + d[3]) * x + 1);
  }
  return q;
}

// ── 正态性检验 ────────────────────────────────────

export interface NormalityResult {
  shapiroFrancia: { W: number; pValue: number | null };
  kolmogorovSmirnov: { D: number; pValue: number | null };
  andersonDarling: { A2: number; pValue: number | null };
  skewness: number;
  kurtosis: number;
  /** 综合判定：是否近似正态（任一常用检验 p≥0.05 即视为通过） */
  isNormal: boolean;
  /** 样本量，小于 3 时检验不可靠 */
  sampleSize: number;
}

/** Shapiro-Francia 检验（Shapiro-Wilk 家族，基于 Q-Q 相关） */
export function shapiroFrancia(values: number[]): { W: number; pValue: number | null } {
  const n = values.length;
  if (n < 5) return { W: 1, pValue: null };
  const sorted = [...values].sort((a, b) => a - b);
  const m = mean(sorted);
  const sd = stdDev(sorted);
  if (sd === 0) return { W: 1, pValue: null };
  const exp = sorted.map((_, i) => m + sd * normalQuantile((i + 1 - 0.375) / (n + 0.25)));
  const num = sorted.reduce((s, v, i) => s + exp[i] * (v - m), 0);
  const den = Math.sqrt(sorted.reduce((s, v) => s + (v - m) * (v - m), 0) * exp.reduce((s, e) => s + e * e, 0));
  const W = den === 0 ? 1 : (num / den) * (num / den);
  // Royston 近似 p 值（小样本外不精确，仅作参考）
  let pValue: number | null = null;
  if (n <= 5000) {
    const ln = Math.log(n);
    const mu = 0.0038915 * Math.pow(ln, 3) - 0.083751 * ln * ln + 0.51072 * ln - 0.73708;
    const sigma = Math.exp(0.0039185 * ln * ln - 0.01052 * ln * ln * 0 + 0.05249 * Math.sqrt(ln) - 0.47074) * 0.1;
    if (Number.isFinite(mu) && sigma > 0) {
      const z = (Math.log(1 - W) - mu) / sigma;
      pValue = Math.max(0, Math.min(1, 1 - normalCdf(z)));
    }
  }
  return { W: Math.round(W * 10000) / 10000, pValue };
}

/** Kolmogorov-Smirnov 检验（与标准正态比较） */
export function kolmogorovSmirnov(values: number[]): { D: number; pValue: number | null } {
  const n = values.length;
  if (n === 0) return { D: 0, pValue: null };
  const m = mean(values);
  const sd = stdDev(values);
  if (sd === 0) return { D: 0, pValue: null };
  const sorted = [...values].sort((a, b) => a - b);
  let D = 0;
  for (let i = 0; i < n; i++) {
    const f = (i + 1) / n;
    const fExp = normalCdf((sorted[i] - m) / sd);
    D = Math.max(D, Math.abs(f - fExp), Math.abs((i + 1) / n - normalCdf((sorted[i] - m) / sd)));
  }
  // p 值近似（Kolmogorov 分布，Miller 级数）
  const x = Math.sqrt(n) * D;
  let pValue = 0;
  for (let j = 1; j <= 10; j++) {
    pValue += Math.pow(-1, j - 1) * Math.exp(-2 * j * j * x * x);
  }
  pValue = 2 * pValue;
  return { D: Math.round(D * 10000) / 10000, pValue: Number.isFinite(pValue) ? Math.max(0, Math.min(1, pValue)) : null };
}

/** Anderson-Darling 检验（与标准正态比较） */
export function andersonDarling(values: number[]): { A2: number; pValue: number | null } {
  const n = values.length;
  if (n < 2) return { A2: 0, pValue: null };
  const m = mean(values);
  const sd = stdDev(values);
  if (sd === 0) return { A2: 0, pValue: null };
  const sorted = [...values].sort((a, b) => a - b);
  const z = sorted.map((v) => (v - m) / sd);
  let S = 0;
  for (let i = 0; i < n; i++) {
    const f1 = normalCdf(z[i]);
    const f2 = normalCdf(z[n - 1 - i]);
    S += (2 * (i + 1) - 1) * (Math.log(f1) + Math.log(1 - f2));
  }
  const A2 = -n - S / n;
  // AD 正态 p 值近似
  let pValue: number | null = null;
  if (A2 <= 0.6) pValue = Math.exp(A2 * (1.2937 - 1.7093 * A2 + 4.5356 * A2 * A2) - A2);
  else if (A2 <= 1.0) pValue = Math.exp(A2 * (1.2937 - 1.7093 * A2 + 4.5356 * A2 * A2) - A2);
  else pValue = Math.exp(-(A2 - 1.0) * (1.0 + 0.5 / (A2 - 1.0)));
  return { A2: Math.round(A2 * 10000) / 10000, pValue: pValue == null ? null : Math.max(0, Math.min(1, pValue)) };
}

/** 综合正态性检验 */
export function normality(values: number[]): NormalityResult {
  const sf = shapiroFrancia(values);
  const ks = kolmogorovSmirnov(values);
  const ad = andersonDarling(values);
  const p = (v: number | null) => v == null ? 0 : v;
  const isNormal = values.length >= 3 && (p(sf.pValue) >= 0.05 || p(ks.pValue) >= 0.05 || p(ad.pValue) >= 0.05);
  return {
    shapiroFrancia: sf,
    kolmogorovSmirnov: ks,
    andersonDarling: ad,
    skewness: Math.round(skewness(values) * 1000) / 1000,
    kurtosis: Math.round(kurtosis(values) * 1000) / 1000,
    isNormal,
    sampleSize: values.length
  };
}

/** 标准正态 CDF（误差函数近似） */
function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return sign * y;
}

// ── 档位判定（难度/区分度）────────────────────────

export interface ThresholdBand {
  /** 上限阈值（含）；难度/区分度的值 ≤ 该阈值则归入此档 */
  max: number;
  label: string;
  /** 徽章颜色（前端用） */
  color: string;
}

/** 依据档位数组（已按阈值升序）判定归属，返回档位 label/color */
export function classifyBand(value: number, bands: ThresholdBand[]): { label: string; color: string } {
  for (const b of bands) {
    if (value <= b.max) return { label: b.label, color: b.color };
  }
  // 兜底：取最后一档（阈值最高者）或默认
  const last = bands[bands.length - 1];
  return last ? { label: last.label, color: last.color } : { label: "未知", color: "#888780" };
}
