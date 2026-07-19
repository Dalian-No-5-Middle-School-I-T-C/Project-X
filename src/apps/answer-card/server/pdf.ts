import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import type {
  AnswerCard,
  LayoutDocument,
  ObjectiveRenderItem,
  PageLayout,
  PageRenderBlock,
  Rect,
  SubjectiveBlock,
  SubjectiveRenderItem
} from "../../../shared/types";
import { buildLayout } from "../../../shared/layout";
import { formatBlankLabel } from "../../../shared/blankLabels";
import { cardAssetsDir } from "./storage";

const MM_TO_PT = 72 / 25.4;
const REGISTERED_FONT_NAME = "regular";
const BUILTIN_FALLBACK_FONT = "Helvetica";
const regularFonts = new WeakMap<PDFKit.PDFDocument, string>();

type FontCandidate = {
  filePath: string;
  postscriptName?: string;
};

const bundledFontCandidates: FontCandidate[] = [
  { filePath: "C:\\Windows\\Fonts\\msyh.ttc", postscriptName: "MicrosoftYaHei" },
  { filePath: "C:\\Windows\\Fonts\\simhei.ttf" },
  { filePath: "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", postscriptName: "NotoSansCJKsc-Regular" },
  { filePath: "/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf" },
  { filePath: "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc", postscriptName: "NotoSansCJKsc-Regular" },
  { filePath: "/usr/share/fonts/truetype/noto/NotoSansCJKsc-Regular.otf" },
  { filePath: "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc" },
  { filePath: "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc" },
  { filePath: "/usr/share/fonts/truetype/arphic/uming.ttc" },
  { filePath: "/System/Library/Fonts/PingFang.ttc", postscriptName: "PingFangSC-Regular" },
  { filePath: "/Library/Fonts/Arial Unicode.ttf" },
  { filePath: "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf" }
];

function envFontCandidates(): FontCandidate[] {
  const fontPath = process.env.PROJECTX_PDF_FONT_PATH ?? process.env.ANSWER_CARD_PDF_FONT_PATH;
  if (!fontPath) return [];
  return fontPath.split(path.delimiter).filter(Boolean).map((filePath) => ({
    filePath,
    postscriptName: process.env.PROJECTX_PDF_FONT_POSTSCRIPT_NAME ?? process.env.ANSWER_CARD_PDF_FONT_POSTSCRIPT_NAME
  }));
}

function discoverSystemFontCandidates(): FontCandidate[] {
  const fontDirs = [
    "/usr/share/fonts/opentype/noto",
    "/usr/share/fonts/truetype/noto",
    "/usr/share/fonts/truetype/wqy",
    "/usr/share/fonts/truetype/arphic",
    "C:\\Windows\\Fonts",
    "/System/Library/Fonts",
    "/Library/Fonts"
  ];
  const preferredNames = [/noto.*cjk.*sc.*regular/i, /noto.*sans.*cjk.*regular/i, /source.*han.*sans.*sc.*regular/i, /wqy.*microhei/i, /wqy.*zenhei/i, /simhei/i, /msyh/i, /pingfang/i, /dejavusans/i];
  const candidates: FontCandidate[] = [];

  for (const dir of fontDirs) {
    if (!existsSync(dir)) continue;
    let filenames: string[];
    try {
      filenames = readdirSync(dir);
    } catch {
      continue;
    }
    for (const pattern of preferredNames) {
      const filename = filenames.find((name) => pattern.test(name) && /\.(ttf|ttc|otf)$/i.test(name));
      if (filename) candidates.push({ filePath: path.join(dir, filename) });
    }
  }

  return candidates;
}

function setupRegularFont(doc: PDFKit.PDFDocument): void {
  const candidates = [...envFontCandidates(), ...bundledFontCandidates, ...discoverSystemFontCandidates()];
  const tried = new Set<string>();

  for (const candidate of candidates) {
    if (!existsSync(candidate.filePath)) continue;
    const cacheKey = `${candidate.filePath}\0${candidate.postscriptName ?? ""}`;
    if (tried.has(cacheKey)) continue;
    tried.add(cacheKey);

    try {
      if (candidate.postscriptName) {
        doc.registerFont(REGISTERED_FONT_NAME, candidate.filePath, candidate.postscriptName);
      } else {
        doc.registerFont(REGISTERED_FONT_NAME, candidate.filePath);
      }
      regularFonts.set(doc, REGISTERED_FONT_NAME);
      return;
    } catch (error) {
      console.warn(`[Project-X] PDF font registration failed: ${candidate.filePath}`, error);
    }
  }

  console.warn("[Project-X] No CJK-capable PDF font was found. Falling back to Helvetica; Chinese text may not render correctly.");
  regularFonts.set(doc, BUILTIN_FALLBACK_FONT);
}

function regularFont(doc: PDFKit.PDFDocument): string {
  return regularFonts.get(doc) ?? BUILTIN_FALLBACK_FONT;
}

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
  doc.font(regularFont(doc)).fontSize(size).fillColor("#111").text(text, pt(x), pt(y), options);
}

function drawCenteredText(doc: PDFKit.PDFDocument, text: string, x: number, y: number, width: number, size = 9) {
  doc.font(regularFont(doc)).fontSize(size).fillColor("#111").text(text, pt(x), pt(y), { width: pt(width), align: "center" });
}

// 在给定方框内将文本水平且垂直居中。
// pdfkit 的 text() 以文本块顶部为 Y 原点，行高约为字号 * 1.2，据此换算毫米后在框内垂直居中。
function drawCenteredBoxText(
  doc: PDFKit.PDFDocument,
  text: string,
  x: number,
  y: number,
  width: number,
  height: number,
  size = 5.8
) {
  const textHeightMm = (size * 1.2 / 72) * 25.4;
  const centeredY = y + (height - textHeightMm) / 2;
  doc.font(regularFont(doc)).fontSize(size).fillColor("#111").text(text, pt(x), pt(centeredY), {
    width: pt(width),
    align: "center",
    lineBreak: false
  });
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
    const titleWidth = Math.max(40, page.panels[0]?.rect.width ?? page.width - 70);
    doc.font(regularFont(doc)).fontSize(15).fillColor("#111").text(page.header.title, pt(page.header.titleX - titleWidth / 2), pt(page.header.titleY - 4), {
      width: pt(titleWidth),
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
  const separatorX = digitRect.x + 8.5;
  doc.moveTo(pt(separatorX), pt(digitRect.y + 7)).lineTo(pt(separatorX), pt(digitRect.y + digitRect.height)).stroke();

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
    drawCenteredBoxText(doc, String(item.questionNumber), item.labelX - 2.5, firstOption.rect.y, 5, firstOption.rect.height, 7.2);
  }
  item.options.forEach((option) => {
    drawRect(doc, option.rect, { stroke: "#333", lineWidth: 0.15 });
    drawCenteredBoxText(doc, option.label, option.rect.x, option.rect.y, option.rect.width, option.rect.height, 5.8);
  });
}

function drawSubjectiveBlock(
  doc: PDFKit.PDFDocument,
  card: AnswerCard,
  block: Extract<PageRenderBlock, { type: "subjective" }>
) {
  // 作文块专用渲染
  const originalBlock = card.bodyBlocks.find(b => b.id === block.blockId);
  const isEssay = originalBlock?.type === "subjective" && originalBlock.blockKind === "essay";

  if (isEssay) {
    drawEssayGrid(doc, originalBlock, block);
    return;
  }

  if (block.title) {
    drawText(doc, block.title, block.rect.x, block.rect.y - 0.5, 10);
  }
  if (block.frameRect) {
    drawRect(doc, block.frameRect, { stroke: "#222", lineWidth: 0.25 });
  }
  block.questions.forEach((question) => drawSubjectiveQuestion(doc, card, question, block.frameRect));
}

function drawEssayGrid(
  doc: PDFKit.PDFDocument,
  originalBlock: SubjectiveBlock,
  block: Extract<PageRenderBlock, { type: "subjective" }>
) {
  const q = originalBlock.questions[0];
  const g = q?.essayGrid;
  if (!g) return;

  const cellW = g.cellWidthMm || 7;
  const cellH = g.cellHeightMm || 7;
  const lineColor = g.lineColor || "#222";
  const lineW = g.lineWidthMm ?? 0.15;
  const showTitle = g.showTitle !== false;
  const insetX = 4;

  const bodyW = block.rect.width;
  const usableW = bodyW - insetX * 2;
  const columns = g.columns > 0 ? g.columns : Math.floor(usableW / cellW);
  const gridW = columns * cellW;
  const offsetX = block.rect.x + (bodyW - gridW) / 2;

  const gridH = block.rect.height - (showTitle ? 9 : 2);
  const rows = Math.floor(gridH / cellH);
  const startY = block.rect.y + (showTitle ? 9 : 2);

  // 标题
  if (showTitle) {
    drawText(doc, `${block.title}（${q?.score ?? 0}分）`, block.rect.x + insetX, block.rect.y + 1.5, 9);
  }

  // 格子
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      const cx = offsetX + col * cellW;
      const cy = startY + row * cellH;
      drawRect(doc, { x: cx, y: cy, width: cellW, height: cellH }, {
        stroke: lineColor, lineWidth: lineW, fill: "#fff"
      });
    }
  }
}

function drawSubjectiveQuestion(doc: PDFKit.PDFDocument, card: AnswerCard, question: SubjectiveRenderItem, frameRect?: Rect) {
  const isV2 = card.layoutVersion === 2;
  if (question.kind !== "blank") {
    drawRect(doc, question.rect, { stroke: "#222", lineWidth: 0.25 });
    drawText(doc, `${question.questionNumber}.（${question.score}分）`, question.rect.x + 2, isV2 ? question.rect.y + 1.2 : question.contentRect.y + 2, 8);
  } else {
    drawText(doc, String(question.questionNumber), question.contentRect.x + 3, question.contentRect.y + 3.2, 8);
  }

  if (question.style === "manual_score_grid" && (!isV2 || question.scoreCells.length > 0)) {
    const sg = question.scoreGrid;
    const sc = sg?.strokeColor ?? "#999";
    const sw = sg?.strokeWidthMm ?? 0.15;
    const fc = sg?.fillColor ?? "#fff";
    const fs = sg?.fontSize ? pt(sg.fontSize) : 6;
    const dc = sg?.dividerColor ?? "#ccc";
    const dw = sg?.dividerWidthMm ?? 0.1;
    const showL = sg?.showLabel !== false;

    const firstScoreCell = question.scoreCells[0];
    if (frameRect && question.kind === "blank" && firstScoreCell) {
      if (showL) drawText(doc, "得分", frameRect.x + 4, firstScoreCell.rect.y + (isV2 ? 0.55 : 1.2), 7);
      const dividerY = isV2 ? frameRect.y + 6 : firstScoreCell.rect.y + firstScoreCell.rect.height + 2;
      doc.lineWidth(pt(dw));
      doc.moveTo(pt(frameRect.x), pt(dividerY)).lineTo(pt(frameRect.x + frameRect.width), pt(dividerY)).stroke(dc);
    } else {
      const dividerY = question.contentRect.y;
      doc.lineWidth(pt(dw));
      doc.moveTo(pt(question.rect.x), pt(dividerY)).lineTo(pt(question.rect.x + question.rect.width), pt(dividerY)).stroke(dc);
    }
    question.scoreCells.forEach((cell) => {
      drawRect(doc, cell.rect, { stroke: sc, lineWidth: sw, fill: fc });
      if (cell.score !== null) {
        drawCenteredText(doc, String(cell.score), cell.rect.x, cell.rect.y + (isV2 ? 0.55 : 1.2), cell.rect.width, fs);
      }
    });
  }

  const lcfg = question.lineGrid;
  const lcolor = lcfg?.lineColor ?? "#222";
  const lwidthMm = lcfg?.lineWidthMm ?? 0.15;
  const linsetL = lcfg?.insetLeftMm ?? 8;
  const linsetR = lcfg?.insetRightMm ?? 6;
  const lstyle = lcfg?.lineStyle;
  if (lstyle === "dashed") {
    doc.dash(pt(1.2), { space: pt(0.8) });
  } else if (lstyle === "dotted") {
    doc.dash(pt(0.3), { space: pt(0.7) });
    doc.lineCap("round");
  }

  question.lineYs.forEach((lineY) => {
    doc.lineWidth(pt(lwidthMm));
    doc.moveTo(pt(question.contentRect.x + linsetL), pt(lineY))
       .lineTo(pt(question.contentRect.x + question.contentRect.width - linsetR), pt(lineY))
       .stroke(lcolor);
  });

  if (lstyle === "dashed" || lstyle === "dotted") {
    doc.undash();
    doc.lineCap("butt");
  }

  question.blanks.forEach((blank, index) => {
    const blankLabel = question.blankLabels?.[index] ?? (question.kind === "blank" ? formatBlankLabel(question.blankLabelStyle, index) : `${question.questionNumber}.${index + 1}`);
    if (blankLabel) {
      const slotWidth = question.blankLabelSlotWidth ?? blankLabel.length * 1.8 + 0.8;
      drawText(doc, blankLabel, blank.x - slotWidth - 0.8, blank.y + blank.height - 2.35, 8, {
        width: pt(slotWidth),
        align: "right"
      });
    }
    doc.moveTo(pt(blank.x), pt(blank.y + blank.height)).lineTo(pt(blank.x + blank.width), pt(blank.y + blank.height)).stroke();
    const anno = question.blankRightAnnotations?.[index];
    if (anno) {
      drawText(doc, anno, blank.x + blank.width + 1.2, blank.y + blank.height - 2.35, 7);
    }
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

function drawFooter(doc: PDFKit.PDFDocument, page: PageLayout, totalPages: number) {
  drawCenteredText(doc, `第${page.pageNumber}页/共${totalPages}页`, 0, page.height - 15, page.width, 9);
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

  setupRegularFont(doc);

  layout.pages.forEach((page) => {
    doc.addPage({ size: [pt(page.width), pt(page.height)], margin: 0 });
    drawHeader(doc, page);
    drawStudentArea(doc, page);

    page.blocks.forEach((block) => {
      if (block.type === "objective") drawObjectiveBlock(doc, block);
      if (block.type === "subjective") drawSubjectiveBlock(doc, card, block);
    });

    drawFooter(doc, page, layout.pages.length);
  });

  return doc;
}
