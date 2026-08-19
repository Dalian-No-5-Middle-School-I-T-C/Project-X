/**
 * 周报告 UI 演示数据：让「成绩分析 → 周报」同时展示 已发布（上周）+ 未发布顺延（本周）。
 * 仅用于浏览器验收，不参与回归套件。
 * 运行：npx tsx scripts/weekly-audit-ui-seed.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmpDir = mkdtempSync(path.join(tmpdir(), "projectx-weekly-ui-"));
process.env.PROJECTX_DB_PATH = path.join(tmpDir, "ui.db");
delete process.env.PROJECTX_MARIADB_HOST;
delete process.env.PROJECTX_MYSQL_HOST;

const { initializeDatabase, ensureDefaultAdmin, getDatabase } = await import("../src/server/db/index");
const { seedDemoData } = await import("../src/server/services/DemoDataService");
const { getWeekWindow, weekPublishAt, WeeklyAuditService } = await import("../src/server/services/WeeklyAuditService");

initializeDatabase();
await ensureDefaultAdmin();
await seedDemoData();
const db = getDatabase();

const gradeId = (db.prepare("SELECT id FROM grades WHERE name = '高一(演示)'").get() as { id: number }).id;
const STUDENT_NUMS = Array.from({ length: 16 }, (_, i) => `202601${String(i + 1).padStart(2, "0")}`);
const total = [138, 125, 118, 140, 128, 115, 122, 135, 130, 120, 128, 116, 124, 132, 121, 127];

function addDaysLocal(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

let seq = 1;
function insertQuizExam(name: string, subject: string, dateStr: string, totals: number[]): number {
  const cardId = `UI${String(seq++).padStart(7, "0")}`;
  db.prepare("INSERT INTO answer_cards (id, title, subject_label, exam_date) VALUES (?, ?, ?, ?)").run(cardId, name, subject, dateStr);
  const info = db.prepare(`
    INSERT INTO exams (name, card_id, grade_id, subject, start_time, status, closed_at, exam_mode, created_by)
    VALUES (?, ?, ?, ?, ?, 'closed', CURRENT_TIMESTAMP, 'quiz', (SELECT id FROM users WHERE username = 'admin'))
  `).run(name, cardId, gradeId, subject, dateStr);
  const examId = Number(info.lastInsertRowid);
  for (const [i, t] of totals.entries()) {
    const sid = (db.prepare("SELECT id FROM users WHERE student_number = ?").get(STUDENT_NUMS[i]) as { id: number }).id;
    db.prepare("INSERT INTO student_scores (exam_id, student_id, objective_score, subjective_score, total_score) VALUES (?, ?, ?, 0, ?)").run(examId, sid, t, t);
    const perQ = Math.floor(t / 5);
    const qs = [perQ, perQ, perQ, Math.max(0, perQ - 8), Math.min(30, perQ + (t - perQ * 5) + 8)];
    for (let q = 1; q <= 5; q++) {
      db.prepare("INSERT INTO question_scores (exam_id, student_id, question_number, score, max_score, score_type) VALUES (?, ?, ?, ?, 30, 'objective')")
        .run(examId, sid, q, qs[q - 1]);
    }
  }
  return examId;
}

const prevWeek = getWeekWindow(-1);
const curWeek = getWeekWindow(0);

// 上周：3 场完整晨测 → 发布（用上周六 08:00 的假想时钟）
insertQuizExam("晨测-语文", "语文", addDaysLocal(prevWeek.weekStart, 0), total);
insertQuizExam("晨测-数学", "数学", addDaysLocal(prevWeek.weekStart, 1), total);
insertQuizExam("晨测-英语", "英语", addDaysLocal(prevWeek.weekStart, 2), total);
const svc = new WeeklyAuditService();
const prevPublishAt = weekPublishAt(prevWeek.weekStart);
const published = await svc.publishDueWeeks(new Date(prevPublishAt.getTime() + 60_000));
console.log("已发布:", published.published.join("、"));

// 本周：1 场考试但未出分（周五数学未完成 → 顺延）
insertQuizExam("晨测-周五数学", "数学", addDaysLocal(curWeek.weekStart, 4), []);

console.log(`UI DB: ${process.env.PROJECTX_DB_PATH}`);
console.log(`发布时刻(上周): ${prevPublishAt.toLocaleString()} | 发布时刻(本周): ${weekPublishAt(curWeek.weekStart).toLocaleString()}`);