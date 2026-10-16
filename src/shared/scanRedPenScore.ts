/**
 * 红笔手写分数格与扫描色彩模式（issue #331 ③「大题分数斜线有时读不到」）。
 *
 * 卡面的 `manual_score_grid` 分数格由识别器在**彩色像素**里做红笔门控
 * （native/AnswerCardRecognizer/answer_recognition.cpp 的 HSV 0–12 / 165–180 区间），
 * 灰度图（含修复前的灰度缺省、以及操作员显式选了灰度/黑白的会话）里红笔与印刷边框、
 * 铅笔痕迹同为灰色，红笔掩码全空，每格都判为 `no_red_line`，整题落到
 * `no_valid_subjective_score` → 分数按 0 计。于是「换了操作员/忘了改模式的批次读不到，
 * 其它批次正常」——现场感受就是「有时读不到、无规律」。路由缺省已由 #330 改成彩色，
 * 本模块负责的是剩下的：卡面事实判定、历史会话与显式灰度的升级、零红笔告警。
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
  return pages.some((page) => pageNeedsRedPenScoring(page));
}

/**
 * 单个布局页是否有分数格。整卡判定只决定「要不要彩色」，
 * 批后统计必须逐页问这一句：纯客观题页的 subjectiveQuestions 恒为空，
 * 把它们算进分母就会出现「分数页根本不在这批里，却报一张都没读到」。
 */
export function pageNeedsRedPenScoring(page: Pick<PageLayout, "elements"> | undefined): boolean {
  return Boolean(page?.elements.some((element) => element.type === "score_cell"));
}

/**
 * 只有明确写成 `gray` / `bw` 才按低色彩扫；其余（缺省的 color、缺字段、非法字符串）一律按彩色。
 * #330 之后路由缺省已是彩色，这里若把「不认识的值」降级成灰度，等于自己造出 ③ 的病根——
 * 不含分数格的卡更不会被升级，那种卡就会静默按灰度扫。
 */
function asScanColorMode(value: ScanColorMode | string | undefined): ScanColorMode {
  return value === "gray" || value === "bw" ? value : "color";
}

/**
 * 含分数格的卡恒定用彩色扫描：这是扫描前的唯一判定点，
 * 调用方不能各自再写一套 `colorMode === "color"` 判断。
 */
export function resolveScanColorMode(
  requested: ScanColorMode | string | undefined,
  needsRedPen: boolean
): { colorMode: ScanColorMode; upgraded: boolean } {
  const current = asScanColorMode(requested);
  if (!needsRedPen || current === "color") return { colorMode: current, upgraded: false };
  return { colorMode: "color", upgraded: true };
}

/** 自动改用彩色时给操作员的提示（未升级时为 null）。 */
export function colorModeUpgradeNotice(from: ScanColorMode | string | undefined): string {
  const label = COLOR_MODE_LABELS[asScanColorMode(from)];
  return `本答题卡含红笔手写分数格，已自动把扫描模式从「${label}」改为「彩色」：红笔斜线在${label}下与印刷边框同为灰色，分数会一律读成 0。`;
}

/**
 * 整批一张红笔分数都没读到时的提示。只在「全部含分数格的页面都没有有效分数格笔迹」时给出：
 * 个别卷子空白属正常（缺考、未打分），全批为零才说明色彩模式或笔迹本身出了问题。
 *
 * 两种零红笔要分开说：识别器只把「看到红笔但没采纳」的格子放进 invalidCells，
 * 所以 invalidCells 有、validCells 全空 ⇒ 彩色可用、是画线方式不对；
 * 建议改彩色只会把老师引向一个不是原因的原因。
 */
export function redPenMissNotice(input: {
  needsRedPen: boolean;
  colorMode: ScanColorMode | string | undefined;
  pageCount: number;
  pagesWithRedMark: number;
  pagesWithRejectedRed?: number;
}): string | null {
  if (!input.needsRedPen || input.pageCount <= 0 || input.pagesWithRedMark > 0) return null;
  const counted = `本次 ${input.pageCount} 张含分数格的答卷页里，红笔分数格一张都没采纳`;
  if ((input.pagesWithRejectedRed ?? 0) > 0) {
    return `${counted}，但其中 ${input.pagesWithRejectedRed} 张读到了红笔只是未采信（多为斜线没有贯穿整格、格里有多处红迹如打「×」，或分数写在格外）。这与色彩模式无关，请对照原卷确认画线方式，判不了的在异常卷手工改分。`;
  }
  if (input.colorMode === "color") {
    return `${counted}。已用彩色扫描，请确认教师用的是红笔、斜线是否贯穿整个分数格；确属未打分的卷子按 0 分处理，可在异常卷手工改分。`;
  }
  // 这条走不到当代新扫描的批次：含分数格的卡在创建会话时就被 scanner-service 强制成彩色，
  // 落库的 color_mode 也是升级后的值。能进来的只有 #330 之前的历史会话，以及
  // 「先扫完、后来才在卡面加分数格」这类扫描时确实按灰度出图的批次。
  return `${counted}，而扫描模式为「${COLOR_MODE_LABELS[input.colorMode === "bw" ? "bw" : "gray"]}」：红笔在该模式下会被拍成灰线，分数一律按 0 计。请改用彩色模式重扫，或在异常卷手工改分。`;
}
