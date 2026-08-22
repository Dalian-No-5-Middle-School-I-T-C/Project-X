/**
 * 信度（Cronbach α / KR-20）与变异系数 CV 冒烟测试（纯函数，不依赖数据库）
 *
 * 覆盖：
 *  - α 与 KR-20 的数值正确性（与手算一致）
 *  - 样本/题数不足、方差为 0、矩阵不完整时的 null 保护
 *  - CV 的均值 ≤0 保护
 *
 * 运行: npx tsx scripts/stats-reliability-smoke.ts
 */
import { coefficientOfVariation, cronbachAlpha, kr20 } from "../src/shared/stats";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}`);
  }
}

// [1] Cronbach α —— 手算验证
// 3 题 × 3 生：行=[8,7,6],[7,6,5],[6,5,4]
// 列均值: 7,6,5；列方差: 2/3,2/3,2/3（0.6667²×…手算：各列 std=0.8165, var=0.6667）
// 总分: 21,18,15 → 均值 18，方差 (9+0+9)/3=6
// α = 3/2 × (1 − (0.6667×3)/6) = 1.5 × (1 − 0.3333) = 1.0（完美线性）
{
  const m = [[8, 7, 6], [7, 6, 5], [6, 5, 4]];
  const a = cronbachAlpha(m);
  check("完美线性 3 题 α = 1.0", a !== null && Math.abs(a - 1.0) < 1e-9);
}

// [2] KR-20 —— 与二分数据上的 α 等价
// 2 题 × 4 生：[1,1],[1,0],[0,1],[0,0]
// p1=0.5,p2=0.5 → Σpq=0.25+0.25=0.5；总分 [2,1,1,0] 均值 1，方差 (1+0+0+1)/4=0.5
// KR-20 = 2/1 × (1 − 0.5/0.5) = 0
{
  const m = [[1, 1], [1, 0], [0, 1], [0, 0]];
  const r20 = kr20(m);
  check("随机 2 题 KR-20 = 0", r20 !== null && Math.abs(r20 - 0) < 1e-9);
  const alphaOnBinary = cronbachAlpha(m);
  check("二分数据上 α ≡ KR-20", alphaOnBinary !== null && r20 !== null && Math.abs(alphaOnBinary - r20) < 1e-9);
}

// [3] 高一致性 KR-20（Guttman 模式：能力排序完全一致）
// 4 题 × 4 生：[1,1,1,1],[1,1,1,0],[1,1,0,0],[1,0,0,0]
// Σpq = 0 + 0.1875 + 0.25 + 0.1875 = 0.625；总分均值 2.5，方差 1.25
// KR-20 = 4/3 × (1 − 0.625/1.25) = 0.6667
{
  const m = [[1, 1, 1, 1], [1, 1, 1, 0], [1, 1, 0, 0], [1, 0, 0, 0]];
  const r20 = kr20(m);
  check("Guttman 模式 KR-20 = 0.667", r20 !== null && Math.abs(r20 - 0.6667) < 0.001);
}

// [3b] 反模式：总分能力与题目得分负相关 → 负信度（数学上合理，被裁剪到 -1）
{
  const m = [[1, 1, 1], [1, 1, 0], [1, 0, 1], [0, 1, 1]];
  const r20 = kr20(m);
  check("反一致性 KR-20 被裁剪到 [-1,1] 且为负", r20 !== null && r20 === -1);
}

// [4] 保护：题数/样本不足
{
  check("1 题返回 null", cronbachAlpha([[1], [2]]) === null);
  check("1 生返回 null", cronbachAlpha([[1, 2]]) === null);
  check("KR-20 1 题返回 null", kr20([[1], [0]]) === null);
}

// [5] 保护：总分方差为 0（所有学生同分）
{
  check("总分方差 0 → α null", cronbachAlpha([[5, 5], [5, 5]]) === null);
  check("KR-20 全满分 → null", kr20([[1, 1], [1, 1]]) === null);
}

// [6] 保护：矩阵不完整 / 含 NaN
{
  check("行长度不一致 → null", cronbachAlpha([[1, 2], [3]]) === null);
  check("含 NaN → null", cronbachAlpha([[1, NaN], [3, 4]]) === null);
  check("KR-20 非 0/1 值 → null", kr20([[1, 2], [0, 1]]) === null);
}

// [7] 变异系数
{
  check("CV(2, 10) = 0.2", coefficientOfVariation(2, 10) === 0.2);
  check("均值 0 → null", coefficientOfVariation(2, 0) === null);
  check("均值 <0 → null", coefficientOfVariation(2, -1) === null);
  check("负标准差 → null", coefficientOfVariation(-1, 10) === null);
  check("NaN → null", coefficientOfVariation(NaN, 10) === null);
}

// [8] 一般性：α = 1 − k/(k-1)·σ²_avg/σ²_total 的行为边界（方差为 0 的题）
{
  // 第 3 题所有人都得 0（方差 0）：α 公式仍可算，Σσ² 少一项
  const m = [[5, 3, 0], [3, 4, 0], [4, 5, 0]];
  const a = cronbachAlpha(m);
  check("含零方差题可计算", a !== null && a >= -1 && a <= 1);
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);