// 安全（R32）：跨机明文 HTTP 上不得发送账号与 API Key。
//
// 现场事实：扫描端「服务器连接」的地址来自老师手填，`normalizeServerUrl` 会把缺 scheme 的
// `192.168.1.100:5174` 补成 `http://…`（这是 v2.5.6 修「请求根本没发出去」时必须保留的行为），
// 于是跨机上传默认走明文，`X-Api-Key` 与登录凭据在同一网段内可被任意嗅探——
// 而这把 Key 的权限是「向服务器写入扫描结果」，不是只读。
//
// 口径（与 R12 移动页面「非 https 跨源拒绝」同一套思路）：
// - **https** → 放行；
// - **回环**（localhost / 127.0.0.0-8 / ::1）→ 放行，流量不出本机，本地模式必须照旧可用；
// - **跨机明文 http** → 默认拒绝发送任何凭据，除非运维在「服务器连接」里对**这一个 host:port**
//   做过显式勾选。允许记录按 host:port 存，换服务器不会继承上一次的同意。
//
// 拒绝的是「带凭据的请求」，不是全部请求：不带凭据的 `/api/app/health` 探测仍然放行，
// 这样连接状态指示器还能告诉老师「服务器可达但凭据没发出去」，而不是退化成一片沉默。
//
// 纯函数与 localStorage 读写分开：判定逻辑不依赖浏览器，可在 Node 下直接断言
// （见 scripts/verify-insecure-remote-transport.ts）。

/** 允许跨机明文发送凭据的 host:port 白名单（显式勾选后写入，按目标主机粒度记录）。 */
export const INSECURE_TRANSPORT_HOSTS_KEY = "projectx_insecure_http_hosts";

export type CredentialTransportReason =
  | "https"
  | "loopback"
  | "explicit-allowance"
  | "blocked-plaintext"
  | "unparsable";

export interface CredentialTransportDecision {
  allowed: boolean;
  reason: CredentialTransportReason;
  /** 归一化后的 host:port（无法解析时为空串），用于白名单比对与界面提示。 */
  host: string;
  message: string;
}

/** 解析出 `protocol` 与 `host:port`；非 http(s) 或无法解析时返回 null。 */
export function parseServerTarget(raw: string | null | undefined): { protocol: string; host: string } | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname) return null;
    return { protocol: url.protocol, host: url.host };
  } catch {
    return null;
  }
}

/** 回环主机判定：localhost、127.0.0.0/8、::1（URL 会给 IPv6 带方括号）。 */
export function isLoopbackHost(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!bare) return false;
  if (bare === "localhost" || bare === "::1") return true;
  return /^127(\.\d{1,3}){3}$/.test(bare);
}

/** 是否是「跨机明文 http」目标（回环不算跨机）。 */
export function isInsecureRemoteTarget(raw: string | null | undefined): boolean {
  const target = parseServerTarget(raw);
  if (!target || target.protocol !== "http:") return false;
  const hostname = target.host.replace(/:\d+$/, "");
  return !isLoopbackHost(hostname);
}

/** 白名单里是否已对该 host:port 做过显式勾选（严格全等，不做通配、不做同网段推断）。 */
export function hasInsecureTransportAllowance(
  raw: string | null | undefined,
  grantedHosts: readonly string[],
): boolean {
  const target = parseServerTarget(raw);
  if (!target) return false;
  return grantedHosts.includes(target.host);
}

/** 拒绝时给老师看的原话：说清风险、出路，以及去哪儿勾选。 */
export function insecureTransportMessage(host: string): string {
  return `远端服务器 ${host} 使用明文 HTTP，跨机发送 API Key 或账号会被同网段窃听。`
    + "请改用 https:// 地址；若确属隔离的内网测试环境，先在「服务器连接」里勾选"
    + "「允许向该地址明文发送凭据」并保存，再重试。";
}

/**
 * 判定「能否把凭据发往这个地址」。
 * 无法解析的地址按拒绝处理（宁可不发，也不要把 Key 送进一个我们看不懂的目标）。
 */
export function evaluateCredentialTransport(
  raw: string | null | undefined,
  grantedHosts: readonly string[],
): CredentialTransportDecision {
  const target = parseServerTarget(raw);
  if (!target) {
    return {
      allowed: false,
      reason: "unparsable",
      host: "",
      message: "服务器地址无法解析，已阻止发送凭据。请在「服务器连接」中重新填写完整地址。",
    };
  }
  if (target.protocol === "https:") {
    return { allowed: true, reason: "https", host: target.host, message: "" };
  }
  const hostname = target.host.replace(/:\d+$/, "");
  if (isLoopbackHost(hostname)) {
    return { allowed: true, reason: "loopback", host: target.host, message: "" };
  }
  if (grantedHosts.includes(target.host)) {
    return { allowed: true, reason: "explicit-allowance", host: target.host, message: "" };
  }
  return {
    allowed: false,
    reason: "blocked-plaintext",
    host: target.host,
    message: insecureTransportMessage(target.host),
  };
}

function readStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** 读取已勾选的 host:port 列表（脏值/超限一律当作没有勾选）。 */
export function readInsecureTransportHosts(): string[] {
  const storage = readStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(INSECURE_TRANSPORT_HOSTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 255)
      .slice(0, 16);
  } catch {
    return [];
  }
}

function writeInsecureTransportHosts(hosts: readonly string[]): void {
  const storage = readStorage();
  if (!storage) return;
  try {
    if (hosts.length === 0) storage.removeItem(INSECURE_TRANSPORT_HOSTS_KEY);
    else storage.setItem(INSECURE_TRANSPORT_HOSTS_KEY, JSON.stringify([...hosts]));
  } catch {
    /* 存不下就等于没勾选：下一次仍然按拒绝处理，方向是安全的 */
  }
}

/** 显式勾选：允许向该地址明文发送凭据（按 host:port 记录）。 */
export function grantInsecureTransportAllowance(raw: string | null | undefined): string {
  const target = parseServerTarget(raw);
  if (!target) return "";
  const hosts = readInsecureTransportHosts();
  if (!hosts.includes(target.host)) writeInsecureTransportHosts([...hosts, target.host].slice(-16));
  return target.host;
}

/** 撤销勾选。不传地址时清空全部——切换服务器时用它，避免旧同意被新目标继承。 */
export function revokeInsecureTransportAllowance(raw?: string | null): void {
  if (raw === undefined) {
    writeInsecureTransportHosts([]);
    return;
  }
  const target = parseServerTarget(raw);
  if (!target) return;
  writeInsecureTransportHosts(readInsecureTransportHosts().filter((host) => host !== target.host));
}

/**
 * 发送凭据前的闸门：不允许就抛错。
 * 带 `noRetry` 标记，上传管理器会当成配置错误立即失败并展示原因，
 * 而不是按网络抖动重试到天荒地老。
 */
export function assertCredentialTransportAllowed(raw: string | null | undefined): void {
  const decision = evaluateCredentialTransport(raw, readInsecureTransportHosts());
  if (decision.allowed) return;
  const error = new Error(decision.message) as Error & { noRetry?: boolean; code?: string };
  error.noRetry = true;
  error.code = decision.reason === "unparsable" ? "SERVER_URL_UNPARSABLE" : "INSECURE_REMOTE_TRANSPORT_BLOCKED";
  throw error;
}

/** 当前配置的地址能否发送凭据（界面提示用，不抛错）。 */
export function canSendCredentialsToConfiguredServer(raw: string | null | undefined): CredentialTransportDecision {
  return evaluateCredentialTransport(raw, readInsecureTransportHosts());
}
