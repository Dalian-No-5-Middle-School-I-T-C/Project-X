import { fetchJson, remoteScannerFetch, getStoredApiKey, authFetch } from "../auth/api";
import { SERVER_URL_KEY } from "./scannerMode";

function getRemoteBase(): string {
  try {
    return (localStorage.getItem(SERVER_URL_KEY) ?? "").trim().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

export type SyncSource = "remote" | "local" | "offline-cache";

const REMOTE_SYNC_PREFIX = "/api/scanner/sync";

function toRemotePath(localPath: string): string {
  // local /api/cards?limit=500 -> remote /api/scanner/sync/cards?limit=500
  // local /api/cards/:id -> remote /api/scanner/sync/cards/:id
  // local /api/exam-groups -> remote /api/scanner/sync/exam-groups
  // local /api/classes/grades -> remote /api/scanner/sync/classes/grades
  if (localPath.startsWith("/api/cards")) return localPath.replace("/api/cards", `${REMOTE_SYNC_PREFIX}/cards`);
  if (localPath.startsWith("/api/exam-groups")) return localPath.replace("/api/exam-groups", `${REMOTE_SYNC_PREFIX}/exam-groups`);
  if (localPath.startsWith("/api/classes/grades")) return localPath.replace("/api/classes/grades", `${REMOTE_SYNC_PREFIX}/classes/grades`);
  if (localPath.startsWith("/api/exams")) return localPath.replace("/api/exams", `${REMOTE_SYNC_PREFIX}/exams`);
  return `${REMOTE_SYNC_PREFIX}${localPath}`;
}

async function fetchSynced<T>(localPath: string): Promise<{ data: T; source: SyncSource }> {
  const base = getRemoteBase();
  if (base) {
    const remotePath = toRemotePath(localPath);
    try {
      const res = await remoteScannerFetch(remotePath, {
        headers: getStoredApiKey() ? { "X-Api-Key": getStoredApiKey()! } : undefined,
      });
      if (!res.ok) {
        const status = res.status;
        let msg = res.statusText;
        try { const body = (await res.clone().json()) as any; msg = body?.message || body?.error || msg; } catch {}
        // 401/403 鉴权失败不回退；404 权威删除不回退；网络/5xx 才回退
        if (status === 401 || status === 403) {
          throw Object.assign(new Error(msg), { status, remoteAuthFailed: true });
        }
        if (status === 404) {
          throw Object.assign(new Error(msg), { status, remoteNotFound: true });
        }
        throw Object.assign(new Error(msg), { status });
      }
      return { data: (await res.json()) as T, source: "remote" };
    } catch (e: any) {
      if (e?.remoteAuthFailed || e?.remoteNotFound || e?.status === 401 || e?.status === 403 || e?.status === 404) throw e;
      // 安全（R32）：跨机明文被闸门拦下是**配置错误**，不是网络抖动。
      // 静默回退本机会让老师看到「卡列表出来了」而以为同步正常，比直接报错更难查。
      if (e?.code === "INSECURE_REMOTE_TRANSPORT_BLOCKED" || e?.code === "SERVER_URL_UNPARSABLE") throw e;
      // 网络错误 / 5xx / 超时 -> 静默回退本地
    }
  }
  const data = await fetchJson<T>(localPath);
  return { data, source: base ? "offline-cache" : "local" };
}

export const fetchCardsSynced = () => fetchSynced<any[]>("/api/cards?limit=500");

export interface SyncedCardDetail {
  card: any;
  source: SyncSource;
  /** 安全 R35：远端已配置但没连上，这份卡来自本机缓存，可能已经过期。 */
  stale: boolean;
}

/**
 * 安全 R35：卡详情**必须**把来源交出去。
 * 此前 `fetchCardByIdSynced` 直接丢掉 source，网络掉线/5xx 时会静默返回本机缓存的旧卡，
 * 选择页照旧进入工作区、按旧布局和旧答案判分——服务器改了卡也没人知道。
 * 现在调用方必须自己决定：stale 时要么停下，要么让老师显式确认离线继续。
 */
export async function fetchCardDetailSynced(id: string): Promise<SyncedCardDetail> {
  const { data, source } = await fetchSynced<any>(`/api/cards/${encodeURIComponent(id)}`);
  return { card: data, source, stale: source === "offline-cache" };
}

/**
 * 选中卡片时把完整卡 upsert 进本机库（幂等，保留原 id）。
 * 直扫/阅卷只读本机 127.0.0.1 内嵌服务（PUT /api/cards/:id 已支持不存在时创建），
 * 因此远端新建的卡必须先进本机库才能真的「可直接扫描」。
 */
export async function importCardLocally(card: { id: string }): Promise<void> {
  const res = await authFetch(`/api/cards/${encodeURIComponent(card.id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(card),
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { message?: string; error?: string };
      message = body?.message || body?.error || message;
    } catch { /* keep statusText */ }
    throw Object.assign(new Error(message || "导入答题卡到本机失败"), { status: res.status });
  }
}
export const fetchExamGroupsSynced = () => fetchSynced<any[]>("/api/exam-groups").then((r) => r.data);
export const fetchExamsSynced = () => fetchSynced<any[]>("/api/exams?limit=200").then((r) => r.data);
export const fetchGradesSynced = async () => {
  try {
    return (await fetchSynced<any[]>("/api/classes/grades")).data;
  } catch (e: any) {
    if (e?.status === 401 || e?.status === 403 || e?.remoteAuthFailed) throw e;
    if (e?.status === 404) {
      // 服务端未启用同步面/旧版服务器：回退本机年级列表
      try { return await fetchJson<any[]>("/api/classes/grades"); } catch { /* fall through */ }
    }
    return [];
  }
};

export const fetchExamGroupDetailSynced = (id: number | string) =>
  fetchSynced<any>(`/api/exam-groups/${encodeURIComponent(String(id))}`).then((r) => r.data);

export function startPolling(opts: { intervalMs?: number; onUpdate: () => void }): () => void {
  const ms = opts.intervalMs ?? 30000;
  const id = setInterval(opts.onUpdate, ms);
  const onVis = () => {
    if (!document.hidden) opts.onUpdate();
  };
  document.addEventListener("visibilitychange", onVis);
  return () => {
    clearInterval(id);
    document.removeEventListener("visibilitychange", onVis);
  };
}
