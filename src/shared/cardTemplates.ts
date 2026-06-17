import type {
  AnswerCard,
  BodyBlock,
  ObjectiveBlock,
  ObjectiveMode,
  ObjectiveQuestionConfig,
  ObjectiveScoringRule,
  SubjectiveBlock,
  SubjectiveQuestion
} from "./types";

export type SubjectTemplateOptions = {
  englishListening?: boolean;
  chineseChoicePlacement?: "front" | "inline";
};

const DEFAULT_DENSITY = "compact" as const;

function templateId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

function objectiveQuestion(
  questionNumber: number,
  mode: ObjectiveMode,
  optionCount: number,
  score: number,
  scoringRule?: ObjectiveScoringRule
): ObjectiveQuestionConfig {
  return { questionNumber, mode, optionCount, score, answerKey: [], scoringRule };
}

function objectiveBlock(title: string, questions: ObjectiveQuestionConfig[]): ObjectiveBlock {
  const first = questions[0] ?? objectiveQuestion(1, "single", 4, 0);
  return {
    id: templateId("obj"),
    type: "objective",
    title,
    questionStart: first.questionNumber,
    questionCount: questions.length,
    optionCount: first.optionCount ?? 4,
    mode: first.mode ?? "single",
    scorePerQuestion: first.score ?? 0,
    density: DEFAULT_DENSITY,
    answerKey: {},
    multipleScoring: { partialScores: {}, wrongOrExtraScore: 0 },
    questions
  };
}

function linedQuestion(number: number | string, score = 0, minHeightMm = 34): SubjectiveQuestion {
  return {
    id: templateId("q"),
    number,
    score,
    style: "manual_score_grid",
    kind: "lined_answer",
    lineGrid: { enabled: true, lineSpacingMm: 8 },
    images: [],
    minHeightMm
  };
}

function blankQuestion(number: number | string, score = 0, count = 1): SubjectiveQuestion {
  return {
    id: templateId("q"),
    number,
    score,
    style: score > 0 ? "manual_score_grid" : "plain_subjective",
    kind: "blank",
    blanks: { count, widthMm: 24, heightMm: 6, labelStyle: "none" },
    lineGrid: { enabled: false, lineSpacingMm: 8 },
    images: [],
    minHeightMm: 14
  };
}

function subjectiveBlock(title: string, questions: SubjectiveQuestion[]): SubjectiveBlock {
  return { id: templateId("subj"), type: "subjective", title, questions };
}

function rangeQuestions(start: number, end: number, mode: ObjectiveMode, optionCount: number, score: number): ObjectiveQuestionConfig[] {
  return Array.from({ length: end - start + 1 }, (_, index) =>
    objectiveQuestion(start + index, mode, optionCount, score)
  );
}

const chineseQuestion10Rule: ObjectiveScoringRule = {
  type: "per_selected_count",
  partialScores: { 1: 1, 2: 2 },
  wrongOrExtraScore: 0,
  allowWrongOptions: true
};

const mathMultiRule: ObjectiveScoringRule = {
  type: "by_correct_count",
  partialScoresByCorrectCount: {
    2: { 1: 3 },
    3: { 1: 2, 2: 4 }
  },
  wrongOrExtraScore: 0
};

const physicsMultiRule: ObjectiveScoringRule = {
  type: "fixed_partial",
  partialScore: 3,
  wrongOrExtraScore: 0
};

const biologyIndefiniteRule: ObjectiveScoringRule = {
  type: "fixed_partial",
  partialScore: 1,
  wrongOrExtraScore: 0
};

function chineseTemplate(options: SubjectTemplateOptions): BodyBlock[] {
  const choiceQuestions = [
    ...rangeQuestions(1, 2, "single", 4, 3),
    objectiveQuestion(6, "single", 4, 3),
    objectiveQuestion(10, "multiple", 8, 3, chineseQuestion10Rule),
    ...rangeQuestions(11, 12, "single", 4, 3),
    objectiveQuestion(15, "single", 4, 3)
  ];
  const subjectiveBlocks: BodyBlock[] = [
    subjectiveBlock("填空题", [blankQuestion(3, 0, 1)]),
    subjectiveBlock("解答题", [linedQuestion(4), linedQuestion(5)]),
    subjectiveBlock("解答题", [linedQuestion(7), linedQuestion(8), linedQuestion(9)]),
    subjectiveBlock("解答题", [linedQuestion("13.1", 4, 28), linedQuestion("13.2", 4, 28)]),
    subjectiveBlock("解答题", [linedQuestion(14)]),
    subjectiveBlock("解答题", [linedQuestion(16)]),
    subjectiveBlock("填空题", [blankQuestion("17.1", 6, 2), blankQuestion("17.2", 0, 2), blankQuestion("17.3", 0, 2)]),
    subjectiveBlock("语言文字运用", [linedQuestion(18), linedQuestion(19), linedQuestion(20), linedQuestion(21), linedQuestion(22)])
  ];
  if (options.chineseChoicePlacement === "inline") {
    return [
      objectiveBlock("选择题", rangeQuestions(1, 2, "single", 4, 3)),
      subjectiveBlocks[0],
      subjectiveBlocks[1],
      objectiveBlock("选择题", [objectiveQuestion(6, "single", 4, 3)]),
      subjectiveBlocks[2],
      objectiveBlock("多选题", [objectiveQuestion(10, "multiple", 8, 3, chineseQuestion10Rule)]),
      objectiveBlock("选择题", rangeQuestions(11, 12, "single", 4, 3)),
      subjectiveBlocks[3],
      subjectiveBlocks[4],
      objectiveBlock("选择题 15", [objectiveQuestion(15, "single", 4, 3)]),
      ...subjectiveBlocks.slice(5)
    ];
  }
  return [objectiveBlock("选择题", choiceQuestions), ...subjectiveBlocks];
}

function englishTemplate(withListening: boolean): BodyBlock[] {
  const questions = [
    ...(withListening ? rangeQuestions(1, 20, "single", 3, 1.5) : []),
    ...rangeQuestions(21, 35, "single", 4, 2.5),
    ...rangeQuestions(36, 40, "single", 7, 2.5),
    ...rangeQuestions(41, 55, "single", 4, 1)
  ];
  return [
    objectiveBlock(withListening ? "客观题" : "客观题", questions),
    subjectiveBlock("语法填空", Array.from({ length: 10 }, (_, index) => blankQuestion(56 + index, 1.5, 1)))
  ];
}

function mathTemplate(): BodyBlock[] {
  const objective = [
    ...rangeQuestions(1, 8, "single", 4, 5),
    ...rangeQuestions(9, 11, "multiple", 4, 6).map((question) => ({ ...question, scoringRule: mathMultiRule }))
  ];
  return [
    objectiveBlock("选择题", objective),
    subjectiveBlock("填空题", [blankQuestion(12, 5, 1), blankQuestion(13, 5, 1), blankQuestion(14, 5, 1)]),
    subjectiveBlock("解答题", [linedQuestion(15, 0, 72)])
  ];
}

function physicsTemplate(): BodyBlock[] {
  const objective = [
    ...rangeQuestions(1, 7, "single", 4, 4),
    ...rangeQuestions(8, 10, "multiple", 4, 6).map((question) => ({ ...question, scoringRule: physicsMultiRule }))
  ];
  return [
    objectiveBlock("选择题", objective),
    subjectiveBlock("填空题", [blankQuestion(11, 0, 2), blankQuestion(12, 0, 2)]),
    subjectiveBlock("解答题", [linedQuestion(13), linedQuestion(14), linedQuestion(15)])
  ];
}

function chemistryTemplate(): BodyBlock[] {
  return [
    objectiveBlock("选择题", rangeQuestions(1, 15, "single", 4, 3)),
    subjectiveBlock("填空题", [blankQuestion(16), blankQuestion(17), blankQuestion(18), blankQuestion(19)])
  ];
}

function biologyTemplate(): BodyBlock[] {
  const objective = [
    ...rangeQuestions(1, 15, "single", 4, 2),
    ...rangeQuestions(16, 20, "indefinite", 4, 2).map((question) => ({
      ...question,
      scoringRule: biologyIndefiniteRule
    }))
  ];
  return [
    objectiveBlock("选择题", objective),
    subjectiveBlock("填空题", [blankQuestion(21), blankQuestion(22), blankQuestion(23), blankQuestion(24), blankQuestion(25)])
  ];
}

export function applySubjectTemplate(card: AnswerCard, options: SubjectTemplateOptions = {}): AnswerCard {
  const subject = card.subject;
  let bodyBlocks: BodyBlock[] | null = null;
  if (subject === "yuwen") bodyBlocks = chineseTemplate(options);
  if (subject === "yingyu" || subject === "waiyu") bodyBlocks = englishTemplate(options.englishListening !== false);
  if (subject === "shuxue") bodyBlocks = mathTemplate();
  if (subject === "wuli") bodyBlocks = physicsTemplate();
  if (subject === "huaxue") bodyBlocks = chemistryTemplate();
  if (subject === "shengwu") bodyBlocks = biologyTemplate();
  return bodyBlocks ? { ...card, bodyBlocks } : card;
}
