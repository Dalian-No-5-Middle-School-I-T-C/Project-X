/**
 * 演示考试数据种子脚本
 *
 * 用法: npx tsx scripts/seed-demo-exams.ts
 *
 * 为 v1.5.0 功能测试准备：单科 / 大考 / 跨考、并列排名、缺考、按周打包等。
 * 可重复运行（会先清理上次「演示-」前缀的数据）。
 */

import { initializeDatabase, ensureDefaultAdmin, getDatabase, closeDatabase } from "../src/server/db/index";
import { UserRepository } from "../src/server/repositories/UserRepository";
import { ClassRepository } from "../src/server/repositories/ClassRepository";
import { ROLE_IDS } from "../src/server/auth/permissions";

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
  /** student_number -> total score; omit = absent */
  scores: Record<string, number>;
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
      "20260105": 72, "20260106": 75, "20260107": 82, "20260108": 0, // 缺考
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
      // 20260116 缺考
    }
  }
];

const OUTSIDE_WEEK_EXAM: ExamSpec = {
  cardId: "88000007", name: `${DEMO_PREFIX}历史`, subject: "历史", examDate: "2026-06-10", fullScore: 100,
  scores: {
    "20260101": 78, "20260102": 85, "20260103": 72, "20260104": 88,
    "20260105": 80, "20260106": 76, "20260107": 82, "20260108": 90,
    "20260109": 74, "20260110": 86, "20260111": 79, "20260112": 83,
    "20260113": 77, "20260114": 84, "20260115": 81, "20260116": 75
  }
};

function ensureExamGroupItemsTable(db: ReturnType<typeof getDatabase>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS exam_group_items (
      group_id      INTEGER NOT NULL REFERENCES exam_groups(id) ON DELETE CASCADE,
      exam_id       INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
      sort_order    INTEGER DEFAULT 0,
      PRIMARY KEY (group_id, exam_id)
    );
    CREATE INDEX IF NOT EXISTS idx_exam_group_items_exam ON exam_group_items(exam_id);
  `);
}

function cleanupDemoData(db: ReturnType<typeof getDatabase>): void {
  const demoExamIds = (db.prepare("SELECT id FROM exams WHERE name LIKE ?").all(`${DEMO_PREFIX}%`) as Array<{ id: number }>).map((r) => r.id);
  const demoGroupIds = (db.prepare("SELECT id FROM exam_groups WHERE name LIKE ?").all(`${DEMO_PREFIX}%`) as Array<{ id: number }>).map((r) => r.id);

  if (demoGroupIds.length > 0) {
    const ph = demoGroupIds.map(() => "?").join(",");
    db.prepare(`DELETE FROM exam_group_members WHERE group_id IN (${ph})`).run(...demoGroupIds);
    db.prepare(`DELETE FROM exam_group_items WHERE group_id IN (${ph})`).run(...demoGroupIds);
    db.prepare(`DELETE FROM exam_groups WHERE id IN (${ph})`).run(...demoGroupIds);
  }

  if (demoExamIds.length > 0) {
    const ph = demoExamIds.map(() => "?").join(",");
    db.prepare(`DELETE FROM question_scores WHERE exam_id IN (${ph})`).run(...demoExamIds);
    db.prepare(`DELETE FROM student_scores WHERE exam_id IN (${ph})`).run(...demoExamIds);
    db.prepare(`DELETE FROM exams WHERE id IN (${ph})`).run(...demoExamIds);
  }

  for (let i = 1; i <= 7; i++) {
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

  db.prepare("DELETE FROM classes WHERE name IN ('演示1班', '演示2班')").run();
  db.prepare("DELETE FROM grades WHERE name = '高一(演示)'").run();
}

async function main(): Promise<void> {
  console.log("初始化数据库...");
  initializeDatabase();
  await ensureDefaultAdmin();

  const db = getDatabase();
  ensureExamGroupItemsTable(db);
  const userRepo = new UserRepository();
  const classRepo = new ClassRepository();

  console.log("清理旧演示数据...");
  cleanupDemoData(db);

  console.log("创建年级与班级...");
  const grade = classRepo.createGrade("高一(演示)", 1);
  const class1 = classRepo.createClass(grade.id, "演示1班", 1);
  const class2 = classRepo.createClass(grade.id, "演示2班", 2);

  console.log("创建学生账号（密码 = 学号）...");
  const batch = await userRepo.batchCreateStudents(
    STUDENT_NUMBERS.map((num, i) => ({
      username: num,
      name: STUDENT_NAMES[i],
      student_number: num
    }))
  );
  console.log(`  新增 ${batch.created} 名学生，跳过 ${batch.skipped} 名`);

  const studentIdByNumber = new Map<string, number>();
  for (const num of STUDENT_NUMBERS) {
    const row = db.prepare("SELECT id FROM users WHERE student_number = ?").get(num) as { id: number } | undefined;
    if (row) studentIdByNumber.set(num, row.id);
  }

  const class1Ids = STUDENT_NUMBERS.slice(0, 8).map((n) => studentIdByNumber.get(n)!).filter(Boolean);
  const class2Ids = STUDENT_NUMBERS.slice(8).map((n) => studentIdByNumber.get(n)!).filter(Boolean);
  classRepo.addStudents(class1.id, class1Ids);
  classRepo.addStudents(class2.id, class2Ids);

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

  const examIds: number[] = [];

  function seedExam(spec: ExamSpec): number {
    insertCard.run(spec.cardId, spec.name, spec.subject, spec.examDate);
    const info = insertExam.run(spec.name, spec.cardId, grade.id, spec.subject, spec.examDate);
    const examId = Number(info.lastInsertRowid);
    examIds.push(examId);

    for (const [num, total] of Object.entries(spec.scores)) {
      if (total <= 0) continue;
      const sid = studentIdByNumber.get(num);
      if (sid) insertScore.run(examId, sid, total, total);
    }
    return examId;
  }

  console.log("创建考试与成绩...");
  const weekExamIds: number[] = [];
  for (const spec of WEEK_EXAMS) {
    weekExamIds.push(seedExam(spec));
  }
  seedExam(OUTSIDE_WEEK_EXAM);

  console.log("创建大考合集...");
  const groupInfo = db.prepare(`
    INSERT INTO exam_groups (name, description, grade_id, tag, status, total_score_mode, only_full_participants, created_by)
    VALUES (?, ?, ?, '模考', 'active', 'raw', 0, (SELECT id FROM users WHERE username = 'admin'))
  `).run(
    `${DEMO_PREFIX}2026高考摸底大考`,
    "语数英物化生六科联考演示数据",
    grade.id
  );
  const examGroupId = Number(groupInfo.lastInsertRowid);
  const insertMember = db.prepare("INSERT INTO exam_group_members (group_id, exam_id, sort_order) VALUES (?, ?, ?)");
  weekExamIds.forEach((id, i) => insertMember.run(examGroupId, id, i));

  console.log("创建跨考已存组...");
  const crossInfo = db.prepare(`
    INSERT INTO exam_groups (name, source, start_date, end_date, created_by)
    VALUES (?, 'week', '2026-06-16', '2026-06-22', (SELECT id FROM users WHERE username = 'admin'))
  `).run(`${DEMO_PREFIX}第25周考试包`);
  const crossGroupId = Number(crossInfo.lastInsertRowid);
  const insertItem = db.prepare("INSERT INTO exam_group_items (group_id, exam_id, sort_order) VALUES (?, ?, ?)");
  weekExamIds.forEach((id, i) => insertItem.run(crossGroupId, id, i));

  console.log("\n✅ 演示数据准备完成\n");
  console.log("── 组织结构 ──");
  console.log(`  年级: 高一(演示)`);
  console.log(`  班级: 演示1班 (8人), 演示2班 (8人)`);
  console.log(`  学生: ${STUDENT_NUMBERS[0]} ~ ${STUDENT_NUMBERS[15]}，密码 = 学号`);
  console.log("\n── 考试 (6/16~6/21 同一周，另有 6/10 历史在范围外) ──");
  for (const spec of [...WEEK_EXAMS, OUTSIDE_WEEK_EXAM]) {
    console.log(`  ${spec.name}  ${spec.examDate}  满分${spec.fullScore}`);
  }
  console.log("\n── 测试要点 ──");
  console.log("  • 数学: 李华/王芳/郑涛 同分 128 → 并列排名");
  console.log("  • 化学: 周杰(20260108) 缺考");
  console.log("  • 生物: 沈婷(20260116) 缺考");
  console.log("  • 跨考按周: 2026-06-16 ~ 2026-06-22 应匹配 6 场");
  console.log(`  • 大考合集: ${DEMO_PREFIX}2026高考摸底大考`);
  console.log(`  • 跨考已存组: ${DEMO_PREFIX}第25周考试包`);
  console.log("\n登录: admin / admin123  或  学生用学号登录");

  closeDatabase();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
