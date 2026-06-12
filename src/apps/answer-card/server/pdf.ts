import { existsSync } from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import type {
  AnswerCard,
  LayoutDocument,
  ObjectiveRenderItem,
  PageLayout,
  PageRenderBlock,
  Rect,
  SubjectiveRenderItem
} from "../../../shared/types";
import { buildLayout } from "../../../shared/layout";
import { formatBlankLabel } from "../../../shared/blankLabels";
import { cardAssetsDir } from "./storage";

const MM_TO_PT = 72 / 25.4;
const fontRegular = "C:\\Windows\\Fonts\\msyh.ttc";
const fontRegularPostscriptName = "MicrosoftYaHei";
const fontFallback = "C:\\Windows\\Fonts\\simhei.ttf";

function pt(mm: number): number {
  return mm * MM_TO_PT;
}

function drawRect(doc: PDFKit.PDFDocument, rect: Rect, options: { fill?: string; stroke?: string; lineWidth?: number } = {}) {
  if (options.lineWidth) doc.lineWidth(pt(options.lineWidth));
  if (options.fill && options.stroke) {
    doc.rect(pt(rect.x), pt(rect.y), pt(rect.width), pt(rect.height)).fillAndStroke(options.fill, options.stroke);
  } else if (options.fill) {
    doc.rect(pt(rect.x), pt(rect.y), pt(rect.width), pt(rect.height)).fill(options.fill);
  } else {
    doc.rect(pt(rect.x), pt(rect.y), pt(rect.width), pt(rect.height)).stroke(options.stroke ?? "#222");
  }
}

function drawText(
  doc: PDFKit.PDFDocument,
  text: string,
  x: number,
  y: number,
  size = 9,
  options: PDFKit.Mixins.TextOptions = {}
) {
  doc.font("regular").fontSize(size).fillColor("#111").text(text, pt(x), pt(y), options);
}

function drawCenteredText(doc: PDFKit.PDFDocument, text: string, x: number, y: number, width: number, size = 9) {
  doc.font("regular").fontSize(size).fillColor("#111").text(text, pt(x), pt(y), { width: pt(width), align: "center" });
}

function drawHeader(doc: PDFKit.PDFDocument, page: PageLayout) {
  for (const marker of page.markers) {
    drawRect(doc, marker.rect, { fill: "#1f302c" });
  }

  drawText(doc, `ID:${page.header.id}`, page.header.idTextX, page.header.idTextY - 4.3, 10);
  page.header.codeBoxes.forEach((box, index) => {
    drawRect(doc, box, { fill: index === 0 || index === page.header.codeBoxes.length - 1 ? "#1f302c" : undefined });
  });

  if (page.header.title && page.header.titleX && page.header.titleY) {
    doc.font("regular").fontSize(15).fillColor("#111").text(page.header.title, pt(35), pt(page.header.titleY - 4), {
      width: pt(140),
      align: "center"
    });
  }
}

function drawStudentArea(doc: PDFKit.PDFDocument, page: PageLayout) {
  if (!page.studentArea) return;
  const { infoRect, digitRect, digitCells } = page.studentArea;
  drawRect(doc, infoRect, { stroke: "#333", lineWidth: 0.25 });
  drawRect(doc, digitRect, { stroke: "#333", lineWidth: 0.25 });
  drawCenteredText(doc, "填涂号区", digitRect.x, digitRect.y + 2, digitRect.width, 10);

  drawText(doc, "姓名：", infoRect.x + 5, infoRect.y + 10, 9);
  doc.moveTo(pt(infoRect.x + 18), pt(infoRect.y + 14.5)).lineTo(pt(infoRect.x + infoRect.width - 9), pt(infoRect.y + 14.5)).stroke();
  drawText(doc, "班级：", infoRect.x + 5, infoRect.y + 22, 9);
  doc.moveTo(pt(infoRect.x + 18), pt(infoRect.y + 26.5)).lineTo(pt(infoRect.x + infoRect.width - 9), pt(infoRect.y + 26.5)).stroke();

  for (let row = 0; row < Math.max(...digitCells.map((cell) => cell.digitIndex)) + 1; row += 1) {
    doc.moveTo(pt(digitRect.x), pt(digitRect.y + 7 + row * 4.8)).lineTo(pt(digitRect.x + digitRect.width), pt(digitRect.y + 7 + row * 4.8)).stroke();
  }

  digitCells.forEach((cell) => {
    drawRect(doc, cell.rect, { stroke: "#333", lineWidth: 0.15 });
    drawCenteredText(doc, String(cell.digit), cell.rect.x, cell.rect.y - 0.15, cell.rect.width, 5.5);
  });
}

function drawObjectiveBlock(doc: PDFKit.PDFDocument, block: Extract<PageRenderBlock, { type: "objective" }>) {
  drawText(doc, block.title, block.rect.x, block.rect.y - 0.5, 10);
  drawRect(doc, block.frameRect, { stroke: "#222", lineWidth: 0.25 });
  block.rowMarkers.forEach((marker) => {
    drawRect(doc, marker.left, { fill: "#1f302c" });
    drawRect(doc, marker.right, { fill: "#1f302c" });
  });

  block.items.forEach((item) => drawObjectiveItem(doc, item));
}

function drawObjectiveItem(doc: PDFKit.PDFDocument, item: ObjectiveRenderItem) {
  const firstOption = item.options[0];
  if (firstOption) {
    drawText(doc, String(item.questionNumber), item.labelX - 2.5, firstOption.rect.y + 0.05, 7.2);
  }
  item.options.forEach((option) => {
    drawRect(doc, option.rect, { stroke: "#333", lineWidth: 0.15 });
    drawCenteredText(doc, option.label, option.rect.x, option.rect.y + 0.35, option.rect.width, 5.8);
  });
}

function drawSubjectiveBlock(
  doc: PDFKit.PDFDocument,
  card: AnswerCard,
  block: Extract<PageRenderBlock, { type: "subjective" }>
) {
  if (block.title) {
    drawText(doc, block.title, block.rect.x, block.rect.y - 0.5, 10);
  }
  if (block.frameRect) {
    drawRect(doc, block.frameRect, { stroke: "#222", lineWidth: 0.25 });
  }
  block.questions.forEach((question) => drawSubjectiveQuestion(doc, card, question, block.frameRect));
}

function drawSubjectiveQuestion(doc: PDFKit.PDFDocument, card: AnswerCard, question: SubjectiveRenderItem, frameRect?: Rect) {
  if (question.kind !== "blank") {
    drawRect(doc, question.rect, { stroke: "#222", lineWidth: 0.25 });
    drawText(doc, `${question.questionNumber}.（${question.score}分）`, question.rect.x + 2, question.contentRect.y + 2, 8);
  } else {
    drawText(doc, String(question.questionNumber), question.contentRect.x + 3, question.contentRect.y + 3.2, 8);
  }

  if (question.style === "manual_score_grid") {
    const firstScoreCell = question.scoreCells[0];
    if (frameRect && question.kind === "blank" && firstScoreCell) {
      drawText(doc, "得分", frameRect.x + 4, firstScoreCell.rect.y + 1.2, 7);
      const dividerY = firstScoreCell.rect.y + firstScoreCell.rect.height + 2;
      doc.moveTo(pt(frameRect.x), pt(dividerY)).lineTo(pt(frameRect.x + frameRect.width), pt(dividerY)).dash(2, { space: 2 }).stroke();
    } else {
      const dividerY = question.contentRect.y;
      doc.moveTo(pt(question.rect.x), pt(dividerY)).lineTo(pt(question.rect.x + question.rect.width), pt(dividerY)).dash(2, { space: 2 }).stroke();
    }
    doc.undash();
    question.scoreCells.forEach((cell) => {
      drawRect(doc, cell.rect, { stroke: "#222", lineWidth: 0.2 });
      drawCenteredText(doc, String(cell.score), cell.rect.x, cell.rect.y + 1.2, cell.rect.width, 6);
    });
  }

  question.lineYs.forEach((lineY) => {
    doc.moveTo(pt(question.contentRect.x + 8), pt(lineY)).lineTo(pt(question.contentRect.x + question.contentRect.width - 6), pt(lineY)).stroke("#777");
  });

  question.blanks.forEach((blank, index) => {
    const blankLabel = question.kind === "blank" ? formatBlankLabel(question.blankLabelStyle, index) : `${question.questionNumber}.${index + 1}`;
    if (blankLabel) {
      const slotWidth = question.blankLabelSlotWidth ?? blankLabel.length * 1.8 + 0.8;
      drawText(doc, blankLabel, blank.x - slotWidth - 0.8, blank.y + blank.height - 2.35, 8, {
        width: pt(slotWidth),
        align: "right"
      });
    }
    doc.moveTo(pt(blank.x), pt(blank.y + blank.height)).lineTo(pt(blank.x + blank.width), pt(blank.y + blank.height)).stroke();
  });

  question.images.forEach((image) => {
    const fullPath = path.join(cardAssetsDir(card.id), path.basename(image.assetId));
    if (existsSync(fullPath)) {
      doc.image(fullPath, pt(image.rect.x), pt(image.rect.y), {
        width: pt(image.rect.width),
        height: pt(image.rect.height)
      });
      drawRect(doc, image.rect, { stroke: "#555", lineWidth: 0.15 });
    } else {
      drawRect(doc, image.rect, { stroke: "#999", lineWidth: 0.15 });
      drawCenteredText(doc, "图片缺失", image.rect.x, image.rect.y + image.rect.height / 2 - 2, image.rect.width, 8);
    }
  });
}

function drawFooter(doc: PDFKit.PDFDocument, pageNumber: number, totalPages: number) {
  drawCenteredText(doc, `第${pageNumber}页/共${totalPages}页`, 0, 282, 210, 9);
}

export function createPdf(card: AnswerCard): PDFKit.PDFDocument {
  const layout: LayoutDocument = buildLayout(card);
  const doc = new PDFDocument({
    size: [pt(layout.width), pt(layout.height)],
    margin: 0,
    autoFirstPage: false,
    info: {
      Title: card.title,
      Author: "Answer Card Designer"
    }
  });

  if (existsSync(fontRegular)) {
    doc.registerFont("regular", fontRegular, fontRegularPostscriptName);
  } else {
    doc.registerFont("regular", fontFallback);
  }

  layout.pages.forEach((page) => {
    doc.addPage();
    drawHeader(doc, page);
    drawStudentArea(doc, page);

    page.blocks.forEach((block) => {
      if (block.type === "objective") drawObjectiveBlock(doc, block);
      if (block.type === "subjective") drawSubjectiveBlock(doc, card, block);
    });

    drawFooter(doc, page.pageNumber, layout.pages.length);
  });

  return doc;
}
