import { getMysqlDb } from "../db";
import type { DbAdapter } from "../db";
import { randomDistribute } from "./RandomDistributionService";
import { getBlockConfig } from "./BlockGradingConfigService";
import { getPermittedBlocks, isPrivilegedGrader } from "../../apps/answer-card/server/middleware";
import type { ReviewAssignment, TeacherBlockAssignment } from "../../shared/types";

type AssignmentRow = {
  id: number;
  exam_id: number;
  block_id: string;
  teacher_id: number;
  student_count: number;
  assigned_student_ids: string | null;
  auto_assigned?: number;
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
    autoAssigned: row.auto_assigned ?? 0,
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
        `INSERT INTO review_assignments (exam_id, block_id, teacher_id, student_count, assigned_student_ids, auto_assigned)
         VALUES (?, ?, ?, ?, ?, 0)`,
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
        autoAssigned: 0,
        createdAt: new Date().toISOString()
      });
    }
  });

  // v1.9.4：若未设仲裁人，自动把剩余/未分配卷均衡派发给已分配本题块的教师（份数差≤阈值）
  await rebalanceWorkload(examId, blockId, db);

  return getAssignmentsByBlock(examId, blockId, db);
}

/**
 * 工作量均衡自动再分配（v1.9.4）。
 *
 * 触发条件：题块未设仲裁人（arbitrator_id 为空）且 auto_reassign_no_arb=1。
 * 行为：在已分配本题块的教师之间搬运「未阅」卷，使任意两位教师的份数差 ≤ workload_balance_threshold。
 * 被追加卷的教师其 assignment 标记 auto_assigned=1（进度条加卷）。
 * 不搬运已阅/争议卷，且不会把卷交给已阅过该生的教师（避免自审）。
 */
export async function rebalanceWorkload(
  examId: number,
  blockId: string,
  db: DbAdapter = getMysqlDb()
): Promise<void> {
  const config = await getBlockConfig(examId, blockId, "answer", 0, db);
  if (config.arbitratorId != null || config.autoReassignNoArb !== 1) return;

  const assignments = await getAssignmentsByBlock(examId, blockId, db);
  if (assignments.length < 2) return;

  const cropRows = await db.all(
    "SELECT student_id, status, reviewer_id FROM answer_block_crops WHERE exam_id = ? AND block_id = ?",
    examId, blockId
  ) as Array<{ student_id: number | null; status: string | null; reviewer_id: number | null }>;
  const cropByStudent = new Map<number, { status: string | null; reviewerId: number | null }>();
  for (const r of cropRows) {
    if (r.student_id != null) cropByStudent.set(r.student_id, { status: r.status, reviewerId: r.reviewer_id });
  }

  type Working = { id: number; teacherId: number; ids: number[]; autoAssigned: number };
  const working: Working[] = assignments.map((a) => ({
    id: a.id,
    teacherId: a.teacherId,
    ids: [...a.assignedStudentIds],
    autoAssigned: a.autoAssigned
  }));

  const alreadyReviewed = (sid: number, teacherId: number): boolean =>
    cropByStudent.get(sid)?.reviewerId === teacherId;

  const isMovable = (sid: number, toTeacherId: number): boolean => {
    const c = cropByStudent.get(sid);
    if (!c) return false;
    if (c.status === "reviewed" || c.status === "disputed") return false; // 已阅/争议不再搬
    if (c.reviewerId === toTeacherId) return false; // 目标已阅过 → 自审
    return true;
  };

  const countOf = (w: Working) => w.ids.length;
  const minByCount = (list: Working[]) => list.reduce((a, b) => (countOf(b) < countOf(a) ? b : a));
  const maxByCount = (list: Working[]) => list.reduce((a, b) => (countOf(b) > countOf(a) ? b : a));

  // 1) 吸收「尚未分配」的卷（分配后剩余未分配卷），派给份数最少且未阅过该生的教师
  const assignedSet = new Set<number>();
  for (const w of working) for (const id of w.ids) assignedSet.add(id);
  const unassignedPool = Array.from(cropByStudent.keys()).filter((s) => !assignedSet.has(s));
  for (const sid of unassignedPool) {
    const eligible = working.filter((w) => !alreadyReviewed(sid, w.teacherId));
    if (eligible.length === 0) continue; // 无合格教师 → 争议池兜底
    const target = minByCount(eligible);
    target.ids.push(sid);
    target.autoAssigned = 1;
    assignedSet.add(sid);
  }

  // 2) 在已分配教师间搬运，使任意两位教师份数差收敛到阈值内
  let guard = 0;
  while (guard++ < 10000) {
    const maxW = maxByCount(working);
    const minW = minByCount(working);
    if (countOf(maxW) - countOf(minW) <= config.workloadBalanceThreshold) break;
    const movableIdx = maxW.ids.findIndex((sid) => isMovable(sid, minW.teacherId));
    if (movableIdx === -1) break; // 无可用卷可搬 → 已达均衡上限
    const [sid] = maxW.ids.splice(movableIdx, 1);
    minW.ids.push(sid);
    minW.autoAssigned = 1;
  }

  await db.transaction(async (tx) => {
    for (const w of working) {
      await tx.run(
        "UPDATE review_assignments SET assigned_student_ids = ?, student_count = ?, auto_assigned = ? WHERE id = ?",
        JSON.stringify(w.ids),
        w.ids.length,
        w.autoAssigned,
        w.id
      );
    }
  });
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
  db: DbAdapter = getMysqlDb(),
  user?: { role_id?: number; role_name?: string; teacher_role?: string | null }
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

  // #24: 教师可见题块与权限矩阵绑定 —— 有约束时仅保留该教师可阅的题块；
  // getPermittedBlocks 在无任何分配/授予时返回 null（全部可见，向后兼容）。
  // 特权阅卷人（管理员/学年主任）不参与过滤，全部可见（L5 修复：避免伪造 user 丢失特权身份）。
  let blocks = cropBlocks;
  const isPrivileged = user ? isPrivilegedGrader(user as any) : false;
  if (!isPrivileged) {
    const permitted = await getPermittedBlocks({ id: teacherId } as any, examId);
    if (permitted !== null) {
      const set = new Set(permitted);
      blocks = cropBlocks.filter((b) => set.has(b.block_id));
    }
  }

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

  return blocks.map((block) => {
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
