import type {
  AnswerCard,
  ObjectiveBlock,
  ObjectiveScoringRule,
  SubjectiveBlock,
  SubjectiveQuestion
} from "./types";
import { objectiveQuestionDefinitions, type ObjectiveQuestionDefinition } from "./grading";

export type CardScoreIssueKind = "total" | "objective" | "fill_blank" | "answer";

export type CardScoreIssue = {
  kind: CardScoreIssueKind;
  message: string;
  questionRefs?: string[];
};

export type CardScoreValidationResult = {
  totalScore: number;
  objectiveScore: number;
  subjectiveScore: number;
  expectedTotals: number[];
  flexibleTotalSubject: boolean;
  issues: CardScoreIssue[];
};

type ObjectiveScoreItem = {
  blockId: string;
  blockTitle: string;
  questionNumber: number;
  mode: string;
  optionCount: number;
  score: number;
  scoringRule?: ObjectiveScoringRule;
};

const STANDARD_TOTALS = [100, 150];
const LOW_SCORE_LIMIT = 2;
const MANY_BLANKS_THRESHOLD = 2;

function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}

function numericScore(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isFlexibleTotalSubject(card: AnswerCard): boolean {
  const raw = `${card.subject ?? ""} ${card.subjectLabel ?? ""}`.toLowerCase();
  return (
    raw.includes("yuwen") ||
    raw.includes("yingyu") ||
    raw.includes("waiyu") ||
    raw.includes("chinese") ||
    raw.includes("english") ||
    raw.includes("语文") ||
    raw.includes("英语") ||
    raw.includes("外语")
  );
}

function isFillBlankBlock(block: SubjectiveBlock): boolean {
  if (block.blockKind) return block.blockKind === "fill_blank";
  return block.questions.length > 0 && block.questions.every((question) => question.kind === "blank");
}

function blankScoreQuestion(questions: SubjectiveQuestion[]): SubjectiveQuestion | undefined {
  return questions.find((question) => question.style === "manual_score_grid") ?? questions[0];
}

function blankCount(question: SubjectiveQuestion): number {
  if (question.blanks?.items?.length) return question.blanks.items.length;
  return Math.max(1, question.blanks?.count ?? 1);
}

function questionLabel(value: number | string): string {
  return `第 ${value} 题`;
}

function scoringRuleKey(rule: ObjectiveScoringRule | undefined): string {
  return rule ? JSON.stringify(rule) : "";
}

function objectiveGroupKey(item: ObjectiveScoreItem): string {
  return [
    item.blockId,
    item.mode,
    item.optionCount,
    scoringRuleKey(item.scoringRule)
  ].join("|");
}

function objectiveScoreItems(block: ObjectiveBlock): ObjectiveScoreItem[] {
  return objectiveQuestionDefinitions(block).map((question: ObjectiveQuestionDefinition) => ({
    blockId: block.id,
    blockTitle: block.title,
    questionNumber: question.questionNumber,
    mode: question.mode,
    optionCount: question.optionCount,
    score: numericScore(question.score),
    scoringRule: question.scoringRule
  }));
}

function addObjectiveOutlierIssues(items: ObjectiveScoreItem[], issues: CardScoreIssue[]): void {
  const groups = new Map<string, ObjectiveScoreItem[]>();
  for (const item of items) {
    if (item.score <= 0) {
      issues.push({
        kind: "objective",
        message: `${item.blockTitle || "客观题"} ${questionLabel(item.questionNumber)} 分值未设置或为 0`,
        questionRefs: [String(item.questionNumber)]
      });
      continue;
    }
    const key = objectiveGroupKey(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  const reported = new Set<string>();
  const report = (item: ObjectiveScoreItem, expected: number) => {
    const key = `${item.blockId}_${item.questionNumber}`;
    if (reported.has(key)) return;
    reported.add(key);
    issues.push({
      kind: "objective",
      message: `${item.blockTitle || "客观题"} ${questionLabel(item.questionNumber)} 为 ${item.score} 分，和同类题常见分值 ${expected} 分不一致`,
      questionRefs: [String(item.questionNumber)]
    });
  };

  for (const groupItems of groups.values()) {
    if (groupItems.length < 3) continue;
    const sorted = [...groupItems].sort((a, b) => a.questionNumber - b.questionNumber);

    for (let index = 1; index < sorted.length - 1; index += 1) {
      const previous = sorted[index - 1];
      const current = sorted[index];
      const next = sorted[index + 1];
      if (previous.score === next.score && current.score !== previous.score) {
        report(current, previous.score);
      }
    }

    const counts = new Map<number, number>();
    for (const item of sorted) counts.set(item.score, (counts.get(item.score) ?? 0) + 1);
    const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!dominant) continue;
    const [dominantScore, dominantCount] = dominant;
    const anomalyCount = sorted.length - dominantCount;
    if (dominantCount >= Math.max(4, Math.ceil(sorted.length * 0.75)) && anomalyCount > 0 && anomalyCount <= 2) {
      for (const item of sorted) {
        if (item.score !== dominantScore) report(item, dominantScore);
      }
    }
  }
}

export function validateCardScores(card: AnswerCard): CardScoreValidationResult {
  const issues: CardScoreIssue[] = [];
  const objectiveItems = card.bodyBlocks.flatMap((block) =>
    block.type === "objective" ? objectiveScoreItems(block) : []
  );
  const objectiveScore = roundScore(objectiveItems.reduce((sum, item) => sum + item.score, 0));
  addObjectiveOutlierIssues(objectiveItems, issues);

  let subjectiveScore = 0;
  for (const block of card.bodyBlocks) {
    if (block.type !== "subjective") continue;
    if (isFillBlankBlock(block)) {
      const scoreQuestion = blankScoreQuestion(block.questions);
      const score = numericScore(scoreQuestion?.score);
      subjectiveScore += score;
      const totalBlankCount = block.questions.reduce((sum, question) => sum + blankCount(question), 0);
      if (totalBlankCount >= MANY_BLANKS_THRESHOLD && score <= LOW_SCORE_LIMIT) {
        issues.push({
          kind: "fill_blank",
          message: `${block.title || "填空题"} 共 ${totalBlankCount} 个空，但总分只有 ${score} 分`,
          questionRefs: block.questions.map((question) => String(question.number))
        });
      }
      continue;
    }

    for (const question of block.questions) {
      const score = numericScore(question.score);
      subjectiveScore += score;
      if (score <= LOW_SCORE_LIMIT) {
        issues.push({
          kind: "answer",
          message: `${block.title || "解答题"} ${questionLabel(question.number)} 分值为 ${score} 分，疑似过低`,
          questionRefs: [String(question.number)]
        });
      }
    }
  }

  subjectiveScore = roundScore(subjectiveScore);
  const totalScore = roundScore(objectiveScore + subjectiveScore);
  const flexibleTotalSubject = isFlexibleTotalSubject(card);
  if (!flexibleTotalSubject && !STANDARD_TOTALS.some((target) => Math.abs(totalScore - target) < 0.001)) {
    issues.unshift({
      kind: "total",
      message: `当前总分为 ${totalScore} 分，通常应为 100 或 150 分`
    });
  }

  return {
    totalScore,
    objectiveScore,
    subjectiveScore,
    expectedTotals: STANDARD_TOTALS,
    flexibleTotalSubject,
    issues
  };
}
