import { gradeObjectiveQuestion } from "../src/shared/grading";
import type { AnswerCard, ObjectiveBlock, ObjectiveQuestionConfig } from "../src/shared/types";

function block(questions: ObjectiveQuestionConfig[]): ObjectiveBlock {
  const first = questions[0];
  return {
    id: "obj_test",
    type: "objective",
    title: "Objective",
    questionStart: first.questionNumber,
    questionCount: questions.length,
    optionCount: first.optionCount ?? 4,
    mode: first.mode ?? "single",
    scorePerQuestion: first.score ?? 0,
    density: "compact",
    answerKey: {},
    multipleScoring: { partialScores: {}, wrongOrExtraScore: 0 },
    questions
  };
}

function card(questions: ObjectiveQuestionConfig[]): AnswerCard {
  return {
    id: "10000001",
    title: "Smoke",
    paper: { size: "A4", orientation: "portrait" },
    studentInfo: { fields: [], studentNumberDigits: 5 },
    bodyBlocks: [block(questions)],
    sided: "single",
    layoutVersion: 1,
    updatedAt: new Date(0).toISOString()
  };
}

function scoreOf(questions: ObjectiveQuestionConfig[], questionNumber: number, selectedOptions: string[]): number {
  return gradeObjectiveQuestion(card(questions), { questionNumber, selectedOptions, confidence: 1 }).score;
}

function expectScore(name: string, actual: number, expected: number): void {
  if (actual !== expected) {
    throw new Error(`${name}: expected ${expected}, got ${actual}`);
  }
}

const chinese10: ObjectiveQuestionConfig = {
  questionNumber: 10,
  mode: "multiple",
  optionCount: 8,
  score: 3,
  answerKey: ["B", "D", "F"],
  scoringRule: {
    type: "per_selected_count",
    partialScores: { 1: 1, 2: 2 },
    wrongOrExtraScore: 0,
    allowWrongOptions: true
  }
};
expectScore("Chinese 10 BCD", scoreOf([chinese10], 10, ["B", "C", "D"]), 2);
expectScore("Chinese 10 BDEF", scoreOf([chinese10], 10, ["B", "D", "E", "F"]), 0);
expectScore("Chinese 10 AB", scoreOf([chinese10], 10, ["A", "B"]), 1);

const mathTwo: ObjectiveQuestionConfig = {
  questionNumber: 9,
  mode: "multiple",
  optionCount: 4,
  score: 6,
  answerKey: ["A", "C"],
  scoringRule: {
    type: "by_correct_count",
    partialScoresByCorrectCount: { 2: { 1: 3 }, 3: { 1: 2, 2: 4 } },
    wrongOrExtraScore: 0
  }
};
const mathThree: ObjectiveQuestionConfig = { ...mathTwo, questionNumber: 10, answerKey: ["A", "C", "D"] };
expectScore("Math two-correct partial", scoreOf([mathTwo], 9, ["A"]), 3);
expectScore("Math three-correct one", scoreOf([mathThree], 10, ["A"]), 2);
expectScore("Math three-correct two", scoreOf([mathThree], 10, ["A", "D"]), 4);
expectScore("Math wrong", scoreOf([mathThree], 10, ["A", "B"]), 0);

const physics: ObjectiveQuestionConfig = {
  questionNumber: 8,
  mode: "multiple",
  optionCount: 4,
  score: 6,
  answerKey: ["A", "C"],
  scoringRule: { type: "fixed_partial", partialScore: 3, wrongOrExtraScore: 0 }
};
expectScore("Physics fixed partial", scoreOf([physics], 8, ["A"]), 3);
expectScore("Physics wrong", scoreOf([physics], 8, ["A", "B"]), 0);

const biology: ObjectiveQuestionConfig = {
  questionNumber: 16,
  mode: "indefinite",
  optionCount: 4,
  score: 2,
  answerKey: ["A", "B", "C"],
  scoringRule: { type: "fixed_partial", partialScore: 1, wrongOrExtraScore: 0 }
};
expectScore("Biology partial", scoreOf([biology], 16, ["A", "C"]), 1);
expectScore("Biology wrong", scoreOf([biology], 16, ["A", "D"]), 0);

console.log("grading-rules-smoke ok");
