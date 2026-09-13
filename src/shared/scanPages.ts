import type { CombinedRecognitionResult } from "./types";

/** Resolve only the native recognizer's ID-only failure after a verified pairing
 * or an explicit teacher correction. Image/marker failures stay failed. */
export function applyScanStudentId(result: CombinedRecognitionResult, value: string, inherited = false): void {
  result.studentId = { status: inherited ? "inherited" : "ok", value };
  if (inherited) result.studentId.source = "inherited";
  if (result.status === "failed" && result.message === "Student ID recognition failed."
    && Number(result.quality?.matchCount ?? 0) >= 4 && Array.isArray(result.quality?.missingRoles)
    && Array.isArray(result.questions) && Array.isArray(result.subjectiveQuestions)) {
    result.status = result.quality!.missingRoles.length === 0 ? "ok" : "partial";
    result.message = inherited ? "学号已从同份答题卡首页继承" : "学号已人工订正";
  }
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
