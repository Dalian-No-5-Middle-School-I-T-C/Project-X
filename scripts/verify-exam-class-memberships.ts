import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import XLSX from "xlsx";

const maria = process.argv.includes("--mariadb");
if (maria) {
  assert.equal(process.env.PROJECTX_MARIADB_DATABASE, "projectx_exam_classes_test");
  assert.equal(process.env.PROJECTX_MARIADB_HOST, "127.0.0.1");
} else {
  delete process.env.PROJECTX_MARIADB_HOST;
  delete process.env.PROJECTX_MYSQL_HOST;
  process.env.PROJECTX_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "exam-classes-")), "test.db");
}
const { initializeDatabase, closeDatabase, getDatabase } = await import("../src/server/db");
const { getMysqlDb, initMariadbSchema, resetAdapter } = await import("../src/server/db/mysql");
if (!maria) initializeDatabase();
const db = getMysqlDb();
if (maria) {
  assert.equal((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE()"))?.n, 0, "Use an empty disposable database");
  await initMariadbSchema();
}
const { ClassRepository } = await import("../src/server/repositories/ClassRepository");
const { ExamRepository } = await import("../src/server/repositories/ExamRepository");
const { AnalysisRepository } = await import("../src/server/repositories/AnalysisRepository");
const { ScoreRepository } = await import("../src/server/repositories/ScoreRepository");
const { UserRepository } = await import("../src/server/repositories/UserRepository");
const { ensureExamParticipants, setExplicitParticipants } = await import("../src/server/services/examParticipants");
const classes = new ClassRepository(db), analysis = new AnalysisRepository();
let serial = 0;
async function student(name: string): Promise<number> {
  const number = `H${++serial}`;
  return (await db.run("INSERT INTO users(username,password_hash,name,role_id,student_number) VALUES (?,'disabled',?,3,?)", number, name, number)).lastInsertRowid;
}
async function exam(name: string, classId: number | null = null, gradeId: number | null = null): Promise<number> {
  return (await db.run("INSERT INTO exams(name,subject,status,class_id,grade_id,score_published) VALUES (?,'数学','grading',?,?,1)", name, classId, gradeId)).lastInsertRowid;
}
async function score(examId: number, sid: number, value: number): Promise<void> {
  await db.transaction(async tx => {
    await new ExamRepository(tx).saveStudentScore(examId, sid, value, 0);
    await tx.run("INSERT INTO question_scores(exam_id,student_id,question_number,score,max_score,score_type,selected_options) VALUES (?,?,1,?,100,'objective','[\"A\"]')", examId, sid, value);
  });
}
async function group(exams: number[], full = false): Promise<number> {
  const id = (await db.run("INSERT INTO exam_groups(name,source,only_full_participants) VALUES ('history','manual',?)", full ? 1 : 0)).lastInsertRowid;
  for (const [order, examId] of exams.entries()) await db.run("INSERT INTO exam_group_members(group_id,exam_id,sort_order) VALUES (?,?,?)", id, examId, order);
  return id;
}
async function membership(examId: number, sid: number): Promise<number[]> {
  const rows = await db.all<{ class_id: number }>("SELECT class_id FROM exam_class_memberships WHERE exam_id = ? AND student_id = ? ORDER BY class_id", examId, sid);
  return rows.map(r => r.class_id);
}
try {
  const grade = await classes.createGrade("高一"), nextGrade = await classes.createGrade("高二");
  const old = await classes.createClass(grade.id, "原班"), selected = await classes.createClass(grade.id, "选科班");
  const promoted = await classes.createClass(nextGrade.id, "升年级班");
  const a = await student("多班A"), b = await student("原班B"), c = await student("选科班C");
  await classes.addStudent(old.id, a); await classes.addStudent(selected.id, a);
  await classes.addStudent(old.id, b); await classes.addStudent(selected.id, c);
  const e1 = await exam("多班数学"), e2 = await exam("多班第二科");
  for (const [sid, value] of [[a, 100], [b, 60], [c, 40]]) { await score(e1, sid, value); await score(e2, sid, value); }
  const one = await group([e1]), two = await group([e1, e2]);
  const small = await analysis.getScoreTableData(e1, old.id);
  assert.equal(small.totalCount, 2);
  const compare = await analysis.getGroupClassComparison(one);
  assert.deepEqual(compare.classes.find(r => r.classId === old.id)?.count, 2);
  assert.equal(compare.classes.find(r => r.classId === old.id)?.avgScore, 80);
  assert.equal(compare.subjectClassSummaries[0].byClass.find(r => r.classId === old.id)?.avgScore, 80);
  for (const gid of [one, two]) {
    const dist = await analysis.getGroupDistribution(gid, "class");
    assert.equal(dist.find(r => r.scopeId === String(old.id))?.sampleSize, 2);
    assert.equal(dist.find(r => r.scopeId === String(selected.id))?.sampleSize, 2);
    assert.equal((await analysis.getGroupDistribution(gid, "total"))[0].sampleSize, 3);
  }
  console.log("PASS: original multi-class omission fixed; one student per class across subjects; overall remains unique");

  await db.run("INSERT INTO answer_cards(id,title) VALUES ('90000001','知识点回归')");
  await db.run("UPDATE exams SET card_id = '90000001' WHERE id = ?", e1);
  await db.run("INSERT INTO knowledge_points(card_id,question_number,point_text) VALUES ('90000001',1,'函数')");
  async function assertKnowledgeClasses(): Promise<void> {
    const stats = await analysis.getClassKnowledgeStats(e1);
    assert.equal(stats.empty, false);
    assert.equal(stats.coverageRate, 100);
    assert.deepEqual(stats.classes.map(r => r.classId).sort((x, y) => x - y), [old.id, selected.id]);
    const point = stats.matrix.find(r => r.knowledgePoint === '函数');
    assert.equal(point?.byClass.find(r => r.classId === old.id)?.scoreRate, 80);
    assert.equal(point?.byClass.find(r => r.classId === selected.id)?.scoreRate, 70);
    assert.equal(point?.byClass.find(r => r.classId === old.id)?.questionCount, 1);
    const filtered = await analysis.getClassKnowledgeStats(e1, [old.id]);
    assert.deepEqual(filtered.classes.map(r => r.classId), [old.id]);
    assert.equal(filtered.matrix[0].byClass[0].scoreRate, 80);
  }
  await assertKnowledgeClasses();
  console.log("PASS: tagged knowledge statistics return class IDs, rates and filtered classes");

  // Existing pre-v59 scores have no snapshots. Upgrade cannot guess prior moves.
  await db.run("DROP TABLE exam_class_memberships");
  await db.run("DELETE FROM schema_migrations WHERE version = 59");
  if (maria) { await initMariadbSchema(); await initMariadbSchema(); }
  else { const { runMigrations } = await import("../src/server/db/migrations"); runMigrations(getDatabase()); runMigrations(getDatabase()); }
  assert.ok(await db.get("SELECT 1 FROM schema_migrations WHERE version = 59"));
  assert.equal((await analysis.getGroupClassComparison(one)).classes.find(r => r.classId === old.id)?.avgScore, 80);
  assert.deepEqual(await membership(e1, a), [], "Migration must not invent historical membership");
  console.log("PASS: populated pre-v59 upgrade, idempotence and legacy fallback");

  // Move a normal single-class student; #347 makes the move retroactive.
  const absent = await student("缺考学生"); await classes.addStudent(old.id, absent);
  const rosterExam = await exam("缺考后补录", old.id);
  const future = await exam("尚未开始的年级考试", null, grade.id);
  await db.run("UPDATE exams SET status = 'draft' WHERE id = ?", future);
  await classes.moveStudent(old.id, selected.id, b);
  await classes.moveStudent(old.id, selected.id, absent);
  assert.deepEqual(await membership(future, b), [], "Empty drafts must not freeze before the exam begins");
  await score(future, b, 70);
  assert.deepEqual(await membership(future, b), [selected.id]);
  assert.deepEqual(await membership(e1, b), [selected.id], "A move re-anchors every past exam to the new class");
  const movedStats = await analysis.getClassKnowledgeStats(e1);
  assert.equal(movedStats.matrix.find(r => r.knowledgePoint === '函数')?.byClass.find(r => r.classId === old.id)?.scoreRate, 100);
  assert.equal(Math.round((movedStats.matrix.find(r => r.knowledgePoint === '函数')?.byClass.find(r => r.classId === selected.id)?.scoreRate ?? 0) * 10) / 10, 66.7);
  assert.deepEqual(await membership(rosterExam, absent), [selected.id], "缺考名单里的学生调班后同样归到新班");
  assert.equal((await ensureExamParticipants(db, rosterExam)).participantCount, 3, "应考名单保持调班时的成员，不随回溯改写");
  await score(rosterExam, absent, 50);
  assert.equal((await analysis.getScoreTableData(rosterExam)).rows[0].classId, selected.id);
  assert.equal((await analysis.getExportData(e1, old.id)).students.some(r => r.studentNumber === "H2"), false);
  assert.equal((await analysis.getExportData(e1, selected.id)).students.some(r => r.studentNumber === "H2"), true);
  assert.equal((await analysis.getScoreSummary(e1, old.id))?.count, 1);
  assert.equal((await analysis.getScoreSummary(e1, selected.id))?.count, 3);
  assert.equal((await analysis.getScoreTableData(e1, selected.id)).rows.some((r: any) => r.studentId === b), true);
  assert.equal((await analysis.getQuestionStudentScores(e1, 1, selected.id)).find(r => r.studentId === b)?.className, selected.name);
  assert.equal((await analysis.getQuestionStudentScores(e1, 1, old.id)).find(r => r.studentId === b), undefined);
  assert.equal((await analysis.getWrongQuestionRows(e1, {classId: selected.id, threshold: 0.7})).find(r => r.studentId === b)?.className, selected.name);
  assert.equal((await analysis.getStudentTrend(b)).find(r => r.examId === e1)?.classAvg, 66.7);
  assert.equal((await new ScoreRepository().getStudentTrendData(b)).find(r => r.examId === e1)?.classAvg, 66.7);
  const afterMove = await exam("分班后数学", null, grade.id); await score(afterMove, b, 75);
  assert.deepEqual(await membership(afterMove, b), [selected.id]);
  await db.transaction(tx => new ExamRepository(tx).saveStudentScore(e1, b, 60, 0));
  assert.deepEqual(await membership(e1, b), [selected.id], "Regrading keeps the score in the class the student moved to");
  console.log("PASS: a move re-anchors historic tables, exports, filters, drilldown, trends and regrading");

  const mixed = await group([e1, afterMove]);
  assert.equal((await analysis.getGroupClassComparison(mixed)).classes.find(r => r.classId === old.id)?.count, 1);
  assert.equal((await analysis.getGroupClassComparison(mixed)).classes.find(r => r.classId === selected.id)?.count, 3);
  assert.equal((await analysis.getGroupDistribution(mixed, "class")).find(r => r.scopeId === String(old.id))?.sampleSize, 1);
  const full = await group([e1, afterMove], true);
  assert.equal((await analysis.getGroupParticipantIds(full)).size, 1);
  assert.deepEqual((await analysis.getGroupClassComparison(full)).classes.map(r => [r.classId, r.count]), [[selected.id, 1]]);
  console.log("PASS: groups spanning a move follow the re-anchored class; complete-participant gate remains intact");

  await classes.moveStudent(selected.id, promoted.id, b);
  await classes.deleteGrade(grade.id);
  const afterPromotion = await exam("高二数学", null, nextGrade.id); await score(afterPromotion, b, 80);
  assert.deepEqual(await membership(afterPromotion, b), [promoted.id]);
  assert.equal((await analysis.getScoreTableData(e1)).rows.find((r: any) => r.studentId === b)?.classId, promoted.id, "跨年级调班同样回溯到现班");
  assert.equal((await analysis.getScoreTableData(afterMove)).rows[0].classId, promoted.id);
  assert.equal((await analysis.getStudentTrend(b)).find(r => r.examId === e1)?.classAvg, 60);
  console.log("PASS: grade promotion and archival move the student's whole history to the current class");

  const unknown = await student("原无班级"), unknownExam = await exam("无班级考试"); await score(unknownExam, unknown, 30);
  assert.deepEqual(await membership(unknownExam, unknown), [0]);
  assert.equal((await analysis.getScoreTableData(unknownExam, 0)).totalCount, 1);
  await classes.addStudent(promoted.id, unknown);
  assert.deepEqual(await membership(unknownExam, unknown), [promoted.id], "补上班级后，此前记为未知班级的考试改按该班统计");
  assert.equal((await analysis.getScoreTableData(unknownExam, 0)).totalCount, 0);
  assert.equal((await analysis.getScoreSummary(unknownExam, promoted.id))?.count, 1);
  assert.equal((await analysis.getGroupClassComparison(await group([unknownExam]))).classes[0].classId, promoted.id);
  console.log("PASS: assigning a class relabels an unknown historic class");

  const imported = await student("重导入"), importExam = await exam("导入前考试");
  await classes.addStudent(promoted.id, imported);
  await db.run("INSERT INTO student_scores(exam_id,student_id,total_score) VALUES (?,?,25)", importExam, imported);
  const other = await classes.createClass(nextGrade.id, "补充班");
  const result = await new UserRepository().batchImportFromCsv([["年级", "班级", "学号", "姓名"], ["高二", other.name, `H${serial}`, "重导入"]]);
  assert.deepEqual(result.students.errors, []);
  assert.deepEqual(await membership(importExam, imported), [promoted.id, other.id].sort((x, y) => x - y), "CSV 重导入是增量：多班在读的学生历次考试在两个班各计一次");
  await classes.removeStudent(promoted.id, imported);
  assert.deepEqual(await membership(importExam, imported), [other.id]);
  assert.equal((await analysis.getScoreTableData(importExam)).rows[0].classId, other.id);
  console.log("PASS: CSV additions and withdrawal follow the current class links");

  // Archive-first then new-grade import: the retired class must not keep the student.
  const g3 = await classes.createGrade("毕业测试"), archived = await classes.createClass(g3.id, "旧班");
  const staying = await classes.createClass(g3.id, "新班"), transferred = await student("先归档再加入");
  await classes.addStudent(archived.id, transferred); const oldExam = await exam("归档前", null, g3.id);
  await db.run("INSERT INTO student_scores(exam_id,student_id,total_score) VALUES (?,?,70)", oldExam, transferred);
  await classes.deleteClass(archived.id);
  assert.deepEqual(await membership(oldExam, transferred), [archived.id], "全部关联被归档时保持原归属，不改写成未知班级");
  await classes.addStudent(staying.id, transferred);
  const newExam = await exam("归档后", null, g3.id); await score(newExam, transferred, 80);
  assert.deepEqual(await membership(oldExam, transferred), [staying.id], "加入新班后历次考试改按新班统计");
  assert.deepEqual(await membership(newExam, transferred), [staying.id]);
  await setExplicitParticipants(db, oldExam, [transferred]);
  assert.deepEqual(await membership(oldExam, transferred), [staying.id], "名单编辑不再改动班级归属");
  console.log("PASS: archived links are replaced by the new class; roster edits follow the move rule");

  // Exercise actual routes with an injected administrator identity. This tests
  // history consumers; authentication/authorization is covered by verify:auth
  // and verify:security-critical, which run with real tokens.
  process.env.PROJECTX_AUTH_ENFORCE = "0";
  const { default: groupRouter } = await import("../src/server/routes/exam-groups-analysis");
  const { default: ladderRouter } = await import("../src/server/routes/ladder");
  let callerId = -1;
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {id: callerId, username: "test", name: "test", role_id: callerId === -1 ? 1 : 3, role_name: callerId === -1 ? "admin" : "student", student_number: null, teacher_role: null, subject: null, password_change_required: false};
    next();
  });
  app.use("/groups/:groupId", groupRouter); app.use("/ladder", ladderRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address() as {port: number};
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const rankingResponse = await fetch(`${base}/groups/${one}/rankings`);
    assert.equal(rankingResponse.status, 200);
    const ranking = await rankingResponse.json() as any;
    assert.equal(ranking.rows.find((r: any) => r.studentId === b)?.classId, promoted.id, "调班后历次考试的班级按现班返回");
    assert.equal(ranking.rows.find((r: any) => r.studentId === b)?.subjects[0].gradeRank, 2);
    const filteredResponse = await fetch(`${base}/groups/${one}/rankings?classId=${old.id}`);
    assert.equal(filteredResponse.status, 200);
    const filtered = await filteredResponse.json() as any;
    assert.equal(filtered.totalStudents, 1, "已调走的学生不再计入原班筛选");
    assert.equal(filtered.rows.find((r: any) => r.studentId === b), undefined);
    assert.equal(filtered.rows.find((r: any) => r.studentId === a)?.totalClassRank, 1);
    const ladderResponse = await fetch(`${base}/ladder/exam-groups/${two}`);
    assert.equal(ladderResponse.status, 200);
    const ladder = await ladderResponse.json() as any;
    assert.equal(ladder.rows.find((r: any) => r.studentId === a)?.totalScore, 200, "A's total must not double because of multi-class joins");
    assert.equal(ladder.rows.find((r: any) => r.studentId === b)?.classId, promoted.id);
    const comparisonResponse = await fetch(`${base}/groups/${one}/class-comparison`);
    assert.equal(comparisonResponse.status, 200);
    const comparison = await comparisonResponse.json() as any;
    assert.equal(comparison.classes.find((r: any) => r.classId === old.id)?.count, 1);
    assert.equal(comparison.classes.find((r: any) => r.classId === promoted.id)?.count, 1);
    const exported = await fetch(`${base}/groups/${one}/export`, {method: "POST", signal: AbortSignal.timeout(10000), headers: {"Content-Type": "application/json"}, body: JSON.stringify({includeOverview: true})});
    assert.equal(exported.status, 200);
    const zip = XLSX.CFB.read(Buffer.from(await exported.arrayBuffer()), {type: "buffer"});
    // CFB's ZIP reader does not decode UTF-8 entry names; the overview is the
    // first workbook appended by the route. Assert its sheet name below.
    const overview = zip.FileIndex.find((file: any) => file.name.endsWith(".xlsx") && file.content?.length);
    assert.ok(overview, "Group export must contain the overview workbook");
    const workbook = XLSX.read(overview.content, {type: "buffer"});
    assert.equal(workbook.SheetNames[0], "总览");
    const exportedRows = XLSX.utils.sheet_to_json<any>(workbook.Sheets[workbook.SheetNames[0]]);
    assert.equal(exportedRows.find(row => row["姓名"] === "原班B")?.["班级"], promoted.name);
    const hiddenExam = await exam("未参加的考试");
    await score(hiddenExam, c, 99);
    const mixedGroup = await group([e1, hiddenExam]);
    callerId = a;
    const studentLadderResponse = await fetch(`${base}/ladder/exam-groups/${mixedGroup}`);
    assert.equal(studentLadderResponse.status, 200);
    const studentLadder = await studentLadderResponse.json() as any;
    assert.equal(studentLadder.rows.find((r: any) => r.studentId === a)?.totalScore, 100);
    assert.equal(studentLadder.rows.find((r: any) => r.studentId === b)?.classId, promoted.id,
      "Student scope filtering follows the re-anchored class");
    assert.equal(studentLadder.rows.find((r: any) => r.studentId === c)?.totalScore, 40,
      "Unparticipated exams must not contribute scores to the group ladder");
    assert.ok(studentLadder.rows.every((r: any) => r.subjectScores.every((s: any) => s.examId === e1)),
      "The response must contain only participated subjects");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
  console.log("PASS: actual group ranking, comparison and ladder routes follow the re-anchored class and keep unique scores");
  console.log(`ALL PASS (${db.dialect})`);
} finally { await resetAdapter(); if (!maria) closeDatabase(); }
