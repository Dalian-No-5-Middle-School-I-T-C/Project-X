/**
 * 演示考试数据种子脚本
 *
 * 用法（在仓库根目录）:
 *   npx tsx testdata/demo-exams/scripts/seed.ts
 *   PROJECTX_DB_PATH=/path/to.db npx tsx testdata/demo-exams/scripts/seed.ts
 *
 * 可重复运行：会先清理「演示-」前缀数据。
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeDatabase, ensureDefaultAdmin, getDatabase, closeDatabase } from "../../../src/server/db/index.ts";
import { UserRepository } from "../../../src/server/repositories/UserRepository.ts";
import { ClassRepository } from "../../../src/server/repositories/ClassRepository.ts";
import { ROLE_IDS } from "../../../src/server/auth/permissions.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

const DEMO_PREFIX = "演示-";
const CARD_ID_PREFIX = "88000";
const STUDENT_NUMBERS = [
  "20260101", "20260102", "20260103", "20260104",
  "20260105", "20260106", "20260107", "20260108",
  "20260109", "20260110", "20260111", "20260112",
  "20260113", "20260114", "20260115", "20260116"
];
const STUDENT_NAMES = [
  "张明", "李华", "王芳", "刘强", "陈静", "赵伟", "孙丽", "周杰",
  "吴敏", "郑涛", "钱磊", "冯雪", "褚亮", "卫红", "蒋浩", "沈婷"
];

interface ExamSpec {
  cardId: string;
  name: string;
  subject: string;
  examDate: string;
  fullScore: number;
  scores: Record<string, number>;
  withQuestions?: boolean;
}

const WEEK_EXAMS: ExamSpec[] = [
  {
    cardId: "88000001", name: `${DEMO_PREFIX}语文`, subject: "语文", examDate: "2026-06-16", fullScore: 150,
    scores: {
      "20260101": 132, "20260102": 125, "20260103": 118, "20260104": 140,
      "20260105": 128, "20260106": 115, "20260107": 122, "20260108": 135,
      "20260109": 130, "20260110": 120, "20260111": 128, "20260112": 116,
      "20260113": 124, "20260114": 138, "20260115": 121, "20260116": 127
    }
  },
  {
    cardId: "88000002", name: `${DEMO_PREFIX}数学`, subject: "数学", examDate: "2026-06-17", fullScore: 150,
    withQuestions: true,
    scores: {
      "20260101": 145, "20260102": 128, "20260103": 128, "20260104": 138,
      "20260105": 120, "20260106": 110, "20260107": 125, "20260108": 142,
      "20260109": 128, "20260110": 128, "20260111": 115, "20260112": 130,
      "20260113": 122, "20260114": 136, "20260115": 118, "20260116": 124
    }
  },
  {
    cardId: "88000003", name: `${DEMO_PREFIX}英语`, subject: "英语", examDate: "2026-06-18", fullScore: 150,
    scores: {
      "20260101": 128, "20260102": 135, "20260103": 122, "20260104": 130,
      "20260105": 118, "20260106": 125, "20260107": 140, "20260108": 115,
      "20260109": 132, "20260110": 128, "20260111": 120, "20260112": 138,
      "20260113": 126, "20260114": 122, "20260115": 134, "20260116": 119
    }
  },
  {
    cardId: "88000004", name: `${DEMO_PREFIX}物理`, subject: "物理", examDate: "2026-06-19", fullScore: 100,
    scores: {
      "20260101": 88, "20260102": 76, "20260103": 82, "20260104": 91,
      "20260105": 85, "20260106": 70, "20260107": 78, "20260108": 92,
      "20260109": 80, "20260110": 76, "20260111": 88, "20260112": 74,
      "20260113": 82, "20260114": 90, "20260115": 77, "20260116": 84
    }
  },
  {
    cardId: "88000005", name: `${DEMO_PREFIX}化学`, subject: "化学", examDate: "2026-06-20", fullScore: 100,
    scores: {
      "20260101": 85, "20260102": 78, "20260103": 80, "20260104": 88,
      "20260105": 72, "20260106": 75, "20260107": 82,
      "20260109": 79, "20260110": 83, "20260111": 76, "20260112": 81,
      "20260113": 77, "20260114": 86, "20260115": 74, "20260116": 80
    }
  },
  {
    cardId: "88000006", name: `${DEMO_PREFIX}生物`, subject: "生物", examDate: "2026-06-21", fullScore: 100,
    scores: {
      "20260101": 90, "20260102": 82, "20260103": 85, "20260104": 88,
      "20260105": 78, "20260106": 80, "20260107": 86, "20260108": 84,
      "20260109": 81, "20260110": 79, "20260111": 83, "20260112": 77,
      "20260113": 85, "20260114": 89, "20260115": 82
    }
  }
];

const PRIOR_MATH_EXAM: ExamSpec = {
  cardId: "88000008", name: `${DEMO_PREFIX}数学月考`, subject: "数学", examDate: "2026-05-20", fullScore: 150,
  scores: {
    "20260101": 130, "20260102": 120, "20260103": 125, "20260104": 135,
    "20260105": 115, "20260106": 105, "20260107": 118, "20260108": 138,
    "20260109": 122, "20260110": 118, "20260111": 110, "20260112": 125,
    "20260113": 115, "20260114": 128, "20260115": 112, "20260116": 120
  }
};

const OUTSIDE_WEEK_EXAM: ExamSpec = {
  cardId: "88000007", name: `${DEMO_PREFIX}历史`, subject: "历史", examDate: "2026-06-10", fullScore: 100,
  scores: {
    "20260101": 78, "20260102": 85, "20260103": 72, "20260104": 88,
    "20260105": 80, "20260106": 76, "20260107": 82, "20260108": 90,
    "20260109": 74, "20260110": 86, "20260111": 79, "20260112": 83,
    "20260113": 77, "20260114": 84, "20260115": 81, "20260116": 75
  }
};

function tableExists(db: ReturnType<typeof getDatabase>, name: string): boolean {
  const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  return Boolean(row);
}

function ensureCrossExamTables(db: ReturnType<typeof getDatabase>): void {
  if (!tableExists(db, "exam_group_items")) {
    db.exec(`
      CREATE TABLE exam_group_items (
        group_id      INTEGER NOT NULL REFERENCES exam_groups(id) ON DELETE CASCADE,
        exam_id       INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
        sort_order    INTEGER DEFAULT 0,
        PRIMARY KEY (group_id, exam_id)
      );
      CREATE INDEX IF NOT EXISTS idx_exam_group_items_exam ON exam_group_items(exam_id);
    `);
  }
}

function linkGroupExams(db: ReturnType<typeof getDatabase>, groupId: number, examIds: number[]): void {
  const insertMember = db.prepare(
    "INSERT OR IGNORE INTO exam_group_members (group_id, exam_id, sort_order) VALUES (?, ?, ?)"
  );
  examIds.forEach((id, i) => insertMember.run(groupId, id, i));

  if (tableExists(db, "exam_group_items")) {
    const insertItem = db.prepare(
      "INSERT OR IGNORE INTO exam_group_items (group_id, exam_id, sort_order) VALUES (?, ?, ?)"
    );
    examIds.forEach((id, i) => insertItem.run(groupId, id, i));
  }
}

function cleanupDemoData(db: ReturnType<typeof getDatabase>): void {
  const demoExamIds = (db.prepare("SELECT id FROM exams WHERE name LIKE ?").all(`${DEMO_PREFIX}%`) as Array<{ id: number }>).map((r) => r.id);
  const demoGroupIds = (db.prepare("SELECT id FROM exam_groups WHERE name LIKE ?").all(`${DEMO_PREFIX}%`) as Array<{ id: number }>).map((r) => r.id);

  if (demoGroupIds.length > 0) {
    const ph = demoGroupIds.map(() => "?").join(",");
    db.prepare(`DELETE FROM exam_group_members WHERE group_id IN (${ph})`).run(...demoGroupIds);
    if (tableExists(db, "exam_group_items")) {
      db.prepare(`DELETE FROM exam_group_items WHERE group_id IN (${ph})`).run(...demoGroupIds);
    }
    db.prepare(`DELETE FROM exam_groups WHERE id IN (${ph})`).run(...demoGroupIds);
  }

  if (demoExamIds.length > 0) {
    const ph = demoExamIds.map(() => "?").join(",");
    db.prepare(`DELETE FROM question_scores WHERE exam_id IN (${ph})`).run(...demoExamIds);
    db.prepare(`DELETE FROM student_scores WHERE exam_id IN (${ph})`).run(...demoExamIds);
    db.prepare(`DELETE FROM exams WHERE id IN (${ph})`).run(...demoExamIds);
  }

  for (let i = 1; i <= 8; i++) {
    db.prepare("DELETE FROM answer_cards WHERE id = ?").run(`${CARD_ID_PREFIX}${String(i).padStart(3, "0")}`);
  }

  const demoStudentIds = (db.prepare(
    `SELECT id FROM users WHERE student_number IN (${STUDENT_NUMBERS.map(() => "?").join(",")})`
  ).all(...STUDENT_NUMBERS) as Array<{ id: number }>).map((r) => r.id);

  if (demoStudentIds.length > 0) {
    const ph = demoStudentIds.map(() => "?").join(",");
    db.prepare(`DELETE FROM class_students WHERE student_id IN (${ph})`).run(...demoStudentIds);
    db.prepare(`DELETE FROM users WHERE id IN (${ph})`).run(...demoStudentIds);
  }

  db.prepare("DELETE FROM users WHERE username = 'demo-teacher'").run();
  db.prepare("DELETE FROM classes WHERE name IN ('演示1班', '演示2班')").run();
  db.prepare("DELETE FROM grades WHERE name = '高一(演示)'").run();
}

function seedQuestionScores(
  db: ReturnType<typeof getDatabase>,
  examId: number,
  studentIdByNumber: Map<string, number>,
  scores: Record<string, number>
): void {
  const insertQ = db.prepare(`
    INSERT INTO question_scores (exam_id, student_id, question_number, score, max_score, score_type)
    VALUES (?, ?, ?, ?, ?, 'objective')
  `);
  for (const [num, total] of Object.entries(scores)) {
    if (total <= 0) continue;
    const sid = studentIdByNumber.get(num);
    if (!sid) continue;
    const perQ = Math.floor(total / 5);
    const remainder = total - perQ * 5;
    for (let q = 1; q <= 5; q++) {
      const score = q === 5 ? perQ + remainder : perQ;
      insertQ.run(examId, sid, q, score, 30);
    }
  }
}

export async function seedDemoExams(dbPath?: string): Promise<void> {
  if (dbPath) process.env.PROJECTX_DB_PATH = dbPath;
  if (!process.env.PROJECTX_DB_PATH) {
    process.env.PROJECTX_DB_PATH = path.join(REPO_ROOT, "data", "projectx.db");
  }

  console.log(`[seed] 数据库: ${process.env.PROJECTX_DB_PATH}`);
  initializeDatabase();
  await ensureDefaultAdmin();

  const db = getDatabase();
  ensureCrossExamTables(db);
  const userRepo = new UserRepository();
  const classRepo = new ClassRepository();

  cleanupDemoData(db);

  const grade = classRepo.createGrade("高一(演示)", 1);
  const class1 = classRepo.createClass(grade.id, "演示1班", 1);
  const class2 = classRepo.createClass(grade.id, "演示2班", 2);

  await userRepo.createUser({
    username: "demo-teacher",
    password: "teacher123",
    name: "演示教师",
    role_id: ROLE_IDS.TEACHER,
    subject: "数学"
  });

  const batch = await userRepo.batchCreateStudents(
    STUDENT_NUMBERS.map((num, i) => ({
      username: num,
      name: STUDENT_NAMES[i],
      student_number: num
    }))
  );
  console.log(`[seed] 学生: 新增 ${batch.created}，跳过 ${batch.skipped}`);

  const studentIdByNumber = new Map<string, number>();
  for (const num of STUDENT_NUMBERS) {
    const row = db.prepare("SELECT id FROM users WHERE student_number = ?").get(num) as { id: number } | undefined;
    if (row) studentIdByNumber.set(num, row.id);
  }

  classRepo.addStudents(class1.id, STUDENT_NUMBERS.slice(0, 8).map((n) => studentIdByNumber.get(n)!));
  classRepo.addStudents(class2.id, STUDENT_NUMBERS.slice(8).map((n) => studentIdByNumber.get(n)!));

  const insertCard = db.prepare(`
    INSERT INTO answer_cards (id, title, subject_label, exam_date)
    VALUES (?, ?, ?, ?)
  `);
  const insertExam = db.prepare(`
    INSERT INTO exams (name, card_id, grade_id, subject, start_time, status, created_by)
    VALUES (?, ?, ?, ?, ?, 'closed', (SELECT id FROM users WHERE username = 'admin'))
  `);
  const insertScore = db.prepare(`
    INSERT INTO student_scores (exam_id, student_id, objective_score, subjective_score, total_score)
    VALUES (?, ?, ?, 0, ?)
  `);

  const weekExamIds: number[] = [];

  function seedExam(spec: ExamSpec): number {
    insertCard.run(spec.cardId, spec.name, spec.subject, spec.examDate);
    const info = insertExam.run(spec.name, spec.cardId, grade.id, spec.subject, spec.examDate);
    const examId = Number(info.lastInsertRowid);

    for (const [num, total] of Object.entries(spec.scores)) {
      if (total <= 0) continue;
      const sid = studentIdByNumber.get(num);
      if (sid) insertScore.run(examId, sid, total, total);
    }
    if (spec.withQuestions) seedQuestionScores(db, examId, studentIdByNumber, spec.scores);
    return examId;
  }

  seedExam(PRIOR_MATH_EXAM);
  for (const spec of WEEK_EXAMS) weekExamIds.push(seedExam(spec));
  seedExam(OUTSIDE_WEEK_EXAM);

  const groupInfo = db.prepare(`
    INSERT INTO exam_groups (name, description, grade_id, tag, status, total_score_mode, only_full_participants, created_by)
    VALUES (?, ?, ?, '模考', 'active', 'raw', 0, (SELECT id FROM users WHERE username = 'admin'))
  `).run(`${DEMO_PREFIX}2026高考摸底大考`, "语数英物化生六科联考演示数据", grade.id);
  linkGroupExams(db, Number(groupInfo.lastInsertRowid), weekExamIds);

  const crossInfo = db.prepare(`
    INSERT INTO exam_groups (name, source, start_date, end_date, created_by)
    VALUES (?, 'week', '2026-06-16', '2026-06-22', (SELECT id FROM users WHERE username = 'admin'))
  `).run(`${DEMO_PREFIX}第25周考试包`);
  linkGroupExams(db, Number(crossInfo.lastInsertRowid), weekExamIds);

  console.log("[seed] 完成: 8 场考试, 16 名学生, 大考合集 + 跨考已存组");
}

async function main(): Promise<void> {
  await seedDemoExams();
  closeDatabase();
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
