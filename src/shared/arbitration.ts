import type { ReviewImage } from "./types";

export type ArbitrationQuestionRule = {
  number: number;
  maxScore: number;
  step: number;
};

export type ArbitrationDisputeItem = {
  reviewImages?: ReviewImage[];
  reviewIssue?: string;
  questionNumbers: number[];
  questions: ArbitrationQuestionRule[];
  cropId: string;
  cropImageUrl: string;
  originalPages: Array<{ pageNumber: number; imageUrl: string }>;
  studentName: string;
  studentNumber: string;
  blockId: string;
  blockTitle: string;
  scores: Array<{ reviewerName: string; score: number }>;
  scoreDiff: number;
  threshold: number;
  status: "pending" | "arbitrated" | "shelved";
  arbitratorName: string | null;
};

export type ArbitrationDisputesResponse = {
  ok: true;
  data: ArbitrationDisputeItem[];
  canArbitrate: boolean;
};

/** Validate one score against the authoritative card rule shared by UI and API. */
export function arbitrationScoreError(value: number, rule: ArbitrationQuestionRule): string | null {
  if (!Number.isFinite(rule.maxScore) || rule.maxScore < 0) {
    return `第${rule.number}题缺少有效的权威满分`;
  }
  if (!Number.isFinite(rule.step) || rule.step <= 0) {
    return `第${rule.number}题缺少有效的分数步长`;
  }
  if (!Number.isFinite(value)) return `第${rule.number}题需要填写有效分数`;
  if (value < 0 || value > rule.maxScore) return `第${rule.number}题分数须在 0 至 ${rule.maxScore} 分之间`;
  const steps = value / rule.step;
  if (Math.abs(steps - Math.round(steps)) > 1e-7) {
    return `第${rule.number}题分数须按 ${rule.step} 分的步长填写`;
  }
  return null;
}

/**
 * Multi-question arbitration is valid only when every authoritative question is
 * present exactly once. The same validator is used by the dialog and HTTP API.
 */
export function validateArbitrationScores(
  questionNumbers: number[],
  rules: ArbitrationQuestionRule[],
  scores: unknown
): { ok: true; values: Record<string, number> } | { ok: false; error: string } {
  if (!questionNumbers.length || new Set(questionNumbers).size !== questionNumbers.length) {
    return { ok: false, error: "争议题号无效，请刷新后重试" };
  }
  if (rules.length !== questionNumbers.length || rules.some(rule => !questionNumbers.includes(rule.number))) {
    return { ok: false, error: "争议题号与权威评分规则不一致，请刷新后重试" };
  }
  if (scores == null || typeof scores !== "object" || Array.isArray(scores)) {
    return { ok: false, error: "请逐一填写本卷所有小题的分数" };
  }
  const input = scores as Record<string, unknown>;
  const expected = new Set(questionNumbers.map(String));
  const keys = Object.keys(input);
  if (keys.length !== expected.size || keys.some(key => !expected.has(key))) {
    return { ok: false, error: "请逐一填写本卷所有小题的分数，不能多交或少交题目" };
  }
  const ruleByNumber = new Map(rules.map(rule => [rule.number, rule]));
  const values: Record<string, number> = {};
  for (const number of questionNumbers) {
    const value = input[String(number)];
    if (typeof value !== "number") return { ok: false, error: `第${number}题需要填写有效分数` };
    const error = arbitrationScoreError(value, ruleByNumber.get(number)!);
    if (error) return { ok: false, error };
    values[String(number)] = value;
  }
  return { ok: true, values };
}
