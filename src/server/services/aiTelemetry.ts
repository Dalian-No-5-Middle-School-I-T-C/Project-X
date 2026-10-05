/**
 * AI 调用观测（服务端内部埋点，不暴露任何客户端路由）。
 *
 * 两层模型：
 *   - ai_analysis_runs ：逻辑任务层（一次"考试分析/学生分析/大考分析"特征调用）。
 *   - ai_provider_calls：实际模型调用层（每一次打向 Python llmclient 边车的 HTTP 往返），
 *                        run_id 关联 ai_analysis_runs。
 *
 * 副作用（PR #312 CR8）：`success IS NULL` 的运行行同时充当并发名额的占位，
 * 所以「回填」不只是埋点，也是释放——所有调用路径都必须在结束时走到 finalizeAiRun。
 *
 * 安全约束：
 *   - 绝不保存 API Key / 完整提示词 / 学生姓名 / 完整回答，仅记录 feature、model、
 *     stage、success、latency、tokens(若可得)、error_code 等聚合字段。
 *   - 所有写入均包 try/catch，埋点失败绝不影响业务 AI 调用。
 */

import { getMysqlDb } from "../db";
import type { DbAdapter } from "../db";

export type AiRunFeature = "exam_analysis" | "student_analysis" | "exam_group_analysis";

export interface AiRunInput {
  userId: number | null;
  feature: AiRunFeature | string;
  model?: string | null;
  stage?: string | null;
  success?: boolean;
  latencyMs?: number | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  errorCode?: string | null;
}

export interface AiRunPatch {
  success?: boolean;
  latencyMs?: number | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  errorCode?: string | null;
}

export interface ProviderCallInput {
  runId: number | null;
  provider: string;
  model?: string | null;
  stage?: string | null;
  success: boolean;
  latencyMs: number;
  tokens?: number | null;
  errorCode?: string | null;
}

/** 逻辑任务层：插入一条运行记录并返回自增 id。会抛错——供准入临界区使用（占位失败必须让请求失败）。 */
export async function insertAiRunRow(db: DbAdapter, input: AiRunInput): Promise<number> {
  const res = await db.run(
    `INSERT INTO ai_analysis_runs
       (user_id, feature, model, stage, success, latency_ms, tokens_in, tokens_out, error_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.userId ?? null,
    input.feature,
    input.model ?? null,
    input.stage ?? null,
    input.success === undefined ? null : (input.success ? 1 : 0),
    input.latencyMs ?? null,
    input.tokensIn ?? null,
    input.tokensOut ?? null,
    input.errorCode ?? null
  );
  return Number(res.lastInsertRowid);
}

/** 逻辑任务层：写入一条 AI 分析运行记录，返回自增 id（失败返回 null）。
 *  未传 success 时写入 NULL（pending）——调用尚未结束，不能预先记成功；
 *  运行结束后由 finalizeAiRun 回填。控制台成功率只统计已完成（success 非空）的调用。
 *  注意：pending 行同时是并发名额的占位（PR #312 CR8），埋点失败在这里是静默的，
 *  准入路径请勿使用本函数而应直接用 `insertAiRunRow`。 */
export async function recordAiRun(input: AiRunInput, db: DbAdapter = getMysqlDb()): Promise<number | null> {
  try {
    return await insertAiRunRow(db, input);
  } catch (err) {
    console.warn("[aiTelemetry] recordAiRun failed:", (err as Error)?.message);
    return null;
  }
}

/** 逻辑任务层：运行结束后回填成功/延迟/错误码（失败不影响业务）。 */
export async function finalizeAiRun(runId: number | null, patch: AiRunPatch): Promise<void> {
  if (runId == null) return;
  try {
    const db = getMysqlDb();
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (patch.success !== undefined) { sets.push("success = ?"); vals.push(patch.success ? 1 : 0); }
    if (patch.latencyMs !== undefined) { sets.push("latency_ms = ?"); vals.push(patch.latencyMs); }
    if (patch.tokensIn !== undefined) { sets.push("tokens_in = ?"); vals.push(patch.tokensIn); }
    if (patch.tokensOut !== undefined) { sets.push("tokens_out = ?"); vals.push(patch.tokensOut); }
    if (patch.errorCode !== undefined) { sets.push("error_code = ?"); vals.push(patch.errorCode); }
    if (sets.length === 0) return;
    vals.push(runId);
    await db.run(`UPDATE ai_analysis_runs SET ${sets.join(", ")} WHERE id = ?`, ...vals);
  } catch (err) {
    console.warn("[aiTelemetry] finalizeAiRun failed:", (err as Error)?.message);
  }
}

/**
 * 服务启动时清理上次进程留下的在途占位（PR #312 CR8）。
 *
 * `success IS NULL` 的行现在同时是并发名额的占位：进程被 kill 时没人回填，
 * 不清理就会一直占用名额直到失效窗口过去。启动阶段不存在真正在途的调用
 * （本进程还没开始服务），所以残留一律判为中断。失败只告警，不阻塞启动。
 */
export async function markInterruptedAiRuns(db: DbAdapter): Promise<void> {
  try {
    await db.run(
      `UPDATE ai_analysis_runs SET success = 0, error_code = 'INTERRUPTED' WHERE success IS NULL`
    );
  } catch (err) {
    console.warn("[aiTelemetry] markInterruptedAiRuns failed:", (err as Error)?.message);
  }
}

/** 实际模型调用层：写入一次边车 HTTP 调用记录（失败不影响业务）。 */export async function recordProviderCall(input: ProviderCallInput): Promise<void> {
  try {
    const db = getMysqlDb();
    await db.run(
      `INSERT INTO ai_provider_calls
         (run_id, provider, model, stage, success, latency_ms, tokens, error_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      input.runId,
      input.provider,
      input.model ?? null,
      input.stage ?? null,
      input.success ? 1 : 0,
      input.latencyMs,
      input.tokens ?? null,
      input.errorCode ?? null
    );
  } catch (err) {
    console.warn("[aiTelemetry] recordProviderCall failed:", (err as Error)?.message);
  }
}

/**
 * 包裹一次业务 AI 调用：记录逻辑任务层运行、计时、在成功/失败/异常时回填，
 * 并把 runId 透传给 doCall（doCall 内部应对 fetchLlmClient 传入 telemetry 以联动
 * 实际模型调用层）。异常会重新抛出，由调用方既有 catch 处理状态码映射。
 *
 * `reservedRunId`（PR #312 CR9）：调用方已在准入临界区里插好占位行时传入，
 * 本函数不再另起一行——否则一次调用产生两条记录，账本与名额都会翻倍。
 * 无论走哪条路，退出时都会回填，占位不会悬着不放。
 */
export async function trackAnalysisCall(opts: {
  userId: number | null;
  feature: AiRunFeature | string;
  model?: string | null;
  reservedRunId?: number | null;
  doCall: (runId: number | null) => Promise<Response>;
}): Promise<Response> {
  const startedAt = Date.now();
  const runId = opts.reservedRunId ?? await recordAiRun({
    userId: opts.userId,
    feature: opts.feature,
    model: opts.model ?? null,
    stage: "request"
  });
  try {
    const response = await opts.doCall(runId);
    const elapsed = Date.now() - startedAt;
    if (!response.ok) {
      await finalizeAiRun(runId, { success: false, latencyMs: elapsed, errorCode: `HTTP_${response.status}` });
    } else {
      await finalizeAiRun(runId, { success: true, latencyMs: elapsed });
    }
    return response;
  } catch (err) {
    const elapsed = Date.now() - startedAt;
    const code =
      err instanceof Error && err.name === "AbortError" ? "TIMEOUT" :
      err instanceof Error && (err.message.includes("fetch") || err.message.includes("ECONNREFUSED")) ? "UNREACHABLE" :
      "EXCEPTION";
    await finalizeAiRun(runId, { success: false, latencyMs: elapsed, errorCode: code });
    throw err;
  }
}
