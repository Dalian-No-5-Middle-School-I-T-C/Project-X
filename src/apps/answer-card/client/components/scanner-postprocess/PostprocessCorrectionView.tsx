import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Save } from "lucide-react";
import {
  Badge, Button, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
  Spinner, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableWrap, Tip,
} from "../ui/v2";
import { CorrectionCanvas } from "./CorrectionCanvas";
import { RotationButtons, type ImageRotation } from "../RotatedCardImage";
import type { PostprocessChannel } from "./postprocessChannel";
import { scannerUploadManager } from "../../lib/scannerUploadManager";
import { replaceScopedSelection } from "../../../../../shared/scanPostprocess";
import {
  correctionCells, correctionState, isUnconfirmedCorrectionCell, lowConfidenceTouchedIds, mergeRecognitions, toggleCorrectionCell,
  type CorrectionCell, type CorrectionDocument, type CorrectionEdit,
} from "../../../../../shared/scanCorrection";
import { matchesCorrectionFocus, selectObjectiveOptionCells, selectScoreCells } from "../../../../../shared/correctionCellSelect";
import { findObjectiveQuestion, gradeCombinedRecognition, gradeSubjectiveRecognition, OBJECTIVE_REVIEW_CONFIDENCE_THRESHOLD } from "../../../../../shared/grading";
import { isMultiSelectMode, objectiveModeLabel } from "../../../../../shared/objectiveMode";
import type { CombinedRecognitionResult, SubjectiveQuestionNumber } from "../../../../../shared/types";
import { clearCorrectionDraft, draftMatchesDocument, readCorrectionDraft, writeCorrectionDraft } from "../../lib/correctionDraft";

export interface PostprocessCorrectionViewProps {
  channel: PostprocessChannel;
  sessionId: string;
  groupId: string;
  /** 本组回执是否已入库：服务端 saveSessionCorrection 明确拒绝再改已入库卷（要转 Web 成绩修改） */
  initialSaved?: boolean;
  /** 远端上传模式只把订正写成草稿。本机 saved 不能锁住界面，也不能代替远端回执。 */
  draftOnly?: boolean;
  /** 从异常队列「去改这题」带过来的题号：挂载后把该行滚进视野 */
  highlightQuestion?: SubjectiveQuestionNumber | null;
  /** 放弃半成品续传成功后回调：调用方要清掉自己的「已入队」标记，否则改完不会再整卷上传 */
  onUploadAbandoned?: () => void;
  onSaved: () => void | Promise<void>;
}

interface Row {
  questionNumber: SubjectiveQuestionNumber;
  kind: "objective" | "subjective";
  questionId?: string;
  blockId?: string;
  typeLabel: string;
  score: number;
  maxScore: number;
  recognized: string;
  reviewed: boolean;
  modified: boolean;
  options: string[];
}

/** Radix Select 的 Item 不接受空串，未答用哨兵值表达。 */
const UNANSWERED = "__none__";

function markLowConfidenceConfirmation<T extends { sourceId: string; selected: string[]; touched?: string[] }>(
  document: CorrectionDocument,
  pages: T[],
  picked: readonly string[],
  scope: ReadonlySet<string>,
): T[] {
  return pages.map(pageEdit => {
    const page = document.pages.find(item => item.sourceId === pageEdit.sourceId);
    if (!page) return pageEdit;
    const extra = lowConfidenceTouchedIds([...scope], picked, id => isUnconfirmedCorrectionCell(page, id));
    if (!extra.length) return pageEdit;
    return { ...pageEdit, touched: [...new Set([...(pageEdit.touched ?? []), ...extra])] };
  });
}

/** 卡面选项字母表：A..（optionCount） */
function optionLetters(count: number | undefined): string[] {
  return Array.from({ length: Math.max(0, count ?? 0) }, (_, index) => String.fromCharCode(65 + index));
}

export function PostprocessCorrectionView({ channel, sessionId, groupId, initialSaved = false, draftOnly = false, highlightQuestion, onUploadAbandoned, onSaved }: PostprocessCorrectionViewProps) {
  const url = channel.correctionUrl(sessionId, groupId);
  const [document, setDocument] = useState<CorrectionDocument | null>(null);
  const [edits, setEdits] = useState<CorrectionEdit[]>([]);
  const [images, setImages] = useState<Record<string, string>>({});
  const [pageIndex, setPageIndex] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState<ImageRotation>(0);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  /** 保存成功且服务端已接纳入库：本组不能再从这里改（回执已是 saved，再 PUT 必被拒） */
  const [savedOnce, setSavedOnce] = useState(false);
  const locked = initialSaved || savedOnce;
  /** 保存成功后自增：服务端会 +1 revision，不重拉文档下次保存必被「答题卡已更新」拒绝 */
  const [loadTick, setLoadTick] = useState(0);
  /** 本次加载是否从本机草稿恢复：闪退/白屏后要明确告诉老师改动还在。 */
  const [draftRestored, setDraftRestored] = useState(false);
  /** null=没有待保存修改；true=本机草稿写入成功；false=写入失败，必须提示别重载。 */
  const [draftPersisted, setDraftPersisted] = useState<boolean | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  /** 保存成功后要迁到新 revision 草稿上的半截考号（考号面板输入、本编辑器不提交）。 */
  const pendingTypedRef = useRef<string | undefined>(undefined);
  /** 本组件创建的原卷 blob URL；切卷/卸载时统一回收，避免多页大图把渲染进程撑爆。 */
  const blobUrlsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    for (const url of blobUrlsRef.current) URL.revokeObjectURL(url);
    blobUrlsRef.current.clear();
    setBusy(true);
    setDocument(null);
    setImages({});
    void (async () => {
      try {
        const response = await channel.request(url);
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || "加载答题卡失败");
        const doc = data as CorrectionDocument;
        if (!alive) return;
        setDocument(doc);
        const baseEdits = doc.pages.map(p => ({ sourceId: p.sourceId, revision: p.revision, selected: [...p.selected], touched: [] }));
        const draft = readCorrectionDraft(doc.card.id, sessionId, groupId);
        if (draft && draftMatchesDocument(draft, doc)) {
          setEdits(draft.edits);
          setDraftRestored(true);
        } else {
          setEdits(baseEdits);
          setDraftRestored(false);
        }
        // 保存只提交格选，考号面板那份还没落到格上的原文得跟到新 revision 上，
        // 否则保存成功后 revision 一变，切回考号面板就找不到它了。
        if (pendingTypedRef.current !== undefined) {
          const typed = pendingTypedRef.current;
          pendingTypedRef.current = undefined;
          writeCorrectionDraft(doc.card.id, sessionId, groupId, doc, baseEdits, typed);
        }
        setDraftPersisted(null);
        setPageIndex(0);
      } catch (error) {
        if (alive) setMessage(error instanceof Error ? error.message : "加载失败");
      } finally {
        if (alive) setBusy(false);
      }
    })();
    return () => { alive = false; };
  }, [url, channel, loadTick, sessionId, groupId]);

  // 只按当前页取原图：一张 A4 300DPI 解码后约 35MB，整卷十几页同时留在内存里，
  // 异常卷一页页翻就可能把渲染进程顶到 OOM。切页时再取，离开时统一 revoke。
  const currentSourceId = document?.pages[pageIndex]?.sourceId ?? null;
  useEffect(() => {
    if (!document || !currentSourceId) return;
    // 同一时间只留当前页：翻过十几页也不把整卷解码图都攒在内存里。
    const stale = Object.keys(images).filter(sourceId => sourceId !== currentSourceId);
    if (stale.length) {
      for (const sourceId of stale) {
        const url = images[sourceId];
        if (url) { URL.revokeObjectURL(url); blobUrlsRef.current.delete(url); }
      }
      setImages(prev => (prev[currentSourceId] ? { [currentSourceId]: prev[currentSourceId] } : {}));
      return;
    }
    if (images[currentSourceId]) return;
    let alive = true;
    const page = document.pages.find(item => item.sourceId === currentSourceId);
    if (!page) return;
    void (async () => {
      try {
        const image = await channel.request(page.imageUrl);
        if (!image.ok) throw new Error("完整答题卡图片加载失败");
        const blob = URL.createObjectURL(await image.blob());
        if (!alive) { URL.revokeObjectURL(blob); return; }
        blobUrlsRef.current.add(blob);
        setImages(prev => (prev[currentSourceId] ? (URL.revokeObjectURL(blob), prev) : { ...prev, [currentSourceId]: blob }));
      } catch (error) {
        if (alive) setMessage(error instanceof Error ? error.message : "完整答题卡图片加载失败");
      }
    })();
    return () => { alive = false; };
  }, [document, currentSourceId, channel, images]);

  useEffect(() => () => {
    for (const url of blobUrlsRef.current) URL.revokeObjectURL(url);
    blobUrlsRef.current.clear();
  }, []);

  // 全部可编辑格与「格 → 所在页」索引：跨页改一题时只替换该题作用域内的格
  const cells = useMemo<CorrectionCell[]>(() => (document ? document.pages.flatMap(page => correctionCells(page.layout)) : []), [document]);
  const pageOfCell = useMemo(() => {
    const map = new Map<string, string>();
    if (!document) return map;
    for (const page of document.pages) for (const cell of correctionCells(page.layout)) map.set(cell.id, page.sourceId);
    return map;
  }, [document, cells]);

  const page = document?.pages[pageIndex];
  const edit = edits[pageIndex];
  const liveMerged = useMemo<CombinedRecognitionResult | null>(() => {
    if (!document) return null;
    const questions = [];
    const subjectiveQuestions = [];
    for (const [index, docPage] of document.pages.entries()) {
      const current = edits[index];
      if (!current) continue;
      const recognition = correctionState(document.card, docPage, current.selected, current.touched).recognition;
      questions.push(...(recognition.questions ?? []));
      subjectiveQuestions.push(...(recognition.subjectiveQuestions ?? []));
    }
    return { ...mergeRecognitions(document), questions, subjectiveQuestions };
  }, [document, edits]);

  const graded = useMemo(() => (document && liveMerged
    ? gradeCombinedRecognition(document.card, `后处理_${groupId}`, liveMerged, OBJECTIVE_REVIEW_CONFIDENCE_THRESHOLD)
    : null), [document, liveMerged, groupId]);

  // 复核题号直接取共享判分的结果：界面不再自己写一套「低置信度 = 存疑」判定，
  // 空白题、越界选项、整张卡没红笔这些口径都由 gradeCombinedRecognition 统一裁断。
  // 订阅上传进度：任务在途时每一页都现读本机订正，这时保存会让服务器收到半旧半新的快照。
  useSyncExternalStore(scannerUploadManager.subscribe, scannerUploadManager.getState);
  const uploadCardId = document?.card.id ?? null;
  const uploadBlock = scannerUploadManager.groupUploadBlock(uploadCardId, groupId, sessionId);
  const uploadBusy = uploadBlock !== null;
  const uploadResumable = uploadBlock === "partial-pages";

  const reviewQuestions = useMemo(() => {
    const set = new Set<SubjectiveQuestionNumber>();
    if (!graded) return set;
    for (const q of graded.questions) if (q.needsReview) set.add(q.questionNumber);
    for (const q of graded.subjectiveQuestions) if (q.needsReview) set.add(q.questionNumber);
    return set;
  }, [graded]);

  const rows = useMemo<Row[]>(() => {
    if (!document || !graded) return [];
    const original = mergeRecognitions(document);
    const objective: Row[] = graded.questions.map(q => {
      const definition = findObjectiveQuestion(document.card, q.questionNumber)?.definition;
      const origin = original.questions?.find(o => o.questionNumber === q.questionNumber);
      return {
        questionNumber: q.questionNumber, kind: "objective", typeLabel: objectiveModeLabel(definition?.mode ?? "single"),
        score: q.score, maxScore: q.maxScore, recognized: (origin?.selectedOptions ?? []).join(",") || "—",
        reviewed: q.needsReview, modified: [...(origin?.selectedOptions ?? [])].sort().join() !== [...q.selectedOptions].sort().join(),
        options: optionLetters(definition?.optionCount),
      };
    });
    // 主观题按「题块」逐条出行：同一 questionId 可能出现在多个题块上，
    // 用 graded.subjectiveQuestions（无 blockId）反查会把两块的分数格混在一起
    const subjective: Row[] = (liveMerged?.subjectiveQuestions ?? []).flatMap(entry => {
      const grade = gradeSubjectiveRecognition(document.card, entry);
      if (!grade) return [];
      const origin = original.subjectiveQuestions?.find(o => o.questionId === grade.questionId && o.blockId === entry.blockId);
      return [{
        questionNumber: grade.questionNumber, kind: "subjective" as const, questionId: grade.questionId, blockId: entry.blockId,
        typeLabel: "解答", score: grade.score, maxScore: grade.maxScore,
        recognized: origin ? String(origin.score) : "—", reviewed: grade.status !== "ok" || grade.needsReview,
        modified: origin ? origin.score !== grade.score : false, options: [],
      }];
    });
    return [...objective, ...subjective].sort((a, b) => Number(a.questionNumber) - Number(b.questionNumber)
      || (a.kind === b.kind ? 0 : a.kind === "objective" ? -1 : 1));
  }, [document, graded, liveMerged, groupId]);

  const errors = useMemo(() => {
    if (!document) return [];
    return document.pages.flatMap((docPage, index) => correctionState(document.card, docPage,
      edits[index]?.selected ?? docPage.selected, edits[index]?.touched).errors);
  }, [document, edits]);

  const dirty = !!document && edits.some((current, index) => {
    const origin = document.pages[index];
    return [...origin.selected].sort().join() !== [...current.selected].sort().join() || !!current.touched?.length;
  });

  // 每次改动立刻落本机草稿：闪退/白屏不会等到 debounce 才丢。页 revision 不符时不写新草稿，
  // 由加载阶段 decide 是否恢复；保存成功后由 save() 清掉。
  useEffect(() => {
    if (!document || busy || locked || edits.length !== document.pages.length) return;
    // 考号面板和这里共用同一个草稿键：老师手输的考号（含主动清空的空串）不能因为
    // 「这个编辑器没有格选改动」就被当成空草稿删掉，否则切回考号面板就丢了。
    const existing = readCorrectionDraft(document.card.id, sessionId, groupId);
    const carriedTyped = existing && draftMatchesDocument(existing, document) ? existing.typed : undefined;
    if (!dirty) {
      if (carriedTyped !== undefined) return;
      clearCorrectionDraft(document.card.id, sessionId, groupId);
      setDraftRestored(false);
      setDraftPersisted(null);
      return;
    }
    setDraftPersisted(writeCorrectionDraft(document.card.id, sessionId, groupId, document, edits, carriedTyped));
  }, [document, edits, dirty, busy, locked, sessionId, groupId]);

  const missing = document?.pages.some(p => !p.recognition.geometry) ?? false;

  /**
   * 把一题的新格选写回 edits：只替换该题作用域内的格，其余格（学号、别的题）原样保留。
   */
  function applyCells(picked: string[] | null, inScope: (cell: CorrectionCell) => boolean) {
    if (!document || locked) return;
    if (!picked) { setMessage("该值在卡面上无法表示（缺少对应填涂格）"); return; }
    const scope = new Set(cells.filter(inScope).map(cell => cell.id));
    // 走 setEdits 的函数式形式：同一渲染批次里连续改两题时，读渲染时值的闭包会丢掉前一次
    setEdits(current => markLowConfidenceConfirmation(document, replaceScopedSelection(current, pageOfCell, scope, picked), picked, scope));
    setMessage("");
  }

  function setObjectiveAnswer(row: Row, options: string[]) {
    applyCells(selectObjectiveOptionCells(cells, Number(row.questionNumber), options),
      cell => cell.type === "objective_option" && cell.questionNumber === Number(row.questionNumber));
  }

  function setSubjectiveScore(row: Row, score: number) {
    if (!row.questionId) return;
    applyCells(selectScoreCells(cells, row.questionId, row.blockId, score, row.maxScore),
      cell => cell.type === "score_cell" && cell.questionId === row.questionId && (!row.blockId || cell.blockId === row.blockId));
  }

  /** 行点击：把画布翻到该题所在的页 */
  function focusRow(row: Row) {
    const sourceId = cells.filter(cell => matchesCorrectionFocus(cell, row)).map(cell => pageOfCell.get(cell.id)).find(Boolean);
    const index = document?.pages.findIndex(p => p.sourceId === sourceId) ?? -1;
    if (index >= 0) setPageIndex(index);
  }

  function toggle(cellId: string) {
    if (!document || !page || busy || locked) return;
    const confirm = page.invalid.includes(cellId) || isUnconfirmedCorrectionCell(page, cellId);
    setEdits(current => current.map(e => e.sourceId === page.sourceId
      ? { ...e, selected: toggleCorrectionCell(document.card, page, e.selected, cellId), touched: confirm ? [...new Set([...(e.touched ?? []), cellId])] : e.touched }
      : e));
    setMessage("");
  }

  async function save() {
    setSaving(true);
    setMessage("");
    try {
      const response = await channel.request(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pages: edits, ...(draftOnly ? { draft: true } : {}) }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "保存失败");
      // 考号面板的半截输入不在这次提交里：先记下来，重拉文档后按新 revision 写回草稿。
      const carriedTyped = document
        ? (() => {
          const existing = readCorrectionDraft(document.card.id, sessionId, groupId);
          return existing && draftMatchesDocument(existing, document) ? existing.typed : undefined;
        })()
        : undefined;
      if (document) clearCorrectionDraft(document.card.id, sessionId, groupId);
      if (carriedTyped !== undefined) pendingTypedRef.current = carriedTyped;
      setDraftRestored(false);
      setDraftPersisted(null);
      // 只有本机正式入库才锁。远端模式的草稿保存即使带回 saved，也还要等上传，不能把界面锁死。
      if (result.saved && !draftOnly) setSavedOnce(true);
      else if (typeof result.message === "string" && result.message) setMessage(result.message);
      await onSaved();
      // 重拉文档同步 revision，并把「未保存」状态归零
      setLoadTick(tick => tick + 1);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    if (highlightQuestion === null || highlightQuestion === undefined || !document) return;
    const target = tableRef.current?.querySelector(`[data-question="${String(highlightQuestion)}"]`);
    target?.scrollIntoView({ block: "center" });
  }, [highlightQuestion, document]);

  if (busy && !document) return <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"><Spinner /> 正在加载答题卡…</div>;
  if (!document || !page || !edit || !graded) return <div className="flex flex-1 items-center justify-center text-sm text-destructive-fg">{message || "加载失败"}</div>;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-border-subtle bg-card px-4 py-2 text-sm">
        <span className="tabular-nums">客观题 <b>{graded.objectiveScore}</b>
          <span className="text-muted-foreground">/{graded.objectiveMaxScore}</span>
          {" · 主观题 "}<b>{graded.subjectiveScore}</b>
          <span className="text-muted-foreground">/{graded.subjectiveMaxScore}</span>
          {" · 总分 "}<b>{graded.totalScore}</b>
          <span className="text-muted-foreground">/{graded.totalMaxScore}</span></span>
        {draftRestored && dirty && <Badge tone="info" dot>已恢复本机草稿</Badge>}
        {missing && <Badge tone="warning" dot>缺坐标</Badge>}
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={pageIndex === 0 || saving} onClick={() => setPageIndex(i => i - 1)}>上一页</Button>
          <span className="tabular-nums">{pageIndex + 1} / {document.pages.length}</span>
          <Button size="sm" variant="outline" disabled={pageIndex === document.pages.length - 1 || saving} onClick={() => setPageIndex(i => i + 1)}>下一页</Button>
          <Button size="sm" variant="outline" disabled={zoom <= 1} onClick={() => setZoom(z => Math.max(1, z - 0.5))}>缩小</Button>
          <span className="tabular-nums">{Math.round(zoom * 100)}%</span>
          <Button size="sm" variant="outline" disabled={zoom >= 4} onClick={() => setZoom(z => Math.min(4, z + 0.5))}>放大</Button>
          <RotationButtons rotation={rotation} onChange={setRotation} disabled={saving} />
          {uploadBusy ? (
            <Tip label={uploadBlock === "recovery-damaged"
              ? "本机上传恢复记录已损坏，读不出远端会话与逐页进度；这一卷可能已经入库，保存或重传都会改写正式成绩。请先在服务器核对原上传会话，再点「已核对服务器，清除损坏记录」"
              : uploadBlock === "completion-pending"
              ? "这一卷的页面都已上传、只差提交（重复学号这类冲突是服务器拒的）；现在保存会让服务器收到半旧半新的识别结果，请先「重试保存」或处理冲突卷"
              : uploadResumable
              ? "这一卷已上传一部分、还有失败页可续传；现在保存会让服务器收到半旧半新的识别结果。请先重试失败页，或点「放弃续传」后再保存"
              : "这一卷正在上传；现在保存会让服务器收到半旧半新的识别结果，请等它传完或先取消任务"}>
              <Button variant="primary" size="sm" icon={<Save />} disabled loading>保存修改</Button>
            </Tip>
          ) : (
            <Button variant="primary" size="sm" icon={<Save />} disabled={!dirty || saving || errors.length > 0 || locked} loading={saving} onClick={() => void save()}>保存修改</Button>
          )}
          {uploadResumable && uploadCardId && (
            <Button size="sm" variant="outline" onClick={() => {
              if (!window.confirm("放弃续传后，已上传的半成品不再补传，这一卷可以立即改分（改完请整卷重新上传）。服务器上的半成品会话不会写入成绩。确定放弃吗？")) return;
              const result = scannerUploadManager.abandonGroupUpload(uploadCardId, groupId, sessionId);
              if (!result.ok) { setMessage(result.message); return; }
              // 调用方的「已入队」标记必须一起清掉：留着它，改完的整卷再也不会被排进上传队列。
              onUploadAbandoned?.();
              setMessage("已放弃这一卷的续传，现在可以改分；保存后这一卷会整卷重新上传。");
            }}>放弃续传</Button>
          )}
          {uploadBlock === "recovery-damaged" && uploadCardId && (
            <Button size="sm" variant="outline" onClick={() => {
              const remoteSessionId = scannerUploadManager.damagedRecoverySessionId(uploadCardId, groupId, sessionId);
              if (!window.confirm(`本机上传恢复记录已损坏，无法确认这一卷在服务器上是否已经入库${remoteSessionId ? `（原上传会话 ${remoteSessionId}）` : ""}。请先在成绩或异常卷列表里核对那一份：确认没有已保存的成绩之后，再清除本机记录；清除后这一卷会按新会话重新上传。确定已经核对过吗？`)) return;
              const result = scannerUploadManager.discardDamagedRecovery(uploadCardId, groupId, sessionId);
              if (!result.ok) { setMessage(result.message); return; }
              onUploadAbandoned?.();
              setMessage("已清除损坏的恢复记录；请先把这一卷的填涂核对确认，再整卷重新上传。");
            }}>已核对服务器，清除损坏记录</Button>
          )}
        </div>
      </div>
      <div className="flex min-h-0 flex-1 gap-4 p-4">
        <div className="min-w-0 flex-1 overflow-auto rounded-md bg-muted p-3">
          {!images[page.sourceId] && <div className="flex min-h-[220px] items-center justify-center gap-2 text-sm text-muted-foreground"><Spinner /> 正在加载原卷…</div>}
          <CorrectionCanvas document={document} pageIndex={pageIndex} edit={edit} images={images} zoom={zoom} rotation={rotation} busy={busy || locked} reviewQuestions={reviewQuestions} onToggle={toggle} />
        </div>
        <div ref={tableRef} className="min-w-0 flex-1 overflow-auto">
          <TableWrap>
            <Table className="text-sm">
              <TableHeader>
                <TableRow>
                  <TableHead>题号</TableHead>
                  <TableHead>类型</TableHead>
                  <TableHead numeric>得分/满分</TableHead>
                  <TableHead>识别</TableHead>
                  <TableHead className="w-40">修改</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...rows].sort((a, b) => Number(b.reviewed) - Number(a.reviewed)).map(row => (
                  <TableRow
                    key={`${row.kind}-${row.questionNumber}-${row.questionId ?? ""}-${row.blockId ?? ""}`}
                    data-question={String(row.questionNumber)}
                    selected={row.modified}
                    clickable
                    onClick={() => focusRow(row)}
                    className={row.reviewed ? "bg-warning-soft" : undefined}
                  >
                    <TableCell className="font-medium tabular-nums">{row.questionNumber}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{row.typeLabel}</TableCell>
                    <TableCell numeric>
                      <span className={row.modified ? "text-primary" : undefined}>{row.score}</span>
                      <span className="text-muted-foreground">/{row.maxScore}</span>
                    </TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">
                      {row.recognized}
                      {row.reviewed && <Badge tone="warning" dot className="ml-2">存疑</Badge>}
                      {row.modified && <Badge tone="accent" className="ml-2">已改</Badge>}
                    </TableCell>
                    <TableCell onClick={e => e.stopPropagation()}>
                      {row.kind === "objective" ? (
                        isMultiSelectMode(findObjectiveQuestion(document.card, Number(row.questionNumber))?.definition.mode ?? "single") ? (
                          <div className="flex flex-wrap gap-1">
                            {row.options.map(option => {
                              const now = liveMerged?.questions?.find(q => q.questionNumber === Number(row.questionNumber))?.selectedOptions ?? [];
                              const on = now.includes(option);
                              return (
                                <Button key={option} size="sm" variant={on ? "primary" : "outline"} className="px-2" aria-pressed={on}
                                  onClick={() => setObjectiveAnswer(row, on ? now.filter(o => o !== option) : [...now, option])}>
                                  {option}
                                </Button>
                              );
                            })}
                          </div>
                        ) : (
                          <Select
                            value={liveMerged?.questions?.find(q => q.questionNumber === Number(row.questionNumber))?.selectedOptions[0] ?? UNANSWERED}
                            onValueChange={value => setObjectiveAnswer(row, value === UNANSWERED ? [] : [value])}
                          >
                            <SelectTrigger className="h-control-sm w-24 text-sm tabular-nums" aria-label={`第 ${row.questionNumber} 题选项`}>
                              <SelectValue placeholder="未答" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={UNANSWERED}>未答</SelectItem>
                              {row.options.map(option => <SelectItem key={option} value={option}>{option}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        )
                      ) : (
                        <Input
                          type="number" min={0} max={row.maxScore} step={0.5} value={row.score} className="h-control-sm w-20 text-sm tabular-nums"
                          onChange={e => {
                            const value = Number(e.target.value);
                            if (Number.isFinite(value)) setSubjectiveScore(row, value);
                          }}
                          aria-label={`第 ${row.questionNumber} 题得分`}
                        />
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableWrap>
        </div>
      </div>
      <div role="status" className="border-t border-border-subtle bg-card px-4 py-2 text-sm">
        {message
          ? <span className="text-destructive-fg">{message}</span>
          : locked
            ? <span className="text-muted-foreground">本卷成绩已入库，不能再从扫描端改；后续改分请到 Web 端「成绩修改」，或重扫该卷由服务器重新判分。</span>
            : errors.length
            ? <span className="text-destructive-fg">{[...new Set(errors)].slice(0, 3).join("；")}{errors.length > 3 ? "…" : ""}</span>
            : <span className="text-muted-foreground">{missing ? "此页缺少坐标数据，点选不可用；请在异常处理里重新识别该卡。" : dirty ? (draftPersisted === false ? "修改尚未保存，本机草稿保存失败；请尽快点击「保存修改」，不要直接关闭或重载。" : "修改尚未保存，已自动存本机草稿；左图点选与右表改分同步生效。") : "左图点填涂格改，右表按题改，两边同步。"}</span>}
      </div>
    </div>
  );
}
