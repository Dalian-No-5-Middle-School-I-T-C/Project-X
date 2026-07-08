/**
 * 回归测试：验证 PR161 代码审查报告中修复的若干逻辑 bug。
 * 运行：npx tsx scripts/bugfix-verification.ts
 */
import {
  gradeObjectiveQuestion,
  gradeSubjectiveRecognition,
  gradeSessionStudentResults
} from "../src/shared/grading";
import { competitionRank } from "../src/shared/ranking";
import { rankPercentile, roundScore } from "../src/server/services/rankingUpdate";
import { maskApiKey, isMaskedApiKey } from "../src/server/utils/maskApiKey";
import type {
  AnswerCard,
  CombinedRecognitionResult,
  ObjectiveBlock,
  ObjectiveQuestionConfig
} from "../src/shared/types";

let passed = 0;
function check(name: string, cond: boolean): void {
  if (!cond) throw new Error(`FAIL: ${name}`);
  passed++;
}

function objBlock(questions: ObjectiveQuestionConfig[]): ObjectiveBlock {
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
    bodyBlocks: [objBlock(questions)],
    sided: "single",
    layoutVersion: 1,
    updatedAt: new Date(0).toISOString()
  };
}

const q1: ObjectiveQuestionConfig = {
  questionNumber: 1,
  mode: "single",
  optionCount: 4,
  score: 5,
  answerKey: ["A"]
};
const testCard = card([q1]);

// ── H-L1: 复核置信度阈值应生效 ────────────────────────
{
  const lowConf = { questionNumber: 1, selectedOptions: ["A"], confidence: 0.1 };
  const defaultThreshold = gradeObjectiveQuestion(testCard, lowConf); // 默认 0.12
  check("H-L1 默认阈值下 0.1 置信度触发复核", defaultThreshold.needsReview === true && defaultThreshold.status === "review");

  const looseThreshold = gradeObjectiveQuestion(testCard, lowConf, 0.05); // 放宽到 0.05
  check("H-L1 放宽阈值后 0.1 置信度不复核", looseThreshold.needsReview === false && looseThreshold.status === "correct");

  const strictThreshold = gradeObjectiveQuestion(testCard, { questionNumber: 1, selectedOptions: ["A"], confidence: 0.5 }, 0.8);
  check("H-L1 收紧阈值后 0.5 置信度触发复核", strictThreshold.needsReview === true);
}

// ── M-L6: 主观题负分应裁剪为 0 ────────────────────────
{
  const graded = gradeSubjectiveRecognition(testCard, {
    questionId: "s1",
    questionNumber: 1,
    score: -5,
    maxScore: 10,
    status: "ok",
    confidence: 1,
    validCells: [],
    invalidCells: []
  });
  check("M-L6 负分裁剪为 0", graded.score === 0);

  const overflow = gradeSubjectiveRecognition(testCard, {
    questionId: "s1",
    questionNumber: 1,
    score: 99,
    maxScore: 10,
    status: "ok",
    confidence: 1,
    validCells: [],
    invalidCells: []
  });
  check("M-L6 超上限裁剪为 maxScore", overflow.score === 10);
}

// ── M-L3 / M-L2: 多页阅卷学号与去重择优 ──────────────
{
  const mkRecognition = (
    studentId: { status: string; value: string | null } | undefined,
    confidence: number
  ): CombinedRecognitionResult => ({
    status: "ok",
    questions: [{ questionNumber: 1, selectedOptions: ["A"], confidence }],
    subjectiveQuestions: [],
    ...(studentId ? { studentId } : {})
  });

  const pages = [
    {
      recordId: "r1",
      pageNum: 1,
      side: "front",
      imagePath: "p1.jpg",
      ocrStatus: "ok",
      // 首页学号识别失败 + 低置信度客观题（触发复核）
      recognition: mkRecognition({ status: "failed", value: null }, 0.05)
    },
    {
      recordId: "r2",
      pageNum: 2,
      side: "back",
      imagePath: "p2.jpg",
      ocrStatus: "ok",
      // 次页学号识别成功 + 高置信度同题
      recognition: mkRecognition({ status: "ok", value: "20231" }, 0.99)
    }
  ];

  const result = gradeSessionStudentResults(testCard, pages);
  check("M-L3 跨页择优取识别成功的学号", result.studentId === "20231");
  // 同分（都答对得 5 分），应保留高置信度（不复核）的结果
  const q = result.objectiveQuestions.find((x) => x.questionNumber === 1);
  check("M-L2 同分去重保留高置信度结果", !!q && q.needsReview === false);
  check("M-L2 复核计数为 0", result.needsReviewCount === 0);
}

// ── H-L2 / M-L4: competitionRank + 百分位公式 ────────
{
  const rows = [{ s: 90 }, { s: 90 }, { s: 80 }, { s: 70 }];
  const ranks: number[] = [];
  competitionRank(rows, (r) => r.s, (_r, rank) => ranks.push(rank));
  check("H-L2 同分并列名次为 1,1,3,4", JSON.stringify(ranks) === JSON.stringify([1, 1, 3, 4]));

  // 公式 A：末名（rank=n）百分位为 0，第一名为 100
  check("M-L4 第一名百分位 100", rankPercentile(1, 4) === 100);
  check("M-L4 末名百分位 0", rankPercentile(4, 4) === 0);
  check("M-L4 越界 rank 下限裁剪为 0", rankPercentile(5, 4) === 0);
  check("M-L4 单人考试百分位 100", rankPercentile(1, 1) === 100);
}

// ── H-L3: 浮点舍入 ──────────────────────────────────
{
  check("H-L3 roundScore 消除浮点误差", roundScore(85.1 + 0.2) === 85.3);
}

// ── H-S3: API Key 脱敏 ───────────────────────────────
{
  check("H-S3 maskApiKey 保留末 4 位", maskApiKey("sk-abcdef1234567890") === "••••••••7890");
  check("H-S3 maskApiKey 空值", maskApiKey("") === "");
  check("H-S3 isMaskedApiKey 识别脱敏值", isMaskedApiKey("••••••••7890") === true);
  check("H-S3 isMaskedApiKey 真实 Key 非脱敏", isMaskedApiKey("sk-abcdef1234567890") === false);
}

console.log(`bugfix-verification ok (${passed} checks passed)`);
