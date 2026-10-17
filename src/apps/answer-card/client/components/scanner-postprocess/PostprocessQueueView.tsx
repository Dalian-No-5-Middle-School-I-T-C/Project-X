import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowLeft, ScanSearch, SkipForward, Trash2, TriangleAlert } from "lucide-react";
import {
  Badge, Button, Card, CardContent, CardHeader, CardTitle, ConfirmDialog,
  EmptyState, Input, Progress, Spinner, Tip, notify,
} from "../ui/v2";
import { CardCorrectionButton } from "../CardCorrectionEditor";
import { CorrectionCanvas } from "./CorrectionCanvas";
import type { PostprocessChannel } from "./postprocessChannel";
import { replaceScopedSelection, type PostprocessQueueItem } from "../../../../../shared/scanPostprocess";
import { selectStudentDigitCells } from "../../../../../shared/correctionCellSelect";
import { uniqueScanConflictCards, type ScanConflictCard } from "../../../../../shared/scanPages";
import { correctionCells, correctionState, toggleCorrectionCell, type CorrectionDocument, type CorrectionEdit } from "../../../../../shared/scanCorrection";
import { OBJECTIVE_REVIEW_CONFIDENCE_THRESHOLD } from "../../../../../shared/grading";
import type { SubjectiveQuestionNumber } from "../../../../../shared/types";

export interface ScanMeta { recordId: string; createdAt: string; scanQuality: number | null; }

export interface PostprocessQueueViewProps {
  queue: PostprocessQueueItem[];
  channel: PostprocessChannel;
  examId: number | null;
  scans: ScanMeta[];
  layoutPageCount: number;
  /** 处理完成（考号已改、重复卷已定性等）：页面重拉批结果并按需补传 */
  onResolved: (sessionId: string, groupId: string) => void | Promise<void>;
  onJumpToCorrection: (sessionId: string, groupId: string, questionNumber?: SubjectiveQuestionNumber) => void;
  onDelete: (groupIds: string[], force: boolean) => Promise<void>;
}

const ISSUE_LABEL: Record<PostprocessQueueItem["kind"], string> = {
  duplicate: "考号重复",
  student_id: "考号问题",
  missing_page: "缺页",
  low_confidence: "存疑",
  other: "其他",
};

const kindTone = (kind: PostprocessQueueItem["kind"]): "danger" | "warning" | "neutral" => (
  kind === "low_confidence" ? "warning" : kind === "other" ? "neutral" : "danger"
);

export function PostprocessQueueView({ queue, channel, examId, scans, layoutPageCount, onResolved, onJumpToCorrection, onDelete }: PostprocessQueueViewProps) {
  const [cursor, setCursor] = useState(0);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [resolved, setResolved] = useState<Set<string>>(new Set());
  const [fixTarget, setFixTarget] = useState<{ sessionId: string; groupId: string } | null>(null);
  const seen = useRef<Set<string>>(new Set());

  // 队列项在批结果重拉后消失 = 该条已处理；已处理的仍计入进度，否则进度条会随处理退回 0
  useEffect(() => {
    const live = new Set(queue.map(item => item.id));
    for (const item of queue) seen.current.add(item.id);
    const next = new Set(resolved);
    let changed = false;
    for (const id of seen.current) if (!live.has(id) && !next.has(id)) { next.add(id); changed = true; }
    if (changed) setResolved(next);
    setCursor(current => Math.min(current, Math.max(0, queue.length - 1)));
  }, [queue, resolved]);

  const index = Math.min(cursor, Math.max(0, queue.length - 1));
  const current = queue[index];
  const total = queue.length + resolved.size;
  const skippedCount = queue.filter(item => skipped.has(item.id)).length;

  if (!queue.length) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <Badge tone="success" dot>队列已清零</Badge>
        <p className="m-0 max-w-[46ch] text-sm text-muted-foreground">
          本批 {total} 条异常已全部处理完成；正常卷按现有流程后台上传，已处理卷在补传队列里继续。
        </p>
      </div>
    );
  }

  const goto = (offset: number) => {
    for (let step = 1; step <= queue.length; step++) {
      const index = (cursor + offset * step + queue.length * step) % queue.length;
      if (!skipped.has(queue[index].id)) { setCursor(index); return; }
    }
  };

  return (
    <div className="flex min-h-0 flex-1 gap-4 p-4">
      <Card className="flex w-[260px] shrink-0 flex-col">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-baseline justify-between gap-2 text-base">
            <span>异常队列</span>
            <span className="text-xs font-normal tabular-nums text-muted-foreground">第 {cursor + 1} / {queue.length} 条</span>
          </CardTitle>
          <Progress value={total ? Math.round((resolved.size / total) * 100) : 0} size="sm" tone="success" />
          <p className="m-0 text-xs tabular-nums text-muted-foreground">已处理 {resolved.size} · 暂时跳过 {skippedCount}</p>
        </CardHeader>
        <CardContent className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto py-0">
          {queue.map((item, itemIndex) => (
            <button
              key={item.id}
              type="button"
              onClick={() => { setCursor(itemIndex); setFixTarget(null); }}
              className={`rounded-md border px-2 py-1.5 text-left text-xs transition-colors ${
                itemIndex === index ? "border-primary bg-accent" : "border-border-subtle bg-card"
              } ${skipped.has(item.id) ? "opacity-60" : ""}`}
            >
              <span className="flex items-center gap-2">
                <Badge tone={kindTone(item.kind)} dot>{ISSUE_LABEL[item.kind]}</Badge>
                <span className="truncate tabular-nums">{item.studentId ?? `组 ${item.groupId}`}</span>
              </span>
              <span className="mt-0.5 block truncate text-muted-foreground">{item.label}</span>
            </button>
          ))}
        </CardContent>
        <CardContent className="flex gap-2 border-t border-border-subtle pt-2">
          <Button variant="outline" size="sm" className="flex-1" icon={<SkipForward />}
            onClick={() => { setSkipped(prev => new Set(prev).add(current.id)); goto(1); }}>
            暂时跳过
          </Button>
          <Tip label="跳到下一条未跳过的异常">
            <Button variant="secondary" size="sm" className="flex-1" icon={<ArrowDown />} onClick={() => goto(1)}>下一条</Button>
          </Tip>
        </CardContent>
      </Card>

      <div className="min-w-0 flex-1 overflow-auto">
        {fixTarget
          ? <StudentIdPanel sessionId={fixTarget.sessionId} groupId={fixTarget.groupId} channel={channel} examId={examId}
              onResolved={onResolved} onBack={() => setFixTarget(null)} />
          : current.kind === "student_id"
            ? <StudentIdPanel sessionId={current.sessionId} groupId={current.groupId} channel={channel} examId={examId} onResolved={onResolved} />
            : current.kind === "duplicate"
              ? <DuplicatePanel item={current} channel={channel} scans={scans} onResolved={onResolved} onFixStudentId={target => setFixTarget(target)} />
              : current.kind === "missing_page"
                ? <MissingPagePanel item={current} channel={channel} layoutPageCount={layoutPageCount} onResolved={onResolved} onDelete={onDelete} />
                : current.kind === "low_confidence"
                  ? <LowConfidencePanel item={current} channel={channel} onJump={onJumpToCorrection} />
                  : <OtherPanel item={current} channel={channel} onResolved={onResolved} />}
      </div>
    </div>
  );
}

/** 队列面板共用的 correction 文档加载（图片只在需要画布时取）。 */
function useCorrectionBundle(channel: PostprocessChannel, url: string | null, withImages: boolean) {
  const [document, setDocument] = useState<CorrectionDocument | null>(null);
  const [images, setImages] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    if (!url) { setDocument(null); setBusy(false); return; }
    let alive = true;
    const blobs: string[] = [];
    setBusy(true);
    setDocument(null);
    setError("");
    void (async () => {
      try {
        const response = await channel.request(url);
        const data = await response.json();
        if (!response.ok) throw new Error(data?.message || "加载答题卡失败");
        const doc = data as CorrectionDocument;
        const loaded: Record<string, string> = {};
        if (withImages) for (const page of doc.pages) {
          const image = await channel.request(page.imageUrl);
          if (!image.ok) throw new Error("答题卡图片加载失败");
          const blob = URL.createObjectURL(await image.blob());
          if (!alive) { URL.revokeObjectURL(blob); return; }
          blobs.push(blob);
          loaded[page.sourceId] = blob;
        }
        if (!alive) return;
        setDocument(doc);
        setImages(loaded);
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : "加载失败");
      } finally {
        if (alive) setBusy(false);
      }
    })();
    return () => { alive = false; blobs.forEach(blob => URL.revokeObjectURL(blob)); };
  }, [channel, url, withImages]);

  return { document, images, error, busy };
}

function PanelShell({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <Card className="flex min-h-0 flex-col">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
        {description && <p className="m-0 text-xs text-muted-foreground">{description}</p>}
      </CardHeader>
      <CardContent className="min-h-0 flex-1">{children}</CardContent>
    </Card>
  );
}

interface StudentIdPanelProps {
  sessionId: string;
  groupId: string;
  channel: PostprocessChannel;
  examId: number | null;
  onResolved: (sessionId: string, groupId: string) => void | Promise<void>;
  onBack?: () => void;
}

/** 考号修正（D10）：考号区裁图 + 花名册联想 + 确认写回 digit 格并重匹配。 */
function StudentIdPanel({ sessionId, groupId, channel, examId, onResolved, onBack }: StudentIdPanelProps) {
  const url = channel.correctionUrl(sessionId, groupId);
  const { document, images, error, busy } = useCorrectionBundle(channel, url, true);
  const [edits, setEdits] = useState<CorrectionEdit[]>([]);
  const [value, setValue] = useState("");
  const [roster, setRoster] = useState<Array<{ id: number; name: string; student_number: string | null }>>([]);
  const [rosterChecked, setRosterChecked] = useState(false);
  const [saving, setSaving] = useState(false);
  const cropRef = useRef<HTMLDivElement>(null);
  const digitPageIndex = useMemo(() => (document ? document.pages.findIndex(page => correctionCells(page.layout).some(cell => cell.type === "student_digit")) : -1), [document]);
  const digitPage = document && digitPageIndex >= 0 ? document.pages[digitPageIndex] : null;

  useEffect(() => {
    if (!document) return;
    setEdits(document.pages.map(page => ({ sourceId: page.sourceId, revision: page.revision, selected: [...page.selected], touched: [] })));
    // 卡上已填的考号作为初值，老师只需改错位的那几位
    const filled = document.pages.find(page => page.recognition.studentId?.value)?.recognition.studentId?.value;
    if (filled) setValue(filled);
  }, [document]);

  useEffect(() => {
    const node = cropRef.current?.querySelector('polygon[aria-label^="学号第"]');
    node?.scrollIntoView({ block: "center", inline: "center" });
  }, [document, images]);

  // 花名册联想：300ms 防抖；读不到考试就退化为纯手输
  useEffect(() => {
    const keyword = value.trim();
    if (examId === null || keyword.length < 2) { setRoster([]); setRosterChecked(false); return; }
    let alive = true;
    setRosterChecked(false);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const response = await channel.request(`/api/exams/${examId}/participant-search?q=${encodeURIComponent(keyword)}`);
          const data = await response.json();
          if (!alive) return;
          if (response.ok) {
            setRoster((data.students ?? []) as Array<{ id: number; name: string; student_number: string | null }>);
            setRosterChecked(true);
          }
        } catch { /* 名单查不到不影响手输 */ }
      })();
    }, 300);
    return () => { alive = false; clearTimeout(timer); };
  }, [value, examId, channel]);

  const digits = value.trim();
  // 只有真正查过名单才敢说「不在名单」，否则查询失败会被误报成缺考
  const notInRoster = rosterChecked && /^\d+$/.test(digits) && digits.length >= 2 && !roster.some(student => student.student_number === digits);
  const canConfirm = !!document && /^\d+$/.test(digits) && !saving;

  /** 点选 digit 格：与手输同源，都写进同一份 edits */
  function toggleCell(cellId: string) {
    if (!document || !digitPage) return;
    setEdits(current => current.map(entry => entry.sourceId === digitPage.sourceId
      ? { ...entry, selected: toggleCorrectionCell(document.card, digitPage, entry.selected, cellId) }
      : entry));
  }

  function useRosterNumber(number: string) { setValue(number); setRoster([]); }

  async function confirm() {
    if (!document) return;
    const cells = document.pages.flatMap(page => correctionCells(page.layout));
    const picked = selectStudentDigitCells(cells, digits);
    if (!picked) { notify.error("考号位数与卡面不符"); return; }
    const scope = new Set(cells.filter(cell => cell.type === "student_digit").map(cell => cell.id));
    const owner = new Map<string, string>();
    for (const page of document.pages) for (const cell of correctionCells(page.layout)) owner.set(cell.id, page.sourceId);
    const next = replaceScopedSelection(edits, owner, scope, picked);
    setSaving(true);
    try {
      const response = await channel.request(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pages: next }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "保存考号失败");
      notify.success(`考号已改为 ${digits}`);
      await onResolved(sessionId, groupId);
    } catch (err) {
      notify.error(err instanceof Error ? err.message : "保存考号失败");
    } finally {
      setSaving(false);
    }
  }

  if (busy && !document) return <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"><Spinner /> 正在加载考号区…</div>;
  if (!document || !digitPage || digitPageIndex < 0) {
    return <PanelShell title="考号修正"><p className="text-sm text-destructive-fg">{error || "该卡面没有考号填涂区，无法改考号"}</p></PanelShell>;
  }
  const edit = edits.find(entry => entry.sourceId === digitPage.sourceId);
  if (!edit) return null;

  return (
    <PanelShell title="考号修正" description={onBack ? undefined : "改完点确认，系统按新考号重新匹配学生并判分"}>
      {onBack && (
        <Button variant="ghost" size="sm" className="mb-2" icon={<ArrowLeft />} onClick={onBack}>返回重卡对比</Button>
      )}
      <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
        <div ref={cropRef} className="min-h-[220px] w-full shrink-0 overflow-auto rounded-md bg-muted p-3 lg:w-[46%]">
          <CorrectionCanvas document={document} pageIndex={digitPageIndex} edit={edit} images={images} zoom={3} busy={saving} onToggle={toggleCell} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-muted-foreground">考号（卡面共 {new Set(correctionCells(digitPage.layout).filter(c => c.type === "student_digit").map(c => c.digitIndex)).size} 位）</span>
            <Input value={value} onChange={e => setValue(e.target.value)} inputMode="numeric" placeholder="按卡面位数输入数字" aria-label="考号" />
          </label>
          {examId !== null && roster.length > 0 && (
            <ul className="m-0 flex max-h-40 flex-col gap-1 overflow-auto rounded-md border border-border-subtle bg-card p-1.5 text-sm">
              {roster.map(student => (
                <li key={student.id}>
                  <button type="button" className="w-full truncate rounded-sm px-1.5 py-1 text-left hover:bg-secondary" onClick={() => useRosterNumber(student.student_number ?? "")}>
                    <span className="tabular-nums">{student.student_number ?? "无考号"}</span>
                    <span className="ml-2 text-muted-foreground">{student.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {examId === null && <p className="m-0 text-xs text-muted-foreground">本机未确定考试归属，花名册联想不可用，请直接按卡面位数输入考号。</p>}
          {notInRoster && <Badge tone="danger" dot>该考号不在应考名单</Badge>}
          <div className="flex items-center gap-2">
            <Button variant="primary" icon={<ScanSearch />} disabled={!canConfirm} loading={saving} onClick={() => void confirm()}>
              确认考号 · 重新匹配学生
            </Button>
          </div>
          <p className="m-0 text-xs text-muted-foreground">也可以直接在左图点选digit格改某一位；单选列内互斥，与上面的输入同源。</p>
        </div>
      </div>
    </PanelShell>
  );
}

/** 重卡定性（D11）：并排看图 → 保留其一（作废另一份）或改考号。 */
function DuplicatePanel({ item, channel, scans, onResolved, onFixStudentId }: {
  item: PostprocessQueueItem;
  channel: PostprocessChannel;
  scans: ScanMeta[];
  onResolved: (sessionId: string, groupId: string) => void | Promise<void>;
  /** 改的是那一份副本的考号，跨会话时用副本自己的 session */
  onFixStudentId: (target: { sessionId: string; groupId: string }) => void;
}) {
  const [busy, setBusy] = useState(false);
  const cards = uniqueScanConflictCards(item.conflicts);

  const meta = (card: ScanConflictCard) => {
    const ids = new Set(card.pages.map(page => page.recordId));
    const rows = scans.filter(scan => ids.has(scan.recordId));
    const created = rows.map(row => row.createdAt).sort();
    const quality = rows.map(row => row.scanQuality).filter((value): value is number => value !== null);
    return {
      createdAt: created[0] ?? "—",
      quality: quality.length ? (quality.reduce((sum, value) => sum + value, 0) / quality.length).toFixed(1) : "—",
    };
  };
  const samePaper = cards.length === 2 && cards[0].totalScore === cards[1].totalScore
    && cards[0].pages.length === cards[1].pages.length;

  async function keep(card: ScanConflictCard, other: ScanConflictCard) {
    setBusy(true);
    try {
      const response = await channel.request(channel.discardUrl(other.sessionId, other.groupId), { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.message || "作废失败");
      notify.success(`已保留 ${card.studentId} 的第 ${Number(card.groupId) + 1} 组，另一份已作废`);
      await onResolved(item.sessionId, item.groupId);
    } catch (err) {
      notify.error(err instanceof Error ? err.message : "作废失败");
    } finally {
      setBusy(false);
    }
  }

  if (cards.length < 2) {
    return (
      <PanelShell title="考号重复" description={item.label}>
        <p className="m-0 text-sm text-muted-foreground">只读到一份回执，无法并排定性。请核对原卷后改考号，或到服务端处理已入库的那一份。</p>
        <Button variant="outline" size="sm" className="mt-3" disabled={busy} onClick={() => onFixStudentId({ sessionId: item.sessionId, groupId: item.groupId })}>不是同一人 → 改考号</Button>
      </PanelShell>
    );
  }

  return (
    <PanelShell title="考号重复" description={item.label}>
      <Badge tone={samePaper ? "info" : "warning"} dot className="mb-3">
        {samePaper ? "总分与页数一致，倾向同一张卡重扫" : "差异较大，倾向考号撞车，请看图确认"}
      </Badge>
      <div className="grid gap-4 lg:grid-cols-2">
        {cards.map(card => {
          const other = cards.find(c => c !== card)!;
          const info = meta(card);
          const otherSaved = other.previouslySaved;
          return (
            <div key={`${card.sessionId}/${card.groupId}`} className="flex flex-col gap-2 rounded-md border border-border-subtle bg-card p-3">
              <div className="rounded-md bg-muted p-2">
                {card.pages[0] && <img src={channel.imageUrl(card.pages[0].recordId)} alt={`第 ${Number(card.groupId) + 1} 组首页`} className="max-h-64 w-full object-contain" />}
              </div>
              <p className="m-0 text-sm tabular-nums">考号 {card.studentId} · 总分 {card.totalScore ?? "—"} · {card.pages.length} 面</p>
              <p className="m-0 text-xs tabular-nums text-muted-foreground">扫描 {info.createdAt} · 清晰度 {info.quality}</p>
              <div className="flex flex-wrap gap-1.5">
                {card.previouslySaved && <Badge tone="neutral" dot>已入库</Badge>}
                {card.formalScoreRetained && <Badge tone="warning" dot>正式成绩保留</Badge>}
                {!card.previouslySaved && !card.formalScoreRetained && <Badge tone="neutral" dot>未入库</Badge>}
              </div>
              <div className="mt-auto flex flex-wrap items-center gap-2 pt-2">
                <Tip label={otherSaved ? "已入库卷不能作废，请改考号" : `作废第 ${Number(other.groupId) + 1} 组，保留这一份`}>
                  <span className="inline-flex">
                    <Button variant="outline" size="sm" disabled={busy || otherSaved} onClick={() => void keep(card, other)}>保留这份</Button>
                  </span>
                </Tip>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => onFixStudentId({ sessionId: card.sessionId, groupId: card.groupId })}>不是同一人 → 改考号</Button>
              </div>
            </div>
          );
        })}
      </div>
    </PanelShell>
  );
}

/** 缺页 / 配对失败：期望页对照 + 重新识别 + 整卡改分 + 删除该组。 */
function MissingPagePanel({ item, channel, layoutPageCount, onResolved, onDelete }: {
  item: PostprocessQueueItem;
  channel: PostprocessChannel;
  layoutPageCount: number;
  onResolved: (sessionId: string, groupId: string) => void | Promise<void>;
  onDelete: (groupIds: string[], force: boolean) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const correctionUrl = channel.correctionUrl(item.sessionId, item.groupId);

  async function retry() {
    setBusy(true);
    try {
      const response = await channel.request(channel.retryUrl(item.sessionId), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ groupId: item.groupId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.message || "重新识别失败");
      notify.success("已重新识别该卡");
      await onResolved(item.sessionId, item.groupId);
    } catch (err) {
      notify.error(err instanceof Error ? err.message : "重新识别失败");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await onDelete([item.groupId], false);
      notify.success("已删除该组本机扫描记录");
      setConfirmDelete(false);
    } catch (err) {
      const blocked = (err as { blocked?: string[] }).blocked;
      if (blocked?.length) { setConfirmDelete(false); notify.warning(`组 ${blocked.join("、")} 已有回执，请在扫描结果里二次确认后删除`); return; }
      notify.error(err instanceof Error ? err.message : "删除失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <PanelShell title="缺页 / 配对失败" description={item.label}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: layoutPageCount }, (_, index) => index + 1).map(page => (
            <Badge key={page} tone={item.missingLayoutPages.includes(page) ? "danger" : "success"} dot>
              第 {page} 页{item.missingLayoutPages.includes(page) ? "缺失" : "已到"}
            </Badge>
          ))}
        </div>
        <p className="m-0 text-xs text-muted-foreground">缺页请先整理原卷后重新扫描该份答题卡；只缺背面且确认无需背面时可用整卡改分补录。</p>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void retry()}>重新识别此卡</Button>
          <CardCorrectionButton url={correctionUrl} request={channel.request} disabled={busy} onSaved={() => onResolved(item.sessionId, item.groupId)} />
          <Button variant="ghost" size="sm" className="text-destructive-fg" icon={<Trash2 />} disabled={busy} onClick={() => setConfirmDelete(true)}>删除该组</Button>
        </div>
      </div>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`删除第 ${Number(item.groupId) + 1} 组扫描卡？`}
        description="本机扫描记录与识别结果将被移除，不可恢复。已上传的服务器成绩不受影响。"
        confirmLabel="删除，不可恢复"
        loading={busy}
        onConfirm={() => void remove()}
      />
    </PanelShell>
  );
}

/** 识别存疑：列出低置信客观题与异常主观题，逐题跳到视图 2 定位。 */
function LowConfidencePanel({ item, channel, onJump }: {
  item: PostprocessQueueItem;
  channel: PostprocessChannel;
  onJump: (sessionId: string, groupId: string, questionNumber?: SubjectiveQuestionNumber) => void;
}) {
  const { document, error, busy } = useCorrectionBundle(channel, channel.correctionUrl(item.sessionId, item.groupId), false);
  const rows = useMemo(() => {
    if (!document) return [];
    const list: Array<{ questionNumber: SubjectiveQuestionNumber; label: string; confidence: number; value: string }> = [];
    for (const page of document.pages) {
      const recognition = correctionState(document.card, page, page.selected).recognition;
      for (const question of recognition.questions ?? []) {
        if ((question.confidence ?? 0) >= OBJECTIVE_REVIEW_CONFIDENCE_THRESHOLD) continue;
        list.push({ questionNumber: question.questionNumber, label: `第 ${question.questionNumber} 题（客观）`, confidence: question.confidence ?? 0, value: question.selectedOptions.join(",") || "未答" });
      }
      for (const question of recognition.subjectiveQuestions ?? []) {
        if (question.status === "ok") continue;
        list.push({ questionNumber: question.questionNumber, label: `第 ${question.questionNumber} 题（主观 ${question.status}）`, confidence: question.confidence ?? 0, value: String(question.score) });
      }
    }
    return list.sort((a, b) => a.confidence - b.confidence);
  }, [document]);

  if (busy) return <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"><Spinner /> 正在读取存疑题…</div>;
  if (!document) return <PanelShell title="识别存疑"><p className="text-sm text-destructive-fg">{error || "加载失败"}</p></PanelShell>;

  return (
    <PanelShell title="识别存疑" description={`${item.label} · 按置信度从低到高`}>
      {rows.length === 0 ? (
        <EmptyState size="sm" title="没有低于阈值的题" description="该卷已无存疑题，可返回扫描结果继续处理下一份。" />
      ) : (
        <ul className="m-0 flex flex-col gap-1.5 p-0">
          {rows.map(row => (
            <li key={`${row.label}-${row.confidence}`} className="flex items-center gap-3 rounded-md border border-border-subtle bg-card px-3 py-1.5 text-sm">
              <span className="min-w-0 flex-1 truncate">{row.label}</span>
              <span className="tabular-nums text-muted-foreground">置信 {row.confidence.toFixed(2)}</span>
              <span className="tabular-nums text-muted-foreground">识别 {row.value}</span>
              <Button variant="outline" size="sm" onClick={() => onJump(item.sessionId, item.groupId, row.questionNumber)}>去改这题</Button>
            </li>
          ))}
        </ul>
      )}
    </PanelShell>
  );
}

/** 兜底桶：只为不丢异常，展示失败原文并提供整卡改分与重新识别。 */
function OtherPanel({ item, channel, onResolved }: {
  item: PostprocessQueueItem;
  channel: PostprocessChannel;
  onResolved: (sessionId: string, groupId: string) => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);

  async function retry() {
    setBusy(true);
    try {
      const response = await channel.request(channel.retryUrl(item.sessionId), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ groupId: item.groupId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.message || "重新识别失败");
      notify.success("已重新识别该卡");
      await onResolved(item.sessionId, item.groupId);
    } catch (err) {
      notify.error(err instanceof Error ? err.message : "重新识别失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <PanelShell title="其他失败" description={`第 ${Number(item.groupId) + 1} 组`}>
      <div className="flex items-start gap-2 rounded-md border border-warning-border bg-warning-soft px-3 py-2 text-sm text-warning-foreground">
        <TriangleAlert size={16} className="mt-0.5 shrink-0" />
        <span className="min-w-0 break-words">{item.failureMessage || "处理失败"}</span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void retry()}>重新识别此卡</Button>
        <CardCorrectionButton url={channel.correctionUrl(item.sessionId, item.groupId)} request={channel.request} disabled={busy}
          onSaved={() => onResolved(item.sessionId, item.groupId)} />
      </div>
    </PanelShell>
  );
}
