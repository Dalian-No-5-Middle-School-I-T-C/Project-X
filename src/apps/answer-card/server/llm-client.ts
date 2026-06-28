/**
 * LLM client helpers — thin wrappers around the Python llmclient sidecar.
 *
 * Extracted from index.ts so the analysis router can import them.
 */
export function llmClientUrl(pathname = ""): string {
  const base = (process.env.LLMCLIENT_URL || "http://127.0.0.1:8766").replace(/\/+$/, "");
  return `${base}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
}

export function llmClientHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...(extra ?? {}) };
  const internalKey = process.env.LLMCLIENT_INTERNAL_API_KEY;
  if (internalKey && !headers.Authorization) {
    headers.Authorization = `Bearer ${internalKey}`;
  }
  return headers;
}

export async function fetchLlmClient(pathname: string, init?: RequestInit, timeoutMs = 5_000): Promise<Response> {
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
