import { findObjectiveQuestion } from "./grading";
import { isMultiSelectMode } from "./objectiveMode";
import type { AnswerCard, CombinedRecognitionResult, LayoutElement, PageLayout, Rect } from "./types";

export type CorrectionCell = Extract<LayoutElement, { type: "student_digit" | "objective_option" | "score_cell" }>;
export type CorrectionPage = {
  sourceType: "scan_record" | "twain_scan_record";
  sourceId: string;
  revision: number;
  layout: PageLayout;
  recognition: CombinedRecognitionResult;
  selected: string[];
  invalid: string[];
  imageUrl: string;
  recovery?: { fingerprint: string; identityMode: "strict" | "legacy"; dpi: number; signature?: string };
};
export type CorrectionDocument = { card: AnswerCard; pages: CorrectionPage[]; version: string };
export type CorrectionEdit = { sourceId: string; revision: number; selected: string[]; touched?: string[]; recovery?: { fingerprint: string; signature?: string; recognition: CombinedRecognitionResult } };
export function correctionCells(page: PageLayout): CorrectionCell[] {
  return page.elements.filter((e): e is CorrectionCell => ["student_digit", "objective_option", "score_cell"].includes(e.type));
}
const sameRect = (a: Rect | undefined, b: Rect) => a && Math.abs(a.x - b.x) < .01 && Math.abs(a.y - b.y) < .01;
export function recognizedCells(layout: PageLayout, recognition: CombinedRecognitionResult) {
  const selected: string[] = [], invalid: string[] = [];
  for (const cell of correctionCells(layout)) {
    if (cell.type === "student_digit") {
      const digit = (recognition.studentId?.digits as Array<{ digitIndex: number; selectedDigit?: number; selectedDigits?: number[] }> | undefined)?.find(d => d.digitIndex === cell.digitIndex);
      const digits = digit?.selectedDigits ?? (digit?.selectedDigit != null ? [digit.selectedDigit] : []);
      if (digits.includes(cell.digit) || (!digit && recognition.studentId?.value?.[cell.digitIndex] === String(cell.digit))) selected.push(cell.id);
      if (digits.length > 1 && digits.includes(cell.digit)) invalid.push(cell.id);
    } else if (cell.type === "objective_option") {
      if (recognition.questions?.find(q => q.questionNumber === cell.questionNumber)?.selectedOptions.includes(cell.option)) selected.push(cell.id);
    } else {
      const q = recognition.subjectiveQuestions?.find(q => q.questionId === cell.questionId && (!q.blockId || q.blockId === cell.blockId));
      const matches = (v: { score: number; rect?: Rect }) => v.rect ? sameRect(v.rect, cell.rect) : v.score === cell.score;
      if (q?.validCells.some(matches) || q?.invalidCells.some(matches)) selected.push(cell.id);
      if (q?.invalidCells.some(matches)) invalid.push(cell.id);
    }
  }
  return { selected, invalid };
}
export function toggleCorrectionCell(card: AnswerCard, page: CorrectionPage, selected: string[], id: string): string[] {
  const cells = correctionCells(page.layout), cell = cells.find(c => c.id === id);
  if (!cell) return selected;
  // An unanswered question is valid; a student-number digit must stay selected.
  if (cell.type === "objective_option" && selected.includes(id)) return selected.filter(key => key !== id);
  const exclusive = cell.type === "student_digit" || (cell.type === "objective_option" && !isMultiSelectMode(findObjectiveQuestion(card, cell.questionNumber)?.definition.mode ?? "single"));
  if (exclusive) return [...selected.filter(key => {
    const c = cells.find(c => c.id === key);
    return !(c?.type === "student_digit" && cell.type === "student_digit" && c.digitIndex === cell.digitIndex)
      && !(c?.type === "objective_option" && cell.type === "objective_option" && c.questionNumber === cell.questionNumber);
  }), id];
  return selected.includes(id) ? selected.filter(key => key !== id) : [...selected, id];
}

/** Same score-grid arithmetic as native build_subjective_questions; identifies the conflicting place only. */
export function evaluateScoreCells(cells: Array<Extract<CorrectionCell, { type: "score_cell" }>>, max: number) {
  const invalid = new Set<string>();
  const groups = new Map<string, typeof cells>();
  for (const cell of cells) {
    const value = cell.score;
    const place = value === .5 ? "fraction" : max > 16 && value >= 10 && value % 10 === 0 ? "tens"
      : max > 16 && Number.isInteger(value) && value >= 0 && value <= 9 ? "ones" : max <= 16 ? "base" : "invalid";
    const group = groups.get(place) ?? []; group.push(cell); groups.set(place, group);
  }
  for (const [place, group] of groups) if (place === "invalid" || group.length > 1) for (const c of group) invalid.add(c.id);
  const score = cells.filter(c => !invalid.has(c.id)).reduce((sum, c) => sum + c.score, 0);
  if (score > max + .001) for (const c of cells) invalid.add(c.id);
  return { score: invalid.size ? 0 : score, invalid, valid: cells.length > 0 && invalid.size === 0 };
}
export function correctionState(card: AnswerCard, page: CorrectionPage, selected: string[], touched: string[] = []) {
  const cells = correctionCells(page.layout), chosen = cells.filter(c => selected.includes(c.id));
  const invalid = new Set(page.invalid.filter(id => selected.includes(id) && page.selected.includes(id) && !touched.includes(id)));
  const recognition: CombinedRecognitionResult = JSON.parse(JSON.stringify(page.recognition));
  const errors: string[] = [];
  const digitIndices = [...new Set(cells.filter(c => c.type === "student_digit").map(c => c.digitIndex))].sort((a,b) => a-b);
  if (digitIndices.length) {
    const digits = digitIndices.map(digitIndex => {
      const hits = chosen.filter(c => c.type === "student_digit" && c.digitIndex === digitIndex);
      if (hits.length !== 1) { errors.push(`学号第 ${digitIndex + 1} 位需选择一个数字`); hits.forEach(c => invalid.add(c.id)); }
      return { digitIndex, selectedDigits: hits.map(c => (c as Extract<CorrectionCell, {type:"student_digit"}>).digit), selectedDigit: hits.length === 1 ? (hits[0] as Extract<CorrectionCell, {type:"student_digit"}>).digit : null };
    });
    recognition.studentId = { status: errors.length ? "failed" : "ok", value: errors.length ? null : digits.map(d => d.selectedDigit).join(""), digits };
  }
  recognition.questions = (recognition.questions ?? []).map(q => {
    const available = cells.filter(c => c.type === "objective_option" && c.questionNumber === q.questionNumber);
    if (!available.length) return q;
    const hits = chosen.filter((c): c is Extract<CorrectionCell,{type:"objective_option"}> => c.type === "objective_option" && c.questionNumber === q.questionNumber);
    const def = findObjectiveQuestion(card,q.questionNumber)?.definition;
    if (!isMultiSelectMode(def?.mode ?? "single") && hits.length > 1) { hits.forEach(c => invalid.add(c.id)); errors.push(`第 ${q.questionNumber} 题为单选`); }
    for (const c of hits) if (def?.answerKey?.length && !def.answerKey.includes(c.option)) invalid.add(c.id);
    const changed = hits.map(c => c.option).sort().join() !== [...q.selectedOptions].sort().join();
    // 老师点过这些格（含「点掉再点回原答案」）即是确认：低置信度不能因为选项没变就一直停在复核阈值下。
    const confirmed = hits.some(c => touched.includes(c.id));
    return { ...q, selectedOptions: hits.map(c => c.option), confidence: changed || confirmed ? 1 : q.confidence };
  });
  recognition.subjectiveQuestions = (recognition.subjectiveQuestions ?? []).map(q => {
    const all = cells.filter((c): c is Extract<CorrectionCell,{type:"score_cell"}> => c.type === "score_cell" && c.questionId === q.questionId && (!q.blockId || c.blockId === q.blockId));
    if (!all.length) return q; // Online-reviewed questions have no editable score grid.
    const hits = all.filter(c => selected.includes(c.id));
    const evaluated = evaluateScoreCells(hits, q.maxScore);
    evaluated.invalid.forEach(id => invalid.add(id));
    const bad = hits.filter(c => invalid.has(c.id));
    if (!evaluated.valid || bad.length) errors.push(`第 ${q.questionNumber} 题分数格无效`);
    const toCell = (c: typeof hits[number]) => ({ blockId: c.blockId, questionId: c.questionId, questionNumber: c.questionNumber, score: c.score, rect: c.rect });
    return { ...q, score: evaluated.score, status: evaluated.valid && !bad.length ? "ok" : "invalid", confidence: 1,
      validCells: hits.filter(c => !invalid.has(c.id)).map(toCell), invalidCells: bad.map(toCell) };
  });
  return { invalid, recognition, errors };
}
export function projectRect(rect: Rect, matrix: number[]): string {
  return [[rect.x,rect.y],[rect.x+rect.width,rect.y],[rect.x+rect.width,rect.y+rect.height],[rect.x,rect.y+rect.height]].map(([x,y]) => {
    const z = matrix[6]*x + matrix[7]*y + matrix[8];
    return `${(matrix[0]*x+matrix[1]*y+matrix[2])/z},${(matrix[3]*x+matrix[4]*y+matrix[5])/z}`;
  }).join(" ");
}
