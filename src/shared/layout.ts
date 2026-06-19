import type {
  AnswerCard,
  BodyBlock,
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
import { objectiveQuestionDefinitions, type ObjectiveQuestionDefinition } from "./grading";

const PAGE_WIDTH = 210;
const PAGE_HEIGHT = 297;
const MARGIN_X = 17;
const TOP_MARGIN = 14;
const BOTTOM_MARGIN = 18;
const BODY_WIDTH = PAGE_WIDTH - MARGIN_X * 2;
const OPTIONS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

type DensitySettings = {
  maxColumns: number;
  rowHeight: number;
  optionGap: number;
  optionWidth: number;
  optionHeight: number;
  questionGap: number;
};

type BlankLineSpec = { label: string; widthMm: number; heightMm: number };
type PlacedBlankLine = BlankLineSpec & { rect: Rect };

const DENSITY: Record<ObjectiveDensity, DensitySettings> = {
  loose: { maxColumns: 4, rowHeight: 7.7, optionGap: 8.1, optionWidth: 5.1, optionHeight: 3.0, questionGap: 6.4 },
  normal: { maxColumns: 4, rowHeight: 6.7, optionGap: 7.4, optionWidth: 4.8, optionHeight: 2.8, questionGap: 5.6 },
  compact: { maxColumns: 5, rowHeight: 5.9, optionGap: 6.7, optionWidth: 4.4, optionHeight: 2.5, questionGap: 4.8 },
  dense: { maxColumns: 6, rowHeight: 5.2, optionGap: 6.0, optionWidth: 4.1, optionHeight: 2.3, questionGap: 4.2 }
};
const OBJECTIVE_SETTINGS = DENSITY.compact;
const OBJECTIVE_FRAME_TOP = 6.2;
const OBJECTIVE_INNER_TOP = 2.4;
const OBJECTIVE_INNER_BOTTOM = 2.2;
const OBJECTIVE_ROW_MARKER_SIZE = 2.2;
const OBJECTIVE_OPTION_TOP_OFFSET = 0.9;
const OBJECTIVE_CONTENT_SIDE_INSET = 8.5;
const OBJECTIVE_LABEL_TO_OPTION_GAP = 6.3;
const OBJECTIVE_STANDARD_COLUMNS = 4;
const OBJECTIVE_GRID_CELL_QUESTIONS = 5;
const OBJECTIVE_VERTICAL_GROUP_QUESTIONS = 4;
const OBJECTIVE_WIDE_OPTION_THRESHOLD = 5;
const OBJECTIVE_GRID_ROW_GAP = 1.5;

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
  const h = 7;
  return [
    { role: "top-left", rect: rect(MARGIN_X - 4.5, 21, w, h) },
    { role: "top-right", rect: rect(PAGE_WIDTH - MARGIN_X + 1.9, 21, w, h) },
    { role: "middle-left", rect: rect(MARGIN_X - 4.5, 163, w, h) },
    { role: "middle-right", rect: rect(PAGE_WIDTH - MARGIN_X + 1.9, 163, w, h) },
    { role: "bottom-left", rect: rect(MARGIN_X - 4.5, PAGE_HEIGHT - 35, w, h) },
    { role: "bottom-right", rect: rect(PAGE_WIDTH - MARGIN_X + 1.9, PAGE_HEIGHT - 35, w, h) }
  ];
}

function createPage(card: AnswerCard, pageNumber: number, includeTitle: boolean): PageLayout {
  const codeBoxes = Array.from({ length: 6 }, (_, index) => rect(58 + index * 6.1, 22, 4.8, 3.4));
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
      idTextX: 21,
      idTextY: 26,
      codeBoxes,
      titleX: includeTitle ? PAGE_WIDTH / 2 : undefined,
      titleY: includeTitle ? 37 : undefined
    },
    blocks: [],
    elements
  };
}

function layoutStudentArea(card: AnswerCard, page: PageLayout, y: number): StudentAreaLayout {
  const rowCount = Math.max(1, card.studentInfo.studentNumberDigits);
  const rowH = 4.8;
  const areaHeight = Math.max(29, 7 + rowCount * rowH);
  const infoRect = rect(MARGIN_X, y, 66, areaHeight);
  const digitRect = rect(MARGIN_X + 70, y, BODY_WIDTH - 70, areaHeight);
  const digitCells: StudentAreaLayout["digitCells"] = [];
  const cellW = 4.6;
  const cellH = 2.8;
  const startX = digitRect.x + 13;
  const startY = digitRect.y + 8;
  const usableW = digitRect.width - 18;
  const colGap = usableW / 10;

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

  page.studentArea = { infoRect, digitRect, digitCells };
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

const SCORE_CELL_WIDTH = 7.6;
const SCORE_CELL_HEIGHT = 6;
const SCORE_HEADER_HEIGHT = 10;
const BLANK_BLOCK_INSET_X = 6;
const BLANK_BLOCK_INSET_Y = 3;
const BLANK_ITEM_GAP_X = 1.6;
const BLANK_ITEM_ROW_HEIGHT = 13;
const BLANK_NUMBER_WIDTH = 8;
const BLANK_SCORE_HEADER_HEIGHT = 7;
const BLANK_INNER_GAP_X = 2.4;
const BLANK_MAX_COLUMNS = 5;
const BLANK_MIN_LINE_WIDTH = 16;
const BLANK_MAX_SHRINK_RATIO = 0.7;

function addManualScoreCells(
  page: PageLayout,
  block: SubjectiveBlock,
  question: SubjectiveQuestion,
  y: number,
  rightX: number
): Array<{ score: number | null; rect: Rect }> {
  const values = getScoreValues(question.score);
  const startX = rightX - values.length * SCORE_CELL_WIDTH - 2;
  return values.map((score, index) => {
    const scoreRect = rect(startX + index * SCORE_CELL_WIDTH, y, SCORE_CELL_WIDTH - 0.8, SCORE_CELL_HEIGHT);
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
    return { score, rect: scoreRect };
  });
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
      heightMm: item.heightMm || fallbackHeight
    }));
  }

  return Array.from({ length: blankQuestionCount(question) }, (_, index) => ({
    label: formatBlankLabel(question.blanks?.labelStyle, index),
    widthMm: fallbackWidth,
    heightMm: fallbackHeight
  }));
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
  const blankCount = blankQuestionCount(question);
  const labelWidth = labelSlotWidth * blankCount;
  const availableLineWidth =
    (columnW - BLANK_NUMBER_WIDTH - labelWidth - BLANK_INNER_GAP_X * Math.max(0, blankCount - 1) - 2) / blankCount;
  return Math.min(
    blankQuestionLineWidth(question),
    Math.max(blankMinimumLineWidth(question), availableLineWidth)
  );
}

function blankQuestionFitsColumn(question: SubjectiveQuestion, columnW: number, labelSlotWidth: number): boolean {
  const blankCount = blankQuestionCount(question);
  const labelWidth = labelSlotWidth * blankCount;
  const availableLineWidth =
    (columnW - BLANK_NUMBER_WIDTH - labelWidth - BLANK_INNER_GAP_X * Math.max(0, blankCount - 1) - 2) / blankCount;
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
  return questions.find((question) => question.style === "manual_score_grid") ?? questions[0];
}

function answerBlankLabelWidth(spec: BlankLineSpec): number {
  return spec.label ? spec.label.length * 1.8 + 0.8 : 0;
}

function layoutAnswerBlankLines(question: SubjectiveQuestion, contentRect: Rect): PlacedBlankLine[] {
  const specs = blankLineSpecs(question);
  const gapX = 6;
  const gapY = 5;
  const leftInset = 8;
  const usableWidth = contentRect.width - leftInset - 6;
  let x = contentRect.x + leftInset;
  let y = contentRect.y + 13;
  let rowHeight = 0;
  const placed: PlacedBlankLine[] = [];

  specs.forEach((spec) => {
    const labelWidth = answerBlankLabelWidth(spec);
    const itemWidth = labelWidth + spec.widthMm;
    const rowHasItems = x > contentRect.x + leftInset;
    if (rowHasItems && x + itemWidth > contentRect.x + leftInset + usableWidth) {
      x = contentRect.x + leftInset;
      y += rowHeight + gapY;
      rowHeight = 0;
    }

    const blankX = x + labelWidth;
    const blankRect = rect(blankX, y, spec.widthMm, spec.heightMm);
    placed.push({ ...spec, rect: blankRect });
    x = blankX + spec.widthMm + gapX;
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
  const scoreHeader = question.style === "manual_score_grid" ? 11 : 0;
  const blanksHeight = question.kind === "blank" ? answerBlankLinesHeight(question) : 0;
  const imageHeight = (question.images ?? []).reduce((sum, image) => sum + image.heightMm + 3, 0);
  return Math.max(question.minHeightMm, 18 + scoreHeader + blanksHeight + imageHeight);
}

function blankSubjectiveSegmentHeight(questions: SubjectiveQuestion[], blockTitle: string, includeScoreHeader = true): number {
  const titleH = blockTitle ? titleHeight() : 0;
  const scoreHeader = includeScoreHeader && blankScoreQuestion(questions) ? BLANK_SCORE_HEADER_HEIGHT : 0;
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
  const height = subjectiveQuestionHeight(question);
  const blockRect = rect(MARGIN_X, y, BODY_WIDTH, height);
  const titleH = blockTitle ? titleHeight() : 0;
  const questionY = y + titleH;
  const questionRect = rect(MARGIN_X, questionY, BODY_WIDTH, height - titleH);
  const scoreHeaderH = question.style === "manual_score_grid" ? SCORE_HEADER_HEIGHT : 0;
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
  const images: Array<{ assetId: string; originalName?: string; rect: Rect }> = [];

  if (question.style === "manual_score_grid") {
    scoreCells.push(...addManualScoreCells(page, block, question, questionRect.y + 1.6, MARGIN_X + BODY_WIDTH));
  }

  if (question.kind === "lined_answer" && question.lineGrid?.enabled) {
    const spacing = question.lineGrid.lineSpacingMm || 8;
    for (let lineY = contentRect.y + 12; lineY < contentRect.y + contentRect.height - 5; lineY += spacing) {
      lineYs.push(round(lineY));
    }
  }

  if (question.kind === "blank") {
    const placedBlanks = layoutAnswerBlankLines(question, contentRect);
    blanks.push(...placedBlanks.map((item) => item.rect));
    blankLabels.push(...placedBlanks.map((item) => item.label));
  }

  let imageY = contentRect.y + 12;
  for (const image of question.images ?? []) {
    const x =
      image.align === "center"
        ? MARGIN_X + (BODY_WIDTH - image.widthMm) / 2
        : image.align === "right"
          ? MARGIN_X + BODY_WIDTH - image.widthMm - 4
          : MARGIN_X + 6;
    const imageRect = rect(x, imageY, image.widthMm, image.heightMm);
    images.push({ assetId: image.assetId, originalName: image.originalName, rect: imageRect });
    page.elements.push({
      id: `p${page.pageNumber}_image_${block.id}_${question.id}_${image.assetId}`,
      type: "image_area",
      blockId: block.id,
      questionId: question.id,
      assetId: image.assetId,
      rect: imageRect
    });
    imageY += image.heightMm + 3;
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
        blanks,
        blankLabels,
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
  const scoreHeader = scoreQuestion ? BLANK_SCORE_HEADER_HEIGHT : 0;
  const blankLabelSlotWidth = Math.max(0, ...questions.map(maxBlankLabelWidth));

  if (scoreQuestion) {
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
      blankX += lineW + BLANK_INNER_GAP_X;
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
      blanks,
      blankLabels: specs.map((item) => item.label),
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
  return studentArea.digitRect.y + studentArea.digitRect.height + 5;
}

function nextPageY(): number {
  return 36;
}

export function buildLayout(card: AnswerCard): LayoutDocument {
  const warnings: string[] = [];
  const pages: PageLayout[] = [createPage(card, 1, true)];
  let page = pages[0];
  let y = firstBodyY(card, page);

  const newPage = () => {
    page = createPage(card, pages.length + 1, false);
    pages.push(page);
    y = nextPageY();
  };

  const ensureSpace = (height: number) => {
    if (height > availableHeight(y) && page.blocks.length > 0) {
      newPage();
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
          newPage();
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
          newPage();
        }
      }
      continue;
    }

    layoutSubjectiveBlock(block, ensureSpace, newPage, () => page, (nextY) => {
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

function layoutSubjectiveBlock(
  block: SubjectiveBlock,
  ensureSpace: (height: number) => void,
  newPage: () => void,
  getPage: () => PageLayout,
  setY: (value: number) => void,
  getY: () => number
): void {
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
