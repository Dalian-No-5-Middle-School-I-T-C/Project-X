import type { DbAdapter } from "../db";
import { buildInsertIgnore } from "../db/mysql";

/** Exam membership is immutable once captured. Zero records an unknown class,
 * so assigning a class later cannot relabel an earlier exam. Call inside the
 * same transaction as the roster/score/membership write. */
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
