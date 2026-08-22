/**
 * 成绩分析阈值配置（路线图 P0-1）
 *
 * 全局阈值存于 system_settings，键：
 *   analysis_pass_rate      及格线比例（默认 0.6）
 *   analysis_excellent_rate 优秀线比例（默认 0.9）
 *   analysis_segment_size   分数段粒度（默认 10 分）
 *   analysis_error_tiers    题目错误率档位，逗号分隔高/中/低（默认 "70,50,30"）
 *
 * 带模块级缓存，PUT /api/analysis/config/thresholds 写入后调用
 * invalidateAnalysisThresholdsCache() 失效。
 */
import { getMysqlDb } from "../db";
import type { ThresholdBand } from "../../shared/stats";

export interface AnalysisThresholds {
  /** 及格线比例（0-1），如 0.6 表示满分的 60% */
  passRate: number;
  /** 优秀线比例（0-1），如 0.9 表示满分的 90% */
  excellentRate: number;
  /** 分数段粒度（分），如 10 表示每 10 分一段 */
  segmentSize: number;
  /** 题目错误率档位 [高, 中, 低]（百分比），如 [70, 50, 30] */
  errorTiers: [number, number, number];
  /** 主观题低分判定比例（0-1），默认 0.5：得分 < 该题满分 × 此比例 记为低分 */
  subjectiveLowScoreRatio: number;
}

export const DEFAULT_ANALYSIS_THRESHOLDS: AnalysisThresholds = {
  passRate: 0.6,
  excellentRate: 0.9,
  segmentSize: 10,
  errorTiers: [70, 50, 30],
  subjectiveLowScoreRatio: 0.5
};

export const ANALYSIS_SETTING_KEYS = {
  passRate: "analysis_pass_rate",
  excellentRate: "analysis_excellent_rate",
  segmentSize: "analysis_segment_size",
  errorTiers: "analysis_error_tiers",
  subjectiveLowScoreRatio: "analysis_low_score_ratio",
  difficultyBands: "analysis_difficulty_bands",
  discriminationBands: "analysis_discrimination_bands"
} as const;

/** 难度系数档位默认值（阈值升序，max 为归属上界，单位 0-1） */
export const DEFAULT_DIFFICULTY_BANDS: ThresholdBand[] = [
  { max: 0.3, label: "难", color: "#E24B4A" },
  { max: 0.5, label: "较难", color: "#EF9F27" },
  { max: 0.7, label: "中等", color: "#BA7517" },
  { max: 1.01, label: "容易", color: "#639922" }
];

/** 区分度档位默认值（阈值升序，max 为归属上界，单位 0-1） */
export const DEFAULT_DISCRIMINATION_BANDS: ThresholdBand[] = [
  { max: 0.2, label: "差", color: "#E24B4A" },
  { max: 0.3, label: "尚可", color: "#EF9F27" },
  { max: 0.4, label: "良好", color: "#BA7517" },
  { max: 1.01, label: "优秀", color: "#639922" }
];

let cache: AnalysisThresholds | null = null;

export function invalidateAnalysisThresholdsCache(): void {
  cache = null;
  bandsCache = null;
}

export interface DifficultyDiscriminationBands {
  difficulty: ThresholdBand[];
  discrimination: ThresholdBand[];
}

let bandsCache: DifficultyDiscriminationBands | null = null;

function parseBands(raw: string | null | undefined, fallback: ThresholdBand[]): ThresholdBand[] {
  if (!raw) return fallback;
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length === 0) return fallback;
    const ok = arr.every((b) => typeof b === "object" && b && typeof (b as any).max === "number" && typeof (b as any).label === "string");
    return ok ? (arr as ThresholdBand[]) : fallback;
  } catch {
    return fallback;
  }
}

export async function getDifficultyDiscriminationBands(): Promise<DifficultyDiscriminationBands> {
  if (bandsCache) return bandsCache;
  const db = getMysqlDb();
  let rows: Array<{ key: string; value: string }> = [];
  try {
    rows = (await db.all(
      "SELECT `key`, value FROM system_settings WHERE `key` IN (?, ?)",
      ANALYSIS_SETTING_KEYS.difficultyBands,
      ANALYSIS_SETTING_KEYS.discriminationBands
    )) as Array<{ key: string; value: string }>;
  } catch {
    return { difficulty: DEFAULT_DIFFICULTY_BANDS, discrimination: DEFAULT_DISCRIMINATION_BANDS };
  }
  const map: Record<string, string> = {};
  for (const r of rows) map[r.key] = r.value;
  bandsCache = {
    difficulty: parseBands(map[ANALYSIS_SETTING_KEYS.difficultyBands], DEFAULT_DIFFICULTY_BANDS),
    discrimination: parseBands(map[ANALYSIS_SETTING_KEYS.discriminationBands], DEFAULT_DISCRIMINATION_BANDS)
  };
  return bandsCache;
}

function clamp(v: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(v) || v < min || v > max) return fallback;
  return v;
}

/**
 * 严格解析错误率档位：必须是 3 个位于 (0, 100] 且严格递减的数值；非法返回 null。
 * 用于 PUT 入参校验（非法应报 400 而非静默回退默认值）。
 */
export function parseErrorTiersStrict(raw: string | null | undefined): [number, number, number] | null {
  if (!raw) return null;
  const parts = String(raw).split(",").map((s) => Number(s.trim()));
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n) || n <= 0 || n > 100)) return null;
  const [high, medium, low] = parts;
  if (!(high > medium && medium > low)) return null;
  return [high, medium, low];
}

/** 宽松解析：非法时回退默认值（仅用于读库内已存配置，避免脏数据致分析不可用） */
export function parseErrorTiers(raw: string | null | undefined): [number, number, number] {
  return parseErrorTiersStrict(raw) ?? [...DEFAULT_ANALYSIS_THRESHOLDS.errorTiers];
}

export async function getAnalysisThresholds(): Promise<AnalysisThresholds> {
  if (cache) return cache;
  const db = getMysqlDb();
  let rows: Array<{ key: string; value: string }> = [];
  try {
    rows = (await db.all(
      "SELECT `key`, value FROM system_settings WHERE `key` IN (?, ?, ?, ?, ?)",
      ANALYSIS_SETTING_KEYS.passRate,
      ANALYSIS_SETTING_KEYS.excellentRate,
      ANALYSIS_SETTING_KEYS.segmentSize,
      ANALYSIS_SETTING_KEYS.errorTiers,
      ANALYSIS_SETTING_KEYS.subjectiveLowScoreRatio
    )) as Array<{ key: string; value: string }>;
  } catch {
    // system_settings 表缺失等异常 → 使用默认值
    return { ...DEFAULT_ANALYSIS_THRESHOLDS, errorTiers: [...DEFAULT_ANALYSIS_THRESHOLDS.errorTiers] };
  }
  const map: Record<string, string> = {};
  for (const r of rows) map[r.key] = r.value;
  const d = DEFAULT_ANALYSIS_THRESHOLDS;
  cache = {
    passRate: clamp(Number(map[ANALYSIS_SETTING_KEYS.passRate]), 0.01, 1, d.passRate),
    excellentRate: clamp(Number(map[ANALYSIS_SETTING_KEYS.excellentRate]), 0.01, 1, d.excellentRate),
    segmentSize: Math.round(clamp(Number(map[ANALYSIS_SETTING_KEYS.segmentSize]), 1, 100, d.segmentSize)),
    errorTiers: parseErrorTiers(map[ANALYSIS_SETTING_KEYS.errorTiers]),
    subjectiveLowScoreRatio: clamp(Number(map[ANALYSIS_SETTING_KEYS.subjectiveLowScoreRatio]), 0.01, 1, d.subjectiveLowScoreRatio)
  };
  return cache;
}

/**
 * 校验并归一化 PUT 请求体；非法时返回错误消息。
 */
export function validateThresholdsInput(body: unknown): { ok: true; value: AnalysisThresholds } | { ok: false; message: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const passRate = Number(b.passRate);
  const excellentRate = Number(b.excellentRate);
  const segmentSize = Number(b.segmentSize);
  if (!Number.isFinite(passRate) || passRate <= 0 || passRate > 1) {
    return { ok: false, message: "及格线比例必须在 (0, 1] 之间，如 0.6" };
  }
  if (!Number.isFinite(excellentRate) || excellentRate <= 0 || excellentRate > 1) {
    return { ok: false, message: "优秀线比例必须在 (0, 1] 之间，如 0.9" };
  }
  if (excellentRate < passRate) {
    return { ok: false, message: "优秀线比例不能低于及格线比例" };
  }
  if (!Number.isFinite(segmentSize) || segmentSize < 1 || segmentSize > 100 || !Number.isInteger(segmentSize)) {
    return { ok: false, message: "分数段粒度必须是 1-100 的整数" };
  }
  // Bugfix: errorTiers 非法时报 400，而非静默替换成默认值导致「保存成功但未生效」
  const rawTiers = typeof b.errorTiers === "string"
    ? b.errorTiers
    : Array.isArray(b.errorTiers) ? (b.errorTiers as unknown[]).join(",") : null;
  const tiers = parseErrorTiersStrict(rawTiers);
  if (!tiers) {
    return { ok: false, message: "错误率档位必须是 3 个位于 (0, 100] 且严格递减的数值，如 \"70,50,30\"" };
  }
  // 主观题低分比例可选（旧客户端不传时保持默认 0.5），传入则必须在 (0, 1]
  let lowScoreRatio = DEFAULT_ANALYSIS_THRESHOLDS.subjectiveLowScoreRatio;
  if (b.subjectiveLowScoreRatio !== undefined && b.subjectiveLowScoreRatio !== null && b.subjectiveLowScoreRatio !== "") {
    lowScoreRatio = Number(b.subjectiveLowScoreRatio);
    if (!Number.isFinite(lowScoreRatio) || lowScoreRatio <= 0 || lowScoreRatio > 1) {
      return { ok: false, message: "主观题低分比例必须在 (0, 1] 之间，如 0.5" };
    }
  }
  return {
    ok: true,
    value: { passRate, excellentRate, segmentSize, errorTiers: tiers, subjectiveLowScoreRatio: lowScoreRatio }
  };
}
