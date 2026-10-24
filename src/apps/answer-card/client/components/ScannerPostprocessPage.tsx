import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft } from "lucide-react";
import { Badge, Button, SegmentedControl, Spinner, notify } from "./ui/v2";
import { authFetch } from "../auth/api";
import { fetchCardDetailSynced } from "../lib/scannerSync";
import { scannerUploadManager } from "../lib/scannerUploadManager";
import { forgetQueuedGroup, isGroupQueued, readPreviewDiscards, readQueuedGroups, rememberPreviewDiscard } from "../lib/scannerUploadLedger";
import { cardFingerprint } from "../../../../shared/cardVersion";
import { buildLayout } from "../../../../shared/layout";
import {
  buildPostprocessGroups, buildPostprocessQueue, matchingLayoutPageCount, observedLayoutPageCount,
  omitPreviewDiscardedGroups, type PostprocessGroup,
} from "../../../../shared/scanPostprocess";
import type { ScanBatchResponse, ScanBatchResult } from "../../../../shared/scanPages";
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
  const [localCard, setLocalCard] = useState<AnswerCard | null>(null);
  const [remoteCard, setRemoteCard] = useState<AnswerCard | null>(null);
  const card = localCard ?? remoteCard;
  const [batches, setBatches] = useState<Record<string, ScanBatchResponse>>({});
  const [metas, setMetas] = useState<Record<string, SessionMeta>>({});
  const [scans, setScans] = useState<ScanMeta[]>([]);
  const [active, setActive] = useState<PostprocessGroup | null>(null);
  const [highlight, setHighlight] = useState<SubjectiveQuestionNumber | null>(null);
  const [focusIssue, setFocusIssue] = useState<{ sessionId: string; groupId: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingAll, setSavingAll] = useState(false);
  const [error, setError] = useState("");
  /** 本页见过的异常组（sid/gid）：失败卷与冲突副本还没建过回执，订正后允许补传一次。
   *  识别成功的卷（含存疑卷）已在 reload 的首传里排队，不再建第二份回执。 */
  const abnormalKey = `projectx-postprocess-abnormal/${cardId}`;
  const abnormalSeen = useRef<Set<string>>(readIdSet(abnormalKey));
  /** 完成名单持久化；未完成上传由 manager 恢复原远端会话。 */
  const queuedByPage = useRef<Set<string>>(readQueuedGroups(cardId));

  // 通道唯一为本地（spec §5 通道裁定）：远端语义只经 queueGroupUpload 补传承担
  const channel: PostprocessChannel = useMemo(() => localChannel(), []);
  // 图片去向按调用时读取：渲染闭包里缓存的档位会在切换后失效，补传判定必须用当场值
  const isRemoteUploadOn = useCallback(() => getScannerMode() === "remote" && isRemoteServerConfigured(), []);

  /** 返回本轮拉到的快照：补传判定必须用重拉后的数据，闭包里的旧 batches 会漏掉刚处理好的组 */
  const reload = useCallback(async (): Promise<{ batches: Record<string, ScanBatchResponse>; metas: Record<string, SessionMeta>; card: AnswerCard | null }> => {
    setLoading(true);
    setError("");
    try {
      const loaded = await loadPostprocessCards(cardId);
      const display = loaded.local ?? loaded.remote;
      if (!display) throw new Error("答题卡不存在");
      const discarded = readPreviewDiscards(cardId);
      const nextBatches: Record<string, ScanBatchResponse> = {};
      const nextMetas: Record<string, SessionMeta> = {};
      for (const { sessionId } of sessions) {
        const batch = omitPreviewDiscardedGroups(await channel.results(sessionId), discarded, sessionId);
        nextBatches[sessionId] = batch;
        nextMetas[sessionId] = await loadSessionMeta(sessionId);
      }
      // 记入学号、判分成功的卷（含仍带存疑标记的）都已随批上传，存疑状态随回执返回；
      // 失败组与冲突副本还没有学号或归属，服务端无处挂这份成绩，继续留在本机处理，
      // 处理完（改考号/重识别）由下面的补传路径上传。
      for (const [sid, next] of Object.entries(nextBatches)) {
        for (const result of next.results) {
          if (result.needsReviewCount > 0) abnormalSeen.current.add(`${sid}/${result.groupId}`);
        }
        for (const failure of next.failures) {
          abnormalSeen.current.add(`${sid}/${failure.groupId}`);
          for (const copy of failure.conflicts ?? []) abnormalSeen.current.add(`${copy.sessionId}/${copy.groupId}`);
        }
        for (const review of next.reviewCards ?? []) abnormalSeen.current.add(`${review.sessionId}/${review.groupId}`);
      }
      writeIdSet(abnormalKey, abnormalSeen.current);
      const queuedNow = ensureFirstUploads(cardId, display.id, nextBatches, nextMetas, isRemoteUploadOn(), queuedByPage.current);
      if (queuedNow > 0) notify.info(queuedNow === 1 ? "已加入上传队列，图片后台续传" : `已加入上传队列（${queuedNow} 份），图片后台续传`);
      setLocalCard(loaded.local);
      setRemoteCard(loaded.remote);
      setBatches(nextBatches);
      setMetas(nextMetas);
      const scanList = await authFetch(`/api/scanner/card/${cardId}/scans`);
      if (scanList.ok) {
        const rows = (await scanList.json()) as Array<{ recordId: string; createdAt: string; scanQuality: number | null }>;
        setScans(rows.map(row => ({ recordId: row.recordId, createdAt: row.createdAt, scanQuality: row.scanQuality })));
      }
      return { batches: nextBatches, metas: nextMetas, card: display };
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
      return { batches: {}, metas: {}, card: null };
    } finally {
      setLoading(false);
    }
  }, [cardId, sessions, channel, abnormalKey, isRemoteUploadOn]);

  useEffect(() => { void reload(); }, [reload]);

  const sessionLayouts = useMemo(() => {
    const localFingerprint = localCard ? cardFingerprint(localCard) : null;
    const remoteFingerprint = remoteCard ? cardFingerprint(remoteCard) : null;
    const localPageCount = localCard ? buildLayout(localCard).pages.length : 0;
    const remotePageCount = remoteCard ? buildLayout(remoteCard).pages.length : 0;
    const map: Record<string, { pageCount: number; layoutStale: boolean }> = {};
    for (const { sessionId } of sessions) {
      map[sessionId] = matchingLayoutPageCount({
        cardVersion: metas[sessionId]?.cardVersion ?? null,
        localFingerprint, localPageCount, remoteFingerprint, remotePageCount,
        observedMaxLayoutPage: observedLayoutPageCount(batches[sessionId]),
      });
    }
    return map;
  }, [sessions, batches, metas, localCard, remoteCard]);
  const layoutStale = Object.values(sessionLayouts).some(entry => entry.layoutStale);
  const groups = useMemo(() => {
    if (!card) return [];
    return sessions.flatMap(({ sessionId }) => buildPostprocessGroups(
      batches[sessionId] ?? { results: [], failures: [] },
      sessionId,
      sessionLayouts[sessionId]?.pageCount ?? 0,
    ));
  }, [batches, sessions, sessionLayouts, card]);
  const queue = useMemo(() => buildPostprocessQueue(groups), [groups]);
  const issueGroups = useMemo(() => new Set(queue.map(item => `${item.sessionId}/${item.groupId}`)).size, [queue]);
  const uploaded = useMemo(() => Object.values(batches).flatMap(b => b.results).filter(r => r.saved).length, [batches]);

  /**
   * 仅本地模式的「保存成绩入库」：扫描完成后本页会自动接管工作台视图，
   * 原 ScannerPanel done 视图里的保存按钮不再可见，这里必须把它接回来，
   * 否则一批正常卷看起来「正常」却从未写进成绩表（validate 只演算不落库）。
   */
  async function saveAllLocal() {
    setSavingAll(true);
    try {
      let failures = 0;
      let savedGroups = 0;
      for (const { sessionId } of sessions) {
        // 存疑卷一起提交（issue #352）：低置信度只作为复核标记，不拦入库。
        // failures 里的那些没有学号或没有完整页，本来就不在 results 里，跟着提交只会写出无主成绩。
        const groupIds = (batches[sessionId]?.results ?? [])
          .filter(row => !row.saved)
          .map(row => row.groupId);
        if (!groupIds.length) continue;
        const saved = await channel.saveResults(sessionId, groupIds);
        failures += saved.failures.length;
        savedGroups += groupIds.length;
      }
      if (!savedGroups) {
        notify.info("没有待入库的试卷");
      } else {
        notify.success(failures ? `已提交 ${savedGroups} 份试卷，另有 ${failures} 份待处理` : `本批 ${savedGroups} 份试卷已写成本机正式成绩`);
      }
      await reload();
    } catch (e) {
      notify.error(e instanceof Error ? e.message : "保存成绩失败");
    } finally {
      setSavingAll(false);
    }
  }

  async function handleDelete(targets: Array<{ sessionId: string; groupIds: string[] }>, force: boolean) {
    if (!targets.length) { notify.error("没有选中的卷子"); return; }
    const uploadCardId = card?.id ?? cardId;
    for (const target of targets) {
      for (const groupId of target.groupIds) {
        const message = scannerUploadManager.localGroupDeleteBlock(uploadCardId, groupId, target.sessionId);
        if (message) { notify.error(message); return; }
      }
    }
    for (const target of targets) {
      for (const groupId of target.groupIds) {
        const gate = scannerUploadManager.releaseGroupForLocalDelete(uploadCardId, groupId, target.sessionId);
        if (!gate.ok) { notify.error(gate.message); return; }
        if (gate.forgetLedger) {
          forgetQueuedGroup(cardId, target.sessionId, groupId);
          queuedByPage.current.delete(`${target.sessionId}/${groupId}`);
        }
      }
    }
    let deleted = 0;
    let finished = false;
    const blocked: string[] = [];
    const previewOnly = isRemoteUploadOn();
    // 逐会话下发：groupId 只在单个 session 内有意义，混在一起删会删掉另一批的同名组。
    // 先不带 force 问一遍服务端，遇到拦截就停下（本会话一枚页面都不删），让老师看清代价再重来。
    try {
      for (const target of targets) {
        const res = await channel.request(channel.deleteGroupsUrl(target.sessionId), {
          method: "DELETE", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ groupIds: target.groupIds, force, ...(previewOnly ? { previewOnly: true } : {}) }),
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
      finished = true;
    } finally {
      // 前面的会话可能已经删掉，后面的 409 不能让界面还停在旧列表上。
      if (finished || deleted > 0) await reload();
    }
  }

  /**
   * 处理完一条之后重拉。首传已在 reload 里对全部识别成功的组排队（存疑卷也算）。
   * 这里只补「还没传过」的失败/冲突保留份；已经传过的组不再建第二份回执。
   */
  async function syncAfterFix(sessionId: string, groupId: string) {
    const key = `${sessionId}/${groupId}`;
    const wasAbnormal = abnormalSeen.current.has(key);
    const alreadyQueued = queuedByPage.current.has(key) || isGroupQueued(cardId, sessionId, groupId)
      || scannerUploadManager.hasGroupUpload(cardId, groupId, sessionId);
    const fresh = await reload();
    if (!isRemoteUploadOn() || !fresh.card) return;
    let batch = fresh.batches[sessionId];
    let meta = fresh.metas[sessionId];
    if (!batch || !meta) {
      try {
        batch = omitPreviewDiscardedGroups(await channel.results(sessionId), readPreviewDiscards(cardId), sessionId);
        meta = await loadSessionMeta(sessionId);
      } catch (error) {
        notify.error(error instanceof Error ? error.message : "读取保留卷失败，未能补传");
        return;
      }
    }
    const result = batch?.results.find(entry => entry.groupId === groupId);
    if (!result || !meta) {
      if (wasAbnormal) notify.error("没有找到可补传的识别结果");
      else if (alreadyQueued) notify.info("该卷已随本批上传，本机改动不再重复上传；服务器成绩请走 Web 成绩修改。");
      return;
    }
    const inPage = sessionId in fresh.batches;
    const queuedNow = queueCleanGroup(cardId, fresh.card.id, sessionId, meta, result, queuedByPage.current);
    if (queuedNow === "queued") {
      notify.info("已加入上传队列，图片后台续传");
      return;
    }
    if (queuedNow === "error") {
      notify.error("加入上传队列失败");
      return;
    }
    if (queuedNow === "missing-version" && !inPage) {
      notify.error("本机会话没有扫描时的答题卡版本，已停止补传，避免按新版面上传旧识别结果");
      return;
    }
    if (alreadyQueued) {
      // 重复上传同一份考卷会被服务端当成第二份原卷，反而撤掉已保存的成绩，
      // 所以本机改分只留本机记录，服务器侧要改请走 Web 成绩修改。
      notify.info("该卷已随本批上传，本机改动不再重复上传；服务器成绩请走 Web 成绩修改。");
    }
  }

  if (loading && !card) return <div className="flex h-[100dvh] items-center justify-center bg-background"><Spinner size={24} /></div>;
  if (!card) {
    return (
      <div className="flex h-[100dvh] flex-col items-center justify-center gap-3 bg-background px-6 text-sm text-destructive-fg">
        <p className="m-0">{error || "加载失败"}</p>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={onBack} aria-label="返回扫描" icon={<ArrowLeft size={16} />}>返回扫描</Button>
          <Button onClick={() => void reload()}>重试</Button>
        </div>
      </div>
    );
  }

  const sessionWarnings = [...new Set(Object.values(metas).flatMap(meta => meta.warnings ?? []))];
  if (layoutStale) sessionWarnings.push("答题卡已更换，缺页按本次实际扫到的页核对。");

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
      {sessionWarnings.length > 0 && (
        <div role="status" className="flex flex-col gap-2 border-b border-warning-border bg-warning-soft px-5 py-3 text-sm text-foreground">
          {sessionWarnings.map(warning => (
            <div key={warning} className="flex items-start gap-2">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <span className="min-w-0 flex-1 break-words">{warning}</span>
            </div>
          ))}
        </div>
      )}
      {view === "results" && (
        <PostprocessResultsView
          groups={groups}
          channel={channel}
          onDelete={handleDelete}
          onSaveAll={isRemoteUploadOn() ? undefined : saveAllLocal}
          saveAllBusy={savingAll}
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
      {active && (
        <div className={view === "correction" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
          <PostprocessCorrectionView
            key={`${active.sessionId}/${active.groupId}`}
            channel={channel}
            sessionId={active.sessionId}
            groupId={active.groupId}
            initialSaved={isRemoteUploadOn() ? false : active.saved}
            draftOnly={isRemoteUploadOn()}
            highlightQuestion={highlight}
            onUploadAbandoned={() => queuedByPage.current.delete(`${active.sessionId}/${active.groupId}`)}
            onSaved={() => syncAfterFix(active.sessionId, active.groupId)}
          />
        </div>
      )}
      {view === "correction" && !active && (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">先在「扫描结果」里选一张卷子</div>
      )}
      {view === "queue" && (
        <PostprocessQueueView
          queue={queue}
          channel={channel}
          examIdForSession={sessionId => metas[sessionId]?.examId ?? null}
          scans={scans}
          layoutPageCountFor={sessionId => sessionLayouts[sessionId]?.pageCount ?? 0}
          focus={focusIssue}
          onResolved={syncAfterFix}
          onPreviewDiscard={(sessionId, groupId) => rememberPreviewDiscard(cardId, sessionId, groupId)}
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

function isRemoteNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const row = error as { remoteNotFound?: boolean; status?: number };
  return row.remoteNotFound === true || row.status === 404;
}

/** 远端 404 不再挡住本机批次；其它远端错误仍交给页面上的返回和重试。 */
async function loadPostprocessCards(cardId: string): Promise<{ local: AnswerCard | null; remote: AnswerCard | null }> {
  let remote: AnswerCard | null = null;
  let local: AnswerCard | null = null;
  try {
    const synced = await fetchCardDetailSynced(cardId);
    if (synced.source === "remote") remote = synced.card as AnswerCard;
    else local = synced.card as AnswerCard;
  } catch (error) {
    if (!isRemoteNotFound(error)) throw error;
  }
  if (!local) {
    const response = await authFetch(`/api/cards/${encodeURIComponent(cardId)}`);
    if (response.ok) local = await response.json() as AnswerCard;
    else if (!remote) {
      let message = "答题卡不存在";
      try {
        const body = await response.json() as { message?: string };
        if (body.message) message = body.message;
      } catch { /* 用上面的默认文案 */ }
      throw new Error(message);
    }
  }
  return { local, remote };
}

type QueueOutcome = "queued" | "skipped" | "missing-version" | "error";

function queueCleanGroup(
  cardId: string,
  uploadCardId: string,
  sessionId: string,
  meta: SessionMeta | undefined,
  result: ScanBatchResult,
  queued: Set<string>,
): QueueOutcome {
  // 这里只服务远端补传。本机 result.saved 只说明本机考试接住了成绩，不是远端回执。
  if (!result.studentId) return "skipped";
  const key = `${sessionId}/${result.groupId}`;
  if (queued.has(key) || isGroupQueued(cardId, sessionId, result.groupId)) return "skipped";
  if (scannerUploadManager.hasGroupUpload(uploadCardId, result.groupId, sessionId)) {
    queued.add(key);
    return "skipped";
  }
  if (!meta?.cardVersion) return "missing-version";
  try {
    queueGroupUpload({ ...meta, cardId: uploadCardId, cardVersion: meta.cardVersion }, sessionId, result);
  } catch (error) {
    notify.error(error instanceof Error ? error.message : "创建或恢复上传任务失败");
    return "error";
  }
  queued.add(key);
  return "queued";
}

function ensureFirstUploads(
  cardId: string,
  uploadCardId: string,
  batches: Record<string, ScanBatchResponse>,
  metas: Record<string, SessionMeta>,
  remote: boolean,
  queued: Set<string>,
): number {
  if (!remote) return 0;
  let count = 0;
  let missingVersion = false;
  for (const [sessionId, batch] of Object.entries(batches)) {
    for (const result of batch.results) {
      const outcome = queueCleanGroup(cardId, uploadCardId, sessionId, metas[sessionId], result, queued);
      if (outcome === "queued") count += 1;
      if (outcome === "missing-version") missingVersion = true;
      if (outcome === "error") notify.error("加入上传队列失败");
    }
  }
  if (missingVersion) notify.error("本机会话没有扫描时的答题卡版本，已停止补传，避免按新版面上传旧识别结果");
  return count;
}

function readIdSet(key: string): Set<string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "[]") as unknown;
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

function writeIdSet(key: string, values: Set<string>): void {
  try { localStorage.setItem(key, JSON.stringify([...values])); } catch { /* 配额满时仍保留内存集合 */ }
}
