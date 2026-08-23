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
import { trackAnalysisCall } from "./aiTelemetry";
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

/** 执行一次 LLM 学情分析（同步阻塞，由后台队列串行调用）。 */
export async function runAiAnalysis(spec: AiJobSpec): Promise<AiAnalysisResponse> {
  const model = spec.model ?? null;
  // AI 调用观测（逻辑任务层 + 实际模型调用层双层埋点），埋点失败不影响业务调用
  const response = await trackAnalysisCall({
    userId: spec.userId ?? null,
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
}

/** 服务启动时调用：把上次进程残留的 queued/running 任务标记为 failed。 */
export async function cleanupInterruptedAiJobs(): Promise<void> {
  await markInterruptedJobsFailed(getMysqlDb());
}

/** 创建任务并立即返回 jobId。 */
export async function createAiAnalysisJob(input: AiJobCreateInput): Promise<number> {
  const db = getMysqlDb();
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

/** 将任务入队执行（fire-and-forget，调用方负责 catch 日志）。 */
export function enqueueAiAnalysisJob(jobId: number, spec: AiJobSpec): Promise<AiAnalysisResponse> {
  const db = getMysqlDb();
  return enqueueSerial(async () => {
    // 队列是串行的，DB 单连接下不会插队
    await db.run("UPDATE ai_analysis_jobs SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE id = ?", jobId);
    try {
      const startedAt = Date.now();
      // 任务创建者从任务表读取，注入遥测（AI 调用观测 user_id 归属）
      const createdBy = spec.userId ?? await db.get("SELECT created_by FROM ai_analysis_jobs WHERE id = ?", jobId).then((r: any) => r?.created_by ?? null);
      const result = await runAiAnalysis({ ...spec, userId: createdBy ?? null });
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
