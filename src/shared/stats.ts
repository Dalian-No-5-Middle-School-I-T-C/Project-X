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

/** 按固定段长生成直方图
 *
 * 桶为半开区间 [min, min+step)，最后一段闭区间收尾（包含 fullScore）。
 * - 标签使用 "0-<10"、"10-<20"…，最后一段 "90-100"——避免 9.5 被读作 0-9 的"小数成绩归类错位"
 * - 数值字段 min/max：前 N-1 段 max = min+step-1（适配 SQL `BETWEEN r.min AND r.max` 过滤整数成绩），
 *   末段 max = fullScore（闭区间，含满分；保证 JS 桶计数与 SQL 计数一致）。 */
export function histogram(values: number[], fullScore: number, segmentSize: number): HistogramBin[] {
  const step = Math.max(1, Math.round(segmentSize));
  const bins: HistogramBin[] = [];
  for (let min = 0; min < fullScore; min += step) {
    const upperExclusive = min + step;
    const isLast = upperExclusive >= fullScore;
    const max = isLast ? fullScore : Math.min(upperExclusive - 1, fullScore);
    const range = isLast ? `${min}-${fullScore}` : `${min}-<${upperExclusive}`;
    bins.push({ range, min, max, count: 0 });
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
  /** 综合判定：是否近似正态（以 Shapiro-Francia 为主判，p≥0.05 视为通过） */
  isNormal: boolean;
  /** 样本量，小于 3 时检验不可靠 */
  sampleSize: number;
}

/** Shapiro-Francia 检验（Shapiro-Wilk 家族，基于数据与理论正态分位数的相关平方）
 *
 * W = [Σ (v_i - v̄)(m_i - m̄)]² / [Σ(v_i - v̄)² · Σ(m_i - m̄)²]
 *   其中 m_i = v̄ + s · Φ⁻¹((i - 3/8) / (n + 1/4)) （Blom 期望值）
 *
 * p 值采用 Royston 1992 的渐近正态近似：log(1-W) ≈ N(μ_n, σ_n²)
 *   μ_n = -1.5861 - 0.31082·ln(n) - 0.083751·ln(n)² + 0.0038915·ln(n)³
 *   σ_n = exp(-0.4803 - 0.082676·ln(n) + 0.0030302·ln(n)²)
 * 仅作参考：n<5 不可靠，n>5000 精度下降。 */
export function shapiroFrancia(values: number[]): { W: number; pValue: number | null } {
  const n = values.length;
  if (n < 5) return { W: 1, pValue: null };
  const sorted = [...values].sort((a, b) => a - b);
  const vBar = mean(sorted);
  const sd = stdDev(sorted);
  if (sd === 0) return { W: 1, pValue: null };
  // 期望正态分位值（Blom 位置），已用 v̄ 与 s 居中
  const expected = sorted.map((_, i) => vBar + sd * normalQuantile((i + 1 - 0.375) / (n + 0.25)));
  const eBar = mean(expected);
  let num = 0, d1 = 0, d2 = 0;
  for (let i = 0; i < n; i++) {
    const dv = sorted[i] - vBar;
    const de = expected[i] - eBar;
    num += dv * de;
    d1 += dv * dv;
    d2 += de * de;
  }
  const W = (d1 > 0 && d2 > 0) ? (num * num) / (d1 * d2) : 1;
  let pValue: number | null = null;
  if (W > 0 && W < 1) {
    const ln = Math.log(n);
    const mu = -1.5861 - 0.31082 * ln - 0.083751 * ln * ln + 0.0038915 * Math.pow(ln, 3);
    const sigma = Math.exp(-0.4803 - 0.082676 * ln + 0.0030302 * ln * ln);
    if (sigma > 0 && Number.isFinite(mu)) {
      const z = (Math.log(1 - W) - mu) / sigma;
      pValue = Math.max(0, Math.min(1, 1 - normalCdf(z)));
    }
  }
  return { W: Math.round(W * 10000) / 10000, pValue };
}

/** Kolmogorov-Smirnov 检验（与正态分布比较，参数由样本估计）
 *
 * D⁺ = max_i (i/n - F(x_i))        — 经验 CDF 上界
 * D⁻ = max_i (F(x_i) - (i-1)/n)    — 经验 CDF 下界
 * D  = max(D⁺, D⁻)
 *
 * 因均值/方差由样本估计，标准 Smirnov 渐近 p 值会偏大（过于宽松），
 * 故采用 Lilliefors 修正：Dallal & Wilkinson (1986) 的解析近似；
 * n<5 时 p 值不可靠，返回 null。 */
export function kolmogorovSmirnov(values: number[]): { D: number; pValue: number | null } {
  const n = values.length;
  if (n === 0) return { D: 0, pValue: null };
  const m = mean(values);
  const sd = stdDev(values);
  if (sd === 0) return { D: 0, pValue: null };
  const sorted = [...values].sort((a, b) => a - b);
  let dPlus = 0, dMinus = 0;
  for (let i = 0; i < n; i++) {
    const fExp = normalCdf((sorted[i] - m) / sd);
    const upper = (i + 1) / n;        // F_n(x_i) 上界
    const lower = i / n;               // F_n(x_{i-1}) 下界
    if (upper - fExp > dPlus) dPlus = upper - fExp;
    if (fExp - lower > dMinus) dMinus = fExp - lower;
  }
  const D = Math.max(dPlus, dMinus);
  // Lilliefors p 值近似（Dallal & Wilkinson 1986）：
  // p ≈ exp(-7.01256·D²·(n+2.78019) + 2.99587·D·√(n+2.78019) - 0.122119 + 0.974598/√n + 1.67997/n)
  let pValue: number | null = null;
  if (n >= 5) {
    const root = Math.sqrt(n + 2.78019);
    const approx = -7.01256 * D * D * (n + 2.78019) + 2.99587 * D * root - 0.122119 + 0.974598 / Math.sqrt(n) + 1.67997 / n;
    pValue = Number.isFinite(approx) ? Math.max(0, Math.min(1, Math.exp(approx))) : null;
  }
  return { D: Math.round(D * 10000) / 10000, pValue };
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
  // Stephens 的有限样本修正及正态分布 p 值分段近似。
  const adjusted = A2 * (1 + 0.75 / n + 2.25 / (n * n));
  let pValue: number;
  if (adjusted < 0.2) pValue = 1 - Math.exp(-13.436 + 101.14 * adjusted - 223.73 * adjusted * adjusted);
  else if (adjusted < 0.34) pValue = 1 - Math.exp(-8.318 + 42.796 * adjusted - 59.938 * adjusted * adjusted);
  else if (adjusted < 0.6) pValue = Math.exp(0.9177 - 4.279 * adjusted - 1.38 * adjusted * adjusted);
  else pValue = Math.exp(1.2937 - 5.709 * adjusted + 0.0186 * adjusted * adjusted);
  return { A2: Math.round(A2 * 10000) / 10000, pValue: pValue == null ? null : Math.max(0, Math.min(1, pValue)) };
}

/** 综合正态性检验
 * 采用 Shapiro-Francia 为主判（在小/中样本下对正态偏离最敏感，功效最高）。
 * 当 n < 5 时样本量过小不做正态性判断，返回 isNormal=false。 */
export function normality(values: number[]): NormalityResult {
  const sf = shapiroFrancia(values);
  const ks = kolmogorovSmirnov(values);
  const ad = andersonDarling(values);
  const isNormal = values.length >= 5 && sf.pValue != null && sf.pValue >= 0.05;
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

// ── 信度（Cronbach α / KR-20）与变异系数 CV ───────────

/**
 * Cronbach's α：内部一致性信度（含主观题/连续计分题时使用）。
 * itemScores: 每行一个学生、每列一道题的得分；矩阵必须完整（缺行返回 null）。
 * α = k/(k-1) × (1 − Σσ_i² / σ_total²)，两端裁剪到 [-1, 1]。
 * 要求 ≥2 题、≥2 生且总分方差 > 0，否则返回 null（无法评估）。
 */
export function cronbachAlpha(itemScores: number[][]): number | null {
  const n = itemScores.length;
  const k = n > 0 ? itemScores[0].length : 0;
  if (n < 2 || k < 2) return null;
  for (const row of itemScores) if (row.length !== k) return null;
  const itemVar: number[] = [];
  for (let j = 0; j < k; j++) {
    const col: number[] = [];
    for (let i = 0; i < n; i++) {
      const v = itemScores[i][j];
      if (!Number.isFinite(v)) return null;
      col.push(v);
    }
    const m = col.reduce((a, b) => a + b, 0) / n;
    itemVar.push(col.reduce((s, v) => s + (v - m) ** 2, 0) / n);
  }
  const totals = itemScores.map((row) => row.reduce((a, b) => a + b, 0));
  const tm = totals.reduce((a, b) => a + b, 0) / n;
  const totalVar = totals.reduce((s, v) => s + (v - tm) ** 2, 0) / n;
  if (!(totalVar > 0)) return null;
  const alpha = (k / (k - 1)) * (1 - itemVar.reduce((a, b) => a + b, 0) / totalVar);
  return Math.round(Math.max(-1, Math.min(1, alpha)) * 1000) / 1000;
}

/**
 * KR-20（Kuder-Richardson 20）：纯客观题（二分计分 0/1）信度。
 * binaryMatrix: 每行一个学生、每列一题，1=得分等于该题满分（答对）。
 * KR-20 = k/(k-1) × (1 − Σp_j q_j / σ_total²)。与二分数据上的 α 等价，是经典选择。
 */
export function kr20(binaryMatrix: number[][]): number | null {
  const n = binaryMatrix.length;
  const k = n > 0 ? binaryMatrix[0].length : 0;
  if (n < 2 || k < 2) return null;
  for (const row of binaryMatrix) if (row.length !== k) return null;
  const pq: number[] = [];
  for (let j = 0; j < k; j++) {
    let ones = 0;
    for (let i = 0; i < n; i++) {
      const v = binaryMatrix[i][j];
      if (v !== 0 && v !== 1) return null;
      ones += v;
    }
    const p = ones / n;
    pq.push(p * (1 - p));
  }
  const totals = binaryMatrix.map((row) => row.reduce((a, b) => a + b, 0));
  const tm = totals.reduce((a, b) => a + b, 0) / n;
  const totalVar = totals.reduce((s, v) => s + (v - tm) ** 2, 0) / n;
  if (!(totalVar > 0)) return null;
  const r20 = (k / (k - 1)) * (1 - pq.reduce((a, b) => a + b, 0) / totalVar);
  return Math.round(Math.max(-1, Math.min(1, r20)) * 1000) / 1000;
}

/** 变异系数 CV = 标准差 / 均值（均值需 > 0），用于跨科/跨班离散度对比（消除满分差异），保留 3 位 */
export function coefficientOfVariation(stdDev: number, mean: number): number | null {
  if (!(mean > 0) || !Number.isFinite(stdDev) || !(stdDev >= 0)) return null;
  return Math.round((stdDev / mean) * 1000) / 1000;
}
