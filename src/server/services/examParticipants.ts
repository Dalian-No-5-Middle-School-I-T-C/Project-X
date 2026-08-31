/**
 * 考试参与者快照服务（评审 P1-1 / P1-2）。
 *
 * 背景：原发布完整性只比人数（COUNT scored vs COUNT roster），外班/误识别学生可凑数绕过
 *       "部分成绩禁止公布"的门控（例：名册 A/B，只录 A + 外班 C，计数 2/2 放行）。
 *
 * 设计（v47 + v48）：
 * - 快照表 exam_participants (exam_id, student_id, source) 固化应考名单，之后调班不再改变历史判断。
 *   - source='roster'：按考试 class_id/grade_id 从 class_students 自动快照（默认）；
 *   - source='explicit'：管理员显式指定的应考名单（跨班/跨年级联考、补救无范围考试）。
 * - 名单来源优先级：显式名单（explicit）优先；无显式名单时回落班级/年级名册快照；
 *   两者皆无（考试无 class_id/grade_id 且未设置显式名单）→ rosterKnown=false，公布一律 409
 *   （v48 起删除「仅校验非空」退化路径，杜绝部分成绩公布）。
 * - 发布校验：应考学生集合 ⊆ 已评分学生集合（required ⊆ scored）。缺任何一人即 409。
 * - 阅卷入库时拒绝不属于参与者名单的学生（名单不可知时不拦截）。
 *
 * 单场/批量公布共用同一谓词 assertGradingComplete。
 */
import type { DbAdapter } from "../db";
import { ROLE_IDS } from "../auth/permissions";

export type ParticipantSource = "roster" | "explicit";

export interface ExamParticipantSnapshot {
  rosterKnown: boolean;
  participantCount: number;
  source: ParticipantSource | null;
}

function isSqlite(db: DbAdapter): boolean {
  return db.dialect === "sqlite";
}

/**
 * 应考名单添加用学生搜索（五轮B2：原 /api/users 为管理员接口，教师 403 后前端静默空白）。
 * 只搜学生角色（role_id=3）且启用（is_active=1）的账号：学号精确或姓名模糊；
 * LIKE 通配符转义，避免 % / _ 命中无关学生。
 */
export async function searchStudentsForExam(
  db: DbAdapter,
  _examId: number,
  q: string
): Promise<Array<{ id: number; name: string; student_number: string | null }>> {
  const keyword = (q ?? "").trim();
  if (!keyword) return [];
  const escaped = keyword.replace(/[\\%_]/g, (m) => `\\${m}`);
  const rows = await db.all(
    `SELECT u.id, u.name, u.student_number
     FROM users u
     WHERE u.role_id = ? AND u.is_active = 1
       AND (u.student_number LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\')
     ORDER BY u.student_number
     LIMIT 20`,
    ROLE_IDS.STUDENT, `${escaped}%`, `%${escaped}%`
  ) as Array<{ id: number; name: string; student_number: string | null }>;
  return rows.map((r) => ({ id: r.id, name: r.name, student_number: r.student_number }));
}

/** 读取考试应考名单（含学生学号/姓名），按 source 优先返回：显式名单 → 名册快照 */
export async function listParticipants(
  db: DbAdapter,
  examId: number
): Promise<Array<{ student_id: number; student_number: string | null; name: string; source: string }>> {
  try {
    const rows = await db.all(
      `SELECT ep.student_id, ep.source, u.student_number, u.name
       FROM exam_participants ep
       JOIN users u ON u.id = ep.student_id
       WHERE ep.exam_id = ?
       ORDER BY COALESCE(u.student_number, ''), u.name`,
      examId
    ) as Array<{ student_id: number; student_number: string | null; name: string; source: string }>;
    return rows;
  } catch {
    return [];
  }
}

/** 判定考试当前名单是否可知及规模（显式名单优先；否则名册快照；皆无则不可知） */
export async function ensureExamParticipants(
  db: DbAdapter,
  examId: number
): Promise<ExamParticipantSnapshot> {
  // 1) 显式名单存在 → 以其为准（source='explicit'）
  const explicitRow = await db.get(
    "SELECT COUNT(*) AS cnt FROM exam_participants WHERE exam_id = ? AND source = 'explicit'",
    examId
  ) as { cnt: number } | undefined;
  const explicitCount = Number(explicitRow?.cnt ?? 0);
  if (explicitCount > 0) {
    return { rosterKnown: true, participantCount: explicitCount, source: "explicit" };
  }

  // 2) 无显式名单 → 按考试范围（class_id/grade_id）固化名册快照（source='roster'）
  const exam = await db.get("SELECT class_id, grade_id FROM exams WHERE id = ?", examId) as
    | { class_id: number | null; grade_id: number | null }
    | undefined;
  if (!exam) return { rosterKnown: false, participantCount: 0, source: null };
  const rosterKnown = exam.class_id != null || exam.grade_id != null;
  if (!rosterKnown) return { rosterKnown: false, participantCount: 0, source: null };

  // 已存在名册快照则直接复用
  const rosterRow = await db.get(
    "SELECT COUNT(*) AS cnt FROM exam_participants WHERE exam_id = ? AND source = 'roster'",
    examId
  ) as { cnt: number } | undefined;
  const rosterCount = Number(rosterRow?.cnt ?? 0);
  if (rosterCount > 0) {
    return { rosterKnown: true, participantCount: rosterCount, source: "roster" };
  }

  // 冻结当前名册（幂等：重复插入由主键忽略）
  // 五轮B2：快照 JOIN users，杜绝把已删除/无账号的 class_students 行快照进名单，
  // 否则清演示数据 / 删用户后 exam_participants 留悬空引用，列表 JOIN users 丢行 → "共50人只显示6人"。
  try {
    if (exam.class_id != null) {
      const sql = isSqlite(db)
        ? "INSERT OR IGNORE INTO exam_participants (exam_id, student_id, source) SELECT ?, cs.student_id, 'roster' FROM class_students cs JOIN users u ON u.id = cs.student_id WHERE cs.class_id = ?"
        : "INSERT IGNORE INTO exam_participants (exam_id, student_id, source) SELECT ?, cs.student_id, 'roster' FROM class_students cs JOIN users u ON u.id = cs.student_id WHERE cs.class_id = ?";
      await db.run(sql, examId, exam.class_id);
    } else if (exam.grade_id != null) {
      const sql = isSqlite(db)
        ? "INSERT OR IGNORE INTO exam_participants (exam_id, student_id, source) SELECT ?, cs.student_id, 'roster' FROM class_students cs JOIN users u ON u.id = cs.student_id JOIN classes c ON c.id = cs.class_id WHERE c.grade_id = ?"
        : "INSERT IGNORE INTO exam_participants (exam_id, student_id, source) SELECT ?, cs.student_id, 'roster' FROM class_students cs JOIN users u ON u.id = cs.student_id JOIN classes c ON c.id = cs.class_id WHERE c.grade_id = ?";
      await db.run(sql, examId, exam.grade_id);
    }
  } catch {
    // 表不存在（旧库未迁移）时视作名单不可知，不阻塞流程
    return { rosterKnown: false, participantCount: 0, source: null };
  }

  try {
    const after = await db.get(
      "SELECT COUNT(*) AS cnt FROM exam_participants WHERE exam_id = ? AND source = 'roster'",
      examId
    ) as { cnt: number } | undefined;
    return { rosterKnown: true, participantCount: Number(after?.cnt ?? 0), source: "roster" };
  } catch {
    return { rosterKnown: false, participantCount: 0, source: null };
  }
}

/**
 * 设置显式应考名单（整体替换 source='explicit' 行）。
 * 调用前须完成学生存在性/角色校验；空数组等价于清除显式名单（DELETE 语义）。
 */
export async function setExplicitParticipants(
  db: DbAdapter,
  examId: number,
  studentIds: number[]
): Promise<number> {
  const uniq = [...new Set(studentIds)];
  return db.transaction(async (tx) => {
    await tx.run("DELETE FROM exam_participants WHERE exam_id = ? AND source = 'explicit'", examId);
    if (uniq.length === 0) return 0;
    const insertSQL = isSqlite(tx)
      ? "INSERT OR IGNORE INTO exam_participants (exam_id, student_id, source) VALUES (?, ?, 'explicit')"
      : "INSERT IGNORE INTO exam_participants (exam_id, student_id, source) VALUES (?, ?, 'explicit')";
    for (const sid of uniq) {
      await tx.run(insertSQL, examId, sid);
    }
    return uniq.length;
  });
}

/** 清除显式应考名单（仅删 source='explicit' 行），回落班级/年级名册快照 */
export async function clearExplicitParticipants(db: DbAdapter, examId: number): Promise<void> {
  await db.run("DELETE FROM exam_participants WHERE exam_id = ? AND source = 'explicit'", examId);
}

/** 考试是否有显式应考名单 */
export async function hasExplicitParticipants(db: DbAdapter, examId: number): Promise<boolean> {
  const row = await db.get(
    "SELECT 1 AS ok FROM exam_participants WHERE exam_id = ? AND source = 'explicit' LIMIT 1",
    examId
  ) as { ok: number } | undefined;
  return Boolean(row);
}

export async function isExamParticipant(db: DbAdapter, examId: number, studentId: number): Promise<boolean> {
  try {
    const row = await db.get("SELECT 1 AS ok FROM exam_participants WHERE exam_id = ? AND student_id = ? LIMIT 1", examId, studentId) as
      | { ok: number }
      | undefined;
    return Boolean(row);
  } catch {
    return true; // 表缺失时不拦截
  }
}

export async function listMissingParticipants(
  db: DbAdapter,
  examId: number
): Promise<Array<{ student_id: number; student_number: string | null; name: string }>> {
  try {
    const rows = await db.all(
      `SELECT ep.student_id, u.student_number, u.name
       FROM exam_participants ep
       JOIN users u ON u.id = ep.student_id
       WHERE ep.exam_id = ?
         AND NOT EXISTS (SELECT 1 FROM student_scores ss WHERE ss.exam_id = ep.exam_id AND ss.student_id = ep.student_id)
       ORDER BY COALESCE(u.student_number, ''), u.name`,
      examId
    ) as Array<{ student_id: number; student_number: string | null; name: string }>;
    return rows;
  } catch {
    return [];
  }
}
