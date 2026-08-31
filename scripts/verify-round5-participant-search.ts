/**
 * 五轮测试 B2：应考名单搜索（教师可用）+ 快照防悬空引用。
 * 用法：npx tsx scripts/verify-round5-participant-search.ts（期望全绿，退出码 0）
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmpDir = mkdtempSync(path.join(tmpdir(), "projectx-round5-part-"));
process.env.PROJECTX_DB_PATH = path.join(tmpDir, "round5-part.db");
delete process.env.PROJECTX_MARIADB_HOST;
delete process.env.PROJECTX_MYSQL_HOST;

import { getMysqlDb } from "../src/server/db";
import { searchStudentsForExam, ensureExamParticipants, listParticipants } from "../src/server/services/examParticipants";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(cond: boolean, label: string): void {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { failed++; failures.push(label); console.log(`  \x1b[31m✗\x1b[0m ${label}`); }
}
function section(title: string): void { console.log(`\n\x1b[36m== ${title} ==\x1b[0m`); }

async function main(): Promise<void> {
  const db = getMysqlDb();
  await db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, student_number TEXT, role_id INTEGER, is_active INTEGER DEFAULT 1);
    CREATE TABLE exams (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, class_id INTEGER, grade_id INTEGER);
    CREATE TABLE classes (id INTEGER PRIMARY KEY, name TEXT, grade_id INTEGER);
    CREATE TABLE class_students (class_id INTEGER, student_id INTEGER);
    CREATE TABLE exam_participants (exam_id INTEGER, student_id INTEGER, source TEXT,
      PRIMARY KEY (exam_id, student_id));
  `);
  // 学生：在职 + 已停用 + 教师（不应命中）
  await db.run("INSERT INTO users (id, name, student_number, role_id, is_active) VALUES"
    + " (1, '赵可为', '24101', 3, 1), (2, '马梓源', '24102', 3, 1), (3, '王老师', 'T001', 2, 1), (4, '已停用', '24103', 3, 0)");

  section("searchStudentsForExam — 关键字命中在职学生、排除教师/停用");
  const r1 = await searchStudentsForExam(db, 1, "2410");
  ok(r1.length === 2, `按学号前缀命中 2 人（24101/24102）(实际 ${r1.length})`);
  ok(!r1.some((u) => u.name === "王老师"), "教师不在结果内");
  ok(!r1.some((u) => u.name === "已停用"), "停用学生不在结果内");
  const r2 = await searchStudentsForExam(db, 1, "梓源");
  ok(r2.length === 1 && r2[0].name === "马梓源", "按姓名命中");
  const r3 = await searchStudentsForExam(db, 1, "%%%");
  ok(r3.length === 0, "通配符 % 被转义，不命中全部");
  const r4 = await searchStudentsForExam(db, 1, "  ");
  ok(r4.length === 0, "空关键字返回空");

  section("快照防悬空引用 — 被删用户不进名册快照");
  await db.run("INSERT INTO classes (id, name, grade_id) VALUES (1, '一班', NULL)");
  await db.run("INSERT INTO class_students (class_id, student_id) VALUES (1, 1), (1, 2), (1, 999)");
  await db.run("INSERT INTO exams (id, name, class_id, grade_id) VALUES (1, '数学', 1, NULL)");
  const snap = await ensureExamParticipants(db, 1);
  ok(snap.participantCount === 2, `名册快照只含存在用户（2，悬空 999 被剔除）(实际 ${snap.participantCount})`);
  const listed = await listParticipants(db, 1);
  ok(listed.length === 2 && listed[0].name === "赵可为", "listParticipants 与总数一致");

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) { console.error("失败项:\n" + failures.map((f) => "  - " + f).join("\n")); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });