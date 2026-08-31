/**
 * 五轮测试 A3 回归：演示数据清理不得因 FK 炸（演示卡被非演示名前缀考试引用）。
 * 场景：seedDemoData 后，用演示答题卡自建“远程全链路测试”（不带「演示-」前缀），
 * 清理时应把引用演示卡的考试视作演示资产链一并删除，且全程无外键错误。
 * 用法：npx tsx scripts/verify-round5-demo-cleanup.ts（期望全绿，退出码 0）
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmpDir = mkdtempSync(path.join(tmpdir(), "projectx-round5-demo-"));
process.env.PROJECTX_DB_PATH = path.join(tmpDir, "round5-demo.db");
delete process.env.PROJECTX_MARIADB_HOST;
delete process.env.PROJECTX_MYSQL_HOST;

import { getMysqlDb } from "../src/server/db";
import { seedDemoData, clearDemoData } from "../src/server/services/DemoDataService";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(cond: boolean, label: string): void {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { failed++; failures.push(label); console.log(`  \x1b[31m✗\x1b[0m ${label}`); }
}
function section(title: string): void { console.log(`\n\x1b[36m== ${title} ==\x1b[0m`); }

async function main(): Promise<void> {
  const { initializeDatabase, ensureDefaultAdmin } = await import("../src/server/db/index");
  initializeDatabase();
  await ensureDefaultAdmin();

  const stats = await seedDemoData();
  ok(stats.exams > 0, `演示数据导入成功（${stats.exams} 场考试）`);

  const db = getMysqlDb();
  // 用户自建考试引用演示卡（不带「演示-」前缀）—— 复现线上 FK 1451
  const demoCard = await db.get("SELECT id FROM answer_cards WHERE is_demo = 1 LIMIT 1") as { id: string } | undefined;
  ok(!!demoCard, "存在演示答题卡");
  if (!demoCard) { console.error("前置失败：无演示卡"); process.exit(1); }
  const demoStudent = await db.get(
    "SELECT id FROM users WHERE is_demo = 1 AND role_id = 3 LIMIT 1"
  ) as { id: number } | undefined;
  const insert = await db.run(
    "INSERT INTO exams (name, card_id, grade_id, class_id, subject, status) VALUES ('远程全链路测试', ?, NULL, NULL, '英语', 'closed')",
    demoCard.id
  );
  const customExamId = Number(insert.lastInsertRowid);
  ok(customExamId > 0, `自建考试已创建 (id=${customExamId})`);
  if (demoStudent) {
    await db.run(
      "INSERT INTO student_scores (exam_id, student_id, total_score, objective_score, subjective_score) VALUES (?, ?, 88, 40, 48)",
      customExamId, demoStudent.id
    );
  }

  // 清理不得抛 FK 错
  let cleared: Awaited<ReturnType<typeof clearDemoData>>;
  let threw: Error | null = null;
  try { cleared = await clearDemoData(); } catch (e) { threw = e as Error; }
  ok(!threw, `clearDemoData 不抛外键错误${threw ? `：${threw.message}` : ""}`);
  if (threw) { console.error(threw); process.exit(1); }

  const customStill = await db.get("SELECT id FROM exams WHERE id = ?", customExamId) as { id: number } | undefined;
  ok(!customStill, "引用演示卡的考试（非演示名前缀）已被一并清理");
  const cardLeft = await db.get("SELECT COUNT(*) AS cnt FROM answer_cards WHERE is_demo = 1") as { cnt: number };
  ok(Number(cardLeft.cnt) === 0, "演示答题卡全部清除");
  const userLeft = await db.get("SELECT COUNT(*) AS cnt FROM users WHERE is_demo = 1") as { cnt: number };
  ok(Number(userLeft.cnt) === 0, "演示用户全部清除");
  ok(cleared!.removedExams >= 1, `清理统计含被并入的考试（removedExams=${cleared!.removedExams}）`);

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) { console.error("失败项:\n" + failures.map((f) => "  - " + f).join("\n")); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });