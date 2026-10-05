/**
 * 演示考试数据核心逻辑（从 testdata/demo-exams/scripts/ 迁入，供服务端 API 与 CLI 复用）
 *
 * - seedDemoData(): 幂等导入「演示-」前缀数据（8 场考试、16 名学生、网阅演示、2 个合集），
 *   不覆盖现有真实数据，可重复执行。
 * - clearDemoData(): 仅清除「演示-」前缀数据。
 *
 * 假定调用方已完成 initializeDatabase()；SQLite / MariaDB 双方言兼容（DbAdapter）。
 */

import { buildInsertIgnore, generateBootstrapAdminPassword, getMysqlDb, hashPassword, type DbAdapter } from "../db";
import { encryptField } from "../lib/field-crypto";
import { UserRepository } from "../repositories/UserRepository";
import { ClassRepository } from "../repositories/ClassRepository";
import { ROLE_IDS } from "../auth/permissions";
import { seedFillBlankDemo } from "./demo/fillBlankDemo";
import { seedEssayDemo } from "./demo/essayDemo";
import { seedReviewDemo } from "./demo/reviewDemo";
import {
  DEMO_REVIEW_CARD_ID,
  DEMO_VERTICAL_OPTIONS_CARD_ID,
  isDemoCard,
} from "./demo/demoCardIds";
import {
  DEMO_IMPORT_PRODUCTION_CONFIRM,
  DEMO_TEACHER_USERNAMES,
  LEGACY_PUBLIC_DEMO_TEACHER_PASSWORD,
  demoFixedCredentialsEnabled,
  demoProductionImportAllowedByEnv,
} from "./demo/demoDataPolicy";
import { getWeekWindow, WeeklyAuditService } from "./WeeklyAuditService";
import { removeExamAnswerKeyFiles } from "../../apps/answer-card/server/helpers";

const DEMO_PREFIX = "演示-";
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

/* ── 周报演示晨测（exam_mode='quiz'）────────────────────────────────────
 * 目的：让「首页 → 每周考试审计」导入演示数据后立即可测。
 *  - 上上周（-2 周）3 场 + 上周（-1 周）5 场：日期按导入时动态计算（getWeekWindow），
 *    全出分 → 周报自动发布（导入末尾触发 publishDueWeeks），并产生「较上周」对比数据。
 *  - 本周（0 周）1 场未出分 → 展示「报告顺延」状态。
 * 日期永不硬编码，任何时候导入都落在近 5 周窗口内。满分统一 100。
 */
interface QuizExamSpec {
  cardId: string;
  name: string;
  subject: string;
  /** 周窗口内偏移：0=周一 … 4=周五 */
  weekDay: number;
  /** 所在周偏移：-2=上上周、-1=上周、0=本周 */
  weekOffset: -2 | -1 | 0;
  /** 16 名学生分数（与 STUDENT_NUMBERS 顺序一致）；缺省表示不出分（顺延演示） */
  scores?: Record<string, number>;
}

/** 上上周（-2）：整体偏高，制造「上周下滑」的较上周对比 */
const QUIZ_PREV2_EXAMS: QuizExamSpec[] = [
  { cardId: "89000001", name: `${DEMO_PREFIX}晨测数学`, subject: "数学", weekDay: 0, weekOffset: -2, scores: {
    "20260101": 92, "20260102": 85, "20260103": 88, "20260104": 90,
    "20260105": 82, "20260106": 80, "20260107": 86, "20260108": 94,
    "20260109": 84, "20260110": 87, "20260111": 81, "20260112": 89,
    "20260113": 83, "20260114": 91, "20260115": 80, "20260116": 86 } },
  { cardId: "89000002", name: `${DEMO_PREFIX}晨测英语`, subject: "英语", weekDay: 1, weekOffset: -2, scores: {
    "20260101": 90, "20260102": 84, "20260103": 86, "20260104": 91,
    "20260105": 80, "20260106": 83, "20260107": 88, "20260108": 89,
    "20260109": 82, "20260110": 85, "20260111": 81, "20260112": 87,
    "20260113": 84, "20260114": 90, "20260115": 82, "20260116": 85 } },
  { cardId: "89000003", name: `${DEMO_PREFIX}晨测物理`, subject: "物理", weekDay: 2, weekOffset: -2, scores: {
    "20260101": 93, "20260102": 86, "20260103": 89, "20260104": 92,
    "20260105": 84, "20260106": 82, "20260107": 88, "20260108": 95,
    "20260109": 85, "20260110": 88, "20260111": 83, "20260112": 90,
    "20260113": 86, "20260114": 92, "20260115": 81, "20260116": 87 } }
];

/** 上周（-1）：周一~周五每天一场；数学刻意偏低 → 薄弱题 Top5 以数学为主 */
const QUIZ_PREV1_EXAMS: QuizExamSpec[] = [
  { cardId: "89000004", name: `${DEMO_PREFIX}晨测语文`, subject: "语文", weekDay: 0, weekOffset: -1, scores: {
    "20260101": 78, "20260102": 85, "20260103": 72, "20260104": 88,
    "20260105": 80, "20260106": 76, "20260107": 82, "20260108": 90,
    "20260109": 74, "20260110": 86, "20260111": 79, "20260112": 83,
    "20260113": 77, "20260114": 84, "20260115": 81, "20260116": 75 } },
  { cardId: "89000005", name: `${DEMO_PREFIX}晨测数学`, subject: "数学", weekDay: 1, weekOffset: -1, scores: {
    "20260101": 68, "20260102": 72, "20260103": 65, "20260104": 78,
    "20260105": 70, "20260106": 62, "20260107": 75, "20260108": 80,
    "20260109": 66, "20260110": 73, "20260111": 69, "20260112": 76,
    "20260113": 67, "20260114": 79, "20260115": 71, "20260116": 64 } },
  { cardId: "89000006", name: `${DEMO_PREFIX}晨测英语`, subject: "英语", weekDay: 2, weekOffset: -1, scores: {
    "20260101": 75, "20260102": 82, "20260103": 70, "20260104": 85,
    "20260105": 77, "20260106": 73, "20260107": 79, "20260108": 86,
    "20260109": 72, "20260110": 81, "20260111": 76, "20260112": 83,
    "20260113": 74, "20260114": 84, "20260115": 78, "20260116": 71 } },
  { cardId: "89000007", name: `${DEMO_PREFIX}晨测物理`, subject: "物理", weekDay: 3, weekOffset: -1, scores: {
    "20260101": 80, "20260102": 86, "20260103": 74, "20260104": 90,
    "20260105": 82, "20260106": 76, "20260107": 85, "20260108": 92,
    "20260109": 77, "20260110": 87, "20260111": 79, "20260112": 88,
    "20260113": 78, "20260114": 89, "20260115": 81, "20260116": 75 } },
  { cardId: "89000008", name: `${DEMO_PREFIX}晨测化学`, subject: "化学", weekDay: 4, weekOffset: -1, scores: {
    "20260101": 76, "20260102": 83, "20260103": 71, "20260104": 86,
    "20260105": 78, "20260106": 72, "20260107": 80, "20260108": 88,
    "20260109": 73, "20260110": 82, "20260111": 75, "20260112": 85,
    "20260113": 74, "20260114": 84, "20260115": 77, "20260116": 70 } }
];

/** 本周（0）：未出分 → 周报展示「顺延」状态 */
const QUIZ_PENDING_EXAM: QuizExamSpec = {
  cardId: "89000009", name: `${DEMO_PREFIX}晨测数学(待出分)`, subject: "数学", weekDay: 0, weekOffset: 0
};

/**
 * 本次导入会写入的全部演示答题卡 ID（安全 R48 的比对清单）。
 * 由上面的种子规格推导，不另写一份常量——加一场演示考试就自动进清单，不会漏比。
 */
export const DEMO_CARD_IDS: readonly string[] = Object.freeze([
  ...WEEK_EXAMS.map((spec) => spec.cardId),
  PRIOR_MATH_EXAM.cardId,
  OUTSIDE_WEEK_EXAM.cardId,
  ...QUIZ_PREV2_EXAMS.map((spec) => spec.cardId),
  ...QUIZ_PREV1_EXAMS.map((spec) => spec.cardId),
  QUIZ_PENDING_EXAM.cardId,
  DEMO_REVIEW_CARD_ID,
]);

/** 晨测演示知识点（5 题 × 科目）——周报「薄弱题 Top5」可展示知识点名称 */
const QUIZ_KNOWLEDGE: Record<string, string[]> = {
  语文: ["现代文阅读", "文言文翻译", "古诗鉴赏", "名句默写", "作文"],
  数学: ["函数性质", "三角函数", "数列", "立体几何", "解析几何"],
  英语: ["听力理解", "语法填空", "完形填空", "阅读理解", "书面表达"],
  物理: ["牛顿定律", "功能关系", "电场", "磁场", "实验设计"],
  化学: ["氧化还原", "离子反应", "元素周期律", "化学平衡", "有机推断"]
};

/** 本地日期偏移（YYYY-MM-DD + n 天） */
function addDaysLocal(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function tableExists(db: DbAdapter, name: string): Promise<boolean> {
  if (db.dialect === "mariadb") {
    const row = await db.get(
      "SELECT 1 AS x FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?",
      name
    );
    return Boolean(row);
  }
  const row = await db.get("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?", name);
  return Boolean(row);
}

async function ensureCrossExamTables(db: DbAdapter): Promise<void> {
  // exam_group_items 为 PR #112 兼容影子表：仅 SQLite 侧动态建表；
  // MariaDB 侧 schema.mariadb.sql 无此表，跳过（不建/不写/不清）。
  if (db.dialect === "mariadb") return;
  if (!(await tableExists(db, "exam_group_items"))) {
    await db.exec(`
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

/**
 * 关联考试组与考试。trackTypes 与 examIds 一一对应（缺省 'common'），
 * 支持文理分科（#212）：common 共同 / arts 文科 / science 理科。
 */
async function linkGroupExams(
  db: DbAdapter,
  groupId: number,
  examIds: number[],
  trackTypes?: Array<"common" | "arts" | "science">
): Promise<void> {
  const insertMember = buildInsertIgnore(db.dialect, "exam_group_members", ["group_id", "exam_id", "sort_order", "track_type"]);
  for (const [i, id] of examIds.entries()) {
    await db.run(insertMember, groupId, id, i, trackTypes?.[i] ?? "common");
  }

  if (await tableExists(db, "exam_group_items")) {
    const insertItem = buildInsertIgnore(db.dialect, "exam_group_items", ["group_id", "exam_id", "sort_order"]);
    for (const [i, id] of examIds.entries()) {
      await db.run(insertItem, groupId, id, i);
    }
  }
}

export interface ClearDemoStats {
  removedExams: number;
  removedGroups: number;
  removedStudents: number;
  preservedCards: number;
  preservedExams: number;
}

async function cleanupDemoData(db: DbAdapter): Promise<ClearDemoStats> {
  // ── 收集待清理集合（五轮A3：只按明确的演示归属删除）──
  // 非「演示-」前缀考试可能由用户在 UI 中选择演示答题卡后创建，属于真实考试；
  // 不得因其引用 is_demo=1 的卡而连同成绩、切块和网阅记录一起删除。
  const demoExamIds = (await db.all(
    "SELECT id FROM exams WHERE name LIKE ?",
    `${DEMO_PREFIX}%`
  ) as Array<{ id: number }>).map((r) => r.id);
  const protectedRefs = await db.all(
    `SELECT DISTINCT ac.id AS card_id, e.id AS exam_id, e.name AS exam_name
     FROM answer_cards ac
     JOIN exams e ON e.card_id = ac.id
     WHERE ac.is_demo = 1 AND e.name NOT LIKE ?`,
    `${DEMO_PREFIX}%`
  ) as Array<{ card_id: string; exam_id: number; exam_name: string }>;
  const protectedCardIds = new Set(protectedRefs.map((r) => String(r.card_id)));
  const protectedExamIds = new Set(protectedRefs.map((r) => Number(r.exam_id)));
  if (protectedRefs.length > 0) {
    const names = [...new Set(protectedRefs.map((r) => r.exam_name))];
    console.warn(
      `[clearDemoData] ${protectedExamIds.size} 场非演示考试仍引用 ${protectedCardIds.size} 张演示答题卡；已保留考试及答题卡：${names.join("、")}`
    );
  }
  const demoGroupIds = (await db.all("SELECT id FROM exam_groups WHERE name LIKE ?", `${DEMO_PREFIX}%`) as Array<{ id: number }>).map((r) => r.id);

  // v2.3.x: 周报动态组（source='week'，由 WeeklyAuditService 按周发布创建，名称不带「演示-」前缀）。
  // 若组内不存在任何真实考试（成员为空或全为演示考试），随演示清理一并删除，避免残留空组。
  const demoOnlyWeekGroupIds = (await db.all(
    `SELECT eg.id FROM exam_groups eg
     WHERE eg.source = 'week'
       AND NOT EXISTS (SELECT 1 FROM exam_group_members egm
                       JOIN exams e ON e.id = egm.exam_id
                       WHERE egm.group_id = eg.id AND e.name NOT LIKE '演示-%')`
  ) as Array<{ id: number }>).map((r) => r.id);

  // ── 全程事务（五轮A3：任一步失败不得留下半删状态，MariaDB 外键约束下保证原子性）──
  const stats = await db.transaction(async (tx) => {
    if (demoOnlyWeekGroupIds.length > 0) {
      const ph = demoOnlyWeekGroupIds.map(() => "?").join(",");
      await tx.run(`DELETE FROM exam_group_members WHERE group_id IN (${ph})`, ...demoOnlyWeekGroupIds);
      await tx.run(`DELETE FROM exam_groups WHERE id IN (${ph})`, ...demoOnlyWeekGroupIds);
    }

    if (demoGroupIds.length > 0) {
      const ph = demoGroupIds.map(() => "?").join(",");
      await tx.run(`DELETE FROM exam_group_members WHERE group_id IN (${ph})`, ...demoGroupIds);
      if (await tableExists(tx, "exam_group_items")) {
        await tx.run(`DELETE FROM exam_group_items WHERE group_id IN (${ph})`, ...demoGroupIds);
      }
      await tx.run(`DELETE FROM exam_groups WHERE id IN (${ph})`, ...demoGroupIds);
    }

    if (demoExamIds.length > 0) {
      const ph = demoExamIds.map(() => "?").join(",");
      // 先清所有引用（exam_participants 依赖外键级联，但 SQLite 可能外键关闭/旧库无级联，显式删除最稳）
      await tx.run(`DELETE FROM exam_participants WHERE exam_id IN (${ph})`, ...demoExamIds);
      await tx.run(`DELETE FROM question_scores WHERE exam_id IN (${ph})`, ...demoExamIds);
      await tx.run(`DELETE FROM student_scores WHERE exam_id IN (${ph})`, ...demoExamIds);
      await tx.run(`DELETE FROM answer_block_crops WHERE exam_id IN (${ph})`, ...demoExamIds);
      await tx.run(`DELETE FROM review_assignments WHERE exam_id IN (${ph})`, ...demoExamIds);
      await tx.run(`DELETE FROM review_sessions WHERE exam_id IN (${ph})`, ...demoExamIds);
      await tx.run(`DELETE FROM block_grading_config WHERE exam_id IN (${ph})`, ...demoExamIds);
      await tx.run(`DELETE FROM exams WHERE id IN (${ph})`, ...demoExamIds);
    }

    // v1.9.6: 答题卡 / 用户 / 班级 / 年级按归属标记 is_demo=1 清理，不依赖硬编码 ID。
    // 若演示卡仍被非演示考试引用，必须保留该卡；只删除已无任何考试引用的演示卡。
    // v2.3.x: 晨测演示卡关联 knowledge_points（MariaDB 无级联），先清可删除卡的知识点。
    const deletableDemoCardIds = (await tx.all(
      `SELECT ac.id FROM answer_cards ac
       WHERE ac.is_demo = 1
         AND NOT EXISTS (SELECT 1 FROM exams e WHERE e.card_id = ac.id)`
    ) as Array<{ id: string }>).map((r) => r.id);
    let removedCards = 0;
    if (deletableDemoCardIds.length > 0) {
      const ph = deletableDemoCardIds.map(() => "?").join(",");
      await tx.run(`DELETE FROM knowledge_points WHERE card_id IN (${ph})`, ...deletableDemoCardIds);
      removedCards = (await tx.run(`DELETE FROM answer_cards WHERE id IN (${ph})`, ...deletableDemoCardIds)).changes;
    }

    // 收集待清理的演示用户 id（学生 + 演示教师），先解除关联再删用户
    const demoStudentIds = (await tx.all("SELECT id FROM users WHERE is_demo = 1") as Array<{ id: number }>).map((r) => r.id);
    const removedStudents = demoStudentIds.length;

    if (demoStudentIds.length > 0) {
      const ph = demoStudentIds.map(() => "?").join(",");
      await tx.run(`DELETE FROM class_students WHERE student_id IN (${ph})`, ...demoStudentIds);
      await tx.run(`DELETE FROM teacher_classes WHERE teacher_id IN (${ph})`, ...demoStudentIds);
      await tx.run(`DELETE FROM exam_participants WHERE student_id IN (${ph})`, ...demoStudentIds);
      await tx.run(`DELETE FROM users WHERE id IN (${ph})`, ...demoStudentIds);
    }

    // 删演示班级在前，删演示年级在后（classes.grade_id → grades.id 外键级联）。
    // v1.9.6 安全收窄：仅当演示年级下不存在 is_demo=0 的真实班级时才删除演示年级，
    // 避免外键 ON DELETE CASCADE 顺带扫掉挂在演示年级下的真实班级。
    await tx.run("DELETE FROM classes WHERE is_demo = 1");
    const hasRealClassUnderDemoGrade = Boolean(
      await tx.get(
        "SELECT 1 AS x FROM classes WHERE is_demo = 0 AND grade_id IN (SELECT id FROM grades WHERE is_demo = 1) LIMIT 1"
      )
    );
    if (!hasRealClassUnderDemoGrade) {
      await tx.run("DELETE FROM grades WHERE is_demo = 1");
    } else {
      // 边界保护：保留有真实班级挂靠的演示年级，避免级联误删真实数据。
      console.warn(
        "[clearDemoData] 检测到真实班级挂靠在演示年级下，已保留该演示年级以避免级联删除真实班级，请手动迁移真实班级后再次清理。"
      );
    }

    // removedCards 当前仅用于确保删除语句执行并保留后续统计扩展点。
    void removedCards;

    return {
      removedExams: demoExamIds.length,
      removedGroups: demoGroupIds.length,
      removedStudents,
      preservedCards: protectedCardIds.size,
      preservedExams: protectedExamIds.size
    };
  });

  // 事务外清理磁盘上的教师答案页文件（SQLite 单连接下事务内做真异步 I/O 会破坏原子性）
  for (const examId of demoExamIds) await removeExamAnswerKeyFiles(examId);
  return stats;
}

/** 清除全部「演示-」前缀数据（不动真实数据）。假定 DB 已初始化。 */
export async function clearDemoData(): Promise<ClearDemoStats> {
  return cleanupDemoData(getMysqlDb());
}

// 演示客观题答案（5 道单选，4 个选项），供逐题选项分析演示
const DEMO_ANSWER_KEYS: Record<number, string[]> = { 1: ["A"], 2: ["B"], 3: ["C"], 4: ["D"], 5: ["A"] };
const DEMO_OPTIONS = ["A", "B", "C", "D"];
// 答题卡设计器修复：演示-数学卡客观题块按新规范使用「选项竖排」（A/B/C/D 在题号下方纵向堆叠），
// 其余演示卡保持默认横向——与 manifest 「选项竖排」用例一一对应。
// 卡号本身取自 demo/demoCardIds.ts（与安全 R48 的比对清单同一来源）。

/** 为演示答题卡补一个客观题块 + 标准答案，使选项分析端点能解析题元数据 */
async function ensureDemoObjectiveBlock(db: DbAdapter, cardId: string, optionLayout: "horizontal" | "vertical" | "vertical-options" = "horizontal"): Promise<void> {
  // 安全 R48：标准答案是写死的 A/B/C/D/A。挂到真实卡上＝按演示答案给真实答卷判分，
  // 所以这里再确认一次归属（导入前的整单比对是第一道，这里是第二道）。
  if (!(await isDemoCard(db, cardId))) return;
  const blockId = `${cardId}-obj`;
  await db.run(
    buildInsertIgnore(db.dialect, "objective_blocks", [
      "id", "card_id", "sort_order", "title", "question_start", "question_count", "option_count", "mode", "score_per_question", "option_layout"
    ]),
    blockId, cardId, 0, "选择题", 1, 5, 4, "single", 30, optionLayout
  );
  const insertKey = buildInsertIgnore(db.dialect, "objective_answer_keys", ["block_id", "question_number", "correct_options"]);
  for (const [q, key] of Object.entries(DEMO_ANSWER_KEYS)) {
    await db.run(insertKey, blockId, Number(q), JSON.stringify(key));
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

async function seedQuestionScores(
  db: DbAdapter,
  examId: number,
  cardId: string,
  studentIdByNumber: Map<string, number>,
  scores: Record<string, number>
): Promise<void> {
  await ensureDemoObjectiveBlock(db, cardId, cardId === DEMO_VERTICAL_OPTIONS_CARD_ID ? "vertical-options" : "horizontal");
  const insertQ = `INSERT INTO question_scores (exam_id, student_id, question_number, score, max_score, score_type, selected_options)
    VALUES (?, ?, ?, ?, ?, 'objective', ?)`;
  for (const [num, total] of Object.entries(scores)) {
    if (total <= 0) continue;
    const sid = studentIdByNumber.get(num);
    if (!sid) continue;
    const perQ = Math.floor(total / 5);
    const remainder = total - perQ * 5;
    for (let q = 1; q <= 5; q++) {
      const score = q === 5 ? perQ + remainder : perQ;
      await db.run(insertQ, examId, sid, q, score, 30, JSON.stringify(demoSelectedOptions(examId, sid, q, score, 30)));
    }
  }
}

export interface SeedDemoStats {
  studentsCreated: number;
  studentsSkipped: number;
  exams: number;
  groups: number;
  /**
   * 安全 R33：本次导入生效的演示教师凭据。默认口令随机（每次导入都换发），
   * 因此必须把它交回调用方展示一次；`fixed: true` 表示当前用的是公开文档里的固定口令
   * （只在 `PROJECTX_DEMO_FIXED_CREDENTIALS` 显式打开时出现，调用方应据此加警告）。
   */
  teacherCredentials: Array<{ username: string; password: string; fixed: boolean }>;
  /** 演示学生口令是否与学号相同（同上，只有固定凭据模式下才为 true）。 */
  studentPasswordIsStudentNumber: boolean;
}

/** 安全 R33/R48：导入被拒时抛出的错误形状（路由据此映射状态码，前端据此决定是否二次确认）。 */
export interface DemoImportRefusal extends Error {
  status: number;
  code: "DEMO_CARD_ID_CONFLICT" | "DEMO_TEACHER_USERNAME_TAKEN" | "DEMO_IMPORT_REQUIRES_CONFIRMATION";
  /** 需要前端回传的确认串（仅 DEMO_IMPORT_REQUIRES_CONFIRMATION）。 */
  confirm?: string;
  cardIds?: string[];
  usernames?: string[];
  realExams?: number;
  realUsers?: number;
}

function refuse(
  code: DemoImportRefusal["code"],
  message: string,
  extra: Partial<DemoImportRefusal> = {}
): DemoImportRefusal {
  return Object.assign(new Error(message), { status: 409, code, ...extra }) as DemoImportRefusal;
}

/**
 * 安全 R48：演示卡号撞上真实答题卡时，**整单拒绝且不留任何改动**。
 *
 * 建卡用的是 `INSERT ... IGNORE`，撞号不会报错：演示考试会挂到那张真实卡上，
 * 随后 `ensureDemoObjectiveBlock` 给它补一个标准答案为 A/B/C/D/A 的 5 题选择题块、
 * 作文/填空块与 `assets/<cardId>/` 下的演示图片——真实考试从此按演示答案判分。
 * 真实卡号由 `generateCardId()` 产出，落在 10000000–99999999，演示卡号就在同一区间内。
 */
async function assertDemoCardIdsFree(db: DbAdapter): Promise<void> {
  const placeholders = DEMO_CARD_IDS.map(() => "?").join(",");
  const rows = await db.all(
    `SELECT id, title FROM answer_cards WHERE is_demo = 0 AND id IN (${placeholders})`,
    ...DEMO_CARD_IDS
  ) as Array<{ id: string; title: string | null }>;
  if (rows.length === 0) return;
  const detail = rows.map((r) => `${r.id}（${r.title ?? "无标题"}）`).join("、");
  throw refuse(
    "DEMO_CARD_ID_CONFLICT",
    `演示答题卡号与 ${rows.length} 张真实答题卡冲突：${detail}。`
    + `为避免把演示题块与演示答案写进真实卡（那会让真实考试按演示答案判分），本次导入已整单取消，未改动任何数据。`
    + `请先删除或重建这些真实答题卡（重建会拿到新卡号），再导入演示数据。`,
    { cardIds: rows.map((r) => String(r.id)) }
  );
}

/**
 * 安全 R33 / 评审 P1：`demo-teacher` / `demo-teacher-2` 是演示账号的保留用户名，
 * 但**同名且查不到业务关系，不是「这是演示账号」的证据**。
 *
 * 旧判据是「三条在用证据（真实班级任课 / 阅卷分配 / 创建过考试）任一命中才拒绝」。
 * 于是一个真实教师只要刚导入、还没任课、还没被分配阅卷，就会被改口令、改角色、标成
 * `is_demo = 1`——而 `clearDemoData` 正是按 `is_demo = 1` 删账号的：一次演示导入
 * 把真实账号交到了清理程序手里，之后任何人点一次「清理演示数据」它就消失了。
 *
 * 现在只认**明确的演示归属**：`is_demo = 1` 才算演示账号。v1.9.8 起建号与打标在同一条
 * INSERT 里完成，正常流程不会再产出 `is_demo = 0` 的演示教师，所以这个名字下的非演示
 * 账号一律整单拒绝、零改动，由人来定性（改名、删除，或确认是历史残留后显式认领）。
 * 判定仍在任何写入之前，拒绝时库里一个字节都没动。
 */
async function assertDemoTeacherUsernamesAvailable(db: DbAdapter): Promise<void> {
  const taken: string[] = [];
  const details: string[] = [];
  for (const username of DEMO_TEACHER_USERNAMES) {
    const row = await db.get(
      "SELECT id, name, is_demo FROM users WHERE username = ?",
      username
    ) as { id: number; name: string; is_demo: number | null } | undefined;
    if (!row || Number(row.is_demo) === 1) continue;
    taken.push(username);
    details.push(
      `${username}（id=${row.id}，名称「${row.name}」）不是演示账号：`
      + `确认是历史版本中断导入留下的残留时，可显式认领 `
      + `"UPDATE users SET is_demo = 1 WHERE id = ${row.id}"；是真实账号请先改名或删除`
    );
  }
  if (taken.length === 0) return;
  throw refuse(
    "DEMO_TEACHER_USERNAME_TAKEN",
    `用户名 ${taken.join("、")} 被非演示账号占用（该用户名是演示账号保留名）。`
    + `本次导入已整单取消，未改动任何数据。${details.join("；")}。`,
    { usernames: taken }
  );
}

/**
 * 安全 R33：库里已有真实数据时，导入演示数据需要显式确认。
 * 演示导入会写入 16 个演示账号与十几场考试，误点一次就得靠 clear-demo 收拾，
 * 而 clear-demo 只认「演示-」前缀与 is_demo=1 —— 中间态最难还原。
 */
async function assertDemoImportConfirmed(db: DbAdapter, confirmed?: boolean): Promise<void> {
  if (confirmed || demoProductionImportAllowedByEnv()) return;
  const examRow = await db.get(
    "SELECT COUNT(*) AS n FROM exams WHERE name NOT LIKE ?",
    `${DEMO_PREFIX}%`
  ) as { n: number };
  const userRow = await db.get(
    "SELECT COUNT(*) AS n FROM users WHERE is_demo = 0 AND role_id <> ?",
    ROLE_IDS.ADMIN
  ) as { n: number };
  const realExams = Number(examRow?.n ?? 0);
  const realUsers = Number(userRow?.n ?? 0);
  if (realExams === 0 && realUsers === 0) return;
  throw refuse(
    "DEMO_IMPORT_REQUIRES_CONFIRMATION",
    `当前库已有真实数据（${realExams} 场真实考试 / ${realUsers} 个真实账号）。`
    + `演示数据会新增 16 个演示账号与十几场「演示-」前缀考试，且演示账号口令会写进本库。`
    + `确认要在这样的库上导入请重试并带上确认串 ${DEMO_IMPORT_PRODUCTION_CONFIRM}。`,
    { confirm: DEMO_IMPORT_PRODUCTION_CONFIRM, realExams, realUsers }
  );
}

/** 导入前的一切「宁可不做也不做错」检查：任一条命中都必须在写入之前抛出。 */
async function assertDemoImportAllowed(db: DbAdapter, options?: SeedDemoOptions): Promise<void> {
  await assertDemoCardIdsFree(db);
  await assertDemoTeacherUsernamesAvailable(db);
  await assertDemoImportConfirmed(db, options?.confirmedProductionImport);
}

/**
 * 植入周报演示晨测（quiz）：上上周 3 场 + 上周 5 场全出分、本周 1 场未出分（顺延演示）。
 * 日期按 getWeekWindow 动态计算，任何时刻导入都落在周报近 5 周窗口内。
 * 周组不在此手动创建 —— 由 seedDemoData 末尾调用 WeeklyAuditService.publishDueWeeks 统一发布
 * （与生产定时任务同一发布逻辑，保证导入后周报立即可见）。
 */
async function seedWeeklyQuizDemo(
  db: DbAdapter,
  gradeId: number,
  studentIdByNumber: Map<string, number>
): Promise<number> {
  const weekStartByOffset = (offset: -2 | -1 | 0) => getWeekWindow(offset).weekStart;
  const allExams = [...QUIZ_PREV2_EXAMS, ...QUIZ_PREV1_EXAMS, QUIZ_PENDING_EXAM];

  const insertCard = buildInsertIgnore(db.dialect, "answer_cards", ["id", "title", "subject_label", "exam_date", "is_demo"]);
  const insertExam = `INSERT INTO exams (name, card_id, grade_id, subject, start_time, status, closed_at, exam_mode, created_by)
    VALUES (?, ?, ?, ?, ?, 'closed', CURRENT_TIMESTAMP, 'quiz', (SELECT id FROM users WHERE username = 'admin'))`;
  const insertScore = `INSERT INTO student_scores (exam_id, student_id, objective_score, subjective_score, total_score)
    VALUES (?, ?, ?, 0, ?)`;
  // 不依赖 knowledge_points.track_type：旧库升级（迁移 v39 前）无该列；新库缺省 'common' 一致。
  const insertKp = "INSERT INTO knowledge_points (card_id, question_number, point_text, category) VALUES (?, ?, ?, '客观题')";

  let count = 0;
  for (const spec of allExams) {
    const examDate = addDaysLocal(weekStartByOffset(spec.weekOffset), spec.weekDay);
    await db.run(insertCard, spec.cardId, spec.name, spec.subject, examDate, 1);
    const info = await db.run(insertExam, spec.name, spec.cardId, gradeId, spec.subject, examDate);
    const examId = Number(info.lastInsertRowid);
    count += 1;

    const kpList = QUIZ_KNOWLEDGE[spec.subject];
    if (kpList) {
      for (const [i, point] of kpList.entries()) {
        await db.run(insertKp, spec.cardId, i + 1, point);
      }
    }

    if (!spec.scores) continue; // 未出分考试（本周顺延演示），不写成绩
    for (const [num, total] of Object.entries(spec.scores)) {
      const sid = studentIdByNumber.get(num);
      if (sid) await db.run(insertScore, examId, sid, total, total);
    }
    await seedQuestionScores(db, examId, spec.cardId, studentIdByNumber, spec.scores);
  }
  return count;
}

export interface SeedDemoOptions {
  /**
   * 安全 R33：库里已有真实数据时的显式确认（前端二次确认后回传
   * `DEMO_IMPORT_PRODUCTION_CONFIRM`）。未确认、且未设 `PROJECTX_DEMO_ALLOW_PRODUCTION_IMPORT`
   * 时导入被拒——拒绝发生在任何写入之前。
   */
  confirmedProductionImport?: boolean;
}

/**
 * 幂等导入演示数据：先清理「演示-」前缀数据再重建。
 * 假定 DB 已初始化且 admin 用户已存在（服务端运行态天然满足；CLI 需先 ensureDefaultAdmin）。
 */
export async function seedDemoData(options: SeedDemoOptions = {}): Promise<SeedDemoStats> {
  const db = getMysqlDb();
  // 安全 R33/R48：三道「宁可不做也不做错」的闸全部在写入之前判完，拒绝时库里一个字节都没动。
  await assertDemoImportAllowed(db, options);
  await ensureCrossExamTables(db);
  const userRepo = new UserRepository();
  const classRepo = new ClassRepository();

  await cleanupDemoData(db);

  // v1.9.8: 年级/班级/演示教师在单个事务内以 INSERT 直写 is_demo=1，创建与打标原子完成。
  // 此前「先创建再 UPDATE 打标」存在窗口：若进程在两步之间崩溃，demo-teacher 以 is_demo=0
  // 残留（users.username UNIQUE），cleanup 按 is_demo=1 识别无法清理，下次导入必撞 UNIQUE。
  // 评审 P1：这种残留**不再自动收编**。一个 is_demo=0 的同名账号无法自证是演示残留，
  // 收编＝改口令、改角色、打上 is_demo=1，随后就落进 clearDemoData 的删除集合——
  // 那正是「演示导入删掉真实账号」的成因。归属判定统一由
  // assertDemoTeacherUsernamesAvailable 在任何写入之前完成：只认 is_demo=1，其余整单拒绝，
  // 历史残留由人显式认领（错误信息里给出该账号 id 与认领语句）。
  // 口令一律随机换发：公开文档里的 teacher123 在升级后当场失效。
  // teacher_role 不能留空：routes/scores.ts 的兼容分支把「未配置 teacher_role 的教师」当全校可见，
  // 那等于把全校成绩挂在一个口令公开的账号上。
  const fixedCredentials = demoFixedCredentialsEnabled();
  const teacherSpecs = [
    { username: "demo-teacher", name: "演示教师" },
    { username: "demo-teacher-2", name: "演示教师乙" },
  ].map((spec) => ({
    ...spec,
    password: fixedCredentials ? LEGACY_PUBLIC_DEMO_TEACHER_PASSWORD : generateBootstrapAdminPassword(),
  }));
  // bcrypt 哈希为异步，须在同步事务外预先计算。
  const teacherRows = await Promise.all(
    teacherSpecs.map(async (spec) => ({ ...spec, hash: await hashPassword(spec.password) }))
  );
  const created = await db.transaction(async (tx) => {
    const gradeResult = await tx.run("INSERT INTO grades (name, sort_order, is_demo) VALUES (?, ?, 1)", "高一(演示)", 1);
    const gradeId = Number(gradeResult.lastInsertRowid);
    const class1Result = await tx.run("INSERT INTO classes (grade_id, name, sort_order, is_demo) VALUES (?, ?, ?, 1)", gradeId, "演示1班", 1);
    const class1Id = Number(class1Result.lastInsertRowid);
    const class2Result = await tx.run("INSERT INTO classes (grade_id, name, sort_order, is_demo) VALUES (?, ?, ?, 1)", gradeId, "演示2班", 2);
    const class2Id = Number(class2Result.lastInsertRowid);
    const teacherIds: number[] = [];
    for (const row of teacherRows) {
      const info = await tx.run(
        `INSERT INTO users (username, password_hash, name, role_id, subject, teacher_role, initial_password, is_demo)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
        row.username, row.hash, row.name, ROLE_IDS.TEACHER, "数学", "subject_teacher", encryptField(row.password)
      );
      teacherIds.push(Number(info.lastInsertRowid));
    }
    return { gradeId, class1Id, class2Id, teacherIds };
  });
  const grade = { id: created.gradeId };
  const class1 = { id: created.class1Id };
  const class2 = { id: created.class2Id };

  // 安全 R33：把演示教师任课到两个演示班级。teacher_role='subject_teacher' 的可见班级来自
  // teacher_classes，不挂就等于什么都看不到（演示面板空转）；挂演示班级则可见范围恰好圈在演示数据里。
  const insertTeacherClass = buildInsertIgnore(db.dialect, "teacher_classes", ["teacher_id", "class_id", "subject"]);
  for (const teacherId of created.teacherIds) {
    await db.run(insertTeacherClass, teacherId, class1.id, "数学");
    await db.run(insertTeacherClass, teacherId, class2.id, "数学");
  }
  console.log(
    `[seed] 演示教师: ${teacherSpecs.map((t) => t.username).join("、")}`
    + `（口令${fixedCredentials ? "为固定值，仅限隔离测试环境" : "已随机换发，随导入结果返回一次"}，范围=任课教师/演示班级）`
  );

  // 安全 R33：演示学生口令默认交给 batchCreateStudents 随机生成（并存进加密的 initial_password，
  // 管理员可从既有账号导出里查回）；只有显式打开固定凭据开关时才回落到「口令=学号」。
  const batch = await userRepo.batchCreateStudents(
    STUDENT_NUMBERS.map((num, i) => ({
      username: num,
      name: STUDENT_NAMES[i],
      student_number: num,
      ...(fixedCredentials ? { password: num } : {}),
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
    await db.run(`UPDATE users SET is_demo = 1 WHERE id IN (${createdPh})`, ...batch.createdIds);
    // 演示班级分班 / 成绩种子同样只覆盖本次新建的演示学生，被跳过的真实学生不入演示班级、不写演示成绩
    const createdRows = await db.all(
      `SELECT id, student_number FROM users WHERE id IN (${createdPh})`,
      ...batch.createdIds
    ) as Array<{ id: number; student_number: string | null }>;
    for (const row of createdRows) {
      if (row.student_number) studentIdByNumber.set(row.student_number, row.id);
    }
  }

  // v1.9.9: 文理分科标签（#212，大考合集按科类筛选）：演示1班（01~08）= 理科班、演示2班（09~16）= 文科班。
  // 仅打标本次新建的演示学生，被跳过的真实学生不受影响（与 is_demo 打标同一安全语义）。
  for (const [i, num] of STUDENT_NUMBERS.entries()) {
    const sid = studentIdByNumber.get(num);
    if (sid) await db.run("UPDATE users SET track = ? WHERE id = ?", i < 8 ? "science" : "arts", sid);
  }

  const class1StudentIds = STUDENT_NUMBERS.slice(0, 8)
    .map((n) => studentIdByNumber.get(n))
    .filter((id): id is number => typeof id === "number");
  const class2StudentIds = STUDENT_NUMBERS.slice(8)
    .map((n) => studentIdByNumber.get(n))
    .filter((id): id is number => typeof id === "number");
  await classRepo.addStudents(class1.id, class1StudentIds);
  await classRepo.addStudents(class2.id, class2StudentIds);

  const insertCard = buildInsertIgnore(db.dialect, "answer_cards", ["id", "title", "subject_label", "exam_date", "is_demo"]);
  const insertExam = `INSERT INTO exams (name, card_id, grade_id, subject, start_time, status, score_published, closed_at, created_by)
    VALUES (?, ?, ?, ?, ?, 'closed', 1, CURRENT_TIMESTAMP, (SELECT id FROM users WHERE username = 'admin'))`;
  const insertScore = `INSERT INTO student_scores (exam_id, student_id, objective_score, subjective_score, total_score)
    VALUES (?, ?, ?, 0, ?)`;

  const weekExamIds: number[] = [];
  let examCount = 0;

  async function seedExam(spec: ExamSpec): Promise<number> {
    await db.run(insertCard, spec.cardId, spec.name, spec.subject, spec.examDate, 1);
    const info = await db.run(insertExam, spec.name, spec.cardId, grade.id, spec.subject, spec.examDate);
    const examId = Number(info.lastInsertRowid);
    examCount += 1;

    for (const [num, total] of Object.entries(spec.scores)) {
      if (total <= 0) continue;
      const sid = studentIdByNumber.get(num);
      if (sid) await db.run(insertScore, examId, sid, total, total);
    }
    if (spec.withQuestions) await seedQuestionScores(db, examId, spec.cardId, studentIdByNumber, spec.scores);
    return examId;
  }

  await seedExam(PRIOR_MATH_EXAM);
  for (const spec of WEEK_EXAMS) weekExamIds.push(await seedExam(spec));
  const historyExamId = await seedExam(OUTSIDE_WEEK_EXAM);
  await seedFillBlankDemo(db);
  await seedEssayDemo(db);

  // v2.3.x: 周报演示晨测（quiz）——上上周/上周全出分 + 本周未出分（顺延演示）
  examCount += await seedWeeklyQuizDemo(db, grade.id, studentIdByNumber);

  // 网阅打分面板 DEV 演示数据（v1.9.4 路径 B 测试入口）
  // 教师 id 直接用建号事务的返回值：演示账号名是保留名，同名账号一律在写入前被拒绝，
  // 这里的 id 必然来自本次新建的演示教师，不必再按用户名回查。
  const [demoTeacherId, demoTeacher2Id] = created.teacherIds;
  if (demoTeacherId) {
    const reviewSeeded = await seedReviewDemo(db, grade, studentIdByNumber, demoTeacherId, demoTeacher2Id, STUDENT_NUMBERS);
    if (reviewSeeded) examCount += 1;
  }

  const groupInfo = await db.run(
    `INSERT INTO exam_groups (name, description, grade_id, tag, status, total_score_mode, only_full_participants, created_by)
     VALUES (?, ?, ?, '模考', 'active', 'raw', 0, (SELECT id FROM users WHERE username = 'admin'))`,
    `${DEMO_PREFIX}2026高考摸底大考`, "语数英物化生史七科联考演示数据（含文理分科）", grade.id
  );
  // 文理分科（#212）：语数英=共同科目、物化生=理科、历史=文科；大考统计按科类筛选学生
  const bigExamIds = [...weekExamIds, historyExamId];
  const bigTrackTypes: Array<"common" | "arts" | "science"> = [
    "common", "common", "common", "science", "science", "science", "arts"
  ];
  await linkGroupExams(db, Number(groupInfo.lastInsertRowid), bigExamIds, bigTrackTypes);

  const crossInfo = await db.run(
    `INSERT INTO exam_groups (name, source, start_date, end_date, created_by)
     VALUES (?, 'week', '2026-06-16', '2026-06-22', (SELECT id FROM users WHERE username = 'admin'))`,
    `${DEMO_PREFIX}第25周考试包`
  );
  await linkGroupExams(db, Number(crossInfo.lastInsertRowid), weekExamIds);

  // 保险写入全局设置默认键（迁移 v26 已写入；若库为空或被清理则补齐），便于 verify 校验
  const ensureSetting = buildInsertIgnore(db.dialect, "system_settings", ["key", "value"]);
  await db.run(ensureSetting, "require_original_paper", "1");
  await db.run(ensureSetting, "highlight_missing_paper", "1");

  // v2.3.x: 周报发布 —— 与生产定时任务同一逻辑（publishDueWeeks），
  // 导入后上上周/上周报告立即可见（创建 source='week' 动态组），本周顺延状态随之呈现。
  const published = await new WeeklyAuditService().publishDueWeeks(new Date());
  if (published.created.length > 0) {
    console.log(`[seed] 周报已发布: ${published.created.join("、")}`);
  }

  console.log(`[seed] 完成: ${examCount} 场考试, 16 名学生(文理分科), 大考合集(7科) + 跨考已存组 + 周报晨测`);
  return {
    studentsCreated: batch.created,
    studentsSkipped: batch.skipped,
    exams: examCount,
    groups: 3,
    // 安全 R33：口令只在导入结果里出现一次（不落日志），并同步写进加密的 initial_password，
    // 管理员事后可用既有的账号导出查回，不必把公开口令写进文档。
    teacherCredentials: teacherSpecs.map((spec) => ({
      username: spec.username,
      password: spec.password,
      fixed: fixedCredentials,
    })),
    studentPasswordIsStudentNumber: fixedCredentials,
  };
}
