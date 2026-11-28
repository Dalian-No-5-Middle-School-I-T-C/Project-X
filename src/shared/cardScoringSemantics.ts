import type { AnswerCard } from "./types";
import { objectiveQuestionDefinitions } from "./grading";

export type ObjectiveScoringSemantic = {
  answerKey: string[];
  score: number;
  mode: string;
  scoringRule: unknown;
};

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

export function objectiveScoringSemantics(card: AnswerCard): Map<number, ObjectiveScoringSemantic> {
  const result = new Map<number, ObjectiveScoringSemantic>();
  for (const block of card.bodyBlocks) {
    if (block.type !== "objective") continue;
    for (const definition of objectiveQuestionDefinitions(block)) {
      result.set(definition.questionNumber, {
        answerKey: [...(definition.answerKey ?? [])].sort(),
        score: Number(definition.score ?? 0),
        mode: definition.mode,
        scoringRule: definition.mode === "single" ? null : canonical(definition.scoringRule ?? null)
      });
    }
  }
  return result;
}

/** 只比较会影响已存成绩的答案、满分、题型和计分规则；版式/标题变化不会误报。 */
export function changedObjectiveQuestionNumbers(before: AnswerCard | null, after: AnswerCard): number[] {
  if (!before) return [];
  const old = objectiveScoringSemantics(before);
  const next = objectiveScoringSemantics(after);
  const numbers = new Set([...old.keys(), ...next.keys()]);
  return [...numbers].filter((number) => {
    const left = old.get(number);
    const right = next.get(number);
    return JSON.stringify(left ? canonical(left) : null) !== JSON.stringify(right ? canonical(right) : null);
  }).sort((a, b) => a - b);
}
