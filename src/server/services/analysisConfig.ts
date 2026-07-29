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

export interface AnalysisThresholds {
  /** 及格线比例（0-1），如 0.6 表示满分的 60% */
  passRate: number;
  /** 优秀线比例（0-1），如 0.9 表示满分的 90% */
  excellentRate: number;
  /** 分数段粒度（分），如 10 表示每 10 分一段 */
  segmentSize: number;
  /** 题目错误率档位 [高, 中, 低]（百分比），如 [70, 50, 30] */
  errorTiers: [number, number, number];
}

export const DEFAULT_ANALYSIS_THRESHOLDS: AnalysisThresholds = {
  passRate: 0.6,
  excellentRate: 0.9,
  segmentSize: 10,
  errorTiers: [70, 50, 30]
};

export const ANALYSIS_SETTING_KEYS = {
  passRate: "analysis_pass_rate",
  excellentRate: "analysis_excellent_rate",
  segmentSize: "analysis_segment_size",
  errorTiers: "analysis_error_tiers"
} as const;

let cache: AnalysisThresholds | null = null;

export function invalidateAnalysisThresholdsCache(): void {
  cache = null;
}

function clamp(v: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(v) || v < min || v > max) return fallback;
  return v;
}

export function parseErrorTiers(raw: string | null | undefined): [number, number, number] {
  const fallback = DEFAULT_ANALYSIS_THRESHOLDS.errorTiers;
  if (!raw) return [...fallback];
  const parts = String(raw).split(",").map((s) => Number(s.trim()));
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n) || n <= 0 || n > 100)) return [...fallback];
  const [high, medium, low] = parts;
  if (!(high > medium && medium > low)) return [...fallback];
  return [high, medium, low];
}

export async function getAnalysisThresholds(): Promise<AnalysisThresholds> {
  if (cache) return cache;
  const db = getMysqlDb();
  let rows: Array<{ key: string; value: string }> = [];
  try {
    rows = (await db.all(
      "SELECT `key`, value FROM system_settings WHERE `key` IN (?, ?, ?, ?)",
      ANALYSIS_SETTING_KEYS.passRate,
      ANALYSIS_SETTING_KEYS.excellentRate,
      ANALYSIS_SETTING_KEYS.segmentSize,
      ANALYSIS_SETTING_KEYS.errorTiers
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
    errorTiers: parseErrorTiers(map[ANALYSIS_SETTING_KEYS.errorTiers])
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
  const tiers = parseErrorTiers(typeof b.errorTiers === "string" ? b.errorTiers : Array.isArray(b.errorTiers) ? (b.errorTiers as unknown[]).join(",") : null);
  return {
    ok: true,
    value: { passRate, excellentRate, segmentSize, errorTiers: tiers }
  };
}
