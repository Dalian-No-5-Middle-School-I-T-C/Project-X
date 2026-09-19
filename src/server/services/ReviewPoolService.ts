import { databaseTimestamp } from "../db/timestamp";
/**
 * Issue #174: 网阅试卷池
 *
 * 试卷池统一管理每道题块的待批卷子：
 * - 试卷状态为 ready / pending（待复核）/ disputed 且未被领取时，处于池中可领；
 * - 教师通过 claim 原子领取，试卷锁定到该教师（claimed_by/claimed_at），
 *   其他人无法同时打开同一份卷子，从源头避免阅卷冲突；
 * - 提交后由 ReviewService 清空领取标记：pending 回到池中等待下一轮，
 *   reviewed/disputed 离开池子（disputed 被自动改派后仍可再领）。
 */
import { getMysqlDb } from "../db";
import type { DbAdapter } from "../db";
import { listReviewBlockCrops } from "./AnswerBlockCropService";
import { getAssignmentsByBlock } from "./ReviewAssignmentService";
import type { ReviewPoolEntry, ReviewPoolSummary } from "../../shared/types";

/** 可领取状态：初始待批 / 复核轮次待批 / 争议待处理 */
const CLAIMABLE_STATUSES = ["ready", "pending", "disputed"];

export class ReviewPoolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewPoolError";
  }
}

function statusClause(column = "status"): string {
  return `${column} IN ('${CLAIMABLE_STATUSES.join("','")}')`;
}

/** 试卷池汇总：总量 / 池中可领 / 已领 / 已阅 / 争议 / 待复核，及各教师领取与完成情况 */
export async function getPoolSummary(
  examId: number,
  blockId: string,
  teacherId?: number,
  db: DbAdapter = getMysqlDb()
): Promise<ReviewPoolSummary> {
  const rows = await db.all(
    `SELECT status, claimed_by, score_breakdown
     FROM answer_block_crops
     WHERE exam_id = ? AND block_id = ?`,
    examId,
    blockId
  ) as Array<{ status: string | null; claimed_by: number | null; score_breakdown: string | null }>;

  let totalCount = 0;
  let inPoolCount = 0;
  let claimedCount = 0;
  let reviewedCount = 0;
  let disputedCount = 0;
  let pendingCount = 0;
  let myClaimedCount = 0;

  for (const row of rows) {
    const count = 1;
    const status = row.status ?? "ready";
    totalCount += count;
    if (status === "reviewed") {
      reviewedCount += count;
    } else if (status === "disputed") {
      disputedCount += count;
      if (row.claimed_by == null) inPoolCount += count;
    } else if (status === "pending") {
      pendingCount += count;
      if (row.claimed_by == null) inPoolCount += count;
    } else if (status === "ready") {
      if (row.claimed_by == null) inPoolCount += count;
    }
    if (row.claimed_by != null) {
      claimedCount += count;
      if (teacherId != null && row.claimed_by === teacherId) myClaimedCount += count;
    }
  }

  const assignments = await getAssignmentsByBlock(examId, blockId, db);
  const assignmentSummaries: ReviewPoolSummary["assignments"] = [];
  for (const assignment of assignments) {
    let claimed = 0;
    let reviewed = 0;
    for (const row of rows) {
      if (row.claimed_by === assignment.teacherId) claimed += 1;
      try {
        const history = row.score_breakdown ? JSON.parse(row.score_breakdown) as Array<{ reviewerId?: number }> : [];
        if (history.some((review) => review.reviewerId === assignment.teacherId)) reviewed += 1;
      } catch { /* malformed legacy history does not count as completed */ }
    }
    assignmentSummaries.push({
      teacherId: assignment.teacherId,
      teacherName: assignment.teacherName,
      assignedCount: assignment.studentCount,
      claimedCount: claimed,
      reviewedCount: reviewed
    });
  }

  return {
    examId,
    blockId,
    totalCount,
    inPoolCount,
    claimedCount,
    reviewedCount,
    disputedCount,
    pendingCount,
    myClaimedCount,
    assignments: assignmentSummaries
  };
}

/** 读取试卷池条目（全部或按领取人过滤），附领取人姓名 */
export async function getPoolEntries(
  examId: number,
  blockId: string,
  options: { claimedBy?: number } = {},
  db: DbAdapter = getMysqlDb()
): Promise<ReviewPoolEntry[]> {
  const crops = await listReviewBlockCrops({ examId, blockId }, db);
  const teacherIds = Array.from(
    new Set(crops.map((crop) => crop.claimedBy).filter((id): id is number => id != null))
  );
  const nameById = new Map<number, string>();
  if (teacherIds.length > 0) {
    const rows = await db.all(
      `SELECT id, name FROM users WHERE id IN (${teacherIds.map(() => "?").join(",")})`,
      ...teacherIds
    ) as Array<{ id: number; name: string }>;
    for (const row of rows) nameById.set(row.id, row.name);
  }

  const entries: ReviewPoolEntry[] = crops.map((crop) => ({
    ...crop,
    claimedByName: crop.claimedBy != null ? (nameById.get(crop.claimedBy) ?? null) : null,
    claimCount: crop.claimCount ?? 0
  }));

  return options.claimedBy === undefined
    ? entries
    : entries.filter((entry) => entry.claimedBy === options.claimedBy);
}

async function getPoolEntry(examId: number, blockId: string, cropId: string, db: DbAdapter): Promise<ReviewPoolEntry> {
  const entries = await getPoolEntries(examId, blockId, {}, db);
  const entry = entries.find((item) => item.id === cropId);
  if (!entry) throw new ReviewPoolError("试卷不存在");
  return entry;
}

/**
 * 从试卷池领取下一份未领取卷子（原子操作）。
 * 并发下多个教师同时领卷时，只有一人能拿到同一份。
 */
export async function claimNextPaper(
  examId: number,
  blockId: string,
  teacherId: number,
  db: DbAdapter = getMysqlDb(),
  options: { classId?: number } = {}
): Promise<ReviewPoolEntry> {
  const cropId = await db.transaction(async (tx) => {
    const classFilter = options.classId
      ? `AND EXISTS (SELECT 1 FROM class_students cs WHERE cs.student_id = answer_block_crops.student_id AND cs.class_id = ?)`
      : "";
    const classParams = options.classId ? [options.classId] : [];
    const candidates = await tx.all(
      `SELECT id, score_breakdown FROM answer_block_crops
       WHERE exam_id = ? AND block_id = ? AND ${statusClause()} AND claimed_by IS NULL ${classFilter}
       ORDER BY student_number, page_number, segment_index`,
      examId,
      blockId,
      ...classParams
    ) as Array<{ id: string; score_breakdown: string | null }>;
    const candidate = candidates.find((item) => {
      try {
        const history = item.score_breakdown ? JSON.parse(item.score_breakdown) as Array<{ reviewerId?: number }> : [];
        return !history.some((review) => review.reviewerId === teacherId);
      } catch { return true; }
    });
    if (!candidate) throw new ReviewPoolError("试卷池暂无可用试卷");

    const now = databaseTimestamp();
    const result = await tx.run(
      `UPDATE answer_block_crops
       SET claimed_by = ?, claimed_at = ?, claim_count = claim_count + 1
       WHERE id = ? AND claimed_by IS NULL AND ${statusClause()}`,
      teacherId,
      now,
      candidate.id
    );
    if (result.changes === 0) {
      throw new ReviewPoolError("试卷刚被其他教师领取，请重试");
    }
    return candidate.id;
  });
  return getPoolEntry(examId, blockId, cropId, db);
}

/** 领取指定试卷（仅池中未被领取时成功） */
export async function claimSpecificPaper(
  examId: number,
  blockId: string,
  cropId: string,
  teacherId: number,
  db: DbAdapter = getMysqlDb()
): Promise<ReviewPoolEntry> {
  const existing = await db.get(
    "SELECT score_breakdown FROM answer_block_crops WHERE id = ? AND exam_id = ? AND block_id = ?",
    cropId, examId, blockId
  ) as { score_breakdown: string | null } | undefined;
  if (existing?.score_breakdown) {
    try {
      const history = JSON.parse(existing.score_breakdown) as Array<{ reviewerId?: number }>;
      if (history.some((review) => review.reviewerId === teacherId)) {
        throw new ReviewPoolError("您已批阅过该试卷，不能重复领取");
      }
    } catch (error) {
      if (error instanceof ReviewPoolError) throw error;
    }
  }
  const now = databaseTimestamp();
  const result = await db.run(
    `UPDATE answer_block_crops
     SET claimed_by = ?, claimed_at = ?, claim_count = claim_count + 1
     WHERE id = ? AND exam_id = ? AND block_id = ? AND claimed_by IS NULL AND ${statusClause()}`,
    teacherId,
    now,
    cropId,
    examId,
    blockId
  );
  if (result.changes === 0) {
    const row = await db.get(
      "SELECT claimed_by FROM answer_block_crops WHERE id = ? AND exam_id = ? AND block_id = ?",
      cropId,
      examId,
      blockId
    ) as { claimed_by: number | null } | undefined;
    if (!row) throw new ReviewPoolError("试卷不存在");
    if (row.claimed_by != null) throw new ReviewPoolError("该试卷已被其他教师领取");
    throw new ReviewPoolError("该试卷当前不可领取（已批阅或正在处理）");
  }
  return getPoolEntry(examId, blockId, cropId, db);
}

/** 释放试卷回池：领取人本人可释放；管理员/年级组长可强制释放 */
export async function releasePaper(
  examId: number,
  blockId: string,
  cropId: string,
  teacherId: number,
  db: DbAdapter = getMysqlDb(),
  options: { force?: boolean } = {}
): Promise<void> {
  const row = await db.get(
    "SELECT claimed_by FROM answer_block_crops WHERE id = ? AND exam_id = ? AND block_id = ?",
    cropId,
    examId,
    blockId
  ) as { claimed_by: number | null } | undefined;
  if (!row) throw new ReviewPoolError("试卷不存在");
  if (!options.force && row.claimed_by !== teacherId) {
    throw new ReviewPoolError("仅领取人本人或管理员可释放该试卷");
  }
  await db.run(
    "UPDATE answer_block_crops SET claimed_by = NULL, claimed_at = NULL WHERE id = ?",
    cropId
  );
}
