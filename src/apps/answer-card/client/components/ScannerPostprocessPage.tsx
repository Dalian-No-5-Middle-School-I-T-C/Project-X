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
  /** 本页亲眼见过的异常组（sid/gid）。只有它们处理完才补传：正常组在扫描完成时已被
   *  ScannerPanel 排队上传，再建一个远端会话会形成同学号第二份回执并撤回正式成绩 */
  const abnormalSeen = useRef<Set<string>>(new Set());
  /** 本页已补传过的组，防同组重复入队 */
  const queuedByPage = useRef<Set<string>>(new Set());

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
      // 记下面试异常组：这些是 ScannerPanel 当初没排上传的组，处理完才允许本页补传一次
      for (const [sid, next] of Object.entries(nextBatches)) {
        for (const failure of next.failures) abnormalSeen.current.add(`${sid}/${failure.groupId}`);
        for (const review of next.reviewCards ?? []) if (review.sessionId === sid) abnormalSeen.current.add(`${sid}/${review.groupId}`);
      }
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

  async function handleDelete(targets: Array<{ sessionId: string; groupIds: string[] }>, force: boolean) {
    if (!targets.length) { notify.error("没有选中的卷子"); return; }
    let deleted = 0;
    const blocked: string[] = [];
    // 逐会话下发：groupId 只在单个 session 内有意义，混在一起删会删掉另一批的同名组。
    // 先不带 force 问一遍服务端，遇到拦截就停下（本会话一枚页面都不删），让老师看清代价再重来。
    for (const target of targets) {
      const res = await channel.request(channel.deleteGroupsUrl(target.sessionId), {
        method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ groupIds: target.groupIds, force }),
      });
      const data = await res.json();
      if (res.status === 409) {
        blocked.push(...(data.blocked as string[] ?? []).map((groupId: string) => {
          const group = groups.find(entry => entry.sessionId === target.sessionId && entry.groupId === groupId);
          return group?.studentId ?? `组 ${groupId}`;
        }));
        break;
      }
      if (!res.ok) throw new Error(data.message || "删除失败");
      deleted += data.deletedGroups ?? target.groupIds.length;
    }
    if (blocked.length) throw Object.assign(new Error("所选卷包含已入库或待老师确认的回执"), { blocked });
    notify.success(`已删除 ${deleted} 组扫描记录`);
    await reload();
  }

  /**
   * 异常处理完一条之后的同步与补传（D12）。
   * 只补传「本页亲眼见过它异常」的组：扫描完成时正常组已由 ScannerPanel 排队上传，
   * 同考号的第二份回执到服务端会走 conflict → withdraw() 删 student_scores/question_scores
   * （撤掉已保存的正式成绩）。上传任务列表是内存态、进度卡可被关闭，不能当判据。
   */
  async function syncAfterFix(sessionId: string, groupId: string) {
    const key = `${sessionId}/${groupId}`;
    const wasAbnormal = abnormalSeen.current.has(key);
    const fresh = await reload();
    if (!isRemoteUploadOn() || !card) return;
    if (!wasAbnormal) {
      notify.info("本机已保存。该卷随本批一起上传过，改动不再重复上传；服务器成绩请走 Web 成绩修改。");
      return;
    }
    if (queuedByPage.current.has(key)) return;
    const result = fresh.batches[sessionId]?.results.find(entry => entry.groupId === groupId);
    const meta = fresh.metas[sessionId];
    if (!result || !meta) return;
    queuedByPage.current.add(key);
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
