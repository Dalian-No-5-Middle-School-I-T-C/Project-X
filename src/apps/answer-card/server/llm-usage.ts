/**
 * LLM 响应体中的 token 用量解析（纯函数，供 llm-client 观测层使用）。
 * llmclient 返回的约定格式：{ usage: { tokensIn: number; tokensOut: number } }
 */
export type LlmUsage = { tokensIn: number; tokensOut: number };

export function parseUsagePayload(payload: unknown): LlmUsage | null {
  if (!payload || typeof payload !== "object") return null;
  const usage = (payload as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return null;
  const { tokensIn, tokensOut } = usage as Record<string, unknown>;
  if (typeof tokensIn !== "number" || !Number.isFinite(tokensIn)) return null;
  if (typeof tokensOut !== "number" || !Number.isFinite(tokensOut)) return null;
  return { tokensIn, tokensOut };
}
