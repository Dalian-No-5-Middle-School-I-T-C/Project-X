/**
 * AI 调用观测（服务端内部埋点，不暴露任何客户端路由）。
 *
 * 两层模型：
 *   - ai_analysis_runs ：逻辑任务层（一次"考试分析/学生分析/大考分析"特征调用）。
 *   - ai_provider_calls：实际模型调用层（每一次打向 Python llmclient 边车的 HTTP 往返），
 *                        run_id 关联 ai_analysis_runs。
 *
 * 安全约束：
 *   - 绝不保存 API Key / 完整提示词 / 学生姓名 / 完整回答，仅记录 feature、model、
 *     stage、success、latency、tokens(若可得)、error_code 等聚合字段。
 *   - 所有写入均包 try/catch，埋点失败绝不影响业务 AI 调用。
 */

import { getMysqlDb } from "../db";

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

/** 逻辑任务层：写入一条 AI 分析运行记录，返回自增 id（失败返回 null）。
 *  未传 success 时写入 NULL（pending）——调用尚未结束，不能预先记成功；
 *  运行结束后由 finalizeAiRun 回填。控制台成功率只统计已完成（success 非空）的调用。 */
export async function recordAiRun(input: AiRunInput): Promise<number | null> {
  try {
    const db = getMysqlDb();
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
    return typeof res.lastInsertRowid === "number" ? res.lastInsertRowid : Number(res.lastInsertRowid) || null;
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

/** 实际模型调用层：写入一次边车 HTTP 调用记录（失败不影响业务）。 */
export async function recordProviderCall(input: ProviderCallInput): Promise<void> {
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
 */
export async function trackAnalysisCall(opts: {
  userId: number | null;
  feature: AiRunFeature | string;
  model?: string | null;
  doCall: (runId: number | null) => Promise<Response>;
}): Promise<Response> {
  const startedAt = Date.now();
  const runId = await recordAiRun({
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
