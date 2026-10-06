/**
 * 网阅试卷池闸门（安全 R15）
 *
 * 与 `scanUploadLimits` 同一套三层设计：**默认值 + 环境变量覆盖 + 安全天花板**。
 * 「可配置」不等于「可关闭」——这些值是越权领取与资源占用的上限，
 * 因此只允许在 `[1, 天花板]` 区间内收紧或放宽，非法输入一律回落默认值。
 *
 * 本文件位于 shared 层，可能被前端打包，解析必须对缺失的 `process.env` 免疫。
 * 真正的闸门始终在服务端 `ReviewPoolService` 内执行。
 */

interface LimitDef {
  key: ReviewPoolLimitKey;
  env: string;
  unit: ReviewPoolLimitUnit;
  defaultValue: number;
  ceiling: number;
}

export type ReviewPoolLimitKey = "maxHeldPapersPerBlock" | "maxHeldPapersTotal" | "claimLockTimeoutMs";
export type ReviewPoolLimitUnit = "份" | "毫秒";

export const REVIEW_POOL_ENV_VARS: Record<ReviewPoolLimitKey, string> = {
  maxHeldPapersPerBlock: "PROJECTX_REVIEW_MAX_HELD_PER_BLOCK",
  maxHeldPapersTotal: "PROJECTX_REVIEW_MAX_HELD_TOTAL",
  claimLockTimeoutMs: "PROJECTX_REVIEW_CLAIM_LOCK_TIMEOUT_MS"
};

const LIMIT_DEFS: LimitDef[] = [
  {
    key: "maxHeldPapersPerBlock",
    env: REVIEW_POOL_ENV_VARS.maxHeldPapersPerBlock,
    unit: "份",
    defaultValue: 20,
    ceiling: 500
  },
  {
    key: "maxHeldPapersTotal",
    env: REVIEW_POOL_ENV_VARS.maxHeldPapersTotal,
    unit: "份",
    defaultValue: 60,
    ceiling: 2000
  },
  {
    // PR #312 CR9：持有量「计数 + 领取」必须落在同一个临界区，等待锁的时间就是它的预算。
    // 0 等于关掉预留（并发下可超配额），因此与配额一样只允许在天花板内收紧。
    key: "claimLockTimeoutMs",
    env: REVIEW_POOL_ENV_VARS.claimLockTimeoutMs,
    unit: "毫秒",
    defaultValue: 3000,
    ceiling: 30000
  }
];

export type ReviewPoolLimits = Record<ReviewPoolLimitKey, number>;

export const DEFAULT_REVIEW_POOL_LIMITS: ReviewPoolLimits = {
  maxHeldPapersPerBlock: 20,
  maxHeldPapersTotal: 60,
  claimLockTimeoutMs: 3000
};

export interface ResolvedReviewPoolLimits {
  limits: ReviewPoolLimits;
  /** 启动日志用：每条被覆盖 / 回落 / 夹紧的说明 */
  notices: string[];
}

/** 纯函数：给定 env 解析上限，便于校验脚本覆盖三种路径（未设置 / 非法 / 超天花板）。 */
export function resolveReviewPoolLimits(env: Record<string, string | undefined>): ResolvedReviewPoolLimits {
  const limits = { ...DEFAULT_REVIEW_POOL_LIMITS };
  const notices: string[] = [];
  for (const def of LIMIT_DEFS) {
    const raw = env[def.env];
    if (raw === undefined || raw === "") continue;
    const parsed = Number(String(raw).trim());
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
      notices.push(`${def.env}="${raw}" 不是正整数，按默认值 ${def.defaultValue}${def.unit}`);
      continue;
    }
    if (parsed > def.ceiling) {
      limits[def.key] = def.ceiling;
      notices.push(`${def.env}=${parsed} 超出安全天花板，夹紧为 ${def.ceiling}${def.unit}`);
      continue;
    }
    limits[def.key] = parsed;
    notices.push(`${def.env}=${parsed}${def.unit}（默认 ${def.defaultValue}，天花板 ${def.ceiling}）`);
  }
  return { limits, notices };
}

function readProcessEnv(): Record<string, string | undefined> {
  try {
    return typeof process !== "undefined" && process.env ? process.env : {};
  } catch {
    return {};
  }
}

const resolved = resolveReviewPoolLimits(readProcessEnv());

for (const notice of resolved.notices) {
  console.warn(`[review-pool-limits] ${notice}`);
}

/** 单教师在同一题块内可同时持有（已领取未提交）的卷子上限 */
export const MAX_HELD_PAPERS_PER_BLOCK = resolved.limits.maxHeldPapersPerBlock;
/** 单教师跨全部考试/题块可同时持有的卷子上限（防止占池导致他人无法开工） */
export const MAX_HELD_PAPERS_TOTAL = resolved.limits.maxHeldPapersTotal;
/** 领取临界区的命名锁等待预算（毫秒），超时返回 409 让客户端重试 */
export const CLAIM_LOCK_TIMEOUT_MS = resolved.limits.claimLockTimeoutMs;

/** 当前生效的试卷池闸门，用于启动日志 */
export function describeReviewPoolLimits(): string {
  return LIMIT_DEFS
    .map((def) => `${def.key}=${resolved.limits[def.key]}${def.unit}`)
    .join(", ");
}
