import type { DbAdapter } from "../db";
import { NamedLockTimeoutError } from "../db/mysql";
import { databaseTimestamp } from "../db/timestamp";
import { SQL_TIME_ARG, sqlTimeAt } from "../db/timestamp";
import { insertAiRunRow } from "./aiTelemetry";
import {
  AI_ACTIVE_RUN_STALE_MS,
  AI_ADMISSION_LOCK_TIMEOUT_MS,
  MAX_AI_ACTIVE_JOBS_GLOBAL,
  MAX_AI_ACTIVE_JOBS_PER_USER,
  MAX_AI_RUNS_PER_USER_HOUR,
  MAX_AI_TOKENS_PER_USER_DAY,
  type AiQuotaLimitKey,
  type AiQuotaLimits,
} from "../../shared/aiQuotaLimits";

/**
 * AI 计费与并发配额（安全 R11 + PR #312 CR8/CR9）。
 *
 * 判定用的是**已落库的事实**：`ai_analysis_jobs` 里还在排队的任务，加上
 * `ai_analysis_runs` 里 `success IS NULL` 的在途调用。之所以不走内存计数器：
 * 单机重启会清零，而模型账单不会跟着重启清零。
 *
 * CR8 的要点：同步打模型的路径（原卷知识点、学生单场分析）不建任务行，
 * 早先它们完全绕开了并发维度——「同一用户同时在飞的调用」只数得到异步队列里的任务。
 * 现在同步调用以它自己的运行行占位，任务行只补上「还没开始跑」的那一段，
 * 一个任务在执行时由它的运行行计数，两者不会重复占用。
 *
 * CR9 的要点：名额必须**原子地**检查并占位（见 `withAiAdmissionLock`）。
 * 先查后写分离时，一波并发请求读到同一份旧账本，上限 8 能放到 11 个任务。
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
  /** 该用户仍占用并发名额的调用数 = 排队任务 + 在途调用 */
  activeJobsForUser: number;
  /** 全局仍占用并发名额的调用数 = 排队任务 + 在途调用 */
  activeJobsGlobal: number;
  /** 该用户滚动 1 小时内已记录的调用次数 */
  runsLastHour: number;
  /** 该用户滚动 24 小时内已结算的 token 之和（输入 + 输出） */
  tokensLastDay: number;
  /** 分解：排队中的任务行（判定已并入 activeJobs*，这里只供日志与回归断言） */
  queuedJobs?: { user: number; global: number };
  /** 分解：在途运行行（`success IS NULL` 且在失效窗口内） */
  inFlightRuns?: { user: number; global: number };
}

async function countOf(db: DbAdapter, sql: string, ...params: unknown[]): Promise<number> {
  const row = await db.get<{ c: number | string }>(sql, ...params);
  return Number(row?.c ?? 0) || 0;
}

/**
 * 时间窗比较的归一化口径见 `sqlTimeAt` / `SQL_TIME_ARG`（`src/server/db/timestamp.ts`）。
 * 这里与 `aiTelemetry.markInterruptedAiRuns` 共用同一份片段：准入读账本与启动清理**必须**
 * 对「哪一行算过期」给出同一个答案，否则一边认为还占着名额、另一边已经把它判成中断。
 */
const RUN_TIME_AT = sqlTimeAt("created_at");
const RUN_TIME_CUTOFF = SQL_TIME_ARG;

/**
 * 读取当前账本。未登录（`userId` 为空）时没有可归因的账本，返回全 0，
 * 由调用方决定是否放行——扫描端等机器凭据路径本来就不该进到这里。
 *
 * 并发维度由两部分相加（CR8）：
 *  - `ai_analysis_jobs` 的 `queued` 行：任务已建、还没轮到执行；
 *  - `ai_analysis_runs` 的 `success IS NULL` 行：正在打模型的调用（同步路径的全部，
 *    异步路径的执行期）。任务一旦转入 `running` 就由它的运行行接手计数，不重复占用。
 * 在途行只算失效窗口内的：进程被 kill 时没人回填，超过窗口就认定它不再占用名额
 * （启动阶段另有 `markInterruptedAiRuns` 一次性清干净）。
 */
export async function readAiQuotaSnapshot(db: DbAdapter, userId: number | null | undefined): Promise<AiQuotaSnapshot> {
  if (!Number.isFinite(Number(userId)) || Number(userId) <= 0) {
    return { activeJobsForUser: 0, activeJobsGlobal: 0, runsLastHour: 0, tokensLastDay: 0 };
  }
  const id = Number(userId);
  const hourAgo = databaseTimestamp(new Date(Date.now() - 60 * 60 * 1000));
  const dayAgo = databaseTimestamp(new Date(Date.now() - 24 * 60 * 60 * 1000));
  const staleAgo = databaseTimestamp(new Date(Date.now() - AI_ACTIVE_RUN_STALE_MS));
  const [queuedForUser, queuedGlobal, inFlightForUser, inFlightGlobal, runsLastHour, tokens] = await Promise.all([
    countOf(db,
      "SELECT COUNT(*) AS c FROM ai_analysis_jobs WHERE created_by = ? AND status = 'queued'",
      id),
    countOf(db,
      "SELECT COUNT(*) AS c FROM ai_analysis_jobs WHERE status = 'queued'"),
    countOf(db,
      `SELECT COUNT(*) AS c FROM ai_analysis_runs WHERE user_id = ? AND success IS NULL AND ${RUN_TIME_AT} >= ${RUN_TIME_CUTOFF}`,
      id, staleAgo),
    countOf(db,
      `SELECT COUNT(*) AS c FROM ai_analysis_runs WHERE success IS NULL AND ${RUN_TIME_AT} >= ${RUN_TIME_CUTOFF}`,
      staleAgo),
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
  return {
    activeJobsForUser: queuedForUser + inFlightForUser,
    activeJobsGlobal: queuedGlobal + inFlightGlobal,
    runsLastHour,
    tokensLastDay: tokens,
    queuedJobs: { user: queuedForUser, global: queuedGlobal },
    inFlightRuns: { user: inFlightForUser, global: inFlightGlobal },
  };
}

export type AiQuotaVerdict =
  | { ok: true }
  | { ok: false; reason: AiQuotaLimitKey; message: string; retryAfterSeconds: number };

/** 判定只用到这四档；失效窗口与锁等待是执行参数，不参与「超没超」的比较。 */
type AiQuotaCompareLimits = Pick<
  AiQuotaLimits,
  "maxActiveJobsPerUser" | "maxActiveJobsGlobal" | "maxRunsPerUserHour" | "maxTokensPerUserDay"
>;

/** 纯函数形式的判定：给定账本快照与配额，返回放行/拒绝（便于按边界值断言）。 */
export function evaluateAiQuota(
  snapshot: AiQuotaSnapshot,
  limits: AiQuotaCompareLimits = {
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
 * 准入临界区（PR #312 CR9 + 评审 B2）：把「读账本 → 判定 → 占位」串在同一把锁里原子完成。
 *
 * 两层互斥，各挡一种并发：
 *  - **进程内一条串行链**：SQLite 适配器复用同一条 better-sqlite3 连接，并发调用
 *    `db.transaction()` 会在 BEGIN 上嵌套并抛「cannot start a transaction within a transaction」——
 *    一波 AI 提交里只有一个能成，其余全变成 500。排队之后既避开嵌套，又让临界区真正互斥。
 *  - **数据库命名锁 `px_ai_admission`**：挡跨连接/跨进程的并发。MariaDB 下两个请求各自读到
 *    同一份旧账本（COUNT 走一致性快照，看不见对方未提交的 INSERT），上限 8 的名额能放到 11 个任务。
 * 锁是**全局一把**而不是按用户：全局名额本身也是全局的，多个用户同时挤占时必须一起结算。
 *
 * B2 的修正：锁**不能**在事务内部取放。写成 `transaction(tx => withLock(tx, fn))` 时，
 * `RELEASE_LOCK` 在 `fn` 返回的那一刻就执行了，而 COMMIT 还要再往后一步——于是第二个进程
 * 拿到锁时读到的是上一笔**尚未提交**的快照，跨进程窗口照样超发。现在整段临界区交给
 * `db.transactionWithNamedLock()`：同一条连接上 GET_LOCK → BEGIN → fn → COMMIT → RELEASE_LOCK，
 * 放锁时占位行已经对外可见。（`GET_LOCK` 是连接级状态，锁与事务共用同一条连接还有一个好处：
 * 等待者每个只占一条连接，不会出现「锁连接与事务连接互相等对方」的池内死锁。）
 */
export async function runInAiAdmission<T>(db: DbAdapter, fn: (tx: DbAdapter) => Promise<T>): Promise<T> {
  return withAdmissionQueue(async () => {
    try {
      return await db.transactionWithNamedLock(ADMISSION_LOCK_NAME, AI_ADMISSION_LOCK_TIMEOUT_MS, fn);
    } catch (error) {
      // 锁没抢到是「稍后再试」，不是服务端故障：保持 429 语义，别退化成 500。
      if (error instanceof NamedLockTimeoutError) {
        throw new AiQuotaError(`AI 准入排队超过 ${AI_ADMISSION_LOCK_TIMEOUT_MS} 毫秒，请重试`, 2);
      }
      throw error;
    }
  });
}

/** 命名锁的名字（回归脚本与 MariaDB 侧 `IS_USED_LOCK` 体检都用它）。 */
export const ADMISSION_LOCK_NAME = "px_ai_admission";

let admissionChain: Promise<unknown> = Promise.resolve();
function withAdmissionQueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = admissionChain.then(() => fn());
  admissionChain = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * 在准入临界区内判定：超限抛 `AiQuotaError`（HTTP 429 + `Retry-After`）。
 * 只可在 `runInAiAdmission` 的回调里调用——放在临界区外就等于回到「先查后写」的老问题。
 */
export async function checkAiQuotaInAdmission(db: DbAdapter, userId: number | null | undefined): Promise<void> {
  const verdict = evaluateAiQuota(await readAiQuotaSnapshot(db, userId));
  if (!verdict.ok) throw new AiQuotaError(verdict.message, verdict.retryAfterSeconds);
}

/** 同步调用的准入占位需要写进运行记录的归属信息。 */
export interface AiReservationMeta {
  feature: string;
  model?: string | null;
  stage?: string | null;
}

/**
 * 同步 AI 调用的原子准入（CR8 + CR9）：判定通过后，在同一临界区里插入一条
 * `success IS NULL` 的运行行作为占位，返回它的 id。
 *
 * 调用方必须在调用结束时用这个 id 走 `finalizeAiRun`——回填不只是埋点，也是释放名额。
 * 被拒时事务回滚，不会留下无法结算的幽灵行（这是旧「先 assertAiQuota 再 recordAiRun」
 * 顺序刻意回避的问题，合并成一步后同一个不变量自然成立）。
 */
export async function reserveAiCall(
  db: DbAdapter,
  userId: number | null | undefined,
  meta: AiReservationMeta
): Promise<number> {
  return runInAiAdmission(db, async (tx) => {
    await checkAiQuotaInAdmission(tx, userId);
    return insertAiRunRow(tx, {
      userId: userId ?? null,
      feature: meta.feature,
      model: meta.model ?? null,
      stage: meta.stage ?? "request",
    });
  });
}
