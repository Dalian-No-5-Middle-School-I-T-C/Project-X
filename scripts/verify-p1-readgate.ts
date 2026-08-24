/**
 * P1 学生端读门（成绩公布门控）回归验证（临时 SQLite 库 + HTTP）。
 *
 * 核心安全属性：score_published=1 之前，学生不得经任何接口取到成绩。
 *  G1  未公布考试不出现在 /api/scores/me
 *  G2  未公布 /me/exams/:id → 404（防枚举）
 *  G3  未公布不进入 /me/trends（趋势/学期/学科对比同源）
 *  G4  未公布考试天梯 → 403（checkLadderPublished）
 *  G5  未公布单场 AI 分析 → 403（不触发 LLM）
 *  G6  公布后：/me 出现该考试、明细 200
 *  G7  教师改分自动撤回 → 学生端立即不可见（/me 消失、明细 404）
 *  G8  重新公布 → 学生端恢复可见
 *  G9  教师/管理员代查仍可见未公布成绩（publishedOnly=false 不误伤教师端）
 *
 * 用法: npx tsx scripts/verify-p1-readgate.ts（须用 Node 24 运行 tsx）
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import bcrypt from "bcryptjs";

const tmpDir = mkdtempSync(path.join(tmpdir(), "projectx-p1-readgate-"));
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

const DEMO_ADMIN_PASSWORD = "Admin@P1Readgate2026";
async function login(base: string, identifier: string, password: string): Promise<{ token?: string; status: number; body: any }> {
  const r = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier, password }),
  });
  const body = await r.json().catch(() => ({}));
  return { token: body.token, status: r.status, body };
}
async function loginAdmin(base: string, initial: string): Promise<string> {
  const first = await login(base, "admin", initial);
  if (first.token && !first.body?.passwordChangeRequired) return first.token;
  if (first.status === 428 || first.body?.code === "PASSWORD_CHANGE_REQUIRED" || first.body?.passwordChangeRequired) {
    await fetch(`${base}/api/auth/change-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${first.body?.token ?? ""}` },
      body: JSON.stringify({ oldPassword: initial, newPassword: DEMO_ADMIN_PASSWORD }),
    }).catch(() => {});
    const retry = await login(base, "admin", DEMO_ADMIN_PASSWORD);
    if (retry.token) return retry.token;
    throw new Error(`admin 自动改密失败：首次=${first.status}，重试=${retry.status}`);
  }
  throw new Error(`admin 登录失败: status=${first.status}`);
}

async function main() {
  console.log(`临时库: ${process.env.PROJECTX_DB_PATH}`);
  const { initializeDatabase, ensureDefaultAdmin, getDatabase, closeDatabase } = await import("../src/server/db/index");
  const { createApp } = await import("../src/apps/answer-card/server/index");
  const { markScoreMutated } = await import("../src/server/services/examPublishEvents");
  const { getMysqlDb } = await import("../src/server/db");

  initializeDatabase();
  const db = getDatabase();
  const bootstrap = await ensureDefaultAdmin();

  // ── 夹具：年级 G → A 班（s1,s2）；卡；考试（closed 未公布）──
  const gradeId = Number(db.prepare("INSERT INTO grades (name, sort_order, is_demo) VALUES ('读门测试年级', 1, 0)").run().lastInsertRowid);
  const classA = Number(db.prepare("INSERT INTO classes (grade_id, name, sort_order, is_demo) VALUES (?, '读门A班', 1, 0)").run(gradeId).lastInsertRowid);
  const STUDENT_NUM = "40001";
  const s1 = Number(db.prepare("INSERT INTO users (username, password_hash, name, role_id, student_number, is_active) VALUES (?, ?, '读门学生', 3, ?, 1)")
    .run(STUDENT_NUM, bcrypt.hashSync(STUDENT_NUM, 10), STUDENT_NUM).lastInsertRowid);
  const s2 = Number(db.prepare("INSERT INTO users (username, password_hash, name, role_id, student_number, is_active) VALUES ('40002', ?, '读门学生乙', 3, '40002', 1)")
    .run(bcrypt.hashSync("40002", 10)).lastInsertRowid);
  db.prepare("INSERT INTO class_students (class_id, student_id) VALUES (?, ?)").run(classA, s1);
  db.prepare("INSERT INTO class_students (class_id, student_id) VALUES (?, ?)").run(classA, s2);
  const cardId = "READCARD001";
  db.prepare("INSERT INTO answer_cards (id, title, subject, subject_label, exam_date, paper_size, orientation, student_fields, student_number_digits, sided, layout_version, created_by) VALUES (?, '读门测试卡', 'math', '数学', '2026-08-25', 'A4', 'portrait', '{}', 5, 'single', 1, 1)")
    .run(cardId);
  const examId = Number(db.prepare(
    `INSERT INTO exams (name, card_id, grade_id, class_id, subject, start_time, status, score_published, exam_mode, created_by)
     VALUES ('读门测试考试', ?, ?, ?, '数学', CURRENT_TIMESTAMP, 'closed', 0, 'formal', (SELECT id FROM users WHERE username='admin'))`
  ).run(cardId, gradeId, classA).lastInsertRowid);
  function insertScore(sid: number, total = 80): void {
    db.prepare("INSERT INTO student_scores (exam_id, student_id, objective_score, subjective_score, total_score) VALUES (?, ?, ?, 0, ?)")
      .run(examId, sid, total, total);
  }
  insertScore(s1, 85);
  insertScore(s2, 76);

  const app = await createApp();
  const server: Server = await new Promise((resolve) => {
    const s = createServer(app);
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const adminToken = await loginAdmin(base, readFileSync(bootstrap.passwordFile, "utf8").trim());
  const adminHeaders = { Authorization: `Bearer ${adminToken}` };
  const stuLogin = await login(base, STUDENT_NUM, STUDENT_NUM);
  const stuHeaders = { Authorization: `Bearer ${stuLogin.token}` };
  ok(Boolean(adminToken) && Boolean(stuLogin.token), "admin / 学生登录成功");

  // ── G1: 未公布不出现在 /me ──
  {
    const r = await fetch(`${base}/api/scores/me`, { headers: stuHeaders });
    const body = await r.json().catch(() => ({}));
    const hasExam = (body.scores ?? []).some((s: { exam_id: number }) => s.exam_id === examId);
    ok(r.status === 200 && !hasExam, `G1 未公布不出现在 /me (examId=${examId} in list=${hasExam})`);
  }

  // ── G2: 未公布明细 404 ──
  {
    const r = await fetch(`${base}/api/scores/me/exams/${examId}`, { headers: stuHeaders });
    ok(r.status === 404, `G2 未公布明细 → 404 (实际 ${r.status})`);
  }

  // ── G3: 未公布不进入趋势 ──
  {
    const r = await fetch(`${base}/api/scores/me/trends`, { headers: stuHeaders });
    const body = await r.json().catch(() => []);
    const hasExam = (Array.isArray(body) ? body : []).some((t: { examId?: number }) => t.examId === examId);
    ok(!hasExam, `G3 未公布不进入趋势 (in trends=${hasExam})`);
  }

  // ── G4: 未公布天梯 403 ──
  {
    const r = await fetch(`${base}/api/ladder/exams/${examId}`, { headers: stuHeaders });
    ok(r.status === 403, `G4 未公布天梯 → 403 (实际 ${r.status})`);
  }

  // ── G5: 未公布单场 AI 分析 403 ──
  {
    const r = await fetch(`${base}/api/scores/me/exams/${examId}/ai-analysis`, {
      method: "POST", headers: { ...stuHeaders, "Content-Type": "application/json" }, body: "{}",
    });
    ok(r.status === 403, `G5 未公布 AI 分析 → 403 (实际 ${r.status})`);
  }

  // ── G6: 公布后可见 ──
  {
    const pub = await fetch(`${base}/api/exams/${examId}/publish`, { method: "POST", headers: adminHeaders });
    ok(pub.status === 200, `G6 管理员公布 → 200 (实际 ${pub.status})`);
    const me = await fetch(`${base}/api/scores/me`, { headers: stuHeaders });
    const meBody = await me.json().catch(() => ({}));
    const hasExam = (meBody.scores ?? []).some((s: { exam_id: number }) => s.exam_id === examId);
    ok(hasExam, `G6 公布后出现在 /me`);
    const detail = await fetch(`${base}/api/scores/me/exams/${examId}`, { headers: stuHeaders });
    ok(detail.status === 200, `G6 公布后明细 → 200 (实际 ${detail.status})`);
  }

  // ── G7: 教师改分自动撤回 → 学生端立即不可见 ──
  {
    const dbAdapter = getMysqlDb();
    const revoked = await markScoreMutated(dbAdapter, examId, 1, "score_edit");
    ok(revoked === true, `G7 改分触发自动撤回 (score_published→0)`);
    const me = await fetch(`${base}/api/scores/me`, { headers: stuHeaders });
    const meBody = await me.json().catch(() => ({}));
    const hasExam = (meBody.scores ?? []).some((s: { exam_id: number }) => s.exam_id === examId);
    ok(!hasExam, `G7 撤回后 /me 不再出现该考试`);
    const detail = await fetch(`${base}/api/scores/me/exams/${examId}`, { headers: stuHeaders });
    ok(detail.status === 404, `G7 撤回后明细 → 404 (实际 ${detail.status})`);
  }

  // ── G8: 重新公布 → 恢复可见 ──
  {
    const pub = await fetch(`${base}/api/exams/${examId}/publish`, { method: "POST", headers: adminHeaders });
    ok(pub.status === 200, `G8 重新公布 → 200 (实际 ${pub.status})`);
    const detail = await fetch(`${base}/api/scores/me/exams/${examId}`, { headers: stuHeaders });
    ok(detail.status === 200, `G8 重新公布后明细 → 200 (实际 ${detail.status})`);
  }

  // ── G9: 教师/管理员代查仍可见未公布成绩 ──
  {
    // 先撤回，再验证代查（publishedOnly=false 不误伤教师端）
    await markScoreMutated(getMysqlDb(), examId, 1, "score_edit");
    const r = await fetch(`${base}/api/scores/students/${s1}`, { headers: adminHeaders });
    const body = await r.json().catch(() => ({}));
    const hasExam = (body.scores ?? []).some((s: { exam_id: number }) => s.exam_id === examId);
    ok(r.status === 200 && hasExam, `G9 管理员代查仍可见未公布成绩 (actual status=${r.status})`);
  }

  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDatabase();
  rmSync(tmpDir, { recursive: true, force: true });

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
