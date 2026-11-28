import type { AnswerCard, ObjectiveBlock, ObjectiveMode, ObjectiveScoringRule } from "./types";
import { normalizeObjectiveAnswerKey, normalizeObjectiveQuestions, objectiveQuestionDefinitions } from "./grading";

export type ObjectiveAnswerParseRow = {
  questionNumber: number;
  options: string[];
  error?: string;
};

export type ObjectiveAnswerParsePreview = {
  rows: ObjectiveAnswerParseRow[];
  errors: string[];
};

const OPTION_LABELS = "ABCDEFGH";

export type ObjectiveAnswerParseResult = { options: string[]; error?: string };

/** 解析一个题目的答案文本；单选只接受一个选项，多选允许连续字母或分隔符。 */
export function parseObjectiveAnswerText(text: string, mode: ObjectiveMode, optionCount: number): ObjectiveAnswerParseResult {
  const limit = Math.max(2, Math.min(8, Math.trunc(optionCount) || 4));
  const allowed = new Set(OPTION_LABELS.slice(0, limit).split(""));
  const normalized = text.trim().toUpperCase();
  if (!normalized) return { options: [] };
  const tokens = normalized.includes(",") || normalized.includes("，") || normalized.includes("、")
    ? normalized.split(/[,，、\s]+/).filter(Boolean)
    : Array.from(normalized.replace(/\s+/g, ""));
  const invalid = tokens.filter((token) => !/^[A-H]+$/.test(token) || Array.from(token).some((letter) => !allowed.has(letter)));
  if (invalid.length > 0) return { error: `包含无效选项：${invalid.join("、")}（可选 A-${OPTION_LABELS[limit - 1]}）`, options: [] };
  const options = Array.from(new Set(tokens.flatMap((token) => Array.from(token)))).sort();
  if (mode === "single" && options.length > 1) return { error: `单选题只能有一个答案，当前为 ${options.join("")}`, options };
  return { options };
}

/**
 * 共用答案文本按题序解析。换行优先作为题边界；纯单选的单行连续字母逐题分配；
 * 多选/混合块的单行可用逗号或空白分隔题目，每段内部仍可写连续字母（如 AC,BD）。
 */
export function parseObjectiveAnswerBlock(block: ObjectiveBlock, text: string): ObjectiveAnswerParsePreview {
  const definitions = objectiveQuestionDefinitions(block);
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const errors: string[] = [];
  if (lines.length === 0) return { rows: definitions.map((definition) => ({ questionNumber: definition.questionNumber, options: [] })), errors };
  let chunks: string[];
  if (lines.length === 1 && definitions.length > 0 && definitions.every((definition) => definition.mode === "single")) {
    chunks = Array.from(lines[0].replace(/[\s,，、;；]+/g, ""));
  } else if (lines.length === 1 && definitions.length > 1) {
    chunks = lines[0].split(/[,，、;；]+|\s+(?=[A-H](?:[,，、;；\s]|$))/).map((chunk) => chunk.trim()).filter(Boolean);
  } else {
    chunks = lines;
  }
  const rows = definitions.map((definition, index) => {
    const parsed = parseObjectiveAnswerText(chunks[index] ?? "", definition.mode, definition.optionCount);
    if (parsed.error) errors.push(`第 ${definition.questionNumber} 题：${parsed.error}`);
    return { questionNumber: definition.questionNumber, options: parsed.error ? [] : parsed.options, error: parsed.error };
  });
  if (chunks.length > definitions.length) errors.push(`答案行数（${chunks.length}）多于题目数（${definitions.length}）`);
  if (chunks.length < definitions.length) errors.push(`答案行数（${chunks.length}）少于题目数（${definitions.length}），未填写的题目将清空`);
  return { rows, errors };
}

/** 仅在预览无错误时整体应用，保证 block.answerKey 与物化题目同步。 */
export function applyObjectiveAnswerPreview(block: ObjectiveBlock, preview: ObjectiveAnswerParsePreview): boolean {
  if (preview.errors.length > 0 || preview.rows.some((row) => row.error)) return false;
  const questions = normalizeObjectiveQuestions(block);
  for (const row of preview.rows) {
    const question = questions.find((item) => item.questionNumber === row.questionNumber);
    if (!question) return false;
    if (row.options.length > 0) question.answerKey = [...row.options];
    else delete question.answerKey;
  }
  block.questions = questions;
  block.answerKey = normalizeObjectiveAnswerKey(block);
  return true;
}

/** 整体平移物化题号，并按原逐题定义迁移答案，避免只改块字段后旧答案串题。 */
export function shiftObjectiveQuestionStart(block: ObjectiveBlock, nextStart: number): void {
  if (!Number.isInteger(nextStart) || nextStart < 1) return;
  const questions = normalizeObjectiveQuestions(block);
  const delta = nextStart - (questions[0]?.questionNumber ?? block.questionStart);
  for (const question of questions) question.questionNumber += delta;
  block.questions = questions;
  block.questionStart = questions[0]?.questionNumber ?? nextStart;
  block.questionCount = questions.length;
  block.answerKey = normalizeObjectiveAnswerKey(block);
}

/** 块级多选规则深拷贝到所有多选/不定项逐题配置，单选不写入多选规则。 */
export function applyObjectiveMultipleScoringRule(block: ObjectiveBlock, rule: ObjectiveScoringRule): void {
  const questions = normalizeObjectiveQuestions(block);
  for (const question of questions) {
    if (question.mode === "single") continue;
    question.scoringRule = JSON.parse(JSON.stringify(rule)) as ObjectiveScoringRule;
  }
  block.questions = questions;
  if (rule.type === "per_selected_count") {
    block.multipleScoring = {
      partialScores: { ...rule.partialScores },
      wrongOrExtraScore: rule.wrongOrExtraScore ?? 0
    };
  }
}

/** 整卡题号冲突检查；主观题号按有效正整数口径参与。 */
export function findQuestionNumberConflicts(card: AnswerCard, excludedBlockId: string, numbers: number[]): number[] {
  const candidate = new Set(numbers);
  const conflicts = new Set<number>();
  for (const block of card.bodyBlocks) {
    if (block.id === excludedBlockId) continue;
    if (block.type === "objective") {
      for (const definition of objectiveQuestionDefinitions(block)) {
        if (candidate.has(definition.questionNumber)) conflicts.add(definition.questionNumber);
      }
    } else {
      for (const question of block.questions) {
        const value = Number(question.number);
        if (Number.isInteger(value) && value > 0 && candidate.has(value)) conflicts.add(value);
      }
    }
  }
  return [...conflicts].sort((a, b) => a - b);
}
