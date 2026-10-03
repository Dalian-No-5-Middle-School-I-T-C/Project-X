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
 * 归档关系是**刻意保留的历史记录**——`scripts/verify-class-archive.ts` 明确断言归档后
 * `class_students` / `teacher_classes` 的行仍在，成绩与名单才可复现。
 *
 * 「在读」判定（班级与其所属年级均未归档）同时是读取侧「当前班级 / 展示班级」的
 * 排序首键：多行关联的归班歧义不在写入侧删除（多班在读成员合法，见 #308），
 * 而是由 repositories/AnalysisRepository.ts 的 CURRENT_CLASS_* 与 DISPLAY_CLASS_ORDER
 * 按「在读优先 → joined_at 最新 → class_id 最大」统一消解。
 */
