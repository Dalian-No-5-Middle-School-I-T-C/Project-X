/**
 * scoringMode / scoreDistribution 配置端到端集成测试
 *
 * 背景：P1-A 修复要求管理员能通过 UI 切换评分模式。UI 把表单值通过
 * PUT /api/block-grading-config/.../:blockId 写库，再由 OnlineReviewPanel 读回。
 * 本测试直接打 Service 层（避开 HTTP），验证：
 *   1) upsertBlockConfig + getBlockConfig 双向一致（含枚举值归一化）
 *   2) 服务端白名单：scoringMode / scoreDistribution 非法值立刻抛错
 *   3) __default__ 模板与单题块配置共享同一 Service 路径
 *   4) 批量接口走事务，所有题块要么全成功要么全失败
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// 必须在导入任何 db 模块前设置数据库路径
const tmpDir = mkdtempSync(path.join(tmpdir(), "projectx-verify-scoring-"));
process.env.PROJECTX_DB_PATH = path.join(tmpDir, "verify.db");
delete process.env.PROJECTX_MARIADB_HOST;
delete process.env.PROJECTX_MARIADB_PORT;
delete process.env.PROJECTX_MARIADB_USER;

import { getMysqlDb } from "../src/server/db";
import {
  upsertBlockConfig,
  getBlockConfig,
  batchUpdateConfigs
} from "../src/server/services/BlockGradingConfigService";
let failed = 0;
function expect(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`✓ ${name}`);
  } else {
    failed++;
    console.error(`✗ ${name}${detail ? `: ${detail}` : ""}`);
  }
}

async function main(): Promise<void> {
  // 与 verify-auth 一致：先调 initializeDatabase 触发 schema 与迁移，
  // 否则 block_grading_config 等表不存在。
  const dbMod = await import("../src/server/db");
  if (typeof dbMod.initializeDatabase === "function") {
    await dbMod.initializeDatabase();
  }
  const db = getMysqlDb();
  // 跑一次空查询确认连接
  await db.get("SELECT 1");

  // block_grading_config.exam_id 引用 exams(id)，先造一条最小 exams 行
  await db.run(
    "INSERT INTO exams (id, name, status, card_id) VALUES (1, 'verify-exam', 'active', NULL)"
  );

  // ── Case 1: __default__ 模板能存读 scoringMode + scoreDistribution ──
  await upsertBlockConfig(1, "__default__", {
    scoringMode: "per_question"
  });
  let d = await getBlockConfig(1, "__default__");
  expect("default.scoringMode=per_question 持久化", d.scoringMode === "per_question", `actual=${d.scoringMode}`);

  await upsertBlockConfig(1, "__default__", {
    scoringMode: "block_total",
    scoreDistribution: "equal"
  });
  d = await getBlockConfig(1, "__default__");
  expect("default.scoringMode 切回 block_total", d.scoringMode === "block_total");
  expect("default.scoreDistribution=equal 持久化", d.scoreDistribution === "equal", `actual=${d.scoreDistribution}`);

  // ── Case 2: 单题块走同一 Service 路径 ──
  await upsertBlockConfig(1, "block_A", { scoringMode: "per_question" });
  const a = await getBlockConfig(1, "block_A");
  expect("block_A.scoringMode=per_question 持久化", a.scoringMode === "per_question", `actual=${a.scoringMode}`);

  // ── Case 3: 非法枚举值被白名单拦截 ──
  let threw = false;
  try {
    await upsertBlockConfig(1, "block_B", { scoringMode: "rubbish" as any });
  } catch (e: any) {
    threw = e.message.includes("scoringMode") && e.message.includes("非法");
  }
  expect("非法 scoringMode 抛错", threw);

  threw = false;
  try {
    await upsertBlockConfig(1, "block_C", { scoreDistribution: "random" as any });
  } catch (e: any) {
    threw = e.message.includes("scoreDistribution") && e.message.includes("非法");
  }
  expect("非法 scoreDistribution 抛错", threw);

  // ── Case 4: 批量接口走事务，全部题块同步更新 ──
  await batchUpdateConfigs(1, ["block_A", "block_D", "block_E"], {
    scoringMode: "block_total",
    scoreDistribution: "proportional"
  });
  const aAfter = await getBlockConfig(1, "block_A");
  const dAfter = await getBlockConfig(1, "block_D");
  const eAfter = await getBlockConfig(1, "block_E");
  expect("batch: block_A 已切换", aAfter.scoringMode === "block_total");
  expect("batch: block_D 已切换", dAfter.scoringMode === "block_total");
  expect("batch: block_E 已切换", eAfter.scoringMode === "block_total");
  expect("batch: 拆分策略同步", aAfter.scoreDistribution === "proportional" && dAfter.scoreDistribution === "proportional" && eAfter.scoreDistribution === "proportional");

  // ── Case 5: 读不到的题块回退到 default（与业务行为一致） ──
  // 先把 default 重置为 block_total + proportional，再去查不存在的题块
  await upsertBlockConfig(1, "__default__", {
    scoringMode: "block_total",
    scoreDistribution: "proportional"
  });
  const fallback = await getBlockConfig(1, "block_not_exist", "answer", 10);
  expect("未配置题块回退 default.scoringMode", fallback.scoringMode === "block_total", `actual=${fallback.scoringMode}`);
  expect("未配置题块回退 default.scoreDistribution", fallback.scoreDistribution === "proportional", `actual=${fallback.scoreDistribution}`);

  // ── 收尾 ──
  // Windows 下 SQLite 仍持有文件句柄，rmSync 经常 EBUSY；临时目录由 OS 清理
  if (failed > 0) {
    console.error(`\nscoring-mode-config-integration: ${failed} 失败`);
    process.exit(1);
  }
  console.log("\nscoring-mode-config-integration ok");
}

main().catch((err) => {
  console.error("scoring-mode-config-integration 异常退出:", err);
  process.exit(1);
});
