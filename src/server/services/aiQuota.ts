import type { DbAdapter } from "../db";
import { databaseTimestamp } from "../db/timestamp";
import {
  MAX_AI_ACTIVE_JOBS_GLOBAL,
  MAX_AI_ACTIVE_JOBS_PER_USER,
  MAX_AI_RUNS_PER_USER_HOUR,
  MAX_AI_TOKENS_PER_USER_DAY,
  type AiQuotaLimits,
} from "../../shared/aiQuotaLimits";

/**
 * AI 计费与并发配额（安全 R11）。
 *
 * 判定用的是**已落库的事实**：`ai_analysis_jobs`（排队/执行中的任务）与
 * `ai_analysis_runs`（每次调用的次数与 usage 回填的 token）。
 * 之所以不走内存计数器：单机重启会清零，而模型账单不会跟着重启清零。
 *
 * 所有查询都是「单表 + 绑定参数」的聚合，SQLite 与 MariaDB 同形：
 * 没有相关子查询、没有 `IN (${[]})`、时间边界由 `databaseTimestamp()` 按方言产出。
 */

export class AiQuotaError extends Error {
  readonly status = 429;
  readonly code = "AI_QUOTA_EXCEEDED";
  readonly retryAfterSeconds: number;
  constructor(message: string, retryAfterSeconds: number) {
    super(message);
    this.name = "AiQuotaError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface AiQuotaSnapshot {
  /** 该用户仍在排队/执行中的任务数 */
  activeJobsForUser: number;
  /** 全局仍在排队/执行中的任务数 */
  activeJobsGlobal: number;
  /** 该用户滚动 1 小时内已记录的调用次数 */
  runsLastHour: number;
  /** 该用户滚动 24 小时内已结算的 token 之和（输入 + 输出） */
  tokensLastDay: number;
}

async function countOf(db: DbAdapter, sql: string, ...params: unknown[]): Promise<number> {
  const row = await db.get<{ c: number | string }>(sql, ...params);
  return Number(row?.c ?? 0) || 0;
}

/**
 * 时间窗比较的归一化口径。
 *
 * `ai_analysis_runs.created_at` 由列默认值写入：SQLite 的 `CURRENT_TIMESTAMP` 是**空格分隔的 UTC**
 * （`2026-10-04 06:00:00`），而本仓库的 `databaseTimestamp()` 在 SQLite 上按既有约定产出 **ISO**
 * （`2026-10-04T06:00:00.000Z`）。两者直接做字符串比较时 `'T' > ' '`，任何默认值写入的行都会被判成
 * 「早于窗口起点」——配额看起来生效，实际永远读 0。这里把两侧都截成 `YYYY-MM-DD HH:MM:SS` 再比：
 *  - SQLite：比较双方同为 UTC，只消掉分隔符差异；
 *  - MariaDB：`DATETIME` 与 `databaseTimestamp()` 同为本地时间，归一是无操作。
 * 只用 `REPLACE` / `SUBSTR`（两方言同名同义），不引入 `date_format`、相关子查询或 `IN ()`。
 */
const RUN_TIME_AT = "SUBSTR(REPLACE(created_at, 'T', ' '), 1, 19)";
const RUN_TIME_CUTOFF = "SUBSTR(REPLACE(?, 'T', ' '), 1, 19)";

/**
 * 读取当前账本。未登录（`userId` 为空）时没有可归因的账本，返回全 0，
 * 由调用方决定是否放行——扫描端等机器凭据路径本来就不该进到这里。
 */
export async function readAiQuotaSnapshot(db: DbAdapter, userId: number | null | undefined): Promise<AiQuotaSnapshot> {
  if (!Number.isFinite(Number(userId)) || Number(userId) <= 0) {
    return { activeJobsForUser: 0, activeJobsGlobal: 0, runsLastHour: 0, tokensLastDay: 0 };
  }
  const id = Number(userId);
  const hourAgo = databaseTimestamp(new Date(Date.now() - 60 * 60 * 1000));
  const dayAgo = databaseTimestamp(new Date(Date.now() - 24 * 60 * 60 * 1000));
  const [activeJobsForUser, activeJobsGlobal, runsLastHour, tokens] = await Promise.all([
    countOf(db,
      "SELECT COUNT(*) AS c FROM ai_analysis_jobs WHERE created_by = ? AND status IN ('queued', 'running')",
      id),
    countOf(db,
      "SELECT COUNT(*) AS c FROM ai_analysis_jobs WHERE status IN ('queued', 'running')"),
    countOf(db,
      `SELECT COUNT(*) AS c FROM ai_analysis_runs WHERE user_id = ? AND ${RUN_TIME_AT} >= ${RUN_TIME_CUTOFF}`,
      id, hourAgo),
    (async () => {
      const row = await db.get<{ tin: number | string | null; tout: number | string | null }>(
        `SELECT COALESCE(SUM(tokens_in), 0) AS tin, COALESCE(SUM(tokens_out), 0) AS tout FROM ai_analysis_runs WHERE user_id = ? AND ${RUN_TIME_AT} >= ${RUN_TIME_CUTOFF}`,
        id, dayAgo
      );
      return (Number(row?.tin ?? 0) || 0) + (Number(row?.tout ?? 0) || 0);
    })(),
  ]);
  return { activeJobsForUser, activeJobsGlobal, runsLastHour, tokensLastDay: tokens };
}

export type AiQuotaVerdict =
  | { ok: true }
  | { ok: false; reason: keyof AiQuotaLimits; message: string; retryAfterSeconds: number };

/** 纯函数形式的判定：给定账本快照与配额，返回放行/拒绝（便于按边界值断言）。 */
export function evaluateAiQuota(
  snapshot: AiQuotaSnapshot,
  limits: AiQuotaLimits = {
    maxActiveJobsPerUser: MAX_AI_ACTIVE_JOBS_PER_USER,
    maxActiveJobsGlobal: MAX_AI_ACTIVE_JOBS_GLOBAL,
    maxRunsPerUserHour: MAX_AI_RUNS_PER_USER_HOUR,
    maxTokensPerUserDay: MAX_AI_TOKENS_PER_USER_DAY,
  }
): AiQuotaVerdict {
  if (snapshot.activeJobsForUser >= limits.maxActiveJobsPerUser) {
    return {
      ok: false,
      reason: "maxActiveJobsPerUser",
      message: `AI 分析并发配额已满：你仍有 ${snapshot.activeJobsForUser} 个任务在排队或执行中（单用户上限 ${limits.maxActiveJobsPerUser}，可由 PROJECTX_AI_MAX_ACTIVE_JOBS_PER_USER 调整），请等待完成后再提交`,
      retryAfterSeconds: 30,
    };
  }
  if (snapshot.activeJobsGlobal >= limits.maxActiveJobsGlobal) {
    return {
      ok: false,
      reason: "maxActiveJobsGlobal",
      message: `AI 分析服务繁忙：当前全局已有 ${snapshot.activeJobsGlobal} 个任务在处理（上限 ${limits.maxActiveJobsGlobal}，可由 PROJECTX_AI_MAX_ACTIVE_JOBS_GLOBAL 调整），请稍后重试`,
      retryAfterSeconds: 60,
    };
  }
  if (snapshot.runsLastHour >= limits.maxRunsPerUserHour) {
    return {
      ok: false,
      reason: "maxRunsPerUserHour",
      message: `AI 调用频率超限：最近 1 小时已发起 ${snapshot.runsLastHour} 次（上限 ${limits.maxRunsPerUserHour} 次，可由 PROJECTX_AI_MAX_RUNS_PER_HOUR 调整）`,
      retryAfterSeconds: 3600,
    };
  }
  if (snapshot.tokensLastDay >= limits.maxTokensPerUserDay) {
    return {
      ok: false,
      reason: "maxTokensPerUserDay",
      message: `AI 用量已达当日上限：近 24 小时已消耗 ${snapshot.tokensLastDay} tokens（上限 ${limits.maxTokensPerUserDay}，可由 PROJECTX_AI_MAX_TOKENS_PER_DAY 调整），请联系管理员调整配额`,
      retryAfterSeconds: 24 * 3600,
    };
  }
  return { ok: true };
}

/**
 * 入口闸门：不通过时抛 `AiQuotaError`（HTTP 429 + `Retry-After`）。
 * 放在「创建任务/发起调用之前」——任务一旦入队就会真的打向模型。
 */
export async function assertAiQuota(db: DbAdapter, userId: number | null | undefined): Promise<AiQuotaSnapshot> {
  const snapshot = await readAiQuotaSnapshot(db, userId);
  const verdict = evaluateAiQuota(snapshot);
  if (!verdict.ok) throw new AiQuotaError(verdict.message, verdict.retryAfterSeconds);
  return snapshot;
}
