import type { DbAdapter } from "../db";
import { buildInsertIgnore } from "../db/mysql";

/** Exam membership is captured once per student and stays frozen afterwards,
 * so an unrelated later write cannot relabel an earlier exam. Call inside the
 * same transaction as the roster/score/membership write.
 * Exception: an explicit class change re-anchors the history — see {@link reanchorStudentExamClasses}. */
export async function captureExamClasses(db: DbAdapter, examId: number, studentId: number): Promise<void> {
  // Existing immutable snapshots need no further write or membership lookup.
  if (await db.get("SELECT 1 FROM exam_class_memberships WHERE exam_id = ? AND student_id = ? LIMIT 1", examId, studentId)) return;
  // Serialize against class moves and additions on MariaDB as well as SQLite.
  await db.run("UPDATE users SET name = name WHERE id = ?", studentId);
  // Locking reads use the current state even when a MariaDB transaction began
  // its repeatable-read snapshot before waiting for the student's write lock.
  const currentRead = db.dialect === "mariadb" ? " FOR UPDATE" : "";
  if (await db.get(`SELECT 1 FROM exam_class_memberships WHERE exam_id = ? AND student_id = ? LIMIT 1${currentRead}`, examId, studentId)) return;
  const rows = await db.all<{ class_id: number; joined_at: string }>(`
    SELECT cs.class_id, cs.joined_at FROM class_students cs
    JOIN classes c ON c.id = cs.class_id JOIN grades g ON g.id = c.grade_id
    JOIN exams e ON e.id = ?
    WHERE cs.student_id = ?
      AND (e.class_id IS NULL OR e.class_id = cs.class_id)
      AND (e.class_id IS NOT NULL OR e.grade_id IS NULL OR e.grade_id = c.grade_id)
      AND (e.class_id IS NOT NULL
        OR (c.archived_at IS NULL AND g.archived_at IS NULL)
        OR NOT EXISTS (SELECT 1 FROM class_students cs_active
          JOIN classes c_active ON c_active.id = cs_active.class_id
          JOIN grades g_active ON g_active.id = c_active.grade_id
          WHERE cs_active.student_id = cs.student_id
            AND (e.grade_id IS NULL OR c_active.grade_id = e.grade_id)
            AND c_active.archived_at IS NULL AND g_active.archived_at IS NULL))${currentRead}`, examId, studentId);
  const insert = buildInsertIgnore(db.dialect, "exam_class_memberships", ["exam_id", "student_id", "class_id", "joined_at"]);
  if (rows.length === 0) await db.run(insert, examId, studentId, 0, null);
  else for (const row of rows) await db.run(insert, examId, studentId, row.class_id, row.joined_at);
}

/** All historical participants, including students whose score was withdrawn. */
export async function captureExistingExamClasses(db: DbAdapter, examId: number): Promise<void> {
  const students = await db.all<{ student_id: number }>(
    `SELECT ep.student_id FROM exam_participants ep WHERE ep.exam_id = ?
       AND NOT EXISTS (SELECT 1 FROM exam_class_memberships snap WHERE snap.exam_id = ep.exam_id AND snap.student_id = ep.student_id)
     UNION SELECT ss.student_id FROM student_scores ss WHERE ss.exam_id = ?
       AND NOT EXISTS (SELECT 1 FROM exam_class_memberships snap WHERE snap.exam_id = ss.exam_id AND snap.student_id = ss.student_id)
     ORDER BY student_id`,
    examId, examId);
  for (const student of students) await captureExamClasses(db, examId, student.student_id);
}

/**
 * 人工调班（转班、转年级、留级跳级）后，把该生全部考试的班级归属重写为改动后的班级。
 *
 * 学校口径（issue #347）：考号不变的学生一经调班，他的每次考试都按新班统计，
 * 因此回溯覆盖既有快照，而不是只影响之后的考试。快照的常规不可变性仍由
 * {@link captureExamClasses} 保证——只有显式的班级变更才走这里。
 * 学生已无在读班级时保持原样：只剩归档关联时也没有更好的归属可写，
 * 不能把历次考试整体改挂到旧归档班。
 */
export async function reanchorStudentExamClasses(db: DbAdapter, studentId: number): Promise<void> {
  const links = await db.all<{ class_id: number; joined_at: string | null; grade_id: number; active: number }>(`
    SELECT cs.class_id, cs.joined_at, c.grade_id,
      CASE WHEN c.archived_at IS NULL AND g.archived_at IS NULL THEN 1 ELSE 0 END AS active
    FROM class_students cs JOIN classes c ON c.id = cs.class_id JOIN grades g ON g.id = c.grade_id
    WHERE cs.student_id = ? ORDER BY cs.joined_at, cs.class_id`, studentId);
  const active = links.filter(link => Number(link.active) === 1);
  if (active.length === 0) return;
  const preferred = active;
  const exams = await db.all<{ exam_id: number; class_id: number | null; grade_id: number | null }>(
    `SELECT e.id AS exam_id, e.class_id, e.grade_id FROM exams e
     WHERE e.id IN (SELECT DISTINCT exam_id FROM exam_class_memberships WHERE student_id = ?)
     ORDER BY e.id`, studentId);
  const insert = buildInsertIgnore(db.dialect, "exam_class_memberships", ["exam_id", "student_id", "class_id", "joined_at"]);
  for (const exam of exams) {
    const inScope = preferred.filter(link =>
      (exam.class_id == null || link.class_id === exam.class_id)
      && (exam.class_id != null || exam.grade_id == null || link.grade_id === exam.grade_id));
    // 考试范围与学生现班不再重合（跨年级调班、原班专属考试）时仍归到现班。
    const resolved = inScope.length > 0 ? inScope : preferred;
    await db.run("DELETE FROM exam_class_memberships WHERE exam_id = ? AND student_id = ?", exam.exam_id, studentId);
    for (const link of resolved) await db.run(insert, exam.exam_id, studentId, link.class_id, link.joined_at ?? null);
  }
}

/** Snapshot first, with the legacy roster as fallback for exams not yet captured.
 * Internal SQL identifiers only; never pass request data to these helpers. */
export function examClassJoin(studentColumn: string, examColumn: string, alias = "cs"): string {
  return `LEFT JOIN exam_class_memberships ${alias}
    ON ${alias}.student_id = ${studentColumn} AND ${alias}.exam_id = ${examColumn}
    LEFT JOIN class_students ${alias}_live
      ON ${alias}_live.student_id = ${studentColumn} AND ${alias}.exam_id IS NULL`;
}

export function examClassId(alias = "cs"): string {
  return `NULLIF(COALESCE(${alias}.class_id, ${alias}_live.class_id), 0)`;
}

export function examClassJoinedAt(alias = "cs"): string {
  return `COALESCE(${alias}.joined_at, ${alias}_live.joined_at)`;
}

/** EXISTS avoids multiplying question/score rows when filtering a class. */
export function examClassPredicate(studentColumn: string, examColumn: string, unknown = false, classColumn = "?"): string {
  const known = `EXISTS (SELECT 1 FROM users ecm_user
    ${examClassJoin("ecm_user.id", examColumn, "ecm_scope")}
    WHERE ecm_user.id = ${studentColumn} AND ${examClassId("ecm_scope")} ${unknown ? "IS NOT NULL" : `= ${classColumn}`})`;
  return unknown ? `NOT ${known}` : known;
}

export function examDisplayClass(studentColumn: string, examColumn: string): string {
  return `(SELECT ${examClassId("ecm_display")} FROM users ecm_user
    ${examClassJoin("ecm_user.id", examColumn, "ecm_display")}
    LEFT JOIN classes ecm_class ON ecm_class.id = ${examClassId("ecm_display")}
    LEFT JOIN grades ecm_grade ON ecm_grade.id = ecm_class.grade_id
    WHERE ecm_user.id = ${studentColumn}
    ORDER BY (ecm_class.id IS NOT NULL AND ecm_class.archived_at IS NULL AND ecm_grade.archived_at IS NULL) DESC,
      ${examClassJoinedAt("ecm_display")} DESC, ${examClassId("ecm_display")} DESC LIMIT 1)`;
}
