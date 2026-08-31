import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { openSync } from "fontkit";
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
import { ESSAY_GRID_INSET_X, essayGridGeometry, essayWordScaleMarks } from "../../../shared/essayGrid";
import { shouldRenderScoreGrid } from "../../../shared/scoreGrid";
import { cardAssetsDir } from "./storage";

const MM_TO_PT = 72 / 25.4;
const REGISTERED_FONT_NAME = "regular";
const CJK_FONT_PROBE_TEXT = "中文答题卡姓名班级页";
const cjkFontSupportCache = new Map<string, boolean>();

type FontCandidate = {
  filePath: string;
  postscriptName?: string;
};

const bundledFontCandidates: FontCandidate[] = [
  { filePath: "C:\\Windows\\Fonts\\simsun.ttc", postscriptName: "SimSun" },
  { filePath: "C:\\Windows\\Fonts\\msyh.ttc", postscriptName: "MicrosoftYaHei" },
  { filePath: "C:\\Windows\\Fonts\\simhei.ttf" },
  { filePath: "C:\\Windows\\Fonts\\NotoSansSC-VF.ttf" },
  { filePath: "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", postscriptName: "NotoSansCJKsc-Regular" },
  { filePath: "/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf" },
  { filePath: "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc", postscriptName: "NotoSansCJKsc-Regular" },
  { filePath: "/usr/share/fonts/truetype/noto/NotoSansCJKsc-Regular.otf" },
  { filePath: "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc" },
  { filePath: "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc" },
  { filePath: "/usr/share/fonts/truetype/arphic/uming.ttc" },
  { filePath: "/System/Library/Fonts/PingFang.ttc", postscriptName: "PingFangSC-Regular" },
  { filePath: "/Library/Fonts/Arial Unicode.ttf" }
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
  const preferredNames = [/noto.*sans.*sc.*(?:vf|regular)/i, /noto.*cjk.*sc.*regular/i, /noto.*sans.*cjk.*regular/i, /source.*han.*sans.*sc.*regular/i, /wqy.*microhei/i, /wqy.*zenhei/i, /simhei/i, /msyh/i, /pingfang/i];
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

export function fontFileSupportsCjk(filePath: string, postscriptName?: string): boolean {
  const cacheKey = `${filePath}\0${postscriptName ?? ""}`;
  const cached = cjkFontSupportCache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const font = openSync(filePath, postscriptName);
    const supported = "hasGlyphForCodePoint" in font &&
      Array.from(CJK_FONT_PROBE_TEXT).every((character) => font.hasGlyphForCodePoint(character.codePointAt(0)!));
    cjkFontSupportCache.set(cacheKey, supported);
    return supported;
  } catch {
    cjkFontSupportCache.set(cacheKey, false);
    return false;
  }
}

function setupRegularFont(doc: PDFKit.PDFDocument): void {
  const candidates = [...envFontCandidates(), ...bundledFontCandidates, ...discoverSystemFontCandidates()];
  const tried = new Set<string>();

  for (const candidate of candidates) {
    if (!existsSync(candidate.filePath)) continue;
    const cacheKey = `${candidate.filePath}\0${candidate.postscriptName ?? ""}`;
    if (tried.has(cacheKey)) continue;
    tried.add(cacheKey);
    if (!fontFileSupportsCjk(candidate.filePath, candidate.postscriptName)) continue;

    try {
      if (candidate.postscriptName) {
        doc.registerFont(REGISTERED_FONT_NAME, candidate.filePath, candidate.postscriptName);
      } else {
        doc.registerFont(REGISTERED_FONT_NAME, candidate.filePath);
      }
      return;
    } catch (error) {
      console.warn(`[Project-X] PDF font registration failed: ${candidate.filePath}`, error);
    }
  }

  throw new Error(
    "PDF 中文字体不可用：未找到包含中文字形的字体。Ubuntu 请安装 fonts-noto-cjk，或设置 PROJECTX_PDF_FONT_PATH；TTC 字体同时设置 PROJECTX_PDF_FONT_POSTSCRIPT_NAME。"
  );
}

function regularFont(doc: PDFKit.PDFDocument): string {
  return REGISTERED_FONT_NAME;
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
  const { infoRect, digitRect, digitCells, fieldRows, notesLines, notesY } = page.studentArea;
  drawRect(doc, infoRect, { stroke: "#333", lineWidth: 0.25 });
  fieldRows.forEach((row) => {
    drawText(doc, row.label, row.labelX, row.labelY, 9);
    doc.moveTo(pt(row.lineX1), pt(row.lineY)).lineTo(pt(row.lineX2), pt(row.lineY)).stroke();
  });
  if (notesLines && notesLines.length > 0 && notesY !== undefined) {
    notesLines.forEach((line, index) => {
      drawText(doc, line, infoRect.x + 5, notesY + index * 4.2, 7.5);
    });
  }
  // 关闭学号填涂区（showStudentNumber=false）时不绘制涂写格
  if (digitCells.length === 0) return;
  drawRect(doc, digitRect, { stroke: "#333", lineWidth: 0.25 });
  drawCenteredText(doc, "填涂号区", digitRect.x, digitRect.y + 2, digitRect.width, 10);

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
  const g = q?.essayGrid ?? { columns: 0, rows: 0, cellWidthMm: 7, cellHeightMm: 7, targetChars: 600, showTitle: true, lineColor: "#222", lineWidthMm: 0.15, showFrame: true, showWordScale: true };

  const lineColor = g.lineColor || "#222";
  const lineW = g.lineWidthMm ?? 0.15;
  const showTitle = g.showTitle !== false;
  const showFrame = g.showFrame !== false;
  const showWordScale = g.showWordScale !== false;
  // 几何唯一事实源：shared/essayGrid（与 SVG 预览、排版引擎共用，行数/行缝/刻度一致）
  const geo = essayGridGeometry(block.rect, g);
  const marks = showWordScale ? essayWordScaleMarks(geo, block.essayStartCell ?? 0, g.targetChars || 600) : [];

  // 粗边框（仿考试卷作文格外框）
  if (showFrame && block.frameRect) {
    drawRect(doc, block.frameRect, { stroke: "#111", lineWidth: 0.4 });
  }

  // 标题（置于边框内左上角）；题号右对齐，与 SVG 预览一致
  if (showTitle) {
    drawText(doc, block.title, block.rect.x + ESSAY_GRID_INSET_X, block.rect.y + 1.5, 9, { lineBreak: false });
    drawText(
      doc,
      `题：（${String(q?.number ?? 1).padStart(3, "0")}）`,
      block.rect.x + block.rect.width - ESSAY_GRID_INSET_X - 30,
      block.rect.y + 1.5,
      7,
      { align: "right", width: pt(30), lineBreak: false }
    );
  }

  // 格子：保持完整高度，行间留出较宽窄溜用于横向标注字数刻度
  for (let row = 0; row < geo.rows; row++) {
    const cy = geo.rowY(row);
    for (let col = 0; col < geo.columns; col++) {
      const cx = geo.offsetX + col * geo.cellW;
      drawRect(doc, { x: cx, y: cy, width: geo.cellW, height: geo.cellH }, {
        stroke: lineColor, lineWidth: lineW, fill: "#fff"
      });
    }
    // 行间窄溜：淡虚线贯穿整栏（末行不画）
    if (row < geo.rows - 1) {
      const lineY = geo.rowSeamY(row);
      doc.lineWidth(pt(0.08));
      doc.strokeColor("#ddd");
      doc.dash(pt(1), { space: pt(1) });
      doc.moveTo(pt(geo.offsetX), pt(lineY)).lineTo(pt(geo.offsetX + geo.gridW), pt(lineY)).stroke();
      doc.undash();
    }
  }

  // 字数刻度：每 100 字里程碑数字置于该行下方窄缝、右对齐到对应格右边线（格子右下角的窄溜里，不进格内）
  marks.forEach((mark) => {
    const boxW = geo.cellW + 1; // 容错宽度，右对齐落在格右边线内缩处
    drawText(doc, String(mark.milestone), mark.x - 0.6 - boxW, mark.seamY - 1.1, 4.5, {
      width: boxW, align: "right", lineBreak: false
    });
  });
}

function drawSubjectiveQuestion(doc: PDFKit.PDFDocument, card: AnswerCard, question: SubjectiveRenderItem, frameRect?: Rect) {
  const isV2 = card.layoutVersion === 2;
  if (question.kind !== "blank") {
    drawRect(doc, question.rect, { stroke: "#222", lineWidth: 0.25 });
    drawText(doc, `${question.questionNumber}.（${question.score}分）`, question.rect.x + 2, isV2 ? question.rect.y + 1.2 : question.contentRect.y + 2, 8);
  } else {
    drawText(doc, String(question.questionNumber), question.contentRect.x + 3, question.contentRect.y + 3.2, 8);
  }

  if (shouldRenderScoreGrid(question, isV2)) {
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
    doc.lineWidth(pt(0.25));
    doc.moveTo(pt(blank.x), pt(blank.y + blank.height)).lineTo(pt(blank.x + blank.width), pt(blank.y + blank.height)).stroke("#333");
    const anno = question.blankRightAnnotations?.[index];
    if (anno) {
      drawText(doc, anno, blank.x + blank.width + 1.2, blank.y + blank.height - 2.35, 7);
    }
  });

  (question.annotationLines ?? []).forEach((line) => {
    drawText(doc, line.text, line.rect.x, line.rect.y, 7);
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
