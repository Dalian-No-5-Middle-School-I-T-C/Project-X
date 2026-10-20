/**
 * 跨考试/跨学期的成绩变化口径。
 *
 * 不同卷子的满分（总分）不一样，绝对分之间不可直接比较：150 分卷涨 6 分（4%）和
 * 100 分卷涨 6 分（6%）不是一回事，满分越大的卷子越容易触发「进步」标签。
 * 因此所有进退步判定统一在**得分率（%）**上做差，单位记作 pp（百分点）。
 *
 * 满分来源沿用既有唯一口径 `AnalysisRepository.getExamFullScoreMap()`
 * （答题卡分值投影，缺失时回退逐题满分合计，无法解析时返回 0）。
 * 分母不可解析时一律返回 null 表示「不可判定」：不虚构满分，也不退回绝对分。
 */

/** 进退步阈值：得分率变化 ±3 个百分点，等价于百分制卷上的 ±3 分。 */
export const PROGRESS_RATE_THRESHOLD_PP = 3;

export type ProgressDirection = "up" | "down" | "stable" | "unknown";

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** 满分是否可解析（0、负数、NaN 都算解析不出来）。 */
export function hasResolvableFullScore(fullScore: number | null | undefined): boolean {
  return typeof fullScore === "number" && Number.isFinite(fullScore) && fullScore > 0;
}

/** 得分率 0–100（保留 1 位小数）；满分不可解析时返回 null。 */
export function scoreRateOf(
  score: number | null | undefined,
  fullScore: number | null | undefined
): number | null {
  if (!hasResolvableFullScore(fullScore)) return null;
  if (typeof score !== "number" || !Number.isFinite(score)) return null;
  return round1((score / (fullScore as number)) * 100);
}

/**
 * 得分率均值。任一成员缺满分即整体不可判定——
 * 与 `sumKnownFullScore` 「缺一即不聚合」的既有口径保持一致，避免不同样本量之间做差。
 */
export function meanScoreRate(rates: Array<number | null | undefined>): number | null {
  if (rates.length === 0) return null;
  if (rates.some((rate) => typeof rate !== "number" || !Number.isFinite(rate))) return null;
  return round1((rates as number[]).reduce((sum, rate) => sum + rate, 0) / rates.length);
}

/** 两个得分率之间的变化（百分点）；任一侧不可计算则不可判定。 */
export function scoreRateChange(
  current: number | null | undefined,
  previous: number | null | undefined
): number | null {
  if (typeof current !== "number" || !Number.isFinite(current)) return null;
  if (typeof previous !== "number" || !Number.isFinite(previous)) return null;
  return round1(current - previous);
}

/** 按得分率变化判定进退步方向；changePP 为 null 时返回 unknown（界面应显示「—」而非「稳定」）。 */
export function judgeProgress(
  changePP: number | null | undefined,
  thresholdPP: number = PROGRESS_RATE_THRESHOLD_PP
): ProgressDirection {
  if (typeof changePP !== "number" || !Number.isFinite(changePP)) return "unknown";
  if (changePP >= thresholdPP) return "up";
  if (changePP <= -thresholdPP) return "down";
  return "stable";
}
