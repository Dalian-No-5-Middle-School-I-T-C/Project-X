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

export function PostprocessCorrectionView({ channel, sessionId, groupId, initialSaved = false, draftOnly = false, highlightQuestion, onSaved }: PostprocessCorrectionViewProps) {
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
  const tableRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    const blobs: string[] = [];
    setBusy(true);
    setDocument(null);
    void (async () => {
      try {
        const response = await channel.request(url);
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || "加载答题卡失败");
        const doc = data as CorrectionDocument;
        const loaded: Record<string, string> = {};
        for (const page of doc.pages) {
          const image = await channel.request(page.imageUrl);
          if (!image.ok) throw new Error("完整答题卡图片加载失败");
          const blob = URL.createObjectURL(await image.blob());
          if (!alive) { URL.revokeObjectURL(blob); return; }
          blobs.push(blob);
          loaded[page.sourceId] = blob;
        }
        if (!alive) return;
        setDocument(doc);
        setImages(loaded);
        setEdits(doc.pages.map(p => ({ sourceId: p.sourceId, revision: p.revision, selected: [...p.selected], touched: [] })));
        setPageIndex(0);
      } catch (error) {
        if (alive) setMessage(error instanceof Error ? error.message : "加载失败");
      } finally {
        if (alive) setBusy(false);
      }
    })();
    return () => { alive = false; blobs.forEach(blob => URL.revokeObjectURL(blob)); };
  }, [url, channel, loadTick]);

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
  const uploadBusy = scannerUploadManager.isGroupUploading(document?.card.id ?? null, groupId, sessionId);

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
            <Tip label="这一卷正在上传，等它完成后再保存；中途改分会让服务器收到半旧半新的识别结果">
              <Button variant="primary" size="sm" icon={<Save />} disabled loading>保存修改</Button>
            </Tip>
          ) : (
            <Button variant="primary" size="sm" icon={<Save />} disabled={!dirty || saving || errors.length > 0 || locked} loading={saving} onClick={() => void save()}>保存修改</Button>
          )}
        </div>
      </div>
      <div className="flex min-h-0 flex-1 gap-4 p-4">
        <div className="min-w-0 flex-1 overflow-auto rounded-md bg-muted p-3">
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
            : <span className="text-muted-foreground">{missing ? "此页缺少坐标数据，点选不可用；请在异常处理里重新识别该卡。" : dirty ? "修改尚未保存；左图点选与右表改分同步生效。" : "左图点填涂格改，右表按题改，两边同步。"}</span>}
      </div>
    </div>
  );
}
