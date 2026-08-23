// 作文格共享几何：排版引擎（layout.ts）、SVG 预览（DesignEditors.tsx）、PDF 导出（pdf.ts）
// 三处必须得到完全一致的格子布局（列数/行数/行缝/字数刻度），否则「预览看到的行数」
// 与「导出 PDF 的行数」不一致。此模块是作文格几何的唯一事实源。
import type { EssayGridConfig, Rect } from "./types";

/** 行间窄缝宽度（mm）：仿网上阅卷答题卡，行缝用于放淡虚线与每 100 字刻度。 */
export const ESSAY_ROW_GAP_MM = 1.6;
/** 新建作文块的默认格线颜色：仿网上阅卷答题卡的朱红格线；旧卡保留已存颜色。 */
export const ESSAY_DEFAULT_LINE_COLOR = "#c00000";
/** 格区左右内缩（mm），与历史渲染保持一致。 */
export const ESSAY_GRID_INSET_X = 4;
/** 标题区高度（mm）；无标题时仅留窄边。 */
export const ESSAY_GRID_TOP_WITH_TITLE = 9;
export const ESSAY_GRID_TOP_WITHOUT_TITLE = 2;
/** 格区底部留白（mm）。 */
export const ESSAY_GRID_BOTTOM_PAD = 2;

export interface EssayGridGeometry {
  columns: number;
  rows: number;
  cellW: number;
  cellH: number;
  gap: number;
  /** 格子区域左上角 X（面板内居中）。 */
  offsetX: number;
  /** 第一行格子顶部 Y（已含标题区高度）。 */
  startY: number;
  gridW: number;
  /** 第 row 行（0 起）格子顶部 Y。 */
  rowY: (row: number) => number;
  /** 第 row 行下方窄缝中心 Y（虚线/字数刻度位置）。 */
  rowSeamY: (row: number) => number;
  /** n 行格子占用的净高度（末行不留缝）。 */
  rowsHeight: (rows: number) => number;
}

/**
 * 由面板 rect 与作文格配置推导几何。行数公式 floor((gridH+gap)/(cellH+gap)) 与
 * layoutEssayBlock 的高度分配互为逆运算：分配 blockHeight = gridTop + rowsHeight(n) + bottomPad
 * 时，本函数在同一 rect 上恰好解出 n 行。
 */
export function essayGridGeometry(panelRect: Rect, config: EssayGridConfig): EssayGridGeometry {
  const cellW = Math.max(1, config.cellWidthMm || 7);
  const cellH = Math.max(1, config.cellHeightMm || 7);
  const usableW = panelRect.width - ESSAY_GRID_INSET_X * 2;
  const columns = config.columns > 0 ? config.columns : Math.max(1, Math.floor(usableW / cellW));
  const gridW = columns * cellW;
  const offsetX = panelRect.x + (panelRect.width - gridW) / 2;
  const gridTop = config.showTitle !== false ? ESSAY_GRID_TOP_WITH_TITLE : ESSAY_GRID_TOP_WITHOUT_TITLE;
  const gridH = Math.max(0, panelRect.height - gridTop - ESSAY_GRID_BOTTOM_PAD);
  const rows = Math.max(0, Math.floor((gridH + ESSAY_ROW_GAP_MM) / (cellH + ESSAY_ROW_GAP_MM)));
  const startY = panelRect.y + gridTop;
  const rowY = (row: number) => startY + row * (cellH + ESSAY_ROW_GAP_MM);
  const rowSeamY = (row: number) => startY + (row + 1) * (cellH + ESSAY_ROW_GAP_MM) - ESSAY_ROW_GAP_MM / 2;
  const rowsHeight = (count: number) => count * cellH + Math.max(0, count - 1) * ESSAY_ROW_GAP_MM;
  return { columns, rows, cellW, cellH, gap: ESSAY_ROW_GAP_MM, offsetX, startY, gridW, rowY, rowSeamY, rowsHeight };
}

export interface EssayWordScaleMark {
  milestone: number;
  /** 该里程碑格子的右边线 X（刻度数字右对齐于此，内缩 padX）。 */
  x: number;
  /** 该行下方窄缝中心 Y。 */
  seamY: number;
}

/** 每 100 字里程碑：startCell 为该面板首格的全局序号（跨栏/跨页续号）。 */
export function essayWordScaleMarks(
  geometry: EssayGridGeometry,
  startCell: number,
  targetChars: number
): EssayWordScaleMark[] {
  const marks: EssayWordScaleMark[] = [];
  if (geometry.columns <= 0) return marks;
  for (let row = 0; row < geometry.rows; row += 1) {
    const rowStart = startCell + row * geometry.columns;
    const rowEnd = rowStart + geometry.columns - 1;
    const milestone = Math.ceil((rowStart + 1) / 100) * 100;
    if (milestone <= rowEnd && milestone <= targetChars) {
      const cellIndex = milestone - rowStart - 1;
      marks.push({
        milestone,
        x: geometry.offsetX + (cellIndex + 1) * geometry.cellW,
        seamY: geometry.rowSeamY(row)
      });
    }
  }
  return marks;
}
