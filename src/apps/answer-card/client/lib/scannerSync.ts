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
      if (!res.ok) throw Object.assign(new Error(((await res.json().catch(() => ({})) as any).message) || res.statusText), { status: res.status });
      return { data: (await res.json()) as T, source: "remote" };
    } catch (e) {
      // 回退 local
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
