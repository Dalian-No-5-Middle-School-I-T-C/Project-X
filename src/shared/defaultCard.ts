import type { AnswerCard } from "./types";

export function createBlockId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

export function createDefaultCard(id: string): AnswerCard {
  const now = new Date().toISOString();

  return {
    id,
    title: "9.19物理晨测",
    paper: { size: "A4", orientation: "portrait" },
    studentInfo: {
      fields: ["姓名", "班级"],
      studentNumberDigits: 5
    },
    bodyBlocks: [
      {
        id: createBlockId("obj"),
        type: "objective",
        title: "一、单选题（共8题，共40分）",
        questionStart: 1,
        questionCount: 8,
        optionCount: 4,
        mode: "single",
        scorePerQuestion: 5,
        density: "compact",
        answerKey: {},
        multipleScoring: {
          partialScores: {},
          wrongOrExtraScore: 0
        }
      },
      {
        id: createBlockId("obj"),
        type: "objective",
        title: "二、多选题（共4题，共32分）",
        questionStart: 9,
        questionCount: 4,
        optionCount: 4,
        mode: "multiple",
        scorePerQuestion: 8,
        density: "compact",
        answerKey: {},
        multipleScoring: {
          partialScores: { 1: 2, 2: 4, 3: 6 },
          wrongOrExtraScore: 0
        }
      },
      {
        id: createBlockId("subj"),
        type: "subjective",
        title: "三、解答题（共2题，共28分）",
        questions: [
          {
            id: createBlockId("q"),
            number: 15,
            score: 14,
            style: "manual_score_grid",
            kind: "plain_box",
            lineGrid: { enabled: false, lineSpacingMm: 8 },
            images: [],
            minHeightMm: 68
          },
          {
            id: createBlockId("q"),
            number: 16,
            score: 14,
            style: "manual_score_grid",
            kind: "plain_box",
            lineGrid: { enabled: false, lineSpacingMm: 8 },
            images: [],
            minHeightMm: 68
          }
        ]
      }
    ],
    layoutVersion: 1,
    updatedAt: now
  };
}
