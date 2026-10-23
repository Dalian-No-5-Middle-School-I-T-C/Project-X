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

  // ── #351 之后的填空块：块总分只记在首个空，其余小空满分 0 ──
  // 识别切块的题号清单会列出块内全部小空，网阅面板也照样提交；
  // 若按「题号不在答题卡题目范围内」拒绝，整块卷子就再也交不出去了。
  const mysql = await import("../src/server/db");
  const adb = mysql.getMysqlDb();
  const blankCardId = "91599002";
  await adb.run("INSERT INTO answer_cards (id, title, subject_label, exam_date) VALUES (?,?,?,?)", blankCardId, "填空网阅回归", "数学", "2026-10-23");
  const blankExam = await adb.run("INSERT INTO exams (name, card_id, status, review_enabled) VALUES (?,?,?,1)", "演示-填空网阅", blankCardId, "grading");
  const blankExamId = Number(blankExam.lastInsertRowid);
  const blankStudent = await adb.get<{ id: number; student_number: string | null }>(
    "SELECT id, student_number FROM users WHERE student_number IS NOT NULL ORDER BY id LIMIT 1");
  check(Boolean(blankStudent?.id), "回归夹具取到一名学生");
  const blankStudentId = blankStudent!.id;
  const blankStudentNumber = blankStudent!.student_number;
  // 每个题块一份评分配置：逐题模式与题块总分模式各一块填空，两种提交方式都要能交卷
  for (const [blockId, firstNumber, mode] of [["fb_block", 56, "per_question"], ["fb_block2", 61, "block_total"]] as const) {
    await adb.run("INSERT INTO subjective_blocks (id, card_id, sort_order, block_kind, title) VALUES (?,?,?,?,?)", blockId, blankCardId, blockId === "fb_block" ? 0 : 1, "fill_blank", "语法填空");
    for (const [index, entry] of ([[firstNumber, 15], [firstNumber + 1, 0], [firstNumber + 2, 0]] as const).entries()) {
      await adb.run("INSERT INTO subjective_questions (id, block_id, number, score, style, kind, min_height_mm, sort_order) VALUES (?,?,?,?,?,?,?,?)",
        `${blockId}_q${entry[0]}`, blockId, entry[0], entry[1], "manual_score_grid", "blank", 12, index);
    }
    await adb.run("INSERT INTO block_grading_config (exam_id, block_id, scoring_mode, score_distribution, has_half_point, review_mode) VALUES (?,?,?,'proportional',0,1)",
      blankExamId, blockId, mode);
    const cropId = `fb-crop-${blockId}`;
    await adb.run(`INSERT INTO answer_block_crops
        (id, card_id, exam_id, student_id, student_number, source_type, source_record_id,
         block_id, block_title, block_type, page_number, segment_index, question_numbers,
         rect_json, image_path, width_px, height_px, dpi, status, review_round)
       VALUES (?,?,?,?,?, 'regression', ?, ?, '语法填空', 'subjective', 1, 0, ?, '{}', 'missing.png', 240, 320, 300, 'ready', 0)`,
      cropId, blankCardId, blankExamId, blankStudentId, blankStudentNumber, `${cropId}-record`, blockId,
      JSON.stringify([String(firstNumber), String(firstNumber + 1), String(firstNumber + 2)]));
    await adb.run("UPDATE answer_block_crops SET claimed_by = ? WHERE id = ?", teacher.id, cropId);
  }
  // 拒绝用例专用的一份卷：不能借用已经评过分的切块
  await adb.run(`INSERT INTO answer_block_crops
      (id, card_id, exam_id, student_id, student_number, source_type, source_record_id,
       block_id, block_title, block_type, page_number, segment_index, question_numbers,
       rect_json, image_path, width_px, height_px, dpi, status, review_round)
     VALUES ('fb-crop-unknown', ?, ?, ?, ?, 'regression', 'fb-crop-unknown-record', 'fb_block', '语法填空', 'subjective', 1, 0, ?, '{}', 'missing.png', 240, 320, 300, 'ready', 0)`,
    blankCardId, blankExamId, blankStudentId, blankStudentNumber, JSON.stringify(["56", "57", "58"]));
  await adb.run("UPDATE answer_block_crops SET claimed_by = ? WHERE id = ?", teacher.id, "fb-crop-unknown");
  const perQuestion = await submitReviewCropScores({
    examId: blankExamId, cropId: "fb-crop-fb_block", userId: teacher.id, status: "reviewed",
    scores: [
      { questionNumber: 56, scoreType: "subjective", score: 12 },
      { questionNumber: 57, scoreType: "subjective", score: 0 },
      { questionNumber: 58, scoreType: "subjective", score: 0 },
    ],
  });
  check(perQuestion.ok && perQuestion.totalScore === 12, "逐题模式：带 0 分小空的填空块仍能交卷（总分记在首个空）");
  const blockTotal = await submitReviewCropScores({
    examId: blankExamId, cropId: "fb-crop-fb_block2", userId: teacher.id, status: "reviewed",
    blockTotalScore: 10,
    scores: [
      { questionNumber: 61, scoreType: "subjective", score: 0 },
      { questionNumber: 62, scoreType: "subjective", score: 0 },
      { questionNumber: 63, scoreType: "subjective", score: 0 },
    ],
  });
  const written = (await adb.all<{ question_number: number }>(
    "SELECT question_number FROM question_scores WHERE exam_id = ? AND score_type = 'subjective' ORDER BY question_number", blankExamId))
    .map(row => Number(row.question_number));
  check(JSON.stringify(written) === JSON.stringify([56, 61]), `0 分小空不写逐题成绩（实际落库题号 ${JSON.stringify(written)}）`);
  check(blockTotal.ok && blockTotal.finalScore === 10, "题块总分模式：0 分小空不参与覆盖校验与拆分");
  const unknownError = await submitReviewCropScores({
    examId: blankExamId, cropId: "fb-crop-unknown", userId: teacher.id, status: "reviewed",
    scores: [{ questionNumber: 77, scoreType: "subjective", score: 1 }],
  }).then(() => "accepted").catch((error: Error) => error.message);
  check(String(unknownError).includes("不在答题卡题目范围内"), "真正不存在的题号依旧拒绝，0 分小空只是跳过");

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
