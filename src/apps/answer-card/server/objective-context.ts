/**
 * 答题卡客观题 JSON 上下文构建器（纯函数）。
 *
 * 把答题卡已有的客观题结构（题号/题型/选项数/分值/标准答案/评分规则）
 * 压成紧凑 JSON，随知识点分析请求喂给 AI，作为核对题号与答案的结构化先验。
 */
import type { AnswerCard, ObjectiveBlock } from "../../../shared/types";

export type ObjectiveContextItem = {
  questionNumber: number;
  mode: string;
  optionCount: number;
  score: number;
  answerKey: string[];
  scoringRule?: unknown;
};

export function buildObjectiveContext(card: AnswerCard | null | undefined): ObjectiveContextItem[] {
  if (!card) return [];
  const items: ObjectiveContextItem[] = [];
  for (const block of card.bodyBlocks) {
    if (block.type !== "objective") continue;
    items.push(...objectiveItemsFromBlock(block));
  }
  return items;
}

function objectiveItemsFromBlock(block: ObjectiveBlock): ObjectiveContextItem[] {
  const items: ObjectiveContextItem[] = [];
  const questions = block.questions?.length ? block.questions : undefined;

  if (questions) {
    for (const q of questions) {
      items.push({
        questionNumber: q.questionNumber,
        mode: q.mode ?? block.mode ?? "single",
        optionCount: q.optionCount ?? block.optionCount ?? 4,
        score: q.score ?? block.scorePerQuestion ?? 0,
        answerKey: q.answerKey ?? block.answerKey?.[q.questionNumber] ?? [],
        ...(q.scoringRule ? { scoringRule: q.scoringRule } : {}),
      });
    }
    return items;
  }

  // 旧版卡片无逐题配置时，回退到块级默认值（题号从 questionStart 连续编号）。
  for (let i = 0; i < block.questionCount; i++) {
    const questionNumber = block.questionStart + i;
    items.push({
      questionNumber,
      mode: block.mode ?? "single",
      optionCount: block.optionCount ?? 4,
      score: block.scorePerQuestion ?? 0,
      answerKey: block.answerKey?.[questionNumber] ?? [],
    });
  }
  return items;
}
