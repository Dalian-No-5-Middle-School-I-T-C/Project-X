/**
 * 红笔手写分数格与扫描色彩模式（issue #331 ③「大题分数斜线有时读不到」）。
 *
 * 卡面的 `manual_score_grid` 分数格由识别器在**彩色像素**里做红笔门控
 * （native/AnswerCardRecognizer/answer_recognition.cpp 的 HSV 0–12 / 165–180 区间），
 * 而扫描端、服务端与桥接三处的 colorMode 缺省都是 `gray`：灰度图里红笔与印刷边框、
 * 铅笔痕迹同为灰色，红笔掩码全空，每格都判为 `no_red_line`，整题落到
 * `no_valid_subjective_score` → 分数按 0 计。于是「换了操作员/忘了改模式的批次读不到，
 * 其它批次正常」——现场感受就是「有时读不到、无规律」。
 *
 * 这里只做一件事：把「含分数格 ⇒ 必须彩色」这条卡面事实变成扫描前的确定行为，
 * 并把「一张都没读到红笔」从静默 0 分变成一条能照着做的提示。
 */
import type { PageLayout } from "./types";

export type ScanColorMode = "gray" | "color" | "bw";

const COLOR_MODE_LABELS: Record<ScanColorMode, string> = {
  gray: "灰度",
  color: "彩色",
  bw: "黑白",
};

/** 版面里是否存在必须由红笔读取的手写分数格。 */
export function layoutNeedsRedPenScoring(pages: Pick<PageLayout, "elements">[]): boolean {
  return pages.some((page) => page.elements.some((element) => element.type === "score_cell"));
}

/**
 * 含分数格的卡恒定用彩色扫描：这是扫描前的唯一判定点，
 * 调用方不能各自再写一套 `colorMode === "color"` 判断。
 */
export function resolveScanColorMode(
  requested: ScanColorMode | string | undefined,
  needsRedPen: boolean
): { colorMode: ScanColorMode; upgraded: boolean } {
  const current: ScanColorMode = requested === "color" || requested === "bw" ? requested : "gray";
  if (!needsRedPen || current === "color") return { colorMode: current, upgraded: false };
  return { colorMode: "color", upgraded: true };
}

/** 自动改用彩色时给操作员的提示（未升级时为 null）。 */
export function colorModeUpgradeNotice(from: ScanColorMode | string | undefined): string {
  const label = COLOR_MODE_LABELS[from === "color" || from === "bw" ? from : "gray"];
  return `本答题卡含红笔手写分数格，已自动把扫描模式从「${label}」改为「彩色」：红笔斜线在${label}下与印刷边框同为灰色，分数会一律读成 0。`;
}

/**
 * 整批一张红笔分数都没读到时的提示。只在「全部页面都没有有效分数格笔迹」时给出：
 * 个别卷子空白属正常（缺考、未打分），全批为零才说明色彩模式或笔迹本身出了问题。
 */
export function redPenMissNotice(input: {
  needsRedPen: boolean;
  colorMode: ScanColorMode | string | undefined;
  pageCount: number;
  pagesWithRedMark: number;
}): string | null {
  if (!input.needsRedPen || input.pageCount <= 0 || input.pagesWithRedMark > 0) return null;
  const counted = `本次 ${input.pageCount} 张卷子的红笔分数格一张都没读到`;
  if (input.colorMode === "color") {
    return `${counted}。已用彩色扫描，请确认教师用的是红笔、斜线是否贯穿整个分数格；确属未打分的卷子按 0 分处理，可在异常卷手工改分。`;
  }
  return `${counted}，而扫描模式为「${COLOR_MODE_LABELS[input.colorMode === "bw" ? "bw" : "gray"]}」：红笔在该模式下会被拍成灰线，分数一律按 0 计。请改用彩色模式重扫，或在异常卷手工改分。`;
}
