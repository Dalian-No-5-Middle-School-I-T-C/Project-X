import { useEffect, useMemo, useRef, useState } from "react";
import { Save } from "lucide-react";
import {
  Badge, Button, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
  Spinner, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableWrap,
} from "../ui/v2";
import { CorrectionCanvas } from "./CorrectionCanvas";
import type { PostprocessChannel } from "./postprocessChannel";
import { replaceScopedSelection } from "../../../../../shared/scanPostprocess";
import {
  correctionCells, correctionState, toggleCorrectionCell, type CorrectionCell, type CorrectionDocument, type CorrectionEdit,
} from "../../../../../shared/scanCorrection";
import { selectObjectiveOptionCells, selectScoreCells } from "../../../../../shared/correctionCellSelect";
import { findObjectiveQuestion, gradeCombinedRecognition, OBJECTIVE_REVIEW_CONFIDENCE_THRESHOLD } from "../../../../../shared/grading";
import { isMultiSelectMode, objectiveModeLabel } from "../../../../../shared/objectiveMode";
import type { CombinedRecognitionResult, SubjectiveQuestionNumber } from "../../../../../shared/types";

export interface PostprocessCorrectionViewProps {
  channel: PostprocessChannel;
  sessionId: string;
  groupId: string;
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

/** 卡面选项字母表：A..（optionCount） */
function optionLetters(count: number | undefined): string[] {
  return Array.from({ length: Math.max(0, count ?? 0) }, (_, index) => String.fromCharCode(65 + index));
}

/** 各页 recognition 拼成整份卡的识别结果（与本机按组判分同一口径）。 */
function mergeRecognitions(document: CorrectionDocument): CombinedRecognitionResult {
  const base = document.pages[0]?.recognition;
  const merged: CombinedRecognitionResult = {
    status: base?.status ?? "ok",
    studentId: base?.studentId ?? { status: "ok", value: null },
    questions: [],
    subjectiveQuestions: [],
  };
  for (const page of document.pages) {
    merged.questions.push(...(page.recognition.questions ?? []));
    merged.subjectiveQuestions.push(...(page.recognition.subjectiveQuestions ?? []));
  }
  return merged;
}

export function PostprocessCorrectionView({ channel, sessionId, groupId, highlightQuestion, onSaved }: PostprocessCorrectionViewProps) {
  const url = channel.correctionUrl(sessionId, groupId);
  const [document, setDocument] = useState<CorrectionDocument | null>(null);
  const [edits, setEdits] = useState<CorrectionEdit[]>([]);
  const [images, setImages] = useState<Record<string, string>>({});
  const [pageIndex, setPageIndex] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
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
  }, [url, channel]);

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
  // 当前页的即时状态（画布描边与错误提示用），整份卡的识别结果另由 merged 提供
  const state = document && page && edit ? correctionState(document.card, page, edit.selected, edit.touched) : null;
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

  const reviewQuestions = useMemo(() => {
    const set = new Set<SubjectiveQuestionNumber>();
    if (!liveMerged) return set;
    for (const q of liveMerged.questions ?? []) if ((q.confidence ?? 0) < OBJECTIVE_REVIEW_CONFIDENCE_THRESHOLD) set.add(q.questionNumber);
    for (const q of liveMerged.subjectiveQuestions ?? []) if (q.status !== "ok") set.add(q.questionNumber);
    return set;
  }, [liveMerged]);

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
    const subjective: Row[] = graded.subjectiveQuestions.map(q => {
      const origin = original.subjectiveQuestions?.find(o => o.questionId === q.questionId);
      // 分数格的 blockId 只在识别结果里，格选区必须按（题号 + 题块）收窄
      const blockId = liveMerged?.subjectiveQuestions?.find(o => o.questionId === q.questionId)?.blockId;
      return {
        questionNumber: q.questionNumber, kind: "subjective", questionId: q.questionId, blockId,
        typeLabel: "解答", score: q.score, maxScore: q.maxScore,
        recognized: origin ? String(origin.score) : "—", reviewed: q.status !== "ok" || q.needsReview,
        modified: origin ? origin.score !== q.score : false, options: [],
      };
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
    if (!document) return;
    if (!picked) { setMessage("该值在卡面上无法表示（缺少对应填涂格）"); return; }
    const scope = new Set(cells.filter(inScope).map(cell => cell.id));
    setEdits(replaceScopedSelection(edits, pageOfCell, scope, picked));
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
    const owns = (cell: CorrectionCell) => row.kind === "objective"
      ? cell.type === "objective_option" && cell.questionNumber === Number(row.questionNumber)
      : cell.type === "score_cell" && cell.questionId === row.questionId;
    const sourceId = cells.filter(owns).map(cell => pageOfCell.get(cell.id)).find(Boolean);
    const index = document?.pages.findIndex(p => p.sourceId === sourceId) ?? -1;
    if (index >= 0) setPageIndex(index);
  }

  function toggle(cellId: string) {
    if (!document || !page || busy) return;
    setEdits(current => current.map(e => e.sourceId === page.sourceId
      ? { ...e, selected: toggleCorrectionCell(document.card, page, e.selected, cellId), touched: page.invalid.includes(cellId) ? [...new Set([...(e.touched ?? []), cellId])] : e.touched }
      : e));
    setMessage("");
  }

  async function save() {
    setSaving(true);
    setMessage("");
    try {
      const response = await channel.request(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pages: edits }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "保存失败");
      await onSaved();
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
          <Button variant="primary" size="sm" icon={<Save />} disabled={!dirty || saving || errors.length > 0} loading={saving} onClick={() => void save()}>保存修改</Button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 gap-4 p-4">
        <div className="min-w-0 flex-1 overflow-auto rounded-md bg-muted p-3">
          <CorrectionCanvas document={document} pageIndex={pageIndex} edit={edit} images={images} zoom={zoom} busy={busy} reviewQuestions={reviewQuestions} onToggle={toggle} />
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
                    key={`${row.kind}-${row.questionNumber}-${row.questionId ?? ""}`}
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
                                <Button key={option} size="sm" variant={on ? "primary" : "outline"} className="h-6 px-2" aria-pressed={on}
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
          : errors.length
            ? <span className="text-destructive-fg">{[...new Set(errors)].slice(0, 3).join("；")}{errors.length > 3 ? "…" : ""}</span>
            : <span className="text-muted-foreground">{missing ? "此页缺少坐标数据，点选不可用；请在异常处理里重新识别该卡。" : dirty ? "修改尚未保存；左图点选与右表改分同步生效。" : "左图点填涂格改，右表按题改，两边同步。"}</span>}
      </div>
    </div>
  );
}
