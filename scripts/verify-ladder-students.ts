/** Regression: multi-class students must occupy one grade-ladder position. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * 双方言回归（PR #308 评审 P1）。
 *
 * 排名/去重发生在 `AnalysisRepository.getScoreTableData` 与 `getExportData` 的
 * SQL 里（`LEFT JOIN class_students` + `ORDER BY ... c.id ASC`），而生产环境跑的是
 * MariaDB：SQLite 绿了并不代表线上绿。默认仍走一次性 SQLite 库，
 * `--mariadb` 则要求一个专用的空 MariaDB 库（CI 里由 `projectx_ladder_test` 提供），
 * 断言完全共用——差异本身就是我们要抓的缺陷。
 */
const maria = process.argv.includes("--mariadb");
const dir = maria ? null : mkdtempSync(path.join(tmpdir(), "px-ladder-"));
if (!maria) process.env.PROJECTX_DB_PATH = path.join(dir!, "test.db");
for (const key of Object.keys(process.env)) {
  if (key.startsWith("PROJECTX_MARIADB_") || key.startsWith("PROJECTX_MYSQL_")) {
    if (maria && key.startsWith("PROJECTX_MARIADB_")) continue;
    delete process.env[key];
  }
}
if (maria) {
  assert.equal(process.env.PROJECTX_MARIADB_DATABASE, "projectx_ladder_test",
    "MariaDB 变体只允许跑在一次性库 projectx_ladder_test 上（verify:mariadb 会复用 projectx_ci 的表）");
  assert.equal(process.env.PROJECTX_MARIADB_HOST, "127.0.0.1", "MariaDB 变体只连本机 CI 服务");
}

const { initializeDatabase, closeDatabase } = await import("../src/server/db/index");
const { getMysqlDb, initMariadbSchema, resetAdapter } = await import("../src/server/db/mysql");
if (!maria) initializeDatabase();
const db = getMysqlDb();
if (maria) {
  const tables = await db.all<{ n: number }>(
    "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE()");
  assert.equal(Number(tables[0]?.n ?? 0), 0, "Use a new disposable database");
  await initMariadbSchema();
}
const { AnalysisRepository } = await import("../src/server/repositories/AnalysisRepository");
const { LadderService } = await import("../src/server/services/LadderService");

try {
  const grade = (await db.run("INSERT INTO grades (name) VALUES ('ladder-test')")).lastInsertRowid;
  const c1 = (await db.run("INSERT INTO classes (grade_id, name) VALUES (?, 'same-name')", grade)).lastInsertRowid;
  const c2 = (await db.run("INSERT INTO classes (grade_id, name) VALUES (?, 'same-name')", grade)).lastInsertRowid;
  const exam = (await db.run("INSERT INTO exams (name, subject, status) VALUES ('ladder-test', 'ladder-test', 'closed')")).lastInsertRowid;
  const scores = [100, 95, 90, 85, 80, 75, 70, 65, 60, 60, 60, 60, 40];
  const ids: number[] = [];
  for (let i = 0; i < scores.length; i++) {
    const id = (await db.run("INSERT INTO users (username, password_hash, role_id, student_number, name) VALUES (?, 'test', 3, ?, '同名学生')", `ladder-${i}`, `L${i}`)).lastInsertRowid;
    ids.push(id);
    if (i !== 1 && i !== 12) await db.run("INSERT INTO class_students (class_id, student_id) VALUES (?, ?)", c1, id);
    if ([0, 1, 8].includes(i)) await db.run("INSERT INTO class_students (class_id, student_id) VALUES (?, ?)", c2, id);
    await db.run("INSERT INTO student_scores (exam_id, student_id, total_score, objective_score, subjective_score) VALUES (?, ?, ?, ?, 0)", exam, id, scores[i], scores[i]);
  }
  // 夹具自检：多班必须在 MariaDB 下同样落成两行关联，否则这套断言会在
  // 「没有多班残留」的空场景里假绿。L0/L8 各 2 行，L1 只挂在 c2（1 行）= 5 行。
  assert.equal((await db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM class_students WHERE student_id IN (?, ?, ?)", ids[0], ids[1], ids[8]))?.n, 5);

  const repo = new AnalysisRepository();
  const table = await repo.getScoreTableData(exam, undefined, "percentile");
  assert.equal(table.totalCount, 13);
  assert.equal(new Set(table.rows.map((r: any) => r.studentId)).size, 13);
  assert.deepEqual(table.rows.map((r: any) => r.gradeRank), [1,2,3,4,5,6,7,8,9,9,9,9,13]);
  // 展示班级 = DISPLAY_CLASS_ORDER（在读优先，再 joined_at 最新、class_id 最大）：
  // L0 同时挂在 c1/c2，joined_at 同刻，展示班取 id 更大的 c2（与「当前班级」口径一致）。
  assert.equal(table.rows[0].classId, c2);
  const board = LadderService.fromScoreTableRows(table.rows, table.totalCount, ids[8]);
  assert.equal(board.board.length, 12, "cutoff includes every tied student");
  assert.equal(board.myRank, 9);
  assert.equal(board.myScore, 60);
  assert.equal(board.board.filter(r => r.isCurrentUser).length, 1);
  assert.equal(board.board.find(r => r.studentId === ids[8])!.percentile, 33.33);
  const second = await repo.getScoreTableData(exam, c2);
  assert.deepEqual(second.rows.map((r: any) => r.studentId), [ids[0], ids[1], ids[8]]);
  assert.deepEqual(second.rows.map((r: any) => r.classRank), [1,2,3]);
  assert.deepEqual(second.rows.map((r: any) => r.gradeRank), [1,2,9]);
  assert.equal((await repo.getScoreTableData(exam, c1)).rows.find((r: any) => r.studentId === ids[8]).classRank, 8);
  assert.deepEqual((await repo.getScoreTableData(exam, 0)).rows.map((r: any) => r.studentId), [ids[12]]);
  const z = await repo.getScoreTableData(exam, undefined, "zscore");
  const mean = scores.reduce((a,b) => a+b,0) / scores.length;
  const std = Math.sqrt(scores.reduce((a,b) => a+(b-mean)**2,0)/scores.length);
  assert.equal(z.rows[0].displayValue, Math.round((100-mean)/std*100)/100);
  // 导出模板走的是另一条 SQL（getExportData），必须与成绩表同口径，否则教师导出的表
  // 会出现「多班学生占两行、同名两班共用一套班排」——界面看着对、导出的文件不对。
  const exported = await repo.getExportData(exam);
  assert.equal(exported.students.length, 13, "export must not duplicate multi-class students");
  assert.deepEqual(exported.students.map((r: any) => r.gradeRank), [1,2,3,4,5,6,7,8,9,9,9,9,13]);
  const exportedC2 = await repo.getExportData(exam, c2);
  assert.deepEqual(exportedC2.students.map((r: any) => r.studentNumber), ["L0","L1","L8"]);
  assert.deepEqual(exportedC2.students.map((r: any) => r.classRank), [1,2,3], "same-name classes must not share one classRank pool");
  assert.equal((await repo.getExportData(exam, c1)).students.find((r: any) => r.studentNumber === "L8")!.classRank, 8);
  assert.deepEqual((await repo.getExportData(exam, 0)).students.map((r: any) => r.studentNumber), ["L12"]);
  // ── 评审 P2（#304/#305/#308 复核）：展示班级不得选中归档旧班 ──
  // 转入新班的学生，归档旧班关联仍刻意保留（verify-class-archive 断言）；纯 c.id ASC 去重
  // 会命中 id 更小的归档旧班，未筛选成绩表/导出显示旧班与其班排。这里把旧班造成**更大的
  // class_id 且 joined_at 与新班同刻**——只有「在读优先」这一排序键能救回来。
  const moverExam = (await db.run("INSERT INTO exams (name, subject, status) VALUES ('mover-exam', 'mover', 'closed')")).lastInsertRowid;
  const newCls = (await db.run("INSERT INTO classes (grade_id, name) VALUES (?, 'new-class')", grade)).lastInsertRowid;
  const oldCls = (await db.run("INSERT INTO classes (grade_id, name) VALUES (?, 'old-class')", grade)).lastInsertRowid;
  const mover = (await db.run("INSERT INTO users (username, password_hash, role_id, student_number, name) VALUES ('ladder-mover', 'test', 3, 'LM', '转班学生')")).lastInsertRowid;
  // 新班两个陪跑（80/60），转班学生 70 分在新班班排 2；旧班只剩他一人（班排 1），
  // 若展示班选了旧班，classRank 会从 2 变 1，直接暴露选错班。
  await db.run("INSERT INTO class_students (class_id, student_id, joined_at) VALUES (?, ?, '2020-01-01 00:00:00')", newCls, mover);
  await db.run("INSERT INTO class_students (class_id, student_id, joined_at) VALUES (?, ?, '2020-01-01 00:00:00')", oldCls, mover);
  for (const [i, score] of [80, 70, 60].entries()) {
    const mate = i === 1 ? mover
      : (await db.run("INSERT INTO users (username, password_hash, role_id, student_number, name) VALUES (?, 'test', 3, ?, '新班同学')", `ladder-mate-${i}`, `LM${i}`)).lastInsertRowid;
    if (i !== 1) await db.run("INSERT INTO class_students (class_id, student_id, joined_at) VALUES (?, ?, '2020-01-01 00:00:00')", newCls, mate);
    await db.run("INSERT INTO student_scores (exam_id, student_id, total_score, objective_score, subjective_score) VALUES (?, ?, ?, ?, 0)", moverExam, mate, score, score);
  }
  await db.run("UPDATE classes SET archived_at = '2020-02-01 00:00:00' WHERE id = ?", oldCls);
  const moverTable = await repo.getScoreTableData(moverExam);
  assert.equal(moverTable.totalCount, 3);
  const moverRow = moverTable.rows.find((r: any) => r.studentId === mover);
  assert.equal(moverRow.classId, newCls, "在读班级优先于（id 更大的）归档旧班");
  assert.equal(moverRow.className, "new-class");
  assert.equal(moverRow.classRank, 2, "班排取展示班（新班完整成员）的排名");
  assert.equal(moverRow.gradeRank, 2);
  const moverExport = await repo.getExportData(moverExam);
  assert.equal(moverExport.students.length, 3);
  assert.equal(moverExport.students.find((r: any) => r.name === "转班学生").className, "new-class");
  assert.equal(moverExport.students.find((r: any) => r.name === "转班学生").classRank, 2);
  // 全部关联已归档的学生（毕业班级）：回落到最新归档归属，仍显示历史班级而非「未知班级」。
  const onlyOld = (await db.run("INSERT INTO users (username, password_hash, role_id, student_number, name) VALUES ('ladder-only-old', 'test', 3, 'LO', '旧班独存')")).lastInsertRowid;
  await db.run("INSERT INTO class_students (class_id, student_id, joined_at) VALUES (?, ?, '2020-01-01 00:00:00')", oldCls, onlyOld);
  await db.run("INSERT INTO student_scores (exam_id, student_id, total_score, objective_score, subjective_score) VALUES (?, ?, 55, 55, 0)", moverExam, onlyOld);
  const onlyOldRow = (await repo.getScoreTableData(moverExam)).rows.find((r: any) => r.studentId === onlyOld);
  assert.equal(onlyOldRow.classId, oldCls, "全部关联归档时保留最新归档归属作为展示班");
  console.log("PASS: archived old class never wins the display class while an active class exists");
  console.log("PASS: unique students, same-name identities, ties, my rank, percentile, full class membership, same-name classes, unassigned students, population statistics and the export path");
  console.log(`ALL PASS (${db.dialect})`);
} finally {
  resetAdapter();
  if (!maria) { closeDatabase(); rmSync(dir!, { recursive: true, force: true }); }
}
