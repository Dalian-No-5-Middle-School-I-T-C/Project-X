import { essayReviewIssue, loadEssayReviews, reviewUnitPredicate } from "./essayReview";
import { buildUpsertSQL, getMysqlDb } from "../db";
import type { DbAdapter } from "../db";
import { randomDistribute } from "./RandomDistributionService";
import { getBlockConfig } from "./BlockGradingConfigService";
import { getPermittedBlocks, isPrivilegedGrader } from "../../apps/answer-card/server/middleware";
import {
  MAX_HELD_PAPERS_PER_BLOCK,
  MAX_HELD_PAPERS_TOTAL
} from "../../shared/reviewPoolLimits";
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

/** 评分历史里是否已有该教师的任一票（首评 pending 也算，进度按个人记录统计）。 */
function hasReviewerVote(raw: string | null | undefined, teacherId: number): boolean {
  if (!raw) return false;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.some((entry) =>
      Number((entry as { reviewerId?: number }).reviewerId) === teacherId
    );
  } catch {
    return false;
  }
}

export type AssignmentCreateOptions = {
  /** replace=清空后重新分配；append=保留现有分配，只分配尚未归属的学生 */
  mode?: "replace" | "append";
  /** random=按填写份数随机；equal=忽略份数，把待分配学生均分给所选教师 */
  split?: "random" | "equal";
};

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

/** 批量创建/追加分配（年级组长操作） */
export async function createAssignments(
  examId: number,
  blockId: string,
  teacherCounts: Map<number, number>,
  userId: number,
  db: DbAdapter = getMysqlDb(),
  options: AssignmentCreateOptions = {}
): Promise<ReviewAssignment[]> {
  const mode = options.mode === "append" ? "append" : "replace";
  const split = options.split === "equal" ? "equal" : "random";
  const teacherIds = Array.from(teacherCounts.keys());
  if (teacherIds.length === 0) throw new Error("请至少选择一位阅卷教师");

  // 阅卷任务以题块实际切块为准；没有切块时才回退到成绩名单（演示/旧数据）。
  const cropRows = await db.all(
    `SELECT DISTINCT student_id FROM answer_block_crops a
     WHERE a.exam_id = ? AND a.block_id = ? AND a.student_id IS NOT NULL AND ${reviewUnitPredicate("a")}
     ORDER BY a.student_id`,
    examId,
    blockId
  ) as Array<{ student_id: number }>;
  let allStudentIds = cropRows.map((row) => Number(row.student_id));
  if (allStudentIds.length === 0) {
    const studentRows = await db.all(
      `SELECT DISTINCT ss.student_id
       FROM student_scores ss
       WHERE ss.exam_id = ?
       ORDER BY ss.student_id`,
      examId
    ) as Array<{ student_id: number }>;
    allStudentIds = studentRows.map((r) => r.student_id);
  }

  const existing = mode === "append" ? await getAssignmentsByBlock(examId, blockId, db) : [];
  const assignedIds = new Set<number>();
  for (const assignment of existing) for (const id of assignment.assignedStudentIds) assignedIds.add(id);
  const candidates = allStudentIds.filter((id) => !assignedIds.has(id));
  if (candidates.length === 0) {
    throw new Error(mode === "append" ? "本题块没有尚未分配的学生可追加" : "本题块没有可分配的学生");
  }

  let distribution: Map<number, number[]>;
  if (split === "equal") {
    distribution = new Map();
    const base = Math.floor(candidates.length / teacherIds.length);
    const remainder = candidates.length % teacherIds.length;
    let cursor = 0;
    teacherIds.forEach((teacherId, index) => {
      const count = base + (index < remainder ? 1 : 0);
      distribution.set(teacherId, candidates.slice(cursor, cursor + count));
      cursor += count;
    });
  } else {
    const totalRequested = studentsRequested(teacherCounts);
    if (totalRequested > candidates.length) {
      throw new Error(
        mode === "append"
          ? `追加总数(${totalRequested})超过未分配学生数(${candidates.length})`
          : `分配总数(${totalRequested})超过考生总数(${allStudentIds.length})`
      );
    }
    const seed = `${examId}_${blockId}_${Date.now()}`;
    distribution = randomDistribute(candidates, teacherCounts, seed);
  }

  const upsertSQL = buildUpsertSQL(
    db.dialect,
    "review_assignments",
    ["exam_id", "block_id", "teacher_id", "student_count", "assigned_student_ids", "auto_assigned"],
    ["exam_id", "block_id", "teacher_id"],
    ["student_count", "assigned_student_ids", "auto_assigned"]
  );

  await db.transaction(async (tx) => {
    // 覆盖模式先清空；追加模式保留旧分配并与同教师的新份数合并。
    if (mode === "replace") {
      await tx.run("DELETE FROM review_assignments WHERE exam_id = ? AND block_id = ?", examId, blockId);
    }

    for (const [teacherId, studentIds] of distribution) {
      if (studentIds.length === 0) continue;
      if (mode === "append") {
        const previous = existing.find((assignment) => assignment.teacherId === teacherId);
        const merged = Array.from(new Set([...(previous?.assignedStudentIds ?? []), ...studentIds]));
        await tx.run(upsertSQL, examId, blockId, teacherId, merged.length, JSON.stringify(merged), 0);
      } else {
        await tx.run(
          `INSERT INTO review_assignments (exam_id, block_id, teacher_id, student_count, assigned_student_ids, auto_assigned)
           VALUES (?, ?, ?, ?, ?, 0)`,
          examId,
          blockId,
          teacherId,
          studentIds.length,
          JSON.stringify(studentIds)
        );
      }
    }
  });

  // v1.9.4：若未设仲裁人，自动把剩余/未分配卷均衡派发给已分配本题块的教师（份数差≤阈值）
  await rebalanceWorkload(examId, blockId, db);

  return getAssignmentsByBlock(examId, blockId, db);
}

function studentsRequested(teacherCounts: Map<number, number>): number {
  let total = 0;
  for (const count of teacherCounts.values()) {
    if (!Number.isInteger(count) || count < 0) throw new Error("分配份数必须是非负整数");
    total += count;
  }
  return total;
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
    `SELECT student_id, status, reviewer_id FROM answer_block_crops a WHERE exam_id = ? AND block_id = ? AND ${reviewUnitPredicate("a")}`,
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

  const cropRows = await db.all(
    `SELECT a.id, a.block_id, a.block_title, a.block_type, a.student_id, a.status,
            a.claimed_by, a.review_round, a.score_breakdown
     FROM answer_block_crops a
     WHERE a.exam_id = ? AND ${reviewUnitPredicate("a")}
     ORDER BY a.block_id`,
    examId
  ) as Array<{
    id: string;
    block_id: string;
    block_title: string | null;
    block_type: string;
    student_id: number | null;
    status: string | null;
    claimed_by: number | null;
    review_round: number | null;
    score_breakdown: string | null;
  }>;
  const blockIds = Array.from(new Set(cropRows.map((row) => row.block_id)));
  if (blockIds.length === 0) return [];

  // #24: 教师可见题块与权限矩阵绑定 —— 有约束时仅保留该教师可阅的题块；
  // getPermittedBlocks 在无任何分配/授予时返回 null（全部可见，向后兼容）。
  // 特权阅卷人（管理员/学年主任）不参与过滤，全部可见（L5 修复：避免伪造 user 丢失特权身份）。
  let visibleBlockIds = blockIds;
  const isPrivileged = user ? isPrivilegedGrader(user as { role_id?: number; role_name?: string; teacher_role?: string | null }) : false;
  if (!isPrivileged) {
    const permitted = await getPermittedBlocks({ id: teacherId } as { id?: number }, examId);
    if (permitted !== null) {
      const set = new Set(permitted);
      visibleBlockIds = blockIds.filter((id) => set.has(id));
    }
  }

  const assignments = await getAssignmentsByTeacher(examId, teacherId, db);
  const heldTotalRow = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM answer_block_crops a WHERE a.claimed_by = ? AND ${reviewUnitPredicate("a")}`,
    teacherId
  );

  return Promise.all(visibleBlockIds.map(async (blockId) => {
    const blockCrops = cropRows.filter((row) => row.block_id === blockId);
    const first = blockCrops[0];
    const assignment = assignments.find((item) => item.blockId === blockId);
    const votedStudentIds = new Set<number>();
    for (const crop of blockCrops) {
      if (crop.student_id != null && hasReviewerVote(crop.score_breakdown, teacherId)) {
        votedStudentIds.add(Number(crop.student_id));
      }
    }
    const heldCount = blockCrops.filter((crop) => crop.claimed_by === teacherId).length;
    const quotaLeft = Math.max(0, MAX_HELD_PAPERS_PER_BLOCK - heldCount);
    const globalLeft = Math.max(0, MAX_HELD_PAPERS_TOTAL - Number(heldTotalRow?.n ?? 0));

    // 池中可领：未被领取、仍可评分、且本人还没投过票（同卷复核由其他人承接）。
    // 作文切图不完整的单元不算可领，避免把「能看见但领不了」的份数展示成进度。
    const essays = await loadEssayReviews(db, examId, blockId);
    const claimableCount = blockCrops.filter((crop) => {
      if (crop.claimed_by != null) return false;
      const status = crop.status ?? "ready";
      if (status !== "ready" && status !== "pending" && status !== "disputed") return false;
      if (crop.student_id != null && votedStudentIds.has(Number(crop.student_id))) return false;
      return !essayReviewIssue(essays.get(crop.id), crop.id);
    }).length;
    const claimableNow = Math.min(claimableCount, quotaLeft, globalLeft);

    let totalCount: number;
    let assignedToMe: number;
    let remainingForMe: number;
    let assignMode: "assigned" | "pool";
    if (assignment) {
      const assignedIds = assignment.assignedStudentIds.length > 0
        ? assignment.assignedStudentIds
        : blockCrops.map((crop) => Number(crop.student_id)).filter(Number.isFinite);
      const remainingAssigned = assignedIds.filter((studentId) => !votedStudentIds.has(Number(studentId))).length;
      totalCount = assignment.studentCount || assignedIds.length;
      assignedToMe = totalCount;
      remainingForMe = remainingAssigned;
      assignMode = "assigned";
    } else {
      totalCount = blockCrops.length;
      assignedToMe = 0;
      remainingForMe = claimableNow + heldCount;
      assignMode = "pool";
    }

    return {
      blockId,
      blockTitle: first.block_title ?? blockId,
      blockType: first.block_type,
      totalCount,
      assignedToMe,
      remainingForMe,
      isSelected: Boolean(assignment),
      questions: [],
      assignMode,
      canEnter: isPrivileged || remainingForMe > 0 || heldCount > 0,
      claimableCount: claimableNow,
      heldCount,
      privileged: isPrivileged
    };
  }));
}
