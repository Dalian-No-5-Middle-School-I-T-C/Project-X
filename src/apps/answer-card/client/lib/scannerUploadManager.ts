// v2.5.1: 扫描端上传管理器 —— 直扫/导入共用的后台上传队列。
// 生命周期完全脱离 React 组件树：面板卸载/切页不影响进行中的上传（根治 v1.6.0 卸载竞态）。
// 协议沿用服务端既有三步接口：POST sessions → POST pages(逐页 multipart) → POST complete。
// 韧性：单页自动重试 2 次（退避 1s/3s，同 token 服务端幂等覆盖）；断线/api_disabled 转 paused，
// 网络恢复自动续传；存在彻底失败页时不发 complete（服务端会话保持可续传态）。
import { authFetch, getStoredApiKey, remoteScannerFetch } from "../auth/api";
import { SERVER_URL_KEY, readServerUrl } from "./scannerMode";
import { assertCredentialTransportAllowed } from "./remoteCredentialTransport";
import { serverStatus, type ServerStatusKind } from "./remoteServerStatus";
import { applyScanStudentId, uniqueScanConflictCards } from "../../../../shared/scanPages";
import { forgetScanUploadRecovery, readScanUploadRecovery, rememberQueuedGroup, writeScanUploadRecovery } from "./scannerUploadLedger";
import type { ScanBatchFailure, ScanConflictCard, ScanBatchResponse } from "../../../../shared/scanPages";
import type { CombinedGradingRow } from "../../../../shared/types";

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
  getCorrection?: () => Promise<import("../../../../shared/types").CombinedRecognitionResult | undefined>;
  /** Stable card group and layout page from the local session summary. */
  groupId?: string;
  layoutPage?: number;
  /** Local immutable scan record used to verify a restored page mapping. */
  recordId?: string;
  studentId?: string;
}

export interface StartUploadInput {
  trackResults?: boolean;
  identityMode?: "strict" | "legacy";
  kind: UploadJobKind;
  cardId: string;
  /**
   * 安全 R35：本机识别所用答题卡的版本指纹（shared/cardVersion.cardFingerprint）。
   * 服务器会拿自己那一版比对，不一致就拒绝入库——扫描端离线期间服务器改了卡
   * （版面挪了、答案改了）时，按旧卡算出来的分数不能静默写进成绩。
   * 读不到本机卡就传空串，任务会直接失败而不是不带版本上传。
   */
  cardVersion: string;
  name: string;
  dpi?: number;
  paperSize?: string;
  /** 本机扫描会话。同一张卡的 groupId 会跨会话重号，有它才能判断是不是同一份原卷。 */
  localSessionId?: string;
  pages: UploadPageInput[];
}

export interface UploadJobSnapshot {
  results?: ScanBatchResponse;
  resultRows?: Array<{ pageNum: number; side: "front" | "back"; row: CombinedGradingRow }>;
  remoteSessionId?: string | null;
  reviewCards?: ScanConflictCard[];
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
  failures?: ScanBatchFailure[];
  /** 非终态提示：相关联的冲突（如重复学号撤出），不影响任务继续上传 */
  notice?: string;
  canCorrectStudentId: boolean;
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
  anchor?: PageRecord;
  pairingError?: string;
}

interface JobRecord {
  resultRevision?: number;
  trackResults?: boolean;
  results?: ScanBatchResponse;
  resultRows?: UploadJobSnapshot["resultRows"];
  /** Synchronize released, already-uploaded sides before retrying this card. */
  pendingStudentId?: string;
  reviewCards?: ScanConflictCard[];
  id: string;
  kind: UploadJobKind;
  name: string;
  cardId: string;
  localSessionId?: string;
  /** 安全 R35：随会话创建上报的卡版本指纹，服务端据此拒绝旧版本上传 */
  cardVersion: string;
  dpi: number;
  paperSize: string;
  identityMode: "strict" | "legacy";
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
  failures?: ScanBatchFailure[];
  /** 非终态提示：相关联的冲突（如重复学号撤出），不影响任务继续上传 */
  notice?: string;
}

function pendingReviewCards(sessionId: string, batch: ScanBatchResponse): ScanConflictCard[] {
  return uniqueScanConflictCards([
    ...(batch.results ?? []).filter(r => !r.saved).map(r => ({ sessionId, groupId: r.groupId,
      studentId: r.studentId, pages: r.pages, previouslySaved: false })),
    ...(batch.failures ?? []).filter(f => !f.conflicts?.length).map(f => ({ sessionId, groupId: f.groupId,
      studentId: f.studentId ?? "", pages: f.pages, previouslySaved: false })),
    ...(batch.reviewCards ?? []),
  ]);
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
  // v2.5.6：统一归一化（缺 scheme 自动补 http://）。任务快照也依赖它，
  // 否则快照出来的 base 是非法 URL，所有远程请求都会在 fetch 层直接抛错。
  return readServerUrl();
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
  if ((err as { noRetry?: boolean }).noRetry) return true;
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
      const sendsCredential = Boolean(j.apiKey) || headers.has("X-Api-Key") || headers.has("Authorization");
      // 安全（R32）：快照里记的是**建任务时**的地址，闸门必须按这个地址判，
      // 否则「先配 https 建任务、再改成 http」会把 Key 送到明文目标上。
      if (sendsCredential) {
        try {
          assertCredentialTransportAllowed(j.remoteBase);
        } catch (error) {
          // 走 rejected promise 而不是同步抛：调用点有的在事件回调里，同步异常会逃出队列的错误处理
          return Promise.reject(error);
        }
      }
      if (j.apiKey && !headers.has("X-Api-Key")) headers.set("X-Api-Key", j.apiKey);
      const resolved = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `${j.remoteBase}${url.startsWith("/") ? url : `/${url}`}`;
      return fetch(resolved, { ...init, headers });
    };
  }

  const jobs: JobRecord[] = [];
  // Keep small version receipts after a completed task releases its image data.
  const sessionVersions = new Map<string, string>();
  const versionKey = (job: JobRecord, sessionId: string) => JSON.stringify([job.remoteBase, job.cardId, sessionId]);
  function rememberSessionVersion(job: JobRecord, sessionId: string): void {
    const key = versionKey(job, sessionId);
    sessionVersions.set(key, job.cardVersion);
    try { localStorage.setItem(`projectx_scanner_session_version/${key}`, job.cardVersion); }
    catch { /* In-memory receipts still work when browser storage is unavailable. */ }
  }
  function rememberedSessionVersion(job: JobRecord, sessionId: string): string | undefined {
    const key = versionKey(job, sessionId);
    const cached = sessionVersions.get(key);
    if (cached) return cached;
    try {
      const saved = localStorage.getItem(`projectx_scanner_session_version/${key}`);
      return saved && /^[0-9a-f]{24}$/i.test(saved) ? saved : undefined;
    } catch { return undefined; }
  }

  function recoveryGroup(job: JobRecord): string | null {
    if (job.kind !== "scan" || !job.localSessionId) return null;
    const groups = new Set(job.pages.map(page => page.input.groupId));
    return groups.size === 1 ? [...groups][0] ?? null : null;
  }

  function persistRecovery(job: JobRecord, completed = false): void {
    const groupId = recoveryGroup(job);
    if (groupId === null || !job.remoteSessionId) return;
    writeScanUploadRecovery(job.cardId, job.localSessionId!, groupId, {
      remoteBase: job.remoteBase, remoteSessionId: job.remoteSessionId, cardVersion: job.cardVersion,
      completed, dpi: job.dpi, paperSize: job.paperSize, identityMode: job.identityMode,
      pendingStudentId: job.pendingStudentId,
      pages: job.pages.map(page => ({ pageNum: page.input.pageNum, side: page.input.side,
        layoutPage: page.input.layoutPage, recordId: page.input.recordId, studentId: page.input.studentId,
        token: page.token, done: page.done, recognizedStudentId: page.studentId })),
    });
  }

  function restoreRecovery(job: JobRecord): void {
    const groupId = recoveryGroup(job);
    if (groupId === null) return;
    const saved = readScanUploadRecovery(job.cardId, job.localSessionId!, groupId);
    if (!saved) return;
    if (saved.completed) throw new Error("这份卷已经上传完成，请从服务器成绩修改进入订正");
    if (saved.remoteBase !== job.remoteBase) throw new Error("这份卷尚未上传完成，请切回原服务器后续传");
    if (saved.cardVersion !== job.cardVersion || saved.identityMode !== job.identityMode
      || saved.pages.length !== job.pages.length || saved.pages.some((page, i) => {
        const input = job.pages[i].input;
        return page.pageNum !== input.pageNum || page.side !== input.side || page.layoutPage !== input.layoutPage
          || page.recordId !== input.recordId;
      })) throw new Error("原卷版本或页序已改变，请核对原上传会话后再处理");
    job.remoteSessionId = saved.remoteSessionId;
    job.dpi = saved.dpi;
    job.paperSize = saved.paperSize;
    job.pendingStudentId = saved.pendingStudentId;
    saved.pages.forEach((page, index) => {
      const target = job.pages[index];
      target.token = page.token;
      target.done = page.done;
      target.studentId = page.recognizedStudentId;
      target.input.studentId = page.studentId;
    });
    job.message = "已恢复原上传会话，继续上传未完成的页面";
  }
  const listeners = new Set<() => void>();
  let snapshot: UploadManagerSnapshot = { jobs: [], activeJobId: null, queuedCount: 0 };
  let running = false;

  function notify(): void {
    snapshot = {
      jobs: jobs.map((j) => ({
        id: j.id,
        remoteSessionId: j.remoteSessionId,
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
        failures: j.failures,
        notice: j.notice,
        canCorrectStudentId: new Set(j.pages.map(p => p.input.groupId ?? `sheet:${p.input.pageNum}`)).size === 1,
        reviewCards: j.reviewCards,
        results: j.results,
        resultRows: j.resultRows,
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
    // 安全 R35：不知道本机用的是哪一版卡就不要上传——服务器无法核验，
    // 旧布局/旧答案算出来的分数会静默进到别人的成绩里。
    if (!j.cardVersion) {
      // 重试也不会凭空多出本机版本号，按不可重试错误立即失败，把提示原样交给用户
      throw Object.assign(new Error("未能确定本机答题卡版本，请重新选择该答题卡（联网同步）后再上传"), { noRetry: true });
    }
    const fetcher = jobFetch(j);
    const res = await fetcher("/api/scanner/upload/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cardId: j.cardId,
        cardVersion: j.cardVersion,
        name: j.name,
        dpi: j.dpi,
        paperSize: j.paperSize,
        identityMode: j.identityMode,
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
    localForm.append("page", String(page.input.layoutPage ?? (page.input.side === "back" ? 2 : 1)));
    localForm.append("dpi", String(j.dpi));
    localForm.append("includeCrops", "1");
    localForm.append("identityMode", j.identityMode);
    const recognized = await (deps.localFetch ?? authFetch)(`/api/cards/${encodeURIComponent(j.cardId)}/recognition`, {
      method: "POST", body: localForm,
    });
    if (!recognized.ok) {
      const error = await httpError(recognized);
      const detail = recognized.status === 413
        ? `单张图片 ${(blobData.size / 1024 / 1024).toFixed(1)} MiB 超过接收限制，请降低扫描分辨率或转换为 PNG/JPEG 后重试`
        : error.message;
      error.message = `本机识别失败（HTTP ${recognized.status}）：${detail}`;
      // Preserve the status so deterministic 4xx failures are not uploaded repeatedly.
      throw error;
    }
    const recognition = await recognized.json();
    // Recognition still produces fresh crops; explicit local edits remain authoritative.
    const corrected = await page.input.getCorrection?.();
    if (corrected) {
      recognition.questions = corrected.questions;
      recognition.subjectiveQuestions = corrected.subjectiveQuestions;
      recognition.studentId = corrected.studentId;
      if (recognition.geometry && recognition.identity?.status !== "rejected") recognition.status = "ok";
    }
    // Dependencies are fixed when the job is created, independent of array adjacency,
    // retry counts or network latency. Never borrow an ID across physical cards.
    if (!corrected && page.input.studentId) {
      applyScanStudentId(recognition, page.input.studentId);
    } else if (page.anchor) {
      const inherited = page.anchor.studentId;
      if (recognition.studentId?.value && recognition.studentId.value !== inherited?.value) {
        throw new Error("同一份答题卡正反面学号不一致，请核对后重新上传");
      }
      if (!recognition.studentId?.value && inherited) applyScanStudentId(recognition, inherited.value, true);
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
      status: recognition.status, studentId: recognition.studentId, identity: recognition.identity,
      geometry: recognition.geometry, pageNumber: recognition.pageNumber,
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
      // 安全 R35：完成时再报一次版本——从扫描到入库可能隔很久，服务器上的卡若已改动，
      // 这一批就不能入库（服务端返回 409 CARD_VERSION_MISMATCH）。
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cardVersion: j.cardVersion }),
      signal: timeoutSignal(pageTimeoutMs),
    });
    if (!res.ok) {
      const body = await res.clone().json().catch(() => ({}));
      if (Array.isArray(body.failures)) {
        j.failures = body.failures;
        j.reviewCards = pendingReviewCards(j.remoteSessionId!, body);
        const affected = new Set<string>(body.failures.flatMap((f: ScanBatchFailure) => f.conflicts?.map(c => c.sessionId) ?? []));
        for (const other of jobs) if (other !== j && other.remoteBase === j.remoteBase && other.remoteSessionId && affected.has(other.remoteSessionId)) {
          other.notice = "相关重复学号卷需核对；扫描和上传继续进行";
          // An in-flight or queued task must finish its own upload. A withdrawn
          // saved grade must stop displaying success, while retaining recovery.
          if (other.status === "done" || other.status === "error") {
            other.status = "error";
            other.message = "重复学号：原已保存成绩已撤出，请核对新旧卷";
          }
          // Describe only attempts belonging to this task, keeping all evidence.
          const localFailures: ScanBatchFailure[] = body.failures.flatMap((failure: ScanBatchFailure) =>
            (failure.conflicts ?? []).filter(card => card.sessionId === other.remoteSessionId)
              .map(card => ({ ...failure, groupId: card.groupId, studentId: card.studentId, pages: card.pages })));
          other.failures = [...new Map([...(other.failures ?? []), ...localFailures].map(f => [f.groupId, f])).values()];
        }
        notify();
      }
      throw await httpError(res);
    }
    j.failures = undefined;
    j.notice = undefined;
    const body = await res.json().catch(() => ({}));
    j.reviewCards = body.reviewCards;
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
        rememberSessionVersion(j, sessionId);
        j.pages.forEach((p, i) => {
          p.token = tokens[i];
        });
        // Save the remote identity before sending pages. Closing a failed card can then restore this same session.
        persistRecovery(j);
      } catch (err) {
        if ((err as { isJobCancelled?: boolean }).isJobCancelled) return;
        setStatus(j, "error", `创建会话失败：${friendlyErr(err)}`);
        return;
      }
    }

    // Successful sides have already released their blobs. Correct their stored
    // metadata through the existing group endpoint before sending failed sides.
    if (j.pendingStudentId) {
      j.resumePhase = "uploading";
      setStatus(j, "uploading", "正在同步已上传面的订正学号…");
      try {
        await runWithRetry(j, "订正学号", async () => {
          const fetcher = jobFetch(j);
          const response = await fetcher(`/api/scanner/upload/sessions/${j.remoteSessionId}/results`, {
            signal: timeoutSignal(pageTimeoutMs),
          });
          if (!response.ok) throw await httpError(response);
          const batch = await response.json() as ScanBatchResponse;
          const completed = j.pages.filter(page => page.done);
          const groups = [...batch.results.map(result => ({ ...result, saved: result.saved })),
            ...batch.failures.map(failure => ({ ...failure, saved: false })),
            ...(batch.reviewCards ?? []).filter(card => card.sessionId === j.remoteSessionId)
              .map(card => ({ ...card, saved: !!card.previouslySaved }))];
          const matched = groups.filter(group => group.pages.some(page => completed.some(p => p.token === page.recordId)));
          const targets = new Map(matched.map(group => [group.groupId, group]));
          if (completed.some(page => ![...targets.values()].some(group => group.pages.some(p => p.recordId === page.token)))
            || matched.some(group => group.saved)) {
            throw Object.assign(new Error("已上传面缺少可订正的原卷记录，请刷新服务器结果后核对"), { noRetry: true });
          }
          for (const groupId of targets.keys()) {
            const corrected = await fetcher(`/api/scanner/upload/sessions/${j.remoteSessionId}/correct`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ groupId, studentId: j.pendingStudentId }), signal: timeoutSignal(pageTimeoutMs),
            });
            if (!corrected.ok) throw await httpError(corrected);
          }
          for (const page of completed) page.studentId = { status: "ok", value: j.pendingStudentId! };
        });
        j.pendingStudentId = undefined;
        persistRecovery(j);
      } catch (error) {
        if ((error as { isJobCancelled?: boolean }).isJobCancelled) return;
        // Keep a failed-page marker so correction can be retried with another ID.
        for (const page of j.pages) if (!page.done) page.failed = true;
        setStatus(j, "error", `订正已上传面失败：${friendlyErr(error)}`);
        return;
      }
    }

    // Phase 2: 逐页串行上传（失败页记录后继续，不打断批次）
    j.resumePhase = "uploading";
    let lastErrMsg = "";
    for (const page of j.pages) {
      if (page.done || page.failed) continue;
      setStatus(j, "uploading", `正在上传第 ${j.pages.indexOf(page) + 1}/${j.pages.length} 面（第 ${page.input.pageNum} 张${page.input.side === "front" ? "正面" : "背面"}）`);
      try {
        if (page.pairingError) throw new Error(page.pairingError);
        if (page.anchor && !page.anchor.done) throw new Error("同份答题卡的首页尚未成功，请重试失败页；背面不会借用其他学生的学号");
        await runWithRetry(j, "上传", () => uploadPageOnce(j, page));
        page.done = true;
        persistRecovery(j);
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
      const nums = failedPages.map(p => `第 ${p.input.pageNum} 张${p.input.side === "front" ? "正面" : "背面"}`).join("、");
      for (const p of j.pages) {
        if (p.done && !p.failed) releasePage(p); // 失败页保留数据以供重试，成功页即刻释放
      }
      setStatus(
        j,
        "error",
        `${failedPages.length} 面上传失败（${nums}）：${lastErrMsg}。可点「重试失败页」续传`,
      );
      return; // 有失败页不发 complete：服务端会话保持 uploading 可续传
    }

    // Phase 3: 提交完成
    j.resumePhase = "completing";
    setStatus(j, "completing", "正在提交上传会话…");
    try {
      // A restart after complete succeeds must retry only complete, never overwrite completed pages.
      persistRecovery(j);
      await runWithRetry(j, "提交会话", () => completeSession(j));
      persistRecovery(j, true);
      const groupId = recoveryGroup(j);
      if (groupId !== null && rememberQueuedGroup(j.cardId, j.localSessionId!, groupId)) {
        forgetScanUploadRecovery(j.cardId, j.localSessionId!, groupId);
      }
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

  function scanGroupJobs(cardId: string, groupId: string, localSessionId: string): JobRecord[] {
    return jobs.filter(job => job.kind === "scan" && job.cardId === cardId && job.localSessionId === localSessionId
      && job.pages.some(page => page.input.groupId === groupId));
  }

  /** 这份扫描原卷是否已经占住上传资格。导入任务没有本机会话号，不能拿来挡新扫描；缺会话号也不当通配。 */
  function hasGroupUpload(cardId: string, groupId: string, localSessionId?: string): boolean {
    if (!localSessionId) return false;
    return scanGroupJobs(cardId, groupId, localSessionId).some(job => {
      if (job.remoteSessionId) return true;
      return job.status === "queued" || job.status === "creating" || job.status === "uploading"
        || job.status === "paused" || job.status === "completing" || job.status === "done";
    });
  }

  /**
   * 删除本机原图前先和上传任务对齐。
   * 还在排队、且没建远端会话的任务直接取消，避免稍后读图 404 还提示重试。
   * 已建会话但尚未完成的任务保留原图用于续传，上传完成后保留完成标记。
   */
  function localGroupDeleteBlock(cardId: string, groupId: string, localSessionId: string): string | null {
    const inFlight = scanGroupJobs(cardId, groupId, localSessionId).some(job => job.status === "creating"
      || job.status === "uploading" || job.status === "completing" || job.status === "paused");
    if (inFlight) return "这份卷正在上传，请等上传结束再删除本机原图";
    const recovery = readScanUploadRecovery(cardId, localSessionId, groupId);
    return recovery && !recovery.completed ? "这份卷尚未上传完成，请恢复上传后再删除本机原图" : null;
  }

  function releaseGroupForLocalDelete(cardId: string, groupId: string, localSessionId: string):
    { ok: true; forgetLedger: boolean } | { ok: false; message: string } {
    const message = localGroupDeleteBlock(cardId, groupId, localSessionId);
    if (message) return { ok: false, message };
    const matching = scanGroupJobs(cardId, groupId, localSessionId);
    // 已经建出远端会话或已经传完的，留下入队标记，避免删掉本机图后再开一份回执。
    const forgetLedger = !matching.some(job => job.status === "done" || job.remoteSessionId != null);
    for (const job of matching) {
      if (job.status === "queued") cancelJob(job.id);
      else if (job.status === "error" || job.status === "cancelled") dismissJob(job.id);
    }
    return { ok: true, forgetLedger };
  }

  function startUpload(input: StartUploadInput): string {
    if (input.pages.length === 0) throw new Error("没有可上传的页面");
    const pages: PageRecord[] = input.pages.map(p => ({ input: { ...p }, token: "", done: false, failed: false }));
    // TWAIN front/back use the same physical pageNum. Sort deterministically even
    // when the database or reconnect delivers the back before the front.
    pages.sort((a, b) => a.input.pageNum - b.input.pageNum || (a.input.side === b.input.side ? 0 : a.input.side === "front" ? -1 : 1));
    const groups = new Map<string, PageRecord[]>();
    for (const page of pages) {
      const key = page.input.groupId ?? `sheet:${page.input.pageNum}`;
      const group = groups.get(key) ?? [];
      group.push(page);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      const anchor = group.find(p => (p.input.layoutPage ?? (p.input.side === "front" ? 1 : 2)) === 1);
      const seen = new Set<number>();
      const duplicate = group.some(p => {
        const position = p.input.layoutPage ?? (p.input.side === "front" ? 1 : 2);
        if (seen.has(position)) return true;
        seen.add(position); return false;
      });
      for (const page of group) {
        if (duplicate) page.pairingError = "同份答题卡存在重复页面，请核对页序后重新上传";
        else if (!anchor) page.pairingError = "未找到同份答题卡的首页，请补齐正面后重新上传";
        else if (page !== anchor) page.anchor = anchor;
      }
    }
    const job: JobRecord = {
      id: genId(),
      kind: input.kind,
      name: input.name,
      cardId: input.cardId,
      localSessionId: input.localSessionId,
      cardVersion: input.cardVersion,
      dpi: input.dpi ?? 300,
      paperSize: input.paperSize ?? "A4",
      identityMode: input.identityMode ?? "strict",
      pages,
      status: "queued",
      resumePhase: "creating",
      remoteSessionId: null,
      trackResults: input.trackResults,
      message: "",
      createdAt: Date.now(),
      pauseWaiter: null,
      remoteBase: readRemoteBase(),
      apiKey: getStoredApiKey(),
      cancelled: false,
    };
    restoreRecovery(job);
    jobs.push(job);
    notify();
    void pump();
    return job.id;
  }

  /** 手动兜底：把彻底失败页重新入队（复用既有会话与 token，已成功页不重传） */
  function retryFailed(jobId: string): void {
    const j = jobs.find((x) => x.id === jobId);
    if (!j || j.status !== "error") return;
    // Before session creation, a corrected key can safely replace the failed
    // snapshot. Existing sessions remain owned by the original key, and a key
    // configured for another server must never be sent to this job's server.
    if (!j.remoteSessionId && j.remoteBase === readRemoteBase()) {
      j.apiKey = getStoredApiKey();
    }
    try { persistRecovery(j); }
    catch (error) { setStatus(j, "error", friendlyErr(error)); return; }
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

  async function refreshResults(id: string, actionSessionIds: string[] = []): Promise<void> {
    const source = jobs.find(j => j.id === id);
    if (!source) return;
    // Capture the links before refreshing: a corrected response may no longer
    // contain the old conflicts, but their withdrawn jobs still need updating.
    const sessions = new Set([source.remoteSessionId, ...actionSessionIds,
      ...(source.reviewCards ?? []).map(card => card.sessionId),
      ...(source.failures ?? []).flatMap(failure => failure.conflicts?.map(card => card.sessionId) ?? [])]);
    const outcomes = await Promise.allSettled(jobs.filter(j => j.remoteBase === source.remoteBase && j.apiKey === source.apiKey && j.cardId === source.cardId
      && j.remoteSessionId && sessions.has(j.remoteSessionId) && (j.status === "done" || j.status === "error")).map(async job => {
      const revision = job.resultRevision = (job.resultRevision ?? 0) + 1;
      const response = await jobFetch(job)(`/api/scanner/upload/sessions/${job.remoteSessionId}/results`, {
        signal: timeoutSignal(pageTimeoutMs),
      });
      if (!response.ok) throw await httpError(response);
      const body = await response.json() as ScanBatchResponse;
      if (revision !== job.resultRevision) return;
      job.results = body;
      if (job.trackResults) {
        job.resultRows = body.results.flatMap(result => result.pages.flatMap(page =>
          page.grading ? [{ pageNum: page.pageNum, side: page.side, row: page.grading }] : []));
      }
      // Corrected new attempts are pending too; keep their view/save actions even
      // after another session has been saved and the duplicate failures disappear.
      job.reviewCards = pendingReviewCards(job.remoteSessionId!, body);
      job.failures = body.failures;
      if (!body.failures?.length) job.notice = undefined;
      const allSaved = (body.results?.length > 0 || (body.discardedGroups ?? 0) > 0)
        && body.results.every((r: { saved: boolean }) => r.saved);
      if (!job.pages.some(p => p.failed)) {
        job.status = body.failures?.length || !allSaved ? "error" : "done";
        job.message = job.status === "done" ? `上传完成，${job.pages.length} 页已提交到服务器`
          : "仍有答题卡未保存，请核对后重新保存会话";
      }
      notify();
    }));
    const failed = outcomes.find(outcome => outcome.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }

  return {
    getFailedPageBlobs: async (id: string) => {
      const job = jobs.find(j => j.id === id);
      if (!job) throw new Error("上传任务已关闭");
      return Promise.all(job.pages.filter(p => p.failed).map(async page => ({
        recordId: page.token, pageNum: page.input.pageNum, side: page.input.side, blob: await page.input.getBlob(),
      })));
    },
    correctStudentId: (id: string, studentId: string) => {
      const job = jobs.find(j => j.id === id);
      if (!job || job.status !== "error" || !job.pages.some(p => p.failed)) throw new Error("此任务没有可订正的失败页");
      if (!/^[0-9A-Za-z_-]{1,64}$/.test(studentId)) throw new Error("请输入有效学号");
      if (new Set(job.pages.map(p => p.input.groupId ?? `sheet:${p.input.pageNum}`)).size !== 1) throw new Error("请逐份答题卡订正学号");
      for (const page of job.pages) page.input.studentId = studentId;
      if (job.pages.some(page => page.done)) job.pendingStudentId = studentId;
      retryFailed(id);
    },
    refreshResults,
    saveSession: async (id: string, sessionId: string, groupId?: string) => {
      const source = jobs.find(j => j.id === id);
      const owner = source && jobs.find(j => j.remoteSessionId === sessionId && j.remoteBase === source.remoteBase
        && j.apiKey === source.apiKey && j.cardId === source.cardId);
      const version = owner?.cardVersion ?? (source && rememberedSessionVersion(source, sessionId));
      if (!source) throw new Error("上传任务已关闭");
      for (const job of jobs) if (job.remoteBase === source.remoteBase && job.cardId === source.cardId) job.resultRevision = (job.resultRevision ?? 0) + 1;
      return jobFetch(owner ?? source)(`/api/scanner/upload/sessions/${encodeURIComponent(sessionId)}/complete`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(version ? { cardVersion: version } : {}), ...(groupId !== undefined ? { groupId } : {}) }), signal: timeoutSignal(pageTimeoutMs),
      });
    },
    requestJob: (id: string, url: string, init?: RequestInit) => {
      const job = jobs.find(j => j.id === id);
      if (!job) return Promise.reject(new Error("上传任务已关闭"));
      if (init?.method && init.method !== "GET") {
        for (const other of jobs) if (other.remoteBase === job.remoteBase && other.cardId === job.cardId) other.resultRevision = (other.resultRevision ?? 0) + 1;
      }
      return jobFetch(job)(url, init);
    },
    startUpload,
    hasGroupUpload,
    localGroupDeleteBlock,
    releaseGroupForLocalDelete,
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
