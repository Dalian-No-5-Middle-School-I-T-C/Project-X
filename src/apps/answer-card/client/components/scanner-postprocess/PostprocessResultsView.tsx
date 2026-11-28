import { useEffect, useMemo, useRef, useState } from "react";
import { Check, CheckSquare, Database, ImageOff, RefreshCw, Search, Trash2 } from "lucide-react";
import {
  Badge, Button, Checkbox, ConfirmDialog, EmptyState, Input, SegmentedControl, Tip,
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableWrap,
} from "../ui/v2";
import { groupPostprocessBySession, type PostprocessGroup } from "../../../../../shared/scanPostprocess";
import type { PostprocessChannel } from "./postprocessChannel";

type Filter = "all" | "normal" | "issue";
type Layout = "grid" | "list";

export interface DeleteTarget { sessionId: string; groupIds: string[] }

export interface PostprocessRetryResult { ok: number; failed: number; messages: string[] }

export interface PostprocessResultsViewProps {
  groups: PostprocessGroup[];
  channel: PostprocessChannel;
  /** 会话列表的输入顺序就是扫描批次顺序；空批次也从这里发现。 */
  sessions: ReadonlyArray<{ sessionId: string }>;
  /** 远端模式把「已上传」与「待确认 / 待上传」分开显示，避免把本机结果当成服务器成绩。 */
  remote?: boolean;
  /** 删除按会话分组下发：groupId 只在单个 session 内有意义，续扫后两批会出现同名组 */
  onDelete: (targets: DeleteTarget[], force: boolean) => Promise<void>;
  /** 删除没有扫描卡的会话行；只做清理，不动仍然有卷的批次。 */
  onDeleteSession: (sessionId: string) => Promise<void>;
  /** 批量重新识别选中的异常卷；返回每组结果，界面据此汇总。 */
  onRetryGroups?: (targets: DeleteTarget[]) => Promise<PostprocessRetryResult>;
  onOpen: (group: PostprocessGroup) => void;
  /** 本地写入正式成绩；远端只用于老师主动上传取消批次中保留的正常卷。 */
  onSaveAll?: () => Promise<void>;
  saveAllBusy?: boolean;
  /** 远端取消批次使用「加入上传队列」，不能沿用「入库」文案。 */
  saveAllLabel?: string;
  saveAllTip?: string;
  saveAllCount?: number;
}

/** issues 按 duplicate → student_id → missing_page → low_confidence → other 有序，取首条定性。 */
function statusOf(group: PostprocessGroup, remote: boolean): { tone: "success" | "warning" | "danger"; label: string } {
  switch (group.issues[0]) {
    case "duplicate": return { tone: "danger", label: "考号重复" };
    case "student_id": return { tone: "danger", label: "考号未识别" };
    case "missing_page": return { tone: "danger", label: "缺页" };
    case "low_confidence":
      if (!remote) return { tone: "warning", label: `${group.needsReviewCount} 题存疑` };
      return group.saved
        ? { tone: "warning", label: `已上传 · ${group.needsReviewCount} 题存疑` }
        : { tone: "warning", label: `待确认 · ${group.needsReviewCount} 题` };
    case "other": return { tone: "danger", label: "处理失败" };
    default:
      if (!remote) return { tone: "success", label: group.saved ? "已入库" : "正常" };
      return { tone: group.saved ? "success" : "warning", label: group.saved ? "已上传" : "待上传" };
  }
}

export function PostprocessResultsView({
  groups, channel, sessions, remote = false, onDelete, onDeleteSession, onRetryGroups, onOpen,
  onSaveAll, saveAllBusy = false, saveAllLabel = "保存成绩入库", saveAllTip, saveAllCount,
}: PostprocessResultsViewProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [layout, setLayout] = useState<Layout>("grid");
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingTargets, setPendingTargets] = useState<DeleteTarget[] | null>(null);
  const [blockedNotice, setBlockedNotice] = useState<string[] | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [clearingEmpty, setClearingEmpty] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryNotice, setRetryNotice] = useState<string | null>(null);
  /** Shift 连选的起点：只在当前可见列表里找区间。 */
  const anchorRef = useRef<string | null>(null);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return groups
      .filter(g => (filter === "all" ? true : filter === "normal" ? g.issues.length === 0 : g.issues.length > 0))
      .filter(g => !q || (g.studentId ?? "").toLowerCase().includes(q));
  }, [groups, query, filter]);
  const sessionOrder = useMemo(() => sessions.map(session => session.sessionId), [sessions]);
  const sections = useMemo(() => groupPostprocessBySession(visible, sessionOrder), [visible, sessionOrder]);
  const visibleKeys = useMemo(() => visible.map(group => `${group.sessionId}/${group.groupId}`), [visible]);
  const visibleKeySignature = visibleKeys.join("\n");

  // 筛选或搜索变化后，旧勾选可能已经不可见；保留它们会让删除盲删看不见的卡。
  useEffect(() => {
    const allowed = new Set(visibleKeys);
    setSelected(current => {
      let changed = false;
      const next = new Set<string>();
      for (const key of current) {
        if (allowed.has(key)) next.add(key);
        else changed = true;
      }
      return changed ? next : current;
    });
    if (anchorRef.current && !allowed.has(anchorRef.current)) anchorRef.current = null;
  }, [visibleKeySignature, visibleKeys]);

  const issueCount = groups.filter(g => g.issues.length > 0).length;
  // 正常但未入库的份数：这就是「保存成绩入库」要写的对象（异常卷保存会被服务端拒）
  const unsavedNormal = groups.filter(g => !g.issues.length && !g.saved).length;
  const pendingSaveCount = saveAllCount ?? unsavedNormal;
  const emptySessions = sessions.filter(session => !groups.some(group => group.sessionId === session.sessionId));
  const groupKey = (group: PostprocessGroup) => `${group.sessionId}/${group.groupId}`;
  const selectedGroups = groups.filter(group => selected.has(groupKey(group)));
  const selectedIssueGroups = selectedGroups.filter(group => group.issues.length > 0);
  const stopSelecting = () => { setSelecting(false); setSelected(new Set()); anchorRef.current = null; };
  const allVisibleSelected = visible.length > 0 && visible.every(group => selected.has(groupKey(group)));

  function toggle(group: PostprocessGroup) {
    const key = groupKey(group);
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
    anchorRef.current = key;
  }

  function extendTo(group: PostprocessGroup) {
    const key = groupKey(group);
    const anchor = anchorRef.current;
    const start = anchor ? visibleKeys.indexOf(anchor) : -1;
    const end = visibleKeys.indexOf(key);
    if (start < 0 || end < 0) { toggle(group); return; }
    const [from, to] = start <= end ? [start, end] : [end, start];
    setSelected(prev => {
      const next = new Set(prev);
      for (let index = from; index <= to; index += 1) next.add(visibleKeys[index]);
      return next;
    });
  }

  function handleGroupClick(group: PostprocessGroup, event?: { shiftKey?: boolean }) {
    if (!selecting) { onOpen(group); return; }
    if (event?.shiftKey && anchorRef.current) extendTo(group);
    else toggle(group);
  }

  function selectAllVisible() {
    setSelected(prev => {
      const next = new Set(prev);
      for (const key of visibleKeys) next.add(key);
      return next;
    });
  }

  function invertVisible() {
    setSelected(prev => {
      const next = new Set(prev);
      for (const key of visibleKeys) {
        if (next.has(key)) next.delete(key); else next.add(key);
      }
      return next;
    });
  }

  /** 选中的组按所属会话归组下发，避免第二批的同名组被误删 */
  function selectedTargets(): DeleteTarget[] {
    const bySession = new Map<string, string[]>();
    for (const group of groups) {
      if (!selected.has(groupKey(group))) continue;
      bySession.set(group.sessionId, [...(bySession.get(group.sessionId) ?? []), group.groupId]);
    }
    return [...bySession].map(([sessionId, groupIds]) => ({ sessionId, groupIds }));
  }

  function askDeleteSelected() {
    const targets = selectedTargets();
    if (!targets.length) { setDeleteError("没有选中的卷子"); return; }
    setDeleteError(null);
    setBlockedNotice(null);
    setPendingTargets(targets);
    setConfirmOpen(true);
  }

  function askDeleteSection(sectionSessionId: string, sectionGroups: PostprocessGroup[]) {
    setDeleteError(null);
    setBlockedNotice(null);
    setPendingTargets([{ sessionId: sectionSessionId, groupIds: sectionGroups.map(group => group.groupId) }]);
    setConfirmOpen(true);
  }

  async function runDelete(force: boolean) {
    const targets = pendingTargets ?? [];
    setDeleting(true);
    setDeleteError(null);
    try {
      await onDelete(targets, force);
      stopSelecting();
      setConfirmOpen(false);
      setBlockedNotice(null);
      setPendingTargets(null);
    } catch (error) {
      const err = error as { blocked?: string[]; blockedByUpload?: string[] };
      if (err?.blockedByUpload?.length) {
        // 正在上传的卷不是服务端能 force 放行的对象：失败当场说明，勾选原样保留。
        setConfirmOpen(false);
        setBlockedNotice(null);
        setDeleteError(`以下卷正在上传或还有失败页待传，已停止删除并保留勾选：${err.blockedByUpload.join("、")}`);
        return;
      }
      if (err?.blocked?.length) { setBlockedNotice(err.blocked); return; }
      // 删除失败必须留在当前视图显示；直接抛给 void onConfirm 会触发扫描端全局
      // unhandledrejection 遮罩，整页不可用。确认框的开关是 confirmOpen || blockedNotice，
      // 不清掉上一次的 blockedNotice 就会让框继续挡在错误前面。
      setConfirmOpen(false);
      setBlockedNotice(null);
      setDeleteError(error instanceof Error ? error.message : "删除失败");
    } finally {
      setDeleting(false);
    }
  }

  async function clearEmptySessions() {
    if (!emptySessions.length) return;
    setClearingEmpty(true);
    setDeleteError(null);
    try {
      for (const session of emptySessions) await onDeleteSession(session.sessionId);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "清理空批次失败");
    } finally {
      setClearingEmpty(false);
    }
  }

  async function retrySelected() {
    if (!onRetryGroups || !selectedIssueGroups.length) return;
    setRetrying(true);
    setRetryNotice(null);
    setDeleteError(null);
    const bySession = new Map<string, string[]>();
    for (const group of selectedIssueGroups) {
      bySession.set(group.sessionId, [...(bySession.get(group.sessionId) ?? []), group.groupId]);
    }
    try {
      const outcome = await onRetryGroups([...bySession].map(([sessionId, groupIds]) => ({ sessionId, groupIds })));
      const detail = [
        outcome.ok ? `已重新识别 ${outcome.ok} 张` : "",
        outcome.failed ? `另有 ${outcome.failed} 张未能识别` : "",
        ...outcome.messages,
      ].filter(Boolean).join("；");
      setRetryNotice(detail || "没有可重新识别的卷");
    } catch (error) {
      setRetryNotice(error instanceof Error ? error.message : "批量重新识别失败");
    } finally {
      setRetrying(false);
    }
  }

  const confirmCount = (pendingTargets ?? []).reduce((count, target) => count + target.groupIds.length, 0);
  const confirmBatch = (pendingTargets ?? []).length === 1
    && sections.some(section => section.sessionId === pendingTargets?.[0]?.sessionId
      && section.groups.length === pendingTargets?.[0]?.groupIds.length);

  const renderGrid = (sectionGroups: PostprocessGroup[]) => (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(128px,1fr))] gap-3">
      {sectionGroups.map(group => {
        const status = statusOf(group, remote);
        const isSel = selected.has(groupKey(group));
        return (
          <button
            key={groupKey(group)}
            type="button"
            // 选择态下整卡即勾选框：再嵌一个 Checkbox 会变成按钮套按钮，键盘无法退出
            aria-pressed={selecting ? isSel : undefined}
            aria-label={selecting ? `选择 ${group.studentId ?? `组 ${group.groupId}`}` : `打开 ${group.studentId ?? `组 ${group.groupId}`}`}
            onClick={event => handleGroupClick(group, event)}
            className={`flex flex-col gap-1 rounded-md border bg-card p-1.5 text-left transition-colors ${
              group.issues.length ? "ring-2 ring-destructive" : "border-border-subtle"
            } ${isSel ? "border-primary" : ""}`}
          >
            <span className="relative block">
              {selecting && (
                <span aria-hidden className={`absolute left-1 top-1 z-10 flex size-4 items-center justify-center rounded-sm border ${
                  isSel ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card"
                }`}>
                  {isSel && <Check size={12} />}
                </span>
              )}
              {group.thumbRecordId ? (
                <img
                  src={channel.thumbnailUrl(group.thumbRecordId)}
                  alt={`第 ${group.groupId} 组答题卡`}
                  loading="lazy"
                  decoding="async"
                  className="aspect-[3/4] w-full rounded-xs border border-border bg-paper object-contain"
                />
              ) : (
                <span className="flex aspect-[3/4] w-full items-center justify-center rounded-xs border border-border bg-muted text-xs text-muted-foreground">无图</span>
              )}
            </span>
            <span className="truncate text-xs font-medium tabular-nums">{group.studentId ?? "未识别"}</span>
            <Badge tone={status.tone} dot className="h-[18px] px-1.5 text-[10.5px]">{status.label}</Badge>
          </button>
        );
      })}
    </div>
  );

  const renderList = (sectionGroups: PostprocessGroup[], sectionIndex: number) => (
    <TableWrap>
      <Table>
        <TableHeader>
          <TableRow>
            {selecting && (
              <TableHead className="w-10">
                <Checkbox
                  checked={sectionGroups.every(group => selected.has(groupKey(group)))}
                  aria-label={`选择第 ${sectionIndex + 1} 批全部卷`}
                  onCheckedChange={() => {
                    setSelected(prev => {
                      const next = new Set(prev);
                      const all = sectionGroups.every(group => next.has(groupKey(group)));
                      for (const group of sectionGroups) {
                        if (all) next.delete(groupKey(group)); else next.add(groupKey(group));
                      }
                      return next;
                    });
                  }}
                />
              </TableHead>
            )}
            <TableHead>考号</TableHead>
            <TableHead numeric>页数</TableHead>
            <TableHead numeric>客观</TableHead>
            <TableHead numeric>主观</TableHead>
            <TableHead numeric>总分</TableHead>
            <TableHead>状态</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sectionGroups.map(group => {
            const status = statusOf(group, remote);
            const isSel = selected.has(groupKey(group));
            return (
              <TableRow key={groupKey(group)} clickable tabIndex={0}
                onClick={event => handleGroupClick(group, event)}
                onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleGroupClick(group, e); } }}>
                {selecting && (
                  <TableCell onClick={e => e.stopPropagation()}>
                    <Checkbox checked={isSel} onCheckedChange={() => toggle(group)} aria-label={`选择 ${group.studentId ?? `组 ${group.groupId}`}`} />
                  </TableCell>
                )}
                <TableCell className="font-medium tabular-nums">{group.studentId ?? "未识别"}</TableCell>
                <TableCell numeric>{group.pageCount}</TableCell>
                <TableCell numeric>{group.objectiveScore}</TableCell>
                <TableCell numeric>{group.subjectiveScore}</TableCell>
                <TableCell numeric className="font-semibold">{group.totalScore}<span className="text-muted-foreground">/{group.maxScore}</span></TableCell>
                <TableCell><Badge tone={status.tone} dot>{status.label}</Badge></TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </TableWrap>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-border-subtle bg-card px-4 py-2">
        <div className="relative w-60">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索考号" className="pl-8" aria-label="搜索考号" />
        </div>
        <SegmentedControl
          aria-label="筛选"
          value={filter}
          onValueChange={setFilter}
          items={[
            { value: "all", label: `全部 ${groups.length}` },
            { value: "normal", label: `正常 ${groups.length - issueCount}` },
            { value: "issue", label: `异常 ${issueCount}` },
          ]}
        />
        <div className="ml-auto flex items-center gap-2">
          {onSaveAll && pendingSaveCount > 0 && (
            <Tip label={saveAllTip ?? `把 ${pendingSaveCount} 份正常卷写成本机正式成绩；异常卷请先处理完再保存`}>
              <Button variant="secondary" size="sm" icon={<Database />} loading={saveAllBusy} disabled={saveAllBusy} onClick={() => void onSaveAll()}>
                {saveAllLabel}（{pendingSaveCount}）
              </Button>
            </Tip>
          )}
          <Button
            variant={selecting ? "secondary" : "outline"}
            size="sm"
            icon={<CheckSquare />}
            aria-pressed={selecting}
            onClick={() => { if (selecting) stopSelecting(); else setSelecting(true); }}
          >
            选择
          </Button>
          <SegmentedControl
            aria-label="视图"
            size="sm"
            value={layout}
            onValueChange={setLayout}
            items={[{ value: "grid", label: "方块" }, { value: "list", label: "列表" }]}
          />
        </div>
      </div>

      {retryNotice && (
        <div role="status" className="flex flex-wrap items-center gap-2 border-b border-info-border bg-info-soft px-4 py-2 text-xs text-info-fg">
          <span className="min-w-0 flex-1">{retryNotice}</span>
          <Button variant="ghost" size="sm" onClick={() => setRetryNotice(null)}>知道了</Button>
        </div>
      )}
      {deleteError && (
        <div role="alert" className="flex flex-wrap items-center gap-2 border-b border-destructive-border bg-destructive-soft px-4 py-2 text-xs text-destructive-fg">
          <span className="min-w-0 flex-1">{deleteError}</span>
          <Button variant="ghost" size="sm" onClick={() => setDeleteError(null)}>知道了</Button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {emptySessions.length > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-border-subtle bg-muted px-3 py-2 text-xs text-muted-foreground">
            <span className="min-w-0 flex-1">
              有 {emptySessions.length} 个批次已经没有扫描卡：{emptySessions.map(session => session.sessionId.slice(0, 6)).join("、")}
            </span>
            <Button variant="outline" size="sm" loading={clearingEmpty} disabled={clearingEmpty} onClick={() => void clearEmptySessions()}>
              清理空批次（{emptySessions.length}）
            </Button>
          </div>
        )}
        {visible.length === 0 ? (
          <EmptyState icon={<ImageOff />} title="没有符合条件的卷子" description="调整筛选或搜索词后重试" size="md" />
        ) : (
          <div className="flex flex-col gap-5">
            {sections.map((section, sectionIndex) => (
              <section key={section.sessionId} className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="m-0 text-sm font-semibold">第 {sectionIndex + 1} 批</h3>
                  <span className="text-xs tabular-nums text-muted-foreground">{section.groups.length} 组</span>
                  <span className="text-xs text-muted-foreground">批次 {section.sessionId.slice(0, 8)}</span>
                  <Button variant="ghost" size="sm" className="ml-auto text-destructive-fg" icon={<Trash2 size={13} />}
                    onClick={() => askDeleteSection(section.sessionId, section.groups)}>
                    删除整批
                  </Button>
                </div>
                {layout === "grid" ? renderGrid(section.groups) : renderList(section.groups, sectionIndex)}
              </section>
            ))}
          </div>
        )}
      </div>

      {selecting && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border-subtle bg-card px-4 py-2">
          <b className="text-sm tabular-nums">已选 {selected.size} 张</b>
          <Button variant="ghost" size="sm" disabled={visible.length === 0} onClick={selectAllVisible}>全选当前结果（{visible.length}）</Button>
          <Button variant="ghost" size="sm" disabled={!selected.size} onClick={() => { setSelected(new Set()); anchorRef.current = null; }}>取消全选</Button>
          <Button variant="ghost" size="sm" disabled={visible.length === 0} onClick={invertVisible}>反选</Button>
          <span className="text-xs text-muted-foreground">按住 Shift 点击可连选一段；筛选或搜索变化会清掉看不见的勾选</span>
          {onRetryGroups && (
            <Tip label="对选中的失败 / 存疑卷重新识别；已保存的卷只在服务端证据校验通过后重算成绩">
              <Button variant="outline" size="sm" icon={<RefreshCw size={13} />} disabled={!selectedIssueGroups.length || retrying}
                loading={retrying} onClick={() => void retrySelected()}>
                重新识别异常卷（{selectedIssueGroups.length}）
              </Button>
            </Tip>
          )}
          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={stopSelecting}>退出选择</Button>
            <Button variant="destructive" size="sm" icon={<Trash2 />} disabled={!selected.size} onClick={askDeleteSelected}>
              删除选中（{selected.size}）
            </Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen || !!blockedNotice}
        onOpenChange={open => { if (!open) { setConfirmOpen(false); setBlockedNotice(null); setPendingTargets(null); } }}
        title={confirmBatch ? `删除第 ${sections.findIndex(section => section.sessionId === pendingTargets?.[0]?.sessionId) + 1} 批 ${confirmCount} 张扫描卡？` : `删除 ${confirmCount} 张扫描卡？`}
        description={blockedNotice
          ? `其中 ${blockedNotice.length} 张已有成绩记录或待处理，请先核对成绩状态。删除只会移除本机扫描记录和识别结果；服务器上已保存的成绩会保留，未保存的待处理记录将无法再从本机补传。`
          : "本机扫描记录与识别结果将被移除，且无法恢复。已上传到服务器的成绩不受影响。"}
        confirmLabel={blockedNotice ? "知晓代价，仍删除" : "删除"}
        loading={deleting}
        onConfirm={() => void runDelete(!!blockedNotice)}
      />
    </div>
  );
}
