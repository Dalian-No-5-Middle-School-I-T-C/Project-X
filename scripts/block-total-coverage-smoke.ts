/**
 * block_total 模式题号覆盖 + 重复校验 smoke 测试
 *
 * 背景：原 ReviewService 用 Set 检查题号覆盖，但没检查 params.scores 自身
 * 是否有重复题号。客户端提交 [1,1,2] 时：
 *   - Set 看到 1、2 都覆盖 → 校验通过（错！）
 *   - submittedScores 数组保留两个第 1 题
 *   - totalScore 把第 1 题算两次（虚高）
 *   - scoreBreakdown.questionScores 去重后只保留一个 #1，
 *     与 scoreBreakdown.score 之和不一致 → 后续争议/排名计算全错
 *
 * 覆盖场景：
 *   1) 完美匹配（顺序无关）→ 放行
 *   2) 完美匹配（顺序倒置）→ 放行
 *   3) 单题题块 → 放行
 *   4) 重复题号 [1,1,2]     → 拒绝
 *   5) 重复题号 [1,2,2]     → 拒绝
 *   6) 多重重复 [1,1,1]     → 拒绝
 *   7) 提交项数少于权威     → 拒绝
 *   8) 提交项数多于权威     → 拒绝
 *   9) 含不属于本题块的题号 → 拒绝
 *  10) 空数组               → 拒绝
 */
import { validateBlockTotalCoverage } from "../src/server/services/scoringModeValidator";

interface Case {
  name: string;
  authoritativeNums: number[];
  submittedNums: number[];
  expectOk: boolean;
  expectErrorIncludes?: string;
}

const cases: Case[] = [
  {
    name: "完美匹配 → 放行",
    authoritativeNums: [1, 2, 3],
    submittedNums: [1, 2, 3],
    expectOk: true
  },
  {
    name: "完美匹配但顺序倒置 → 放行",
    authoritativeNums: [1, 2, 3],
    submittedNums: [3, 1, 2],
    expectOk: true
  },
  {
    name: "单题题块 → 放行",
    authoritativeNums: [1],
    submittedNums: [1],
    expectOk: true
  },
  {
    name: "重复题号 [1,1,2] → 拒绝",
    authoritativeNums: [1, 2],
    submittedNums: [1, 1, 2],
    expectOk: false,
    expectErrorIncludes: "重复"
  },
  {
    name: "重复题号 [1,2,2] → 拒绝",
    authoritativeNums: [1, 2],
    submittedNums: [1, 2, 2],
    expectOk: false,
    expectErrorIncludes: "重复"
  },
  {
    name: "多重重复 [1,1,1] → 拒绝",
    authoritativeNums: [1, 2, 3],
    submittedNums: [1, 1, 1],
    expectOk: false,
    expectErrorIncludes: "重复"
  },
  {
    name: "提交项数少于权威 → 拒绝",
    authoritativeNums: [1, 2, 3],
    submittedNums: [1, 2],
    expectOk: false,
    expectErrorIncludes: "项数"
  },
  {
    name: "提交项数多于权威 → 拒绝",
    authoritativeNums: [1, 2],
    submittedNums: [1, 2, 3],
    expectOk: false,
    expectErrorIncludes: "项数"
  },
  {
    name: "含不属于本题块的题号（数量等于但题号错）→ 拒绝",
    authoritativeNums: [1, 2],
    submittedNums: [1, 99],
    expectOk: false,
    expectErrorIncludes: "不属于"
  },
  {
    name: "空数组 → 拒绝",
    authoritativeNums: [1, 2],
    submittedNums: [],
    expectOk: false,
    expectErrorIncludes: "至少"
  }
];

let failed = 0;
for (const c of cases) {
  const items = c.submittedNums.map((n) => ({ questionNumber: n }));
  const result = validateBlockTotalCoverage(c.authoritativeNums, items);

  let ok = result.ok === c.expectOk;
  if (ok && !result.ok && c.expectErrorIncludes) {
    if (!result.error.includes(c.expectErrorIncludes)) {
      ok = false;
      console.error(
        `✗ ${c.name}: 错误信息不含「${c.expectErrorIncludes}」, 实际: ${result.error}`
      );
      failed++;
      continue;
    }
  }
  if (!ok) {
    failed++;
    console.error(
      `✗ ${c.name}: expected ok=${c.expectOk}, got ${JSON.stringify(result)}`
    );
  } else {
    const tag = result.ok ? "放行" : "拒绝";
    console.log(
      `✓ ${c.name} → ${tag}${result.ok ? "" : "（" + result.error.slice(0, 50) + "…）"}`
    );
  }
}

if (failed > 0) {
  console.error(`block-total-coverage-smoke: ${failed} 失败`);
  process.exit(1);
}
console.log("block-total-coverage-smoke ok");
