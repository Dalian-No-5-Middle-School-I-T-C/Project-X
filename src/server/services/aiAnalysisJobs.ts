/**
 * AI 学情分析异步任务化（建议 5）。
 *
 * 单机不引入消息队列：用「SQLite 任务表 + 内存串行队列」。
 *  - POST 创建任务立即返回 jobId（不阻塞 120s）
 *  - 后台串行队列执行（并发 = 1，天然防重）
 *  - 前端轮询 GET /ai-analysis/jobs/:id
 *  - 落库的 result 顺便成为 AI 分析的持久缓存
 *  - 服务重启时残留的 queued/running 任务由服务启动阶段一次性标记为 failed（见 createApp）
 */
import { getMysqlDb } from "../db";
import type { DbAdapter } from "../db";
import { fetchLlmClient } from "../../apps/answer-card/server/llm-client";
import { trackAnalysisCall, markInterruptedAiRuns, insertAiRunRow } from "./aiTelemetry";
import { checkAiQuotaInAdmission, runInAiAdmission } from "./aiQuota";
import type { AiAnalysisResponse, AiJobPollResponse, AiJobState } from "../../shared/types";

export interface AiJobSpec {
  examId?: number;
  groupId?: number;
  classId?: number;
  model?: string;
  providerOverride?: Record<string, unknown>;
  /** 任务创建者（AI 调用观测写入 ai_analysis_runs.user_id）。 */
  userId?: number | null;
}

export interface AiJobCreateInput extends AiJobSpec {
  createdBy?: number | null;
}

const VALID_STATES: AiJobState[] = ["queued", "running", "done", "error"];

/** 后台串行队列：全局单条 Promise 链，保证任意时刻只有一个任务在跑。 */
let jobQueue: Promise<void> = Promise.resolve();
function enqueueSerial<T>(fn: () => Promise<T>): Promise<T> {
  const run = jobQueue.then(() => fn());
  jobQueue = run.then(() => undefined, () => undefined);
  return run;
}

function rowToPoll(row: any): AiJobPollResponse {
  return {
    id: Number(row.id),
    examId: row.exam_id != null ? Number(row.exam_id) : null,
    groupId: row.group_id != null ? Number(row.group_id) : null,
    classId: row.class_id != null ? Number(row.class_id) : null,
    status: (VALID_STATES.includes(row.status) ? row.status : "error") as AiJobState,
    result: row.result ? (JSON.parse(row.result) as AiAnalysisResponse) : null,
    error: row.error ?? null,
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

/**
 * 执行一次 LLM 学情分析（同步阻塞，由后台队列串行调用）。
 *
 * 这里只写观测、不再判一次配额：准入在建任务时已经做过（`reserveAiAnalysisJob`），
 * 名额的接力由 `claimAiAnalysisJobForRun` 负责——任务转入 `running` 与那条
 * `success IS NULL` 的运行行在同一个事务里交接（PR #312 CR8 的分工，两者相加才是不重复的
 * 在途数）。若在此重新准入，排队中的任务会把自己挡住。
 * `reservedRunId` 就是交接时建好的那条运行行，本函数只回填它，不再另起一行。
 */
export async function runAiAnalysis(spec: AiJobSpec, reservedRunId?: number | null): Promise<AiAnalysisResponse> {
  const model = spec.model ?? null;
  // AI 调用观测（逻辑任务层 + 实际模型调用层双层埋点），埋点失败不影响业务调用
  const response = await trackAnalysisCall({
    userId: spec.userId ?? null,
    reservedRunId: reservedRunId ?? null,
    feature: spec.groupId != null ? "exam_group_analysis" : "exam_analysis",
    model,
    doCall: (runId) => fetchLlmClient(
      "/analysis/run",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          examId: spec.examId,
          groupId: spec.groupId,
          classId: spec.classId,
          model,
          locale: "zh-CN",
          providerOverride: spec.providerOverride ?? undefined,
        }),
      },
      120_000,
      { runId, provider: "llmclient", model, stage: "analysis" },
    ),
  });

  if (!response.ok) {
    let message = `AI 服务返回 ${response.status}`;
    try {
      const body = await response.json() as { detail?: string; message?: string };
      message = body.detail || body.message || message;
    } catch {
      const text = await response.text().catch(() => "");
      if (text) message = text;
    }
    throw new Error(message);
  }
  return await response.json() as AiAnalysisResponse;
}

/** 服务重启后残留任务的清理（只在服务启动阶段调用一次，见 createApp）。 */
let interruptedCleanupDone = false;
export async function markInterruptedJobsFailed(db: DbAdapter): Promise<void> {
  if (interruptedCleanupDone) return;
  interruptedCleanupDone = true;
  await db.run(
    `UPDATE ai_analysis_jobs SET status = 'error', error = '服务重启中断，任务未完成' WHERE status IN ('queued', 'running')`
  );
  // PR #312 CR8：运行行的 success IS NULL 现在同时是并发名额的占位，
  // 崩溃残留若不清掉会一直压着名额，直到失效窗口过去。
  await markInterruptedAiRuns(db);
}

/** 服务启动时调用：把上次进程残留的 queued/running 任务标记为 failed。 */
export async function cleanupInterruptedAiJobs(): Promise<void> {
  await markInterruptedJobsFailed(getMysqlDb());
}

/** 创建任务并立即返回 jobId。 */
export async function createAiAnalysisJob(input: AiJobCreateInput, db: DbAdapter = getMysqlDb()): Promise<number> {
  const info = await db.run(
    `INSERT INTO ai_analysis_jobs (exam_id, group_id, class_id, status, model, created_by)
     VALUES (?, ?, ?, 'queued', ?, ?)`,
    input.examId ?? null,
    input.groupId ?? null,
    input.classId ?? null,
    input.model ?? null,
    input.createdBy ?? null,
  );
  return info.lastInsertRowid;
}

/**
 * 建任务 + 过配额，合成一个原子步骤（PR #312 CR9）。
 *
 * 旧写法是 `assertAiQuota()` 之后 `createAiAnalysisJob()`：两步之间没有互斥，
 * 一波并发请求读到同一份「还有名额」的旧账本，上限 8 照样能放进 11 个任务。
 * 现在判定与 `queued` 行写入在同一把锁的同一个事务里——任务行本身就是占位。
 * 超限时抛 `AiQuotaError`（路由渲染为 429 + Retry-After），事务回滚，不落任务行。
 */
export async function reserveAiAnalysisJob(input: AiJobCreateInput): Promise<number> {
  const db = getMysqlDb();
  return runInAiAdmission(db, async (tx) => {
    await checkAiQuotaInAdmission(tx, input.createdBy ?? null);
    return createAiAnalysisJob(input, tx);
  });
}

/**
 * 队列交接：把「任务转 running」与「它的在途占位出现」合成同一步（PR #312 复核 P2）。
 *
 * CR8 的名额账本是「`queued` 任务行 + `success IS NULL` 运行行」，两段接力本该无缝；
 * 但旧实现先把任务改成 `running`，运行行要等到 `trackAnalysisCall` 里才插入——中间那一段
 * 两条腿都不占位。串行队列本身不放大这个窗口，放大它的是准入：另一个提交恰好在交接间隙
 * 读账本，看到的既是 0 个排队也是 0 个在途，于是上限 8 能放进 9 个。
 *
 * 现在两条写语句落在同一把准入锁、同一个事务里：读取侧要么看到 `queued` 任务行，要么看到
 * 在途运行行，不存在两者皆空的瞬间；任务行已离开 `queued`，也不会被重复计数。
 * 占位写在准入锁内还有一层作用——它与「同步调用」的 `reserveAiCall` 互斥，交接不再能插到
 * 别人的「读账本 → 占位」中间。
 */
export async function claimAiAnalysisJobForRun(
  jobId: number,
  spec: AiJobSpec,
): Promise<{ runId: number; userId: number | null }> {
  return runInAiAdmission(getMysqlDb(), async (tx) => {
    // 创建者从任务表读：运行行的 user_id 决定这次调用算在谁的头上，缺了就退化成全局计数。
    const row = await tx.get<{ created_by: number | null }>(
      "SELECT created_by FROM ai_analysis_jobs WHERE id = ?", jobId);
    const userId = spec.userId ?? row?.created_by ?? null;
    const runId = await insertAiRunRow(tx, {
      userId,
      feature: spec.groupId != null ? "exam_group_analysis" : "exam_analysis",
      model: spec.model ?? null,
      stage: "request",
    });
    await tx.run(
      "UPDATE ai_analysis_jobs SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      jobId,
    );
    return { runId, userId };
  });
}

/** 将任务入队执行（fire-and-forget，调用方负责 catch 日志）。 */
export function enqueueAiAnalysisJob(jobId: number, spec: AiJobSpec): Promise<AiAnalysisResponse> {
  const db = getMysqlDb();
  return enqueueSerial(async () => {
    // 队列是串行的，DB 单连接下不会插队
    let claimed: { runId: number; userId: number | null };
    try {
      claimed = await claimAiAnalysisJobForRun(jobId, spec);
    } catch (err) {
      // 交接失败（准入锁超时、连接故障）时任务还停在 queued：它会一直压着一个名额，
      // 而轮询方永远等不到终态。就地判失败，让账本与客户端状态一起回到一致。
      const message = err instanceof Error ? err.message : String(err);
      await db.run(
        `UPDATE ai_analysis_jobs SET status = 'error', error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'queued'`,
        message.slice(0, 2000), jobId,
      ).catch(() => {});
      throw err;
    }
    const createdBy = claimed.userId;
    const reservedRunId = claimed.runId;
    try {
      const startedAt = Date.now();
      // 任务创建者已由交接步骤读出并写进运行行，这里只透传，不再另起观测行
      const result = await runAiAnalysis({ ...spec, userId: createdBy ?? null }, reservedRunId);
      await db.run(
        `UPDATE ai_analysis_jobs SET status = 'done', result = ?, error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        JSON.stringify(result),
        jobId,
      );
      console.log(`[AiJob] #${jobId} done in ${Date.now() - startedAt}ms`);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db.run(
        `UPDATE ai_analysis_jobs SET status = 'error', error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        message.slice(0, 2000),
        jobId,
      );
      throw err;
    }
  });
}

export async function getAiAnalysisJob(jobId: number): Promise<AiJobPollResponse | null> {
  const db = getMysqlDb();
  const row = await db.get("SELECT * FROM ai_analysis_jobs WHERE id = ?", jobId);
  return row ? rowToPoll(row) : null;
}

/** 恢复当前用户在同一考试/合集及班级范围内最近的分析任务。 */
export async function getLatestAiAnalysisJob(
  context: { examId: number; groupId?: never } | { groupId: number; examId?: never },
  createdBy: number,
  classId?: number,
): Promise<AiJobPollResponse | null> {
  const isGroup = context.groupId != null;
  const params: unknown[] = [isGroup ? context.groupId : context.examId, createdBy];
  if (classId != null) params.push(classId);
  const row = await getMysqlDb().get(
    `SELECT * FROM ai_analysis_jobs
     WHERE ${isGroup ? "group_id = ? AND exam_id IS NULL" : "exam_id = ? AND group_id IS NULL"}
       AND created_by = ? AND ${classId == null ? "class_id IS NULL" : "class_id = ?"}
     ORDER BY id DESC LIMIT 1`, ...params,
  );
  return row ? rowToPoll(row) : null;
}

/**
 * 读取任务及其创建者（供轮询接口的 IDOR 校验）。
 * 不把 created_by 放进 AiJobPollResponse，避免向客户端暴露任务归属。
 */
export async function getAiAnalysisJobWithCreator(jobId: number): Promise<{ job: AiJobPollResponse; createdBy: number | null } | null> {
  const db = getMysqlDb();
  const row = await db.get("SELECT * FROM ai_analysis_jobs WHERE id = ?", jobId);
  if (!row) return null;
  return { job: rowToPoll(row), createdBy: row.created_by != null ? Number(row.created_by) : null };
}
