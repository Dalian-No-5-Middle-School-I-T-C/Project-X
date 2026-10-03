import type { CombinedRecognitionResult } from "./types";

/** Resolve only the native recognizer's ID-only failure after a verified pairing
 * or an explicit teacher correction. Image/marker failures stay failed. */
export function applyScanStudentId(result: CombinedRecognitionResult, value: string, inherited = false): void {
  if (result.identity?.status === "rejected") return;
  result.studentId = { status: inherited ? "inherited" : "ok", value };
  if (inherited) result.studentId.source = "inherited";
  if (result.status === "failed" && result.message === "Student ID recognition failed."
    && Number(result.quality?.matchCount ?? 0) >= 4 && Array.isArray(result.quality?.missingRoles)
    && Array.isArray(result.questions) && Array.isArray(result.subjectiveQuestions)) {
    result.status = result.quality!.missingRoles.length === 0 ? "ok" : "partial";
    result.message = inherited ? "学号已从同份答题卡首页继承" : "学号已人工订正";
  }
}

/**
 * B13：把 native 的**物理纸张号**换算成一次扫描会话内累计的纸张号（scan_records.page_num）。
 *
 * 两条约束必须同时成立，才能既修好「扫 100 张只显示 1 份答题卡」又不破坏双面扫描：
 *   1. native 的 `page` 只在单个扫描进程内从 1 递增（twain_controller.cpp:453 起），
 *      重启扫描就是新进程、必然重新计数，所以落库页号要加上「本会话已落库的最大纸张号」偏移；
 *      否则 mapScanPageToLayout 的 groupIndex 会恒为 0。
 *   2. 偏移的单位是**纸**而不是**张图**：同一张纸的正反两面共享同一个 page
 *      （twain_controller.cpp:473 与 :513 写的是同一个 pageNum），
 *      mapScanPageToLayout 也按「physicalPage + side」还原布局页与正反面。
 *      若按图片下标逐张递增，两份双面卷的分组会从 [0,0,1,1] 变成 [0,1,2,3]，
 *      正反面被拆到相邻两张「纸」上，首页学号继承与完整性校验随之失效。
 *
 * native 未给出有效纸张号（旧桥、异常值）时按「第几张纸」兜底推导：
 * 双面一批 4 张图 → 1,1,2,2；单面 → 1,2,3,4。
 */
export function assignScanRecordPageNums(
  pages: ReadonlyArray<{ page?: number }>,
  opts: { sheetOffset: number; sidesPerSheet: number },
): number[] {
  const sides = Math.max(1, Math.trunc(opts.sidesPerSheet) || 1);
  const offset = Math.max(0, Math.trunc(opts.sheetOffset) || 0);
  return pages.map((page, index) => {
    const nativeSheet = Number.isFinite(page.page) && Number(page.page) > 0
      ? Math.trunc(Number(page.page))
      : Math.floor(index / sides) + 1;
    return offset + nativeSheet;
  });
}

/** TWAIN pageNum identifies a physical sheet: its front and back share the number. */
export function mapScanPageToLayout(
  physicalPage: number,
  side: "front" | "back",
  layoutPageCount: number,
  sided: "single" | "double",
) {
  const sidesPerSheet = sided === "single" ? 1 : 2;
  const sheetsPerStudent = Math.max(1, Math.ceil(layoutPageCount / sidesPerSheet));
  const sheetIndex = Math.max(0, physicalPage - 1);
  const groupIndex = Math.floor(sheetIndex / sheetsPerStudent);
  const layoutPage = (sheetIndex % sheetsPerStudent) * sidesPerSheet + (side === "back" && sidesPerSheet === 2 ? 2 : 1);
  return { groupIndex, layoutPage, unusedSide: (sided === "single" && side === "back") || layoutPage > layoutPageCount };
}

export interface ScanBatchPage {
  recordId: string;
  pageNum: number;
  side: "front" | "back";
  layoutPage: number;
}

/** Imported images contain used layout pages only, in student/page order.
 * Reserve the unused back of an odd-page duplex card in physical sheet numbering. */
export function mapImportedScanPages(imageCount: number, layoutPageCount: number, sided: "single" | "double") {
  if (!Number.isSafeInteger(layoutPageCount) || layoutPageCount < 1 || imageCount < 1 || imageCount % layoutPageCount !== 0) {
    throw new Error(`导入图片缺页：每份答题卡需要 ${layoutPageCount} 张图片，请按学生、布局页序补齐`);
  }
  const sides = sided === "double" ? 2 : 1;
  const sheets = Math.ceil(layoutPageCount / sides);
  return Array.from({ length: imageCount }, (_, index) => {
    const groupIndex = Math.floor(index / layoutPageCount);
    const offset = index % layoutPageCount;
    const pageNum = groupIndex * sheets + Math.floor(offset / sides) + 1;
    const side = sides === 2 && offset % 2 === 1 ? "back" as const : "front" as const;
    const mapping = mapScanPageToLayout(pageNum, side, layoutPageCount, sided);
    return { pageNum, side, groupId: String(mapping.groupIndex), layoutPage: mapping.layoutPage };
  });
}

export interface ScanBatchFailure {
  groupId: string;
  studentId: string | null;
  stage: "recognition" | "grading" | "saving";
  message: string;
  pages: ScanBatchPage[];
  /** Other attempts, including withdrawn saved attempts, requiring teacher review. */
  conflicts?: ScanConflictCard[];
}

export interface ScanConflictCard {
  sessionId: string;
  groupId: string;
  studentId: string;
  previouslySaved: boolean;
  totalScore?: number;
  pages: ScanBatchPage[];
}

export interface ScanBatchResult {
  groupId: string;
  studentId: string;
  totalScore: number;
  maxScore: number;
  objectiveScore: number;
  objectiveMaxScore: number;
  subjectiveScore: number;
  subjectiveMaxScore: number;
  needsReviewCount: number;
  pageCount: number;
  saved: boolean;
  pages: Array<ScanBatchPage & {
    objectiveScore: number;
    subjectiveScore: number;
    totalScore: number;
    totalMaxScore: number;
  }>;
}

export interface ScanBatchResponse {
  results: ScanBatchResult[];
  failures: ScanBatchFailure[];
  reviewCards?: ScanConflictCard[];
}
