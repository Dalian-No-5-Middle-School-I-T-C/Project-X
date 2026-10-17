import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Badge, Button, SegmentedControl, Spinner, notify } from "./ui/v2";
import { authFetch } from "../auth/api";
import { fetchCardDetailSynced } from "../lib/scannerSync";
import { cardFingerprint } from "../../../../shared/cardVersion";
import { buildLayout } from "../../../../shared/layout";
import { buildPostprocessGroups, buildPostprocessQueue, type PostprocessGroup } from "../../../../shared/scanPostprocess";
import type { ScanBatchResponse } from "../../../../shared/scanPages";
import type { AnswerCard, SubjectiveQuestionNumber } from "../../../../shared/types";
import { localChannel, loadSessionMeta, queueGroupUpload, type PostprocessChannel, type SessionMeta } from "./scanner-postprocess/postprocessChannel";
import { PostprocessResultsView } from "./scanner-postprocess/PostprocessResultsView";
import { PostprocessCorrectionView } from "./scanner-postprocess/PostprocessCorrectionView";
import { PostprocessQueueView, type ScanMeta } from "./scanner-postprocess/PostprocessQueueView";
import { getScannerMode, isRemoteServerConfigured } from "../lib/scannerMode";
import { scannerUploadManager } from "../lib/scannerUploadManager";

type View = "results" | "correction" | "queue";

export interface ScannerPostprocessPageProps {
  cardId: string;
  cardTitle: string;
  sessions: Array<{ sessionId: string; pageCount: number }>;
  onBack: () => void;
}

export function ScannerPostprocessPage({ cardId, cardTitle, sessions, onBack }: ScannerPostprocessPageProps) {
  const [view, setView] = useState<View>("results");
  const [card, setCard] = useState<AnswerCard | null>(null);
  const [batches, setBatches] = useState<Record<string, ScanBatchResponse>>({});
  const [metas, setMetas] = useState<Record<string, SessionMeta>>({});
  const [scans, setScans] = useState<ScanMeta[]>([]);
  const [active, setActive] = useState<PostprocessGroup | null>(null);
  const [highlight, setHighlight] = useState<SubjectiveQuestionNumber | null>(null);
  const [focusIssue, setFocusIssue] = useState<{ sessionId: string; groupId: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  /** 已有上传任务或已入库的组：补传护栏基线，绝不重复建会话 */
  const uploadedGroups = useRef<Set<string>>(new Set());

  // 通道唯一为本地（spec §5 通道裁定）：远端语义只经 queueGroupUpload 补传承担
  const channel: PostprocessChannel = useMemo(() => localChannel(), []);
  // 图片去向按调用时读取：渲染闭包里缓存的档位会在切换后失效，补传判定必须用当场值
  const isRemoteUploadOn = useCallback(() => getScannerMode() === "remote" && isRemoteServerConfigured(), []);

  /** 返回本轮拉到的快照：补传判定必须用重拉后的数据，闭包里的旧 batches 会漏掉刚处理好的组 */
  const reload = useCallback(async (): Promise<{ batches: Record<string, ScanBatchResponse>; metas: Record<string, SessionMeta> }> => {
    setLoading(true);
    setError("");
    try {
      const { card: loaded } = await fetchCardDetailSynced(cardId);
      if (!loaded) throw new Error("答题卡不存在");
      setCard(loaded as AnswerCard);
      const nextBatches: Record<string, ScanBatchResponse> = {};
      const nextMetas: Record<string, SessionMeta> = {};
      for (const { sessionId } of sessions) {
        nextBatches[sessionId] = await channel.results(sessionId);
        nextMetas[sessionId] = await loadSessionMeta(sessionId);
      }
      setBatches(nextBatches);
      setMetas(nextMetas);
      // 基线必须在 setBatches 之后同轮刷新：续扫第二批时旧基线会误判成「未上传」而重复建会话
      const covered = new Set<string>();
      for (const job of scannerUploadManager.getState().jobs) {
        if (job.cardId !== cardId) continue;
        for (const groupId of job.groupIds) covered.add(groupId);
      }
      for (const batch of Object.values(nextBatches)) for (const result of batch.results) if (result.saved) covered.add(result.groupId);
      uploadedGroups.current = covered;
      const scanList = await authFetch(`/api/scanner/card/${cardId}/scans`);
      if (scanList.ok) {
        const rows = (await scanList.json()) as Array<{ recordId: string; createdAt: string; scanQuality: number | null }>;
        setScans(rows.map(row => ({ recordId: row.recordId, createdAt: row.createdAt, scanQuality: row.scanQuality })));
      }
      return { batches: nextBatches, metas: nextMetas };
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
      return { batches: {}, metas: {} };
    } finally {
      setLoading(false);
    }
  }, [cardId, sessions, channel]);

  useEffect(() => { void reload(); }, [reload]);

  const layoutPageCount = card ? buildLayout(card).pages.length : 0;
  const groups = useMemo(() => {
    if (!card) return [];
    return sessions.flatMap(({ sessionId }) => buildPostprocessGroups(batches[sessionId] ?? { results: [], failures: [] }, sessionId, layoutPageCount));
  }, [batches, sessions, layoutPageCount, card]);
  const queue = useMemo(() => buildPostprocessQueue(groups), [groups]);
  const issueGroups = useMemo(() => new Set(queue.map(item => `${item.sessionId}/${item.groupId}`)).size, [queue]);
  const uploaded = useMemo(() => Object.values(batches).flatMap(b => b.results).filter(r => r.saved).length, [batches]);
  const examId = useMemo(() => Object.values(metas).find(meta => meta.examId !== null)?.examId ?? null, [metas]);

  async function handleDelete(groupIds: string[], force: boolean) {
    const sessionId = sessions[sessions.length - 1]?.sessionId;
    if (!sessionId) { notify.error("没有可删除的扫描会话"); return; }
    const res = await channel.request(channel.deleteGroupsUrl(sessionId), {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ groupIds, force }),
    });
    const data = await res.json();
    if (res.status === 409) throw Object.assign(new Error(data.message || "存在已上传回执"), { blocked: data.blocked ?? [] });
    if (!res.ok) throw new Error(data.message || "删除失败");
    notify.success(`已删除 ${data.deletedGroups ?? groupIds.length} 组扫描记录`);
    await reload();
  }

  /**
   * 异常处理完一条之后的同步与补传（D12）。判定顺序不可调换：
   * 本地模式不上传 → 同组已有任务则复用（失败页 retryFailed）→ 加载时已上传/已入库则不动
   * （同考号第二份回执到服务端会 conflict → withdraw() 撤掉已保存的正式成绩）→ 其余首传。
   */
  async function syncAfterFix(sessionId: string, groupId: string) {
    const wasUploaded = uploadedGroups.current.has(groupId);
    const job = scannerUploadManager.getState().jobs.find(entry => entry.cardId === cardId && entry.groupIds.includes(groupId));
    const fresh = await reload();
    if (!isRemoteUploadOn() || !card) return;
    if (job) {
      if (job.status === "error" && job.failedPages.length > 0) {
        scannerUploadManager.retryFailed(job.id);
        notify.info("已按原上传任务重试失败页，不新建会话");
      } else {
        notify.info("该卷已有上传任务，进度见右上角上传卡");
      }
      return;
    }
    if (wasUploaded) {
      notify.info("该卷已上传入库；服务器成绩请走 Web 成绩修改，本机改动仅作留档");
      return;
    }
    const result = fresh.batches[sessionId]?.results.find(entry => entry.groupId === groupId);
    const meta = fresh.metas[sessionId];
    if (!result || !meta) return;
    uploadedGroups.current.add(groupId);
    queueGroupUpload({ ...meta, cardId: card.id, cardVersion: cardFingerprint(card) }, sessionId, result);
    notify.info("已加入上传队列，图片后台续传");
  }

  if (loading && !card) return <div className="flex h-[100dvh] items-center justify-center bg-background"><Spinner size={24} /></div>;
  if (!card) return <div className="flex h-[100dvh] items-center justify-center bg-background text-sm text-destructive-fg">{error || "加载失败"}</div>;

  return (
    <main className="flex h-[100dvh] min-w-0 flex-col overflow-hidden bg-background">
      <header className="flex h-page-header shrink-0 items-center gap-3 border-b border-border-subtle bg-card px-5">
        <Button variant="ghost" size="icon-sm" onClick={onBack} aria-label="返回扫描"><ArrowLeft size={18} /></Button>
        <div className="flex min-w-0 flex-1 flex-col">
          <strong className="truncate text-base font-semibold">{cardTitle} · 扫描后处理</strong>
          <span className="truncate text-xs tabular-nums text-muted-foreground">
            已扫 {groups.length} 组 · 正常 {groups.length - issueGroups} · 异常 {issueGroups} · 已入库 {uploaded}
          </span>
        </div>
        <SegmentedControl
          aria-label="后处理视图"
          value={view}
          onValueChange={setView}
          items={[
            { value: "results", label: "扫描结果" },
            { value: "correction", label: "卡查看与改分" },
            { value: "queue", label: <span className="flex items-center gap-1.5">异常处理{queue.length > 0 && <Badge tone="danger" className="h-[18px] px-1.5 text-[10.5px] tabular-nums">{queue.length}</Badge>}</span> },
          ]}
        />
      </header>
      {view === "results" && (
        <PostprocessResultsView
          groups={groups}
          channel={channel}
          onDelete={handleDelete}
          onOpen={group => {
            setActive(group);
            if (group.issues.length) {
              setFocusIssue({ sessionId: group.sessionId, groupId: group.groupId });
              setView("queue");
            } else {
              setView("correction");
            }
          }}
        />
      )}
      {view === "correction" && active && (
        <PostprocessCorrectionView
          channel={channel}
          sessionId={active.sessionId}
          groupId={active.groupId}
          highlightQuestion={highlight}
          onSaved={() => syncAfterFix(active.sessionId, active.groupId)}
        />
      )}
      {view === "correction" && !active && (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">先在「扫描结果」里选一张卷子</div>
      )}
      {view === "queue" && (
        <PostprocessQueueView
          queue={queue}
          channel={channel}
          examId={examId}
          scans={scans}
          layoutPageCount={layoutPageCount}
          focus={focusIssue}
          onResolved={syncAfterFix}
          onDelete={handleDelete}
          onJumpToCorrection={(sessionId, groupId, questionNumber) => {
            const group = groups.find(entry => entry.sessionId === sessionId && entry.groupId === groupId) ?? null;
            setActive(group);
            setHighlight(questionNumber ?? null);
            setView("correction");
          }}
        />
      )}
    </main>
  );
}
