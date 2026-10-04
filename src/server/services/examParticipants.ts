/**
 * 考试参与者快照：显式名单优先，否则按班级/年级冻结名册。
 * 名单用于核对录入学生身份和展示缺考/未出分学生。
 * 公布允许部分学生先出分，不要求名单齐全或已设置名单。
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
 *
 * classIds 为调用者可见班级范围（null = 全校可见，[] = 无可见班级）。
 * 云端安全检查 #25：此前忽略考试直接搜全校学生，等于绕过教师学生列表范围。
 */
export async function searchStudentsForExam(
  db: DbAdapter,
  _examId: number,
  q: string,
  classIds?: number[] | null
): Promise<Array<{ id: number; name: string; student_number: string | null }>> {
  const keyword = (q ?? "").trim();
  if (!keyword) return [];
  const scoped = Array.isArray(classIds);
  if (scoped && classIds!.length === 0) return [];
  // Use a non-backslash escape: SQL string parsing differs between SQLite and
  // MariaDB (and MariaDB's NO_BACKSLASH_ESCAPES mode).
  const escaped = keyword.replace(/[!%_]/g, (m) => `!${m}`);
  const rows = await db.all(
    `SELECT u.id, u.name, u.student_number
     FROM users u
     WHERE u.role_id = ? AND u.is_active = 1
       AND (u.student_number LIKE ? ESCAPE '!' OR u.name LIKE ? ESCAPE '!')
       ${scoped
        ? `AND EXISTS (SELECT 1 FROM class_students cs WHERE cs.student_id = u.id AND cs.class_id IN (${classIds!.map(() => "?").join(",")}))`
        : ""}
     ORDER BY u.student_number
     LIMIT 20`,
    ROLE_IDS.STUDENT, `${escaped}%`, `%${escaped}%`, ...(scoped ? classIds! : [])
  ) as Array<{ id: number; name: string; student_number: string | null }>;
  return rows.map((r) => ({ id: r.id, name: r.name, student_number: r.student_number }));
}

/**
 * 显式应考名单写入前的范围校验（安全 R29）。
 *
 * 显式名单是**权威应考名单**：写入即决定谁能参加这场考试并出成绩。此前 PUT 只确认目标 ID
 * 是学生账号，教师可把任意年级/班级的学生塞进自己的考试（既越权建立名单，也借名单读到
 * 范围外学生的姓名与考号）。现在要求同时满足两条：
 * 1. 学生属于考试的应考范围——班级考试看该班名册，年级考试看该年级任一名册；
 *    无范围的历史考试不做考试侧收敛；
 * 2. 学生在调用者可访问的班级内——`accessibleClassIds` 为 null（管理员 / 学年主任 /
 *    未配置 teacher_role 的旧部署教师）时不叠加此约束，`[]` 时一律视为越权。
 *
 * 返回越权（含名册缺失、无法判定归属）的学生 ID 列表。
 */
export async function findStudentsOutsideParticipantScope(
  db: DbAdapter,
  exam: { class_id: number | null; grade_id: number | null },
  studentIds: number[],
  accessibleClassIds: number[] | null
): Promise<number[]> {
  if (studentIds.length === 0) return [];
  const placeholders = studentIds.map(() => "?").join(",");
  const inExamScope = new Set<number>();
  if (exam.class_id != null) {
    const rows = await db.all(
      `SELECT cs.student_id FROM class_students cs
       WHERE cs.class_id = ? AND cs.student_id IN (${placeholders})`,
      exam.class_id, ...studentIds
    ) as Array<{ student_id: number }>;
    for (const r of rows) inExamScope.add(Number(r.student_id));
  } else if (exam.grade_id != null) {
    const rows = await db.all(
      `SELECT cs.student_id FROM class_students cs
       JOIN classes c ON c.id = cs.class_id
       WHERE c.grade_id = ? AND cs.student_id IN (${placeholders})`,
      exam.grade_id, ...studentIds
    ) as Array<{ student_id: number }>;
    for (const r of rows) inExamScope.add(Number(r.student_id));
  } else {
    for (const id of studentIds) inExamScope.add(id);
  }
  const outside = studentIds.filter((id) => !inExamScope.has(id));
  if (accessibleClassIds === null) return outside;
  if (accessibleClassIds.length === 0) return [...studentIds];
  const callerPlaceholders = accessibleClassIds.map(() => "?").join(",");
  const rows = await db.all(
    `SELECT cs.student_id FROM class_students cs
     WHERE cs.student_id IN (${placeholders}) AND cs.class_id IN (${callerPlaceholders})`,
    ...studentIds, ...accessibleClassIds
  ) as Array<{ student_id: number }>;
  const accessible = new Set(rows.map((r) => Number(r.student_id)));
  const notAccessible = studentIds.filter((id) => !accessible.has(id));
  return [...new Set([...outside, ...notAccessible])];
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
         AND (
           ep.source = 'explicit'
           OR NOT EXISTS (
             SELECT 1 FROM exam_participants ep_exp
             WHERE ep_exp.exam_id = ep.exam_id AND ep_exp.source = 'explicit'
           )
         )
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
        ? "INSERT OR IGNORE INTO exam_participants (exam_id, student_id, source) SELECT ?, cs.student_id, 'roster' FROM class_students cs JOIN users u ON u.id = cs.student_id JOIN classes c ON c.id = cs.class_id WHERE c.grade_id = ? AND c.archived_at IS NULL"
        : "INSERT IGNORE INTO exam_participants (exam_id, student_id, source) SELECT ?, cs.student_id, 'roster' FROM class_students cs JOIN users u ON u.id = cs.student_id JOIN classes c ON c.id = cs.class_id WHERE c.grade_id = ? AND c.archived_at IS NULL";
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
    // 显式名单是考试参与者的唯一有效集合。必须先移除 roster 快照及旧 explicit 行，
    // 否则 (exam_id, student_id) 主键会让重叠学生的 INSERT IGNORE 静默失败，形成混合名单。
    await tx.run("DELETE FROM exam_participants WHERE exam_id = ?", examId);
    if (uniq.length === 0) return 0;
    const insertSQL = "INSERT INTO exam_participants (exam_id, student_id, source) VALUES (?, ?, 'explicit')";
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
    const row = await db.get(
      `SELECT 1 AS ok
       FROM exam_participants ep
       WHERE ep.exam_id = ? AND ep.student_id = ?
         AND (
           ep.source = 'explicit'
           OR NOT EXISTS (
             SELECT 1 FROM exam_participants ep_exp
             WHERE ep_exp.exam_id = ep.exam_id AND ep_exp.source = 'explicit'
           )
         )
       LIMIT 1`,
      examId,
      studentId
    ) as
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
         AND (
           ep.source = 'explicit'
           OR NOT EXISTS (
             SELECT 1 FROM exam_participants ep_exp
             WHERE ep_exp.exam_id = ep.exam_id AND ep_exp.source = 'explicit'
           )
         )
         AND NOT EXISTS (SELECT 1 FROM student_scores ss WHERE ss.exam_id = ep.exam_id AND ss.student_id = ep.student_id)
       ORDER BY COALESCE(u.student_number, ''), u.name`,
      examId
    ) as Array<{ student_id: number; student_number: string | null; name: string }>;
    return rows;
  } catch {
    return [];
  }
}
