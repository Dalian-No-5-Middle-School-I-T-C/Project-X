// v2.5.1: 远端服务器连接状态探活（周期轮询 /api/app/health）。
// 订阅即自动轮询：成功后 20s 慢节奏，失败后 5s 加速以快速发现恢复。
// 工厂依赖可注入（serverUrl/fetchHealth/schedule），Node 冒烟脚本用手动时钟驱动。
import { remoteScannerFetch } from "../auth/api";

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

function readServerUrl(): string {
  try {
    return (localStorage.getItem("projectx_server_url") ?? "").trim().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

async function defaultFetchHealth(): Promise<HealthProbeResult> {
  const res = await remoteScannerFetch("/api/app/health");
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
  fetchHealth?: () => Promise<HealthProbeResult>;
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

  function emit(): void {
    for (const l of listeners) l();
  }

  /** 探测一次，返回下一次轮询间隔 */
  async function probeOnce(): Promise<number> {
    const serverUrl = getServerUrl();
    if (!serverUrl) {
      // 未配置地址仍走一次探测通道以保持统一轮询节奏（默认实现在本地即拒绝，不产生网络流量），
      // 这样用户保存服务器地址后无需手动 refresh，下个周期即可自动恢复在线判定。
      try {
        await fetchHealth();
      } catch {
        /* 未配置地址时的通道拒绝按忽略处理 */
      }
      state = { kind: "unconfigured", serverUrl: "", lastCheckedAt: null, detail: "未配置服务器地址" };
      emit();
      return INTERVAL_OK_MS;
    }
    try {
      const res = await fetchHealth();
      if (res.ok && res.body?.capabilities?.scannerClientApi === true) {
        state = { kind: "online", serverUrl, lastCheckedAt: Date.now(), detail: "扫描客户端 API 已启用" };
        return INTERVAL_OK_MS;
      }
      if (res.ok) {
        state = {
          kind: "api_disabled",
          serverUrl,
          lastCheckedAt: Date.now(),
          detail: "服务器在线，但未启用远程扫描客户端 API（需设置 PROJECTX_ENABLE_SCANNER_CLIENT_API=1）",
        };
        return INTERVAL_FAIL_MS;
      }
      state = {
        kind: "offline",
        serverUrl,
        lastCheckedAt: Date.now(),
        detail: `服务器无响应（HTTP ${res.status ?? "?"}）`,
      };
      return INTERVAL_FAIL_MS;
    } catch (err) {
      state = {
        kind: "offline",
        serverUrl,
        lastCheckedAt: Date.now(),
        detail: err instanceof Error ? err.message : "网络异常",
      };
      return INTERVAL_FAIL_MS;
    } finally {
      emit();
    }
  }

  function loop(): void {
    if (stopped) return;
    void probeOnce().then((nextMs) => {
      if (stopped) return;
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
      cancelTimer?.();
      cancelTimer = null;
      if (!stopped) loop();
    },
    stop(): void {
      stopped = true;
      cancelTimer?.();
      cancelTimer = null;
    },
  };
}

/** 应用级单例：首次订阅自动开始轮询 */
export const serverStatus = createServerStatusMonitor();
