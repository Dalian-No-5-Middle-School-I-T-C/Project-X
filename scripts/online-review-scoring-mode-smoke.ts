/**
 * OnlineReviewPanel 三态评分模式 smoke 测试
 *
 * 背景：PR #189 二次修复。客户端评分模式从二态（block_total/per_question）
 * 扩为三态（+unknown）。区分：
 *   - 配置明确读到 block_total → 禁用提交（与管理配置一致）
 *   - 配置明确读到 per_question → 正常提交
 *   - 配置缺失但响应成功 → 回退 block_total（与后端 getBlockConfig 行为一致）
 *   - 配置加载失败（网络/服务异常）→ unknown，禁用按钮会让老师硬锁死，
 *     必须保留提交能力，让服务端校验兜底
 *
 * 覆盖场景：
 *   1) ok + scoringMode=block_total      → block_total
 *   2) ok + scoringMode=per_question     → per_question
 *   3) ok + scoringMode=undefined         → block_total（非法值回落）
 *   4) ok + scoringMode=garbage            → block_total（非法值回落，与 service 白名单一致）
 *   5) config-missing                     → block_total（合法未配置）
 *   6) fetch-failed                       → unknown + 携带错误信息
 */
import { resolveScoringMode, type ConfigFetchResult } from "../src/server/services/scoringModeValidator";

interface Case {
  name: string;
  result: ConfigFetchResult;
  expectedMode: "block_total" | "per_question" | "unknown";
  expectErrorIncludes?: string;
}

const cases: Case[] = [
  {
    name: "ok + block_total → block_total",
    result: { kind: "ok", scoringMode: "block_total" },
    expectedMode: "block_total"
  },
  {
    name: "ok + per_question → per_question",
    result: { kind: "ok", scoringMode: "per_question" },
    expectedMode: "per_question"
  },
  {
    name: "ok + scoringMode=undefined → block_total（字段缺失回落）",
    result: { kind: "ok", scoringMode: undefined },
    expectedMode: "block_total"
  },
  {
    name: "ok + scoringMode=garbage → block_total（非法值回落，与 service 白名单一致）",
    result: { kind: "ok", scoringMode: "block_total_v2" },
    expectedMode: "block_total"
  },
  {
    name: "config-missing → block_total（合法未配置）",
    result: { kind: "config-missing" },
    expectedMode: "block_total"
  },
  {
    name: "fetch-failed → unknown + 携带错误",
    result: { kind: "fetch-failed", error: "Network timeout" },
    expectedMode: "unknown",
    expectErrorIncludes: "Network timeout"
  }
];

let failed = 0;
for (const c of cases) {
  const out = resolveScoringMode(c.result);
  let ok = out.mode === c.expectedMode;
  if (ok && c.expectedMode === "unknown" && c.expectErrorIncludes) {
    if (!out.configLoadError?.includes(c.expectErrorIncludes)) {
      ok = false;
      console.error(
        `✗ ${c.name}: configLoadError 不含「${c.expectErrorIncludes}」, 实际: ${out.configLoadError}`
      );
      failed++;
      continue;
    }
  }
  if (ok && c.expectedMode !== "unknown" && out.configLoadError !== null) {
    ok = false;
    console.error(
      `✗ ${c.name}: 非 unknown 状态下 configLoadError 应为 null, 实际: ${out.configLoadError}`
    );
    failed++;
    continue;
  }
  if (!ok) {
    failed++;
    console.error(`✗ ${c.name}: expected mode=${c.expectedMode}, got ${JSON.stringify(out)}`);
  } else {
    const tag = out.mode;
    const extra = out.configLoadError ? ` (err: ${out.configLoadError})` : "";
    console.log(`✓ ${c.name} → ${tag}${extra}`);
  }
}

if (failed > 0) {
  console.error(`online-review-scoring-mode-smoke: ${failed} 失败`);
  process.exit(1);
}
console.log("online-review-scoring-mode-smoke ok");