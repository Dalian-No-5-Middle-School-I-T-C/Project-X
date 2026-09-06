// v2.5.1: 扫描端上传管理器 —— 直扫/导入共用的后台上传队列。
// 生命周期完全脱离 React 组件树：面板卸载/切页不影响进行中的上传（根治 v1.6.0 卸载竞态）。
// 协议沿用服务端既有三步接口：POST sessions → POST pages(逐页 multipart) → POST complete。
// 韧性：单页自动重试 2 次（退避 1s/3s，同 token 服务端幂等覆盖）；断线/api_disabled 转 paused，
// 网络恢复自动续传；存在彻底失败页时不发 complete（服务端会话保持可续传态）。
import { authFetch, getStoredApiKey, remoteScannerFetch } from "../auth/api";
import { SERVER_URL_KEY } from "./scannerMode";
import { serverStatus, type ServerStatusKind } from "./remoteServerStatus";

export type UploadJobKind = "scan" | "import";
export type UploadJobStatus =
  | "queued"       // 排队等待
  | "creating"     // 创建远端会话中
  | "uploading"    // 逐页上传中
  | "completing"   // 提交 complete 中
  | "paused"       // 断线暂停（自动恢复）
  | "done"         // 全部完成
  | "error"        // 会话创建失败 / 存在彻底失败页
  | "cancelled";   // 用户取消（队列中或暂停中）

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
  studentId?: { status: string; value: string };
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
  /** 快照：创建时的远端地址与 Key，后续 page/complete 始终发往同一服务器，避免切服后把 A 的 session 发往 B */
  remoteBase: string;
  apiKey: string | null;
  /** 用户取消标志：暂停/队列中任务被取消后置真，使挂起的 runWithRetry 原地退出 */
  cancelled: boolean;
}

export interface UploadManagerDeps {
  localFetch?: typeof authFetch;
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

function readRemoteBase(): string {
  try {
    return (localStorage.getItem(SERVER_URL_KEY) ?? "").trim().replace(/\/+$/, "");
  } catch {
    return "";
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

/** 面向用户的错误文案：超时中止映射为可读提示，其余原样透出 */
const friendlyErr = (err: unknown): string => {
  if (err instanceof DOMException && err.name === "AbortError") return "上传超时";
  if (err instanceof Error && err.name === "TimeoutError") return "上传超时";
  return errMsg(err);
};

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

/** 页面数据用后即弃：ia32 目标内存有限，Blob/File 闭包不能整场滞留 */
function releasePage(page: PageRecord): void {
  page.input.getBlob = () => Promise.reject(new Error("页面数据已释放"));
}

export function createScannerUploadManager(deps: UploadManagerDeps = {}) {
  const baseRemoteFetch = deps.remoteFetch ?? remoteScannerFetch;
  const isOnline = deps.isOnline ?? defaultIsOnline;
  const getServerKind = deps.getServerKind ?? (() => serverStatus.getState().kind);
  const timeoutSignal = deps.timeoutSignal ?? defaultTimeoutSignal;
  const sleep = deps.sleep ?? defaultSleep;
  const pageTimeoutMs = deps.pageTimeoutMs ?? 120_000;
  const genId = deps.genId ?? defaultGenId;

  function jobFetch(j: JobRecord): (url: string, init?: RequestInit) => Promise<Response> {
    // 注入的 mock（冒烟测试）直接使用，不走快照
    if (baseRemoteFetch !== remoteScannerFetch) return baseRemoteFetch;
    // 快照：用创建时的 base/key，避免切服后把 A 的 session 发往 B
    if (!j.remoteBase) return baseRemoteFetch;
    return (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (j.apiKey && !headers.has("X-Api-Key")) headers.set("X-Api-Key", j.apiKey);
      const resolved = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `${j.remoteBase}${url.startsWith("/") ? url : `/${url}`}`;
      return fetch(resolved, { ...init, headers });
    };
  }

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
          j.status === "uploading"
            ? (j.pages.find((p) => !p.done && !p.failed)?.input.pageNum ?? null)
            : null,
        failedPages: j.pages.filter((p) => p.failed).map((p) => p.input.pageNum),
        message: j.message,
        createdAt: j.createdAt,
      })),
      activeJobId:
        // cancelled 是终态:不再算“活动任务”（审查 P2:此前注销后仍被算）
        jobs.find((j) => !["queued", "done", "error", "cancelled"].includes(j.status))?.id ?? null,
      queuedCount: jobs.filter((j) => j.status === "queued").length,
    };
    for (const l of listeners) {
      try {
        l();
      } catch {
        /* 订阅方异常不阻断通知 */
      }
    }
  }

  function setStatus(j: JobRecord, status: UploadJobStatus, message?: string): void {
    j.status = status;
    if (message !== undefined) j.message = message;
    notify();
  }

/**
   * 是否应暂停某任务：
   * - 任务的快照服务器地址与当前配置不一致（已切到另一台服务器）→ 视为孤悬任务，
   *   不能靠全局在线状态判断其可达性，恒保持暂停（避免「重试又暂停」死循环）。
   * - 否则按全局探活判定（离线 / 未启用远端 API / 断网）。
   */
  function shouldPauseNow(j?: JobRecord): boolean {
    if (j && j.remoteBase) {
      const currentBase = readRemoteBase();
      if (currentBase && j.remoteBase !== currentBase) return true;
    }
    const kind = getServerKind();
    return kind === "offline" || kind === "api_disabled";
  }

  function waitForResume(j: JobRecord): Promise<void> {
    return new Promise<void>((resolve) => {
      j.pauseWaiter = resolve;
    });
  }

/** 网络/探活变化时由接线层调用：放行满足恢复条件的暂停任务（孤悬任务维持暂停） */
  function notifyNetworkChanged(): void {
    for (const j of jobs) {
      if (j.status === "paused" && !shouldPauseNow(j)) {
        const w = j.pauseWaiter;
        j.pauseWaiter = null;
        w?.();
      }
    }
  }

  async function createSession(j: JobRecord): Promise<{ sessionId: string; tokens: string[] }> {
    const fetcher = jobFetch(j);
    const res = await fetcher("/api/scanner/upload/sessions", {
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
    // Linux receives recognition data; the Windows client owns the native recognizer.
    const localForm = new FormData();
    localForm.append("file", blobData, `page_${page.input.pageNum}.jpg`);
    localForm.append("page", String(page.input.side === "back" ? 2 : 1));
    localForm.append("dpi", String(j.dpi));
    localForm.append("includeCrops", "1");
    const recognized = await (deps.localFetch ?? authFetch)(`/api/cards/${encodeURIComponent(j.cardId)}/recognition`, {
      method: "POST", body: localForm,
    });
    if (!recognized.ok) throw new Error(`本机识别失败（HTTP ${recognized.status}）`);
    const recognition = await recognized.json();
    // A duplex back page may omit the ID area. Inherit only from its immediate
    // front page in this job, never from another student or an earlier job.
    if (!recognition.studentId?.value && page.input.side === "back") {
      const previous = j.pages[j.pages.indexOf(page) - 1];
      if (previous?.input.side === "front" && previous.done && previous.studentId) {
        recognition.studentId = { ...previous.studentId, status: "inherited" };
      }
    }
    if (recognition.status === "failed" || !recognition.studentId?.value) {
      throw new Error("本机未识别到有效学号，请检查答题卡后重试上传");
    }
    page.studentId = recognition.studentId;
    const form = new FormData();
    form.append("image", blobData, `page_${page.input.pageNum}.jpg`);
    form.append("token", page.token);
    form.append("pageNum", String(page.input.pageNum));
    form.append("side", page.input.side);
    form.append("recognition", JSON.stringify({
      status: recognition.status, studentId: recognition.studentId,
      questions: recognition.questions, subjectiveQuestions: recognition.subjectiveQuestions,
    }));
    const fetcher = jobFetch(j);
    const res = await fetcher(`/api/scanner/upload/sessions/${j.remoteSessionId}/pages`, {
      method: "POST",
      body: form,
      signal: timeoutSignal(pageTimeoutMs),
    });
    if (!res.ok) throw await httpError(res);
    const cropImages = recognition.cropImages ?? [];
    if (cropImages.length > 0) {
      const cropForm = new FormData();
      const manifest = cropImages.map(({ dataBase64, ...crop }: any, index: number) => {
        const fileName = `crop_${index}.png`;
        const bytes = Uint8Array.from(atob(dataBase64), c => c.charCodeAt(0));
        cropForm.append("crops", new Blob([bytes], { type: "image/png" }), fileName);
        return { ...crop, fileName };
      });
      cropForm.append("manifest", JSON.stringify(manifest));
      const cropResponse = await fetcher(`/api/scanner/upload/sessions/${j.remoteSessionId}/pages/${page.token}/crops`, {
        method: "POST", body: cropForm, signal: timeoutSignal(pageTimeoutMs),
      });
      if (!cropResponse.ok) throw await httpError(cropResponse);
      const saved = await cropResponse.json();
      if (saved.skipped || saved.count !== cropImages.length) throw new Error("部分阅卷图块保存失败，请重试上传");
    }
  }

  async function completeSession(j: JobRecord): Promise<void> {
    const fetcher = jobFetch(j);
    const res = await fetcher(`/api/scanner/upload/sessions/${j.remoteSessionId}/complete`, {
      method: "POST",
      signal: timeoutSignal(pageTimeoutMs),
    });
    if (!res.ok) throw await httpError(res);
  }

  /**
   * 单阶段重试执行器：
   * - 每轮循环开头检查断线（离线/api_disabled）→ 转 paused 并挂起等待恢复；
   * - 配置类 4xx（isConfigError）确定性失败，不消耗重试直接上抛；
   * - 其余失败按退避自动重试至多 AUTO_RETRY_EXTRA 次；耗尽后：api_disabled/离线 →
   *   转入暂停（保留重试机会），否则上抛；
   * - 恢复后从当前操作原地继续（resumePhase 由调用方维护）。
   */
  /** 用户取消后让挂起的死跑退出：抛出可识别的取消错误 */
  function cancelledError(j: JobRecord): Error {
    return Object.assign(new Error(`上传任务 ${j.id} 已取消`), { isJobCancelled: true });
  }

  async function runWithRetry<T>(j: JobRecord, phaseLabel: string, fn: () => Promise<T>): Promise<T> {
    let tries = 0;
    for (;;) {
if (j.cancelled) throw cancelledError(j);
      if (shouldPauseNow(j)) {
        setStatus(
          j,
          "paused",
          j.remoteBase && readRemoteBase() && j.remoteBase !== readRemoteBase()
            ? `${phaseLabel}暂停：服务器已切换，原任务需取消后重新上传`
            : `${phaseLabel}中断：已断线，网络恢复后将自动续传`,
        );
        await waitForResume(j);
        if (j.cancelled) throw cancelledError(j);
        setStatus(j, j.resumePhase, `网络已恢复，继续${phaseLabel}`);
        continue;
      }
      try {
        return await fn();
      } catch (err) {
        if (j.cancelled) throw cancelledError(j);
        if (isConfigError(err)) throw err;
        tries += 1;
        if (tries > AUTO_RETRY_EXTRA) {
          if (shouldPauseNow(j)) {
            tries = 0; // 暂停后恢复重新给满重试预算
            setStatus(j, "paused", `${phaseLabel}失败：${friendlyErr(err)}，已断线等待恢复…`);
            await waitForResume(j);
            if (j.cancelled) throw cancelledError(j);
            setStatus(j, j.resumePhase, `网络已恢复，继续${phaseLabel}`);
            continue;
          }
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
        if ((err as { isJobCancelled?: boolean }).isJobCancelled) return;
        setStatus(j, "error", `创建会话失败：${friendlyErr(err)}`);
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
        releasePage(page);
        notify();
      } catch (err) {
        if ((err as { isJobCancelled?: boolean }).isJobCancelled) return;
        page.failed = true;
        lastErrMsg = friendlyErr(err);
        notify();
      }
    }

    const failedPages = j.pages.filter((p) => p.failed);
    if (failedPages.length > 0) {
      const nums = failedPages.map((p) => p.input.pageNum).join("、");
      for (const p of j.pages) {
        if (p.done && !p.failed) releasePage(p); // 失败页保留数据以供重试，成功页即刻释放
      }
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
      for (const p of j.pages) releasePage(p);
      setStatus(j, "done", `上传完成，${j.pages.length} 页已提交到服务器`);
    } catch (err) {
      if ((err as { isJobCancelled?: boolean }).isJobCancelled) return;
      for (const p of j.pages) {
        if (p.done && !p.failed) releasePage(p);
      }
      setStatus(j, "error", `提交会话失败：${friendlyErr(err)}`);
    }
  }

  /** 全局串行泵：同一时刻只跑一个任务，避免带宽争抢；
   * 暂停中的活动任务会占住串行泵（后续任务本也会立即暂停），恢复后继续排空 */
  async function pump(): Promise<void> {
    if (running) return;
    running = true;
    try {
      for (;;) {
        const next = jobs.find((x) => x.status === "queued");
        if (!next) break;
        try {
          await runJob(next);
        } catch (err) {
          // 兜底：runJob 内部异常不应卡死队列
          if ((err as { isJobCancelled?: boolean }).isJobCancelled) continue;
          if (next.status !== "done" && next.status !== "error" && next.status !== "cancelled") {
            next.status = "error";
            next.message = `上传任务异常中断：${err instanceof Error ? err.message : String(err)}`;
          }
          notify();
        }
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
      remoteBase: readRemoteBase(),
      apiKey: getStoredApiKey(),
      cancelled: false,
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

  /**
   * 取消任务（队列中或已暂停）：
   * - 队列中：直接从数组移除；
   * - 已暂停：置 cancelled 并唤醒挂起的 runWithRetry 使其原地退出，同时解除串行泵占用；
   * - 其余状态（mid-flight / done / error）不允许取消，避免打断在途上传或已完成结果。
   */
  function cancelJob(jobId: string): void {
    const idx = jobs.findIndex((x) => x.id === jobId);
    if (idx < 0) return;
    const j = jobs[idx];
    if (j.status === "queued") {
      for (const p of j.pages) releasePage(p);
      jobs.splice(idx, 1);
      notify();
      return;
    }
    if (j.status === "paused") {
      j.cancelled = true;
      // 全部页面释放（含未上传页）：getBlob 闭包持有 File/Blob，ia32 内存有限，
      // 取消后不得再被任务引用（审查 P2：此前只释放已完成页）
      for (const p of j.pages) releasePage(p);
      const w = j.pauseWaiter;
      j.pauseWaiter = null;
      j.status = "cancelled";
      j.message = "任务已取消";
      w?.();
      notify();
      return;
    }
  }

  /**
   * 移除终态任务（cancelled/done/error）并释放其页面资源。
   * 供进度卡「关闭」按钮调用——取消后的卡片不再悬浮到重启（审查 P2）。
   */
  function dismissJob(jobId: string): boolean {
    const idx = jobs.findIndex((x) => x.id === jobId);
    if (idx < 0) return false;
    const j = jobs[idx];
    if (j.status !== "cancelled" && j.status !== "done" && j.status !== "error") {
      return false;
    }
    for (const p of j.pages) releasePage(p);
    jobs.splice(idx, 1);
    notify();
    return true;
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
    cancelJob,
    dismissJob,
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
