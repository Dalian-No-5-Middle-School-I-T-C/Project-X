/**
 * Issue #174 试卷池冒烟测试
 *
 * 运行: npx tsx scripts/review-pool-smoke.ts
 *
 * 覆盖:
 *  1. 初始汇总:总量/池中可领/已阅
 *  2. 教师 A 领卷 → 锁定到 A,池中数量减少
 *  3. 教师 B 领卷 → 拿到不同试卷,两人互斥
 *  4. 指定领取已被他人领取的试卷 → 冲突报错
 *  5. 领取人本人释放 → 回池
 *  6. 管理员强制释放他人领取的试卷 → 回池
 *  7. claim_count 累计领取次数
 *  8. 已阅卷不可领取
 *  9. 池空时领卷报错
 * 10. 提交归属校验:非领取人提交被拒
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";

const tmpDir = mkdtempSync(path.join(tmpdir(), "projectx-reviewpool-"));
process.env.PROJECTX_DB_PATH = path.join(tmpDir, "pool.db");
delete process.env.PROJECTX_MARIADB_HOST;
delete process.env.PROJECTX_MARIADB_PORT;
delete process.env.PROJECTX_MARIADB_USER;
delete process.env.PROJECTX_MARIADB_PASSWORD;
delete process.env.PROJECTX_MARIADB_DATABASE;
delete process.env.PROJECTX_MYSQL_HOST;

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(cond: boolean, label: string): void {
  if (cond) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  \x1b[31m✗\x1b[0m ${label}`);
  }
}

async function expectError(label: string, fn: () => Promise<unknown>, messagePart?: string): Promise<void> {
  try {
    await fn();
    ok(false, `${label}（未抛错）`);
  } catch (err: any) {
    const msg = err instanceof Error ? err.message : String(err);
    ok(messagePart ? msg.includes(messagePart) : true, `${label} → ${msg}`);
  }
}

async function main(): Promise<void> {
  const { initializeDatabase, getDatabase, closeDatabase } = await import("../src/server/db/index");
  const { getMysqlDb } = await import("../src/server/db");
  const {
    getPoolSummary,
    getPoolEntries,
    claimNextPaper,
    claimSpecificPaper,
    releasePaper,
    ReviewPoolError
  } = await import("../src/server/services/ReviewPoolService");
  const { submitReviewCropScores, ReviewValidationError } = await import("../src/server/services/ReviewService");

  initializeDatabase();
  const db = getDatabase();
  const poolDb = getMysqlDb();

  // ── 基础数据:2 名教师 + 4 名学生 + 4 份切块(3 ready + 1 reviewed) ──
  const insertUser = db.prepare(
    "INSERT INTO users (name, role_id, username, password_hash, student_number) VALUES (?, ?, ?, ?, ?)"
  );
  const teacherA = Number(insertUser.run("教师A", 2, `ta_${randomUUID()}`, "x", null).lastInsertRowid);
  const teacherB = Number(insertUser.run("教师B", 2, `tb_${randomUUID()}`, "x", null).lastInsertRowid);
  const studentIds: number[] = [];
  for (let i = 0; i < 4; i++) {
    studentIds.push(Number(
      insertUser.run(`学生${i + 1}`, 3, `st_${randomUUID()}`, "x", String(1001 + i)).lastInsertRowid
    ));
  }

  const examId = Number(
    db.prepare("INSERT INTO exams (name, status) VALUES (?, ?)").run("试卷池测试", "grading").lastInsertRowid
  );

  const insertCrop = db.prepare(`
    INSERT INTO answer_block_crops (
      id, card_id, exam_id, student_id, student_number, source_type, source_record_id,
      block_id, block_title, block_type, page_number, segment_index,
      question_numbers, rect_json, image_path, width_px, height_px, dpi, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const cropIds: string[] = [];
  for (let i = 0; i < 4; i++) {
    const id = randomUUID();
    cropIds.push(id);
    insertCrop.run(
      id, "card-pool-test", examId, studentIds[i], String(1001 + i),
      "scan_record", `rec_${i}`, "A", "第一大题", "subjective",
      1, 0, JSON.stringify([1]), JSON.stringify({ x: 0, y: 0, width: 100, height: 100 }),
      `/tmp/crop_${i}.png`, 800, 600, 150,
      i === 3 ? "reviewed" : "ready"
    );
  }

  const blockId = "A";

  // 1. 初始汇总
  let summary = await getPoolSummary(examId, blockId, teacherA, poolDb);
  ok(summary.totalCount === 4, "初始总量 = 4");
  ok(summary.inPoolCount === 3, "初始池中可领 = 3（reviewed 不可领）");
  ok(summary.reviewedCount === 1, "初始已阅 = 1");

  // 2. 教师 A 领卷
  const first = await claimNextPaper(examId, blockId, teacherA, poolDb);
  ok(first.claimedBy === teacherA, "教师 A 领取后 claimedBy = A");
  ok(first.claimCount === 1, "首次领取 claim_count = 1");
  summary = await getPoolSummary(examId, blockId, teacherA, poolDb);
  ok(summary.inPoolCount === 2, "A 领取后池中可领 = 2");
  ok(summary.claimedCount === 1 && summary.myClaimedCount === 1, "已领 = 1 且 A 已领 = 1");

  // 3. 教师 B 领卷 → 互斥
  const second = await claimNextPaper(examId, blockId, teacherB, poolDb);
  ok(second.id !== first.id, "B 领取到不同试卷");
  ok(second.claimedBy === teacherB, "B 领取后 claimedBy = B");
  summary = await getPoolSummary(examId, blockId, teacherA, poolDb);
  ok(summary.inPoolCount === 1 && summary.claimedCount === 2, "两人各持一份,池中剩 1");

  // 4. 指定领取冲突
  await expectError(
    "B 指定领取 A 已领试卷 → 冲突",
    () => claimSpecificPaper(examId, blockId, first.id, teacherB, poolDb),
    "已被其他教师领取"
  );

  // 5. 领取人本人释放
  await releasePaper(examId, blockId, first.id, teacherA, poolDb);
  summary = await getPoolSummary(examId, blockId, teacherA, poolDb);
  ok(summary.inPoolCount === 2 && summary.claimedCount === 1, "A 释放后回池:池中 2,已领 1");

  // 6. 强制释放(管理员/年级组长)
  await releasePaper(examId, blockId, second.id, teacherA, poolDb, { force: true });
  summary = await getPoolSummary(examId, blockId, teacherA, poolDb);
  ok(summary.inPoolCount === 3 && summary.claimedCount === 0, "强制释放后全部回池");

  // 7. claim_count 累计
  const reClaim = await claimNextPaper(examId, blockId, teacherA, poolDb);
  ok(reClaim.claimCount === 2, "同卷再次领取 claim_count = 2");
  await releasePaper(examId, blockId, reClaim.id, teacherA, poolDb);

  // 8. 已阅卷不可领取 + 池空
  await expectError(
    "指定领取 reviewed 试卷 → 拒绝",
    () => claimSpecificPaper(examId, blockId, cropIds[3], teacherA, poolDb),
    "当前不可领取"
  );

  // 把剩余 3 份全部领走
  for (let i = 0; i < 3; i++) {
    await claimNextPaper(examId, blockId, teacherA, poolDb);
  }
  await expectError(
    "池空后领卷 → 报错",
    () => claimNextPaper(examId, blockId, teacherA, poolDb),
    "暂无可用试卷"
  );

  // 9. 条目查询
  const myEntries = await getPoolEntries(examId, blockId, { claimedBy: teacherA }, poolDb);
  ok(myEntries.length === 3 && myEntries.every((e) => e.claimedBy === teacherA), "getPoolEntries 按领取人过滤");

  // 10. 提交归属校验:非领取人提交他人已领卷 → 拒绝
  const claimed = myEntries[0];
  await expectError(
    "教师 B 提交 A 已领取的试卷 → 拒绝",
    () => submitReviewCropScores({
      examId,
      cropId: claimed.id,
      scores: [{ questionNumber: 1, scoreType: "subjective", score: 10 }],
      userId: teacherB
    }, poolDb),
    "已被其他教师领取"
  );

  // 11. 领取人本人提交不被归属校验拦截（会继续走到后续校验,应报题块不存在等业务错误,而非归属错误）
  try {
    await submitReviewCropScores({
      examId,
      cropId: claimed.id,
      scores: [{ questionNumber: 1, scoreType: "subjective", score: 10 }],
      userId: teacherA
    }, poolDb);
    ok(false, "A 提交走业务校验（不应通过）");
  } catch (err: any) {
    const msg = err instanceof Error ? err.message : String(err);
    ok(!msg.includes("已被其他教师领取") && err instanceof ReviewValidationError === false, `A 提交未被归属拦截（业务错误: ${msg.slice(0, 40)}）`);
  }

  closeDatabase();
  rmSync(tmpDir, { recursive: true, force: true });

  if (failed > 0) {
    console.error(`\nreview-pool-smoke: ${failed} 失败`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`\nreview-pool-smoke ok (${passed} 断言)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
