import { getMysqlDb } from "../db";
import type { DbAdapter } from "../db";
import { randomDistribute } from "./RandomDistributionService";
import type { ReviewAssignment, TeacherBlockAssignment } from "../../shared/types";

type AssignmentRow = {
  id: number;
  exam_id: number;
  block_id: string;
  teacher_id: number;
  student_count: number;
  assigned_student_ids: string | null;
  created_at: string;
};

function parseAssignedIds(value: string | null): number[] {
  if (!value) return [];
  try {
    return JSON.parse(value) as number[];
  } catch {
    return [];
  }
}

function toReviewAssignment(row: AssignmentRow, teacherName?: string): ReviewAssignment {
  return {
    id: row.id,
    examId: row.exam_id,
    blockId: row.block_id,
    teacherId: row.teacher_id,
    teacherName,
    studentCount: row.student_count,
    assignedStudentIds: parseAssignedIds(row.assigned_student_ids),
    createdAt: row.created_at
  };
}

/** 获取某考试某题块已分配的学生 ID 合集（去重） */
export async function getAssignedStudentIdsForBlock(
  examId: number,
  blockId: string,
  db: DbAdapter = getMysqlDb()
): Promise<Set<number>> {
  const rows = await db.all(
    "SELECT assigned_student_ids FROM review_assignments WHERE exam_id = ? AND block_id = ?",
    examId,
    blockId
  ) as Array<{ assigned_student_ids: string | null }>;
  const ids = new Set<number>();
  for (const row of rows) {
    for (const id of parseAssignedIds(row.assigned_student_ids)) {
      ids.add(id);
    }
  }
  return ids;
}

/** 获取某考试某题块的所有分配 */
export async function getAssignmentsByBlock(
  examId: number,
  blockId: string,
  db: DbAdapter = getMysqlDb()
): Promise<ReviewAssignment[]> {
  const rows = await db.all(
    `SELECT ra.*, u.name AS teacher_name
     FROM review_assignments ra
     JOIN users u ON u.id = ra.teacher_id
     WHERE ra.exam_id = ? AND ra.block_id = ?
     ORDER BY ra.id`,
    examId,
    blockId
  ) as Array<AssignmentRow & { teacher_name: string }>;
  return rows.map((r) => toReviewAssignment(r, r.teacher_name));
}

/** 获取某教师在某考试中的分配 */
export async function getAssignmentsByTeacher(
  examId: number,
  teacherId: number,
  db: DbAdapter = getMysqlDb()
): Promise<ReviewAssignment[]> {
  const rows = await db.all(
    "SELECT * FROM review_assignments WHERE exam_id = ? AND teacher_id = ?",
    examId,
    teacherId
  ) as AssignmentRow[];
  return rows.map((r) => toReviewAssignment(r));
}

/** 批量创建分配（年级组长操作） */
export async function createAssignments(
  examId: number,
  blockId: string,
  teacherCounts: Map<number, number>,
  userId: number,
  db: DbAdapter = getMysqlDb()
): Promise<ReviewAssignment[]> {
  // 获取该考试的全部学生
  const studentRows = await db.all(
    `SELECT DISTINCT ss.student_id
     FROM student_scores ss
     WHERE ss.exam_id = ?
     ORDER BY ss.student_id`,
    examId
  ) as Array<{ student_id: number }>;
  const allStudentIds = studentRows.map((r) => r.student_id);

  const totalRequested = Array.from(teacherCounts.values()).reduce((a, b) => a + b, 0);
  if (totalRequested > allStudentIds.length) {
    throw new Error(`分配总数(${totalRequested})超过考生总数(${allStudentIds.length})`);
  }

  const seed = `${examId}_${blockId}_${Date.now()}`;
  const distribution = randomDistribute(allStudentIds, teacherCounts, seed);

  const assignments: ReviewAssignment[] = [];
  await db.transaction(async (tx) => {
    // 先删除旧分配
    await tx.run("DELETE FROM review_assignments WHERE exam_id = ? AND block_id = ?", examId, blockId);

    for (const [teacherId, studentIds] of distribution) {
      await tx.run(
        `INSERT INTO review_assignments (exam_id, block_id, teacher_id, student_count, assigned_student_ids)
         VALUES (?, ?, ?, ?, ?)`,
        examId,
        blockId,
        teacherId,
        studentIds.length,
        JSON.stringify(studentIds)
      );

      assignments.push({
        id: 0,
        examId,
        blockId,
        teacherId,
        studentCount: studentIds.length,
        assignedStudentIds: studentIds,
        createdAt: new Date().toISOString()
      });
    }
  });

  return assignments;
}

/** 删除某分配 */
export async function deleteAssignment(
  assignmentId: number,
  db: DbAdapter = getMysqlDb()
): Promise<void> {
  await db.run("DELETE FROM review_assignments WHERE id = ?", assignmentId);
}

/** 获取教师可选的题块列表 */
export async function getAvailableBlocksForTeacher(
  examId: number,
  teacherId: number,
  db: DbAdapter = getMysqlDb()
): Promise<TeacherBlockAssignment[]> {
  // 获取该考试所有题块
  const examRow = await db.get("SELECT card_id FROM exams WHERE id = ?", examId) as { card_id: string | null } | undefined;
  if (!examRow?.card_id) return [];

  const cropBlocks = await db.all(
    `SELECT DISTINCT block_id, block_title, block_type
     FROM answer_block_crops
     WHERE exam_id = ?
     ORDER BY block_id`,
    examId
  ) as Array<{ block_id: string; block_title: string | null; block_type: string }>;

  // 获取教师分配
  const assignments = await getAssignmentsByTeacher(examId, teacherId, db);

  // Batch query actual reviewed counts
  let reviewedMap = new Map<string, number>();
  if (assignments.length > 0) {
    const blockIds = assignments.map(a => a.blockId);
    const placeholders = blockIds.map(() => '?').join(',');
    const reviewedCounts = await db.all(
      `SELECT abc.block_id, COUNT(*) AS cnt
       FROM answer_block_crops abc
       WHERE abc.exam_id = ? AND abc.block_id IN (${placeholders})
         AND abc.status = 'reviewed' AND abc.reviewer_id = ?
       GROUP BY abc.block_id`,
      examId, ...blockIds, teacherId
    ) as Array<{ block_id: string; cnt: number }>;
    reviewedMap = new Map(reviewedCounts.map(r => [r.block_id, r.cnt]));
  }

  return cropBlocks.map((block) => {
    const assignment = assignments.find((a) => a.blockId === block.block_id);
    const totalCount = assignment?.studentCount ?? 0;
    const reviewed = reviewedMap.get(block.block_id) ?? 0;

    return {
      blockId: block.block_id,
      blockTitle: block.block_title ?? block.block_id,
      blockType: block.block_type,
      totalCount,
      assignedToMe: totalCount,
      remainingForMe: Math.max(0, totalCount - reviewed),
      isSelected: assignments.some((a) => a.blockId === block.block_id),
      questions: []
    };
  });
}
