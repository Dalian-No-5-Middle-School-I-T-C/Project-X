/**
 * Business-route RBAC middleware (extracted from index.ts).
 *
 * These functions were previously module-scoped closures inside createApp().
 * They are now plain exports so domain routers (analysis, cards, exams)
 * can import and reuse them.
 */
import type express from "express";
import { getMysqlDb, type DbAdapter } from "../../../server/db";
import { ScoreRepository } from "../../../server/repositories/ScoreRepository";
import { roleHasPermission, PERMISSIONS } from "../../../server/auth/permissions";
import { isAuthEnforced } from "../../../server/lib/authEnforce";

// P0-5 (C-S3): 模块级鉴权状态，由 createApp 初始化时设置
// enforceAuth=true 时 requireExamAccess 无用户返回 401；false 时保持向后兼容放行
let authEnforced = isAuthEnforced();
export function setAuthEnforced(v: boolean): void { authEnforced = v; }

// ── Gate factory ──────────────────────────────────────────

/**
 * Creates an RBAC gate middleware.
 *
 * When PROJECTX_AUTH_ENFORCE is off (set to "0"/"false"), the gate is a pass-through
 * so the v1.0 login-free frontend still works.  When ON, unauthenticated
 * requests get 401 and insufficient permissions get 403.
 */
export function makeGate(enforce: boolean, readPerm: string, writePerm: string) {
  return (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    if (!enforce) {
      next();
      return;
    }
    if (!req.user) {
      res.status(401).json({ message: "未提供认证令牌" });
      return;
    }
    const required = req.method === "GET" || req.method === "HEAD" ? readPerm : writePerm;
    if (!roleHasPermission(req.user.role_id, required)) {
      res.status(403).json({ message: `权限不足：缺少 ${required}` });
      return;
    }
    next();
  };
}

// ── Exam visibility ───────────────────────────────────────

/**
 * Returns the set of exam IDs visible to the current teacher.
 * - admin / grade_leader → null (all visible)
 * - head_teacher / subject_teacher → created exams + 任教学科匹配的班级
 *   + **担任班主任的班级全科可见**（按班标记 teacher_classes.is_head_teacher）
 * - plain teacher (no teacher_role) → 权限矩阵禁止的考试被剔除（#246：此前提前返回
 *   null 导致矩阵对该类教师完全失效）；无任何禁止行 → null（back-compat 全可见）
 *
 * 班主任自 v54 起是「按班关系」而非全局角色：全局 head_teacher 不再直接把
 * teacher_classes 关联的所有班级放大成全科可见（否则旧角色教师既无法在配置面板被识别，
 * 也无法在换人时被收回权限，见评审 P1）。
 *
 * #178 双模式：quiz（晨测）考试对教师全量可见（放开精细权限），
 * formal（大考）继续按 teacher_role + teacher_permissions 精细过滤。
 */
export async function getVisibleExamIds(user: express.Request["user"]): Promise<number[] | null> {
  if (!user || user.role_name === "admin") return null;
  if (user.role_name !== "teacher") return null;

  if (user.teacher_role === "grade_leader") return null;

  const db = getMysqlDb();

  async function withQuizExamIds(ids: number[]): Promise<number[]> {
    // 晨测模式 = 全量权限：无论 teacher_role / teacher_permissions 如何限制，quiz 考试都可见
    const quizRows = await db.all<{ id: number }>(
      `SELECT id FROM exams e WHERE e.exam_mode = 'quiz' AND ${EXAM_NOT_SOFT_DELETED_SQL}`
    );
    const merged = new Set(ids);
    for (const row of quizRows) merged.add(row.id);
    return Array.from(merged);
  }

  // 班主任与学科教师共用同一套「按班 + 按学科」判定：班主任身份体现在 teacher_classes.is_head_teacher 上。
  // 兼容遗留数据：旧模型用「全局 head_teacher 角色 + 一条不带科目的班级关联」表达班主任。
  // 迁移 55 会为存量班级补一位标记，但**同班可能有多条这样的遗留关联**，因此读时也要接受它们——
  // 条件是「该班尚无按班标记」：一旦某班经新版界面/替换流程指定了班主任，该班的遗留关联就不再算班主任。
  // 这条「NOT EXISTS 按班标记」是权限与配置/替换流程一致的关键：替换流程只清 is_head_teacher=1 的行，
  // 若读时无条件认可遗留关联，被换下的旧班主任会凭 is_head_teacher=0 + subject=NULL 继续全科可见（评审 P1）。
  // 只认「不带科目」的关联：带科目的关联说明是任课关系，即便角色是 head_teacher 也不据此放大到全科。
  if (user.teacher_role === "head_teacher" || user.teacher_role === "subject_teacher") {
    const headWhere = user.teacher_role === "head_teacher"
      ? `(tc.is_head_teacher = 1 OR (tc.subject IS NULL AND NOT EXISTS (
           SELECT 1 FROM teacher_classes h
            WHERE h.class_id = tc.class_id AND h.is_head_teacher = 1)))`
      : "tc.is_head_teacher = 1";
    // 按班班主任：其担任班主任的班级看全科，其余班级仍按学科过滤
    const headClassIds = (await db.all<{ class_id: number }>(
      `SELECT tc.class_id FROM teacher_classes tc WHERE tc.teacher_id = ? AND ${headWhere}`,
      user.id
    )).map((r) => r.class_id);
    // 学科教师未配置学科时，至少仍应看到晨测（quiz=全量权限）与担任班主任的班级
    if (!user.subject && headClassIds.length === 0) return await withQuizExamIds([]);
    const classRows = user.subject
      ? await db.all<{ class_id: number }>(
          // 全局 head_teacher：不带科目的关联是「旧班主任标记」而不是任课关系（班级配置页也
          // 只把带科目的行列为任课），因此这里不接受 `subject IS NULL` 的宽松匹配——否则被换下
          // 的旧班主任仍会看到本人学科在本班的考试，与配置/替换流程不一致（评审 P1）。
          user.teacher_role === "head_teacher"
            ? "SELECT class_id FROM teacher_classes WHERE teacher_id = ? AND subject = ?"
            : "SELECT class_id FROM teacher_classes WHERE teacher_id = ? AND (subject = ? OR subject IS NULL)",
          user.id,
          user.subject
        )
      : [];
    const classIds = classRows.map((r) => r.class_id);
    const parts: string[] = ["e.created_by = ?"];
    const params: unknown[] = [user.id];
    if (classIds.length > 0) {
      parts.push(`(e.subject = ? AND e.class_id IN (${classIds.map(() => "?").join(",")}))`);
      params.push(user.subject, ...classIds);
    }
    if (headClassIds.length > 0) {
      parts.push(`e.class_id IN (${headClassIds.map(() => "?").join(",")})`);
      params.push(...headClassIds);
    }
    const rows = await db.all<{ id: number }>(
      `SELECT DISTINCT e.id FROM exams e WHERE (${parts.join(" OR ")}) AND ${EXAM_NOT_SOFT_DELETED_SQL}`,
      ...params
    );
    // #246：学科教师同样受权限矩阵查看标志约束（此前提前返回导致矩阵失效）
    return await withQuizExamIds(await filterExamsByViewRestrictions(db, user.id, rows.map((r) => r.id)));
  }

  // 普通教师（无 teacher_role，不属任何精细分支）：同样消费权限矩阵的查看禁止行。
  // #246：此前该类教师在函数入口即提前返回 null（全可见），矩阵对其完全失效。
  if (await hasTable(db, "teacher_permissions")) {
    const restrictions = await db.all<unknown>(
      "SELECT 1 FROM teacher_permissions WHERE teacher_id = ? AND can_view_scores = 0 AND block_id IS NULL LIMIT 1",
      user.id
    );
    if (restrictions.length > 0) {
      // 存在禁止行 → 可见集合 = 全部考试 − 矩阵禁止的考试（含 subject/class 维度匹配）
      const allRows = await db.all<{ id: number }>(
        `SELECT id FROM exams e WHERE ${EXAM_NOT_SOFT_DELETED_SQL}`
      );
      const allowed = await filterExamsByViewRestrictions(db, user.id, allRows.map((r) => r.id));
      return await withQuizExamIds(allowed);
    }
  }

  return null;
}

async function hasTable(db: DbAdapter, table: string): Promise<boolean> {
  try {
    return !!(await db.get(`SELECT 1 FROM ${table} LIMIT 1`));
  } catch {
    return false;
  }
}

// ── auto_delete 软删除可见性（#246）───────────────────────

/** 软删除考试（exam_archives.is_deleted=1）过滤片段：别名须为 e。 */
export const EXAM_NOT_SOFT_DELETED_SQL =
  "NOT EXISTS (SELECT 1 FROM exam_archives ea WHERE ea.exam_id = e.id AND ea.is_deleted = 1)";

/** 同上，用于 exam_group_members 别名 egm 的查询（大考组成员统计，可无 exams 表 JOIN）。 */
export const GROUP_MEMBER_NOT_SOFT_DELETED_SQL =
  "NOT EXISTS (SELECT 1 FROM exam_archives ea WHERE ea.exam_id = egm.exam_id AND ea.is_deleted = 1)";

export async function isExamSoftDeleted(examId: number): Promise<boolean> {
  try {
    const row = await getMysqlDb().get(
      "SELECT 1 FROM exam_archives WHERE exam_id = ? AND is_deleted = 1 LIMIT 1",
      examId
    );
    return !!row;
  } catch {
    return false;
  }
}

// ── 权限矩阵查看标志运行时消费（#246）─────────────────────

export type ViewPermissionFlag = "can_view_scores" | "can_view_charts" | "can_view_students";

const VIEW_FLAG_LABELS: Record<ViewPermissionFlag, string> = {
  can_view_scores: "成绩",
  can_view_charts: "图表",
  can_view_students: "学生名单"
};

/**
 * #246 权限矩阵查看标志校验：判断教师在某考试上是否拥有指定查看权限。
 * - admin / grade_leader 特权放行；
 * - 矩阵表不存在或该教师无任何记录 → 兼容放行；
 * - 仅消费维度级行（block_id IS NULL）；维度匹配规则与 isTeacherPermittedForExam 一致：
 *   存在任一匹配维度且 flag=1 的行即允许。
 */
export async function hasViewPermission(
  user: express.Request["user"],
  examId: number,
  flag: ViewPermissionFlag
): Promise<boolean> {
  if (!user) return false;
  if (user.role_name === "admin") return true;
  if (user.role_name === "teacher" && user.teacher_role === "grade_leader") return true;
  const teacherId = (user as { id?: number }).id;
  if (!teacherId) return false;
  const db = getMysqlDb();
  if (!(await hasTable(db, "teacher_permissions"))) return true;
  const rows = await db.all<{
    grade_id: number | null;
    subject: string | null;
    class_id: number | null;
    flag: number;
  }>(
    `SELECT grade_id, subject, class_id, ${flag} AS flag FROM teacher_permissions
     WHERE teacher_id = ? AND block_id IS NULL`,
    teacherId
  );
  if (rows.length === 0) return true; // 未配置矩阵 → 兼容放行
  const exam = await db.get<{ grade_id: number | null; subject: string | null; class_id: number | null }>(
    "SELECT grade_id, subject, class_id FROM exams WHERE id = ?",
    examId
  );
  if (!exam) return false;
  return rows.some((r) =>
    r.flag === 1 &&
    (r.grade_id == null || r.grade_id === exam.grade_id) &&
    (r.subject == null || r.subject === exam.subject) &&
    (r.class_id == null || r.class_id === exam.class_id)
  );
}

/**
 * 查看权限门工厂（#246）：叠加在 requireExamAccess 之后，按矩阵查看标志二次过滤。
 * 用法：router.get("/exams/:examId/overview", requireExamAccess, makeViewPermissionGate("can_view_charts"), handler)
 */
export function makeViewPermissionGate(flag: ViewPermissionFlag) {
  const label = VIEW_FLAG_LABELS[flag];
  return async (req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> => {
    if (!req.user) {
      if (authEnforced) {
        res.status(401).json({ message: "未提供认证令牌" });
        return;
      }
      next();
      return;
    }
    const examId = Number(req.params.examId);
    if (!examId) {
      next();
      return;
    }
    if (await hasViewPermission(req.user, examId, flag)) {
      next();
      return;
    }
    res.status(403).json({ message: `权限不足：管理员已关闭你对本场考试「${label}」的查看权限` });
  };
}

/**
 * #246 权限矩阵查看标志校验（班级级 · 安全 R21）：花名册没有对应考试，
 * 因此 `grade_id` 维度从 `classes` 表解析；`subject` 维度以调用者自身任教学科比对
 * （班级表无学科列，花名册本身也不是按学科切分的数据）。
 * 矩阵表不存在或教师无任何记录 → 兼容放行。
 */
export async function hasClassViewPermission(
  user: express.Request["user"],
  classId: number,
  flag: ViewPermissionFlag
): Promise<boolean> {
  if (!user) return false;
  if (user.role_name === "admin") return true;
  if (user.role_name === "teacher" && user.teacher_role === "grade_leader") return true;
  if (user.role_name !== "teacher") return false;
  const teacherId = (user as { id?: number }).id;
  if (!teacherId) return false;
  const db = getMysqlDb();
  if (!(await hasTable(db, "teacher_permissions"))) return true;
  const rows = await db.all<{
    grade_id: number | null;
    subject: string | null;
    class_id: number | null;
    flag: number;
  }>(
    `SELECT grade_id, subject, class_id, ${flag} AS flag FROM teacher_permissions
     WHERE teacher_id = ? AND block_id IS NULL`,
    teacherId
  );
  if (rows.length === 0) return true; // 未配置矩阵 → 兼容放行
  const cls = await db.get<{ grade_id: number | null }>("SELECT grade_id FROM classes WHERE id = ?", classId);
  if (!cls) return false;
  const callerSubject = (user as { subject?: string | null }).subject ?? null;
  return rows.some((r) =>
    r.flag === 1 &&
    (r.grade_id == null || r.grade_id === cls.grade_id) &&
    (r.subject == null || callerSubject == null || r.subject === callerSubject) &&
    (r.class_id == null || r.class_id === classId)
  );
}

/**
 * #246 权限矩阵查看标志校验（大考组级）：组内全部非软删除成员考试的维度
 * 都被某条 flag=1 的授权行覆盖时才允许（与 canReadGroup 的「全部成员可见」
 * 模型一致）；矩阵表不存在或教师无任何记录 → 兼容放行；组内无有效成员 → 放行
 * （读取端此时返回空统计，无需查看门二次拦截）。
 */
export async function hasGroupViewPermission(
  user: express.Request["user"],
  groupId: number,
  flag: ViewPermissionFlag
): Promise<boolean> {
  if (!user) return false;
  if (user.role_name === "admin") return true;
  if (user.role_name === "teacher" && user.teacher_role === "grade_leader") return true;
  const teacherId = (user as { id?: number }).id;
  if (!teacherId) return false;
  const db = getMysqlDb();
  if (!(await hasTable(db, "teacher_permissions"))) return true;
  const rows = await db.all<{
    grade_id: number | null;
    subject: string | null;
    class_id: number | null;
    flag: number;
  }>(
    `SELECT grade_id, subject, class_id, ${flag} AS flag FROM teacher_permissions
     WHERE teacher_id = ? AND block_id IS NULL`,
    teacherId
  );
  if (rows.length === 0) return true; // 未配置矩阵 → 兼容放行
  const exams = await db.all<{ grade_id: number | null; subject: string | null; class_id: number | null }>(
    `SELECT e.grade_id, e.subject, e.class_id FROM exam_group_members egm
     JOIN exams e ON e.id = egm.exam_id
     WHERE egm.group_id = ? AND ${GROUP_MEMBER_NOT_SOFT_DELETED_SQL}`,
    groupId
  );
  if (exams.length === 0) return true;
  const granted = (exam: { grade_id: number | null; subject: string | null; class_id: number | null }): boolean =>
    rows.some((r) =>
      r.flag === 1 &&
      (r.grade_id == null || r.grade_id === exam.grade_id) &&
      (r.subject == null || r.subject === exam.subject) &&
      (r.class_id == null || r.class_id === exam.class_id)
    );
  return exams.every(granted);
}

/**
 * 大考组查看权限门（#246）：叠加在 requireReadableGroup 之后，
 * 按矩阵查看标志对组级分析/名单端点二次过滤。
 * 用法：router.get("/overview", requireReadableGroup, makeGroupViewPermissionGate("can_view_charts"), handler)
 */
export function makeGroupViewPermissionGate(flag: ViewPermissionFlag) {
  const label = VIEW_FLAG_LABELS[flag];
  return async (req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> => {
    if (!req.user) {
      if (authEnforced) {
        res.status(401).json({ message: "未提供认证令牌" });
        return;
      }
      next();
      return;
    }
    const groupId = Number(req.params.groupId);
    if (!groupId) {
      next();
      return;
    }
    if (await hasGroupViewPermission(req.user, groupId, flag)) {
      next();
      return;
    }
    res.status(403).json({ message: `权限不足：管理员已关闭你对本大考「${label}」的查看权限` });
  };
}

/**
 * #246 跨考试查看权限批量过滤：返回 examIds 中教师按矩阵拥有指定查看标志的子集。
 * 语义与单考试门 hasViewPermission 一致（allow-based）：admin / grade_leader /
 * 未配置矩阵 → 全部保留；否则仅保留存在 flag=1 且维度匹配授权行的考试。
 * 批量实现（授权行 + 考试维度各查一次），供 /trends、/students/:id/trend、
 * /subject-quality 等跨考试端点在取数后收敛结果集。
 */
export async function filterExamIdsByViewPermission(
  user: express.Request["user"],
  examIds: number[],
  flag: ViewPermissionFlag
): Promise<Set<number>> {
  const unique = [...new Set(examIds.filter((id) => Number.isInteger(id) && id > 0))];
  const all = new Set(unique);
  if (!user) return all; // 未开启强制鉴权时与查看门一致放行
  if (user.role_name === "admin") return all;
  if (user.role_name === "teacher" && user.teacher_role === "grade_leader") return all;
  const teacherId = (user as { id?: number }).id;
  if (!teacherId) return new Set();
  if (unique.length === 0) return all;
  const db = getMysqlDb();
  if (!(await hasTable(db, "teacher_permissions"))) return all;
  const rows = await db.all<{
    grade_id: number | null;
    subject: string | null;
    class_id: number | null;
    flag: number;
  }>(
    `SELECT grade_id, subject, class_id, ${flag} AS flag FROM teacher_permissions
     WHERE teacher_id = ? AND block_id IS NULL`,
    teacherId
  );
  if (rows.length === 0) return all;
  const placeholders = unique.map(() => "?").join(",");
  const exams = await db.all<{ id: number; grade_id: number | null; subject: string | null; class_id: number | null }>(
    `SELECT id, grade_id, subject, class_id FROM exams WHERE id IN (${placeholders})`,
    ...unique
  );
  const allowed = new Map<number, boolean>();
  for (const e of exams) {
    allowed.set(
      Number(e.id),
      rows.some((r) =>
        r.flag === 1 &&
        (r.grade_id == null || r.grade_id === e.grade_id) &&
        (r.subject == null || r.subject === e.subject) &&
        (r.class_id == null || r.class_id === e.class_id)
      )
    );
  }
  return new Set(unique.filter((id) => allowed.get(id) === true));
}

/**
 * #246：按权限矩阵查看标志过滤考试 ID 集合。
 * 仅消费维度级禁止行（block_id IS NULL 且 flag=0），题块级行不影响整卷可见性；
 * 维度全空（NULL）的禁止行 = 全部禁止。矩阵表不存在或无禁止行时原样返回。
 */
async function filterExamsByViewRestrictions(
  db: DbAdapter,
  teacherId: number,
  examIds: number[],
  flag: ViewPermissionFlag = "can_view_scores"
): Promise<number[]> {
  if (examIds.length === 0) return examIds;
  if (!(await hasTable(db, "teacher_permissions"))) return examIds;
  const deniedRows = await db.all<{ grade_id: number | null; subject: string | null; class_id: number | null }>(
    `SELECT DISTINCT grade_id, subject, class_id FROM teacher_permissions
     WHERE teacher_id = ? AND ${flag} = 0 AND block_id IS NULL`,
    teacherId
  );
  if (deniedRows.length === 0) return examIds;
  const placeholders = examIds.map(() => "?").join(",");
  const exams = await db.all<{ id: number; grade_id: number | null; subject: string | null; class_id: number | null }>(
    `SELECT id, grade_id, subject, class_id FROM exams WHERE id IN (${placeholders})`,
    ...examIds
  );
  const isDenied = (e: { grade_id: number | null; subject: string | null; class_id: number | null }): boolean =>
    deniedRows.some((d) =>
      (d.grade_id == null || d.grade_id === e.grade_id) &&
      (d.subject == null || d.subject === e.subject) &&
      (d.class_id == null || d.class_id === e.class_id)
    );
  return exams.filter((e) => !isDenied(e)).map((e) => e.id);
}

/**
 * Middleware: asserts the current user can access `req.params.examId`.
 * Skips when no user is set (makeGate already handles the auth-enforce case).
 */
export async function requireExamAccess(req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> {
  if (!req.user) {
    // P0-5 (C-S3): 鉴权开启时无用户返回 401；关闭时保持向后兼容放行
    if (authEnforced) {
      res.status(401).json({ message: "未提供认证令牌" });
      return;
    }
    next();
    return;
  }
  const examId = Number(req.params.examId);
  if (!examId) {
    res.status(400).json({ message: "缺少 examId" });
    return;
  }

  // #246 auto_delete 落实：被保留策略软删除的考试对非管理员完全不可见（管理员可进入恢复）
  if (req.user.role_name !== "admin" && (await isExamSoftDeleted(examId))) {
    res.status(404).json({ message: "考试不存在或已按数据保留策略清理" });
    return;
  }

  if (req.user.role_name === "student") {
    // 学生仅允许读取自己参加了的考试（GET）或提交本场 AI 分析（POST）；
    // 写操作（改分/编辑/代查他人）一律拒绝
    if (req.method !== "GET" && !(req.method === "POST" && req.originalUrl.includes("/ai-analysis"))) {
      res.status(403).json({ message: "权限不足" });
      return;
    }
    const scoreRepo = new ScoreRepository();
    if (await scoreRepo.hasScore(req.user.id, examId)) {
      next();
      return;
    }
    res.status(403).json({ message: "权限不足：你未参加该考试" });
    return;
  }

  const visibleIds = await getVisibleExamIds(req.user);
  if (visibleIds === null) {
    next();
    return;
  }
  if (visibleIds.includes(examId)) {
    next();
    return;
  }
  res.status(403).json({ message: "权限不足：无权访问此考试" });
}

export async function validateExamIdsAccess(req: express.Request, res: express.Response, examIds: number[]): Promise<boolean> {
  const visibleIds = await getVisibleExamIds(req.user);
  if (visibleIds === null) return true;
  const visible = new Set(visibleIds);
  const denied = examIds.filter((examId) => !visible.has(examId));
  if (denied.length === 0) return true;
  res.status(403).json({ message: "权限不足：考试组包含不可访问的考试" });
  return false;
}

// ── 权限位门（兼容免鉴权模式） ────────────────────────────

/**
 * 与 `makeGate` 同口径的权限位门（安全 R09）：`requirePermission` 在无用户时一律 401，
 * 会把「未开启强制鉴权」的旧部署直接挡在门外；这里无用户时按 `authEnforced` 决定放行或 401，
 * 有用户时按角色权限表判定。
 */
export function requirePermissionCompat(permission: string) {
  return (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    if (!req.user) {
      if (authEnforced) {
        res.status(401).json({ message: "未提供认证令牌" });
        return;
      }
      next();
      return;
    }
    if (!roleHasPermission(req.user.role_id, permission)) {
      res.status(403).json({ message: `权限不足：缺少 ${permission}` });
      return;
    }
    next();
  };
}

/**
 * 教师与某场考试是否有组织归属关系（安全 R09 的晨测旁路收口）。
 *
 * `getVisibleExamIds` 对 `exam_mode='quiz'` 的晨测做**全量可见**放大（#178 双模式设计），
 * 于是「可见」被 `requireExamAccess` 当成「可写」：任意教师都能改任何一场晨测的整卷成绩与答案。
 * 写侧不再继承这个放大——要么管理员/学年主任，要么本人创建，要么确实任教/担任该班班主任，
 * 年级级联考（无班级）则要求教师在该年级有对应学科的任课关系。
 */
export async function hasExamOrganizationAffinity(
  user: express.Request["user"],
  examId: number
): Promise<boolean> {
  if (!user) return false;
  if (isPrivilegedGrader(user)) return true;
  const teacherId = (user as { id?: number }).id;
  if (!teacherId) return false;
  const db = getMysqlDb();
  const exam = await db.get<{ created_by: number | null; class_id: number | null; grade_id: number | null; subject: string | null }>(
    "SELECT created_by, class_id, grade_id, subject FROM exams WHERE id = ?",
    examId
  );
  if (!exam) return false;
  if (exam.created_by != null && Number(exam.created_by) === Number(teacherId)) return true;
  if (exam.class_id != null) {
    const link = await db.get(
      `SELECT 1 FROM teacher_classes
       WHERE teacher_id = ? AND class_id = ?
         AND (is_head_teacher = 1 OR subject IS NULL OR subject = ?)
       LIMIT 1`,
      teacherId, exam.class_id, exam.subject
    );
    return !!link;
  }
  if (exam.grade_id != null) {
    const link = await db.get(
      `SELECT 1 FROM teacher_classes tc
       JOIN classes c ON c.id = tc.class_id
       WHERE tc.teacher_id = ? AND c.grade_id = ?
         AND (tc.is_head_teacher = 1 OR tc.subject IS NULL OR tc.subject = ?)
       LIMIT 1`,
      teacherId, exam.grade_id, exam.subject
    );
    return !!link;
  }
  return false;
}

/**
 * 教师能否把考试**落到**某个年级/班级/学科（安全 R18）。
 *
 * `getVisibleExamIds` 的可见集合包含 `e.created_by = 本人`，因此「能创建/改范围」就等于
 * 「能拿到那个组织的名单与成绩」：教师只要把考试指到任意 grade_id / class_id，
 * 那一场考试的年级/班级数据就随创建者身份变成其可见范围。这里把目标组织收敛到
 * 调用者真正任教的范围；`null` 表示沿用考试当前值。
 *
 * 兼容口径与 `getAccessibleClassIds` 一致：管理员/学年主任不限；
 * 未设置 `teacher_role` 的普通教师（旧部署单师自用）不限——否则存量部署将无法建考。
 */
export async function canManageExamOrganization(
  user: express.Request["user"],
  target: { gradeId?: number | null; classId?: number | null; subject?: string | null }
): Promise<boolean> {
  if (!user) return true; // 免鉴权模式：无身份可判，交由上层网关
  if (user.role_name === "admin") return true;
  if (user.role_name !== "teacher") return false;
  if (user.teacher_role === "grade_leader") return true;
  if (!user.teacher_role) return true; // 旧部署兼容：未配置精细角色的教师
  const teacherId = (user as { id?: number }).id;
  if (!teacherId) return false;
  const db = getMysqlDb();
  const classId = target.classId == null ? null : Number(target.classId);
  const gradeId = target.gradeId == null ? null : Number(target.gradeId);
  const subject = target.subject == null ? null : String(target.subject);
  if (classId != null) {
    const link = await db.get(
      `SELECT 1 FROM teacher_classes
       WHERE teacher_id = ? AND class_id = ?
         AND (is_head_teacher = 1 OR subject IS NULL OR subject = ?)
       LIMIT 1`,
      teacherId, classId, subject
    );
    return !!link;
  }
  if (gradeId != null) {
    // 年级级考试（联考）：教师需在该年级任教学科，或担任该年级内任一班的班主任
    const link = await db.get(
      `SELECT 1 FROM teacher_classes tc
       JOIN classes c ON c.id = tc.class_id
       WHERE tc.teacher_id = ? AND c.grade_id = ?
         AND (tc.is_head_teacher = 1 OR tc.subject IS NULL OR tc.subject = ?)
       LIMIT 1`,
      teacherId, gradeId, subject
    );
    return !!link;
  }
  return false; // 既无班级也无年级：无法判定归属，按拒绝处理（创建端另有 SCOPE_REQUIRED 校验）
}

/**
 * 判断某教师当前的整卷写授权是否来自「未配置任何权限矩阵」的兼容回退。
 * 是 → 调用方需要再验组织归属；否（特权阅卷人 / 已配置矩阵 / 已获整卷分配）→ 由
 * `isTeacherPermittedForWholeExam` 的显式判定负责，不再追加约束。
 */
async function reliesOnLegacyGradingFallback(
  user: express.Request["user"],
  examId: number
): Promise<boolean> {
  if (!user || isPrivilegedGrader(user)) return false;
  const teacherId = (user as { id?: number }).id;
  if (!teacherId) return false;
  const db = getMysqlDb();
  if (!(await hasTable(db, "teacher_permissions"))) return true;
  const anyPermRow = await db.get("SELECT 1 FROM teacher_permissions WHERE teacher_id = ? LIMIT 1", teacherId);
  if (anyPermRow) return false;
  const wholeAssignment = await db.get(
    "SELECT 1 FROM review_assignments WHERE exam_id = ? AND teacher_id = ? AND block_id IS NULL LIMIT 1",
    examId, teacherId
  );
  return !wholeAssignment;
}

/**
 * 整卷写权限门（安全 R09）：改分、改答案、重算这类一次性改写整卷数据的入口，
 * 不再继承「可见即可写」。判定顺序：
 * 1. 只有管理员/教师可写（学生与其它角色直接拒绝，避免 `isTeacherPermittedForWholeExam`
 *    在无矩阵时被兼容回退放行）；
 * 2. 权限矩阵/题块分配决定整卷写授权（`isTeacherPermittedForWholeExam`，仅接受 block_id 为空的授权）；
 * 3. 授权若来自「完全没配矩阵」的兼容回退，再要求组织归属，堵住晨测全量可见带来的任意教师改写。
 */
export async function requireWholeExamGradingAccess(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): Promise<void> {
  if (!req.user) {
    if (authEnforced) {
      res.status(401).json({ message: "未提供认证令牌" });
      return;
    }
    next();
    return;
  }
  const roleName = req.user.role_name;
  if (roleName === "student") {
    // 学生维持 requireExamAccess 的既有语义（仅 GET / 提交本场 AI 分析），
    // 整卷写操作一律拒绝——不再依赖「学生没有权限矩阵行」这种巧合放行。
    const isAiAnalysisPost = req.method === "POST" && String(req.originalUrl ?? "").includes("/ai-analysis");
    if (req.method === "GET" || isAiAnalysisPost) {
      next();
      return;
    }
    res.status(403).json({ message: "权限不足" });
    return;
  }
  if (roleName !== "teacher" && roleName !== "admin") {
    res.status(403).json({ message: "权限不足：整卷成绩与答案仅限教师或管理员修改" });
    return;
  }
  const examId = Number(req.params.examId);
  if (!Number.isFinite(examId) || examId <= 0) {
    res.status(400).json({ message: "缺少 examId" });
    return;
  }
  // 考试创建者对本场考试保留整卷写权限：`isTeacherPermittedForWholeExam` 一旦看到
  // 该考试配了题块分配，就只承认「不限题块」的显式授权，创建者若只被分到某个题块
  // 将无法再修正任何成绩（verify-security-critical 的改分撤回基线即此形态）。
  // 创建关系由 `exams.created_by` 直接判定，不经可见性放大，因此不会重开 R09 的口子。
  const examRow = await getMysqlDb().get<{ created_by: number | null }>(
    "SELECT created_by FROM exams WHERE id = ?",
    examId
  );
  if (examRow?.created_by != null && Number(examRow.created_by) === Number((req.user as { id?: number }).id)) {
    next();
    return;
  }
  if (!(await isTeacherPermittedForWholeExam(req.user, examId, "can_grade"))) {
    res.status(403).json({ message: "权限不足：改分/改答案需要本场考试的整卷阅卷授权（单题块授权请走题块网阅）" });
    return;
  }
  if ((await reliesOnLegacyGradingFallback(req.user, examId)) && !(await hasExamOrganizationAffinity(req.user, examId))) {
    res.status(403).json({ message: "权限不足：你与这场考试没有组织归属关系（未创建、未任教、也非该班班主任），不能修改整卷成绩或答案" });
    return;
  }
  next();
}

/**
 * 整卷**读取**授权判定（安全 R08）：仅有题块级阅卷/权限配置的教师不应读到全卷成绩详情、
 * 总分与班级均分。返回其受限于的题块集合，null 表示不受题块限制。
 *
 * PR #312 CR11：`getPermittedBlocks` 的空集意味着「这场**没有任何阅卷授权**」，
 * 而 R08 要拦的是「有阅卷授权、但只到题块粒度」的账号。把两者混为一谈，
 * 只读教师（can_view_scores=1 / can_view_students=1 / can_grade=0、无阅卷分配）
 * 就会因为「没有写权限」被判定成「没有读权限」而 403——读与写是两条独立的授权：
 * 整卷读取由前面的 `requireExamAccess` + 两个查看门决定（查看门要求 block_id IS NULL
 * 的整卷权限行），这道门只在「确实被限制在若干题块上」时才生效。
 */
export async function isBlockedToOwnGradingBlocks(
  user: express.Request["user"],
  examId: number
): Promise<string[] | null> {
  if (!user || user.role_name !== "teacher") return null;
  if (isPrivilegedGrader(user)) return null;
  const blocks = await getPermittedBlocks(user, examId);
  if (blocks !== null && blocks.length === 0) return null;
  return blocks;
}

// ── Grading scope (题块级正向授权 · 防 IDOR) ──────────────

/**
 * 特权阅卷人：管理员(role_id=1) 或 学年主任(grade_leader)。
 * 与 submit/release 既有规则一致，可代交 / 强制处理任意题块。
 */
export function isPrivilegedGrader(user: express.Request["user"]): boolean {
  if (!user) return false;
  const u = user as { role_id?: number; role_name?: string; teacher_role?: string | null };
  return u.role_id === 1 || (u.role_name === "teacher" && u.teacher_role === "grade_leader");
}

/**
 * 题块级正向授权：校验教师是否被分配到 (examId, blockId)。
 * - 特权阅卷人直接放行。
 * - 被显式分配或被细粒度权限授予的教师放行。
 * - 该题块不存在任何分配记录、且该教师完全未配置权限矩阵时放行
 *   （向后兼容：仅限旧部署，避免未分配题块锁死所有人）。
 * - 已配置矩阵的教师必须命中匹配授权，否则一律拒绝（#246：防止
 *   can_grade=0 / 年级学科不匹配的教师借「无分配记录」回退越权）。
 * 返回 true=允许。
 */
export async function canGradeBlock(
  user: express.Request["user"],
  examId: number,
  blockId: string
): Promise<boolean> {
  if (!user) return false;
  if (isPrivilegedGrader(user)) return true;
  const teacherId = (user as { id?: number }).id;
  if (!teacherId) return false;
  const db = getMysqlDb();
  const assigned = await db.get(
    "SELECT 1 FROM review_assignments WHERE exam_id = ? AND block_id = ? AND teacher_id = ? LIMIT 1",
    examId, blockId, teacherId
  );
  if (assigned) return true;
  // v37: 细粒度权限授予 —— 作为追加放行路径（绝不引入新拒绝，确保既有部署零回归）。
  // 匹配规则：can_grade=1 且 (grade_id 为空或匹配考试年级) 且 (block_id 为空或匹配)
  // 且 (subject 为空或匹配考试学科) 且 (class_id 为空或匹配考试班级)。
  if (await hasTable(db, "teacher_permissions")) {
    const granted = await db.get(
      `SELECT 1 FROM teacher_permissions
       WHERE teacher_id = ? AND can_grade = 1
         AND (grade_id IS NULL OR grade_id = (SELECT grade_id FROM exams WHERE id = ?))
         AND (block_id IS NULL OR block_id = ?)
         AND (subject IS NULL OR subject = (SELECT subject FROM exams WHERE id = ?))
         AND (class_id IS NULL OR class_id = (SELECT class_id FROM exams WHERE id = ?))
       LIMIT 1`,
      teacherId, examId, blockId, examId, examId
    );
    if (granted) return true;
  }
  // 若该 (exam, block) 没有任何分配记录，且该教师完全未配置权限矩阵 → 放行
  // （向后兼容旧部署）。已配置矩阵的教师不享受此回退（#246 正向授权不被绕过）。
  const anyAssignment = await db.get(
    "SELECT 1 FROM review_assignments WHERE exam_id = ? AND block_id = ? LIMIT 1",
    examId, blockId
  );
  if (anyAssignment) return false;
  if (!(await hasTable(db, "teacher_permissions"))) return true;
  const anyPermRow = await db.get(
    "SELECT 1 FROM teacher_permissions WHERE teacher_id = ? LIMIT 1",
    teacherId
  );
  return !anyPermRow;
}

/**
 * 返回教师在某考试中可阅卷的题块集合；null 表示不受限（全部可阅）。
 * 综合：显式 review_assignments + 细粒度 teacher_permissions 授予。
 * 向后兼容：若该考试既无分配记录也无任何权限授予，返回 null（全部可阅）。
 * 供工作量分配（#24）与权限配置面板（#25）消费。
 */
export async function getPermittedBlocks(
  user: express.Request["user"],
  examId: number
): Promise<string[] | null> {
  if (!user) return null;
  if (isPrivilegedGrader(user)) return null; // 特权阅卷人：全部
  const teacherId = (user as { id?: number }).id;
  if (!teacherId) return null;
  const db = getMysqlDb();

  // 1) 显式分配
  const assignedRows = await db.all<{ block_id: string }>(
    "SELECT DISTINCT block_id FROM review_assignments WHERE exam_id = ? AND teacher_id = ?",
    examId, teacherId
  );
  const blocks = new Set(assignedRows.map((r) => r.block_id));

  // 2) 细粒度权限授予（block_id 非空的行给出具体题块；NULL 表示该维度不限 → 全部）
  // 维度匹配含 grade_id：grade 为空（不限）或等于考试年级，防止跨年级越权。
  let grantsAll = false;
  if (await hasTable(db, "teacher_permissions")) {
    const permRows = await db.all<{ block_id: string | null }>(
      `SELECT DISTINCT block_id FROM teacher_permissions
       WHERE teacher_id = ? AND can_grade = 1
         AND (grade_id IS NULL OR grade_id = (SELECT grade_id FROM exams WHERE id = ?))
         AND (subject IS NULL OR subject = (SELECT subject FROM exams WHERE id = ?))
         AND (class_id IS NULL OR class_id = (SELECT class_id FROM exams WHERE id = ?))`,
      teacherId, examId, examId, examId
    );
    for (const r of permRows) {
      if (r.block_id == null) grantsAll = true;
      else blocks.add(r.block_id);
    }
  }
  if (grantsAll) return null;

  // 3) 若该考试无任何分配且无任何权限授予 → 向后兼容视为全部可阅
  if (blocks.size === 0) {
    const anyAssignment = await db.get(
      "SELECT 1 FROM review_assignments WHERE exam_id = ? LIMIT 1",
      examId
    );
    // #246：兼容判断不看维度匹配——只要教师已配置权限矩阵（含不匹配/can_grade=0 的行），
    // 就不再享受「无授权 → 全部可阅」回退，防止借不匹配配置越权。
    const anyPermRow = await db.get(
      "SELECT 1 FROM teacher_permissions WHERE teacher_id = ? LIMIT 1",
      teacherId
    );
    if (!anyAssignment && !anyPermRow) return null;
  }
  return Array.from(blocks);
}

/**
 * 教师权限矩阵校验（#24 分配绑定）。
 * 判断某教师在授权矩阵内是否被允许对该考试执行 can_grade / can_assign 操作。
 * 兼容策略：teacher_permissions 表不存在，或该教师无任何矩阵记录 → 放行（旧部署）。
 * 维度匹配：grade_id 为空或等于考试年级；subject 为空或等于考试学科；class_id 为空或等于考试班级。
 */
export async function isTeacherPermittedForExam(
  examId: number,
  teacherId: number,
  perm: "can_grade" | "can_assign"
): Promise<boolean> {
  const db = getMysqlDb();
  if (!(await hasTable(db, "teacher_permissions"))) return true;
  const exam = await db.get<{ grade_id: number | null; subject: string | null; class_id: number | null }>(
    "SELECT grade_id, subject, class_id FROM exams WHERE id = ?",
    examId
  );
  if (!exam) return false;
  const rows = await db.all<{
    grade_id: number | null;
    subject: string | null;
    class_id: number | null;
    can_grade: number;
    can_assign: number;
  }>(
    "SELECT grade_id, subject, class_id, can_grade, can_assign FROM teacher_permissions WHERE teacher_id = ?",
    teacherId
  );
  if (rows.length === 0) return true; // 未配置矩阵 → 兼容放行
  const flag = perm === "can_grade" ? "can_grade" : "can_assign";
  return rows.some((r) =>
    (r as Record<string, unknown>)[flag] === 1 &&
    (r.grade_id == null || r.grade_id === exam.grade_id) &&
    (r.subject == null || r.subject === exam.subject) &&
    (r.class_id == null || r.class_id === exam.class_id)
  );
}

/**
 * 整卷级授权校验（PR #280 第五轮评审 P1）。
 *
 * 与 isTeacherPermittedForExam 的区别：整卷上传会一次性写入本场考试的全部客观题
 * 与主观题成绩并撤回已公布状态，因此只接受「不限题块」的授权（block_id IS NULL）。
 * 仅有单个题块授权（block_id 非空）的教师改走题块级网阅接口，不得借整卷接口
 * 覆盖其它题块的成绩。
 *
 * 特权阅卷人（管理员 / 学年主任）先放行：修改用户角色不会清理历史 teacher_permissions
 * 行，遗留的 can_grade=0 记录不应把管理员与学年主任挡在门外（评审 P2）。
 * 兼容策略同 isTeacherPermittedForExam：表不存在或该教师无任何矩阵记录 → 放行；
 * 但本考试一旦配置题块分配，未获显式整卷授权的教师不得走兼容回退，
 * 包括只分配了部分题块和完全未获分配的教师。
 */
export async function isTeacherPermittedForWholeExam(
  user: express.Request["user"],
  examId: number,
  perm: "can_grade" | "can_assign" = "can_grade"
): Promise<boolean> {
  if (!user) return false;
  if (isPrivilegedGrader(user)) return true;
  const teacherId = (user as { id?: number }).id;
  if (!teacherId) return false;
  const db = getMysqlDb();
  const exam = await db.get<{ grade_id: number | null; subject: string | null; class_id: number | null }>(
    "SELECT grade_id, subject, class_id FROM exams WHERE id = ?",
    examId
  );
  if (!exam) return false;
  if (await hasTable(db, "teacher_permissions")) {
    const rows = await db.all<{
      grade_id: number | null;
      subject: string | null;
      class_id: number | null;
      block_id: string | null;
      can_grade: number;
      can_assign: number;
    }>(
      "SELECT grade_id, subject, class_id, block_id, can_grade, can_assign FROM teacher_permissions WHERE teacher_id = ?",
      teacherId
    );
    if (rows.length > 0) {
      const flag = perm === "can_grade" ? "can_grade" : "can_assign";
      return rows.some((r) =>
        (r as Record<string, unknown>)[flag] === 1 &&
        r.block_id == null &&
        (r.grade_id == null || r.grade_id === exam.grade_id) &&
        (r.subject == null || r.subject === exam.subject) &&
        (r.class_id == null || r.class_id === exam.class_id)
      );
    }
  }
  // 仅完全没有题块分配的旧考试允许兼容回退；不能只检查调用者本人的分配。
  const blockScoped = await db.get(
    "SELECT 1 FROM review_assignments WHERE exam_id = ? AND block_id IS NOT NULL LIMIT 1",
    examId
  );
  return !blockScoped;
}

/**
 * 中间件：题块级操作授权（防 IDOR）。
 * 读取 req.params.examId；blockId 优先取 req.params.blockId，
 * 否则由 req.params.cropId 反查 answer_block_crops.block_id。
 * 无法判定题块时放行（交由既有逻辑），避免误拦截。
 */
export async function requireGradingScope(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): Promise<void> {
  if (!req.user) {
    if (authEnforced) {
      res.status(401).json({ message: "未提供认证令牌" });
      return;
    }
    next();
    return;
  }
  try {
    const examId = Number(req.params.examId);
    if (!Number.isFinite(examId)) {
      res.status(400).json({ message: "缺少 examId" });
      return;
    }
    let blockId = typeof req.params.blockId === "string" ? req.params.blockId : "";
    if (!blockId && typeof req.params.cropId === "string") {
      const crop = await getMysqlDb().get(
        "SELECT block_id FROM answer_block_crops WHERE id = ? AND exam_id = ?",
        req.params.cropId, examId
      ) as { block_id?: string } | undefined;
      blockId = crop?.block_id ?? "";
    }
    if (!blockId) {
      next();
      return;
    }
    if (await canGradeBlock(req.user, examId, blockId)) {
      next();
      return;
    }
    res.status(403).json({ message: "权限不足：你未被分配批改该题块" });
  } catch (err) {
    next(err);
  }
}

export { PERMISSIONS };
