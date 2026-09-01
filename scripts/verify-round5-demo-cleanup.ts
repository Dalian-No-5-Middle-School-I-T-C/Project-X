/**
 * 五轮测试 A3 回归：演示数据清理不得因 FK 炸，也不得删除引用演示卡的非演示考试。
 * 场景：seedDemoData 后，用演示答题卡自建“远程全链路测试”（不带「演示-」前缀），
 * 清理时应保留该考试、真实学生成绩和被引用的答题卡，同时清除其余演示资产。
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
  const prefixExamCount = Number((await db.get(
    "SELECT COUNT(*) AS cnt FROM exams WHERE name LIKE '演示-%'"
  ) as { cnt: number }).cnt);
  // 用户自建考试引用演示卡（不带「演示-」前缀）—— 复现线上 FK 1451 与误删风险
  const demoCard = await db.get("SELECT id FROM answer_cards WHERE is_demo = 1 LIMIT 1") as { id: string } | undefined;
  ok(!!demoCard, "存在演示答题卡");
  if (!demoCard) { console.error("前置失败：无演示卡"); process.exit(1); }
  const realStudentInsert = await db.run(
    `INSERT INTO users (username, password_hash, name, role_id, student_number, is_demo)
     VALUES ('round5-real-student', 'test-only', '真实学生', 3, 'R5001', 0)`
  );
  const realStudentId = Number(realStudentInsert.lastInsertRowid);
  const insert = await db.run(
    "INSERT INTO exams (name, card_id, grade_id, class_id, subject, status) VALUES ('远程全链路测试', ?, NULL, NULL, '英语', 'closed')",
    demoCard.id
  );
  const customExamId = Number(insert.lastInsertRowid);
  ok(customExamId > 0, `自建考试已创建 (id=${customExamId})`);
  await db.run(
    "INSERT INTO student_scores (exam_id, student_id, total_score, objective_score, subjective_score) VALUES (?, ?, 88, 40, 48)",
    customExamId, realStudentId
  );
  await db.run(
    "INSERT INTO exam_participants (exam_id, student_id, source) VALUES (?, ?, 'explicit')",
    customExamId, realStudentId
  );

  // 清理不得抛 FK 错
  let cleared: Awaited<ReturnType<typeof clearDemoData>>;
  let threw: Error | null = null;
  try { cleared = await clearDemoData(); } catch (e) { threw = e as Error; }
  ok(!threw, `clearDemoData 不抛外键错误${threw ? `：${threw.message}` : ""}`);
  if (threw) { console.error(threw); process.exit(1); }

  const customStill = await db.get("SELECT id FROM exams WHERE id = ?", customExamId) as { id: number } | undefined;
  ok(!!customStill, "引用演示卡的非演示考试被保留");
  const protectedCard = await db.get("SELECT id FROM answer_cards WHERE id = ?", demoCard.id) as { id: string } | undefined;
  ok(!!protectedCard, "仍被非演示考试引用的演示答题卡被保留");
  const scoreStill = await db.get(
    "SELECT total_score FROM student_scores WHERE exam_id = ? AND student_id = ?",
    customExamId, realStudentId
  ) as { total_score: number } | undefined;
  ok(Number(scoreStill?.total_score) === 88, "非演示考试的真实学生成绩被保留");
  const participantStill = await db.get(
    "SELECT 1 AS ok FROM exam_participants WHERE exam_id = ? AND student_id = ?",
    customExamId, realStudentId
  ) as { ok: number } | undefined;
  ok(!!participantStill, "非演示考试的应考名单被保留");
  const userLeft = await db.get("SELECT COUNT(*) AS cnt FROM users WHERE is_demo = 1") as { cnt: number };
  ok(Number(userLeft.cnt) === 0, "演示用户全部清除");
  ok(cleared!.removedExams === prefixExamCount, `仅统计「演示-」前缀考试（removedExams=${cleared!.removedExams}）`);
  ok(cleared!.preservedExams === 1 && cleared!.preservedCards === 1,
    `保护统计正确（exams=${cleared!.preservedExams}, cards=${cleared!.preservedCards}）`);

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) { console.error("失败项:\n" + failures.map((f) => "  - " + f).join("\n")); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
