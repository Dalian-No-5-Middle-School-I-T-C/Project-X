// v2.5.1: 远端服务器连接状态探活（周期轮询 /api/app/health）。
// 订阅即自动轮询：成功后 20s 慢节奏，失败后 5s 加速以快速发现恢复。
// 工厂依赖可注入（serverUrl/fetchHealth/schedule），Node 冒烟脚本用手动时钟驱动。
import { remoteScannerFetch } from "../auth/api";
// v2.5.6：探活也走统一归一化——缺 scheme 的地址会让 fetch 直接抛错，
// 若不归一化，探活会一直停在 offline，掩盖「地址写错了」这一真实原因。
import { readServerUrl } from "./scannerMode";

export type ServerStatusKind =
  | "unconfigured" // 未配置服务器地址
  | "checking"     // 首次探测中
  | "online"       // 在线且扫描客户端 API 已启用
  | "api_disabled" // 在线但未启用 PROJECTX_ENABLE_SCANNER_CLIENT_API
  | "offline";     // 不可达

export interface ServerStatusSnapshot {
  kind: ServerStatusKind;
  serverUrl: string;
  lastCheckedAt: number | null;
  detail: string;
}

interface HealthBody {
  ok?: boolean;
  capabilities?: { scannerClientApi?: boolean };
}

export interface HealthProbeResult {
  ok: boolean;
  status?: number;
  body: HealthBody | null;
}

const INTERVAL_OK_MS = 20_000;
const INTERVAL_FAIL_MS = 5_000;

// v2.5.6：探活也走统一归一化——缺 scheme 的地址会让 fetch 直接抛错，
// 若不归一化，探活会一直停在 offline，掩盖「地址写错了」这一真实原因。
async function defaultFetchHealth(signal: AbortSignal): Promise<HealthProbeResult> {
  const res = await remoteScannerFetch("/api/app/health", { signal });
  let body: HealthBody | null = null;
  try {
    body = (await res.json()) as HealthBody;
  } catch {
    /* 非 JSON 响应按 null 处理 */
  }
  return { ok: res.ok, status: res.status, body };
}

export interface ServerStatusDeps {
  serverUrl?: () => string;
  fetchHealth?: (signal: AbortSignal) => Promise<HealthProbeResult>;
  timeoutMs?: number;
  /** 注入定时器以便测试手动驱动；返回取消函数 */
  schedule?: (fn: () => void, ms: number) => () => void;
}

export function createServerStatusMonitor(deps: ServerStatusDeps = {}) {
  const getServerUrl = deps.serverUrl ?? readServerUrl;
  const fetchHealth = deps.fetchHealth ?? defaultFetchHealth;
  const schedule =
    deps.schedule ??
    ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    });

  let state: ServerStatusSnapshot = { kind: "checking", serverUrl: "", lastCheckedAt: null, detail: "" };
  const listeners = new Set<() => void>();
  let stopped = true;
  let cancelTimer: (() => void) | null = null;
  // 代际计数：refresh()/stop() 时自增，使仍在飞行中的旧探测完成后不再续排定时器，
  // 避免 refresh 中途探测分叉出第二条永久轮询链。
  let epoch = 0;
  let activeProbe: AbortController | null = null;

  function emit(): void {
    for (const l of listeners) {
      try {
        l();
      } catch {
        /* 订阅方异常不阻断轮询 */
      }
    }
  }

  /** A stalled response must release the polling loop, including a stalled JSON body. */
  async function probeOnce(myEpoch: number): Promise<number> {
    const serverUrl = getServerUrl();
    const controller = new AbortController();
    activeProbe = controller;
    const cancelDeadline = schedule(() => controller.abort(new Error("服务器探测超时")), deps.timeoutMs ?? 10_000);
    let removeAbort = () => {};
    const aborted = new Promise<never>((_, reject) => {
      const onAbort = () => reject(controller.signal.reason ?? new Error("探测已取消"));
      controller.signal.addEventListener("abort", onAbort, { once: true });
      removeAbort = () => controller.signal.removeEventListener("abort", onAbort);
    });
    let next: ServerStatusSnapshot;
    try {
      const res = await Promise.race([fetchHealth(controller.signal), aborted]);
      next = res.ok && res.body?.capabilities?.scannerClientApi === true
        ? { kind: "online", serverUrl, lastCheckedAt: Date.now(), detail: "扫描客户端 API 已启用" }
        : res.ok && res.body !== null
          ? { kind: "api_disabled", serverUrl, lastCheckedAt: Date.now(), detail: "服务器在线，但未启用远程扫描客户端 API（需设置 PROJECTX_ENABLE_SCANNER_CLIENT_API=1）" }
          : { kind: "offline", serverUrl, lastCheckedAt: Date.now(), detail: res.ok
            ? `响应格式异常（HTTP ${res.status ?? "?"}）` : `服务器无响应（HTTP ${res.status ?? "?"}）` };
    } catch (err) {
      next = { kind: "offline", serverUrl, lastCheckedAt: Date.now(), detail: err instanceof Error ? err.message : "网络异常" };
    } finally {
      cancelDeadline();
      removeAbort();
      if (activeProbe === controller) activeProbe = null;
    }
    if (!serverUrl) next = { kind: "unconfigured", serverUrl: "", lastCheckedAt: null, detail: "未配置服务器地址" };
    if (!stopped && myEpoch === epoch && serverUrl === getServerUrl()) {
      state = next;
      emit();
    }
    return next.kind === "online" || next.kind === "unconfigured" ? INTERVAL_OK_MS : INTERVAL_FAIL_MS;
  }

  function loop(): void {
    if (stopped) return;
    const my = epoch;
    void probeOnce(my).then((nextMs) => {
      if (stopped || my !== epoch) return;
      cancelTimer = schedule(loop, nextMs);
    });
  }

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      if (stopped) {
        stopped = false;
        loop();
      }
      return () => {
        listeners.delete(listener);
      };
    },
    getState: (): ServerStatusSnapshot => state,
    /** 立即重新探测（如登录页保存了新地址后调用） */
    refresh(): void {
      epoch += 1;
      activeProbe?.abort();
      cancelTimer?.();
      cancelTimer = null;
      if (!stopped) loop();
    },
    stop(): void {
      epoch += 1;
      activeProbe?.abort();
      stopped = true;
      cancelTimer?.();
      cancelTimer = null;
    },
  };
}

/** 应用级单例：首次订阅自动开始轮询 */
export const serverStatus = createServerStatusMonitor();
