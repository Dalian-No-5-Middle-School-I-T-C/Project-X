/**
 * AI 调用的计费与并发配额（安全 R11）——**默认值 + 环境变量覆盖 + 安全天花板**三档决定。
 *
 * 此前只有一个「有没有配置服务商」的开关：一次 `POST /ai-analysis` 会真的打向模型、产生真金白银
 * 的费用，但没有任何服务端账本参与放行判断——同一个用户可以在一分钟内反复提交，把配额刷爆。
 * （单次调用的输出上限不在这里：它由边车侧固定，见 `llmclient/providers.py` 的 `max_tokens=8192`
 * 与 `providers_knowledge_points.py` 的 `4096`，客户端请求体无法注入。）
 *
 * 配额落在两个维度：
 *  - **并发**：同一用户/全局仍在占用的调用名额 = 排队中的任务（`ai_analysis_jobs` 的 `queued`）
 *    + 在途调用（`ai_analysis_runs` 里 `success IS NULL` 且未过失效窗口的行）。异步任务执行期间
 *    的名额由它自己的 run 行承担，因此不会与任务行重复计数（PR #312 CR8）。
 *  - **计费**：滚动 1 小时内的调用次数、滚动 24 小时内已结算的 token 之和（`ai_analysis_runs`
 *    的 `tokens_in`/`tokens_out`，由 `llm-client.ts` 从边车响应的 usage 回填）。
 *
 * 口径说明：token 账本只统计**已完成并回报 usage** 的调用。因此提交时的判定是
 * 「已结算用量 + 本次预估」，无法预知未完成任务的消耗——这正是并发上限要一起生效的原因：
 * 单用户最多 2 个未完成任务、全局最多 8 个，把「未结算窗口」的实际敞口压到可接受范围。
 *
 * 判定与占位必须在同一个临界区内完成（PR #312 CR9）：先查后写分离时，一波并发请求读到同一份
 * 旧账本，8 的名额能放到 11 个任务。`admissionLockTimeoutMs` 就是给这段临界区用的。
 *
 * 与其它限制文件一致：非法值回落默认、超天花板夹紧、解析不抛错。
 */

export type AiQuotaLimitKey =
  | "maxActiveJobsPerUser"
  | "maxActiveJobsGlobal"
  | "maxRunsPerUserHour"
  | "maxTokensPerUserDay"
  | "activeRunStaleMs"
  | "admissionLockTimeoutMs";

export type AiQuotaLimits = Record<AiQuotaLimitKey, number>;

const LIMIT_DEFS: Array<{
  key: AiQuotaLimitKey;
  env: string;
  unit: "count" | "ms";
  default: number;
  ceiling: number;
}> = [
  // 单用户未完成任务：学情分析一次要跑几十秒，2 个已经覆盖「一次考试 + 一次重试」。
  { key: "maxActiveJobsPerUser", env: "PROJECTX_AI_MAX_ACTIVE_JOBS_PER_USER", unit: "count", default: 2, ceiling: 20 },
  // 全局未完成任务：边车是单条串行链，排太长只会让所有人的任务超时。
  { key: "maxActiveJobsGlobal", env: "PROJECTX_AI_MAX_ACTIVE_JOBS_GLOBAL", unit: "count", default: 8, ceiling: 100 },
  // 滚动 1 小时调用次数：按「一场联考 6 个班 × 每班重跑几次」的真实用量给。
  { key: "maxRunsPerUserHour", env: "PROJECTX_AI_MAX_RUNS_PER_HOUR", unit: "count", default: 20, ceiling: 500 },
  // 滚动 24 小时 token：一次整班学情分析约几万 token，100 万足够一整天的正常教学用量。
  { key: "maxTokensPerUserDay", env: "PROJECTX_AI_MAX_TOKENS_PER_DAY", unit: "count", default: 1_000_000, ceiling: 20_000_000 },
  // 在途占位的失效窗口（毫秒，PR #312 CR8）：同步调用靠 `ai_analysis_runs` 里
  // `success IS NULL` 的行占用名额，进程被 kill 时这些行没人回填，超过窗口就不再占用。
  // 默认 5 分钟，已放宽到最长边车调用（120 秒）的两倍以上；上限 1 小时，避免一次崩溃把名额焊死。
  { key: "activeRunStaleMs", env: "PROJECTX_AI_ACTIVE_RUN_STALE_MS", unit: "ms", default: 300_000, ceiling: 3_600_000 },
  // 准入临界区的命名锁等待预算（毫秒，PR #312 CR9）：超时报 429 让客户端重试，而不是把请求挂住。
  { key: "admissionLockTimeoutMs", env: "PROJECTX_AI_ADMISSION_LOCK_TIMEOUT_MS", unit: "ms", default: 2_000, ceiling: 30_000 },
];

export const AI_QUOTA_ENV_VARS = LIMIT_DEFS.map((def) => def.env);

function defaultLimits(): AiQuotaLimits {
  const limits = {} as AiQuotaLimits;
  for (const def of LIMIT_DEFS) limits[def.key] = def.default;
  return limits;
}

/** 未配置时的默认配额（文档、界面提示与测试都用它做基准）。 */
export const DEFAULT_AI_QUOTA_LIMITS: AiQuotaLimits = defaultLimits();

export interface ResolvedAiQuotaLimits {
  limits: AiQuotaLimits;
  /** 生效的覆盖项与异常值说明，供启动日志使用 */
  notices: string[];
}

/** 纯函数形式的解析器：不读 `process.env`、不打印、不抛错。 */
export function resolveAiQuotaLimits(env: Record<string, string | undefined> = {}): ResolvedAiQuotaLimits {
  const limits = defaultLimits();
  const notices: string[] = [];
  for (const def of LIMIT_DEFS) {
    const raw = env[def.env];
    if (raw === undefined || String(raw).trim() === "") continue;
    const parsed = Number(String(raw).trim());
    if (!Number.isFinite(parsed) || parsed < 1) {
      notices.push(`${def.env}="${raw}" 不是 ≥1 的整数，按默认值 ${def.default} 处理`);
      continue;
    }
    const value = Math.floor(parsed);
    if (value > def.ceiling) {
      limits[def.key] = def.ceiling;
      notices.push(`${def.env}="${raw}" 超过安全天花板 ${def.ceiling}，已按天花板夹紧`);
      continue;
    }
    limits[def.key] = value;
    notices.push(`${def.key} 由 ${def.env} 覆盖为 ${value}`);
  }
  return { limits, notices };
}

function readProcessEnv(): Record<string, string | undefined> {
  return typeof process !== "undefined" && process.env ? process.env : {};
}

const resolved = resolveAiQuotaLimits(readProcessEnv());
if (resolved.notices.length > 0 && typeof process !== "undefined" && process.env) {
  for (const notice of resolved.notices) console.warn(`[ai-quota] ${notice}`);
}

export const MAX_AI_ACTIVE_JOBS_PER_USER = resolved.limits.maxActiveJobsPerUser;
export const MAX_AI_ACTIVE_JOBS_GLOBAL = resolved.limits.maxActiveJobsGlobal;
export const MAX_AI_RUNS_PER_USER_HOUR = resolved.limits.maxRunsPerUserHour;
export const MAX_AI_TOKENS_PER_USER_DAY = resolved.limits.maxTokensPerUserDay;
/** 在途调用（`success IS NULL`）占用并发名额的失效窗口，毫秒 */
export const AI_ACTIVE_RUN_STALE_MS = resolved.limits.activeRunStaleMs;
/** AI 准入临界区的命名锁等待预算，毫秒 */
export const AI_ADMISSION_LOCK_TIMEOUT_MS = resolved.limits.admissionLockTimeoutMs;

/** 给启动日志与健康检查用的一行摘要。 */
export function describeAiQuotaLimits(): string {
  return [
    `单用户未完成 ≤${MAX_AI_ACTIVE_JOBS_PER_USER}`,
    `全局未完成 ≤${MAX_AI_ACTIVE_JOBS_GLOBAL}`,
    `单用户 1 小时 ≤${MAX_AI_RUNS_PER_USER_HOUR} 次`,
    `单用户 24 小时 ≤${MAX_AI_TOKENS_PER_USER_DAY} tokens`,
    `在途占位失效窗口 ${AI_ACTIVE_RUN_STALE_MS / 1000} 秒`,
    `准入锁等待 ${AI_ADMISSION_LOCK_TIMEOUT_MS / 1000} 秒`
  ].join(" | ");
}
