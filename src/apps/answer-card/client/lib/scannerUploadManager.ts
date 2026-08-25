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
  async function runWithRetry<T>(j: JobRecord, phaseLabel: string, fn: () => Promise<T>): Promise<T> {
    let tries = 0;
    for (;;) {
      if (shouldPauseNow()) {
        setStatus(j, "paused", `${phaseLabel}中断：已断线，网络恢复后将自动续传`);
        await waitForResume(j);
        setStatus(j, j.resumePhase, `网络已恢复，继续${phaseLabel}`);
        continue;
      }
      try {
        return await fn();
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
