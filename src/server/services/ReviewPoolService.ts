import { databaseTimestamp } from "../db/timestamp";
/**
 * Issue #174: 网阅试卷池
 *
 * 试卷池统一管理每道题块的待批卷子：
 * - 试卷状态为 ready / pending（待复核）/ disputed 且未被领取时，处于池中可领；
 * - 教师通过 claim 原子领取，试卷锁定到该教师（claimed_by/claimed_at），
 *   其他人无法同时打开同一份卷子，从源头避免阅卷冲突；
 * - 提交后由 ReviewService 清空领取标记：pending 回到池中等待下一轮，
 *   reviewed/disputed 离开池子（disputed 被自动改派后仍可再领）；
 * - PR #312 CR1：逐生分配只约束**首评**。双评/三评的卷子回到池中（pending）后，
 *   由题块内其他已分配教师承接——分配切片互不重叠，若复核轮次仍按切片过滤，
 *   首评教师被历史记录挡住、其他人被切片挡住，第二轮就无人可领；
 * - PR #312 CR9：持有量「计数 + 领取」压进同一个临界区（MariaDB 命名锁 + 事务），
 *   避免并发领取各自读到同一旧计数从而突破配额。
 */
import { getMysqlDb } from "../db";
import type { DbAdapter } from "../db";
import { listReviewBlockCrops } from "./AnswerBlockCropService";
import { getAssignmentsByBlock } from "./ReviewAssignmentService";
import { CLAIM_LOCK_TIMEOUT_MS, MAX_HELD_PAPERS_PER_BLOCK, MAX_HELD_PAPERS_TOTAL } from "../../shared/reviewPoolLimits";
import type { ReviewPoolEntry, ReviewPoolSummary } from "../../shared/types";

/** 可领取状态：初始待批 / 复核轮次待批 / 争议待处理 */
const CLAIMABLE_STATUSES = ["ready", "pending", "disputed"];

export class ReviewPoolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewPoolError";
  }
}

/** 越权领取（范围/持有量约束）：与「池里没卷了」的 409 区分开，路由映射为 403 */
export class ReviewPoolScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewPoolScopeError";
  }
}

/**
 * 教师在某题块内的**逐生分配**集合（安全 R15）。
 *
 * 工作量分配（#24）会把具体学生 ID 写进 `review_assignments.assigned_student_ids`，
 * 但领取路径此前完全忽略它：只被分配了 3 名学生的教师，可以领走该题块内任意一份卷子，
 * 于是打开的是别人的学生答案——`requireGradingScope` 只到题块粒度，拦不住这种横向越权。
 *
 * 返回 `null` 表示无逐生约束（该教师在该题块没有分配行，或分配行为空 = 整块可阅），
 * 与既有部署行为保持一致；返回空数组在调用处视为「无卷可领」而非「不限制」。
 */
export async function getAssignedStudentIdSet(
  examId: number,
  blockId: string,
  teacherId: number,
  db: DbAdapter = getMysqlDb()
): Promise<Set<number> | null> {
  const row = await db.get<{ assigned_student_ids: string | null }>(
    `SELECT assigned_student_ids FROM review_assignments
     WHERE exam_id = ? AND block_id = ? AND teacher_id = ?
     LIMIT 1`,
    examId, blockId, teacherId
  );
  if (!row) return null;
  const raw = row.assigned_student_ids;
  if (!raw) return null;
  let ids: unknown;
  try {
    ids = JSON.parse(raw);
  } catch {
    return null; // 存量脏数据（非 JSON）→ 不因此锁死阅卷
  }
  if (!Array.isArray(ids) || ids.length === 0) return null;
  return new Set(ids.map(Number).filter((n) => Number.isFinite(n)));
}

/**
 * 评分历史（`score_breakdown`）解析：脏数据按「无历史」处理，
 * 与既有口径一致——无法解析的历史不应把卷子永久锁死在池中，也不应被当成已完成。
 */
export function parseBreakdownHistory(raw: string | null | undefined): Array<{ reviewerId?: number }> {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as Array<{ reviewerId?: number }> : [];
  } catch {
    return [];
  }
}

/**
 * 卷子是否已离开首评队列：首评已提交（等待下一评）、已评完，或转入争议池。
 * 争议卷同样放行——`autoAssignDisputedCrop` 本就会将争议卷改派给「已分配本题块且
 * 未评过该生」的教师，逐生切片不该把改派目标再次挡掉。
 */
function isPostFirstRound(crop: { status?: string | null; reviewRound?: number | null }): boolean {
  if (Number(crop.reviewRound ?? 0) > 0) return true;
  const status = crop.status ?? "ready";
  return status === "pending" || status === "disputed";
}

/**
 * 逐生分配下某份卷子对本教师是否可阅（安全 R15 + PR #312 CR1）。
 *
 * `assigned_student_ids` 切的是**首评**工作量；切片之间互不重叠（`RandomDistributionService`
 * 顺序切分），所以卷子一旦离开首评队列就必须放开给题块内的其他教师，否则第二评永远无人可领：
 * 首评人被评分历史挡住、其他人被切片挡住。`assignedIds = null` 表示该教师在本题块没有
 * 逐生约束（整块可阅）。
 */
export function isClaimableForAssignedSet(
  crop: { studentId?: number | null; status?: string | null; reviewRound?: number | null },
  assignedIds: Set<number> | null
): boolean {
  if (!assignedIds) return true;
  if (assignedIds.has(Number(crop.studentId))) return true;
  return isPostFirstRound(crop);
}

/** SQL 版「离开首评队列」判定，与 `isPostFirstRound` 同口径（领取候选在库里就要收敛，不能整块捞回内存） */
function postFirstRoundSqlClause(): string {
  return "(answer_block_crops.review_round > 0 OR answer_block_crops.status IN ('pending','disputed'))";
}

/** 可阅范围 SQL 片段：以 `abc` 为 `answer_block_crops` 别名的布尔条件 + 对应占位符参数 */
export interface AssignedSliceClause {
  sql: string;
  params: unknown[];
}

/** 别名版的「离开首评队列」判定，与 `isClaimableForAssignedSet` 同口径 */
const POST_FIRST_ROUND_ALIASED = "(abc.review_round > 0 OR abc.status IN ('pending','disputed'))";

/**
 * 把逐生分配翻译成 SQL（安全 R15 的读取侧补全，PR #312 评审 B1）。
 *
 * `assigned_student_ids` 此前只作用在**领取**与**切块原图**两处，切块清单
 * （`GET /api/review/exams/:examId/block-crops`）与阅卷溯源（`.../trace`）只收到题块粒度：
 * 同一题块被切成两半时，A 教师能从清单里读到 B 教师那半学生的姓名、学号、每题得分与评审人，
 * 只是点开原图会被拒——「看不见图但看得见答案与分数」仍然是一次横向越权。
 *
 * 判定与 `isClaimableForAssignedSet` 逐条对齐，保证「清单里有的卷子」= 「能领/能回看的卷子」：
 *  - 本人切片内的学生 → 放行；
 *  - 已离开首评队列（二评/争议/已评完）→ 放行（题块内互不重叠的切片不该挡住复核与回看）；
 *  - 本人已领取（`claimed_by`）→ 放行；
 *  - 该教师在本题块没有切片（无分配行 / 分配行为空 / 脏数据）→ 整块放行，与存量部署一致。
 *
 * 全场景无切片时返回 `null`：调用方**不追加任何条件**，行为与改动前完全一致。
 * 逐块查询而不是批量捞：一个教师的可见题块本就个位数，且这样能与 `getAssignedStudentIdSet`
 * 共用同一份「首行 + JSON 解析失败视为无约束」的判据，不会出现清单与原图口径不一致。
 */
export async function buildAssignedSliceClause(
  examId: number,
  teacherId: number,
  blockIds: string[],
  db: DbAdapter = getMysqlDb()
): Promise<AssignedSliceClause | null> {
  if (blockIds.length === 0) return null;
  const parts: AssignedSliceClause[] = [];
  const unconstrained: string[] = [];
  for (const blockId of blockIds) {
    const assigned = await getAssignedStudentIdSet(examId, blockId, teacherId, db);
    if (!assigned) { unconstrained.push(blockId); continue; }
    const ids = Array.from(assigned);
    const inList = ids.length > 0 ? `abc.student_id IN (${ids.map(() => "?").join(",")})` : "0";
    parts.push({
      sql: `(abc.block_id = ? AND (${inList} OR ${POST_FIRST_ROUND_ALIASED} OR abc.claimed_by = ?))`,
      params: [blockId, ...ids, teacherId]
    });
  }
  if (parts.length === 0) return null;
  if (unconstrained.length > 0) {
    parts.unshift({
      sql: `abc.block_id IN (${unconstrained.map(() => "?").join(",")})`,
      params: unconstrained
    });
  }
  return { sql: `(${parts.map(p => p.sql).join(" OR ")})`, params: parts.flatMap(p => p.params) };
}

/** 统计教师当前持有（已领取未提交）的卷子数：题块内与全局（安全 R15 的持有量约束） */
export async function countHeldPapers(
  teacherId: number,
  scope: { examId: number; blockId: string },
  db: DbAdapter = getMysqlDb()
): Promise<{ inBlock: number; total: number }> {
  const totalRow = await db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM answer_block_crops WHERE claimed_by = ?",
    teacherId
  ) as { n: number } | undefined;
  const blockRow = await db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM answer_block_crops WHERE claimed_by = ? AND exam_id = ? AND block_id = ?",
    teacherId, scope.examId, scope.blockId
  ) as { n: number } | undefined;
  return { inBlock: Number(blockRow?.n ?? 0), total: Number(totalRow?.n ?? 0) };
}

/** 持有量闸门（安全 R15 + PR #312 CR9）：超限直接拒绝，避免个别教师占满题块。
 *  必须在领取临界区内调用（见 `withClaimReservation`）——先查后写分离时，并发领取会读到同一旧计数。
 *  特权阅卷人（管理员/学年主任）豁免——他们负责处理积压与争议卷，持有量本就该不受配额限制。 */
async function assertHeldQuota(
  examId: number,
  blockId: string,
  teacherId: number,
  db: DbAdapter,
  exempt = false
): Promise<void> {
  if (exempt) return;
  const held = await countHeldPapers(teacherId, { examId, blockId }, db);
  if (held.inBlock >= MAX_HELD_PAPERS_PER_BLOCK) {
    throw new ReviewPoolScopeError(
      `你在本题块已持有 ${held.inBlock} 份未提交试卷，达到上限 ${MAX_HELD_PAPERS_PER_BLOCK} 份；请先批阅提交或释放回池`
    );
  }
  if (held.total >= MAX_HELD_PAPERS_TOTAL) {
    throw new ReviewPoolScopeError(
      `你累计持有 ${held.total} 份未提交试卷，达到全局上限 ${MAX_HELD_PAPERS_TOTAL} 份；请先批阅提交或释放回池`
    );
  }
}

function statusClause(column = "status"): string {
  return `${column} IN ('${CLAIMABLE_STATUSES.join("','")}')`;
}

/**
 * 领取临界区（PR #312 CR9）：把「读持有量 → 选卷子 → 占卷」串到同一位教师的一把锁里。
 *
 * 只做「检查 + 写入」的普通事务并不原子：MariaDB 下两个并发领取各自读到同一个旧计数
 * （COUNT 走一致性快照，看不见对方未提交的 UPDATE），于是 20 份的配额能领到 25 份。
 * 锁名按教师，跨题块与全局两档配额因此都在同一个临界区内结算。
 * SQLite 走单连接同步驱动，事务本身已互斥；命名锁只在 MariaDB 侧需要。
 * 锁必须与事务共用同一条连接（`GET_LOCK` 是连接级状态），因此只在 tx 内取放。
 */
async function withClaimReservation<T>(
  db: DbAdapter,
  teacherId: number,
  exempt: boolean,
  fn: () => Promise<T>
): Promise<T> {
  // 特权阅卷人不占配额，也就没有需要结算的临界区；SQLite 侧事务本身互斥，无需命名锁。
  if (exempt || db.dialect !== "mariadb") return await fn();
  // 锁名只允许 [0-9a-zA-Z_] 且 ≤64 字符：teacherId 已是数字主键
  const lockName = `px_review_claim_${teacherId}`;
  // GET_LOCK 的等待参数单位是**秒**，而档位按毫秒交付（与其它 PROJECTX_* 时间口径一致）。
  // 直接把 3000 传进去等于等 3000 秒：并发一挤就是几十分钟挂住请求并占满连接池。
  const waitSeconds = Math.max(1, Math.round(CLAIM_LOCK_TIMEOUT_MS / 1000));
  const acquired = await db.get<{ locked: number | string | null }>(
    "SELECT GET_LOCK(?, ?) AS locked",
    lockName, waitSeconds
  ) as { locked: number | string | null } | undefined;
  if (Number(acquired?.locked ?? 0) !== 1) {
    throw new ReviewPoolError(`领取并发过高，等待锁超过 ${CLAIM_LOCK_TIMEOUT_MS} 毫秒，请重试`);
  }
  try {
    return await fn();
  } finally {
    // 命名锁是连接级状态、不随事务提交释放；本连接归还池中前必须显式放锁，否则后续请求会白等超时。
    await db.get("SELECT RELEASE_LOCK(?) AS released", lockName);
  }
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
  options: { claimedBy?: number; assignedStudentIds?: Set<number> | null } = {},
  db: DbAdapter = getMysqlDb()
): Promise<ReviewPoolEntry[]> {
  let crops = await listReviewBlockCrops({ examId, blockId }, db);
  // 安全 R15：池子列表带学生姓名/学号，逐生分配的教师只应看到自己那部分；
  // PR #312 CR1：待复核的卷子对他同样可领，清单必须一起显示，否则「能领到却看不见」。
  if (options.assignedStudentIds) {
    crops = crops.filter((crop) => isClaimableForAssignedSet(crop, options.assignedStudentIds!));
  }
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
  options: { classId?: number; privileged?: boolean } = {}
): Promise<ReviewPoolEntry> {
  const privileged = options.privileged === true;
  const assignedIds = await getAssignedStudentIdSet(examId, blockId, teacherId, db);
  const cropId = await db.transaction(async (tx) => withClaimReservation(tx, teacherId, privileged, async () => {
    // 安全 R15 + PR #312 CR9：持有量在领取临界区内结算，「先查后写」分离时并发能突破配额
    await assertHeldQuota(examId, blockId, teacherId, tx, privileged);
    const classFilter = options.classId
      ? `AND EXISTS (SELECT 1 FROM class_students cs WHERE cs.student_id = answer_block_crops.student_id AND cs.class_id = ?)`
      : "";
    const classParams = options.classId ? [options.classId] : [];
    // 安全 R15：分配行写明学生集合时首评只看自己的切片；
    // PR #312 CR1：切片互不重叠，一旦卷子离开首评队列就放开给题块内其他教师。
    const inSliceSql = assignedIds && assignedIds.size > 0
      ? `answer_block_crops.student_id IN (${[...assignedIds].map(() => "?").join(",")})`
      : "";
    const assignedFilter = assignedIds
      ? inSliceSql
        ? `AND (${postFirstRoundSqlClause()} OR ${inSliceSql})`
        : `AND ${postFirstRoundSqlClause()}`
      : "";
    const assignedParams = assignedIds ? [...assignedIds] : [];
    // 切片内的卷子优先：否则他人「已首评待二评」的卷子会按学号排在前头，
    // 把本人尚未开评的首评工作量挤到队尾（切片分工的本意）。
    const orderAffinity = inSliceSql ? `(${inSliceSql}) DESC, ` : "";
    const candidates = await tx.all(
      `SELECT id, score_breakdown FROM answer_block_crops
       WHERE exam_id = ? AND block_id = ? AND ${statusClause()} AND claimed_by IS NULL ${classFilter} ${assignedFilter}
       ORDER BY ${orderAffinity}student_number, page_number, segment_index`,
      examId,
      blockId,
      ...classParams,
      ...assignedParams,
      ...(assignedIds && assignedIds.size > 0 ? [...assignedIds] : [])
    ) as Array<{ id: string; score_breakdown: string | null }>;
    // 同一份卷不让同一人评两次（复核轮次由题块内的其他教师承接）
    const candidate = candidates.find((item) =>
      !parseBreakdownHistory(item.score_breakdown).some((review) => review.reviewerId === teacherId)
    );
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
  }));
  return getPoolEntry(examId, blockId, cropId, db);
}

/** 领取指定试卷（仅池中未被领取时成功） */
export async function claimSpecificPaper(
  examId: number,
  blockId: string,
  cropId: string,
  teacherId: number,
  db: DbAdapter = getMysqlDb(),
  options: { privileged?: boolean } = {}
): Promise<ReviewPoolEntry> {
  const privileged = options.privileged === true;
  await db.transaction(async (tx) => withClaimReservation(tx, teacherId, privileged, async () => {
    // 安全 R15：持有量上限 + 逐生分配范围（指定 crop 时越权要显式拒绝，而非静默领到别人的卷子）
    await assertHeldQuota(examId, blockId, teacherId, tx, privileged);
    const assignedIds = await getAssignedStudentIdSet(examId, blockId, teacherId, tx);
    const existing = await tx.get<{
      score_breakdown: string | null;
      student_id: number | null;
      status: string | null;
      review_round: number | null;
    }>(
      "SELECT score_breakdown, student_id, status, review_round FROM answer_block_crops WHERE id = ? AND exam_id = ? AND block_id = ?",
      cropId, examId, blockId
    ) as {
      score_breakdown: string | null;
      student_id: number | null;
      status: string | null;
      review_round: number | null;
    } | undefined;
    // 已评过的人不能再领（含自己首评后的复核轮次），复核由题块内的其他人承接
    if (parseBreakdownHistory(existing?.score_breakdown).some((review) => review.reviewerId === teacherId)) {
      throw new ReviewPoolError("您已批阅过该试卷，不能重复领取");
    }
    // PR #312 CR1：待复核卷子跨切片可领，范围判定与自动领取共用同一谓词，两条路径不会走出两套规则
    if (existing && !isClaimableForAssignedSet(
      { studentId: existing.student_id, status: existing.status, reviewRound: existing.review_round },
      assignedIds
    )) {
      throw new ReviewPoolScopeError("该试卷不在你的逐生分配范围内，请改用题块内的自动领取");
    }
    const now = databaseTimestamp();
    const result = await tx.run(
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
      const row = await tx.get(
        "SELECT claimed_by FROM answer_block_crops WHERE id = ? AND exam_id = ? AND block_id = ?",
        cropId,
        examId,
        blockId
      ) as { claimed_by: number | null } | undefined;
      if (!row) throw new ReviewPoolError("试卷不存在");
      if (row.claimed_by != null) throw new ReviewPoolError("该试卷已被其他教师领取");
      throw new ReviewPoolError("该试卷当前不可领取（已批阅或正在处理）");
    }
    return cropId;
  }));
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
