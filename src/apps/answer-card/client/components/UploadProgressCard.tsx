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
