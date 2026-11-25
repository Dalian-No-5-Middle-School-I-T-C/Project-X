import { CardCorrectionButton } from "./CardCorrectionEditor";
import { useEffect, useState, useSyncExternalStore } from "react";
import { CheckCircle2, ChevronDown, ChevronUp, CloudUpload, PauseCircle, RefreshCw, X, XCircle } from "lucide-react";
import { Button, Input, Progress, Spinner } from "./ui/v2";
import { ScanPreviewModal, type ScanPage } from "./ScanPreviewModal";
import { scannerUploadManager } from "../lib/scannerUploadManager";
import type { UploadJobSnapshot } from "../lib/scannerUploadManager";
import { ServerStatusIndicator } from "./ServerStatusIndicator";
import { uniqueScanConflictCards, type ScanConflictCard } from "../../../../shared/scanPages";
import { ScannerConflictCards } from "./ScannerConflictCards";

const DONE_AUTO_HIDE_MS = 3_000;

const BORDER_BY_STATUS: Record<UploadJobSnapshot["status"], string> = {
  queued: "border-border-subtle",
  creating: "border-info-border",
  uploading: "border-info-border",
  completing: "border-info-border",
  paused: "border-warning-border",
  done: "border-success-border",
  error: "border-destructive-border",
  cancelled: "border-border-subtle",
};

export function UploadProgressCard() {
  const snap = useSyncExternalStore(scannerUploadManager.subscribe, scannerUploadManager.getState);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [entered, setEntered] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // done 任务 3 秒后自动收起
  useEffect(() => {
    const doneIds = snap.jobs.filter((j) => j.status === "done" && !j.reviewCards?.length).map((j) => j.id);
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

  const visible = snap.jobs.filter((j) => !dismissed.has(j.id) || j.status === "error" || Boolean(j.reviewCards?.length));
  if (visible.length === 0) return null;

  const counts = { active: 0, queued: 0, paused: 0, error: 0, done: 0, cancelled: 0 };
  for (const { status } of visible) {
    if (status === "creating" || status === "uploading" || status === "completing") counts.active++;
    else counts[status]++;
  }
  const pendingCount = counts.queued + counts.paused;
  const summary = [
    counts.active > 0 && `上传中 ${counts.active}`,
    counts.queued > 0 && `排队 ${counts.queued}`,
    counts.paused > 0 && `已暂停 ${counts.paused}`,
    counts.error > 0 && `失败 ${counts.error}`,
    counts.done > 0 && `已完成 ${counts.done}`,
    counts.cancelled > 0 && `已取消 ${counts.cancelled}`,
  ].filter(Boolean).join(" · ");
  const seen = new Set<string>();
  const conflictCards = new Map((collapsed ? [] : visible).map(job => [job.id, uniqueScanConflictCards([
    ...(job.reviewCards ?? []), ...(job.failures ?? []).flatMap(f => f.conflicts ?? []),
  ]).filter(card => {
    const key = JSON.stringify([card.sessionId, card.groupId]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  })]));

  return (
    <section
      aria-label="上传任务"
      className={`fixed right-[var(--px-scanner-upload-right,1rem)] bottom-[var(--px-scanner-upload-bottom,3.75rem)] z-(--px-z-sticky) flex max-w-[calc(100vw-2rem)] flex-col overflow-hidden transition-[transform,opacity] duration-200 ${
        entered ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0"
      } ${
        collapsed
          ? "w-auto rounded-full shadow-1"
          : "max-h-[min(60vh,calc(100vh_-_var(--px-scanner-upload-bottom,3.75rem)_-_12rem))] w-80 rounded-lg border border-border bg-card shadow-2"
      }`}
    >
      <div className={`flex shrink-0 items-center gap-2 ${collapsed ? "" : "justify-between px-2 pt-2"}`}>
        {!collapsed && <ServerStatusIndicator />}
        <Button
          variant="outline"
          size="sm"
          type="button"
          aria-expanded={!collapsed}
          aria-label={collapsed ? `展开上传（${visible.length}） · ${summary}` : undefined}
          title={collapsed ? summary : undefined}
          className={`h-7 max-w-full px-2 text-xs ${collapsed ? "min-w-0 shrink rounded-full" : ""}`}
          icon={collapsed ? <ChevronUp className="size-3.5" aria-hidden /> : <ChevronDown className="size-3.5" aria-hidden />}
          onClick={() => setCollapsed(value => !value)}
        >
          {collapsed ? <span className="truncate tabular-nums">{summary}</span> : "收起上传"}
        </Button>
      </div>
      {!collapsed && (
        <>
          {(counts.error > 0 || pendingCount > 0) && (
            <div className="flex shrink-0 flex-wrap justify-end gap-1.5 px-2 pt-2">
              {counts.error > 0 && (
                <Button variant="outline" size="sm" type="button" className="h-7 px-2 text-xs"
                  onClick={() => scannerUploadManager.dismissTerminalJobs("error")}>
                  清空失败（{counts.error}）
                </Button>
              )}
              {pendingCount > 0 && (
                <Button variant="outline" size="sm" type="button" className="h-7 px-2 text-xs"
                  onClick={() => scannerUploadManager.cancelPendingJobs()}>
                  取消排队（{pendingCount}）
                </Button>
              )}
            </div>
          )}
          <div role="region" aria-label="上传任务列表" tabIndex={0} className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
            {visible.map((job) => (
              <UploadJobCard
                key={job.id}
                job={job}
                conflictCards={conflictCards.get(job.id) ?? []}
                queuedCount={snap.queuedCount}
                onDismiss={scannerUploadManager.dismissJob}
              />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function UploadJobCard({
  job,
  conflictCards,
  queuedCount,
  onDismiss,
}: {
  job: UploadJobSnapshot;
  conflictCards: ScanConflictCard[];
  queuedCount: number;
  onDismiss: (id: string) => void;
}) {
  const [studentId, setStudentId] = useState("");
  const [actionError, setActionError] = useState("");
  const [preview, setPreview] = useState<ScanPage[]>([]);
  useEffect(() => () => { for (const page of preview) URL.revokeObjectURL(page.imageUrl); }, [preview]);
  const kindLabel = job.kind === "scan" ? "直扫上传" : "导入上传";
  const pct = job.total === 0 ? 0 : Math.round((job.uploaded / job.total) * 100);
  const busy = job.status === "creating" || job.status === "uploading" || job.status === "completing";

  return (
    <div className={`shrink-0 rounded-lg border bg-card p-3 shadow-md ${BORDER_BY_STATUS[job.status]}`}>
      <div className="flex items-center gap-2">
        <CloudUpload size={15} className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {kindLabel} · {job.name}
        </span>
        {(job.status === "cancelled" || job.status === "done" || job.status === "error") && (
          <Button variant="ghost" size="icon-sm" aria-label="关闭" onClick={() => onDismiss(job.id)}>
            <X size={14} />
          </Button>
        )}
      </div>

      {conflictCards.length > 0 && <ScannerConflictCards cards={conflictCards} remote remoteSessionId={job.remoteSessionId ?? null} examId={job.examId ?? null}
        request={(url, init) => scannerUploadManager.requestJob(job.id, url, init)}
        saveSession={(sessionId, groupId) => scannerUploadManager.saveSession(job.id, sessionId, groupId)}
        onChanged={sessionId => scannerUploadManager.refreshResults(job.id, [sessionId])} />}

      {job.notice && (
        <p className="mt-2 break-words rounded-md bg-warning-soft px-2 py-1.5 text-xs text-warning-foreground">{job.notice}</p>
      )}

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
          <Button variant="ghost" size="sm" onClick={() => scannerUploadManager.cancelJob(job.id)}>
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
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 text-destructive-fg"
            icon={<X size={12} />}
            onClick={() => scannerUploadManager.cancelJob(job.id)}
          >
            取消
          </Button>
        </div>
      )}

      {job.status === "cancelled" && (
        <p className="mt-2 flex items-center gap-1.5 rounded-md bg-muted px-2 py-1.5 text-xs text-muted-foreground">
          <X size={13} className="shrink-0" />
          <span className="min-w-0 break-words">任务已取消</span>
        </p>
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
          {job.failures?.map(failure => <div key={failure.groupId} className="mt-2">
            <p>{failure.studentId}：{failure.message}</p>
            {job.remoteSessionId && <CardCorrectionButton
              url={`/api/scanner/upload/sessions/${encodeURIComponent(job.remoteSessionId)}/groups/${encodeURIComponent(failure.groupId)}/correction`}
              request={(url, init) => scannerUploadManager.requestJob(job.id, url, init)}
              onSaved={() => scannerUploadManager.refreshResults(job.id)} /> }
          </div>)}
          <div className="mt-1.5">
            {job.failedPages.length > 0 && <div className="mb-2 flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => {
                void scannerUploadManager.getFailedPageBlobs(job.id).then(pages => {
                  setPreview(pages.map(page => ({ recordId: page.recordId, pageNum: page.pageNum, side: page.side, imageUrl: URL.createObjectURL(page.blob) })));
                }).catch(error => setActionError(String(error.message)));
              }}>查看失败原卷</Button>
              {job.canCorrectStudentId && <>
                <Input aria-label="订正上传卷学号" placeholder="核对原卷后输入学号" value={studentId} onChange={event => setStudentId(event.target.value)} />
                <Button variant="outline" size="sm" disabled={!studentId.trim()} onClick={() => {
                  try { scannerUploadManager.correctStudentId(job.id, studentId.trim()); setActionError(""); }
                  catch (error) { setActionError(error instanceof Error ? error.message : "订正失败"); }
                }}>订正学号并重试</Button>
              </>}
            </div>}
            {actionError && <p role="alert">{actionError}</p>}
            <Button
              variant="outline"
              size="sm"
              icon={<RefreshCw size={12} />}
              onClick={() => scannerUploadManager.retryFailed(job.id)}
            >
              {job.failedPages.length ? "重试失败页" : "重试保存"}
            </Button>
          </div>
        </div>
      )}
      {preview.length > 0 && <ScanPreviewModal title="上传失败原卷" pages={preview} onClose={() => setPreview([])} />}
    </div>
  );
}
