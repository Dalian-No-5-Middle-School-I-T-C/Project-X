const TOKEN_KEY = "projectx_auth_token";

// v1.6.0: API 基础地址支持运行时配置
// 优先级: localStorage > VITE_PROJECTX_API_BASE > 空（相对路径）
function getApiBase(): string {
  try {
    const stored = localStorage.getItem("projectx_server_url");
    if (stored) return stored.replace(/\/+$/, "");
  } catch { /* ignore */ }
  return (import.meta.env.VITE_PROJECTX_API_BASE ?? "").replace(/\/+$/, "");
}

let authToken: string | null = null;

export function apiUrl(url: string): string {
  const base = getApiBase();
  if (!base || /^[a-z][a-z0-9+.-]*:/i.test(url)) {
    return url;
  }
  return url.startsWith("/") ? `${base}${url}` : `${base}/${url}`;
}

export function getAuthToken(): string | null {
  if (authToken) return authToken;
  try {
    authToken = localStorage.getItem(TOKEN_KEY);
  } catch {
    authToken = null;
  }
  return authToken;
}

export function setAuthToken(token: string | null): void {
  authToken = token;
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore storage errors
  }
}

function notifyUnauthorized(): void {
  setAuthToken(null);
  window.dispatchEvent(new Event("projectx:unauthorized"));
}

export async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const token = getAuthToken();
  // v1.6.0: 同时支持 Api-Key header
  const storedApiKey = (() => { try { return localStorage.getItem("projectx_api_key"); } catch { return null; } })();
  const headers = new Headers(options?.headers);
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  if (storedApiKey && !headers.has("X-Api-Key")) {
    headers.set("X-Api-Key", storedApiKey);
  }
  const response = await fetch(apiUrl(url), { ...options, headers });
  if (!response.ok) {
    let message = response.statusText;
    let body: Record<string, unknown> | null = null;
    try {
      body = (await response.json()) as Record<string, unknown>;
      if (typeof body.message === "string") message = body.message;
    } catch {
      const text = await response.text().catch(() => "");
      if (text) message = text;
    }
    const error = new Error(message) as Error & { status?: number };
    error.status = response.status;
    if (body) Object.assign(error, body);
    // P1-3: 全局记录 API 错误，即使调用方 .catch(() => {}) 也不会完全吞掉
    console.warn(`[API] ${options?.method ?? "GET"} ${url} 失败 (${response.status}): ${message}`);
    if (response.status === 401 && !url.includes("/api/auth/login")) {
      notifyUnauthorized();
    }
    throw error;
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function authFetch(url: string, options?: RequestInit): Promise<Response> {
  const token = getAuthToken();
  const storedApiKey = (() => { try { return localStorage.getItem("projectx_api_key"); } catch { return null; } })();
  const headers = new Headers(options?.headers);
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  if (storedApiKey && !headers.has("X-Api-Key")) {
    headers.set("X-Api-Key", storedApiKey);
  }
  return fetch(apiUrl(url), { ...options, headers });
}

/** 为无法在请求头携带 Token 的场景（PDF、SSE 等）追加 ?token= */
export function urlWithToken(url: string): string {
  const token = getAuthToken();
  const resolved = apiUrl(url);
  if (!token) return resolved;
  const sep = resolved.includes("?") ? "&" : "?";
  return `${resolved}${sep}token=${encodeURIComponent(token)}`;
}

/** P1-14: 媒体资源URL（图片、PDF iframe等）。
 *  同源请求依靠 httpOnly cookie 认证，不暴露 token 在 URL 中；
 *  跨源请求（远端 API 模式）才追加 ?token=。 */
export function mediaUrl(url: string): string {
  const base = getApiBase();
  // 同源：cookies 自动发送，不需要 token
  if (!base) return apiUrl(url);
  // 跨源：需要 token query param
  return urlWithToken(url);
}
