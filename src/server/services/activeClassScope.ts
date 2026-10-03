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

/**
 * 「当前归属」的班级关联判定，与 {@link assertActiveClassScope} 同口径：
 * 班级本身与其所属年级都未归档，这条 class_students 行才代表学生现在的班。
 *
 * 归档关系是**刻意保留的历史记录**——`scripts/verify-class-archive.ts` 明确断言归档后
 * `class_students` / `teacher_classes` 的行仍在，成绩与名单才可复现。
 * 因此「一名学生一份班级关联」这条不变量只能作用在当前归属上，
 * 任何清理都必须带上这个条件，否则调班/重新导入会把学生读过的历史班级一并抹掉。
 *
 * 子查询引用的是 classes/grades 而非被删表本身，SQLite 与 MariaDB 同一条 SQL 通用。
 */
export const ACTIVE_CLASS_STUDENTS_LINK_FILTER = `
  class_id IN (
    SELECT c.id FROM classes c
    JOIN grades g ON g.id = c.grade_id
    WHERE c.archived_at IS NULL AND g.archived_at IS NULL
  )`;

/** 清空某学生当前的分班关联（保留归档班级的历史关联），供「先删后绑」路径复用。 */
export async function clearActiveStudentClassLinks(tx: DbAdapter, studentId: number): Promise<void> {
  await tx.run(
    `DELETE FROM class_students WHERE student_id = ? AND${ACTIVE_CLASS_STUDENTS_LINK_FILTER}`,
    studentId,
  );
}
