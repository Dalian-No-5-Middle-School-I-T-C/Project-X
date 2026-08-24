/**
 * 考试参与者快照服务（评审 P1-1）。
 *
 * 背景：原发布完整性只比人数（COUNT scored vs COUNT roster），外班/误识别学生可凑数绕过
 *       "部分成绩禁止公布"的门控（例：名册 A/B，只录 A + 外班 C，计数 2/2 放行）。
 *
 * 设计：
 * - 快照表 exam_participants (exam_id, student_id) 在"阅卷入库开始"（首次成绩写入）或
 *   "公布校验"（存量 closed 库兜底）时固化当前班级/年级名册；之后调班不再改变历史判断。
 * - 发布校验改为集合校验：应考学生集合 ⊆ 已评分学生集合（required ⊆ scored）。缺任何一人即 409。
 * - 阅卷入库时拒绝不属于参与者快照的学生（名单不可知时不拦截）。
 *
 * 单场/批量公布共用同一谓词 assertGradingComplete。
 * 空班级（快照 0 行）视为无强制名单，兼容空名册存量/测试库。
 */
import type { DbAdapter } from "../db";

export async function ensureExamParticipants(
  db: DbAdapter,
  examId: number
): Promise<{ rosterKnown: boolean; participantCount: number }> {
  const exam = await db.get("SELECT class_id, grade_id FROM exams WHERE id = ?", examId) as
    | { class_id: number | null; grade_id: number | null }
    | undefined;
  if (!exam) return { rosterKnown: false, participantCount: 0 };

  const rosterKnown = exam.class_id != null || exam.grade_id != null;
  if (!rosterKnown) return { rosterKnown: false, participantCount: 0 };

  const cntRow = await db.get("SELECT COUNT(*) AS cnt FROM exam_participants WHERE exam_id = ?", examId) as
    | { cnt: number }
    | undefined;
  const existing = Number(cntRow?.cnt ?? 0);
  if (existing > 0) return { rosterKnown: true, participantCount: existing };

  // 冻结当前名册（幂等：重复插入由主键忽略）
  const isSqlite = db.dialect === "sqlite";
  try {
    if (exam.class_id != null) {
      const sql = isSqlite
        ? "INSERT OR IGNORE INTO exam_participants (exam_id, student_id) SELECT ?, student_id FROM class_students WHERE class_id = ?"
        : "INSERT IGNORE INTO exam_participants (exam_id, student_id) SELECT ?, student_id FROM class_students WHERE class_id = ?";
      await db.run(sql, examId, exam.class_id);
    } else if (exam.grade_id != null) {
      const sql = isSqlite
        ? "INSERT OR IGNORE INTO exam_participants (exam_id, student_id) SELECT ?, cs.student_id FROM class_students cs JOIN classes c ON c.id = cs.class_id WHERE c.grade_id = ?"
        : "INSERT IGNORE INTO exam_participants (exam_id, student_id) SELECT ?, cs.student_id FROM class_students cs JOIN classes c ON c.id = cs.class_id WHERE c.grade_id = ?";
      await db.run(sql, examId, exam.grade_id);
    }
  } catch {
    // 表不存在（旧库未迁移）时视作名单不可知，不阻塞流程
  }

  try {
    const after = await db.get("SELECT COUNT(*) AS cnt FROM exam_participants WHERE exam_id = ?", examId) as
      | { cnt: number }
      | undefined;
    return { rosterKnown: true, participantCount: Number(after?.cnt ?? 0) };
  } catch {
    return { rosterKnown: false, participantCount: 0 };
  }
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
