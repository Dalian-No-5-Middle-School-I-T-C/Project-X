import type {
  AnswerCard,
  CombinedGradingRow,
  CombinedRecognitionResult,
  ObjectiveBlock,
  ObjectiveGradingRow,
  ObjectiveMode,
  ObjectiveQuestionConfig,
  ObjectiveQuestionGrade,
  ObjectiveRecognitionQuestion,
  ObjectiveRecognitionResult,
  ObjectiveScoringRule,
  SubjectiveBlock,
  SubjectiveQuestion,
  SubjectiveQuestionGrade,
  SubjectiveQuestionGradeStatus,
  SubjectiveRecognitionQuestion
} from "./types";

export const OBJECTIVE_REVIEW_CONFIDENCE_THRESHOLD = 0.12;

const OPTION_LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

export type ObjectiveQuestionDefinition = {
  questionNumber: number;
  mode: ObjectiveMode;
  optionCount: number;
  score: number;
  answerKey?: string[];
  scoringRule?: ObjectiveScoringRule;
};

function normalizeOptions(options: string[] | undefined, optionCount?: number): string[] {
  const allowed = new Set(OPTION_LABELS.slice(0, optionCount ?? OPTION_LABELS.length));
  return Array.from(new Set((options ?? []).map((item) => item.toUpperCase()).filter((item) => allowed.has(item)))).sort();
}

function sameOptions(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((item, index) => item === right[index]);
}

function legacyScoringRule(block: ObjectiveBlock): ObjectiveScoringRule | undefined {
  if (!block.multipleScoring) return undefined;
  return {
    type: "per_selected_count",
    partialScores: block.multipleScoring.partialScores ?? {},
    wrongOrExtraScore: block.multipleScoring.wrongOrExtraScore ?? 0
  };
}

function normalizeQuestionConfig(block: ObjectiveBlock, config: ObjectiveQuestionConfig): ObjectiveQuestionDefinition {
  return {
    questionNumber: config.questionNumber,
    mode: config.mode ?? block.mode,
    optionCount: config.optionCount ?? block.optionCount,
    score: config.score ?? block.scorePerQuestion,
    answerKey: config.answerKey ?? block.answerKey?.[config.questionNumber],
    scoringRule: config.scoringRule ?? legacyScoringRule(block)
  };
}

export function objectiveQuestionDefinitions(block: ObjectiveBlock): ObjectiveQuestionDefinition[] {
  if (block.questions && block.questions.length > 0) {
    return block.questions.map((question) => normalizeQuestionConfig(block, question));
  }
  return Array.from({ length: block.questionCount }, (_, index) => {
    const questionNumber = block.questionStart + index;
    return normalizeQuestionConfig(block, { questionNumber });
  });
}

function findObjectiveQuestion(
  card: AnswerCard,
  questionNumber: number
): { block: ObjectiveBlock; definition: ObjectiveQuestionDefinition } | null {
  for (const block of card.bodyBlocks) {
    if (block.type !== "objective") continue;
    const definition = objectiveQuestionDefinitions(block).find((item) => item.questionNumber === questionNumber);
    if (definition) {
      return { block, definition };
    }
  }
  return null;
}

export function objectiveQuestionNumbers(block: ObjectiveBlock): number[] {
  return objectiveQuestionDefinitions(block).map((question) => question.questionNumber);
}

export function optionLabelsFor(block: ObjectiveBlock): string[] {
  return OPTION_LABELS.slice(0, block.optionCount);
}

export function optionLabelsForQuestion(block: ObjectiveBlock, questionNumber: number): string[] {
  const definition = objectiveQuestionDefinitions(block).find((item) => item.questionNumber === questionNumber);
  return OPTION_LABELS.slice(0, definition?.optionCount ?? block.optionCount);
}

export function normalizeObjectiveAnswerKey(block: ObjectiveBlock): Record<number, string[]> {
  const normalized: Record<number, string[]> = {};
  for (const question of objectiveQuestionDefinitions(block)) {
    const options = normalizeOptions(question.answerKey, question.optionCount);
    if (question.mode === "single" && options.length > 1) {
      normalized[question.questionNumber] = [options[0]];
    } else if (options.length > 0) {
      normalized[question.questionNumber] = options;
    }
  }
  return normalized;
}

export function normalizeObjectiveQuestions(block: ObjectiveBlock): ObjectiveQuestionConfig[] {
  const answerKey = normalizeObjectiveAnswerKey(block);
  return objectiveQuestionDefinitions(block).map((question) => {
    const options = normalizeOptions(answerKey[question.questionNumber], question.optionCount);
    return {
      questionNumber: question.questionNumber,
      mode: question.mode,
      optionCount: question.optionCount,
      score: question.score,
      answerKey: question.mode === "single" && options.length > 1 ? [options[0]] : options,
      scoringRule: question.scoringRule
    };
  });
}

function partialScoreFor(
  rule: ObjectiveScoringRule | undefined,
  selectedCorrectCount: number,
  correctCount: number
): number | undefined {
  if (!rule) return undefined;
  if (rule.type === "fixed_partial") return rule.partialScore;
  if (rule.type === "by_correct_count") return rule.partialScoresByCorrectCount[correctCount]?.[selectedCorrectCount] ?? 0;
  return rule.partialScores[selectedCorrectCount] ?? 0;
}

function wrongOrExtraScoreFor(rule: ObjectiveScoringRule | undefined): number {
  return rule?.wrongOrExtraScore ?? 0;
}

export function gradeObjectiveQuestion(
  card: AnswerCard,
  question: ObjectiveRecognitionQuestion,
  confidenceThreshold = OBJECTIVE_REVIEW_CONFIDENCE_THRESHOLD
): ObjectiveQuestionGrade {
  const target = findObjectiveQuestion(card, question.questionNumber);
  const definition = target?.definition;
  const confidence = Number.isFinite(question.confidence) ? question.confidence : 0;
  const selectedOptions = normalizeOptions(question.selectedOptions, definition?.optionCount);
  const needsReview = confidence < confidenceThreshold;

  if (!definition) {
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

  const maxScore = definition.score;
  const correctOptions = normalizeOptions(definition.answerKey, definition.optionCount);
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

  const correctSet = new Set(correctOptions);
  const selectedCorrectCount = selectedOptions.filter((option) => correctSet.has(option)).length;
  const hasWrong = selectedCorrectCount < selectedOptions.length;
  const hasTooMany = selectedOptions.length > correctOptions.length;
  const allowsWrongOptions = definition.scoringRule?.allowWrongOptions === true;
  const canPartial =
    (definition.mode === "multiple" || definition.mode === "indefinite") &&
    selectedOptions.length > 0 &&
    selectedCorrectCount > 0 &&
    !hasTooMany &&
    (!hasWrong || allowsWrongOptions);
  const partialScore = canPartial
    ? partialScoreFor(definition.scoringRule, selectedCorrectCount, correctOptions.length)
    : undefined;
  const score = partialScore ?? wrongOrExtraScoreFor(definition.scoringRule);

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
