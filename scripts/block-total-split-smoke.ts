import { splitBlockTotal } from "../src/server/services/ReviewService";
import type { ReviewSubmitScoreInput } from "../src/shared/types";

function items(qs: number[]): ReviewSubmitScoreInput[] {
  return qs.map((q) => ({ questionNumber: q, scoreType: "subjective", score: 0 }));
}

function map(maxes: Record<number, number>): Map<number, number> {
  return new Map(Object.entries(maxes).map(([k, v]) => [Number(k), v]));
}

function approxEqual(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) <= eps;
}

function isMultipleOf(v: number, step: number): boolean {
  return Math.abs(v - Math.round(v / step) * step) <= 1e-9;
}

interface Case {
  name: string;
  blockTotal: number;
  qs: number[];
  maxes: Record<number, number>;
  step: number;
  distribution: "proportional" | "equal";
}

const cases: Case[] = [
  { name: "比例 3×10 总25 step1", blockTotal: 25, qs: [1, 2, 3], maxes: { 1: 10, 2: 10, 3: 10 }, step: 1, distribution: "proportional" },
  { name: "均分 3×10 总25 step1", blockTotal: 25, qs: [1, 2, 3], maxes: { 1: 10, 2: 10, 3: 10 }, step: 1, distribution: "equal" },
  { name: "均分 满分不对称 总12", blockTotal: 12, qs: [1, 2, 3], maxes: { 1: 4, 2: 4, 3: 4 }, step: 1, distribution: "equal" },
  { name: "比例 clamp 2:[2,18] 总20", blockTotal: 20, qs: [1, 2], maxes: { 1: 2, 2: 18 }, step: 1, distribution: "proportional" },
  { name: "比例 0.5 粒度 总29", blockTotal: 29, qs: [1, 2, 3], maxes: { 1: 10, 2: 10, 3: 10 }, step: 0.5, distribution: "proportional" },
  { name: "比例 总0", blockTotal: 0, qs: [1, 2, 3], maxes: { 1: 10, 2: 10, 3: 10 }, step: 1, distribution: "proportional" },
  { name: "均分 0.5 粒度 总7", blockTotal: 7, qs: [1, 2, 3], maxes: { 1: 3, 2: 3, 3: 3 }, step: 0.5, distribution: "equal" },
  { name: "比例 不对称 5/15 总20", blockTotal: 20, qs: [1, 2], maxes: { 1: 5, 2: 15 }, step: 1, distribution: "proportional" },
  { name: "余量吸收 3×4 总10", blockTotal: 10, qs: [1, 2, 3], maxes: { 1: 4, 2: 4, 3: 4 }, step: 1, distribution: "proportional" },
  { name: "负余量 1×1×1 总2", blockTotal: 2, qs: [1, 2, 3], maxes: { 1: 1, 2: 1, 3: 1 }, step: 1, distribution: "equal" },
  { name: "单题 总7", blockTotal: 7, qs: [1], maxes: { 1: 10 }, step: 1, distribution: "proportional" },
  { name: "均分 含0分题 总6", blockTotal: 6, qs: [1, 2, 3], maxes: { 1: 0, 2: 6, 3: 6 }, step: 1, distribution: "equal" },
];

let failed = 0;
for (const c of cases) {
  const maxScoreByQuestion = map(c.maxes);
  const maxBlockScore = Object.values(c.maxes).reduce((a, b) => a + b, 0);
  const split = splitBlockTotal(c.blockTotal, items(c.qs), maxScoreByQuestion, maxBlockScore, c.step, c.distribution);

  let sum = 0;
  let ok = true;
  const details: string[] = [];
  for (const q of c.qs) {
    const v = split.get(q);
    if (v == null) { ok = false; details.push(`第${q}题缺失`); continue; }
    sum += v;
    const max = c.maxes[q];
    if (v < -1e-9) { ok = false; details.push(`第${q}题<0(${v})`); }
    if (v > max + 1e-9) { ok = false; details.push(`第${q}题>max(${v}>${max})`); }
    if (!isMultipleOf(v, c.step)) { ok = false; details.push(`第${q}题非${c.step}粒度(${v})`); }
  }
  if (!approxEqual(sum, c.blockTotal)) { ok = false; details.push(`合计${sum}≠${c.blockTotal}`); }

  if (!ok) {
    failed++;
    console.error(`✗ ${c.name}: ${details.join(", ")}`);
  } else {
    console.log(`✓ ${c.name} → [${c.qs.map((q) => split.get(q)).join(", ")}]`);
  }
}

if (failed > 0) {
  console.error(`block-total-split-smoke: ${failed} 失败`);
  process.exit(1);
}
console.log("block-total-split-smoke ok");