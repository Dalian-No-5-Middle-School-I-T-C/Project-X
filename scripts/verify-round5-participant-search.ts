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
import {
  clearExplicitParticipants,
  ensureExamParticipants,
  isExamParticipant,
  listMissingParticipants,
  listParticipants,
  searchStudentsForExam,
  setExplicitParticipants,
} from "../src/server/services/examParticipants";

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
    CREATE TABLE student_scores (exam_id INTEGER, student_id INTEGER,
      PRIMARY KEY (exam_id, student_id));
  `);
  // 学生：在职 + 已停用 + 教师（不应命中）
  await db.run("INSERT INTO users (id, name, student_number, role_id, is_active) VALUES"
    + " (1, '赵可为', '24101', 3, 1), (2, '马梓源', '24102', 3, 1), (3, '王老师', 'T001', 2, 1), (4, '已停用', '24103', 3, 0), (5, '陈新同学', '24105', 3, 1)");

  section("searchStudentsForExam — 关键字命中在职学生、排除教师/停用");
  const r1 = await searchStudentsForExam(db, 1, "2410");
  ok(r1.length === 3, `按学号前缀命中 3 人（24101/24102/24105）(实际 ${r1.length})`);
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

  section("显式名单整体替换 — roster A/B 改为 explicit B/C");
  const explicitCount = await setExplicitParticipants(db, 1, [2, 5]);
  ok(explicitCount === 2, `写入 2 名显式参与者（实际 ${explicitCount}）`);
  const explicitSnap = await ensureExamParticipants(db, 1);
  ok(explicitSnap.source === "explicit" && explicitSnap.participantCount === 2,
    `显式快照规模为 2（实际 ${JSON.stringify(explicitSnap)}）`);
  const explicitList = await listParticipants(db, 1);
  ok(explicitList.map((r) => r.student_id).join(",") === "2,5" && explicitList.every((r) => r.source === "explicit"),
    `有效名单精确为 B/C，且来源均为 explicit（实际 ${explicitList.map((r) => `${r.student_id}:${r.source}`).join(",")}）`);
  ok(!(await isExamParticipant(db, 1, 1)), "已从显式名单移除的 A 被入库门控拒绝");
  ok(await isExamParticipant(db, 1, 2), "显式名单中的 B 被入库门控接受");
  ok(await isExamParticipant(db, 1, 5), "显式名单中的 C 被入库门控接受");

  await db.run("INSERT INTO student_scores (exam_id, student_id) VALUES (1, 2)");
  const missing = await listMissingParticipants(db, 1);
  ok(missing.length === 1 && missing[0].student_id === 5,
    `发布完整性只要求显式名单，缺失项仅为 C（实际 ${missing.map((r) => r.student_id).join(",")}）`);

  section("清除显式名单 — 回落并重新冻结班级 roster");
  await clearExplicitParticipants(db, 1);
  const fallbackSnap = await ensureExamParticipants(db, 1);
  const fallbackList = await listParticipants(db, 1);
  ok(fallbackSnap.source === "roster" && fallbackSnap.participantCount === 2,
    `回落 roster 规模为 2（实际 ${JSON.stringify(fallbackSnap)}）`);
  ok(fallbackList.map((r) => r.student_id).join(",") === "1,2", "回落名单恢复为 A/B");

  section("历史混合数据兼容 — explicit 存在时忽略残留 roster");
  await db.run("UPDATE exam_participants SET source = 'explicit' WHERE exam_id = 1 AND student_id = 2");
  await db.run("INSERT INTO exam_participants (exam_id, student_id, source) VALUES (1, 5, 'explicit')");
  const mixedList = await listParticipants(db, 1);
  ok(mixedList.map((r) => r.student_id).join(",") === "2,5",
    `历史混合行只暴露 explicit B/C（实际 ${mixedList.map((r) => r.student_id).join(",")}）`);
  ok(!(await isExamParticipant(db, 1, 1)), "历史残留 roster A 不再绕过入库门控");

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) { console.error("失败项:\n" + failures.map((f) => "  - " + f).join("\n")); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
