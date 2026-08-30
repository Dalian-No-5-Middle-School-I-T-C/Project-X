/**
 * LLM client helpers — thin wrappers around the Python llmclient sidecar.
 *
 * Extracted from index.ts so the analysis router can import them.
 */
import { ensureLlmClient } from "./llm-launcher";
import { recordProviderCall, finalizeAiRun } from "../../../server/services/aiTelemetry";
import { getLlmEnv } from "./llm-env";
import { parseUsagePayload } from "./llm-usage";

export interface LlmCallTelemetry {
  runId?: number | null;
  provider?: string;
  model?: string | null;
  stage?: string | null;
}

export function llmClientUrl(pathname = ""): string {
  const base = (getLlmEnv("LLMCLIENT_URL") || "http://127.0.0.1:8766").replace(/\/+$/, "");
  return `${base}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
}

export function llmClientHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...(extra ?? {}) };
  // 安全审计（P1）：与 Python 侧同源读取内部密钥 —— 既认 shell 环境变量，
  // 也认 llmclient/.env（config.py 的 load_dotenv 同款），避免配置后 Node 不发送鉴权。
  const internalKey = getLlmEnv("LLMCLIENT_INTERNAL_API_KEY");
  if (internalKey && !headers.Authorization) {
    headers.Authorization = `Bearer ${internalKey}`;
  }
  return headers;
}

/**
 * 发送一次 AI 请求到 Python llmclient 边车。
 * @param telemetry 可选埋点上下文：传入时在本函数内自动记录一次 ai_provider_calls
 *                  （实际模型调用层）。/health 探测不计入。埋点失败不影响业务返回。
 */
export async function fetchLlmClient(
  pathname: string,
  init?: RequestInit,
  timeoutMs = 5_000,
  telemetry?: LlmCallTelemetry
): Promise<Response> {
  // Best-effort: make sure the Python sidecar is up (auto-starts it on first need).
  const autostart = (process.env.LLMCLIENT_AUTOSTART ?? "true").toLowerCase();
  if (autostart !== "false" && autostart !== "0") {
    try {
      await ensureLlmClient();
    } catch {
      /* fall through; the fetch below will surface the connection error */
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  let success = false;
  let errorCode: string | null = null;
  let tokens: number | null = null;
  try {
    const response = await fetch(llmClientUrl(pathname), {
      ...init,
      headers: llmClientHeaders(init?.headers ? Object.fromEntries(new Headers(init.headers).entries()) : undefined),
      signal: controller.signal
    });
    success = response.ok;
    if (!success) errorCode = `HTTP_${response.status}`;

    // 观测：成功响应中提取 usage 落库（逻辑任务层 tokens_in/tokens_out + 实际模型调用层 tokens）。
    // 需要消费一次响应体，因此重包 Response 返回，保证调用方仍可 json()/text()。
    if (telemetry && pathname !== "/health") {
      let bodyText = "";
      try {
        bodyText = await response.text();
        const parsed = bodyText ? JSON.parse(bodyText) : null;
        const usage = parseUsagePayload(parsed);
        if (usage) {
          tokens = usage.tokensIn + usage.tokensOut;
          await finalizeAiRun(telemetry.runId ?? null, {
            tokensIn: usage.tokensIn,
            tokensOut: usage.tokensOut,
          }).catch(() => {});
        }
      } catch {
        // 读取/解析失败不影响业务返回；调用方拿到的是已读取的文本（可能为空）。
      }
      return new Response(bodyText, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }
    return response;
  } catch (err) {
    success = false;
    errorCode = err instanceof Error && err.name === "AbortError" ? "TIMEOUT" : "EXCEPTION";
    throw err;
  } finally {
    clearTimeout(timer);
    // 实际模型调用层观测：仅当显式传入 telemetry 且非健康检查。
    if (telemetry && pathname !== "/health") {
      const latency = Date.now() - startedAt;
      recordProviderCall({
        runId: telemetry.runId ?? null,
        provider: telemetry.provider ?? "llmclient",
        model: telemetry.model ?? null,
        stage: telemetry.stage ?? null,
        success,
        latencyMs: latency,
        errorCode,
        tokens
      }).catch(() => {});
    }
  }
}
