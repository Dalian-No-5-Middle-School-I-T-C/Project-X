import { useEffect, useMemo, useState } from "react";
import { Check, CheckSquare, Database, ImageOff, Search, Trash2 } from "lucide-react";
import {
  Badge, Button, Checkbox, ConfirmDialog, EmptyState, Input, SegmentedControl, Tip,
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableWrap,
} from "../ui/v2";
import type { PostprocessGroup } from "../../../../../shared/scanPostprocess";
import type { PostprocessChannel } from "./postprocessChannel";

type Filter = "all" | "normal" | "issue";
type Layout = "grid" | "list";
type DeleteBlock = { blocked?: string[]; uploadBlocked?: number };

export interface DeleteTarget { sessionId: string; groupIds: string[] }

export interface PostprocessResultsViewProps {
  groups: PostprocessGroup[];
  channel: PostprocessChannel;
  /** 删除按会话分组下发：groupId 只在单个 session 内有意义，续扫后两批会出现同名组 */
  onDelete: (targets: DeleteTarget[], force: boolean) => Promise<void>;
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
function statusOf(group: PostprocessGroup): { tone: "success" | "warning" | "danger"; label: string } {
  switch (group.issues[0]) {
    case "duplicate": return { tone: "danger", label: "考号重复" };
    case "student_id": return { tone: "danger", label: "考号未识别" };
    case "missing_page": return { tone: "danger", label: "缺页" };
    case "low_confidence": return { tone: "warning", label: `${group.needsReviewCount} 题存疑` };
    case "other": return { tone: "danger", label: "处理失败" };
    default: return { tone: "success", label: group.saved ? "已入库" : "正常" };
  }
}

const groupKey = (group: PostprocessGroup) => `${group.sessionId}/${group.groupId}`;

export function PostprocessResultsView({
  groups, channel, onDelete, onOpen, onSaveAll, saveAllBusy = false, saveAllLabel = "保存成绩入库",
  saveAllTip, saveAllCount,
}: PostprocessResultsViewProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [layout, setLayout] = useState<Layout>("grid");
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmation, setConfirmation] = useState<"initial" | DeleteBlock | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    setSelected(prev => {
      if (prev.size === 0) return prev;
      const remaining = new Set(groups.filter(group => prev.has(groupKey(group))).map(groupKey));
      return remaining.size === prev.size ? prev : remaining;
    });
  }, [groups]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return groups
      .filter(g => (filter === "all" ? true : filter === "normal" ? g.issues.length === 0 : g.issues.length > 0))
      .filter(g => !q || (g.studentId ?? "").toLowerCase().includes(q))
      // 异常卷置顶（demo 视图 8 的 .scan-thumb.bad 语义），其次按组序
      .sort((a, b) => (a.issues.length === b.issues.length ? Number(a.groupId) - Number(b.groupId) : b.issues.length - a.issues.length));
  }, [groups, query, filter]);

  const issueCount = groups.filter(g => g.issues.length > 0).length;
  // 正常但未入库的份数：这就是「保存成绩入库」要写的对象（异常卷保存会被服务端拒）
  const unsavedNormal = groups.filter(g => !g.issues.length && !g.saved).length;
  const pendingSaveCount = saveAllCount ?? unsavedNormal;
  const visibleSelectedCount = visible.filter(group => selected.has(groupKey(group))).length;
  const allVisibleSelected = visible.length > 0 && visibleSelectedCount === visible.length;
  const hiddenSelectedCount = selected.size - visibleSelectedCount;
  const filtered = filter !== "all" || query.trim() !== "";
  const stopSelecting = () => {
    setSelecting(false);
    setSelected(new Set());
    setDeleteError(null);
  };
  const toggle = (group: PostprocessGroup) => setSelected(prev => {
    const next = new Set(prev);
    const key = groupKey(group);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const toggleVisible = () => setSelected(prev => {
    const next = new Set(prev);
    for (const group of visible) {
      if (allVisibleSelected) next.delete(groupKey(group));
      else next.add(groupKey(group));
    }
    return next;
  });
  /** 选中的组按所属会话归组下发，避免第二批的同名组被误删 */
  const selectedTargets = (): DeleteTarget[] => {
    const bySession = new Map<string, string[]>();
    for (const group of groups) {
      if (!selected.has(groupKey(group))) continue;
      const ids = bySession.get(group.sessionId);
      if (ids) ids.push(group.groupId);
      else bySession.set(group.sessionId, [group.groupId]);
    }
    return [...bySession].map(([sessionId, groupIds]) => ({ sessionId, groupIds }));
  };

  const blockedNotice = confirmation === "initial" ? null : confirmation;
  const deleteWarnings = [
    hiddenSelectedCount > 0 ? `已选扫描卡中有 ${hiddenSelectedCount} 张不在当前结果中。` : "",
    blockedNotice?.uploadBlocked
      ? `其中 ${blockedNotice.uploadBlocked} 张卷尚未上传完成或上传记录异常。继续删除将取消这些卷的未完成上传任务，移除本机扫描记录、原图和识别结果。服务器已保存的成绩不受影响。`
      : "",
    blockedNotice?.blocked?.length
      ? `其中 ${blockedNotice.blocked.length} 张已有成绩记录或待处理，请先核对成绩状态。删除会移除本机扫描记录、原图和识别结果。服务器上已保存的成绩会保留，未保存的待处理记录将无法再从本机补传。`
      : "",
    blockedNotice ? "" : "本机扫描记录、原图和识别结果将被移除，且无法恢复。已上传到服务器的成绩不受影响。",
  ].filter(Boolean).join(" ");

  async function runDelete(force: boolean) {
    if (deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await onDelete(selectedTargets(), force);
      stopSelecting();
      setConfirmation(null);
    } catch (error) {
      const block = error as DeleteBlock | null;
      if (!force && (block?.blocked?.length || block?.uploadBlocked)) {
        setConfirmation(block);
        return;
      }
      setConfirmation(null);
      setDeleteError(error instanceof Error ? error.message : "删除失败");
    } finally {
      setDeleting(false);
    }
  }

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
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
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
          {selecting && (
            <Button variant="outline" size="sm" disabled={visible.length === 0} onClick={toggleVisible}>
              {allVisibleSelected ? "取消全选" : `${filtered ? "全选当前结果" : "全选"}（${visible.length}）`}
            </Button>
          )}
          <SegmentedControl
            aria-label="视图"
            size="sm"
            value={layout}
            onValueChange={setLayout}
            items={[{ value: "grid", label: "方块" }, { value: "list", label: "列表" }]}
          />
        </div>
      </div>

      {selecting && (deleteError || hiddenSelectedCount > 0) && (
        <div className="shrink-0 border-b border-border-subtle bg-card px-4 py-2 text-xs">
          {deleteError && <div className="text-destructive-fg" role="alert">{deleteError}</div>}
          {hiddenSelectedCount > 0 && <div className="text-muted-foreground">已选扫描卡中有 {hiddenSelectedCount} 张不在当前结果中。</div>}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {visible.length === 0 ? (
          <EmptyState icon={<ImageOff />} title="没有符合条件的卷子" description="调整筛选或搜索词后重试" size="md" />
        ) : layout === "grid" ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(128px,1fr))] gap-3">
            {visible.map(group => {
              const status = statusOf(group);
              const isSel = selected.has(groupKey(group));
              return (
                <button
                  key={groupKey(group)}
                  type="button"
                  // 选择态下整卡即勾选框：再嵌一个 Checkbox 会变成按钮套按钮，键盘无法退出
                  aria-pressed={selecting ? isSel : undefined}
                  aria-label={selecting ? `选择 ${group.studentId ?? `组 ${group.groupId}`}` : `打开 ${group.studentId ?? `组 ${group.groupId}`}`}
                  onClick={() => (selecting ? toggle(group) : onOpen(group))}
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
        ) : (
          <TableWrap>
            <Table>
              <TableHeader>
                <TableRow>
                  {selecting && (
                    <TableHead className="w-10">
                      <Checkbox
                        checked={allVisibleSelected || (visibleSelectedCount > 0 ? "indeterminate" : false)}
                        onCheckedChange={toggleVisible}
                        aria-label="全选当前结果"
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
                {visible.map(group => {
                  const status = statusOf(group);
                  const isSel = selected.has(groupKey(group));
                  return (
                    <TableRow key={groupKey(group)} clickable tabIndex={0}
                      onClick={() => (selecting ? toggle(group) : onOpen(group))}
                      onKeyDown={e => {
                        if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
                        e.preventDefault();
                        if (selecting) toggle(group); else onOpen(group);
                      }}>
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
        )}
      </div>

      {selecting && (
        <div className="flex shrink-0 items-center gap-3 border-t border-border-subtle bg-card px-4 py-2">
          <b className="shrink-0 text-sm tabular-nums" aria-live="polite">已选 {selected.size} 张</b>
          <span className="hidden min-w-0 truncate text-xs text-muted-foreground sm:block">删除会移除本机扫描记录和原图，服务器已保存的成绩会保留</span>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Button variant="outline" size="sm" onClick={stopSelecting}>取消</Button>
            <Button variant="destructive" size="sm" icon={<Trash2 />} disabled={!selected.size} onClick={() => setConfirmation("initial")}>
              删除选中（{selected.size}）
            </Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmation !== null}
        onOpenChange={open => { if (!open && !deleting) setConfirmation(null); }}
        title={`删除 ${selected.size} 张扫描卡？`}
        description={deleteWarnings}
        confirmLabel={blockedNotice ? "知晓代价，仍删除" : "删除"}
        loading={deleting}
        onConfirm={() => void runDelete(!!blockedNotice)}
      />
    </div>
  );
}
