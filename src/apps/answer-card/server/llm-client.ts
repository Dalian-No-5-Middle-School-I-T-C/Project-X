/**
 * LLM client helpers — thin wrappers around the Python llmclient sidecar.
 *
 * Extracted from index.ts so the analysis router can import them.
 */
import { ensureLlmClient } from "./llm-launcher";
import { getLlmEnv } from "./llm-env";

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

export async function fetchLlmClient(pathname: string, init?: RequestInit, timeoutMs = 5_000): Promise<Response> {
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
  try {
    return await fetch(llmClientUrl(pathname), {
      ...init,
      headers: llmClientHeaders(init?.headers ? Object.fromEntries(new Headers(init.headers).entries()) : undefined),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}
