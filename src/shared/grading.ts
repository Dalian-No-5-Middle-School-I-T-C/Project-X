import type {
  AnswerCard,
  CombinedGradingRow,
  CombinedRecognitionResult,
  ObjectiveBlock,
  ObjectiveGradingRow,
  ObjectiveQuestionGrade,
  ObjectiveRecognitionQuestion,
  ObjectiveRecognitionResult,
  SubjectiveBlock,
  SubjectiveQuestion,
  SubjectiveQuestionGrade,
  SubjectiveQuestionGradeStatus,
  SubjectiveRecognitionQuestion
} from "./types";

export const OBJECTIVE_REVIEW_CONFIDENCE_THRESHOLD = 0.12;

const OPTION_LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

function normalizeOptions(options: string[] | undefined, optionCount?: number): string[] {
  const allowed = new Set(OPTION_LABELS.slice(0, optionCount ?? OPTION_LABELS.length));
  return Array.from(new Set((options ?? []).map((item) => item.toUpperCase()).filter((item) => allowed.has(item)))).sort();
}

function sameOptions(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((item, index) => item === right[index]);
}

function findObjectiveBlock(card: AnswerCard, questionNumber: number): ObjectiveBlock | null {
  for (const block of card.bodyBlocks) {
    if (block.type !== "objective") continue;
    const first = block.questionStart;
    const last = block.questionStart + block.questionCount - 1;
    if (questionNumber >= first && questionNumber <= last) {
      return block;
    }
  }
  return null;
}

export function objectiveQuestionNumbers(block: ObjectiveBlock): number[] {
  return Array.from({ length: block.questionCount }, (_, index) => block.questionStart + index);
}

export function optionLabelsFor(block: ObjectiveBlock): string[] {
  return OPTION_LABELS.slice(0, block.optionCount);
}

export function normalizeObjectiveAnswerKey(block: ObjectiveBlock): Record<number, string[]> {
  const normalized: Record<number, string[]> = {};
  for (const questionNumber of objectiveQuestionNumbers(block)) {
    const options = normalizeOptions(block.answerKey?.[questionNumber], block.optionCount);
    if (block.mode === "single" && options.length > 1) {
      normalized[questionNumber] = [options[0]];
    } else if (options.length > 0) {
      normalized[questionNumber] = options;
    }
  }
  return normalized;
}

export function gradeObjectiveQuestion(
  card: AnswerCard,
  question: ObjectiveRecognitionQuestion,
  confidenceThreshold = OBJECTIVE_REVIEW_CONFIDENCE_THRESHOLD
): ObjectiveQuestionGrade {
  const block = findObjectiveBlock(card, question.questionNumber);
  const confidence = Number.isFinite(question.confidence) ? question.confidence : 0;
  const selectedOptions = normalizeOptions(question.selectedOptions, block?.optionCount);
  const needsReview = confidence < confidenceThreshold;

  if (!block) {
    return {
      questionNumber: question.questionNumber,
      selectedOptions,
      correctOptions: [],
      score: 0,
      maxScore: 0,
      confidence,
      status: "review",
      needsReview: true,
      message: "题号不在当前答题卡的客观题范围内"
    };
  }

  const maxScore = block.scorePerQuestion;
  const correctOptions = normalizeOptions(block.answerKey?.[question.questionNumber], block.optionCount);
  if (correctOptions.length === 0) {
    return {
      questionNumber: question.questionNumber,
      selectedOptions,
      correctOptions,
      score: 0,
      maxScore,
      confidence,
      status: "missing_key",
      needsReview: true,
      message: "未配置标准答案"
    };
  }

  if (sameOptions(selectedOptions, correctOptions)) {
    return {
      questionNumber: question.questionNumber,
      selectedOptions,
      correctOptions,
      score: maxScore,
      maxScore,
      confidence,
      status: needsReview ? "review" : "correct",
      needsReview,
      message: needsReview ? "识别置信度偏低" : undefined
    };
  }

  const selectedSet = new Set(selectedOptions);
  const correctSet = new Set(correctOptions);
  const hasWrongOrExtra = selectedOptions.some((option) => !correctSet.has(option));
  const isSubset = selectedOptions.length > 0 && selectedOptions.every((option) => correctSet.has(option));
  const canPartial = (block.mode === "multiple" || block.mode === "indefinite") && isSubset && !hasWrongOrExtra;
  const partialScore = canPartial ? (block.multipleScoring?.partialScores[selectedOptions.length] ?? 0) : undefined;
  const score = partialScore ?? block.multipleScoring?.wrongOrExtraScore ?? 0;

  return {
    questionNumber: question.questionNumber,
    selectedOptions,
    correctOptions,
    score,
    maxScore,
    confidence,
    status: score > 0 ? "partial" : needsReview ? "review" : "wrong",
    needsReview,
    message: needsReview ? "识别置信度偏低" : undefined
  };
}

export function gradeObjectiveRecognition(
  card: AnswerCard,
  fileName: string,
  recognition: ObjectiveRecognitionResult
): ObjectiveGradingRow {
  const questionMap = new Map(recognition.questions.map((question) => [question.questionNumber, question]));
  const grades: ObjectiveQuestionGrade[] = [];

  for (const block of card.bodyBlocks) {
    if (block.type !== "objective") continue;
    for (const questionNumber of objectiveQuestionNumbers(block)) {
      const recognized = questionMap.get(questionNumber) ?? {
        questionNumber,
        selectedOptions: [],
        confidence: 0
      };
      grades.push(gradeObjectiveQuestion(card, recognized));
    }
  }

  const score = roundScore(grades.reduce((sum, item) => sum + item.score, 0));
  const maxScore = roundScore(grades.reduce((sum, item) => sum + item.maxScore, 0));
  const needsReviewCount = grades.filter((item) => item.needsReview).length;
  const issueCount =
    grades.filter((item) => item.status === "missing_key").length + (recognition.status === "ok" ? 0 : 1);
  const studentId = recognition.studentId?.status === "ok" ? recognition.studentId.value : null;

  return {
    fileName,
    studentId,
    recognitionStatus: recognition.status,
    score,
    maxScore,
    needsReviewCount,
    issueCount,
    message: recognition.message,
    questions: grades,
    recognition
  };
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function findSubjectiveBlock(card: AnswerCard, questionId: string): SubjectiveBlock | null {
  for (const block of card.bodyBlocks) {
    if (block.type !== "subjective") continue;
    if (block.questions.some((q) => q.id === questionId)) return block;
  }
  return null;
}

function findSubjectiveQuestion(card: AnswerCard, questionId: string): SubjectiveQuestion | undefined {
  for (const block of card.bodyBlocks) {
    if (block.type !== "subjective") continue;
    const q = block.questions.find((q) => q.id === questionId);
    if (q) return q;
  }
  return undefined;
}

export function gradeSubjectiveRecognition(
  card: AnswerCard,
  recognition: SubjectiveRecognitionQuestion
): SubjectiveQuestionGrade {
  const question = findSubjectiveQuestion(card, recognition.questionId);
  const maxScore = question?.score ?? recognition.maxScore;
  const needsReview = recognition.status !== "ok";

  let status: SubjectiveQuestionGradeStatus = "ok";
  if (recognition.status === "invalid") status = "invalid";
  else if (needsReview) status = "missing_score_grid";

  return {
    questionId: recognition.questionId,
    questionNumber: recognition.questionNumber,
    score: Math.min(recognition.score, maxScore),
    maxScore,
    status,
    needsReview,
    confidence: recognition.confidence,
    validCells: recognition.validCells,
    invalidCells: recognition.invalidCells,
    message: recognition.message
  };
}

export function gradeCombinedRecognition(
  card: AnswerCard,
  fileName: string,
  recognition: CombinedRecognitionResult
): CombinedGradingRow {
  const objectiveRow = gradeObjectiveRecognition(card, fileName, recognition);

  const subjectiveQuestions: SubjectiveQuestionGrade[] = (recognition.subjectiveQuestions ?? []).map((sq) =>
    gradeSubjectiveRecognition(card, sq)
  );

  const objectiveScore = objectiveRow.score;
  const objectiveMaxScore = objectiveRow.maxScore;
  const subjectiveScore = roundScore(subjectiveQuestions.reduce((sum, q) => sum + q.score, 0));
  const subjectiveMaxScore = roundScore(subjectiveQuestions.reduce((sum, q) => sum + q.maxScore, 0));

  return {
    ...objectiveRow,
    objectiveScore,
    objectiveMaxScore,
    subjectiveScore,
    subjectiveMaxScore,
    totalScore: roundScore(objectiveScore + subjectiveScore),
    totalMaxScore: roundScore(objectiveMaxScore + subjectiveMaxScore),
    subjectiveQuestions,
    recognition
  };
}

// ── Multi-page / Duplex Combined Grading ────────────────

export interface PageGradingResult {
  recordId: string;
  pageNum: number;
  side: string;
  imagePath: string;
  objectiveScore: number;
  objectiveMaxScore: number;
  subjectiveScore: number;
  subjectiveMaxScore: number;
  totalScore: number;
  totalMaxScore: number;
  ocrStatus: string;
  needsReviewCount: number;
}

export interface CombinedStudentResult {
  studentId: string;
  pages: PageGradingResult[];
  totalScore: number;
  totalMaxScore: number;
  objectiveScore: number;
  objectiveMaxScore: number;
  subjectiveScore: number;
  subjectiveMaxScore: number;
  needsReviewCount: number;
  pageCount: number;
  objectiveQuestions: ObjectiveQuestionGrade[];
  subjectiveQuestions: SubjectiveQuestionGrade[];
}

/**
 * Combine grading results from multiple pages/sides for the same student.
 * Deduplicates questions across pages (prefers non-missing_key results, then higher score).
 */
export function gradeSessionStudentResults(
  card: AnswerCard,
  pages: Array<{
    recordId: string;
    pageNum: number;
    side: string;
    imagePath: string;
    recognition: CombinedRecognitionResult;
    ocrStatus: string;
  }>
): CombinedStudentResult {
  const objQMap = new Map<number, ObjectiveQuestionGrade>();
  const subjQMap = new Map<string, SubjectiveQuestionGrade>();

  const pageResults: PageGradingResult[] = pages.map((page) => {
    const row = gradeCombinedRecognition(card, page.imagePath, page.recognition);

    // Deduplicate across pages — prefer better results (non-missing_key, higher score)
    for (const q of row.questions) {
      const existing = objQMap.get(q.questionNumber);
      if (!existing || (existing.status === "missing_key" && q.status !== "missing_key") ||
          (existing.score < q.score && q.status !== "missing_key")) {
        objQMap.set(q.questionNumber, q);
      }
    }
    for (const sq of row.subjectiveQuestions) {
      const key = String(sq.questionId) || String(sq.questionNumber);
      const existing = subjQMap.get(key);
      if (!existing || (existing.status === "missing_score_grid" && sq.status !== "missing_score_grid") ||
          (existing.score < sq.score && sq.status !== "missing_score_grid")) {
        subjQMap.set(key, sq);
      }
    }

    return {
      recordId: page.recordId,
      pageNum: page.pageNum,
      side: page.side,
      imagePath: page.imagePath,
      objectiveScore: row.objectiveScore,
      objectiveMaxScore: row.objectiveMaxScore,
      subjectiveScore: row.subjectiveScore,
      subjectiveMaxScore: row.subjectiveMaxScore,
      totalScore: row.totalScore,
      totalMaxScore: row.totalMaxScore,
      ocrStatus: page.ocrStatus,
      needsReviewCount: row.needsReviewCount
    };
  });

  const allObjectiveQuestions = Array.from(objQMap.values());
  const allSubjectiveQuestions = Array.from(subjQMap.values());

  // Compute totals from deduplicated questions, not from page sums
  const objectiveScore = roundScore(allObjectiveQuestions.reduce((sum, q) => sum + q.score, 0));
  const objectiveMaxScore = roundScore(allObjectiveQuestions.reduce((sum, q) => sum + q.maxScore, 0));
  const subjectiveScore = roundScore(allSubjectiveQuestions.reduce((sum, q) => sum + q.score, 0));
  const subjectiveMaxScore = roundScore(allSubjectiveQuestions.reduce((sum, q) => sum + q.maxScore, 0));
  const totalScore = roundScore(objectiveScore + subjectiveScore);
  const totalMaxScore = roundScore(objectiveMaxScore + subjectiveMaxScore);
  const needsReviewCount = allObjectiveQuestions.filter((q) => q.needsReview).length +
                            allSubjectiveQuestions.filter((q) => q.needsReview).length;

  return {
    studentId: pages[0]?.recognition.studentId?.value ?? "未识别",
    pages: pageResults,
    totalScore,
    totalMaxScore,
    objectiveScore,
    objectiveMaxScore,
    subjectiveScore,
    subjectiveMaxScore,
    needsReviewCount,
    pageCount: pageResults.length,
    objectiveQuestions: allObjectiveQuestions,
    subjectiveQuestions: allSubjectiveQuestions
  };
}
