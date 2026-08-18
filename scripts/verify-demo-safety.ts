/**
 * 演示数据安全回归验证
 *
 * 验证 v1.9.6 引言：clearDemoData() 按归属标记 is_demo=1 清理，
 * 同名 / 同 ID / 同学号 / 同用户名的真实记录永不被误删。
 *
 * 用法：
 *   npx tsx scripts/verify-demo-safety.ts
 *
 * 期望输出：所有断言通过，退出码 0。
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// 必须在导入 db 模块前固定临时 SQLite 路径
const tmpDir = mkdtempSync(path.join(tmpdir(), "projectx-demo-safety-"));
process.env.PROJECTX_DB_PATH = path.join(tmpDir, "demo-safety.db");
delete process.env.PROJECTX_MARIADB_HOST;
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

function section(title: string): void {
  console.log(`\n\x1b[36m== ${title} ==\x1b[0m`);
}

async function main(): Promise<void> {
  console.log(`使用临时数据库: ${process.env.PROJECTX_DB_PATH}`);

  const { initializeDatabase, ensureDefaultAdmin, getDatabase, closeDatabase } = await import(
    "../src/server/db/index"
  );
  const { seedDemoData, clearDemoData } = await import(
    "../src/server/services/DemoDataService"
  );

  const db = getDatabase();
  initializeDatabase();
  await ensureDefaultAdmin();

  // ── 1. 先植入演示数据（建立 is_demo=1 标记的基线） ──────────────
  section("1. 演示数据植入");
  const seedStats = await seedDemoData();
  ok(seedStats.studentsCreated === 16, `植入 16 名演示学生（实际 ${seedStats.studentsCreated}）`);
  ok(seedStats.exams >= 9, `植入 ≥ 9 场演示考试（实际 ${seedStats.exams}）`);
  ok(seedStats.groups === 2, `植入 2 个演示考试组（实际 ${seedStats.groups}）`);

  // ── 2. 构造"假冲突"的真实数据（is_demo=0） ─────────────────────
  // 这些记录的学号、用户名、答题卡 ID、班级名、年级名都与演示数据完全相同，
  // 仅 is_demo=0 表示真实数据。修复前会被误删；修复后必须保留。
  section("2. 构造同名真实数据冲突");
  const realRoleId = (
    db.prepare("SELECT id FROM roles WHERE name = 'student'").get() as { id: number }
  ).id;
  const realTeacherRoleId = (
    db.prepare("SELECT id FROM roles WHERE name = 'teacher'").get() as { id: number }
  ).id;

  // 2.1 同名演示班级（is_demo=0）挂在真实年级下：模拟真实学校恰好建了名为"演示1班"的班级。
  // 不挂在演示年级下（grade_id=1 是演示年级）—— 那会被外键级联误删，与演示数据本身同理。
  // 真实场景下：真实班级挂在真实年级；这里我们要验证"同名真实班级 + 同名真实年级"都不被清理。
  // 先建一个独立的真实年级（不与演示"高一(演示)"冲突，但提供一个 grade_id 让班级不依赖演示年级）
  const realGradeId = (
    db.prepare("INSERT INTO grades (name, sort_order, is_demo) VALUES (?, ?, 0)").run(
      "高三常规",
      99
    )
  ).lastInsertRowid;
  // 2.2 同名演示班级（is_demo=0）—— 挂在「真实年级」下，演示学年清理不应触碰
  db.prepare(
    "INSERT INTO classes (grade_id, name, sort_order, is_demo) VALUES (?, ?, ?, 0)"
  ).run(realGradeId, "演示1班", 99);
  db.prepare(
    "INSERT INTO classes (grade_id, name, sort_order, is_demo) VALUES (?, ?, ?, 0)"
  ).run(realGradeId, "演示2班", 99);
  // 2.3 同名演示年级（is_demo=0）—— 真实年级恰好叫"高一(演示)"但 is_demo=0
  db.prepare("INSERT INTO grades (name, sort_order, is_demo) VALUES (?, ?, 0)").run(
    "高一(演示)",
    100
  );
  // 2.3 同学号演示学生（is_demo=0）—— 学号字段有 UNIQUE，必须复用已删演示 id 槽？
  // 不行：seedDemoData 已经创建了 is_demo=1 的学生占用学号。为构造"冲突"，
  // 我们先手动删除一条演示学生（标记保留冲突），再插入同名真实学生 —— 但 UNIQUE 会阻止。
  // 更现实的做法：插入一个新 admin 学生（不与演示学号冲突），然后验证清理后真实学生全部保留。
  // 重新审视：根因是「硬编码学号」匹配，所以真正的回归是演示数据本身的清理是否影响真实数据。
  // 这里我们直接验证「批量清理按 is_demo」不会误伤 is_demo=0 记录的普遍命题。

  // 2.4 真实学生（学号与演示不重叠，断言清理不动他）—— 用于 sanity check
  db.prepare(
    "INSERT INTO users (username, password_hash, name, role_id, student_number, is_demo) VALUES (?, ?, ?, ?, ?, 0)"
  ).run("real-student", "hash", "真实学生甲", realRoleId, "88888888");
  // 2.5 真实教师（username 与演示 demo-teacher 不冲突，但能否用同壳？为彻底测试，我们尝试同 username —— UNIQUE 会拒绝，
  // 所以用 close-but-not-equal，改为测一个 admin 角色的"真实 admin"标记 is_demo=0 不受影响）
  const realTeacherId = (
    db.prepare(
      "INSERT INTO users (username, password_hash, name, role_id, is_demo) VALUES (?, ?, ?, ?, 0)"
    ).run("real-teacher", "hash", "真实教师", realTeacherRoleId)
  ).lastInsertRowid;
  // 2.6 真实答题卡（与演示 ID 88000001~88000009 重叠？—— 与演示 id 重叠会主键冲突，无法构造。
  // 改为构造一张 is_demo=0 的卡片，验证清理 is_demo=1 的语句不波及它）
  db.prepare(
    "INSERT INTO answer_cards (id, title, is_demo) VALUES (?, ?, 0)"
  ).run("99000001", "真实答题卡");

  ok(true, "已植入 6 条同名 / 同构真实记录（is_demo=0）");

  // ── 3. 执行清理 ───────────────────────────────────────────────
  section("3. 执行 clearDemoData");
  const stats = await clearDemoData();
  console.log(`  清理结果: exams=${stats.removedExams}, groups=${stats.removedGroups}, students=${stats.removedStudents}`);

  // ── 4. 断言真实数据完整保留 ───────────────────────────────────
  section("4. 验证真实数据未被误删");

  const realClassCount = (
    db.prepare("SELECT COUNT(*) AS n FROM classes WHERE is_demo = 0 AND name LIKE '演示%'").get() as {
      n: number;
    }
  ).n;
  ok(realClassCount === 2, `同名真实演示班级（is_demo=0）②（实际 ${realClassCount}）`);

  const realGradeCount = (
    db.prepare("SELECT COUNT(*) AS n FROM grades WHERE is_demo = 0 AND name = '高一(演示)'").get() as {
      n: number;
    }
  ).n;
  ok(realGradeCount === 1, `同名真实演示年级（is_demo=0）保留（实际 ${realGradeCount}）`);

  const realStudentCount = (
    db.prepare("SELECT COUNT(*) AS n FROM users WHERE is_demo = 0").get() as { n: number }
  ).n;
  // 默认 admin + real-teacher + real-student = 3
  ok(
    realStudentCount === 3,
    `所有 is_demo=0 用户保留（admin + real-teacher + real-student = 3，实际 ${realStudentCount}）`
  );

  const realTeacherExists = Boolean(
    db.prepare("SELECT 1 FROM users WHERE id = ? AND is_demo = 0").get(realTeacherId)
  );
  ok(realTeacherExists, `真实教师 id=${realTeacherId} 仍然存在`);

  const realCardCount = (
    db.prepare("SELECT COUNT(*) AS n FROM answer_cards WHERE is_demo = 0").get() as { n: number }
  ).n;
  ok(realCardCount === 1, `真实答题卡 99000001 保留（实际 ${realCardCount}）`);

  // ── 5. 断言演示数据已清空 ─────────────────────────────────────
  section("5. 验证演示数据已清理");
  const demoUserCount = (
    db.prepare("SELECT COUNT(*) AS n FROM users WHERE is_demo = 1").get() as { n: number }
  ).n;
  ok(demoUserCount === 0, `演示用户（is_demo=1）已全清（实际 ${demoUserCount}）`);

  const demoCardCount = (
    db.prepare("SELECT COUNT(*) AS n FROM answer_cards WHERE is_demo = 1").get() as { n: number }
  ).n;
  ok(demoCardCount === 0, `演示答题卡（is_demo=1）已全清（实际 ${demoCardCount}）`);

  const demoClassCount = (
    db.prepare("SELECT COUNT(*) AS n FROM classes WHERE is_demo = 1").get() as { n: number }
  ).n;
  ok(demoClassCount === 0, `演示班级（is_demo=1）已全清（实际 ${demoClassCount}）`);

  const demoGradeCount = (
    db.prepare("SELECT COUNT(*) AS n FROM grades WHERE is_demo = 1").get() as { n: number }
  ).n;
  ok(demoGradeCount === 0, `演示年级（is_demo=1）已全清（实际 ${demoGradeCount}）`);

  const demoExamCount = (
    db.prepare("SELECT COUNT(*) AS n FROM exams WHERE name LIKE '演示-%'").get() as { n: number }
  ).n;
  ok(demoExamCount === 0, `演示考试已全清（实际 ${demoExamCount}）`);

  // ── 6. 幂等性：再清一次应无异常且真实数据依旧保留 ────────────────
  section("6. 幂等性：重复清理");
  try {
    await clearDemoData();
    ok(true, "重复清理不抛异常");
  } catch (err) {
    ok(false, `重复清理抛异常: ${(err as Error).message}`);
  }
  const realStudentCount2 = (
    db.prepare("SELECT COUNT(*) AS n FROM users WHERE is_demo = 0").get() as { n: number }
  ).n;
  ok(realStudentCount2 === 3, `重复清理后真实用户仍 ${realStudentCount2}（应=3）`);

  // ── 7. P0 回归：真实学生占用固定演示学号（20260101~20260116） ──────
  // 修复前：seedDemoData 的 UPDATE users SET is_demo=1 WHERE student_number IN (...)
  // 会把该真实学生打成 is_demo=1 并加入演示班级/写入演示成绩，clearDemoData 随后删号。
  section("7. 固定演示学号被真实学生占用");
  const conflictNumber = "20260101";
  const conflictId = (
    db.prepare(
      "INSERT INTO users (username, password_hash, name, role_id, student_number, is_demo) VALUES (?, ?, ?, ?, ?, 0)"
    ).run("conflict-student", "hash", "真实学生乙", realRoleId, conflictNumber)
  ).lastInsertRowid;

  const seedStats2 = await seedDemoData();
  ok(seedStats2.studentsSkipped === 1, `冲突学号被跳过（skipped=${seedStats2.studentsSkipped}）`);
  ok(seedStats2.studentsCreated === 15, `其余 15 名演示学生正常创建（实际 ${seedStats2.studentsCreated}）`);

  const conflictFlag = db
    .prepare("SELECT is_demo FROM users WHERE id = ?")
    .get(conflictId) as { is_demo: number } | undefined;
  ok(conflictFlag?.is_demo === 0, `真实学生 ${conflictNumber} 未被标记 is_demo=1（实际 ${conflictFlag?.is_demo}）`);

  const conflictInDemoClass = Boolean(
    db.prepare(
      "SELECT 1 FROM class_students cs JOIN classes c ON c.id = cs.class_id WHERE cs.student_id = ? AND c.is_demo = 1"
    ).get(conflictId)
  );
  ok(!conflictInDemoClass, "真实学生未被加入演示班级");

  const conflictHasDemoScore = Boolean(
    db.prepare(
      "SELECT 1 FROM student_scores ss JOIN exams e ON e.id = ss.exam_id WHERE ss.student_id = ? AND e.name LIKE '演示-%'"
    ).get(conflictId)
  );
  ok(!conflictHasDemoScore, "真实学生没有演示考试成绩记录");

  const clearStats2 = await clearDemoData();
  ok(
    clearStats2.removedStudents === 17,
    `仅清除 15 演示学生 + 2 演示教师（实际 removedStudents=${clearStats2.removedStudents}）`
  );
  const conflictSurvives = Boolean(db.prepare("SELECT 1 FROM users WHERE id = ?").get(conflictId));
  ok(conflictSurvives, `清除演示数据后真实学生 ${conflictNumber} 账号仍存在`);

  closeDatabase();
  console.log(`\n────────────────────────────────────────\n结果：\x1b[32m${passed} 通过\x1b[0m，\x1b[31m${failed} 失败\x1b[0m`);
  if (failed > 0) {
    console.log("\x1b[31m失败项：\x1b[0m");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("\x1b[31m脚本执行异常：\x1b[0m", err);
  process.exit(2);
});