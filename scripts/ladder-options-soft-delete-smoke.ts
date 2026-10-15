/** Real student HTTP regression on SQLite or an empty scanner MariaDB database. */
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { startScannerFlowFixture } from "./scanner-upload-flow-fixture";

const fixture = await startScannerFlowFixture();
let server: Server | undefined;
try {
  const info = await (await fetch(`${fixture.baseUrl}/test/fixture`)).json();
  const { getMysqlDb, hashPassword } = await import("../src/server/db");
  const { authService } = await import("../src/server/services/AuthService");
  const { default: ladderRouter } = await import("../src/server/routes/ladder");
  const db = getMysqlDb();
  const password = "Ladder-Soft-Delete-Test-2026!";
  await db.run("UPDATE users SET password_hash=? WHERE student_number IN ('91001','91002')", await hashPassword(password));
  const activeStudent = (await db.get<{ id: number }>("SELECT id FROM users WHERE student_number='91001'"))!;
  const deletedOnlyStudent = (await db.get<{ id: number }>("SELECT id FROM users WHERE student_number='91002'"))!;
  const active = (await db.run("INSERT INTO exams (name,card_id,score_published) VALUES ('有效成员',?,1)", info.cardId)).lastInsertRowid;
  const deleted = (await db.run("INSERT INTO exams (name,card_id,score_published) VALUES ('软删除成员',?,1)", info.cardId)).lastInsertRowid;
  for (const [exam, student, total] of [[active, activeStudent.id, 50], [deleted, deletedOnlyStudent.id, 60]]) {
    await db.run("INSERT INTO exam_participants (exam_id,student_id,source) VALUES (?,?,'explicit')", exam, student);
    await db.run("INSERT INTO student_scores (exam_id,student_id,objective_score,subjective_score,total_score) VALUES (?,?,?,0,?)", exam, student, total, total);
  }
  const group = (await db.run("INSERT INTO exam_groups (name,total_score_mode,only_full_participants) VALUES ('软删除成员回归','raw',0)")).lastInsertRowid;
  await db.run("INSERT INTO exam_group_members (group_id,exam_id,sort_order) VALUES (?,?,0)", group, active);
  await db.run("INSERT INTO exam_group_members (group_id,exam_id,sort_order) VALUES (?,?,1)", group, deleted);
  const activeToken = (await authService.login("flow_91001", password)).token!;
  const deletedOnlyToken = (await authService.login("flow_91002", password)).token!;
  const app = express(); app.use("/api/ladder", ladderRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server!.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/ladder`;
  async function options(token: string) {
    const response = await fetch(`${base}/options`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    return await response.json() as { exams: Array<{ id: number }>; groups: Array<{ id: number }> };
  }
  const board = (token: string) => fetch(`${base}/exam-groups/${group}`, { headers: { Authorization: `Bearer ${token}` } });
  assert((await options(activeToken)).groups.some(g => g.id === group), "baseline active student sees the group");
  assert((await options(deletedOnlyToken)).groups.some(g => g.id === group), "baseline second student participates in the still-active member");

  await db.run("INSERT INTO exam_archives (exam_id,is_deleted,deleted_at) VALUES (?,1,CURRENT_TIMESTAMP)", deleted);
  await db.run("UPDATE exams SET score_published=0 WHERE id=?", deleted);
  assert((await options(activeToken)).groups.some(g => g.id === group), "unpublished deleted member does not hide a valid group");
  const readable = await board(activeToken);
  assert.equal(readable.status, 200, "the offered group is readable");
  assert.equal((await readable.json() as { myScore: number }).myScore, 50);

  await db.run("UPDATE exams SET score_published=1 WHERE id=?", deleted);
  const inaccessible = await options(deletedOnlyToken);
  assert(!inaccessible.exams.some(e => e.id === deleted), "deleted member is absent from single-exam options");
  assert(!inaccessible.groups.some(g => g.id === group), "participation only in a deleted member does not expose the group");
  assert.equal((await board(deletedOnlyToken)).status, 403, "group detail applies the same surviving participation scope");

  // A live unpublished member must still enforce the publication gate.
  await db.run("UPDATE exam_archives SET is_deleted=0 WHERE exam_id=?", deleted);
  await db.run("UPDATE exams SET score_published=0 WHERE id=?", deleted);
  assert(!(await options(activeToken)).groups.some(g => g.id === group), "live unpublished member hides the group");
  assert.equal((await board(activeToken)).status, 403);
  await db.run("UPDATE exam_archives SET is_deleted=1 WHERE exam_id=?", deleted);
  await db.run("INSERT INTO exam_archives (exam_id,is_deleted,deleted_at) VALUES (?,1,CURRENT_TIMESTAMP)", active);
  assert(!(await options(activeToken)).groups.some(g => g.id === group), "group with all members deleted is absent");
  assert.equal(Number((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM exam_group_members WHERE group_id=?", group))!.n), 2,
    "regression retains both membership rows and exercises soft deletion filtering");
  console.log(`PASS ladder soft-delete options (${db.dialect}): unpublished deleted member, deleted-only participation, live publication gate and all-deleted group`);
} finally {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  await fixture.close();
}
