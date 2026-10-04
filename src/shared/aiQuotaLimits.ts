/**
 * AI 调用的计费与并发配额（安全 R11）——**默认值 + 环境变量覆盖 + 安全天花板**三档决定。
 *
 * 此前只有一个「有没有配置服务商」的开关：一次 `POST /ai-analysis` 会真的打向模型、产生真金白银
 * 的费用，但没有任何服务端账本参与放行判断——同一个用户可以在一分钟内反复提交，把配额刷爆。
 * （单次调用的输出上限不在这里：它由边车侧固定，见 `llmclient/providers.py` 的 `max_tokens=8192`
 * 与 `providers_knowledge_points.py` 的 `4096`，客户端请求体无法注入。）
 *
 * 配额落在两个维度：
 *  - **并发**：同一用户仍在排队/执行的任务数、全局未完成任务数（`ai_analysis_jobs`）；
 *  - **计费**：滚动 1 小时内的调用次数、滚动 24 小时内已结算的 token 之和（`ai_analysis_runs`
 *    的 `tokens_in`/`tokens_out`，由 `llm-client.ts` 从边车响应的 usage 回填）。
 *
 * 口径说明：token 账本只统计**已完成并回报 usage** 的调用。因此提交时的判定是
 * 「已结算用量 + 本次预估」，无法预知未完成任务的消耗——这正是并发上限要一起生效的原因：
 * 单用户最多 2 个未完成任务、全局最多 8 个，把「未结算窗口」的实际敞口压到可接受范围。
 *
 * 与其它限制文件一致：非法值回落默认、超天花板夹紧、解析不抛错。
 */

export type AiQuotaLimitKey =
  | "maxActiveJobsPerUser"
  | "maxActiveJobsGlobal"
  | "maxRunsPerUserHour"
  | "maxTokensPerUserDay";

export type AiQuotaLimits = Record<AiQuotaLimitKey, number>;

const LIMIT_DEFS: Array<{
  key: AiQuotaLimitKey;
  env: string;
  unit: "count";
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

/** 给启动日志与健康检查用的一行摘要。 */
export function describeAiQuotaLimits(): string {
  return [
    `单用户未完成 ≤${MAX_AI_ACTIVE_JOBS_PER_USER}`,
    `全局未完成 ≤${MAX_AI_ACTIVE_JOBS_GLOBAL}`,
    `单用户 1 小时 ≤${MAX_AI_RUNS_PER_USER_HOUR} 次`,
    `单用户 24 小时 ≤${MAX_AI_TOKENS_PER_USER_DAY} tokens`
  ].join(" | ");
}
