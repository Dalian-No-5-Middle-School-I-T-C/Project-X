import { authFetch, mediaUrl } from "../../auth/api";
import { getScannerMode } from "../../lib/scannerMode";
import { scannerUploadManager } from "../../lib/scannerUploadManager";
import { parseCardVersion } from "../../../../../shared/cardVersion";
import type { ScanBatchResponse, ScanBatchResult } from "../../../../../shared/scanPages";
import type { CorrectionDocument } from "../../../../../shared/scanCorrection";

/**
 * 后处理页只有本地通道。
 *
 * 远端模式不直接打 `/api/scanner/upload/...`：本页持有的是本地 TWAIN sessionId，
 * 而上传端点认的是 `job.remoteSessionId`（两者不同域），且 `requestJob` 对已收尾的
 * job 直接 reject「上传任务已关闭」。远端语义统一由 `queueGroupUpload` 承担
 * （startUpload 自建 remote session），与 ScannerPanel 现状同构。
 */
export interface PostprocessChannel {
  request(url: string, init?: RequestInit): Promise<Response>;
  results(sessionId: string): Promise<ScanBatchResponse>;
  /** 仅本地模式的入库通道（= 原 ScannerPanel「保存成绩」按钮的 POST results）。groupIds 只保存点名的正常组。 */
  saveResults(sessionId: string, groupIds: readonly string[]): Promise<ScanBatchResponse>;
  correctionUrl(sessionId: string, groupId: string): string;
  imageUrl(recordId: string): string;
  discardUrl(sessionId: string, groupId: string): string;
  retryUrl(sessionId: string): string;
  deleteGroupsUrl(sessionId: string): string;
}

async function readJson(res: Response): Promise<any> {
  const data = await res.json();
  if (!res.ok) throw new Error(data?.message || `请求失败（HTTP ${res.status}）`);
  return data;
}

export function localChannel(): PostprocessChannel {
  return {
    request: (url, init) => authFetch(url, init),
    // 与 ScannerPanel.readResults 同口径：图片去向为远端时走 previewOnly 只演算不落库，
    // 否则本机为每份卷写入 pending 回执，污染「异常卷待处理」队列与删除护栏。
    results: async sessionId => {
      const res = getScannerMode() === "remote"
        ? await authFetch(`/api/scanner/session/${sessionId}/results?previewOnly=1`)
        : await authFetch(`/api/scanner/session/${sessionId}/validate`, { method: "POST" });
      return readJson(res);
    },
    // 与原 ScannerPanel.saveSuccessful 同一端点，但只提交点名的组：整会话 POST 会把待复核卷一起入库。
    saveResults: async (sessionId, groupIds) => readJson(await authFetch(`/api/scanner/session/${sessionId}/results`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ groupIds }),
    })),
    correctionUrl: (sessionId, groupId) => `/api/scanner/session/${sessionId}/groups/${groupId}/correction`,
    imageUrl: recordId => mediaUrl(`/api/scanner/scan-image/${recordId}`),
    discardUrl: (sessionId, groupId) => `/api/scanner/session/${sessionId}/groups/${groupId}/discard`,
    retryUrl: sessionId => `/api/scanner/session/${sessionId}/retry`,
    deleteGroupsUrl: sessionId => `/api/scanner/session/${sessionId}/groups`,
  };
}

export interface SessionMeta {
  sessionId: string;
  /** 花名册联想用；本机无法确定考试归属时为 null，改考号降级为纯手输。 */
  examId: number | null;
  /** 扫描/识别当时写入会话的卡指纹。没有这份就不能补传，不能改用后来拉到的新卡。 */
  cardVersion: string | null;
  identityMode: "strict" | "legacy";
  dpi: number;
  paperSize: string;
  /** 扫描阶段写入会话的告警。跳到后处理页后扫描面板已卸载，横幅从这里读。 */
  warnings: string[];
}

/** 补传与花名册查询所需的会话元数据。 */
export async function loadSessionMeta(sessionId: string): Promise<SessionMeta> {
  const data = await readJson(await authFetch(`/api/scanner/scan/${sessionId}`));
  const session = data.session as {
    identity_mode?: "strict" | "legacy"; dpi?: number; paper_size?: string;
    card_version?: string | null; warnings_json?: unknown;
  };
  return {
    sessionId,
    examId: typeof data.examId === "number" ? data.examId : null,
    cardVersion: parseCardVersion(session.card_version),
    identityMode: session.identity_mode === "legacy" ? "legacy" : "strict",
    dpi: Number(session.dpi) || 300,
    paperSize: session.paper_size || "A4",
    warnings: parseStoredWarnings(session.warnings_json),
  };
}

function parseStoredWarnings(raw: unknown): string[] {
  const list = typeof raw === "string"
    ? (() => { try { return JSON.parse(raw) as unknown; } catch { return []; } })()
    : raw;
  return Array.isArray(list)
    ? list.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

export interface UploadMeta extends SessionMeta {
  cardId: string;
  /** 必须是 `cardFingerprint(card)` 全量指纹：上传端按它核验版本，截断的短版本一律不匹配。 */
  cardVersion: string;
}

/**
 * 异常卷处理完后的按组补传（D12）。镜像 ScannerPanel.queueSuccessfulUploads 的 pages 构造，
 * 只入队指定组。调用方负责只为**尚未上传过**的组调用（重复入队会在服务端形成同学号第二份回执，
 * 触发冲突并撤回已保存的正式成绩）。返回 job id。
 */
export function queueGroupUpload(meta: UploadMeta, sessionId: string, result: ScanBatchResult): string {
  return scannerUploadManager.startUpload({
    identityMode: meta.identityMode,
    kind: "scan",
    cardId: meta.cardId,
    name: `扫描_${result.studentId}`,
    localSessionId: sessionId,
    examId: meta.examId,
    dpi: meta.dpi,
    paperSize: meta.paperSize,
    cardVersion: meta.cardVersion,
    pages: result.pages.map(page => ({
      recordId: page.recordId,
      pageNum: page.pageNum,
      side: page.side,
      groupId: result.groupId,
      layoutPage: page.layoutPage,
      studentId: result.studentId,
      getCorrection: async () => {
        const response = await authFetch(`/api/scanner/session/${sessionId}/groups/${result.groupId}/correction`);
        if (response.status === 409) return undefined; // 旧卷没有坐标快照，只能按原识别结果上传
        if (!response.ok) throw new Error("读取已保存的填涂订正失败");
        const document = (await response.json()) as CorrectionDocument;
        return document.pages.find(p => p.sourceId === page.recordId)?.recognition;
      },
      getBlob: async () => {
        const res = await authFetch(`/api/scanner/scan-image/${page.recordId}`);
        if (!res.ok) throw new Error(`读取本机扫描图失败（HTTP ${res.status}）`);
        return res.blob();
      },
    })),
  });
}
