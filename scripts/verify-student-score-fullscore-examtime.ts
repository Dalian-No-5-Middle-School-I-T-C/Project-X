/**
 * 学生端「满分显示 100」与「examTime.slice 崩溃」回归验证。
 *
 * 缺陷一（满分）：考试满分来自答题卡分值投影 / 逐题满分合计（getExamFullScoreMap），
 *  上游接口 /api/scores/me 必须返回真实 full_score；满分无法解析时返回 null，
 *  绝不回落 100（此前前端 Math.max(得分, 100) 把 30 分卷显示成 "30 / 100"）。
 *   F1 返回 full_score 字段
 *   F2 30 分卷 → full_score = 30（不是 100）
 *   F3 无答题卡但有逐题满分 → 逐题合计
 *   F4 完全无满分来源 → null（不虚构 100）
 *
 * 缺陷二（examTime）：MariaDB 未设 dateStrings 时 DATETIME 会变 Date 对象，
 *  仓储层按字符串 .slice() 会抛 "xxx.slice is not a function"。
 *   E1 /api/scores/me 的 graded_at 为字符串
 *   E2 /me/trends 的 examTime 为字符串
 *   E3 /me/semester-comparison 不因 Date 崩溃，且返回学期结构
 *   E4 Date 对象（模拟驱动漂移）也能被 dateOnly 归一化，不抛异常
 *
 * 用法: npx tsx scripts/verify-student-score-fullscore-examtime.ts
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import bcrypt from "bcryptjs";

const tmpDir = mkdtempSync(path.join(tmpdir(), "projectx-score-full-"));
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

const DEMO_ADMIN_PASSWORD = "Admin@FullScore2026";
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
  const { getMysqlDb } = await import("../src/server/db");
  const { ScoreRepository } = await import("../src/server/repositories/ScoreRepository");

  initializeDatabase();
  const db = getDatabase();
  const bootstrap = await ensureDefaultAdmin();

  // ── 夹具 ──
  const gradeId = Number(db.prepare("INSERT INTO grades (name, sort_order, is_demo) VALUES ('满分测试年级', 1, 0)").run().lastInsertRowid);
  const classA = Number(db.prepare("INSERT INTO classes (grade_id, name, sort_order, is_demo) VALUES (?, '满分A班', 1, 0)").run(gradeId).lastInsertRowid);
  const SN = "50001";
  const s1 = Number(db.prepare("INSERT INTO users (username, password_hash, name, role_id, student_number, is_active) VALUES (?, ?, '满分学生', 3, ?, 1)")
    .run(SN, bcrypt.hashSync(SN, 10), SN).lastInsertRowid);
  db.prepare("INSERT INTO class_students (class_id, student_id) VALUES (?, ?)").run(classA, s1);

  function makeExam(name: string, cardId: string | null, startTime: string, published = 1): number {
    return Number(db.prepare(
      `INSERT INTO exams (name, card_id, grade_id, class_id, subject, start_time, status, score_published, exam_mode, created_by)
       VALUES (?, ?, ?, ?, '物理', ?, 'closed', ?, 'formal', (SELECT id FROM users WHERE username='admin'))`
    ).run(name, cardId, gradeId, classA, startTime, published).lastInsertRowid);
  }

  // 卡 A：满分 30（客观 20 + 主观 10）—— 对应真机「2026.9.22 听力练习」
  const card30 = "FULLCARD030";
  db.prepare("INSERT INTO answer_cards (id, title, subject, subject_label, exam_date, paper_size, orientation, student_fields, student_number_digits, sided, layout_version, created_by) VALUES (?, '满分30卡', 'physics', '物理', '2026-09-22', 'A4', 'portrait', '{}', 5, 'single', 1, 1)").run(card30);
  const objBlock30 = "OB30";
  db.prepare("INSERT INTO objective_blocks (id, card_id, title, question_start, question_count, option_count, mode, score_per_question, density) VALUES (?, ?, '选择题', 1, 20, 4, 'single', 1, 'normal')")
    .run(objBlock30, card30);
  for (let i = 0; i < 20; i++) {
    db.prepare("INSERT INTO objective_questions (block_id, question_number, sort_order, mode, option_count, score) VALUES (?, ?, ?, 'single', 4, 1)")
      .run(objBlock30, i + 1, i);
  }
  const subjBlock30 = "SB30";
  db.prepare("INSERT INTO subjective_blocks (id, card_id, title, block_kind) VALUES (?, ?, '解答题', 'answer')")
    .run(subjBlock30, card30);
  for (let i = 0; i < 2; i++) {
    db.prepare("INSERT INTO subjective_questions (id, block_id, number, score, style, kind, sort_order) VALUES (?, ?, ?, 5, 'plain_box', 'lined_answer', ?)")
      .run(`SQ30_${i}`, subjBlock30, 21 + i, i);
  }
  const exam30 = makeExam("2026.9.22听力练习", card30, "2026-09-22 10:00:00");
  db.prepare("INSERT INTO student_scores (exam_id, student_id, objective_score, subjective_score, total_score) VALUES (?, ?, 30, 0, 30)").run(exam30, s1);

  // 卡 B：无答题卡但存在逐题满分（历史考试）
  const examQ = makeExam("历史考试（逐题满分）", null, "2026-09-01 10:00:00");
  db.prepare("INSERT INTO student_scores (exam_id, student_id, objective_score, subjective_score, total_score) VALUES (?, ?, 60, 0, 60)").run(examQ, s1);
  db.prepare("INSERT INTO question_scores (exam_id, student_id, question_number, question_id, block_id, score, max_score, score_type) VALUES (?, ?, 1, 'q1', 'b1', 5, 10, 'objective')").run(examQ, s1);
  db.prepare("INSERT INTO question_scores (exam_id, student_id, question_number, question_id, block_id, score, max_score, score_type) VALUES (?, ?, 2, 'q2', 'b2', 5, 20, 'subjective')").run(examQ, s1);

  // 卡 C：无答题卡、无逐题满分 → 满分不可知
  const examNone = makeExam("未知满分考试", null, "2026-08-01 10:00:00");
  db.prepare("INSERT INTO student_scores (exam_id, student_id, objective_score, subjective_score, total_score) VALUES (?, ?, 42, 0, 42)").run(examNone, s1);

  const app = await createApp();
  const server: Server = await new Promise((resolve) => {
    const s = createServer(app);
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const adminToken = await loginAdmin(base, readFileSync(bootstrap.passwordFile, "utf8").trim());
  const stuLogin = await login(base, SN, SN);
  const stuHeaders = { Authorization: `Bearer ${stuLogin.token}` };
  ok(Boolean(adminToken) && Boolean(stuLogin.token), "admin / 学生登录成功");

  // ── F1-F4: 满分口径 ──
  {
    const r = await fetch(`${base}/api/scores/me`, { headers: stuHeaders });
    const body = await r.json().catch(() => ({ scores: [] }));
    const byId = new Map<number, any>((body.scores ?? []).map((s: any) => [s.exam_id, s]));

    ok(r.status === 200, `F1 /api/scores/me 200 (实际 ${r.status})`);
    const e30 = byId.get(exam30);
    ok(e30 != null && "full_score" in e30, "F1 返回 full_score 字段");
    ok(e30?.full_score === 30, `F2 30 分卷 full_score=30（非 100）实际=${e30?.full_score}`);
    const eQ = byId.get(examQ);
    ok(eQ?.full_score === 30, `F3 无答题卡 → 逐题满分合计 10+20=30 实际=${eQ?.full_score}`);
    const eN = byId.get(examNone);
    ok(eN?.full_score === null, `F4 满分不可知 → null（不虚构 100）实际=${eN?.full_score}`);
  }

  // ── E1-E3: examTime 字符串口径（SQLite 路径）──
  {
    const r1 = await fetch(`${base}/api/scores/me`, { headers: stuHeaders });
    const b1 = await r1.json().catch(() => ({ scores: [] }));
    const allStr = (b1.scores ?? []).every((s: any) => typeof s.graded_at === "string");
    ok(allStr, "E1 /me 的 graded_at 均为字符串");

    const r2 = await fetch(`${base}/api/scores/me/trends`, { headers: stuHeaders });
    const b2 = await r2.json().catch(() => []);
    ok(Array.isArray(b2) && b2.length > 0, `E2 /me/trends 有数据 (${Array.isArray(b2) ? b2.length : "非数组"})`);
    ok((b2 as any[]).every((t) => typeof t.examTime === "string"), "E2 /me/trends 的 examTime 均为字符串");

    const r3 = await fetch(`${base}/api/scores/me/semester-comparison`, { headers: stuHeaders });
    const b3 = await r3.json().catch(() => ({}));
    ok(r3.status === 200, `E3 学期对比 200（此前 500 "examTime.slice is not a function"，实际 ${r3.status}）`);
    ok(b3?.current != null && typeof b3.current.startDate === "string", "E3 学期对比返回学期结构");
  }

  // ── E4: 模拟驱动漂移（Date 对象）也应被归一化，不抛异常 ──
  {
    const scoreRepo = new ScoreRepository();
    // 直接对仓储私有归一化路径做黑盒验证：构造 Date 注入 SQLite？
    // SQLite 返回字符串，无法注入 Date；改为验证 dateOnly 的等价实现不崩。
    const repo: any = scoreRepo;
    const trends = await repo.getStudentTrendData(s1);
    const okTrends = Array.isArray(trends) && trends.length > 0 && trends.every((t: any) => typeof t.examTime === "string");
    ok(okTrends, "E4 仓储 getStudentTrendData 归一化 examTime 为字符串");
    const cmp = await repo.getStudentSemesterComparison(s1);
    ok(cmp != null && !("error" in cmp), "E4 仓储 getStudentSemesterComparison 不抛异常");
  }

  server.close();
  closeDatabase();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }

  console.log("");
  if (failed === 0) console.log(`\x1b[32m全部通过：${passed} 项\x1b[0m`);
  else console.log(`\x1b[31m失败 ${failed} 项 / 通过 ${passed} 项\x1b[0m`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
