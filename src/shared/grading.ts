import type {
  AnswerCard,
  CombinedGradingRow,
  CombinedRecognitionResult,
  ObjectiveBlock,
  ObjectiveGradingRow,
  ObjectiveQuestionGrade,
  ObjectiveRecognitionQuestion,
  ObjectiveRecognitionResult,
  SubjectiveQuestionGrade,
  SubjectiveQuestionNumber,
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

function subjectiveScoreQuestions(card: AnswerCard): Array<{ questionId: string; questionNumber: SubjectiveQuestionNumber; maxScore: number }> {
  const questions: Array<{ questionId: string; questionNumber: SubjectiveQuestionNumber; maxScore: number }> = [];
  for (const block of card.bodyBlocks) {
    if (block.type !== "subjective") continue;
    for (const question of block.questions) {
      if (question.style !== "manual_score_grid") continue;
      questions.push({
        questionId: question.id,
        questionNumber: question.number,
        maxScore: question.score
      });
    }
  }
  return questions;
}

function gradeSubjectiveQuestion(
  expected: { questionId: string; questionNumber: SubjectiveQuestionNumber; maxScore: number },
  recognized: SubjectiveRecognitionQuestion | undefined
): SubjectiveQuestionGrade {
  if (!recognized) {
    return {
      questionId: expected.questionId,
      questionNumber: expected.questionNumber,
      score: 0,
      maxScore: expected.maxScore,
      status: "invalid",
      needsReview: true,
      confidence: 0,
      validCells: [],
      invalidCells: [],
      message: "未识别到有效评分"
    };
  }

  const isOk = recognized.status === "ok";
  return {
    questionId: expected.questionId,
    questionNumber: expected.questionNumber,
    score: isOk ? roundScore(recognized.score) : 0,
    maxScore: expected.maxScore || recognized.maxScore,
    status: isOk ? "ok" : "invalid",
    needsReview: !isOk,
    confidence: Number.isFinite(recognized.confidence) ? recognized.confidence : 0,
    validCells: recognized.validCells ?? [],
    invalidCells: recognized.invalidCells ?? [],
    message: recognized.message ?? (isOk ? undefined : "未识别到有效评分")
  };
}

export function gradeCombinedRecognition(
  card: AnswerCard,
  fileName: string,
  recognition: CombinedRecognitionResult
): CombinedGradingRow {
  const objective = gradeObjectiveRecognition(card, fileName, recognition);
  const recognizedSubjective = new Map((recognition.subjectiveQuestions ?? []).map((question) => [question.questionId, question]));
  const subjectiveQuestions = subjectiveScoreQuestions(card).map((question) => gradeSubjectiveQuestion(question, recognizedSubjective.get(question.questionId)));
  const subjectiveScore = roundScore(subjectiveQuestions.reduce((sum, item) => sum + item.score, 0));
  const subjectiveMaxScore = roundScore(subjectiveQuestions.reduce((sum, item) => sum + item.maxScore, 0));
  const objectiveScore = objective.score;
  const objectiveMaxScore = objective.maxScore;
  const totalScore = roundScore(objectiveScore + subjectiveScore);
  const totalMaxScore = roundScore(objectiveMaxScore + subjectiveMaxScore);
  const subjectiveIssueCount = subjectiveQuestions.filter((question) => question.needsReview).length;

  return {
    ...objective,
    recognition,
    score: totalScore,
    maxScore: totalMaxScore,
    objectiveScore,
    objectiveMaxScore,
    subjectiveScore,
    subjectiveMaxScore,
    totalScore,
    totalMaxScore,
    issueCount: objective.issueCount + subjectiveIssueCount,
    needsReviewCount: objective.needsReviewCount + subjectiveIssueCount,
    subjectiveQuestions
  };
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}
