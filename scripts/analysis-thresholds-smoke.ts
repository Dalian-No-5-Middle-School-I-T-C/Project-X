/**
 * 成绩分析阈值校验冒烟测试（纯函数，不依赖数据库）
 *
 * 覆盖 validateThresholdsInput / parseErrorTiersStrict / parseErrorTiers：
 * 重点回归「非法 errorTiers 应报错而非静默替换成默认值」（PR 审查非阻塞问题 2）。
 *
 * 运行: npx tsx scripts/analysis-thresholds-smoke.ts
 */
import {
  validateThresholdsInput, parseErrorTiersStrict, parseErrorTiers,
  DEFAULT_ANALYSIS_THRESHOLDS
} from "../src/server/services/analysisConfig";

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

const validBody = { passRate: 0.6, excellentRate: 0.9, segmentSize: 10, errorTiers: "70,50,30" };

console.log("[1] validateThresholdsInput — 合法输入");
{
  const r = validateThresholdsInput(validBody);
  check("字符串档位 \"70,50,30\" 通过", r.ok);
  if (r.ok) {
    check("档位解析为 [70,50,30]", JSON.stringify(r.value.errorTiers) === "[70,50,30]");
  }
  const rArr = validateThresholdsInput({ ...validBody, errorTiers: [80, 60, 40] });
  check("数组档位 [80,60,40] 通过", rArr.ok && JSON.stringify(rArr.ok ? rArr.value.errorTiers : null) === "[80,60,40]");
  const rFloat = validateThresholdsInput({ ...validBody, errorTiers: "75.5,50,25.5" });
  check("小数档位 75.5,50,25.5 通过", rFloat.ok);
}

console.log("[2] validateThresholdsInput — 非法 errorTiers 必须拒绝（回归）");
{
  check("升序 [30,50,70] 被拒绝", !validateThresholdsInput({ ...validBody, errorTiers: [30, 50, 70] }).ok);
  check("乱序 [50,70,30] 被拒绝", !validateThresholdsInput({ ...validBody, errorTiers: [50, 70, 30] }).ok);
  check("相等 [70,70,30] 被拒绝", !validateThresholdsInput({ ...validBody, errorTiers: [70, 70, 30] }).ok);
  check("越界 [110,50,30] 被拒绝", !validateThresholdsInput({ ...validBody, errorTiers: [110, 50, 30] }).ok);
  check("零/负值 [70,50,0] 被拒绝", !validateThresholdsInput({ ...validBody, errorTiers: [70, 50, 0] }).ok);
  check("只有 2 档 [70,50] 被拒绝", !validateThresholdsInput({ ...validBody, errorTiers: [70, 50] }).ok);
  check("4 档 [80,70,50,30] 被拒绝", !validateThresholdsInput({ ...validBody, errorTiers: [80, 70, 50, 30] }).ok);
  check("非数值 \"a,b,c\" 被拒绝", !validateThresholdsInput({ ...validBody, errorTiers: "a,b,c" }).ok);
  check("缺失 errorTiers 被拒绝", !validateThresholdsInput({ passRate: 0.6, excellentRate: 0.9, segmentSize: 10 }).ok);
  const rejected = validateThresholdsInput({ ...validBody, errorTiers: [30, 50, 70] });
  check("拒绝时返回中文错误消息", !rejected.ok && typeof rejected.message === "string" && rejected.message.length > 0);
}

console.log("[3] validateThresholdsInput — 其余字段校验仍有效");
{
  check("passRate=0 被拒绝", !validateThresholdsInput({ ...validBody, passRate: 0 }).ok);
  check("passRate=1.5 被拒绝", !validateThresholdsInput({ ...validBody, passRate: 1.5 }).ok);
  check("excellentRate < passRate 被拒绝", !validateThresholdsInput({ ...validBody, passRate: 0.9, excellentRate: 0.6 }).ok);
  check("segmentSize=0 被拒绝", !validateThresholdsInput({ ...validBody, segmentSize: 0 }).ok);
  check("segmentSize=2.5 被拒绝", !validateThresholdsInput({ ...validBody, segmentSize: 2.5 }).ok);
  check("segmentSize=101 被拒绝", !validateThresholdsInput({ ...validBody, segmentSize: 101 }).ok);
}

console.log("[4] parseErrorTiersStrict / parseErrorTiers 分工");
{
  check("strict: 合法 \"70,50,30\" → [70,50,30]", JSON.stringify(parseErrorTiersStrict("70,50,30")) === "[70,50,30]");
  check("strict: 非法 \"30,50,70\" → null", parseErrorTiersStrict("30,50,70") === null);
  check("strict: 空串 → null", parseErrorTiersStrict("") === null);
  check("strict: null → null", parseErrorTiersStrict(null) === null);
  check(
    "lenient: 非法输入回退默认值（仅读库路径）",
    JSON.stringify(parseErrorTiers("bad")) === JSON.stringify(DEFAULT_ANALYSIS_THRESHOLDS.errorTiers)
  );
  check("lenient: 合法输入原样返回", JSON.stringify(parseErrorTiers("90,60,20")) === "[90,60,20]");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("analysis-thresholds-smoke: ALL PASS");
