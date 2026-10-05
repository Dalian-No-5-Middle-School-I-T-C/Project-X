// v1.6.0: API 基础地址支持运行时配置
// Web 端优先级: localStorage > VITE_PROJECTX_API_BASE > 空（相对路径）
// 扫描端始终使用本机相对路径；远端服务器仅供 scanner upload API 使用。
import { readServerUrl } from "../lib/scannerMode";
import { assertCredentialTransportAllowed } from "../lib/remoteCredentialTransport";
import { MEDIA_TICKET_MAX_PER_USER } from "../../../../shared/mediaTicketLimits";
function getViteEnv(): Record<string, string | undefined> | undefined {
  try { return (import.meta as unknown as { env?: Record<string, string | undefined> })?.env; } catch { return undefined; }
}
function isScannerBuild(): boolean {
  const env = getViteEnv();
  if (!env) return true; // Node/tsx 无 env 时视为 scanner：本地优先，保证离线回退与冒烟可用
  return env.VITE_BUILD_TARGET === "scanner";
}
function getApiBase(): string {
  if (isScannerBuild()) return "";
  return readServerUrl() || (getViteEnv()?.VITE_PROJECTX_API_BASE ?? "").replace(/\/+$/, "");
}

/**
 * 安全（R32）：跨机明文 HTTP 上不发凭据。
 *
 * 只管**运行时填写**的服务器地址（`projectx_server_url`）：那是老师在界面上敲进去的，
 * 少写一个 `s` 就变成明文，扫描端已有勾选入口可以显式放行。
 * `VITE_PROJECTX_API_BASE` 不在此列——它是部署方在构建期写死的选择，
 * 内网明文部署的 Web 端不该被一个没有界面无从勾选的闸门堵死。
 */
function assertRuntimeConfiguredTransportAllowed(): void {
  if (isScannerBuild()) return;
  const runtimeBase = readServerUrl();
  if (runtimeBase) assertCredentialTransportAllowed(runtimeBase);
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
  // v2.5.6：统一归一化，杜绝「192.168.1.100:5174」这类缺 scheme 的地址
  // 让 fetch 抛 TypeError、请求发不出去却让服务端无日志可查。
  return readServerUrl();
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
  // 安全审计（P1）：认证主通道为 HttpOnly Cookie。同源部署下登录响应不携带 token，
  // 此处的内存 token 仅存在于跨域 API 模式（getApiBase() 非空、无法共享 Cookie）时，
  // 从登录响应一次性取得并仅存于内存 —— 绝不写入 localStorage，避免 XSS 窃取长期令牌。
  return authToken;
}

export function setAuthToken(token: string | null): void {
  authToken = token;
}

function notifyUnauthorized(): void {
  setAuthToken(null);
  // 安全（R30）：会话失效时把已签发的媒体票据一并丢掉，别让缓存继续产出注定 401 的 URL。
  ticketCache.clear();
  window.dispatchEvent(new Event("projectx:unauthorized"));
}

/** 跨域 API 模式（getApiBase() 非空）：无法共享 HttpOnly Cookie，需用内存 token 兜底。 */
function isCrossOriginApiMode(): boolean {
  return Boolean(getApiBase());
}

export async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const token = getAuthToken();
  const crossOrigin = isCrossOriginApiMode();
  // v1.6.0: 同时支持 Api-Key header
  const storedApiKey = isScannerBuild() ? null : getStoredApiKey();
  if (crossOrigin && (token || storedApiKey)) assertRuntimeConfiguredTransportAllowed();
  const headers = new Headers(options?.headers);
  // 安全审计（P1）：同源部署下认证主通道 = HttpOnly Cookie（credentials: include），
  // 不携带 Bearer；仅跨域 API 模式（Cookie 无法跨站点携带）才附加内存 token 的 Bearer。
  if (token && crossOrigin && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  if (storedApiKey && !headers.has("X-Api-Key")) {
    headers.set("X-Api-Key", storedApiKey);
  }
  // 字符串 body 一律按 JSON 发送：fetch 对字符串默认给 text/plain，express.json()
  // 只解析 application/json，缺此头会导致 req.body 为空、后端 400（如全局设置保存）。
  if (typeof options?.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(apiUrl(url), { ...options, headers, credentials: "include" });
  if (!response.ok) {
    let message = response.statusText;
    let body: Record<string, unknown> | null = null;
    try {
      body = (await response.json()) as Record<string, unknown>;
      if (typeof body.message === "string") message = body.message;
      else if (typeof body.error === "string") message = body.error;
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
  const crossOrigin = isCrossOriginApiMode();
  const storedApiKey = isScannerBuild() ? null : getStoredApiKey();
  // 安全（R32）：闸门失败要变成 rejected promise，不能同步抛——调用方普遍只 .catch 异步错误。
  if (crossOrigin && (token || storedApiKey)) {
    try {
      assertRuntimeConfiguredTransportAllowed();
    } catch (error) {
      return Promise.reject(error);
    }
  }
  const headers = new Headers(options?.headers);
  if (token && crossOrigin && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  if (storedApiKey && !headers.has("X-Api-Key")) {
    headers.set("X-Api-Key", storedApiKey);
  }
  // 安全审计（F-6/P1）：认证主通道 = HttpOnly Cookie。credentials: include 使服务端
  // Set-Cookie 的 projectx_auth_token 自动随请求发送；仅跨域 API 模式附加内存 token 的 Bearer。
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
  const wantsCredential = Boolean(apiKey) || headers.has("X-Api-Key") || headers.has("Authorization");
  // 安全（R32）：跨机明文 HTTP 上不发凭据。不带凭据的探测（健康检查）仍然放行，
  // 这样界面还能区分「服务器不可达」与「服务器可达但凭据被拦下」。
  if (wantsCredential) {
    try {
      assertCredentialTransportAllowed(base);
    } catch (error) {
      return Promise.reject(error);
    }
  }
  if (apiKey && !headers.has("X-Api-Key")) {
    headers.set("X-Api-Key", apiKey);
  }
  const resolved = /^[a-z][a-z0-9+.-]*:/i.test(url)
    ? url
    : `${base}${url.startsWith("/") ? url : `/${url}`}`;
  return fetch(resolved, { ...options, headers });
}

/**
 * 为无法在请求头携带凭据的场景（PDF、图片、SSE、下载）追加 URL 凭据。
 *
 * 安全（R30）：优先使用「单次资源票据」`?mt=`——它由 `/api/auth/media-ticket` 签发，
 * 只绑定「当前用户 + 这一条只读路径 + 时限」。主会话令牌 `?token=` 保留为兜底
 * （同步渲染的 `<img src>` 拿不到异步票据时），但服务端已把它限制在只读媒体白名单内，
 * 泄漏一条 URL 不再等于交出全部接口的只读权限。
 */
const ticketCache = new Map<string, { ticket: string; expiresAt: number }>();

/**
 * 客户端票据缓存上限与服务端 `PROJECTX_MEDIA_TICKET_MAX_PER_USER` 对齐（P2 返修）。
 *
 * 服务端在「单账号已有 N 张票据」时签发第 N+1 张会淘汰最早过期的那张；客户端若不限存，
 * 第 10 张图之后回看第 1 张仍会命中那张**服务端已经丢弃**的票据 URL，请求直接 401。
 * 浏览器读不到运维的环境变量，这里拿到的是默认档位——方向是安全的：客户端存得比服务端
 * 允许得更少，就绝不会留着一条注定失败的票据。
 */
const TICKET_CACHE_CAP = Math.max(1, MEDIA_TICKET_MAX_PER_USER);

function rememberTicket(pathname: string, ticket: string, expiresAt: number): void {
  ticketCache.set(pathname, { ticket, expiresAt });
  // 与服务端同一策略：按「最早过期」淘汰，而不是 Map 插入序——TTL 相同时两者等价，
  // 但显式按过期时间选，未来支持差异化 TTL 时不会悄悄退化成「淘汰最近才签的那张」。
  while (ticketCache.size > TICKET_CACHE_CAP) {
    let oldestPath: string | undefined;
    let oldestExpiry = Number.POSITIVE_INFINITY;
    for (const [path, entry] of ticketCache) {
      if (path === pathname) continue;
      if (entry.expiresAt < oldestExpiry) {
        oldestExpiry = entry.expiresAt;
        oldestPath = path;
      }
    }
    if (oldestPath === undefined) break;
    ticketCache.delete(oldestPath);
  }
}

function pathnameOf(resolvedUrl: string): string {
  try {
    return new URL(resolvedUrl, typeof location !== "undefined" ? location.href : "http://localhost").pathname;
  } catch {
    return resolvedUrl.split("?")[0];
  }
}

/**
 * @param force 忽略缓存里的旧票强制重签（票据被服务端撤销/驱逐后的补救路径）。
 *              force 时不回落旧票——回落等于让调用方再撞一次 401。
 */
async function ensureMediaTicket(pathname: string, force = false): Promise<string | null> {
  const cached = ticketCache.get(pathname);
  if (!force && cached && cached.expiresAt - Date.now() > 15_000) return cached.ticket;
  const fallback = force ? null : cached?.ticket ?? null;
  try {
    const issued = await fetchJson<{ ticket: string; expiresAt: number }>(
      "/api/auth/media-ticket",
      { method: "POST", body: JSON.stringify({ path: pathname }) }
    );
    if (issued?.ticket) {
      rememberTicket(pathname, issued.ticket, Number(issued.expiresAt));
      return issued.ticket;
    }
  } catch (error) {
    console.warn(`[media-ticket] 为 ${pathname} 签发票据失败，本次回落 URL 令牌`, error);
  }
  return fallback;
}

function appendQuery(url: string, key: string, value: string): string {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}${key}=${encodeURIComponent(value)}`;
}

/**
 * 剥掉 URL 上已有的 URL 凭据（`mt` / `token`），其余查询参数原样保留。
 * 重签/补签的入口可能拿到「已经拼过一次凭据」的 URL（例如直接来自 `img.src`），
 * 再 append 一次就会得到两个 `mt=`：Express 把重复键解析成数组，服务端按非法票据拒绝。
 */
function stripUrlCredentials(url: string): string {
  try {
    const parsed = new URL(url, typeof location !== "undefined" ? location.href : "http://localhost");
    parsed.searchParams.delete("mt");
    parsed.searchParams.delete("token");
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * 安全（R32）：跨机明文 HTTP 下不把凭据写进 URL——URL 会进浏览器历史、代理与访问日志，
 * 明文链路上还会被同网段直接读到。这里宁可让资源请求吃 401，也不外送令牌。
 */
function isRuntimeTransportAllowed(): boolean {
  try {
    assertRuntimeConfiguredTransportAllowed();
    return true;
  } catch {
    return false;
  }
}

/** 异步取得票据后再拼 URL：下载、window.open、EventSource 等可控时机都应走这一条。 */
export async function ticketedMediaUrl(url: string): Promise<string> {
  const resolved = stripUrlCredentials(apiUrl(url));
  if (!isCrossOriginApiMode()) return resolved; // 同源：HttpOnly Cookie 足够，URL 里不留任何凭据
  if (!isRuntimeTransportAllowed()) return resolved;
  const pathname = pathnameOf(resolved);
  const ticket = await ensureMediaTicket(pathname);
  if (ticket) return appendQuery(resolved, "mt", ticket);
  const token = getAuthToken();
  return token ? appendQuery(resolved, "token", token) : resolved;
}

/**
 * 同步版本（`<img src>` / `<a href>` 字面量）。
 * 命中缓存则用票据；未命中时先回落 `?token=`，同时后台补签一张，下一次渲染即用票据。
 */
export function urlWithToken(url: string): string {
  const token = getAuthToken();
  const resolved = apiUrl(url);
  if (!token) return resolved;
  if (!isRuntimeTransportAllowed()) return resolved;
  const cached = ticketCache.get(pathnameOf(resolved));
  if (cached && cached.expiresAt > Date.now()) {
    return appendQuery(resolved, "mt", cached.ticket);
  }
  void ensureMediaTicket(pathnameOf(resolved));
  return appendQuery(resolved, "token", token);
}

/** 退出登录/令牌失效时清空票据缓存，避免继续携带已作废的凭据。 */
export function clearMediaTicketCache(): void {
  ticketCache.clear();
}

/** 丢弃某个资源的缓存票据（资源加载 401/403 时用，别让下次渲染继续端出同一张废票）。 */
export function invalidateMediaTicket(url: string): void {
  const resolved = apiUrl(url);
  if (!isCrossOriginApiMode()) return;
  ticketCache.delete(pathnameOf(resolved));
}

/**
 * 重新签发并返回新的资源 URL（P2 返修）：`<img onerror>` 这类「浏览器自己发请求、
 * 拿不到响应码」的场景无法主动探测权限问题，只能在失败后换一张票重试。
 * 入参允许是「已经带过 mt/token 的 URL」（例如直接来自 `img.src`），内部会先剥掉旧凭据。
 * 同源模式下没有票据概念，原样返回。
 */
export async function resignMediaTicketUrl(url: string): Promise<string> {
  if (!isCrossOriginApiMode()) return apiUrl(url);
  const resolved = stripUrlCredentials(apiUrl(url));
  const pathname = pathnameOf(resolved);
  ticketCache.delete(pathname);
  const fresh = await ensureMediaTicket(pathname, true);
  if (fresh) return appendQuery(resolved, "mt", fresh);
  const token = getAuthToken();
  return token ? appendQuery(resolved, "token", token) : resolved;
}

/** P1-14: 媒体资源URL（图片、PDF iframe等）。
 *  同源请求依靠 httpOnly cookie 认证，不暴露 token 在 URL 中；
 *  跨源请求（远端 API 模式）才追加 URL 凭据。 */
export function mediaUrl(url: string): string {
  const base = getApiBase();
  // 同源：cookies 自动发送，不需要 token
  if (!base) return apiUrl(url);
  // 跨源：需要 URL 凭据（优先单次票据）
  return urlWithToken(url);
}
