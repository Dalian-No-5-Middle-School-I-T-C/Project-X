/**
 * 回归测试：逐题下钻 getQuestionStudentScores 的 classId 过滤
 * 覆盖 Codex 在 PR #206 评审中指出的「class_students 别名 cs 重复 → SQLite/MySQL 报 500」bug。
 *
 * 历史背景：getQuestionStudentScores 在 question_scores 上先 LEFT JOIN class_students cs（显示班级名），
 * 又插入 classFilterQs(classId) 返回的 JOIN class_students cs（按班级过滤）——同名别名 cs 重复，
 * 一旦传入正 classId 即触发 "duplicate alias" / "no such column" 500。
 * 修复：显示班级名改用标量子查询（别名 cs2/cl，LIMIT 1 避免多班级学生重复行），主查询仅保留过滤用 cs。
 *
 * 运行：npx tsx scripts/bugfix-question-students-alias.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmpDir = mkdtempSync(path.join(tmpdir(), "px-qs-alias-"));
process.env.PROJECTX_DB_PATH = path.join(tmpDir, "t.db");
delete process.env.PROJECTX_MARIADB_HOST;
delete process.env.PROJECTX_MARIADB_PORT;
delete process.env.PROJECTX_MARIADB_USER;
delete process.env.PROJECTX_MARIADB_PASSWORD;
delete process.env.PROJECTX_MARIADB_DATABASE;
delete process.env.PROJECTX_MYSQL_HOST;

const { initializeDatabase, getDatabase } = await import("../src/server/db/index");
const { AnalysisRepository } = await import("../src/server/repositories/AnalysisRepository");

let pass = 0, fail = 0;
function ok(cond: boolean, label: string, info?: unknown) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + label); }
  else { fail++; console.log("  \x1b[31m✗\x1b[0m " + label, info ?? ""); }
}

initializeDatabase();
const db = getDatabase();

// 年级 + 班级
const grade = db.prepare("INSERT INTO grades (name) VALUES (?)").run("高三").lastInsertRowid as number;
const c1 = db.prepare("INSERT INTO classes (grade_id, name) VALUES (?, ?)").run(grade, "1班").lastInsertRowid as number;
const c2 = db.prepare("INSERT INTO classes (grade_id, name) VALUES (?, ?)").run(grade, "2班").lastInsertRowid as number;

// 学生
const insU = db.prepare("INSERT INTO users (username, password_hash, role_id, student_number, name) VALUES (?, ?, 3, ?, ?)");
const s1 = insU.run("qs1", "x", "Q1", "一").lastInsertRowid as number;
const s2 = insU.run("qs2", "x", "Q2", "二").lastInsertRowid as number;
const s3 = insU.run("qs3", "x", "Q3", "三").lastInsertRowid as number;
const s4 = insU.run("qs4", "x", "Q4", "四(双班)").lastInsertRowid as number; // 同时入 C1 与 C2
const s5 = insU.run("qs5", "x", "Q5", "五(无班级)").lastInsertRowid as number;

// 编班：s1,s2,s4 → C1；s3,s4 → C2；s5 不编班
const enr = db.prepare("INSERT INTO class_students (class_id, student_id) VALUES (?, ?)");
enr.run(c1, s1); enr.run(c1, s2); enr.run(c1, s4);
enr.run(c2, s3); enr.run(c2, s4);

// 考试 + 第 1 题成绩（5 人都有分）
const e1 = db.prepare("INSERT INTO exams (name, subject, status) VALUES (?, ?, 'closed')").run("QS-数学", "数学").lastInsertRowid as number;
const insQ = db.prepare("INSERT INTO question_scores (exam_id, student_id, question_number, score_type, score, max_score) VALUES (?, ?, 1, 'objective', ?, 10)");
insQ.run(e1, s1, 8); insQ.run(e1, s2, 5); insQ.run(e1, s3, 9); insQ.run(e1, s4, 7); insQ.run(e1, s5, 6);

const repo = new AnalysisRepository();

console.log("\n== getQuestionStudentScores: classId 过滤 / 别名冲突回归 ==");

// 1) 无 classId：5 行，无异常，无重复 student_id
let all: any[] = [];
let threw = false;
try { all = await repo.getQuestionStudentScores(e1, 1, undefined); } catch (e) { threw = true; console.log(e); }
ok(!threw, "无 classId 不抛异常", threw);
ok(all.length === 5, "无 classId → 5 行（全部考生）", { n: all.length });
ok(new Set(all.map((r) => r.studentId)).size === 5, "无 classId → 无重复 student_id", all.map((r) => r.studentId));

// 2) 正 classId = C1：s1,s2,s4（3 行），s4 虽双班但只出现一次，无别名冲突 500
let c1rows: any[] = [];
try { c1rows = await repo.getQuestionStudentScores(e1, 1, c1); } catch (e) { threw = true; console.log(e); }
ok(!threw, "classId=C1 不抛异常（修复前 cs 别名重复 → 500）", threw);
ok(c1rows.length === 3, "classId=C1 → 3 行（s1/s2/s4）", { n: c1rows.length, ids: c1rows.map((r) => r.studentId) });
ok(new Set(c1rows.map((r) => r.studentId)).size === 3, "classId=C1 → s4 双班不重复", c1rows.map((r) => r.studentId));
ok(c1rows.every((r) => r.className != null), "classId=C1 → 每行有班级名", c1rows);

// 3) classId=0（无班级）：仅 s5（1 行）
let unknown: any[] = [];
try { unknown = await repo.getQuestionStudentScores(e1, 1, 0); } catch (e) { threw = true; console.log(e); }
ok(!threw, "classId=0 不抛异常", threw);
ok(unknown.length === 1 && unknown[0].studentId === s5, "classId=0 → 仅无班级学生 s5", { n: unknown.length, id: unknown[0]?.studentId });

// 4) 双班学生 s4 在无 classId 下也不应重复
ok(all.filter((r) => r.studentId === s4).length === 1, "无 classId → 双班 s4 仅 1 行", all.filter((r) => r.studentId === s4));

try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
console.log(`\n\x1b[36m结果：${pass} 通过，${fail} 失败\x1b[0m`);
if (fail > 0) process.exit(1);
