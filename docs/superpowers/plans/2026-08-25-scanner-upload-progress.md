# 扫描端图片上传与进度可视化（v2.5.1）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 根治直扫自动上传的卸载竞态，为导入阅卷增加"判分照旧+后台上传"，并提供右上角下弹进度卡与实时服务器状态指示。

**Architecture:** 新建两个脱离 React 树的 TS 单例（`scannerUploadManager` 上传队列 + `remoteServerStatus` 健康探活），直扫/导入两条路径都把上传任务交给管理器；UI 层只做订阅渲染（`UploadProgressCard` + `ServerStatusIndicator`）。服务端零改动。

**Tech Stack:** React 19 + TypeScript + Tailwind v4 工具类 + ui/v2 组件库（`StatusItem`/`Progress`/`SegmentedControl`/`Button`）；验证用 `npm run typecheck` + `npx tsx` 冒烟脚本（仓库无单测框架，遵循 `scripts/*-smoke.ts` 房风）。

**Spec:** `docs/superpowers/specs/2026-08-25-scanner-upload-manager-design.md`

**分支:** `feat/scanner-upload-progress`（已建，含版本 2.5.1 bump）

---

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/apps/answer-card/client/lib/scannerMode.ts` | 新建 | 扫描存储模式读写 + `isRemoteServerConfigured()` |
| `src/apps/answer-card/client/lib/remoteServerStatus.ts` | 新建 | health 探活单例（工厂可注入依赖供冒烟测试） |
| `src/apps/answer-card/client/lib/scannerUploadManager.ts` | 新建 | 上传队列单例（三步协议/退避重试/断线暂停恢复） |
| `src/apps/answer-card/client/components/ServerStatusIndicator.tsx` | 新建 | 服务器状态点指示器 |
| `src/apps/answer-card/client/components/UploadProgressCard.tsx` | 新建 | 右上下弹进度卡 |
| `src/apps/answer-card/client/components/ScannerPanel.tsx` | 修改 | 删内联上传逻辑，done 分支改调管理器 |
| `src/apps/answer-card/client/components/ScannerWorkspace.tsx` | 修改 | 扫完不再卸载面板；导入卡加模式切换并派发上传；顶栏挂指示器 |
| `src/apps/answer-card/client/ScannerApp.tsx` | 修改 | 根部挂 `UploadProgressCard` |
| `scripts/remote-server-status-smoke.ts` | 新建 | 探活状态机冒烟 |
| `scripts/scanner-upload-manager-smoke.ts` | 新建 | 上传管理器三场景冒烟 |

---

### Task 1: `scannerMode.ts` 共享模式工具

**Files:**
- Create: `src/apps/answer-card/client/lib/scannerMode.ts`
- Modify: `src/apps/answer-card/client/components/ScannerPanel.tsx:124-142`

- [ ] **Step 1: 创建 `scannerMode.ts`**

```ts
// v2.5.1: 扫描存储模式（local=本地存储 / remote=上传服务器）共享读写。
// 直扫面板与导入阅卷卡片共用同一 localStorage key，语义一致、记忆互通。
import { useState } from "react";

export type ScannerMode = "local" | "remote";

const MODE_KEY = "projectx_scanner_mode";

export function getScannerMode(): ScannerMode {
  try {
    return (localStorage.getItem(MODE_KEY) as ScannerMode) || "local";
  } catch {
    return "local";
  }
}

export function setScannerMode(m: ScannerMode): void {
  try {
    localStorage.setItem(MODE_KEY, m);
  } catch {
    /* ignore storage failures */
  }
}

/** 是否已配置远端服务器地址（remote 模式上传的前置条件） */
export function isRemoteServerConfigured(): boolean {
  try {
    return (localStorage.getItem("projectx_server_url") ?? "").trim().length > 0;
  } catch {
    return false;
  }
}

/** React 绑定：本地 state + localStorage 双写 */
export function useScannerMode(): [ScannerMode, (m: ScannerMode) => void] {
  const [mode, setModeState] = useState<ScannerMode>(getScannerMode);
  const update = (m: ScannerMode) => {
    setScannerMode(m);
    setModeState(m);
  };
  return [mode, update];
}
```

- [ ] **Step 2: ScannerPanel 改用共享 hook**

替换 `ScannerPanel.tsx` 中以下两段（原 123-142 行）：

删除：

```tsx
  // v1.6.0: 扫描模式 — 本地存储 或 上传服务器
  const [scannerMode, setScannerMode] = useState<"local" | "remote">(() => {
    try {
      return (localStorage.getItem("projectx_scanner_mode") as "local" | "remote") || "local";
    } catch {
      return "local";
    }
  });
  const scannerModeRef = useRef(scannerMode);
  const [uploadState, setUploadState] = useState<"" | "uploading" | "done" | "error">("");
  const [uploadMsg, setUploadMsg] = useState("");

  function setMode(m: "local" | "remote") {
    setScannerMode(m);
    try {
      localStorage.setItem("projectx_scanner_mode", m);
    } catch {
      /* ignore */
    }
  }
```

替换为：

```tsx
  // v2.5.1: 扫描存储模式共享 hook（与导入阅卷卡片共用同一记忆）
  const [scannerMode, setScannerMode] = useScannerMode();
```

同文件顶部 import 区加：

```tsx
import { useScannerMode } from "../lib/scannerMode";
```

同步删除对 `scannerModeRef` 的引用（原 151-153 行的同步 effect 整段删除）：

```tsx
  useEffect(() => {
    scannerModeRef.current = scannerMode;
  }, [scannerMode]);
```

JSX 中 SegmentedControl 的回调 `onValueChange={(m) => setMode(m)}` 改为 `onValueChange={setScannerMode}`（值类型 `"local"|"remote"` 兼容）。

- [ ] **Step 3: 运行 typecheck**

Run: `npm run typecheck`
Expected: 无错误（此时 scannerModeRef 尚有 done 分支引用？——若有，本步临时把该处改为 `getScannerMode() === "remote"`：`if (getScannerMode() === "remote") {`，并在顶部补 `import { getScannerMode, useScannerMode } from "../lib/scannerMode";`）

- [ ] **Step 4: Commit**

```bash
git add src/apps/answer-card/client/lib/scannerMode.ts src/apps/answer-card/client/components/ScannerPanel.tsx
git commit -m "refactor(scanner): 扫描存储模式收敛为共享 scannerMode 工具"
```

---

### Task 2: `remoteServerStatus.ts` 探活模块（TDD）

**Files:**
- Create: `scripts/remote-server-status-smoke.ts`
- Create: `src/apps/answer-card/client/lib/remoteServerStatus.ts`

- [ ] **Step 1: 先写失败的冒烟脚本**

```ts
// v2.5.1 探活状态机冒烟：注入 fetchHealth + 手动时钟，验证四态翻转与快慢轮询节奏。
import { createServerStatusMonitor } from "../src/apps/answer-card/client/lib/remoteServerStatus";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`断言失败: ${msg}`);
}

const tick = () => new Promise<void>((r) => setImmediate(r));

interface PendingTimer {
  fn: () => void;
  at: number;
  cancelled: boolean;
}

function makeClock() {
  let now = 0;
  let pending: PendingTimer[] = [];
  const schedule = (fn: () => void, ms: number) => {
    const item: PendingTimer = { fn, at: now + ms, cancelled: false };
    pending.push(item);
    return () => {
      item.cancelled = true;
    };
  };
  const flush = async (advanceMs: number) => {
    now += advanceMs;
    const due = pending.filter((p) => !p.cancelled && p.at <= now);
    pending = pending.filter((p) => p.cancelled || p.at > now);
    for (const p of due) p.fn();
    await tick();
    await tick();
  };
  const nextDelay = () => {
    const live = pending.filter((p) => !p.cancelled);
    if (live.length === 0) return null;
    return Math.min(...live.map((p) => p.at)) - now;
  };
  return { schedule, flush, nextDelay, get now() { return now; } };
}

async function main() {
  // ── 场景 A：未配置地址 → unconfigured，不再加速 ──
  {
    const clock = makeClock();
    let probes = 0;
    const mon = createServerStatusMonitor({
      serverUrl: () => "",
      fetchHealth: async () => { probes += 1; return { ok: true, body: { ok: true } }; },
      schedule: clock.schedule,
    });
    mon.subscribe(() => undefined);
    await clock.flush(0);
    assert(mon.getState().kind === "unconfigured", "A: 未配置时应为 unconfigured");
    await clock.flush(20_000);
    await clock.flush(20_000);
    assert(probes === 3, `A: 20s 慢轮询应探活 3 次，实际 ${probes}`);
    mon.stop();
  }

  // ── 场景 B：online → offline → online，节奏 20s/5s 切换 ──
  {
    const clock = makeClock();
    let healthy = true;
    const mon = createServerStatusMonitor({
      serverUrl: () => "http://192.168.1.10:5174",
      fetchHealth: async () =>
        healthy
          ? { ok: true, body: { ok: true, capabilities: { scannerClientApi: true } } }
          : { ok: false, status: 503, body: null },
      schedule: clock.schedule,
    });
    mon.subscribe(() => undefined);
    await clock.flush(0);
    assert(mon.getState().kind === "online", "B: 初始应为 online");
    assert(clock.nextDelay() === 20_000, "B: 成功后应 20s 再探");

    healthy = false;
    await clock.flush(20_000);
    assert(mon.getState().kind === "offline", "B: 探活失败应转 offline");
    assert(clock.nextDelay() === 5_000, "B: 失败后应加速为 5s");

    healthy = true;
    await clock.flush(5_000);
    assert(mon.getState().kind === "online", "B: 恢复后应回 online");
    assert(mon.getState().serverUrl === "http://192.168.1.10:5174", "B: 快照应带服务器地址");
    mon.stop();
  }

  // ── 场景 C：在线但 capability 缺失 → api_disabled ──
  {
    const clock = makeClock();
    const mon = createServerStatusMonitor({
      serverUrl: () => "http://192.168.1.10:5174",
      fetchHealth: async () => ({ ok: true, body: { ok: true, capabilities: {} } }),
      schedule: clock.schedule,
    });
    mon.subscribe(() => undefined);
    await clock.flush(0);
    assert(mon.getState().kind === "api_disabled", "C: capability 缺失应为 api_disabled");
    mon.stop();
  }

  console.log("remote-server-status-smoke: 全部通过");
}

void main();
```

- [ ] **Step 2: 运行确认失败**

Run: `npx tsx scripts/remote-server-status-smoke.ts`
Expected: FAIL —— `Cannot find module .../remoteServerStatus`（模块尚不存在）

- [ ] **Step 3: 实现 `remoteServerStatus.ts`**

```ts
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
```

注意：冒烟脚本的 deps 里用了 `serverUrl` 字段名，工厂接口必须与之同名（上方代码已是 `serverUrl?: () => string`）。

- [ ] **Step 4: 运行确认通过**

Run: `npx tsx scripts/remote-server-status-smoke.ts`
Expected: `remote-server-status-smoke: 全部通过`

- [ ] **Step 5: Commit**

```bash
git add src/apps/answer-card/client/lib/remoteServerStatus.ts scripts/remote-server-status-smoke.ts
git commit -m "feat(scanner): 服务器健康探活模块 remoteServerStatus（20s/5s 自适应轮询）"
```

---

### Task 3: `scannerUploadManager.ts` 上传队列（TDD）

**Files:**
- Create: `scripts/scanner-upload-manager-smoke.ts`
- Create: `src/apps/answer-card/client/lib/scannerUploadManager.ts`

- [ ] **Step 1: 先写失败的冒烟脚本**

```ts
// v2.5.1 上传管理器冒烟：mock remoteFetch 驱动三条核心路径
// ①全成功 ②断线暂停→恢复续传 ③重试耗尽→error→手动 retryFailed 补发 complete
import { createScannerUploadManager } from "../src/apps/answer-card/client/lib/scannerUploadManager";
import type { StartUploadInput } from "../src/apps/answer-card/client/lib/scannerUploadManager";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`断言失败: ${msg}`);
}

const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const blob = () => new Blob(["fake-image-bytes"], { type: "image/jpeg" });

type Step = (url: string) => Response;
const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** 按 URL 前缀路由 + 按调用次序出栈的脚本化 mock */
function makeRemoteMock(routes: Record<string, Step[]>) {
  const calls: string[] = [];
  const counters: Record<string, number> = {};
  const fn = async (url: string): Promise<Response> => {
    calls.push(url);
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) throw new Error("mock 未覆盖的 URL: " + url);
    const steps = routes[key];
    const i = counters[key] ?? 0;
    counters[key] = i + 1;
    const step = steps[Math.min(i, steps.length - 1)];
    return step(url);
  };
  return { fn: fn as unknown as (url: string, init?: RequestInit) => Promise<Response>, calls, counters };
}

function baseInput(pages: number): StartUploadInput {
  return {
    kind: "import",
    cardId: "card_1",
    name: "冒烟",
    pages: Array.from({ length: pages }, (_, i) => ({
      pageNum: i + 1,
      side: "front" as const,
      getBlob: async () => blob(),
    })),
  };
}

function deps(overrides: Partial<Parameters<typeof createScannerUploadManager>[0]> = {}) {
  return {
    isOnline: () => true,
    getServerKind: () => "online" as const,
    sleep: () => Promise.resolve(),
    timeoutSignal: () => new AbortController().signal,
    genId: (() => { let n = 0; return () => `job_${++n}`; })(),
    ...overrides,
  };
}

async function waitTerminal(
  mgr: ReturnType<typeof createScannerUploadManager>,
  id: string,
): Promise<{ status: string; uploaded: number; failedPages: number[]; message: string }> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const j = mgr.getState().jobs.find((x) => x.id === id);
    if (j && (j.status === "done" || j.status === "error")) {
      return { status: j.status, uploaded: j.uploaded, failedPages: j.failedPages, message: j.message };
    }
    if (Date.now() > deadline) throw new Error("等待任务终态超时");
    await sleepReal(5);
  }
}

async function main() {
  const SESSIONS = "/api/scanner/upload/sessions";
  const PAGES = "/pages";
  const COMPLETE = "/complete";

  // ── 场景 1：全成功（2 页）──
  {
    const mock = makeRemoteMock({
      [SESSIONS]: [() => jsonRes({ sessionId: "scan_a", uploadTokens: ["t1", "t2"] }, 201)],
      [PAGES]: [() => jsonRes({ ok: true }), () => jsonRes({ ok: true })],
      [COMPLETE]: [() => jsonRes({ ok: true })],
    });
    const mgr = createScannerUploadManager(deps({ remoteFetch: mock.fn }));
    const id = mgr.startUpload(baseInput(2));
    const r = await waitTerminal(mgr, id);
    assert(r.status === "done", `场景1: 应 done，实际 ${r.status} ${r.message}`);
    assert(r.uploaded === 2, "场景1: uploaded 应为 2");
    assert(mock.calls.some((u) => u.endsWith(COMPLETE)), "场景1: 应调 complete");
  }

  // ── 场景 2：断线暂停 → 恢复自动续传 ──
  {
    let online = true;
    let netFailNext = true; // 第 1 次页上传抛网络错误
    const mock = makeRemoteMock({
      [SESSIONS]: [() => jsonRes({ sessionId: "scan_b", uploadTokens: ["t1"] }, 201)],
      [PAGES]: [
        (url) => {
          if (netFailNext) {
            netFailNext = false;
            online = false; // 失败瞬间"断网"，下次循环检查进入 paused
            throw new TypeError("fetch failed");
          }
          return jsonRes({ ok: true });
        },
      ],
      [COMPLETE]: [() => jsonRes({ ok: true })],
    });
    const mgr = createScannerUploadManager(deps({
      remoteFetch: mock.fn,
      isOnline: () => online,
    }));
    const id = mgr.startUpload(baseInput(1));
    // 等待进入 paused（重试 1 次后循环顶部发现离线）
    const deadline = Date.now() + 3_000;
    for (;;) {
      const j = mgr.getState().jobs.find((x) => x.id === id);
      if (j?.status === "paused") break;
      if (Date.now() > deadline) throw new Error("场景2: 未进入 paused，当前=" + JSON.stringify(mgr.getState()));
      await sleepReal(5);
    }
    // 恢复网络 → 放行
    online = true;
    mgr.notifyNetworkChanged();
    const r = await waitTerminal(mgr, id);
    assert(r.status === "done", `场景2: 恢复后应 done，实际 ${r.status} ${r.message}`);
    assert(r.uploaded === 1, "场景2: uploaded 应为 1");
  }

  // ── 场景 3：配置类错误重试耗尽 → error（不发 complete）→ retryFailed 补发 ──
  {
    let pageOk = false;
    const mock = makeRemoteMock({
      [SESSIONS]: [() => jsonRes({ sessionId: "scan_c", uploadTokens: ["t1", "t2"] }, 201)],
      [PAGES]: [
        () => jsonRes({ ok: true }),                                    // 第 1 页成功
        () => jsonRes({ message: "无效的 upload token" }, 400),          // 第 2 页持续 400
      ],
      [COMPLETE]: [() => jsonRes({ ok: true })],
    });
    // 第 2 页三次尝试都读同一个 step（index 用 min 封顶）→ 需要 pageOk 开关区分两页行为
    const mgr = createScannerUploadManager(deps({ remoteFetch: mock.fn }));
    const id = mgr.startUpload(baseInput(2));
    const r = await waitTerminal(mgr, id);
    assert(r.status === "error", `场景3: 应 error，实际 ${r.status}`);
    assert(r.failedPages.includes(2), "场景3: 失败页应含第 2 页");
    assert(!mock.calls.some((u) => u.endsWith(COMPLETE)), "场景3: 有失败页时不得调 complete");

    // 手动重试：仅失败页重传（done 页跳过），随后补发 complete
    const callsBefore = mock.calls.length;
    mock.routes[PAGES].push(() => jsonRes({ ok: true }));
    mgr.retryFailed(id);
    const r2 = await waitTerminal(mgr, id);
    assert(r2.status === "done", `场景3: 重试后应 done，实际 ${r2.status} ${r2.message}`);
    const pageCalls = mock.calls.slice(callsBefore).filter((u) => u.includes(PAGES)).length;
    assert(pageCalls === 1, `场景3: 重试应只传失败 1 页，实际 ${pageCalls} 次`);
    assert(mock.calls.some((u) => u.endsWith(COMPLETE)), "场景3: 重试成功后应补发 complete");
  }

  console.log("scanner-upload-manager-smoke: 全部通过");
}

void main();
```

注意：makeRemoteMock 的 `routes` 需要暴露出来供场景 3 追加 step（上面 `mgr.retryFailed` 前有 `mock.routes[PAGES].push(...)`），实现里返回对象须包含 `routes`。

- [ ] **Step 2: 运行确认失败**

Run: `npx tsx scripts/scanner-upload-manager-smoke.ts`
Expected: FAIL —— `Cannot find module .../scannerUploadManager`

- [ ] **Step 3: 实现 `scannerUploadManager.ts`**

```ts
// v2.5.1: 扫描端上传管理器 —— 直扫/导入共用的后台上传队列。
// 生命周期完全脱离 React 组件树：面板卸载/切页不影响进行中的上传（根治 v1.6.0 卸载竞态）。
// 协议沿用服务端既有三步接口：POST sessions → POST pages(逐页 multipart) → POST complete。
// 韧性：单页自动重试 2 次（退避 1s/3s，同 token 服务端幂等覆盖）；断线/api_disabled 转 paused，
// 网络恢复自动续传；存在彻底失败页时不发 complete（服务端会话保持可续传态）。
import { remoteScannerFetch } from "../auth/api";
import { serverStatus, type ServerStatusKind } from "./remoteServerStatus";

export type UploadJobKind = "scan" | "import";
export type UploadJobStatus =
  | "queued"       // 排队等待
  | "creating"     // 创建远端会话中
  | "uploading"    // 逐页上传中
  | "completing"   // 提交 complete 中
  | "paused"       // 断线暂停（自动恢复）
  | "done"         // 全部完成
  | "error";       // 会话创建失败 / 存在彻底失败页

export interface UploadPageInput {
  pageNum: number;
  side: "front" | "back";
  getBlob: () => Promise<Blob>;
}

export interface StartUploadInput {
  kind: UploadJobKind;
  cardId: string;
  name: string;
  dpi?: number;
  paperSize?: string;
  pages: UploadPageInput[];
}

export interface UploadJobSnapshot {
  id: string;
  kind: UploadJobKind;
  name: string;
  cardId: string;
  status: UploadJobStatus;
  uploaded: number;
  total: number;
  currentPageNum: number | null;
  failedPages: number[];
  message: string;
  createdAt: number;
}

export interface UploadManagerSnapshot {
  jobs: UploadJobSnapshot[];
  activeJobId: string | null;
  queuedCount: number;
}

const AUTO_RETRY_EXTRA = 2; // 首次失败后的额外尝试次数（总共最多 3 次）
const RETRY_BACKOFF_MS = [1_000, 3_000] as const;

interface PageRecord {
  input: UploadPageInput;
  token: string;
  done: boolean;
  failed: boolean;
}

interface JobRecord {
  id: string;
  kind: UploadJobKind;
  name: string;
  cardId: string;
  dpi: number;
  paperSize: string;
  pages: PageRecord[];
  status: UploadJobStatus;
  /** paused 恢复后回到的阶段 */
  resumePhase: "creating" | "uploading" | "completing";
  remoteSessionId: string | null;
  message: string;
  createdAt: number;
  pauseWaiter: (() => void) | null;
}

export interface UploadManagerDeps {
  remoteFetch?: (url: string, init?: RequestInit) => Promise<Response>;
  isOnline?: () => boolean;
  getServerKind?: () => ServerStatusKind;
  sleep?: (ms: number) => Promise<void>;
  /** 默认 AbortSignal 超时会挂真实定时器，Node 冒烟注入空信号避免悬挂进程 */
  timeoutSignal?: (ms: number) => AbortSignal;
  pageTimeoutMs?: number;
  genId?: () => string;
}

function defaultIsOnline(): boolean {
  try {
    return navigator.onLine !== false;
  } catch {
    return true;
  }
}

function defaultTimeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => void controller.abort(), ms);
  return controller.signal;
}

let seq = 0;
function defaultGenId(): string {
  seq += 1;
  return `up_${Date.now().toString(36)}_${seq}`;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function isConfigError(err: unknown): boolean {
  const status = (err as { status?: number }).status;
  return typeof status === "number" && status >= 400 && status < 500;
}

async function httpError(res: Response): Promise<Error & { status?: number }> {
  let message = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { message?: string };
    if (typeof body.message === "string" && body.message) message = body.message;
  } catch {
    /* ignore */
  }
  const err = new Error(message) as Error & { status?: number };
  err.status = res.status;
  return err;
}

export function createScannerUploadManager(deps: UploadManagerDeps = {}) {
  const remoteFetch = deps.remoteFetch ?? remoteScannerFetch;
  const isOnline = deps.isOnline ?? defaultIsOnline;
  const getServerKind = deps.getServerKind ?? (() => serverStatus.getState().kind);
  const timeoutSignal = deps.timeoutSignal ?? defaultTimeoutSignal;
  const sleep = deps.sleep ?? defaultSleep;
  const pageTimeoutMs = deps.pageTimeoutMs ?? 120_000;
  const genId = deps.genId ?? defaultGenId;

  const jobs: JobRecord[] = [];
  const listeners = new Set<() => void>();
  let snapshot: UploadManagerSnapshot = { jobs: [], activeJobId: null, queuedCount: 0 };
  let running = false;

  function notify(): void {
    snapshot = {
      jobs: jobs.map((j) => ({
        id: j.id,
        kind: j.kind,
        name: j.name,
        cardId: j.cardId,
        status: j.status,
        uploaded: j.pages.filter((p) => p.done).length,
        total: j.pages.length,
        currentPageNum:
          j.status === "uploading" ? (j.pages.find((p) => !p.done)?.input.pageNum ?? null) : null,
        failedPages: j.pages.filter((p) => p.failed).map((p) => p.input.pageNum),
        message: j.message,
        createdAt: j.createdAt,
      })),
      activeJobId:
        jobs.find((j) => !["queued", "done", "error"].includes(j.status))?.id ?? null,
      queuedCount: jobs.filter((j) => j.status === "queued").length,
    };
    for (const l of listeners) l();
  }

  function setStatus(j: JobRecord, status: UploadJobStatus, message?: string): void {
    j.status = status;
    if (message !== undefined) j.message = message;
    notify();
  }

  function shouldPauseNow(): boolean {
    const kind = getServerKind();
    return !isOnline() || kind === "offline" || kind === "api_disabled";
  }

  function waitForResume(j: JobRecord): Promise<void> {
    return new Promise<void>((resolve) => {
      j.pauseWaiter = resolve;
    });
  }

  /** 网络/探活变化时由接线层调用：放行满足恢复条件的暂停任务 */
  function notifyNetworkChanged(): void {
    for (const j of jobs) {
      if (j.status === "paused" && !shouldPauseNow()) {
        const w = j.pauseWaiter;
        j.pauseWaiter = null;
        w?.();
      }
    }
  }

  async function createSession(j: JobRecord): Promise<{ sessionId: string; tokens: string[] }> {
    const res = await remoteFetch("/api/scanner/upload/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cardId: j.cardId,
        name: j.name,
        dpi: j.dpi,
        paperSize: j.paperSize,
        pageCount: j.pages.length,
      }),
      signal: timeoutSignal(pageTimeoutMs),
    });
    if (!res.ok) throw await httpError(res);
    const data = (await res.json()) as { sessionId: string; uploadTokens: string[] };
    if (!data.sessionId || !Array.isArray(data.uploadTokens) || data.uploadTokens.length < j.pages.length) {
      throw new Error("服务端返回的会话或上传令牌异常");
    }
    return { sessionId: data.sessionId, tokens: data.uploadTokens };
  }

  async function uploadPageOnce(j: JobRecord, page: PageRecord): Promise<void> {
    const blobData = await page.input.getBlob();
    const form = new FormData();
    form.append("image", blobData, `page_${page.input.pageNum}.jpg`);
    form.append("token", page.token);
    form.append("pageNum", String(page.input.pageNum));
    form.append("side", page.input.side);
    const res = await remoteFetch(`/api/scanner/upload/sessions/${j.remoteSessionId}/pages`, {
      method: "POST",
      body: form,
      signal: timeoutSignal(pageTimeoutMs),
    });
    if (!res.ok) throw await httpError(res);
  }

  async function completeSession(j: JobRecord): Promise<void> {
    const res = await remoteFetch(`/api/scanner/upload/sessions/${j.remoteSessionId}/complete`, {
      method: "POST",
      signal: timeoutSignal(pageTimeoutMs),
    });
    if (!res.ok) throw await httpError(res);
  }

  /**
   * 单阶段重试执行器：
   * - 每轮循环开头检查断线（离线/api_disabled）→ 转 paused 并挂起等待恢复；
   * - 失败按退避自动重试至多 AUTO_RETRY_EXTRA 次；
   * - 重试耗尽：api_disabled 或网络仍不通 → 转入暂停（保留重试机会）；配置类 4xx → 上抛；
   * - 恢复后从当前操作原地继续（resumePhase 由调用方维护）。
   */
  async function runWithRetry(j: JobRecord, phaseLabel: string, fn: () => Promise<void>): Promise<void> {
    let tries = 0;
    for (;;) {
      if (shouldPauseNow()) {
        setStatus(j, "paused", `${phaseLabel}中断：已断线，网络恢复后将自动续传`);
        await waitForResume(j);
        setStatus(j, j.resumePhase, `网络已恢复，继续${phaseLabel}`);
        continue;
      }
      try {
        await fn();
        return;
      } catch (err) {
        tries += 1;
        if (tries > AUTO_RETRY_EXTRA) {
          const kind = getServerKind();
          if (kind === "api_disabled" || !isOnline() || kind === "offline") {
            tries = 0; // 暂停后恢复重新给满重试预算
            setStatus(j, "paused", `${phaseLabel}失败：${errMsg(err)}，已断线等待恢复…`);
            await waitForResume(j);
            setStatus(j, j.resumePhase, `网络已恢复，继续${phaseLabel}`);
            continue;
          }
          if (isConfigError(err)) throw err;
          throw err;
        }
        await sleep(RETRY_BACKOFF_MS[Math.min(tries - 1, RETRY_BACKOFF_MS.length - 1)]);
      }
    }
  }

  async function runJob(j: JobRecord): Promise<void> {
    // Phase 1: 创建会话（retryFailed 复用既有会话时跳过）
    if (!j.remoteSessionId) {
      j.resumePhase = "creating";
      setStatus(j, "creating", "正在创建上传会话…");
      try {
        const { sessionId, tokens } = await runWithRetry(j, "创建会话", () => createSession(j));
        j.remoteSessionId = sessionId;
        j.pages.forEach((p, i) => {
          p.token = tokens[i];
        });
      } catch (err) {
        setStatus(j, "error", `创建会话失败：${errMsg(err)}`);
        return;
      }
    }

    // Phase 2: 逐页串行上传（失败页记录后继续，不打断批次）
    j.resumePhase = "uploading";
    let lastErrMsg = "";
    for (const page of j.pages) {
      if (page.done || page.failed) continue;
      setStatus(j, "uploading", `正在上传第 ${page.input.pageNum}/${j.pages.length} 页`);
      try {
        await runWithRetry(j, "上传", () => uploadPageOnce(j, page));
        page.done = true;
        notify();
      } catch (err) {
        page.failed = true;
        lastErrMsg = errMsg(err);
        notify();
      }
    }

    const failedPages = j.pages.filter((p) => p.failed);
    if (failedPages.length > 0) {
      const nums = failedPages.map((p) => p.input.pageNum).join("、");
      setStatus(
        j,
        "error",
        `${failedPages.length} 页上传失败（第 ${nums} 页）：${lastErrMsg}。可点「重试失败页」续传`,
      );
      return; // 有失败页不发 complete：服务端会话保持 uploading 可续传
    }

    // Phase 3: 提交完成
    j.resumePhase = "completing";
    setStatus(j, "completing", "正在提交上传会话…");
    try {
      await runWithRetry(j, "提交会话", () => completeSession(j));
      setStatus(j, "done", `上传完成，${j.pages.length} 页已提交到服务器`);
    } catch (err) {
      setStatus(j, "error", `提交会话失败：${errMsg(err)}`);
    }
  }

  /** 全局串行泵：同一时刻只跑一个任务，避免带宽争抢 */
  async function pump(): Promise<void> {
    if (running) return;
    running = true;
    try {
      for (;;) {
        const next = jobs.find((x) => x.status === "queued");
        if (!next) break;
        await runJob(next);
      }
    } finally {
      running = false;
    }
  }

  function startUpload(input: StartUploadInput): string {
    if (input.pages.length === 0) throw new Error("没有可上传的页面");
    const job: JobRecord = {
      id: genId(),
      kind: input.kind,
      name: input.name,
      cardId: input.cardId,
      dpi: input.dpi ?? 300,
      paperSize: input.paperSize ?? "A4",
      pages: input.pages.map((p) => ({ input: p, token: "", done: false, failed: false })),
      status: "queued",
      resumePhase: "creating",
      remoteSessionId: null,
      message: "",
      createdAt: Date.now(),
      pauseWaiter: null,
    };
    jobs.push(job);
    notify();
    void pump();
    return job.id;
  }

  /** 手动兜底：把彻底失败页重新入队（复用既有会话与 token，已成功页不重传） */
  function retryFailed(jobId: string): void {
    const j = jobs.find((x) => x.id === jobId);
    if (!j || j.status !== "error") return;
    for (const p of j.pages) p.failed = false;
    j.message = "";
    j.status = "queued";
    notify();
    void pump();
  }

  /** 手动触发暂停任务的立即重试（若仍断线会再次进入暂停，作为反馈） */
  function retryPaused(jobId: string): void {
    const j = jobs.find((x) => x.id === jobId);
    if (!j || j.status !== "paused") return;
    const w = j.pauseWaiter;
    j.pauseWaiter = null;
    w?.();
  }

  /** 仅允许取消还在排队的任务 */
  function cancelQueued(jobId: string): void {
    const idx = jobs.findIndex((x) => x.id === jobId);
    if (idx >= 0 && jobs[idx].status === "queued") {
      jobs.splice(idx, 1);
      notify();
    }
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function getState(): UploadManagerSnapshot {
    return snapshot;
  }

  return {
    startUpload,
    retryFailed,
    retryPaused,
    cancelQueued,
    notifyNetworkChanged,
    subscribe,
    getState,
  };
}

export type ScannerUploadManager = ReturnType<typeof createScannerUploadManager>;

/** 应用级单例。浏览器环境接线网络事件与探活信号；Node 冒烟脚本不受影响（无 window）。 */
export const scannerUploadManager = createScannerUploadManager();

if (typeof window !== "undefined") {
  window.addEventListener("online", () => scannerUploadManager.notifyNetworkChanged());
  window.addEventListener("offline", () => scannerUploadManager.notifyNetworkChanged());
  void serverStatus.subscribe(() => scannerUploadManager.notifyNetworkChanged());
}
```

注意：冒烟脚本的 `deps()` 里用了字段名 `timeoutSignal`，工厂接口与之对应。

- [ ] **Step 4: 运行确认通过**

Run: `npx tsx scripts/scanner-upload-manager-smoke.ts`
Expected: `scanner-upload-manager-smoke: 全部通过`

若场景 2 卡在「未进入 paused」：核对 runWithRetry 里 catch 后先退避再回到循环顶部检查 `shouldPauseNow()` 的顺序（mock 在第一次页请求时把 `online` 置 false，第二次循环顶部必须命中）。

若场景 3 的 `mock.routes[PAGES].push` 报类型错：确认 makeRemoteMock 返回了原始 `routes` 对象（非拷贝）。

- [ ] **Step 5: Commit**

```bash
git add src/apps/answer-card/client/lib/scannerUploadManager.ts scripts/scanner-upload-manager-smoke.ts
git commit -m "feat(scanner): 后台上传队列 scannerUploadManager（重试/断线暂停/手动兜底）"
```

---

### Task 4: `ServerStatusIndicator.tsx`

**Files:**
- Create: `src/apps/answer-card/client/components/ServerStatusIndicator.tsx`

- [ ] **Step 1: 创建组件（复用 ui/v2 的 `StatusItem` 状态点）**

```tsx
// v2.5.1: 远端服务器连接状态指示器（工作台顶栏常驻 / 上传进度卡头部复用）。
// 数据源 remoteServerStatus 单例；hover 显示服务器地址、探活详情与最后探测时间。
import { useSyncExternalStore } from "react";
import { StatusItem } from "./ui/v2";
import { serverStatus } from "../lib/remoteServerStatus";
import type { ServerStatusKind } from "../lib/remoteServerStatus";

const TONE: Record<ServerStatusKind, "ok" | "warn" | "error" | "idle"> = {
  online: "ok",
  checking: "idle",
  unconfigured: "idle",
  api_disabled: "warn",
  offline: "error",
};

const LABEL: Record<ServerStatusKind, string> = {
  online: "服务器在线",
  checking: "检测服务器…",
  unconfigured: "未配置服务器",
  api_disabled: "扫描 API 未启用",
  offline: "服务器离线",
};

export function ServerStatusIndicator() {
  const snap = useSyncExternalStore(serverStatus.subscribe, serverStatus.getState);
  const checkedAt = snap.lastCheckedAt
    ? new Date(snap.lastCheckedAt).toLocaleTimeString("zh-CN")
    : "";
  const title = snap.serverUrl
    ? `${snap.serverUrl} · ${snap.detail}${checkedAt ? ` · 探测于 ${checkedAt}` : ""}`
    : snap.detail;
  return (
    <StatusItem tone={TONE[snap.kind]} title={title} className="shrink-0 text-xs">
      {LABEL[snap.kind]}
    </StatusItem>
  );
}
```

- [ ] **Step 2: typecheck**

Run: `npm run typecheck`
Expected: 通过（组件暂无人引用，属预期）

- [ ] **Step 3: Commit**

```bash
git add src/apps/answer-card/client/components/ServerStatusIndicator.tsx
git commit -m "feat(scanner): 服务器连接状态指示器组件"
```

---

### Task 5: `UploadProgressCard.tsx` + ScannerApp 挂载

**Files:**
- Create: `src/apps/answer-card/client/components/UploadProgressCard.tsx`
- Modify: `src/apps/answer-card/client/ScannerApp.tsx`

- [ ] **Step 1: 创建进度卡组件**

```tsx
// v2.5.1: 右上角下弹上传进度卡（直扫/导入共用）。
// 数据源 scannerUploadManager 单例；成功 3 秒自动收起，失败保留并可重试。
import { useEffect, useState, useSyncExternalStore } from "react";
import { CheckCircle2, CloudUpload, PauseCircle, RefreshCw, X, XCircle } from "lucide-react";
import { Button, Progress, Spinner } from "./ui/v2";
import { scannerUploadManager } from "../lib/scannerUploadManager";
import type { UploadJobSnapshot } from "../lib/scannerUploadManager";
import { ServerStatusIndicator } from "./ServerStatusIndicator";

const DONE_AUTO_HIDE_MS = 3_000;

const BORDER_BY_STATUS: Record<UploadJobSnapshot["status"], string> = {
  queued: "border-border-subtle",
  creating: "border-info-border",
  uploading: "border-info-border",
  completing: "border-info-border",
  paused: "border-warning-border",
  done: "border-success-border",
  error: "border-destructive-border",
};

export function UploadProgressCard() {
  const snap = useSyncExternalStore(scannerUploadManager.subscribe, scannerUploadManager.getState);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [entered, setEntered] = useState(false);

  // 入场下弹动画（挂载后下一帧过渡到位）
  useEffect(() => {
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // done 任务 3 秒后自动收起
  useEffect(() => {
    const doneIds = snap.jobs.filter((j) => j.status === "done").map((j) => j.id);
    if (doneIds.length === 0) return;
    const timers = doneIds.map((id) =>
      window.setTimeout(() => {
        setDismissed((prev) => {
          const next = new Set(prev);
          next.add(id);
          return next;
        });
      }, DONE_AUTO_HIDE_MS),
    );
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [snap.jobs]);

  const visible = snap.jobs.filter((j) => !dismissed.has(j.id));
  if (visible.length === 0) return null;

  return (
    <div
      className={`fixed right-4 top-14 z-50 flex w-80 flex-col gap-2 transition-all duration-200 ${
        entered ? "translate-y-0 opacity-100" : "-translate-y-2 opacity-0"
      }`}
    >
      <div className="flex justify-end pr-1">
        <ServerStatusIndicator />
      </div>
      {visible.map((job) => (
        <UploadJobCard
          key={job.id}
          job={job}
          queuedCount={snap.queuedCount}
          onDismiss={(id) =>
            setDismissed((prev) => {
              const next = new Set(prev);
              next.add(id);
              return next;
            })
          }
        />
      ))}
    </div>
  );
}

function UploadJobCard({
  job,
  queuedCount,
  onDismiss,
}: {
  job: UploadJobSnapshot;
  queuedCount: number;
  onDismiss: (id: string) => void;
}) {
  const kindLabel = job.kind === "scan" ? "直扫上传" : "导入上传";
  const pct = job.total === 0 ? 0 : Math.round((job.uploaded / job.total) * 100);
  const busy = job.status === "creating" || job.status === "uploading" || job.status === "completing";

  return (
    <div className={`rounded-lg border bg-card p-3 shadow-md ${BORDER_BY_STATUS[job.status]}`}>
      <div className="flex items-center gap-2">
        <CloudUpload size={15} className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {kindLabel} · {job.name}
        </span>
        {(job.status === "done" || job.status === "error") && (
          <Button variant="ghost" size="icon-sm" aria-label="关闭" onClick={() => onDismiss(job.id)}>
            <X size={14} />
          </Button>
        )}
      </div>

      {busy && (
        <>
          <Progress value={pct} size="sm" className="mt-2" />
          <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Spinner size={12} />
            <span className="min-w-0 flex-1 truncate">{job.message}</span>
            <span className="tabular-nums">{job.uploaded}/{job.total} 页</span>
            {queuedCount > 0 && <span className="shrink-0">· 排队 {queuedCount}</span>}
          </p>
        </>
      )}

      {job.status === "queued" && (
        <p className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
          <span>排队等待上传…</span>
          <Button variant="ghost" size="sm" onClick={() => scannerUploadManager.cancelQueued(job.id)}>
            取消
          </Button>
        </p>
      )}

      {job.status === "paused" && (
        <div className="mt-2 flex items-center gap-1.5 rounded-md bg-warning-soft px-2 py-1.5 text-xs text-warning-foreground">
          <PauseCircle size={13} className="shrink-0" />
          <span className="min-w-0 flex-1 break-words">{job.message}</span>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            icon={<RefreshCw size={12} />}
            onClick={() => scannerUploadManager.retryPaused(job.id)}
          >
            立即重试
          </Button>
        </div>
      )}

      {job.status === "done" && (
        <p className="mt-2 flex items-center gap-1.5 rounded-md bg-success-soft px-2 py-1.5 text-xs text-success-foreground">
          <CheckCircle2 size={13} className="shrink-0" />
          <span className="min-w-0 break-words">{job.message}</span>
        </p>
      )}

      {job.status === "error" && (
        <div className="mt-2 rounded-md bg-destructive-soft px-2 py-1.5 text-xs text-destructive-fg">
          <p className="flex items-start gap-1.5">
            <XCircle size={13} className="mt-px shrink-0" />
            <span className="min-w-0 flex-1 break-words">{job.message}</span>
          </p>
          <div className="mt-1.5">
            <Button
              variant="outline"
              size="sm"
              icon={<RefreshCw size={12} />}
              onClick={() => scannerUploadManager.retryFailed(job.id)}
            >
              重试失败页
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: ScannerApp 根部挂载**

`ScannerApp.tsx` 顶部 import 区追加：

```tsx
import { UploadProgressCard } from "./components/UploadProgressCard";
```

将现有 `export function ScannerApp() {` 改名为 `function ScannerAppInner() {`，文件末尾追加新的对外组件：

```tsx
/** v2.5.1: 对外入口 = 原双屏容器 + 全局上传进度卡（右上角下弹） */
export function ScannerApp() {
  return (
    <>
      <ScannerAppInner />
      <UploadProgressCard />
    </>
  );
}
```

- [ ] **Step 3: typecheck**

Run: `npm run typecheck`
Expected: 通过

- [ ] **Step 4: Commit**

```bash
git add src/apps/answer-card/client/components/UploadProgressCard.tsx src/apps/answer-card/client/ScannerApp.tsx
git commit -m "feat(scanner): 右上下弹上传进度卡并挂载到扫描端根容器"
```

---

### Task 6: ScannerPanel 改造（竞态根治）

**Files:**
- Modify: `src/apps/answer-card/client/components/ScannerPanel.tsx`

- [ ] **Step 1: 引入管理器，删除内联上传逻辑**

1a. import 区（第 13 行附近）：`remoteScannerFetch` 从 `../auth/api` 的 import 列表中移除（仅 uploadToRemote 使用它）；新增：

```tsx
import { scannerUploadManager } from "../lib/scannerUploadManager";
```

1b. 删除 `uploadTimerRef`（约 115 行）：

```tsx
  const uploadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
```

1c. 卸载清理 effect（约 175-179 行）删除其中一行，变为：

```tsx
    return () => {
      eventSourceRef.current?.close();
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    };
```

1d. SSE `done` 分支（约 275-287 行），把原来的：

```tsx
          case "done":
            completedRef.current = true;
            setState("done");
            // 通过 ref 读取最新页数，避免闭包捕获扫描开始时的空数组
            onScansComplete?.(sid, pagesRef.current.length);
            // Fetch combined results after scan completes
            fetchCombinedResults(sid);
            // v1.6.0: 远程模式下自动上传
            if (scannerModeRef.current === "remote") {
              if (uploadTimerRef.current) clearTimeout(uploadTimerRef.current);
              uploadTimerRef.current = setTimeout(() => void uploadToRemote(), 500);
            }
            break;
```

替换为：

```tsx
          case "done":
            completedRef.current = true;
            setState("done");
            // 通过 ref 读取最新页数，避免闭包捕获扫描开始时的空数组
            onScansComplete?.(sid, pagesRef.current.length);
            // Fetch combined results after scan completes
            fetchCombinedResults(sid);
            // v2.5.1: 远程模式交由全局上传管理器（脱离面板生命周期，卸载不再能取消上传）
            if (getScannerMode() === "remote") {
              scannerUploadManager.startUpload({
                kind: "scan",
                cardId,
                name: `扫描_${cardId}_${new Date().toISOString().slice(0, 10)}`,
                dpi,
                paperSize,
                pages: pagesRef.current.map((p) => ({
                  pageNum: p.pageNum,
                  side: p.side === "back" ? ("back" as const) : ("front" as const),
                  getBlob: async () => {
                    const r = await authFetch(`/api/scanner/scan-image/${p.recordId}`);
                    if (!r.ok) throw new Error(`读取本机扫描图失败（HTTP ${r.status}）`);
                    return r.blob();
                  },
                })),
              });
            }
            break;
```

（`getScannerMode` 已在 Task 1 加过 import；若 Task 1 时已临时引入则无需重复。）

1e. 整段删除 `uploadToRemote` 函数（v1.6.0 注释块起，约 326-402 行）。

1f. 删除 JSX 中旧的上传状态指示条（约 639-655 行）：

```tsx
            {/* 上传状态指示 */}
            {uploadState && (
              ...整段...
            )}
```

- [ ] **Step 2: typecheck**

Run: `npm run typecheck`
Expected: 通过（确认无残留 uploadState/uploadMsg/uploadTimerRef/remoteScannerFetch 引用）

- [ ] **Step 3: Commit**

```bash
git add src/apps/answer-card/client/components/ScannerPanel.tsx
git commit -m "fix(scanner): 直扫自动上传移交全局管理器，根治面板卸载取消上传的竞态"
```

---

### Task 7: ScannerWorkspace 改造（不卸载 + 导入上传 + 状态指示）

**Files:**
- Modify: `src/apps/answer-card/client/components/ScannerWorkspace.tsx`

- [ ] **Step 1: import 区追加**

```tsx
import { Database, Upload as UploadIcon } from "lucide-react"; // 合并进现有 lucide import
import { useScannerMode, getScannerMode, isRemoteServerConfigured } from "../lib/scannerMode";
import { scannerUploadManager } from "../lib/scannerUploadManager";
import { ServerStatusIndicator } from "./ServerStatusIndicator";
```

（`Database` 若与现有冲突按现有命名处理；现有 import 已含 `ImagePlus` 等，只需补 `Database` 和 `Upload as UploadIcon`。）

- [ ] **Step 2: 组件内加模式状态**

在 `const [isBusy, setIsBusy] = useState(false);` 之后加：

```tsx
  // v2.5.1: 导入阅卷的存储档位（与直扫面板共用同一记忆 key）
  const [importMode, setImportMode] = useScannerMode();
```

- [ ] **Step 3: `gradeAnswerCardFiles` 派发后台上传**

在 `setIsBusy(true);` 之后、`setStatus("正在识别答题卡...");` 之前插入：

```tsx
    // v2.5.1: remote 档位时图片同时后台排队上传（不阻塞判分）
    let uploadQueued = false;
    if (getScannerMode() === "remote") {
      if (isRemoteServerConfigured()) {
        scannerUploadManager.startUpload({
          kind: "import",
          cardId,
          name: `导入_${cardTitle}_${new Date().toISOString().slice(0, 10)}`,
          pages: gradingFiles.map((file, i) => ({
            pageNum: i + 1,
            side: "front" as const,
            getBlob: () => Promise.resolve(file),
          })),
        });
        uploadQueued = true;
      } else {
        setStatus("未配置服务器地址，请先在登录页配置；本次仅本地判分");
      }
    }
```

并把判分成功的 setStatus（原 96 行）改为：

```tsx
      setStatus(`阅卷完成：${result.rows.length} 张，${reviewCount} 题待复核${uploadQueued ? "；图片已后台排队上传到服务器" : ""}`);
```

- [ ] **Step 4: 导入阅卷卡片加档位切换**

在「导入阅卷」Card 的 `<CardContent>` 开头（`<div className="grid grid-cols-2 gap-2">` 之前）插入：

```tsx
                <div className="mb-3 flex flex-col gap-1.5">
                  <span className="text-sm font-medium text-secondary-foreground">图片去向</span>
                  <SegmentedControl
                    aria-label="导入图片去向"
                    value={importMode}
                    onValueChange={setImportMode}
                    block
                    items={[
                      { value: "local", label: "仅本地", icon: <Database size={14} />, tip: "只在本地识别判分" },
                      { value: "remote", label: "本地判分+上传服务器", icon: <UploadIcon size={14} />, tip: "判分照旧，图片同时上传到远端服务器存档" },
                    ]}
                  />
                  {importMode === "remote" && !isRemoteServerConfigured() && (
                    <span className="text-xs text-warning-foreground">尚未配置服务器地址，请先在登录页配置</span>
                  )}
                </div>
```

并在 ui/v2 的 import 列表里补 `SegmentedControl`（该文件当前未引它）。

- [ ] **Step 5: 顶栏挂服务器状态指示器**

header 内 SkinSwitcher 所在容器（约 110-113 行）改为：

```tsx
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <ServerStatusIndicator />
              <SkinSwitcher skin={skin} onSkinChange={onSkinChange} />
            </div>
```

- [ ] **Step 6: 扫完不再卸载面板**

`onScansComplete` 回调（约 122-125 行）改为：

```tsx
                onScansComplete={(sId, pageCount) => {
                  // v2.5.1: 保持面板挂在 done 视图（成绩表可见、上传由全局卡片接管）；退出走面板内按钮
                  setStatus(`扫描完成：${pageCount} 张`);
                }}
```

- [ ] **Step 7: typecheck**

Run: `npm run typecheck`
Expected: 通过

- [ ] **Step 8: Commit**

```bash
git add src/apps/answer-card/client/components/ScannerWorkspace.tsx
git commit -m "feat(scanner): 导入阅卷支持后台上传，扫完保持结果视图，顶栏显示服务器状态"
```

---

### Task 8: 全量回归验证

**Files:** 无新增（纯验证）

- [ ] **Step 1: 类型与冒烟全绿**

```bash
npm run typecheck
npx tsx scripts/remote-server-status-smoke.ts
npx tsx scripts/scanner-upload-manager-smoke.ts
```
Expected: 三条命令全部通过

- [ ] **Step 2: 既有验证套件不回归**

```bash
npm run verify:security-critical
```
Expected: 通过（本次改动纯前端 client/lib + 组件，理论上零影响；失败则排查是否误触服务端代码）

- [ ] **Step 3: 双构建目标产物验证**

```bash
npm run build:scanner
npm run build:web
```
Expected: 均成功；`dist/scanner/` 包含新组件 chunk，web 构建不含 scannerUploadManager 相关引用（Web 端 App.tsx 不渲染 ScannerApp，天然隔离）

---

### Task 9: ia32 安装包（MSI）

**Files:** 无源码改动（打包产物输出至 `release/`）

- [ ] **Step 1: 打包**

Run: `npm run electron:msi:ia32`
说明：链路 = typecheck + vite scanner 构建 + esbuild server bundle + electron-rebuild(ia32) + sharp ia32 二进制补齐 + electron-builder --win msi --ia32。需要 VS Build Tools（better-sqlite3 原生编译）。
Expected: `release/` 下生成 `.msi` 安装包（ia32 架构）

- [ ] **Step 2: 交付物核对**

确认 `release/*.msi` 存在且体积合理（>100MB 量级）；向用户报告产物路径与版本号（安装后关于页/主进程版本应为 2.5.1）。

---

## Self-Review 结论（计划已完成自审）

1. **Spec coverage**：spec §4.1→Task3；§4.2→Task2；§4.3→Task5；§4.4→Task4；§5.1→Task6；§5.2/5.3→Task1+7；§七 测试→Task2/3/8；§七.4 打包→Task9。无缺口。
2. **Placeholder scan**：所有步骤均含完整代码/精确编辑锚点；无 TBD。
3. **Type consistency**：`createServerStatusMonitor` deps 字段 `serverUrl/fetchHealth/schedule` 与冒烟一致；`createScannerUploadManager` deps `remoteFetch/isOnline/getServerKind/sleep/timeoutSignal/genId` 与冒烟一致；UI 组件仅消费快照字段（jobs/queuedCount），与管理器 notify() 输出一致。
