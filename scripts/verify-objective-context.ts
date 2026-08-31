/**
 * 答题卡客观题 JSON 上下文构建器回归测试。
 * 运行：npx tsx scripts/verify-objective-context.ts（任一断言失败时非零退出）
 */
import assert from "node:assert/strict";
import type { AnswerCard, ObjectiveBlock } from "../src/shared/types";
import { buildObjectiveContext } from "../src/apps/answer-card/server/objective-context";

function makeCard(bodyBlocks: AnswerCard["bodyBlocks"]): AnswerCard {
  return {
    id: "c1",
    title: "测试卡",
    paper: { size: "A4", orientation: "portrait" },
    studentInfo: { studentNumberDigits: 8 },
    bodyBlocks,
    sided: "single",
    layoutVersion: 1,
    updatedAt: "2026-08-30T00:00:00Z",
  };
}

function testBuildsItemsFromQuestionList() {
  const block: ObjectiveBlock = {
    id: "b1",
    type: "objective",
    title: "选择题",
    questionStart: 1,
    questionCount: 2,
    optionCount: 4,
    mode: "single",
    scorePerQuestion: 3,
    density: "normal",
    questions: [
      { questionNumber: 1, mode: "single", optionCount: 4, score: 3, answerKey: ["A"] },
      {
        questionNumber: 2,
        mode: "multiple",
        optionCount: 4,
        score: 5,
        answerKey: ["A", "C"],
        scoringRule: { type: "per_selected_count", partialScores: { 1: 1 }, wrongOrExtraScore: 0 },
      },
    ],
  };
  const items = buildObjectiveContext(makeCard([block]));
  assert.equal(items.length, 2);
  assert.equal(items[0].questionNumber, 1);
  assert.equal(items[0].mode, "single");
  assert.equal(items[0].optionCount, 4);
  assert.equal(items[0].score, 3);
  assert.deepEqual(items[0].answerKey, ["A"]);
  assert.equal(items[1].scoringRule?.type, "per_selected_count");
}

function testFallsBackToBlockDefaultsWhenQuestionsMissing() {
  const block: ObjectiveBlock = {
    id: "b2",
    type: "objective",
    title: "选择题",
    questionStart: 5,
    questionCount: 2,
    optionCount: 4,
    mode: "single",
    scorePerQuestion: 2,
    density: "normal",
    answerKey: { 5: ["B"], 6: ["D"] },
  };
  const items = buildObjectiveContext(makeCard([block]));
  assert.equal(items.length, 2);
  assert.equal(items[0].questionNumber, 5);
  assert.equal(items[0].mode, "single");
  assert.equal(items[0].score, 2);
  assert.deepEqual(items[0].answerKey, ["B"]);
  assert.deepEqual(items[1].answerKey, ["D"]);
}

function testSkipsSubjectiveBlocksAndHandlesNullCard() {
  const subjective = {
    id: "s1",
    type: "subjective",
    blockKind: "answer",
    title: "解答题",
    questions: [],
  } as AnswerCard["bodyBlocks"][number];
  assert.equal(buildObjectiveContext(makeCard([subjective])).length, 0);
  assert.equal(buildObjectiveContext(null).length, 0);
}

testBuildsItemsFromQuestionList();
testFallsBackToBlockDefaultsWhenQuestionsMissing();
testSkipsSubjectiveBlocksAndHandlesNullCard();
console.log("verify:objective-context OK");
