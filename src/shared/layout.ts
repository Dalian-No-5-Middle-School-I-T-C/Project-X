import type {
  AnswerCard,
  BodyBlock,
  EssayGridConfig,
  LayoutDocument,
  LayoutElement,
  ObjectiveBlock,
  ObjectiveDensity,
  PageLayout,
  PageRenderBlock,
  Rect,
  StudentAreaLayout,
  SubjectiveBlock,
  SubjectiveQuestion
} from "./types";
import { formatBlankLabel } from "./blankLabels";
import { DEFAULT_STUDENT_NOTES } from "./defaultCard";
import { objectiveQuestionDefinitions, type ObjectiveQuestionDefinition } from "./grading";

let PAGE_WIDTH = 210;
let PAGE_HEIGHT = 297;
const OUTER_MARGIN_X = 17;
let MARGIN_X = OUTER_MARGIN_X;
const TOP_MARGIN = 14;
const BOTTOM_MARGIN = 18;
let BODY_WIDTH = PAGE_WIDTH - MARGIN_X * 2;
const A3_PANEL_GAP = 8;
let IS_A3 = false;
let IS_LAYOUT_V2 = false;
let ACTIVE_WARNINGS: string[] = [];
const OPTIONS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

type DensitySettings = {
  maxColumns: number;
  rowHeight: number;
  optionGap: number;
  optionWidth: number;
  optionHeight: number;
  questionGap: number;
};

type BlankLineSpec = { label: string; widthMm: number; heightMm: number; rightAnnotation?: string };
type PlacedBlankLine = BlankLineSpec & { rect: Rect };

const DENSITY: Record<ObjectiveDensity, DensitySettings> = {
  loose: { maxColumns: 4, rowHeight: 7.7, optionGap: 8.1, optionWidth: 5.1, optionHeight: 3.0, questionGap: 6.4 },
  normal: { maxColumns: 4, rowHeight: 6.7, optionGap: 7.4, optionWidth: 4.8, optionHeight: 2.8, questionGap: 5.6 },
  compact: { maxColumns: 5, rowHeight: 5.9, optionGap: 6.7, optionWidth: 4.4, optionHeight: 2.5, questionGap: 4.8 },
  dense: { maxColumns: 6, rowHeight: 5.2, optionGap: 6.0, optionWidth: 4.1, optionHeight: 2.3, questionGap: 4.2 }
};
const OBJECTIVE_SETTINGS = DENSITY.compact;
const OBJECTIVE_FRAME_TOP = 6.2;
const OBJECTIVE_INNER_TOP = 1.4;
const OBJECTIVE_INNER_BOTTOM = 1.0;
const OBJECTIVE_ROW_MARKER_SIZE = 2.2;
const OBJECTIVE_OPTION_TOP_OFFSET = 0.9;
const OBJECTIVE_CONTENT_SIDE_INSET = 8.5;
const OBJECTIVE_LABEL_TO_OPTION_GAP = 6.3;
let OBJECTIVE_STANDARD_COLUMNS = 4;
const OBJECTIVE_GRID_CELL_QUESTIONS = 5;
const OBJECTIVE_VERTICAL_GROUP_QUESTIONS = 4;
const OBJECTIVE_WIDE_OPTION_THRESHOLD = 5;
const OBJECTIVE_GRID_ROW_GAP = 0.4;

type ObjectiveArrangementMode = "rows" | "grid" | "vertical-grid";

type ObjectiveRow =
  | { type: "standard"; questions: ObjectiveQuestionDefinition[] }
  | { type: "grid"; cells: ObjectiveQuestionDefinition[][] }
  | { type: "wide"; question: ObjectiveQuestionDefinition };

function rect(x: number, y: number, width: number, height: number): Rect {
  return { x: round(x), y: round(y), width: round(width), height: round(height) };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function markerRects(): Array<{ role: string; rect: Rect }> {
  const w = 2.6;
  const heightFor = (role: "top" | "middle" | "bottom") => {
    if (!IS_A3) return 7;
    if (role === "middle") return 5.5;
    if (role === "bottom") return 9;
    return 7;
  };
  return [
    { role: "top-left", rect: rect(OUTER_MARGIN_X - 4.5, 21, w, heightFor("top")) },
    { role: "top-right", rect: rect(PAGE_WIDTH - OUTER_MARGIN_X + 1.9, 21, w, heightFor("top")) },
    { role: "middle-left", rect: rect(OUTER_MARGIN_X - 4.5, 163, w, heightFor("middle")) },
    { role: "middle-right", rect: rect(PAGE_WIDTH - OUTER_MARGIN_X + 1.9, 163, w, heightFor("middle")) },
    { role: "bottom-left", rect: rect(OUTER_MARGIN_X - 4.5, PAGE_HEIGHT - 35, w, heightFor("bottom")) },
    { role: "bottom-right", rect: rect(PAGE_WIDTH - OUTER_MARGIN_X + 1.9, PAGE_HEIGHT - 35, w, heightFor("bottom")) }
  ];
}

function pagePanels(): PageLayout["panels"] {
  if (!IS_A3) {
    return [{ index: 0, role: "single", rect: rect(OUTER_MARGIN_X, 0, PAGE_WIDTH - OUTER_MARGIN_X * 2, PAGE_HEIGHT) }];
  }
  const width = (PAGE_WIDTH - OUTER_MARGIN_X * 2 - A3_PANEL_GAP * 2) / 3;
  return (["left", "middle", "right"] as const).map((role, index) => ({
    index,
    role,
    rect: rect(OUTER_MARGIN_X + index * (width + A3_PANEL_GAP), 0, width, PAGE_HEIGHT)
  }));
}

function activatePanel(panel: PageLayout["panels"][number]): void {
  MARGIN_X = panel.rect.x;
  BODY_WIDTH = panel.rect.width;
  OBJECTIVE_STANDARD_COLUMNS = IS_A3 ? 3 : 4;
}

function createPage(card: AnswerCard, pageNumber: number, includeTitle: boolean): PageLayout {
  const panels = pagePanels();
  const headerPanel = panels[0].rect;
  const codeBoxes = Array.from({ length: 6 }, (_, index) => rect(headerPanel.x + 41 + index * 6.1, 22, 4.8, 3.4));
  const markers = markerRects();
  const elements: LayoutElement[] = markers.map((marker) => ({
    id: `p${pageNumber}_marker_${marker.role}`,
    type: "marker",
    role: marker.role,
    rect: marker.rect
  }));

  return {
    pageNumber,
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    markers,
    header: {
      id: card.id,
      title: includeTitle ? card.title : undefined,
      idTextX: headerPanel.x + 4,
      idTextY: 26,
      codeBoxes,
      titleX: includeTitle ? headerPanel.x + headerPanel.width / 2 : undefined,
      titleY: includeTitle ? 37 : undefined
    },
    panels,
    blocks: [],
    elements
  };
}

// 按方框内可用宽度自动换行（保留显式换行符），返回换行后的行数组。
// sizePt 取保守值 8（略大于实际渲染的 7.5pt），确保估算行宽不超过渲染宽度，文字不溢出框。
function wrapNotesLines(text: string, innerWidthMm: number, sizePt = 8): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    if (raw.length === 0) {
      out.push("");
      continue;
    }
    let current = "";
    let width = 0;
    for (const ch of raw) {
      const w = /[\x00-\x7F]/.test(ch) ? (sizePt / 72) * 25.4 * 0.5 : (sizePt / 72) * 25.4;
      if (width + w > innerWidthMm && current.length > 0) {
        out.push(current);
        current = ch;
        width = w;
      } else {
        current += ch;
        width += w;
      }
    }
    out.push(current);
  }
  return out.filter((line) => line.trim().length > 0);
}

function layoutStudentArea(card: AnswerCard, page: PageLayout, y: number): StudentAreaLayout {
  const info = card.studentInfo;
  const rowCount = Math.max(1, info.studentNumberDigits);
  const rowH = 4.8;
  // 学号填涂区开关：默认（未定义或 true）显示；关闭后不生成涂写格，
  // 识别器对空 student_digits 返回 not_present 且不判失败（answer_recognition.cpp）
  const showStudentNumber = info.showStudentNumber !== false;
  // 手写字段行：姓名/班级默认显示（!== false），座位号/考号仅在显式开启时显示
  const textFields = [
    { label: "姓名", flag: info.showName !== false },
    { label: "班级", flag: info.showClass !== false },
    { label: "座位号", flag: info.showSeat === true },
    { label: "考号", flag: info.showExamNumber === true }
  ];
  const enabledFields = textFields.filter((field) => field.flag);

  const showNotes = info.showNotes === true;
  const rawNotes = showNotes ? (info.notesText || DEFAULT_STUDENT_NOTES) : "";
  const notesInnerW = (IS_A3 ? 48 : 66) - 14;
  const notesLines = showNotes ? wrapNotesLines(rawNotes, notesInnerW) : [];
  const notesLineH = 4.2;

  const infoWidth = IS_A3 ? 48 : 66;
  // 填涂号区需要 7 + rowCount*rowH（保底 29mm）；信息区按字段行数/注意事项自适应
  const digitAreaHeight = showStudentNumber ? Math.max(29, 7 + rowCount * rowH) : 0;
  const fieldRows: StudentAreaLayout["fieldRows"] = [];
  enabledFields.forEach((field, index) => {
    // 行距 12mm：第 0 行下划线在 y+14.5，标签基线在其上方 4.5mm（与 #201 渲染坐标一致）
    fieldRows.push({
      label: `${field.label}：`,
      labelX: MARGIN_X + 5,
      labelY: y + 10 + index * 12,
      lineX1: MARGIN_X + 18,
      lineX2: MARGIN_X + infoWidth - 9,
      lineY: y + 14.5 + index * 12
    });
  });
  const fieldsBottom = enabledFields.length > 0 ? y + 14.5 + (enabledFields.length - 1) * 12 : y + 10;
  const notesY = fieldsBottom + 5;
  const notesBottom =
    showNotes && notesLines.length > 0 ? notesY + notesLines.length * notesLineH : fieldsBottom + 2.5;
  const infoAreaHeight = Math.max(29, notesBottom - y);
  const areaHeight = Math.max(digitAreaHeight, infoAreaHeight);
  const infoRect = rect(MARGIN_X, y, infoWidth, areaHeight);
  // 关闭学号填涂区时 digitRect 宽度置 0（firstBodyY 据此跳过），并清空涂写格
  const digitRect = rect(
    MARGIN_X + infoWidth + 4,
    y,
    showStudentNumber ? BODY_WIDTH - infoWidth - 4 : 0,
    areaHeight
  );
  const digitCells: StudentAreaLayout["digitCells"] = [];
  const cellW = 4.6;
  const cellH = 2.8;
  const startX = digitRect.x + 13;
  const startY = digitRect.y + 8;
  const usableW = digitRect.width - 18;
  const colGap = usableW / 10;

  if (showStudentNumber) {
    for (let digitIndex = 0; digitIndex < rowCount; digitIndex += 1) {
      for (let digit = 0; digit <= 9; digit += 1) {
        const cell = rect(startX + digit * colGap, startY + digitIndex * rowH, cellW, cellH);
        digitCells.push({ digitIndex, digit, rect: cell });
        page.elements.push({
          id: `p${page.pageNumber}_student_${digitIndex}_${digit}`,
          type: "student_digit",
          digitIndex,
          digit,
          rect: cell
        });
      }
    }
  }

  page.studentArea = {
    infoRect,
    digitRect,
    digitCells,
    fieldRows,
    ...(showNotes && notesLines.length > 0 ? { notesLines, notesY } : {})
  };
  return page.studentArea;
}

function bodyBottom(): number {
  return PAGE_HEIGHT - BOTTOM_MARGIN;
}

function titleHeight(): number {
  return 8;
}

function objectiveArrangementMode(questions: ObjectiveQuestionDefinition[]): ObjectiveArrangementMode {
  if (questions.some(isVerticalQuestion)) {
    return "vertical-grid";
  }
  return questions.length >= 15 ? "grid" : "rows";
}

function isWideObjectiveQuestion(question: ObjectiveQuestionDefinition): boolean {
  return question.optionCount > OBJECTIVE_WIDE_OPTION_THRESHOLD;
}

function isVerticalQuestion(question: ObjectiveQuestionDefinition): boolean {
  return question.optionLayout === "vertical";
}

function isSoloRowQuestion(question: ObjectiveQuestionDefinition): boolean {
  return isWideObjectiveQuestion(question);
}

function objectiveGridCellQuestions(mode: ObjectiveArrangementMode): number {
  return mode === "vertical-grid" ? OBJECTIVE_VERTICAL_GROUP_QUESTIONS : OBJECTIVE_GRID_CELL_QUESTIONS;
}

function objectiveRowsForQuestions(questions: ObjectiveQuestionDefinition[], mode: ObjectiveArrangementMode): ObjectiveRow[] {
  const rows: ObjectiveRow[] = [];

  if (mode === "rows") {
    let standardRow: ObjectiveQuestionDefinition[] = [];
    const flushStandardRow = () => {
      if (standardRow.length > 0) {
        rows.push({ type: "standard", questions: standardRow });
        standardRow = [];
      }
    };

    for (const question of questions) {
      if (isSoloRowQuestion(question)) {
        flushStandardRow();
        rows.push({ type: "wide", question });
        continue;
      }

      standardRow.push(question);
      if (standardRow.length === OBJECTIVE_STANDARD_COLUMNS) {
        flushStandardRow();
      }
    }
    flushStandardRow();
    return rows;
  }

  const gridCellQuestions = objectiveGridCellQuestions(mode);
  let gridCells: ObjectiveQuestionDefinition[][] = [[]];
  const flushGridRow = () => {
    const nonEmptyCells = gridCells.filter((cell) => cell.length > 0);
    if (nonEmptyCells.length > 0) {
      rows.push({ type: "grid", cells: nonEmptyCells });
    }
    gridCells = [[]];
  };

  for (const question of questions) {
    if (isSoloRowQuestion(question)) {
      flushGridRow();
      rows.push({ type: "wide", question });
      continue;
    }

    let currentCell = gridCells[gridCells.length - 1];
    if (currentCell.length === gridCellQuestions) {
      if (gridCells.length === OBJECTIVE_STANDARD_COLUMNS) {
        flushGridRow();
      } else {
        gridCells.push([]);
      }
      currentCell = gridCells[gridCells.length - 1];
    }

    currentCell.push(question);
  }
  flushGridRow();
  return rows;
}

function objectivePhysicalRowsForRows(rows: ObjectiveRow[]): number {
  return rows.reduce((sum, row) => {
    if (row.type === "grid") {
      return sum + Math.max(...row.cells.map((cell) => cell.length));
    }
    return sum + 1;
  }, 0);
}

function objectivePhysicalRowsForQuestions(questions: ObjectiveQuestionDefinition[], mode: ObjectiveArrangementMode): number {
  return objectivePhysicalRowsForRows(objectiveRowsForQuestions(questions, mode));
}

function objectiveRowHeight(row: ObjectiveRow): number {
  if (row.type === "grid") {
    return Math.max(...row.cells.map((cell) => cell.length));
  }
  return 1;
}

function objectivePhysicalRowOffsets(rows: ObjectiveRow[], mode: ObjectiveArrangementMode): number[] {
  const offsets: number[] = [];
  let yOffset = 0;

  rows.forEach((row, rowIndex) => {
    const rowHeight = objectiveRowHeight(row);
    for (let offset = 0; offset < rowHeight; offset += 1) {
      offsets.push(round(yOffset + offset * OBJECTIVE_SETTINGS.rowHeight));
    }
    yOffset += rowHeight * OBJECTIVE_SETTINGS.rowHeight;
    if (mode !== "rows" && rowIndex < rows.length - 1) {
      yOffset += OBJECTIVE_GRID_ROW_GAP;
    }
  });

  return offsets;
}

function objectiveSegmentQuestionsForMaxRows(
  questions: ObjectiveQuestionDefinition[],
  mode: ObjectiveArrangementMode,
  maxRows: number
): ObjectiveQuestionDefinition[] {
  let segment: ObjectiveQuestionDefinition[] = [];

  for (const question of questions) {
    const candidate = [...segment, question];
    const candidateRows = objectivePhysicalRowsForQuestions(candidate, mode);
    if (candidateRows > maxRows && segment.length > 0) {
      return segment;
    }
    segment = candidate;
  }

  return segment.length > 0 ? segment : questions.slice(0, 1);
}

function objectiveHeightForQuestions(questions: ObjectiveQuestionDefinition[], mode: ObjectiveArrangementMode): number {
  const rows = objectiveRowsForQuestions(questions, mode);
  const rowOffsets = objectivePhysicalRowOffsets(rows, mode);
  if (rowOffsets.length === 0) {
    return OBJECTIVE_FRAME_TOP + OBJECTIVE_INNER_TOP + OBJECTIVE_INNER_BOTTOM;
  }
  const settings = OBJECTIVE_SETTINGS;
  let contentBottom = 0;
  let physicalRow = 0;
  for (const row of rows) {
    const heightInRows = objectiveRowHeight(row);
    const lastOffset = rowOffsets[physicalRow + heightInRows - 1] ?? (physicalRow + heightInRows - 1) * settings.rowHeight;
    contentBottom = Math.max(contentBottom, lastOffset + OBJECTIVE_OPTION_TOP_OFFSET + settings.optionHeight);
    physicalRow += heightInRows;
  }
  return OBJECTIVE_FRAME_TOP + OBJECTIVE_INNER_TOP + contentBottom + OBJECTIVE_INNER_BOTTOM;
}

function objectiveMaxRowsForAvailableHeight(height: number): number {
  const firstRowHeight = OBJECTIVE_FRAME_TOP + OBJECTIVE_INNER_TOP + OBJECTIVE_SETTINGS.optionHeight + OBJECTIVE_INNER_BOTTOM;
  if (height <= firstRowHeight) return 1;
  return Math.max(1, Math.floor((height - firstRowHeight) / OBJECTIVE_SETTINGS.rowHeight) + 1);
}

function addObjectiveSegment(
  page: PageLayout,
  block: ObjectiveBlock,
  title: string,
  questions: ObjectiveQuestionDefinition[],
  mode: ObjectiveArrangementMode,
  y: number
): number {
  const settings = OBJECTIVE_SETTINGS;
  const objectiveRows = objectiveRowsForQuestions(questions, mode);
  const rowOffsets = objectivePhysicalRowOffsets(objectiveRows, mode);
  const blockHeight = objectiveHeightForQuestions(questions, mode);
  const blockRect = rect(MARGIN_X, y, BODY_WIDTH, blockHeight);
  const frameRect = rect(MARGIN_X, y + OBJECTIVE_FRAME_TOP, BODY_WIDTH, blockHeight - OBJECTIVE_FRAME_TOP);
  const itemAreaY = frameRect.y + OBJECTIVE_INNER_TOP;
  const contentStartX = frameRect.x + OBJECTIVE_CONTENT_SIDE_INSET;
  const contentWidth = frameRect.width - OBJECTIVE_CONTENT_SIDE_INSET * 2;
  const columnWidth = contentWidth / OBJECTIVE_STANDARD_COLUMNS;
  const rowMarkers = rowOffsets.map((rowOffset, row) => {
    const markerY =
      itemAreaY + rowOffset + OBJECTIVE_OPTION_TOP_OFFSET + (settings.optionHeight - OBJECTIVE_ROW_MARKER_SIZE) / 2;
    const left = rect(frameRect.x + 3.4, markerY, OBJECTIVE_ROW_MARKER_SIZE, OBJECTIVE_ROW_MARKER_SIZE);
    const right = rect(frameRect.x + frameRect.width - 5.6, markerY, OBJECTIVE_ROW_MARKER_SIZE, OBJECTIVE_ROW_MARKER_SIZE);
    page.elements.push({
      id: `p${page.pageNumber}_obj_marker_${block.id}_${row}_left`,
      type: "objective_row_marker",
      blockId: block.id,
      row,
      side: "left",
      rect: left
    });
    page.elements.push({
      id: `p${page.pageNumber}_obj_marker_${block.id}_${row}_right`,
      type: "objective_row_marker",
      blockId: block.id,
      row,
      side: "right",
      rect: right
    });
    return { row, left, right };
  });
  const items: PageRenderBlock & { type: "objective" } = {
    type: "objective",
    blockId: block.id,
    title,
    rect: blockRect,
    frameRect,
    rowMarkers,
    items: [],
    density: "compact"
  };

  const addObjectiveQuestion = (question: ObjectiveQuestionDefinition, column: number, physicalRow: number) => {
    const questionNumber = question.questionNumber;
    const labelTextX = contentStartX + column * columnWidth;
    const labelX = labelTextX + 2.5;
    const rowOffset = rowOffsets[physicalRow] ?? physicalRow * settings.rowHeight;
    const labelY = itemAreaY + rowOffset + 2.9;
    const optionStartX = labelTextX + OBJECTIVE_LABEL_TO_OPTION_GAP;
    const options = OPTIONS.slice(0, question.optionCount).map((label, optionIndex) => {
      const optionRect = rect(
        optionStartX + optionIndex * settings.optionGap,
        itemAreaY + rowOffset + OBJECTIVE_OPTION_TOP_OFFSET,
        settings.optionWidth,
        settings.optionHeight
      );
      page.elements.push({
        id: `p${page.pageNumber}_obj_${block.id}_${questionNumber}_${label}`,
        type: "objective_option",
        blockId: block.id,
        questionNumber,
        option: label,
        rect: optionRect
      });
      return { label, rect: optionRect };
    });

    items.items.push({ questionNumber, options, labelX: round(labelX), labelY: round(labelY) });
  };

  let physicalRow = 0;
  for (const objectiveRow of objectiveRows) {
    if (objectiveRow.type === "wide") {
      addObjectiveQuestion(objectiveRow.question, 0, physicalRow);
      physicalRow += 1;
      continue;
    }

    if (objectiveRow.type === "standard") {
      objectiveRow.questions.forEach((question, column) => addObjectiveQuestion(question, column, physicalRow));
      physicalRow += 1;
      continue;
    }

    const rowHeight = Math.max(...objectiveRow.cells.map((cell) => cell.length));
    objectiveRow.cells.forEach((cell, column) => {
      cell.forEach((question, offset) => addObjectiveQuestion(question, column, physicalRow + offset));
    });
    physicalRow += rowHeight;
  }

  page.blocks.push(items);
  return y + blockHeight + 4;
}

function getScoreValues(score: number): Array<number | null> {
  if (score > 16) {
    const maxTens = Math.min(60, Math.floor(score / 10) * 10);
    const tens = Array.from({ length: Math.max(0, maxTens / 10) }, (_, index) => maxTens - index * 10).filter(
      (value) => value >= 10
    );
    return [...tens, null, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 0.5];
  }

  const values: number[] = [];
  for (let value = score; value >= 0; value -= 1) {
    values.push(value);
  }
  if (!Number.isInteger(score)) {
    return values;
  }
  values.push(0.5);
  return values;
}

const V1_SCORE_CELL_STEP = 7.6;
const V1_SCORE_CELL_WIDTH = 6.8;
const V1_SCORE_CELL_HEIGHT = 6;
const V1_SCORE_HEADER_HEIGHT = 10;
const V2_SCORE_CELL_STEP = 5.6;
const V2_SCORE_CELL_WIDTH = 5;
const V2_SCORE_CELL_HEIGHT = 4;
const V2_SCORE_HEADER_HEIGHT = 6;
const BLANK_BLOCK_INSET_X = 6;
const BLANK_BLOCK_INSET_Y = 3;
const BLANK_ITEM_GAP_X = 1.6;
const BLANK_ITEM_ROW_HEIGHT = 11;
const BLANK_NUMBER_WIDTH = 8;
const V1_BLANK_SCORE_HEADER_HEIGHT = 7;
const BLANK_INNER_GAP_X = 2.4;
const BLANK_MAX_COLUMNS = 5;
const BLANK_MIN_LINE_WIDTH = 16;
const BLANK_MAX_SHRINK_RATIO = 0.7;
const ESSAY_DEFAULT_CELL_MM = 7;
const ESSAY_DEFAULT_LINE_COLOR = "#222";
const ESSAY_DEFAULT_LINE_WIDTH = 0.15;
const ESSAY_GRID_INSET_X = 4;
const ESSAY_MAX_EMPTY_ADVANCES = 12;
const BLANK_ANNO_CHAR_WIDTH = 1.6;
const BLANK_ANNO_GAP = 1.2;

function addManualScoreCells(
  page: PageLayout,
  block: SubjectiveBlock,
  question: SubjectiveQuestion,
  y: number,
  rightX: number
): Array<{ score: number | null; rect: Rect }> {
  const values = getScoreValues(question.score);
  if (IS_LAYOUT_V2 && question.score <= 0) return [];
  const step = IS_LAYOUT_V2 ? V2_SCORE_CELL_STEP : V1_SCORE_CELL_STEP;
  const cellWidth = IS_LAYOUT_V2 ? V2_SCORE_CELL_WIDTH : V1_SCORE_CELL_WIDTH;
  const cellHeight = IS_LAYOUT_V2 ? V2_SCORE_CELL_HEIGHT : V1_SCORE_CELL_HEIGHT;
  const startX = rightX - values.length * step - 2;
  return values
    .map((score, index) => {
      const scoreRect = rect(startX + index * step, y, cellWidth, cellHeight);
      if (score !== null) {
        page.elements.push({
          id: `p${page.pageNumber}_score_${block.id}_${question.id}_${score}`,
          type: "score_cell",
          blockId: block.id,
          questionId: question.id,
          questionNumber: question.number,
          score,
          rect: scoreRect
        });
      }
      return { score, rect: scoreRect } as { score: number | null; rect: Rect };
    })
    .filter((cell) => cell.score !== null) as Array<{ score: number; rect: Rect }>;
}

function blankQuestionCount(question: SubjectiveQuestion): number {
  return Math.max(1, question.blanks?.items?.length ?? question.blanks?.count ?? 1);
}

function blankLineSpecs(question: SubjectiveQuestion): BlankLineSpec[] {
  const fallbackWidth = question.blanks?.widthMm ?? 22;
  const fallbackHeight = question.blanks?.heightMm ?? 6;
  const items = question.blanks?.items;
  if (items?.length) {
    return items.map((item, index) => ({
      label: item.label ?? formatBlankLabel(question.blanks?.labelStyle, index),
      widthMm: item.widthMm || fallbackWidth,
      heightMm: item.heightMm || fallbackHeight,
      rightAnnotation: item.rightAnnotation
    }));
  }

  return Array.from({ length: blankQuestionCount(question) }, (_, index) => ({
    label: formatBlankLabel(question.blanks?.labelStyle, index),
    widthMm: fallbackWidth,
    heightMm: fallbackHeight
  }));
}

function blankAnnotationWidth(text?: string): number {
  if (!text) return 0;
  return text.length * BLANK_ANNO_CHAR_WIDTH + BLANK_ANNO_GAP;
}

function blankQuestionLineWidth(question: SubjectiveQuestion): number {
  return Math.max(22, ...blankLineSpecs(question).map((item) => item.widthMm));
}

function blankQuestionLineHeight(question: SubjectiveQuestion): number {
  return Math.max(6, ...blankLineSpecs(question).map((item) => item.heightMm));
}

function blankMinimumLineWidth(question: SubjectiveQuestion): number {
  return Math.max(BLANK_MIN_LINE_WIDTH, blankQuestionLineWidth(question) * BLANK_MAX_SHRINK_RATIO);
}

function blankLabelWidth(question: SubjectiveQuestion, index: number): number {
  const label = blankLineSpecs(question)[index]?.label ?? "";
  return label ? label.length * 1.8 + 0.8 : 0;
}

function maxBlankLabelWidth(question: SubjectiveQuestion): number {
  return Math.max(0, ...blankLineSpecs(question).map((_, index) => blankLabelWidth(question, index)));
}

function blankColumnLineWidth(question: SubjectiveQuestion, columnW: number, labelSlotWidth: number): number {
  const specs = blankLineSpecs(question);
  const blankCount = specs.length;
  const labelWidth = labelSlotWidth * blankCount;
  const annoWidth = specs.reduce((sum, spec) => sum + blankAnnotationWidth(spec.rightAnnotation), 0);
  const availableLineWidth =
    (columnW - BLANK_NUMBER_WIDTH - labelWidth - annoWidth - BLANK_INNER_GAP_X * Math.max(0, blankCount - 1) - 2) / blankCount;
  return Math.min(
    blankQuestionLineWidth(question),
    Math.max(blankMinimumLineWidth(question), availableLineWidth)
  );
}

function blankQuestionFitsColumn(question: SubjectiveQuestion, columnW: number, labelSlotWidth: number): boolean {
  const specs = blankLineSpecs(question);
  const blankCount = specs.length;
  const labelWidth = labelSlotWidth * blankCount;
  const annoWidth = specs.reduce((sum, spec) => sum + blankAnnotationWidth(spec.rightAnnotation), 0);
  const availableLineWidth =
    (columnW - BLANK_NUMBER_WIDTH - labelWidth - annoWidth - BLANK_INNER_GAP_X * Math.max(0, blankCount - 1) - 2) / blankCount;
  return availableLineWidth >= blankMinimumLineWidth(question);
}

function blankBlockColumnCount(questions: SubjectiveQuestion[]): number {
  const labelSlotWidth = Math.max(0, ...questions.map(maxBlankLabelWidth));
  const usableW = BODY_WIDTH - BLANK_BLOCK_INSET_X * 2;
  const maxColumns = Math.min(BLANK_MAX_COLUMNS, questions.length);

  for (let columns = maxColumns; columns >= 1; columns -= 1) {
    const columnW = (usableW - BLANK_ITEM_GAP_X * (columns - 1)) / columns;
    if (questions.every((question) => blankQuestionFitsColumn(question, columnW, labelSlotWidth))) {
      return columns;
    }
  }

  return 1;
}

function blankScoreQuestion(questions: SubjectiveQuestion[]): SubjectiveQuestion | undefined {
  if (IS_LAYOUT_V2) {
    return questions.find((question) => question.style === "manual_score_grid" && question.score > 0);
  }
  return questions.find((question) => question.style === "manual_score_grid") ?? questions[0];
}

function answerBlankLabelWidth(spec: BlankLineSpec): number {
  return spec.label ? spec.label.length * 1.8 + 0.8 : 0;
}

function layoutAnswerBlankLines(question: SubjectiveQuestion, contentRect: Rect): PlacedBlankLine[] {
  const specs = blankLineSpecs(question);
  const gapX = 4;
  const gapY = 4;
  const leftInset = 5;
  const usableWidth = contentRect.width - leftInset - 5;
  let x = contentRect.x + leftInset;
  let y = contentRect.y + 13;
  let rowHeight = 0;
  const placed: PlacedBlankLine[] = [];

  specs.forEach((spec) => {
    const labelWidth = answerBlankLabelWidth(spec);
    const annoWidth = blankAnnotationWidth(spec.rightAnnotation);
    const itemWidth = labelWidth + spec.widthMm + annoWidth;
    const rowHasItems = x > contentRect.x + leftInset;
    if (rowHasItems && x + itemWidth > contentRect.x + leftInset + usableWidth) {
      x = contentRect.x + leftInset;
      y += rowHeight + gapY;
      rowHeight = 0;
    }

    const blankX = x + labelWidth;
    const blankRect = rect(blankX, y, spec.widthMm, spec.heightMm);
    placed.push({ ...spec, rect: blankRect });
    x = blankX + spec.widthMm + annoWidth + gapX;
    rowHeight = Math.max(rowHeight, spec.heightMm);
  });

  return placed;
}

function answerBlankLinesHeight(question: SubjectiveQuestion): number {
  const contentRect = rect(0, 0, BODY_WIDTH, 1);
  const placed = layoutAnswerBlankLines(question, contentRect);
  if (placed.length === 0) return 0;
  const bottom = Math.max(...placed.map((item) => item.rect.y + item.rect.height));
  return bottom + 8;
}

function subjectiveQuestionHeight(question: SubjectiveQuestion): number {
  const scoreHeader = !IS_LAYOUT_V2 && question.style === "manual_score_grid" ? 11 : 0;
  const blanksHeight = question.kind === "blank" ? answerBlankLinesHeight(question) : 0;
  const imageHeight = (question.images ?? []).reduce((sum, image) => sum + image.heightMm + 3, 0);
  return Math.max(question.minHeightMm, 18 + scoreHeader + blanksHeight + imageHeight);
}

function blankSubjectiveSegmentHeight(questions: SubjectiveQuestion[], blockTitle: string, includeScoreHeader = true): number {
  const titleH = blockTitle ? titleHeight() : 0;
  const scoreHeader = includeScoreHeader && blankScoreQuestion(questions)
    ? (IS_LAYOUT_V2 ? V2_SCORE_HEADER_HEIGHT : V1_BLANK_SCORE_HEADER_HEIGHT)
    : 0;
  const rows = Math.ceil(questions.length / blankBlockColumnCount(questions));
  return titleH + scoreHeader + BLANK_BLOCK_INSET_Y * 2 + rows * BLANK_ITEM_ROW_HEIGHT;
}

function addSubjectiveQuestion(
  page: PageLayout,
  block: SubjectiveBlock,
  question: SubjectiveQuestion,
  blockTitle: string,
  y: number
): number {
  const questionHeight = subjectiveQuestionHeight(question);
  const titleH = blockTitle ? titleHeight() : 0;
  const height = IS_LAYOUT_V2 ? questionHeight + titleH : questionHeight;
  const blockRect = rect(MARGIN_X, y, BODY_WIDTH, height);
  const questionY = y + titleH;
  const questionRect = rect(MARGIN_X, questionY, BODY_WIDTH, IS_LAYOUT_V2 ? questionHeight : height - titleH);
  const scoreHeaderH = IS_LAYOUT_V2 ? V2_SCORE_HEADER_HEIGHT : (question.style === "manual_score_grid" ? V1_SCORE_HEADER_HEIGHT : 0);
  const contentRect = rect(
    questionRect.x,
    questionRect.y + scoreHeaderH,
    questionRect.width,
    questionRect.height - scoreHeaderH
  );
  const scoreCells: Array<{ score: number | null; rect: Rect }> = [];
  const lineYs: number[] = [];
  const blanks: Rect[] = [];
  const blankLabels: string[] = [];
  const blankRightAnnotations: string[] = [];
  const images: Array<{ assetId: string; originalName?: string; rect: Rect }> = [];

  if (question.style === "manual_score_grid" && question.scoreGrid?.enabled !== false) {
    scoreCells.push(...addManualScoreCells(page, block, question, questionRect.y + (IS_LAYOUT_V2 ? 1 : 1.6), MARGIN_X + BODY_WIDTH));
  }

  if (question.kind === "lined_answer" && question.lineGrid?.enabled) {
    const lineSpacing = question.lineGrid.lineSpacingMm || 8;
    const fixedCount = question.lineGrid.fixedLineCount;
    const hasV2ScoreHeader = IS_LAYOUT_V2 && question.style === "manual_score_grid" && scoreCells.length > 0;
    const firstLineY = IS_LAYOUT_V2
      ? questionRect.y + (hasV2ScoreHeader ? 14 : 10)
      : contentRect.y + 12;
    const lineBottom = IS_LAYOUT_V2 ? questionRect.y + questionRect.height - 4 : contentRect.y + contentRect.height - 5;

    if (fixedCount && fixedCount > 0) {
      for (let i = 0; i < Math.min(fixedCount, 30); i++) {
        const lineY = firstLineY + i * lineSpacing;
        if (lineY <= lineBottom + 0.5) lineYs.push(round(lineY));
      }
    } else {
      for (let lineY = firstLineY; IS_LAYOUT_V2 ? lineY <= lineBottom : lineY < lineBottom; lineY += lineSpacing) {
        lineYs.push(round(lineY));
      }
    }
  }

  if (question.kind === "blank") {
    const placedBlanks = layoutAnswerBlankLines(question, contentRect);
    blanks.push(...placedBlanks.map((item) => item.rect));
    blankLabels.push(...placedBlanks.map((item) => item.label));
    blankRightAnnotations.push(...placedBlanks.map((item) => item.rightAnnotation || ""));
  }

  let imageY = contentRect.y + 12;
  for (const image of question.images ?? []) {
    const maxImageWidth = Math.max(10, BODY_WIDTH - 12);
    const scale = image.widthMm > maxImageWidth ? maxImageWidth / image.widthMm : 1;
    const imageWidth = image.widthMm * scale;
    const imageHeight = image.heightMm * scale;
    if (scale < 1) {
      ACTIVE_WARNINGS.push(`${block.title} 第 ${question.number} 题的图片宽度超过当前版面，已按比例缩小。`);
    }
    const x =
      image.align === "center"
        ? MARGIN_X + (BODY_WIDTH - imageWidth) / 2
        : image.align === "right"
          ? MARGIN_X + BODY_WIDTH - imageWidth - 4
          : MARGIN_X + 6;
    const imageRect = rect(x, imageY, imageWidth, imageHeight);
    images.push({ assetId: image.assetId, originalName: image.originalName, rect: imageRect });
    page.elements.push({
      id: `p${page.pageNumber}_image_${block.id}_${question.id}_${image.assetId}`,
      type: "image_area",
      blockId: block.id,
      questionId: question.id,
      assetId: image.assetId,
      rect: imageRect
    });
    imageY += imageHeight + 3;
  }

  page.elements.push({
    id: `p${page.pageNumber}_subj_${block.id}_${question.id}`,
    type: "subjective_box",
    blockId: block.id,
    questionId: question.id,
    questionNumber: question.number,
    rect: questionRect
  });

  page.blocks.push({
    type: "subjective",
    blockId: block.id,
    title: blockTitle,
    rect: blockRect,
    questions: [
      {
        blockId: block.id,
        questionId: question.id,
        questionNumber: question.number,
        score: question.score,
        style: question.style,
        kind: question.kind,
        rect: questionRect,
        contentRect,
        scoreCells,
        lineYs,
        lineGrid: question.lineGrid,
        scoreGrid: question.scoreGrid,
        blanks,
        blankLabels,
        blankRightAnnotations,
        blankLabelStyle: question.blanks?.labelStyle,
        blankLabelSlotWidth: maxBlankLabelWidth(question),
        images
      }
    ]
  });

  return y + height + 4;
}

function addBlankSubjectiveSegment(
  page: PageLayout,
  block: SubjectiveBlock,
  questions: SubjectiveQuestion[],
  blockTitle: string,
  includeScoreHeader: boolean,
  y: number
): number {
  const height = blankSubjectiveSegmentHeight(questions, blockTitle, includeScoreHeader);
  const titleH = blockTitle ? titleHeight() : 0;
  const blockRect = rect(MARGIN_X, y, BODY_WIDTH, height);
  const frameRect = rect(MARGIN_X, y + titleH, BODY_WIDTH, height - titleH);
  const renderQuestions: Extract<PageRenderBlock, { type: "subjective" }>["questions"] = [];
  const columns = blankBlockColumnCount(questions);
  const itemAreaW = frameRect.width - BLANK_BLOCK_INSET_X * 2;
  const columnW = itemAreaW / columns;
  const scoreQuestion = includeScoreHeader ? blankScoreQuestion(questions) : undefined;
  const scoreCellsByQuestionId = new Map<string, Array<{ score: number | null; rect: Rect }>>();
  const scoreHeader = scoreQuestion ? (IS_LAYOUT_V2 ? V2_SCORE_HEADER_HEIGHT : V1_BLANK_SCORE_HEADER_HEIGHT) : 0;
  const blankLabelSlotWidth = Math.max(0, ...questions.map(maxBlankLabelWidth));

  if (scoreQuestion && scoreQuestion.scoreGrid?.enabled !== false) {
    scoreCellsByQuestionId.set(
      scoreQuestion.id,
      addManualScoreCells(page, block, scoreQuestion, frameRect.y + 1.6, frameRect.x + frameRect.width)
    );
  }

  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index];
    const col = index % columns;
    const row = Math.floor(index / columns);
    const itemX = frameRect.x + BLANK_BLOCK_INSET_X + col * (columnW + BLANK_ITEM_GAP_X);
    const itemY = frameRect.y + scoreHeader + BLANK_BLOCK_INSET_Y + row * BLANK_ITEM_ROW_HEIGHT;
    const specs = blankLineSpecs(question);
    const blankCount = specs.length;
    const lineW = blankColumnLineWidth(question, columnW, blankLabelSlotWidth);
    const lineH = blankQuestionLineHeight(question);
    let blankX = itemX + BLANK_NUMBER_WIDTH;
    const blanks: Rect[] = [];
    for (let blankIndex = 0; blankIndex < blankCount; blankIndex += 1) {
      blankX += blankLabelSlotWidth;
      blanks.push(rect(blankX, itemY + 2, lineW, lineH));
      blankX += lineW + blankAnnotationWidth(specs[blankIndex]?.rightAnnotation) + BLANK_INNER_GAP_X;
    }
    const questionRect = rect(itemX, itemY, Math.min(columnW - 1, blankX - itemX - BLANK_INNER_GAP_X + 1), BLANK_ITEM_ROW_HEIGHT);

    page.elements.push({
      id: `p${page.pageNumber}_subj_${block.id}_${question.id}`,
      type: "subjective_box",
      blockId: block.id,
      questionId: question.id,
      questionNumber: question.number,
      rect: questionRect
    });

    renderQuestions.push({
      blockId: block.id,
      questionId: question.id,
      questionNumber: question.number,
      score: question.score,
      style: question.id === scoreQuestion?.id ? "manual_score_grid" : "plain_subjective",
      kind: question.kind,
      rect: questionRect,
      contentRect: questionRect,
      scoreCells: scoreCellsByQuestionId.get(question.id) ?? [],
      lineYs: [],
      lineGrid: question.lineGrid,
      scoreGrid: question.scoreGrid,
      blanks,
      blankLabels: specs.map((item) => item.label),
      blankRightAnnotations: specs.map((item) => item.rightAnnotation || ""),
      blankLabelStyle: question.blanks?.labelStyle,
      blankLabelSlotWidth,
      images: []
    });
  }

  page.blocks.push({
    type: "subjective",
    blockId: block.id,
    title: blockTitle,
    rect: blockRect,
    frameRect,
    questions: renderQuestions
  });

  return y + height + 4;
}

function availableHeight(y: number): number {
  return bodyBottom() - y;
}

function firstBodyY(card: AnswerCard, page: PageLayout): number {
  const studentArea = layoutStudentArea(card, page, 48);
  const infoBottom = studentArea.infoRect.y + studentArea.infoRect.height;
  const digitBottom =
    studentArea.digitRect.width > 0 ? studentArea.digitRect.y + studentArea.digitRect.height : 0;
  return Math.max(infoBottom, digitBottom) + 5;
}

function nextPageY(): number {
  return 36;
}

export function buildLayout(card: AnswerCard): LayoutDocument {
  IS_A3 = card.paper?.size === "A3";
  IS_LAYOUT_V2 = card.layoutVersion === 2;
  PAGE_WIDTH = IS_A3 ? 420 : 210;
  PAGE_HEIGHT = 297;
  MARGIN_X = OUTER_MARGIN_X;
  BODY_WIDTH = IS_A3
    ? (PAGE_WIDTH - OUTER_MARGIN_X * 2 - A3_PANEL_GAP * 2) / 3
    : PAGE_WIDTH - OUTER_MARGIN_X * 2;
  OBJECTIVE_STANDARD_COLUMNS = IS_A3 ? 3 : 4;
  const warnings: string[] = [];
  ACTIVE_WARNINGS = warnings;
  const pages: PageLayout[] = [createPage(card, 1, true)];
  let page = pages[0];
  let panelIndex = 0;
  activatePanel(page.panels[panelIndex]);
  let y = firstBodyY(card, page);

  const nextPanel = () => {
    panelIndex += 1;
    if (panelIndex >= page.panels.length) {
      page = createPage(card, pages.length + 1, false);
      pages.push(page);
      panelIndex = 0;
    }
    activatePanel(page.panels[panelIndex]);
    y = nextPageY();
  };

  // 前进到下一个「物理页」：作文块等需独占整页的内容使用，避免跨栏碎片。
  const nextPage = () => {
    page = createPage(card, pages.length + 1, false);
    pages.push(page);
    panelIndex = 0;
    activatePanel(page.panels[panelIndex]);
    y = nextPageY();
  };

  const ensureSpace = (height: number) => {
    if (height > availableHeight(y) && page.blocks.length > 0) {
      nextPanel();
    }
  };

  for (const block of card.bodyBlocks) {
    if (block.type === "objective") {
      let remaining = objectiveQuestionDefinitions(block);
      const arrangementMode = objectiveArrangementMode(remaining);
      let firstSegment = true;

      while (remaining.length > 0) {
        let maxRows = objectiveMaxRowsForAvailableHeight(availableHeight(y));
        const nextObjectiveRow = objectiveRowsForQuestions(remaining, arrangementMode)[0];
        const nextRowHeight = nextObjectiveRow ? objectivePhysicalRowsForRows([nextObjectiveRow]) : 1;
        if (page.blocks.length > 0 && nextRowHeight > maxRows) {
          nextPanel();
          maxRows = objectiveMaxRowsForAvailableHeight(availableHeight(y));
        }

        const segmentQuestions = objectiveSegmentQuestionsForMaxRows(remaining, arrangementMode, maxRows);
        const height = objectiveHeightForQuestions(segmentQuestions, arrangementMode);

        ensureSpace(height);
        if (height > availableHeight(y)) {
          warnings.push(`${block.title} 的题量较多，当前密度下单页空间不足，已尽量分页排版。`);
        }

        y = addObjectiveSegment(
          page,
          block,
          firstSegment ? block.title : `${block.title}（续）`,
          segmentQuestions,
          arrangementMode,
          y
        );
        remaining = remaining.slice(segmentQuestions.length);
        firstSegment = false;

        if (remaining.length > 0) {
          nextPanel();
        }
      }
      continue;
    }

    layoutSubjectiveBlock(block, ensureSpace, nextPanel, nextPage, () => page, (nextY) => {
      y = nextY;
    }, () => y);
  }

  const allElements = pages.flatMap((item) => item.elements);
  return {
    cardId: card.id,
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    pages,
    elements: allElements,
    warnings
  };
}

/* ── Essay Grid Layout ─────────────────────────────── */

function layoutEssayBlock(
  block: SubjectiveBlock,
  nextPhysicalPage: () => void,
  getPage: () => PageLayout,
  setY: (value: number) => void,
  getY: () => number
): void {
  const question = block.questions[0];
  if (!question) return;

  const grid: EssayGridConfig = question.essayGrid ?? {
    columns: 0, rows: 0, cellWidthMm: ESSAY_DEFAULT_CELL_MM,
    cellHeightMm: ESSAY_DEFAULT_CELL_MM, targetChars: 600,
    showTitle: true, lineColor: ESSAY_DEFAULT_LINE_COLOR,
    lineWidthMm: ESSAY_DEFAULT_LINE_WIDTH, showFrame: true, showWordScale: true,
  };
  const cellW = Math.max(1, grid.cellWidthMm || ESSAY_DEFAULT_CELL_MM);
  const cellH = Math.max(1, grid.cellHeightMm || ESSAY_DEFAULT_CELL_MM);
  const showTitle = grid.showTitle !== false;
  const showFrame = grid.showFrame !== false;

  // 每面板独立算列数（栏内居中）；A4 单面板。
  const panelW = BODY_WIDTH;
  const panelInsetX = ESSAY_GRID_INSET_X;
  const usableW = panelW - panelInsetX * 2;
  const columns = grid.columns > 0 ? grid.columns : Math.max(1, Math.floor(usableW / cellW));

  // 逐面板 X 起点：A3 三栏并排，A4 单栏
  const panelCount = IS_A3 ? 3 : 1;
  const panelStarts: number[] = [];
  for (let p = 0; p < panelCount; p++) {
    panelStarts.push(IS_A3 ? p * (panelW + A3_PANEL_GAP) + OUTER_MARGIN_X : MARGIN_X);
  }

  // 标题区高度统一基准：保证同一物理页三栏等高、底部对齐；续写栏标题区留白。
  const gridTopBase = showTitle ? 9 : 2;
  const bottomPad = 2;

  // 目标总格子数 = targetChars；跨栏/跨页连续生成，直到累计格子数 >= 目标字数。
  const targetCells = Math.max(1, grid.targetChars || 600);
  let produced = 0;          // 全局已生成格子数
  let isFirstPanelOverall = true;

  while (produced < targetCells) {
    const startY = getY();
    const availableH = availableHeight(startY) - gridTopBase - bottomPad - 4;
    let rowsThisPanel = Math.max(0, Math.floor(availableH / cellH));
    if (rowsThisPanel <= 0) {
      nextPhysicalPage();
      continue;
    }

    const minRowsNeeded = Math.ceil((targetCells - produced) / (columns * panelCount));
    const rowsToDraw = Math.min(rowsThisPanel, minRowsNeeded);
    const blockHeight = gridTopBase + rowsToDraw * cellH + bottomPad;

    for (let p = 0; p < panelCount; p++) {
      const startCellThisPanel = produced + p * columns * rowsToDraw;  // 该栏首格全局序号
      const isHeadPanel = isFirstPanelOverall && p === 0;
      const blockRect = rect(panelStarts[p], startY, panelW, blockHeight);
      getPage().blocks.push({
        type: "subjective",
        blockId: block.id,
        title: isHeadPanel ? block.title : "",
        rect: blockRect,
        frameRect: showFrame ? blockRect : undefined,
        essayStartCell: startCellThisPanel,
        questions: [],
      });
    }

    produced += rowsToDraw * columns * panelCount;
    setY(startY + blockHeight + 4);
    isFirstPanelOverall = false;

    if (produced < targetCells) {
      nextPhysicalPage();
    }
  }
}

function layoutSubjectiveBlock(
  block: SubjectiveBlock,
  ensureSpace: (height: number) => void,
  newPage: () => void,
  nextPhysicalPage: () => void,
  getPage: () => PageLayout,
  setY: (value: number) => void,
  getY: () => number
): void {
  if (IS_LAYOUT_V2) {
    for (const question of block.questions) {
      if (question.style === "manual_score_grid" && question.score <= 0) {
        ACTIVE_WARNINGS.push(`${block.title} 第 ${question.number} 题启用了分数填涂区，但分值为 0；V2 已隐藏分数格，请先设置分值。`);
      }
    }
  }
  const isEssayBlock = block.blockKind === "essay";

  if (isEssayBlock) {
    // 作文块独占新物理页：若当前页已有内容，先跳到下一物理页顶部，
    // 避免作文格嵌入上一页答题区（截图所见「第一页底部窄条」问题）。
    if (getPage().blocks.length > 0) {
      nextPhysicalPage();
    }
    layoutEssayBlock(block, nextPhysicalPage, getPage, setY, getY);
    return;
  }

  const isFillBlankBlock =
    block.blockKind === "fill_blank" ||
    (!block.blockKind &&
      !block.title.includes("解答") &&
      block.questions.length > 0 &&
      block.questions.every((question) => question.kind === "blank"));

  if (isFillBlankBlock) {
    let remaining = [...block.questions];
    let firstSegment = true;

    while (remaining.length > 0) {
      const title = firstSegment ? block.title : `${block.title}（续）`;
      const firstHeight = blankSubjectiveSegmentHeight([remaining[0]], title, firstSegment);

      ensureSpace(firstHeight);
      if (firstHeight > availableHeight(getY()) && getPage().blocks.length > 0) {
        newPage();
      }

      let count = 0;
      let height = firstHeight;
      for (let index = 1; index <= remaining.length; index += 1) {
        const nextQuestions = remaining.slice(0, index);
        const nextHeight = blankSubjectiveSegmentHeight(nextQuestions, title, firstSegment);
        if (index > 1 && nextHeight > availableHeight(getY())) break;
        count = index;
        height = nextHeight;
      }

      const segmentQuestions = remaining.slice(0, Math.max(1, count));
      const nextY = addBlankSubjectiveSegment(getPage(), block, segmentQuestions, title, firstSegment, getY());
      setY(nextY);
      remaining = remaining.slice(segmentQuestions.length);
      firstSegment = false;

      if (remaining.length > 0) {
        newPage();
      }
    }
    return;
  }

  let firstQuestion = true;

  for (const question of block.questions) {
    const title = firstQuestion ? block.title : "";
    const height = subjectiveQuestionHeight(question) + (title ? titleHeight() : 0);

    ensureSpace(height);
    if (height > availableHeight(getY()) && getPage().blocks.length > 0) {
      newPage();
    }

    const nextY = addSubjectiveQuestion(getPage(), block, question, title, getY());
    setY(nextY);
    firstQuestion = false;
  }
}
