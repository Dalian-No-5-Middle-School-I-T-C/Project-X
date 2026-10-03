/** Regression: multi-class students must occupy one grade-ladder position. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "px-ladder-"));
process.env.PROJECTX_DB_PATH = path.join(dir, "test.db");
for (const key of Object.keys(process.env)) {
  if (key.startsWith("PROJECTX_MARIADB_") || key.startsWith("PROJECTX_MYSQL_")) delete process.env[key];
}
const { initializeDatabase, getMysqlDb, closeDatabase } = await import("../src/server/db/index");
const { AnalysisRepository } = await import("../src/server/repositories/AnalysisRepository");
const { LadderService } = await import("../src/server/services/LadderService");

try {
  initializeDatabase();
  const db = getMysqlDb();
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
  const repo = new AnalysisRepository();
  const table = await repo.getScoreTableData(exam, undefined, "percentile");
  assert.equal(table.totalCount, 13);
  assert.equal(new Set(table.rows.map((r: any) => r.studentId)).size, 13);
  assert.deepEqual(table.rows.map((r: any) => r.gradeRank), [1,2,3,4,5,6,7,8,9,9,9,9,13]);
  assert.equal(table.rows[0].classId, c1);
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
  console.log("PASS: unique students, same-name identities, ties, my rank, percentile, full class membership, same-name classes, unassigned students, population statistics and the export path");
} finally {
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
}
