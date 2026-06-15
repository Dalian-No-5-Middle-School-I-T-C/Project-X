const TOKEN_KEY = "projectx_auth_token";
const API_BASE = (import.meta.env.VITE_PROJECTX_API_BASE ?? "").replace(/\/+$/, "");

let authToken: string | null = null;

export function apiUrl(url: string): string {
  if (!API_BASE || /^[a-z][a-z0-9+.-]*:/i.test(url)) {
    return url;
  }
  return url.startsWith("/") ? `${API_BASE}${url}` : `${API_BASE}/${url}`;
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
  const headers = new Headers(options?.headers);
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  const response = await fetch(apiUrl(url), { ...options, headers });
  if (!response.ok) {
    let message = response.statusText;
    try {
      const body = (await response.json()) as { message?: string };
      if (body.message) message = body.message;
    } catch {
      const text = await response.text().catch(() => "");
      if (text) message = text;
    }
    const error = new Error(message) as Error & { status?: number };
    error.status = response.status;
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
  const headers = new Headers(options?.headers);
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
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
