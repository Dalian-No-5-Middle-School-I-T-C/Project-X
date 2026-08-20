const TOKEN_KEY = "projectx_auth_token";

// v1.6.0: API 基础地址支持运行时配置
// Web 端优先级: localStorage > VITE_PROJECTX_API_BASE > 空（相对路径）
// 扫描端始终使用本机相对路径；远端服务器仅供 scanner upload API 使用。
function getApiBase(): string {
  if (import.meta.env.VITE_BUILD_TARGET === "scanner") return "";
  try {
    const stored = localStorage.getItem("projectx_server_url");
    if (stored) return stored.replace(/\/+$/, "");
  } catch { /* ignore */ }
  return (import.meta.env.VITE_PROJECTX_API_BASE ?? "").replace(/\/+$/, "");
}

// 安全审计（F-6）：API Key 本地存储带 30 天过期时间；兼容旧纯字符串格式（视为未过期，随下次保存升级）。
const API_KEY_EXPIRE_MS = 30 * 24 * 60 * 60 * 1000;

export function getStoredApiKey(): string | null {
  try {
    const raw = localStorage.getItem("projectx_api_key");
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { v?: number; k?: string; exp?: number };
      if (parsed?.v === 1 && typeof parsed.k === "string") {
        if (typeof parsed.exp === "number" && Date.now() > parsed.exp) {
          localStorage.removeItem("projectx_api_key");
          return null;
        }
        return parsed.k;
      }
    } catch { /* 旧格式纯字符串，按未过期处理 */ }
    return raw;
  } catch {
    return null;
  }
}

export function storeApiKey(key: string | null): void {
  try {
    if (!key) {
      localStorage.removeItem("projectx_api_key");
      return;
    }
    localStorage.setItem("projectx_api_key", JSON.stringify({ v: 1, k: key, exp: Date.now() + API_KEY_EXPIRE_MS }));
  } catch {
    /* ignore */
  }
}

function getRemoteScannerBase(): string {
  try {
    return (localStorage.getItem("projectx_server_url") ?? "").trim().replace(/\/+$/, "");
  } catch {
    return "";
  }
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
  const storedApiKey = import.meta.env.VITE_BUILD_TARGET === "scanner" ? null : getStoredApiKey();
  const headers = new Headers(options?.headers);
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  if (storedApiKey && !headers.has("X-Api-Key")) {
    headers.set("X-Api-Key", storedApiKey);
  }
  const response = await fetch(apiUrl(url), { ...options, headers, credentials: "include" });
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
  const storedApiKey = import.meta.env.VITE_BUILD_TARGET === "scanner" ? null : getStoredApiKey();
  const headers = new Headers(options?.headers);
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  if (storedApiKey && !headers.has("X-Api-Key")) {
    headers.set("X-Api-Key", storedApiKey);
  }
  // 安全审计（F-6）：同源请求同时携带 HttpOnly Cookie（主通道），Authorization 头作为兼容回退。
  // credentials include 使服务端 Set-Cookie 的 projectx_auth_token 自动随请求发送。
  return fetch(apiUrl(url), { ...options, headers, credentials: "include" });
}

/** 扫描端专用：仅把远程上传请求发送到配置的 Project-X 服务器。 */
export function remoteScannerFetch(url: string, options?: RequestInit): Promise<Response> {
  const base = getRemoteScannerBase();
  if (!base) {
    return Promise.reject(new Error("未配置远端服务器地址"));
  }

  const headers = new Headers(options?.headers);
  const apiKey = getStoredApiKey();
  if (apiKey && !headers.has("X-Api-Key")) {
    headers.set("X-Api-Key", apiKey);
  }
  const resolved = /^[a-z][a-z0-9+.-]*:/i.test(url)
    ? url
    : `${base}${url.startsWith("/") ? url : `/${url}`}`;
  return fetch(resolved, { ...options, headers });
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
