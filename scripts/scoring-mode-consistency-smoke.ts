/**
 * scoringMode 双向一致性 smoke 测试
 *
 * 背景：PR #189 引入题块总分模式（block_total / per_question），但服务端原本只做了
 * 一个方向的校验（per_question + blockTotalScore → 拒绝），反方向
 * （block_total + 只有逐题分数）仍能通过，导致同一题块在不同阅卷入口走不同评分语义。
 *
 * 本脚本覆盖 4 个组合 + 2 个边界值：
 *   1) block_total + 有 blockTotalScore         → 放行
 *   2) block_total + 无 blockTotalScore (新)    → 拒绝（要修的反方向）
 *   3) per_question + 有 blockTotalScore        → 拒绝（已存在）
 *   4) per_question + 无 blockTotalScore        → 放行
 *   5) 边界：block_total + blockTotalScore = 0  → 放行（0 是合法分值）
 *   6) 边界：block_total + blockTotalScore = NaN → 拒绝（与"未提交"同义，但显式错误更稳）
 */
import { validateScoringModeConsistency } from "../src/server/services/scoringModeValidator";

interface Case {
  name: string;
  scoringMode: "block_total" | "per_question";
  /** undefined / null → 未提交；有限数（含 0）→ 已提交 */
  blockTotalScore: number | null | undefined;
  /** 期望 ok 值；不期望 ok 时再检查 error 是否含指定关键词 */
  expectOk: boolean;
  /** 期望错误信息中必须包含的关键词（仅在 expectOk=false 时校验） */
  expectErrorIncludes?: string;
}

const cases: Case[] = [
  {
    name: "block_total + 有 blockTotalScore → 放行",
    scoringMode: "block_total",
    blockTotalScore: 25,
    expectOk: true
  },
  {
    name: "block_total + 无 blockTotalScore → 拒绝（修复反方向）",
    scoringMode: "block_total",
    blockTotalScore: undefined,
    expectOk: false,
    expectErrorIncludes: "题块总分"
  },
  {
    name: "block_total + null blockTotalScore → 拒绝（与 undefined 同义）",
    scoringMode: "block_total",
    blockTotalScore: null,
    expectOk: false,
    expectErrorIncludes: "题块总分"
  },
  {
    name: "per_question + 有 blockTotalScore → 拒绝（已存在）",
    scoringMode: "per_question",
    blockTotalScore: 25,
    expectOk: false,
    expectErrorIncludes: "逐题评分"
  },
  {
    name: "per_question + 无 blockTotalScore → 放行",
    scoringMode: "per_question",
    blockTotalScore: undefined,
    expectOk: true
  },
  {
    name: "边界：block_total + blockTotalScore = 0 → 放行（0 是合法分值）",
    scoringMode: "block_total",
    blockTotalScore: 0,
    expectOk: true
  },
  {
    name: "边界：block_total + blockTotalScore = NaN → 拒绝（与未提交语义同）",
    scoringMode: "block_total",
    blockTotalScore: Number.NaN,
    expectOk: false,
    expectErrorIncludes: "题块总分"
  }
];

let failed = 0;
for (const c of cases) {
  const hasBlockTotalScore =
    c.blockTotalScore != null && Number.isFinite(c.blockTotalScore);
  const result = validateScoringModeConsistency(c.scoringMode, hasBlockTotalScore);

  let ok = result.ok === c.expectOk;
  if (ok && !result.ok && c.expectErrorIncludes) {
    if (!result.error.includes(c.expectErrorIncludes)) {
      ok = false;
      console.error(`✗ ${c.name}: 错误信息不含「${c.expectErrorIncludes}」, 实际: ${result.error}`);
      failed++;
      continue;
    }
  }
  if (!ok) {
    failed++;
    console.error(`✗ ${c.name}: expected ok=${c.expectOk}, got ${JSON.stringify(result)}`);
  } else {
    const tag = result.ok ? "放行" : "拒绝";
    console.log(`✓ ${c.name} → ${tag}${result.ok ? "" : "（" + result.error.slice(0, 40) + "…）"}`);
  }
}

if (failed > 0) {
  console.error(`scoring-mode-consistency-smoke: ${failed} 失败`);
  process.exit(1);
}
console.log("scoring-mode-consistency-smoke ok");
