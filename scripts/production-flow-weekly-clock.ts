import assert from "node:assert/strict";
import { closeAdapter, getMysqlDb, initMariadbSchema } from "../src/server/db/mysql";
import { WeeklyAuditService } from "../src/server/services/WeeklyAuditService";

// This fixture initializes a new database on the Ubuntu test guest.
const database = process.env.PROJECTX_MARIADB_DATABASE ?? "";
assert.match(database, /^projectx_weekly_e2e_[0-9]+$/);
assert.ok(process.env.PROJECTX_MARIADB_HOST);
const db = getMysqlDb();
try {
  assert.equal(db.dialect, "mariadb");
  assert.equal((await db.get<{ name: string }>("SELECT DATABASE() AS name"))?.name, database);
  assert.deepEqual(await db.all("SHOW TABLES"), []);
  await initMariadbSchema();
  const grade = await db.run("INSERT INTO grades(name) VALUES (?)", "周报边界");
  const student = await db.run(
    "INSERT INTO users(username,name,password_hash,role_id) SELECT ?,?,?,id FROM roles WHERE name='student'",
    "weekly_sample", "周报测试生", "disabled",
  );
  assert.equal(student.changes, 1);
  const createExam = (name: string, day: string) => db.run(
    "INSERT INTO exams(name,grade_id,subject,status,exam_mode,created_at) VALUES (?,?,'数学','closed','quiz',?)",
    name, grade.lastInsertRowid, day,
  );
  const first = await createExam("周初测验", "2026-11-16 09:00:00");
  const score = (id: number) => db.run(
    "INSERT INTO student_scores(exam_id,student_id,objective_score,total_score) VALUES (?,?,60,60)", id, student.lastInsertRowid,
  );
  await score(first.lastInsertRowid);
  const service = new WeeklyAuditService();
  const groupCount = async () => Number((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM exam_groups WHERE source='week'"))?.n);
  assert.equal((await service.publishDueWeeks(new Date(2026, 10, 21, 7, 59, 59))).created.length, 0);
  assert.equal(await groupCount(), 0, "A completed week was published early");
  const second = await createExam("周五测验", "2026-11-20 09:00:00");
  const atEight = new Date(2026, 10, 21, 8, 0, 0);
  await service.publishDueWeeks(atEight);
  assert.equal(await groupCount(), 0, "The week was published with an unfinished exam");
  await score(second.lastInsertRowid);
  assert.equal((await service.publishDueWeeks(atEight)).created.length, 1);
  assert.equal(await groupCount(), 1);
  assert.equal((await service.publishDueWeeks(atEight)).created.length, 0);
  const members = await db.all<{ exam_id: number }>("SELECT exam_id FROM exam_group_members ORDER BY exam_id");
  assert.deepEqual(members.map(row => Number(row.exam_id)), [Number(first.lastInsertRowid), Number(second.lastInsertRowid)]);
  console.log("PASS MariaDB weekly publication at 07:59:59 and 08:00:00, score delay, two members, idempotent retry");
} finally {
  await closeAdapter();
}
