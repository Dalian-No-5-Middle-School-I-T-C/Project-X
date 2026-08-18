/**
 * 网阅提交回归验证（临时库，不依赖 HTTP）。
 *
 * 覆盖 2026-08 真实使用评审发现的两个 P0 回归：
 *   1. 演示/空卡体切块提交必 422「题号不在答题卡题目范围内」；
 *   2. 新切块 review_round 默认 1，首评即报「已达到评分上限」。
 *
 * 运行：npm run verify:review-submit
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tempDir = mkdtempSync(path.join(tmpdir(), "projectx-review-submit-"));
process.env.PROJECTX_DB_PATH = path.join(tempDir, "projectx.db");
process.env.ANSWER_CARD_DATA_DIR = path.join(tempDir, "data");
for (const key of [
  "PROJECTX_MARIADB_HOST", "PROJECTX_MARIADB_PORT", "PROJECTX_MARIADB_USER",
  "PROJECTX_MARIADB_PASSWORD", "PROJECTX_MARIADB_DATABASE", "PROJECTX_MYSQL_HOST"
]) delete process.env[key];

let passed = 0;
let failed = 0;
function check(cond: boolean, label: string): void {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.error(`  ✗ ${label}`); }
}

async function main(): Promise<void> {
  const { initializeDatabase, ensureDefaultAdmin, getDatabase, closeDatabase } =
    await import("../src/server/db/index");
  const { seedDemoData } = await import("../src/server/services/DemoDataService");
  const { claimNextPaper } = await import("../src/server/services/ReviewPoolService");
  const { submitReviewCropScores } = await import("../src/server/services/ReviewService");

  initializeDatabase();
  await ensureDefaultAdmin();
  await seedDemoData();
  const db = getDatabase();

  const teacher = db.prepare("SELECT id FROM users WHERE username = 'demo-teacher'").get() as { id: number };
  const exam = db.prepare("SELECT id FROM exams WHERE name = '演示-网阅测试'").get() as { id: number };

  const freshRound = db.prepare(
    "SELECT review_round FROM answer_block_crops WHERE exam_id = ? AND block_id = 'B' AND status = 'ready' LIMIT 1"
  ).get(exam.id) as { review_round: number } | undefined;
  check(freshRound?.review_round === 0, "新切块 review_round=0（首评不再误判已达上限）");

  const crop = await claimNextPaper(exam.id, "B", teacher.id);
  check(crop.id.startsWith(`demo-${exam.id}-B-`), "从试卷池领取 B 题块切块");

  const result = await submitReviewCropScores({
    examId: exam.id,
    cropId: crop.id,
    userId: teacher.id,
    status: "reviewed",
    scores: [
      { questionNumber: 4, scoreType: "subjective", score: 4 },
      { questionNumber: 5, scoreType: "subjective", score: 5 },
      { questionNumber: 6, scoreType: "subjective", score: 4 },
      { questionNumber: 7, scoreType: "subjective", score: 4 },
      { questionNumber: 8, scoreType: "subjective", score: 3 }
    ]
  });
  check(result.ok && result.finalScore === 20 && !result.disputed, "空卡体演示卷提交成功，单评总分 20");

  console.log(`\n${passed} passed, ${failed} failed`);
  closeDatabase();
  try { rmSync(tempDir, { recursive: true, force: true }); }
  catch { /* Windows 句柄占用可忽略 */ }
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
