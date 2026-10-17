/** 部分成绩公布、应考快照和入库身份校验回归（隔离 SQLite + HTTP）。
 * 有成绩即可公布；缺人、空名单和无范围均不阻塞。名单固化由入库/名单服务负责。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";

const tmpDir = mkdtempSync(path.join(tmpdir(), "projectx-p1-integrity-"));
process.env.PROJECTX_DB_PATH = path.join(tmpDir, "verify.db");
delete process.env.PROJECTX_MARIADB_HOST;
delete process.env.PROJECTX_MARIADB_PORT;
delete process.env.PROJECTX_MARIADB_USER;
delete process.env.PROJECTX_MARIADB_PASSWORD;
delete process.env.PROJECTX_MARIADB_DATABASE;
delete process.env.PROJECTX_MYSQL_HOST;

let passed = 0, failed = 0;
function ok(cond: boolean, label: string): void {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${label}`); }
}

const DEMO_ADMIN_PASSWORD = "Admin@P1Integrity2026";
async function loginAdmin(base: string, initial: string): Promise<string> {
  const first = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: "admin", password: initial }),
  });
  const firstBody = await first.json();
  if (firstBody.token && !firstBody?.passwordChangeRequired) return firstBody.token;
  if (first.status === 428 || firstBody?.code === "PASSWORD_CHANGE_REQUIRED" || firstBody?.passwordChangeRequired) {
    await fetch(`${base}/api/auth/change-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${firstBody?.token ?? ""}` },
      body: JSON.stringify({ oldPassword: initial, newPassword: DEMO_ADMIN_PASSWORD }),
    }).catch(() => {});
    const retry = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "admin", password: DEMO_ADMIN_PASSWORD }),
    });
    const retryBody = await retry.json();
    if (retryBody.token) return retryBody.token;
    throw new Error(`admin 自动改密失败：首次=${first.status}，重试=${retry.status}`);
  }
  throw new Error(`admin 登录失败: status=${first.status} body=${JSON.stringify(firstBody)}`);
}

async function main() {
  console.log(`临时库: ${process.env.PROJECTX_DB_PATH}`);
  const { ensureExamParticipants } = await import("../src/server/services/examParticipants");
  const { initializeDatabase, ensureDefaultAdmin, getDatabase, closeDatabase, getMysqlDb } = await import("../src/server/db/index");
  const { createApp } = await import("../src/apps/answer-card/server/index");

  initializeDatabase();
  const db = getDatabase();
  const bootstrap = await ensureDefaultAdmin();

  // ── 夹具：年级 G → A 班(s1,s2) / B 班(s3,s4)；C 外班学生 s5 ──
  const gradeId = Number(db.prepare("INSERT INTO grades (name, sort_order, is_demo) VALUES ('完整性测试年级', 1, 0)").run().lastInsertRowid);
  const classA = Number(db.prepare("INSERT INTO classes (grade_id, name, sort_order, is_demo) VALUES (?, '完整性A班', 1, 0)").run(gradeId).lastInsertRowid);
  const classB = Number(db.prepare("INSERT INTO classes (grade_id, name, sort_order, is_demo) VALUES (?, '完整性B班', 2, 0)").run(gradeId).lastInsertRowid);
  const emptyClass = Number(db.prepare("INSERT INTO classes (grade_id, name, sort_order, is_demo) VALUES (?, '完整性空班', 3, 0)").run(gradeId).lastInsertRowid);
  const sids: Record<string, number> = {};
  for (const num of ["30001", "30002", "30003", "30004", "30005"]) {
    const r = db.prepare("INSERT INTO users (username, password_hash, name, role_id, student_number, is_active) VALUES (?, 'x', ?, 3, ?, 1)")
      .run(`integ-${num}`, `完整性学生${num}`, num);
    sids[num] = Number(r.lastInsertRowid);
  }
  db.prepare("INSERT INTO class_students (class_id, student_id) VALUES (?, ?)").run(classA, sids["30001"]);
  db.prepare("INSERT INTO class_students (class_id, student_id) VALUES (?, ?)").run(classA, sids["30002"]);
  db.prepare("INSERT INTO class_students (class_id, student_id) VALUES (?, ?)").run(classB, sids["30003"]);
  db.prepare("INSERT INTO class_students (class_id, student_id) VALUES (?, ?)").run(classB, sids["30004"]);
  const cardId = "INTCARD001";
  db.prepare("INSERT INTO answer_cards (id, title, subject, subject_label, exam_date, paper_size, orientation, student_fields, student_number_digits, sided, layout_version, created_by) VALUES (?, '完整性测试卡', 'math', '数学', '2026-08-25', 'A4', 'portrait', '{}', 5, 'single', 1, 1)")
    .run(cardId);

  function createExamDirect(name: string, opts: { classId?: number; gradeId?: number }): number {
    const r = db.prepare(
      `INSERT INTO exams (name, card_id, grade_id, class_id, subject, start_time, status, score_published, exam_mode, created_by)
       VALUES (?, ?, ?, ?, '数学', CURRENT_TIMESTAMP, 'closed', 0, 'formal', (SELECT id FROM users WHERE username='admin'))`
    ).run(name, cardId, opts.gradeId ?? null, opts.classId ?? null);
    return Number(r.lastInsertRowid);
  }
  function insertScore(examId: number, sid: number, total = 60): void {
    db.prepare("INSERT INTO student_scores (exam_id, student_id, objective_score, subjective_score, total_score) VALUES (?, ?, ?, 0, ?)")
      .run(examId, sid, total, total);
  }
  async function publish(base: string, headers: Record<string, string>, examId: number) {
    const r = await fetch(`${base}/api/exams/${examId}/publish`, { method: "POST", headers });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }

  const app = await createApp();
  const server: Server = await new Promise((resolve) => {
    const s = createServer(app);
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const pwd = readFileSync(bootstrap.passwordFile, "utf8").trim();
  const token = await loginAdmin(base, pwd);
  const headers = { Authorization: `Bearer ${token}` };
  ok(Boolean(token), "admin 登录成功");

  // ── T1: 单班名册全录 → 200 ──
  {
    const examId = createExamDirect("IN-T1-单班完整", { classId: classA });
    insertScore(examId, sids["30001"]);
    insertScore(examId, sids["30002"]);
    const r = await publish(base, headers, examId);
    ok(r.status === 200, `T1 单班名册全录 → 200 (实际 ${r.status})`);
  }

  // ── T2: 年级名册只录 A → 200（缺 B）──
  {
    const examId = createExamDirect("IN-T2-只录A", { gradeId });
    insertScore(examId, sids["30001"]);
    insertScore(examId, sids["30002"]);
    const r = await publish(base, headers, examId);
    ok(r.status === 200, `T2 只录 A 班缺 B 班 → 200 (实际 ${r.status})`);
  }

  // ── T3: 只录 A + 外班 C（原绕过场景）→ 200（允许部分成绩）──
  {
    const examId = createExamDirect("IN-T3-外班凑数", { gradeId });
    insertScore(examId, sids["30001"]);
    insertScore(examId, sids["30002"]);
    insertScore(examId, sids["30005"]); // 外班 C 直写凑数
    const r = await publish(base, headers, examId);
    ok(r.status === 200, `T3 缺 B 班不阻塞已有成绩 → 200 (实际 ${r.status})`);
  }

  // ── T4/T4b: 全录 + 外班 C 直写 → 200，且 C 不在应考快照 ──
  {
    const examId = createExamDirect("IN-T4-全录加外班", { gradeId });
    await ensureExamParticipants(getMysqlDb(), examId);
    for (const num of ["30001", "30002", "30003", "30004"]) insertScore(examId, sids[num]);
    insertScore(examId, sids["30005"]);
    const r = await publish(base, headers, examId);
    ok(r.status === 200, `T4 全录 4 人 + 外班 C → 200 (实际 ${r.status})`);
    const snap = db.prepare("SELECT COUNT(*) AS c FROM exam_participants WHERE exam_id = ?").get(examId) as { c: number };
    ok(Number(snap.c) === 4, `T4b 应考快照 = 4 人（外班 C 不入快照，实际 ${snap.c}）`);
  }

  // ── T5/T5b: 调班后快照冻结 ──
  {
    const examId = createExamDirect("IN-T5-调班", { gradeId });
    await ensureExamParticipants(getMysqlDb(), examId);
    for (const num of ["30001", "30002", "30003", "30004"]) insertScore(examId, sids[num]);
    const first = await publish(base, headers, examId);
    ok(first.status === 200, `T5 全录 4 人 → publish 200 (实际 ${first.status})`);
    // 撤回后移走 B 班学生，再重新公布
    const unpub = await fetch(`${base}/api/exams/${examId}/unpublish`, { method: "POST", headers, body: "{}" });
    ok(unpub.status === 200, `T5 撤回成功 (实际 ${unpub.status})`);
    db.prepare("DELETE FROM class_students WHERE class_id = ? AND student_id = ?").run(classB, sids["30004"]);
    const retry = await publish(base, headers, examId);
    ok(retry.status === 200, `T5 调班后重新 publish 仍 200（快照冻结，实际 ${retry.status}）`);
    const snap = db.prepare("SELECT COUNT(*) AS c FROM exam_participants WHERE exam_id = ?").get(examId) as { c: number };
    ok(Number(snap.c) === 4, `T5b 快照仍 4 人（调班不影响历史口径，实际 ${snap.c}）`);
  }

  // ── T6: 单场与批量谓词一致 ──
  {
    const incompleteId = createExamDirect("IN-T6-批量缺人", { gradeId });
    insertScore(incompleteId, sids["30001"]);
    const single = await publish(base, headers, incompleteId);
    const batch = await fetch(`${base}/api/exams/publish-batch`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ examIds: [incompleteId] }),
    });
    ok(single.status === 200 && batch.status === 200, `T6a 不完整：单场 ${single.status} / 批量 ${batch.status} 均 200`);

    const completeId = createExamDirect("IN-T6-批量完整", { gradeId });
    for (const num of ["30001", "30002", "30003", "30004"]) insertScore(completeId, sids[num]);
    const single2 = await publish(base, headers, completeId);
    ok(single2.status === 200, `T6b 完整：单场 200 (实际 ${single2.status})`);
  }

  // ── T7: 空班级 → 200 ──
  {
    const examId = createExamDirect("IN-T7-空班级", { classId: emptyClass });
    insertScore(examId, sids["30005"]);
    const r = await publish(base, headers, examId);
    ok(r.status === 200, `T7 空班级 → 200 (实际 ${r.status})`);
  }

  // ── T8: 无范围考试 → 200（已有成绩可公布）──
  {
    const examId = createExamDirect("IN-T8-无范围", {});
    insertScore(examId, sids["30001"]);
    const r = await publish(base, headers, examId);
    ok(r.status === 200, `T8 无范围 + 1 条成绩 → 200 (实际 ${r.status})`);
  }

  // ── T9: isExamParticipant 拦截语义 ──
  {
    const examId = createExamDirect("IN-T9-拦截", { gradeId });
    await ensureExamParticipants(getMysqlDb(), examId);
    for (const num of ["30001", "30002", "30003", "30004"]) insertScore(examId, sids[num]);
    await publish(base, headers, examId); // 公布不改变已固化名单
    const { isExamParticipant } = await import("../src/server/services/examParticipants");
    const dbAdapter = getMysqlDb();
    const inRoster = await isExamParticipant(dbAdapter, examId, sids["30001"]);
    const outRoster = await isExamParticipant(dbAdapter, examId, sids["30005"]);
    ok(inRoster === true && outRoster === false, `T9 应考学生可入 / 外班 C 被拦 (in=${inRoster}, out=${outRoster})`);
  }

  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDatabase();
  rmSync(tmpDir, { recursive: true, force: true });

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
