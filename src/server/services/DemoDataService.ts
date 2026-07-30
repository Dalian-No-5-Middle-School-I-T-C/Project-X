/**
 * 演示考试数据核心逻辑（从 testdata/demo-exams/scripts/ 迁入，供服务端 API 与 CLI 复用）
 *
 * - seedDemoData(): 幂等导入「演示-」前缀数据（8 场考试、16 名学生、网阅演示、2 个合集），
 *   不覆盖现有真实数据，可重复执行。
 * - clearDemoData(): 仅清除「演示-」前缀数据。
 *
 * 假定调用方已完成 initializeDatabase()；仅支持 SQLite 方言。
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type Database from "better-sqlite3";
import { getDatabase, resolveAnswerCardDataDir, type DbAdapter } from "../db";
import { UserRepository } from "../repositories/UserRepository";
import { ClassRepository } from "../repositories/ClassRepository";
import { ROLE_IDS } from "../auth/permissions";
import { rebalanceWorkload } from "./ReviewAssignmentService";

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

function tableExists(db: Database.Database, name: string): boolean {
  const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  return Boolean(row);
}

function ensureCrossExamTables(db: Database.Database): void {
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

function linkGroupExams(db: Database.Database, groupId: number, examIds: number[]): void {
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

export interface ClearDemoStats {
  removedExams: number;
  removedGroups: number;
  removedStudents: number;
}

function cleanupDemoData(db: Database.Database): ClearDemoStats {
  // 演示考试 / 考试组仍按「演示-」前缀识别（前缀独特，不存在与真实数据冲突的风险）。
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
    db.prepare(`DELETE FROM answer_block_crops WHERE exam_id IN (${ph})`).run(...demoExamIds);
    db.prepare(`DELETE FROM review_assignments WHERE exam_id IN (${ph})`).run(...demoExamIds);
    db.prepare(`DELETE FROM block_grading_config WHERE exam_id IN (${ph})`).run(...demoExamIds);
    db.prepare(`DELETE FROM exams WHERE id IN (${ph})`).run(...demoExamIds);
  }

  // v1.9.6: 答题卡 / 用户 / 班级 / 年级 按归属标记 is_demo=1 清理，不再依赖硬编码 ID /
  // 学号 / 用户名 / 名称，避免误删同名真实数据。安全语义：is_demo=0 的真实记录永不被清理。
  const removedCards = db.prepare("DELETE FROM answer_cards WHERE is_demo = 1").run().changes;

  // 收集待清理的演示用户 id（学生 + 演示教师），先解除 class_students 关联再删用户
  const demoStudentIds = (db.prepare(
    "SELECT id FROM users WHERE is_demo = 1"
  ).all() as Array<{ id: number }>).map((r) => r.id);
  const removedStudents = demoStudentIds.length;

  if (demoStudentIds.length > 0) {
    const ph = demoStudentIds.map(() => "?").join(",");
    db.prepare(`DELETE FROM class_students WHERE student_id IN (${ph})`).run(...demoStudentIds);
    db.prepare(`DELETE FROM teacher_classes WHERE teacher_id IN (${ph})`).run(...demoStudentIds);
    db.prepare(`DELETE FROM users WHERE id IN (${ph})`).run(...demoStudentIds);
  }

  // 删演示班级在前，删演示年级在后（classes.grade_id → grades.id 外键级联）。
  // v1.9.6 安全收窄：仅当演示年级下不存在 is_demo=0 的真实班级时才删除演示年级，
  // 避免外键 ON DELETE CASCADE 顺带扫掉挂在演示年级下的真实班级。
  db.prepare("DELETE FROM classes WHERE is_demo = 1").run();
  const hasRealClassUnderDemoGrade = Boolean(
    db.prepare(
      "SELECT 1 FROM classes WHERE is_demo = 0 AND grade_id IN (SELECT id FROM grades WHERE is_demo = 1) LIMIT 1"
    ).get()
  );
  if (!hasRealClassUnderDemoGrade) {
    db.prepare("DELETE FROM grades WHERE is_demo = 1").run();
  } else {
    // 边界保护：保留有真实班级挂靠的演示年级，避免级联误删真实数据。
    console.warn(
      "[clearDemoData] 检测到真实班级挂靠在演示年级下，已保留该演示年级以避免级联删除真实班级，请手动迁移真实班级后再次清理。"
    );
  }

  // removedCards 不在返回值中体现（仅作日志用），避免改动 ClearDemoStats 接口签名
  void removedCards;

  return {
    removedExams: demoExamIds.length,
    removedGroups: demoGroupIds.length,
    removedStudents
  };
}

/** 清除全部「演示-」前缀数据（不动真实数据）。假定 DB 已初始化。 */
export function clearDemoData(): ClearDemoStats {
  return cleanupDemoData(getDatabase());
}

// 演示客观题答案（5 道单选，4 个选项），供逐题选项分析演示
const DEMO_ANSWER_KEYS: Record<number, string[]> = { 1: ["A"], 2: ["B"], 3: ["C"], 4: ["D"], 5: ["A"] };
const DEMO_OPTIONS = ["A", "B", "C", "D"];

/** 为演示答题卡补一个客观题块 + 标准答案，使选项分析端点能解析题元数据 */
function ensureDemoObjectiveBlock(db: Database.Database, cardId: string): void {
  const blockId = `${cardId}-obj`;
  db.prepare(`
    INSERT OR IGNORE INTO objective_blocks
      (id, card_id, sort_order, title, question_start, question_count, option_count, mode, score_per_question)
    VALUES (?, ?, 0, '选择题', 1, 5, 4, 'single', 30)
  `).run(blockId, cardId);
  const insertKey = db.prepare(
    "INSERT OR IGNORE INTO objective_answer_keys (block_id, question_number, correct_options) VALUES (?, ?, ?)"
  );
  for (const [q, key] of Object.entries(DEMO_ANSWER_KEYS)) {
    insertKey.run(blockId, Number(q), JSON.stringify(key));
  }
}

/**
 * 生成学生所选选项（确定性伪随机，重播种结果稳定）：
 * 得分 ≥ 满分 80% 判为答对 → 选标准答案；否则选一个干扰项，
 * 每题设一个「热门干扰项」（约 55% 错选集中于此），让选项分布图更有讲解价值。
 */
function demoSelectedOptions(examId: number, studentId: number, q: number, score: number, maxScore: number): string[] {
  const key = DEMO_ANSWER_KEYS[q] ?? ["A"];
  if (score >= maxScore * 0.8) return [...key];
  const wrongs = DEMO_OPTIONS.filter((o) => !key.includes(o));
  const h = (examId * 31 + studentId * 7 + q * 13) % 100;
  const popular = wrongs[q % wrongs.length];
  return [h < 55 ? popular : wrongs[h % wrongs.length]];
}

function seedQuestionScores(
  db: Database.Database,
  examId: number,
  cardId: string,
  studentIdByNumber: Map<string, number>,
  scores: Record<string, number>
): void {
  ensureDemoObjectiveBlock(db, cardId);
  const insertQ = db.prepare(`
    INSERT INTO question_scores (exam_id, student_id, question_number, score, max_score, score_type, selected_options)
    VALUES (?, ?, ?, ?, ?, 'objective', ?)
  `);
  for (const [num, total] of Object.entries(scores)) {
    if (total <= 0) continue;
    const sid = studentIdByNumber.get(num);
    if (!sid) continue;
    const perQ = Math.floor(total / 5);
    const remainder = total - perQ * 5;
    for (let q = 1; q <= 5; q++) {
      const score = q === 5 ? perQ + remainder : perQ;
      insertQ.run(examId, sid, q, score, 30, JSON.stringify(demoSelectedOptions(examId, sid, q, score, 30)));
    }
  }
}

export interface SeedDemoStats {
  studentsCreated: number;
  studentsSkipped: number;
  exams: number;
  groups: number;
}

/**
 * 幂等导入演示数据：先清理「演示-」前缀数据再重建。
 * 假定 DB 已初始化且 admin 用户已存在（服务端运行态天然满足；CLI 需先 ensureDefaultAdmin）。
 */
export async function seedDemoData(): Promise<SeedDemoStats> {
  const db = getDatabase();
  ensureCrossExamTables(db);
  const userRepo = new UserRepository();
  const classRepo = new ClassRepository();

  cleanupDemoData(db);

  const grade = await classRepo.createGrade("高一(演示)", 1);
  const class1 = await classRepo.createClass(grade.id, "演示1班", 1);
  const class2 = await classRepo.createClass(grade.id, "演示2班", 2);

  // v1.9.6: 标记刚创建的演示年级/班级为 is_demo=1，使 clearDemoData() 按 is_demo 标记
  // 清理，不依赖硬编码名称。即使真实班级/年级同名也不被误删。
  db.prepare("UPDATE grades SET is_demo = 1 WHERE id = ?").run(grade.id);
  db.prepare("UPDATE classes SET is_demo = 1 WHERE id = ?").run(class1.id);
  db.prepare("UPDATE classes SET is_demo = 1 WHERE id = ?").run(class2.id);

  await userRepo.createUser({
    username: "demo-teacher",
    password: "teacher123",
    name: "演示教师",
    role_id: ROLE_IDS.TEACHER,
    subject: "数学"
  });

  await userRepo.createUser({
    username: "demo-teacher-2",
    password: "teacher123",
    name: "演示教师乙",
    role_id: ROLE_IDS.TEACHER,
    subject: "数学"
  });

  // v1.9.6: 把刚创建的演示教师打标记（按唯一用户名匹配，不影响真实账号）
  db.prepare("UPDATE users SET is_demo = 1 WHERE username IN ('demo-teacher', 'demo-teacher-2')").run();

  // 显式传 password=学号：batchCreateStudents 默认生成随机不可推导密码，
  // 此处覆盖为可读值以便 verify.ts 能用学号登录验证 学生端功能（与 manifest 一致）。
  const batch = await userRepo.batchCreateStudents(
    STUDENT_NUMBERS.map((num, i) => ({
      username: num,
      name: STUDENT_NAMES[i],
      student_number: num,
      password: num
    }))
  );
  console.log(`[seed] 学生: 新增 ${batch.created}，跳过 ${batch.skipped}`);

  // v1.9.7: 仅对本次新建的演示学生打 is_demo=1（按 createdIds 精确匹配）。
  // 不能按学号集合盲打标：若真实学生恰好占用固定演示学号，
  // batchCreateStudents 会跳过创建，盲打标会把该真实学生标成演示账号，
  // 后续 clearDemoData 会删除真实账号（P0 数据丢失风险）。
  const studentIdByNumber = new Map<string, number>();
  if (batch.createdIds.length > 0) {
    const createdPh = batch.createdIds.map(() => "?").join(",");
    db.prepare(`UPDATE users SET is_demo = 1 WHERE id IN (${createdPh})`).run(...batch.createdIds);
    // 演示班级分班 / 成绩种子同样只覆盖本次新建的演示学生，被跳过的真实学生不入演示班级、不写演示成绩
    const createdRows = db.prepare(
      `SELECT id, student_number FROM users WHERE id IN (${createdPh})`
    ).all(...batch.createdIds) as Array<{ id: number; student_number: string | null }>;
    for (const row of createdRows) {
      if (row.student_number) studentIdByNumber.set(row.student_number, row.id);
    }
  }

  const class1StudentIds = STUDENT_NUMBERS.slice(0, 8)
    .map((n) => studentIdByNumber.get(n))
    .filter((id): id is number => typeof id === "number");
  const class2StudentIds = STUDENT_NUMBERS.slice(8)
    .map((n) => studentIdByNumber.get(n))
    .filter((id): id is number => typeof id === "number");
  await classRepo.addStudents(class1.id, class1StudentIds);
  await classRepo.addStudents(class2.id, class2StudentIds);

  const insertCard = db.prepare(`
    INSERT INTO answer_cards (id, title, subject_label, exam_date, is_demo)
    VALUES (?, ?, ?, ?, 1)
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
  let examCount = 0;

  function seedExam(spec: ExamSpec): number {
    insertCard.run(spec.cardId, spec.name, spec.subject, spec.examDate);
    const info = insertExam.run(spec.name, spec.cardId, grade.id, spec.subject, spec.examDate);
    const examId = Number(info.lastInsertRowid);
    examCount += 1;

    for (const [num, total] of Object.entries(spec.scores)) {
      if (total <= 0) continue;
      const sid = studentIdByNumber.get(num);
      if (sid) insertScore.run(examId, sid, total, total);
    }
    if (spec.withQuestions) seedQuestionScores(db, examId, spec.cardId, studentIdByNumber, spec.scores);
    return examId;
  }

  seedExam(PRIOR_MATH_EXAM);
  for (const spec of WEEK_EXAMS) weekExamIds.push(seedExam(spec));
  seedExam(OUTSIDE_WEEK_EXAM);

  // 网阅打分面板 DEV 演示数据（v1.9.4 路径 B 测试入口）
  const teacherRow = db.prepare("SELECT id FROM users WHERE username = 'demo-teacher'").get() as { id: number } | undefined;
  const teacher2Row = db.prepare("SELECT id FROM users WHERE username = 'demo-teacher-2'").get() as { id: number } | undefined;
  if (teacherRow) {
    await seedReviewDemo(db, grade, studentIdByNumber, teacherRow.id, teacher2Row?.id);
    examCount += 1;
  }

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

  // 保险写入全局设置默认键（迁移 v26 已写入；若库为空或被清理则补齐），便于 verify 校验
  const ensureSetting = db.prepare("INSERT OR IGNORE INTO system_settings (`key`, value) VALUES (?, ?)");
  ensureSetting.run("require_original_paper", "1");
  ensureSetting.run("highlight_missing_paper", "1");

  console.log(`[seed] 完成: ${examCount} 场考试, 16 名学生, 大考合集 + 跨考已存组`);
  return {
    studentsCreated: batch.created,
    studentsSkipped: batch.skipped,
    exams: examCount,
    groups: 2
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 网阅打分面板演示种子（自 testdata/demo-exams/scripts/seed-review.ts 迁入）
// ────────────────────────────────────────────────────────────────────────────

const REVIEW_CARD_ID = "88000999";
const REVIEW_EXAM_NAME = "演示-网阅测试";

// ---- 自包含占位图（生成有效 PNG，避免依赖外部图片/二进制） ----
const CRC_TABLE: number[] = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function makePlaceholderPng(w: number, h: number, rgb: [number, number, number]): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = rgb[0];
      raw[o + 1] = rgb[1];
      raw[o + 2] = rgb[2];
    }
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", Buffer.alloc(0))]);
}

function ensurePlaceholderImage(): string {
  const dir = path.join(resolveAnswerCardDataDir(), "recognition", "crops", "demo-review");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "placeholder.png");
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, makePlaceholderPng(240, 320, [228, 228, 232]));
  }
  // 存库用相对路径（服务进程 cwd = 仓库根，图片路由按 cwd 解析）
  return path.relative(process.cwd(), file).split(path.sep).join("/");
}

interface ReviewBlockSpec {
  blockId: string;
  title: string;
  type: string;
  questions: number[];
  maxScorePerQuestion: number;
  hasHalf: number;
}

const REVIEW_BLOCKS: ReviewBlockSpec[] = [
  {
    blockId: "A",
    title: "解答题A（满分15·含0.5）",
    type: "subjective",
    questions: [1, 2, 3],
    maxScorePerQuestion: 5,
    hasHalf: 1
  },
  {
    blockId: "B",
    title: "解答题B（满分25）",
    type: "subjective",
    questions: [4, 5, 6, 7, 8],
    maxScorePerQuestion: 5,
    hasHalf: 0
  }
];

// 与上方 STUDENT_NUMBERS 对应，取前 8 名
const STUDENT_NUMBERS_FOR_REVIEW = STUDENT_NUMBERS.slice(0, 8);

async function seedReviewDemo(
  db: Database.Database,
  grade: { id: number },
  studentIdByNumber: Map<string, number>,
  teacherId: number,
  secondTeacherId?: number
): Promise<void> {
  // 1. 答题卡（submitReviewCropScores 需要 card 存在，body 可空）
  db.prepare(
    "INSERT OR IGNORE INTO answer_cards (id, title, subject_label, exam_date, is_demo) VALUES (?, ?, ?, ?, 1)"
  ).run(REVIEW_CARD_ID, "演示-网阅卡", "数学", "2026-06-25");

  // 2. 考试（review_enabled=1）
  const examInfo = db.prepare(
    `INSERT INTO exams (name, card_id, grade_id, subject, start_time, status, review_enabled, created_by)
     VALUES (?, ?, ?, ?, ?, 'closed', 1, (SELECT id FROM users WHERE username = 'admin'))`
  ).run(REVIEW_EXAM_NAME, REVIEW_CARD_ID, grade.id, "数学", "2026-06-25");
  const examId = Number(examInfo.lastInsertRowid);

  const imgPath = ensurePlaceholderImage();

  // 取前 8 名学生用于演示（份数适中，便于观察进度条与均衡）
  const studentIds = STUDENT_NUMBERS_FOR_REVIEW.map((num) => studentIdByNumber.get(num)).filter(
    (id): id is number => typeof id === "number"
  );

  const insertCrop = db.prepare(
    `INSERT INTO answer_block_crops
       (id, card_id, exam_id, student_id, student_number, source_type, source_record_id,
        block_id, block_title, block_type, page_number, segment_index,
        question_numbers, rect_json, image_path, width_px, height_px, dpi, status)
     VALUES (?, ?, ?, ?, ?, 'demo', ?, ?, ?, ?, 1, 0, ?, '{}', ?, 240, 320, 300, 'ready')`
  );
  const insertQS = db.prepare(
    `INSERT INTO question_scores
       (exam_id, student_id, question_number, question_id, block_id, score, max_score, score_type, manually_modified, modified_by, modified_at)
     VALUES (?, ?, ?, NULL, ?, 0, ?, 'subjective', 0, (SELECT id FROM users WHERE username = 'admin'), datetime('now'))`
  );
  const insertConfig = db.prepare(
    `INSERT OR IGNORE INTO block_grading_config
       (exam_id, block_id, dispute_threshold, rounding, arbitrator_id, review_mode,
        has_half_point, auto_reassign_no_arb, workload_balance_threshold,
        scoring_mode, score_distribution)
     VALUES (?, ?, 2, 'ceil', NULL, 1, ?, 1, 4, ?, ?)`
  );
  const insertAssignment = db.prepare(
    `INSERT INTO review_assignments (exam_id, block_id, teacher_id, student_count, assigned_student_ids, auto_assigned)
     VALUES (?, ?, ?, ?, ?, 0)`
  );

  for (const block of REVIEW_BLOCKS) {
    // 题块 A: block_total + proportional（默认）；题块 B: per_question + equal
    const scoringMode = block.blockId === "A" ? "block_total" : "per_question";
    const scoreDist = block.blockId === "A" ? "proportional" : "equal";
    insertConfig.run(examId, block.blockId, block.hasHalf, scoringMode, scoreDist);
  }

  // 分配策略：
  // - 题块 B（满分25，位值模式）：全部 8 份给 demo-teacher（单教师，无均衡演示）。
  // - 题块 A（满分15，枚举模式）：demo-teacher 5 份 + demo-teacher-2 1 份，2 份暂不分配；
  //   随后 rebalanceWorkload 会把未分配卷吸收到份数最少的教师（演示「进度条加卷 + 份数差收敛」）。
  const blockAFirstTeacher = studentIds.slice(0, 5);
  const blockASecondTeacher = secondTeacherId != null ? studentIds.slice(5, 6) : [];
  if (secondTeacherId != null) {
    insertAssignment.run(examId, "A", teacherId, blockAFirstTeacher.length, JSON.stringify(blockAFirstTeacher));
    insertAssignment.run(examId, "A", secondTeacherId, blockASecondTeacher.length, JSON.stringify(blockASecondTeacher));
  } else {
    // 无第二教师时退化为单教师全量分配
    insertAssignment.run(examId, "A", teacherId, studentIds.length, JSON.stringify(studentIds));
  }
  insertAssignment.run(examId, "B", teacherId, studentIds.length, JSON.stringify(studentIds));

  for (const studentId of studentIds) {
    const studentNumberRow = db.prepare("SELECT student_number FROM users WHERE id = ?").get(studentId) as
      | { student_number: string | null }
      | undefined;
    const studentNumber = studentNumberRow?.student_number ?? null;
    for (const block of REVIEW_BLOCKS) {
      const cropId = `demo-${examId}-${block.blockId}-${studentId}`;
      insertCrop.run(
        cropId,
        REVIEW_CARD_ID,
        examId,
        studentId,
        studentNumber,
        `demo-${examId}-${studentId}`,
        block.blockId,
        block.title,
        block.type,
        JSON.stringify(block.questions),
        imgPath
      );
      for (const q of block.questions) {
        insertQS.run(examId, studentId, q, block.blockId, block.maxScorePerQuestion);
      }
    }
  }

  // 题块 A 工作量均衡：把 8 份卷在已分配教师间收敛到「份数差 ≤ 4」
  if (secondTeacherId != null) {
    await rebalanceWorkload(examId, "A", makeSyncAdapter(db));
  }

  const aAssign = db.prepare("SELECT teacher_id, student_count, auto_assigned FROM review_assignments WHERE exam_id = ? AND block_id = 'A' ORDER BY teacher_id").all(examId) as Array<{ teacher_id: number; student_count: number; auto_assigned: number }>;
  const aSummary = aAssign.map((r) => `教师${r.teacher_id}:${r.student_count}份${r.auto_assigned ? "(含自动追加)" : ""}`).join("，");

  console.log(
    `[seed] 网阅演示: 考试「${REVIEW_EXAM_NAME}」(id=${examId})，题块 A(满分${REVIEW_BLOCKS[0].questions.length * 5}·含0.5) / B(满分${REVIEW_BLOCKS[1].questions.length * 5})。` +
      `题块A分配均衡后：${aSummary}`
  );
}

/** 用同步 better-sqlite3 实例构造 DbAdapter，便于种子逻辑复用服务端 rebalanceWorkload */
function makeSyncAdapter(db: Database.Database): DbAdapter {
  const adapter: DbAdapter = {
    dialect: "sqlite",
    get: <T = any>(sql: string, ...params: any[]) => Promise.resolve((db.prepare(sql).get(...params) as T | null | undefined) ?? null),
    all: <T = any>(sql: string, ...params: any[]) => Promise.resolve(db.prepare(sql).all(...params) as T[]),
    run: (sql, ...params) => {
      const r = db.prepare(sql).run(...params);
      return Promise.resolve({ lastInsertRowid: Number(r.lastInsertRowid), changes: r.changes });
    },
    exec: (sql) => {
      db.exec(sql);
      return Promise.resolve();
    },
    transaction: async (fn) => {
      db.exec("BEGIN");
      try {
        const v = await fn(adapter);
        db.exec("COMMIT");
        return v;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    }
  };
  return adapter;
}
