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

function getObjectiveColumns(block: ObjectiveBlock): number {
  const settings = OBJECTIVE_SETTINGS;
  const minQuestionWidth = 8 + block.optionCount * settings.optionGap + settings.questionGap;
  const maxByWidth = Math.max(1, Math.floor((BODY_WIDTH - 8) / minQuestionWidth));
  return Math.max(1, Math.min(settings.maxColumns, maxByWidth, block.questionCount));
}

function objectiveRowsFor(block: ObjectiveBlock, count: number): number {
  return Math.ceil(count / getObjectiveColumns(block));
}

function objectiveHeight(block: ObjectiveBlock, count = block.questionCount): number {
  const rows = objectiveRowsFor(block, count);
  return OBJECTIVE_FRAME_TOP + OBJECTIVE_INNER_TOP + (rows - 1) * OBJECTIVE_SETTINGS.rowHeight + OBJECTIVE_SETTINGS.optionHeight + OBJECTIVE_INNER_BOTTOM;
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
  questionStart: number,
  count: number,
  y: number
): number {
  const settings = OBJECTIVE_SETTINGS;
  const columns = getObjectiveColumns({ ...block, questionCount: count });
  const rows = Math.ceil(count / columns);
  const blockHeight = objectiveHeight(block, count);
  const blockRect = rect(MARGIN_X, y, BODY_WIDTH, blockHeight);
  const frameRect = rect(MARGIN_X, y + OBJECTIVE_FRAME_TOP, BODY_WIDTH, blockHeight - OBJECTIVE_FRAME_TOP);
  const itemAreaY = frameRect.y + OBJECTIVE_INNER_TOP;
  const contentStartX = frameRect.x + OBJECTIVE_CONTENT_SIDE_INSET;
  const contentWidth = frameRect.width - OBJECTIVE_CONTENT_SIDE_INSET * 2;
  const columnWidth = contentWidth / columns;
  const rowMarkers = Array.from({ length: rows }, (_, row) => {
    const markerY =
      itemAreaY + row * settings.rowHeight + OBJECTIVE_OPTION_TOP_OFFSET + (settings.optionHeight - OBJECTIVE_ROW_MARKER_SIZE) / 2;
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

  for (let offset = 0; offset < count; offset += 1) {
    const questionNumber = questionStart + offset;
    const col = Math.floor(offset / rows);
    const row = offset % rows;
    const labelTextX = contentStartX + col * columnWidth;
    const labelX = labelTextX + 2.5;
    const labelY = itemAreaY + row * settings.rowHeight + 2.9;
    const optionStartX = labelTextX + OBJECTIVE_LABEL_TO_OPTION_GAP;
    const options = OPTIONS.slice(0, block.optionCount).map((label, optionIndex) => {
      const optionRect = rect(
        optionStartX + optionIndex * settings.optionGap,
        itemAreaY + row * settings.rowHeight + OBJECTIVE_OPTION_TOP_OFFSET,
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
  }

  page.blocks.push(items);
  return y + blockHeight + 4;
}

function getScoreValues(score: number): number[] {
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

function subjectiveQuestionHeight(question: SubjectiveQuestion): number {
  const scoreHeader = question.style === "manual_score_grid" ? 11 : 0;
  const blanksHeight = question.kind === "blank" ? (question.blanks?.heightMm ?? 6) + 8 : 0;
  const imageHeight = (question.images ?? []).reduce((sum, image) => sum + image.heightMm + 3, 0);
  return Math.max(question.minHeightMm, 18 + scoreHeader + blanksHeight + imageHeight);
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
  const scoreHeaderH = question.style === "manual_score_grid" ? 10 : 0;
  const contentRect = rect(
    questionRect.x,
    questionRect.y + scoreHeaderH,
    questionRect.width,
    questionRect.height - scoreHeaderH
  );
  const scoreCells: Array<{ score: number; rect: Rect }> = [];
  const lineYs: number[] = [];
  const blanks: Rect[] = [];
  const images: Array<{ assetId: string; originalName?: string; rect: Rect }> = [];

  if (question.style === "manual_score_grid") {
    const values = getScoreValues(question.score);
    const cellW = Math.min(7.6, (BODY_WIDTH - 20) / values.length);
    const startX = MARGIN_X + BODY_WIDTH - values.length * cellW - 2;
    values.forEach((score, index) => {
      const scoreRect = rect(startX + index * cellW, questionRect.y + 1.6, cellW - 0.8, 6);
      scoreCells.push({ score, rect: scoreRect });
      page.elements.push({
        id: `p${page.pageNumber}_score_${block.id}_${question.id}_${score}`,
        type: "score_cell",
        blockId: block.id,
        questionId: question.id,
        questionNumber: question.number,
        score,
        rect: scoreRect
      });
    });
  }

  if (question.kind === "lined_answer" && question.lineGrid?.enabled) {
    const spacing = question.lineGrid.lineSpacingMm || 8;
    for (let lineY = contentRect.y + 12; lineY < contentRect.y + contentRect.height - 5; lineY += spacing) {
      lineYs.push(round(lineY));
    }
  }

  if (question.kind === "blank") {
    const blankCount = question.blanks?.count ?? 4;
    const blankW = question.blanks?.widthMm ?? 28;
    const blankH = question.blanks?.heightMm ?? 6;
    const gap = 6;
    const perRow = Math.max(1, Math.floor((BODY_WIDTH - 14) / (blankW + gap)));
    for (let index = 0; index < blankCount; index += 1) {
      const col = index % perRow;
      const row = Math.floor(index / perRow);
      blanks.push(rect(contentRect.x + 8 + col * (blankW + gap), contentRect.y + 13 + row * (blankH + 5), blankW, blankH));
    }
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
        images
      }
    ]
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
      let remaining = block.questionCount;
      let start = block.questionStart;
      let firstSegment = true;

      while (remaining > 0) {
        const settings = OBJECTIVE_SETTINGS;
        const columns = getObjectiveColumns({ ...block, questionCount: remaining });
        const maxRows = objectiveMaxRowsForAvailableHeight(availableHeight(y));
        const maxCount = Math.max(1, columns * maxRows);
        const count = Math.min(remaining, maxCount);
        const height = objectiveHeight({ ...block, questionCount: count }, count);

        ensureSpace(height);
        if (height > availableHeight(y)) {
          warnings.push(`${block.title} 的题量较多，当前密度下单页空间不足，已尽量分页排版。`);
        }

        y = addObjectiveSegment(page, block, firstSegment ? block.title : `${block.title}（续）`, start, count, y);
        remaining -= count;
        start += count;
        firstSegment = false;

        if (remaining > 0) {
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
