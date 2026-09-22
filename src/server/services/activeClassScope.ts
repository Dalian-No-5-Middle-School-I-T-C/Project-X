import type { DbAdapter } from "../db";

/** Archived organization records remain readable for history, but cannot be newly assigned. */
export async function assertActiveClassScope(db: DbAdapter, gradeId?: number, classId?: number): Promise<void> {
  const archivedGrade = gradeId == null ? null : await db.get(
    "SELECT id FROM grades WHERE id = ? AND archived_at IS NOT NULL", gradeId,
  );
  const archivedClass = classId == null ? null : await db.get(
    `SELECT c.id FROM classes c JOIN grades g ON g.id = c.grade_id
     WHERE c.id = ? AND (c.archived_at IS NOT NULL OR g.archived_at IS NOT NULL)`, classId,
  );
  if (archivedGrade || archivedClass) {
    throw Object.assign(new Error("所选年级或班级已归档，请重新选择"), { status: 400, code: "CLASS_ARCHIVED" });
  }
}
