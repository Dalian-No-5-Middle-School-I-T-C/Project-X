import { fetchJson, remoteScannerFetch, getStoredApiKey } from "../auth/api";

function getRemoteBase(): string {
  try {
    return (localStorage.getItem("projectx_server_url") ?? "").trim().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

export type SyncSource = "remote" | "local" | "offline-cache";

async function fetchSynced<T>(path: string): Promise<{ data: T; source: SyncSource }> {
  const base = getRemoteBase();
  if (base) {
    try {
      const res = await remoteScannerFetch(path, {
        headers: getStoredApiKey() ? { "X-Api-Key": getStoredApiKey()! } : undefined,
      });
      if (!res.ok) {
        const status = res.status;
        // 401/403 鉴权失败不静默回退，需显式暴露，避免 401 假绿回退本地库
        if (status === 401 || status === 403) {
          let msg = res.statusText;
          try { const body = (await res.clone().json()) as any; msg = body?.message || body?.error || msg; } catch {}
          throw Object.assign(new Error(msg), { status, remoteAuthFailed: true });
        }
        throw Object.assign(new Error(((await res.json().catch(() => ({})) as any).message) || res.statusText), { status });
      }
      return { data: (await res.json()) as T, source: "remote" };
    } catch (e: any) {
      // 鉴权失败向上透出，不回退；网络/其他错误才回退本地
      if (e?.remoteAuthFailed || e?.status === 401 || e?.status === 403) throw e;
    }
  }
  const data = await fetchJson<T>(path);
  return { data, source: base ? "offline-cache" : "local" };
}

export const fetchCardsSynced = () => fetchSynced<any[]>("/api/cards?limit=500");
export const fetchCardByIdSynced = async (id: string) => (await fetchSynced<any>(`/api/cards/${encodeURIComponent(id)}`)).data;
export const fetchExamGroupsSynced = () => fetchSynced<any[]>("/api/exam-groups").then((r) => r.data);
export const fetchExamsSynced = () => fetchSynced<any[]>("/api/exams?limit=200").then((r) => r.data);
export const fetchGradesSynced = async () => {
  try {
    return (await fetchSynced<any[]>("/api/classes/grades")).data;
  } catch {
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
