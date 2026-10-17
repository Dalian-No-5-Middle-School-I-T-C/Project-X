import type { CorrectionCell } from "./scanCorrection";

type DigitCell = Extract<CorrectionCell, { type: "student_digit" }>;
type OptionCell = Extract<CorrectionCell, { type: "objective_option" }>;
type ScoreCell = Extract<CorrectionCell, { type: "score_cell" }>;

const EPS = 1e-9;

/** 客观题「修改」列（选项字母）→ 该题应选中的 option 格 id；出现卡面没有的选项返回 null。 */
export function selectObjectiveOptionCells(cells: CorrectionCell[], questionNumber: number, options: string[]): string[] | null {
  const available = cells.filter((c): c is OptionCell => c.type === "objective_option" && c.questionNumber === questionNumber);
  if (!available.length) return null;
  const wanted = new Set(options);
  const picked = available.filter(c => wanted.has(c.option));
  return picked.length === wanted.size ? picked.map(c => c.id) : null;
}

/**
 * 考号输入 → digit 格 id；位数与卡面不符或含非数字返回 null。
 * 位数必须逐列对齐：`correctionState` 要求每个 digitIndex 恰好选中一个数字，
 * 少一位会得到无法保存的「学号第 N 位需选择一个数字」。
 */
export function selectStudentDigitCells(cells: CorrectionCell[], digits: string): string[] | null {
  if (!/^\d+$/.test(digits)) return null;
  const digitCells = cells.filter((c): c is DigitCell => c.type === "student_digit");
  const indices = [...new Set(digitCells.map(c => c.digitIndex))].sort((a, b) => a - b);
  if (!indices.length || indices.length !== digits.length) return null;
  const picked: string[] = [];
  for (const [position, digitIndex] of indices.entries()) {
    const cell = digitCells.find(c => c.digitIndex === digitIndex && c.digit === Number(digits[position]));
    if (!cell) return null;
    picked.push(cell.id);
  }
  return picked;
}

/**
 * 主观题分数 → 分数格 id（`evaluateScoreCells` 的逆）。
 * 位规则与 scanCorrection.ts 的 place 判定一致：max<=16 单格 base；max>16 拆 tens/ones/fraction，每位至多一格。
 * 无法表示（超范围、非 0.5 步进、卡面无对应格）返回 null。
 */
export function selectScoreCells(
  cells: CorrectionCell[],
  questionId: string,
  blockId: string | undefined,
  score: number,
  maxScore: number,
): string[] | null {
  const available = cells.filter((c): c is ScoreCell => c.type === "score_cell" && c.questionId === questionId && (!blockId || c.blockId === blockId));
  if (!available.length) return null;
  if (score < -EPS || score > maxScore + EPS) return null;
  const fraction = Math.abs(score % 1 - 0.5) < EPS ? 0.5 : 0;
  if (Math.abs(score % 1 - fraction) > EPS) return null;
  const integer = Math.round(score - fraction);
  const pick = (value: number) => available.find(c => Math.abs(c.score - value) < EPS)?.id ?? null;
  if (maxScore <= 16) {
    const id = pick(score);
    return id ? [id] : null;
  }
  const tens = Math.floor(integer / 10) * 10;
  const ones = integer % 10;
  const picked: string[] = [];
  if (tens > 0) {
    const id = pick(tens);
    if (!id) return null;
    picked.push(id);
  }
  if (ones > 0 || (tens === 0 && fraction === 0)) {
    const id = pick(ones);
    if (!id) return null;
    picked.push(id);
  }
  if (fraction > 0) {
    const id = pick(fraction);
    if (!id) return null;
    picked.push(id);
  }
  return picked.length ? picked : null;
}
