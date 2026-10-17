import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { scannerUploadManager } from "../lib/scannerUploadManager";

/** Keep the visible batch aligned with saved server corrections. */
export function useScannerResultRefresh(jobIds: string[]) {
  const snapshot = useSyncExternalStore(scannerUploadManager.subscribe, scannerUploadManager.getState);
  const ids = [...new Set(jobIds)].join(",");
  const busy = useRef(false);
  const pending = useRef(new Set<string>());
  const watched = useRef(new Set(jobIds));
  watched.current = new Set(jobIds);
  const seen = useRef(new Map<string, string>());
  const [error, setError] = useState("");
  const refresh = useCallback(async (requested = ids.split(",")) => {
    for (const id of requested) if (id) pending.current.add(id);
    if (busy.current) return;
    busy.current = true;
    let failure = "";
    try {
      while (pending.current.size) {
        const batch = [...pending.current].slice(0, 4);
        for (const id of batch) pending.current.delete(id);
        const settled = batch.filter(id => watched.current.has(id) && scannerUploadManager.getState().jobs.some(j => j.id === id
          && j.uploaded === j.total && (j.status === "done" || j.status === "error")));
        const outcomes = await Promise.allSettled(settled.map(id => scannerUploadManager.refreshResults(id)));
        for (const outcome of outcomes) if (outcome.status === "rejected") failure = outcome.reason instanceof Error ? outcome.reason.message : "刷新服务器成绩失败";
      }
      setError(failure);
    }
    finally { busy.current = false; }
  }, [ids]);
  const terminal = snapshot.jobs.filter(j => ids.split(",").includes(j.id)).map(j => `${j.id}:${j.status}`).join(",");
  useEffect(() => {
    const changed = snapshot.jobs.filter(j => watched.current.has(j.id) && j.uploaded === j.total
      && (j.status === "done" || j.status === "error") && seen.current.get(j.id) !== j.status);
    const timeout = window.setTimeout(() => {
      for (const job of changed) seen.current.set(job.id, job.status);
      if (changed.length) void refresh(changed.map(job => job.id));
    }, 350);
    return () => window.clearTimeout(timeout);
  }, [terminal, refresh]);
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    const timer = window.setInterval(onVisible, 30_000);
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);
  return { jobs: snapshot.jobs, error, refresh };
}
