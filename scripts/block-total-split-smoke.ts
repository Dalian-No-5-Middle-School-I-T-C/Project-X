import assert from "node:assert/strict";
import { ReviewValidationError, splitBlockTotal } from "../src/server/services/ReviewService";
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
  { name: "均分 小数满分 总5", blockTotal: 5, qs: [1, 2], maxes: { 1: 2.5, 2: 3.5 }, step: 1, distribution: "equal" },
  { name: "比例 半分粒度与四分之一满分", blockTotal: 5.5, qs: [1, 2], maxes: { 1: 2.25, 2: 3.75 }, step: 0.5, distribution: "proportional" },
  { name: "均分 高分使用两题的小数满分", blockTotal: 7, qs: [1, 2, 3], maxes: { 1: 1.5, 2: 2.5, 3: 3.5 }, step: 1, distribution: "equal" },
  { name: "均分 精确小数满分", blockTotal: 8.5, qs: [1, 2], maxes: { 1: 5.5, 2: 3 }, step: 1, distribution: "equal" },
  { name: "均分 满分尾差不能截断", blockTotal: 4, qs: [1, 2, 3], maxes: { 1: 1.5, 2: 1.5, 3: 1.75 }, step: 1, distribution: "equal" },
  { name: "比例 高分需要从整数题扣一步", blockTotal: 5, qs: [1, 2, 3, 4, 5], maxes: { 1: 0.75, 2: 0.75, 3: 0.75, 4: 0.75, 5: 3 }, step: 1, distribution: "proportional" },
  { name: "千分位满分", blockTotal: 1, qs: [1, 2, 3], maxes: { 1: 0.001, 2: 0.999, 3: 0.777 }, step: 1, distribution: "equal" },
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
    if (v !== max && !isMultipleOf(v, c.step)) { ok = false; details.push(`第${q}题非${c.step}粒度(${v})`); }
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
// 小题数量固定为三，直接枚举所有合法打分组合，作为独立的可达性判据。
const choices = [0.125, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2.125];
const symmetric = map({ 1: 10, 2: 10, 3: 10 });
assert.deepEqual(splitBlockTotal(25, items([3, 2, 1]), symmetric, 30, 1, "equal"),
  splitBlockTotal(25, items([1, 2, 3]), symmetric, 30, 1, "equal"), "双评提交项顺序不同，两票按同一题号分配余数");
let comparisons = 0;
for (const a of choices) for (const b of choices) for (const c of choices) {
  const maxima = [a, b, c];
  const maxByQuestion = new Map(maxima.map((value, i) => [i + 1, value]));
  const sumMax = a + b + c;
  for (const step of [0.5, 1]) {
    const legal = maxima.map(max => new Set([max, ...Array.from({ length: Math.floor(max / step) + 1 }, (_, i) => i * step)]));
    const reachable = new Set<number>();
    for (const x of legal[0]) for (const y of legal[1]) for (const z of legal[2]) reachable.add(x + y + z);
    for (let total = 0; total <= sumMax; total += step) for (const mode of ["equal", "proportional"] as const) {
      const split = () => splitBlockTotal(total, items([3, 1, 2]), maxByQuestion, sumMax, step, mode);
      const label = JSON.stringify({ maxima, total, step, mode });
      if (reachable.has(total)) {
        const result = split();
        assert(legal.every((values, i) => values.has(result.get(i + 1)!)), label);
        assert.equal([...result.values()].reduce((sum, value) => sum + value, 0), total, label);
      } else {
        assert.throws(split, ReviewValidationError, label);
      }
      comparisons++;
    }
  }
}
console.log(`枚举三题合法分数组合，两种步长和两种分配方式共核对 ${comparisons} 组`);
console.log("block-total-split-smoke ok");
