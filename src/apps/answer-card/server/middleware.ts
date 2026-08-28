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
    // 扫描端只读放权：携带有效 X-Api-Key (scope=scanner/full) 的 GET/HEAD 直接放行，不走 RBAC
    if ((req as any).isApiClient && (req.method === "GET" || req.method === "HEAD")) {
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
 * - head_teacher → own classes + created exams
 * - subject_teacher → own subject + classes + created exams
 * - plain teacher (no teacher_role) → 权限矩阵禁止的考试被剔除（#246：此前提前返回
 *   null 导致矩阵对该类教师完全失效）；无任何禁止行 → null（back-compat 全可见）
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

  if (user.teacher_role === "head_teacher") {
    const classRows = await db.all<{ class_id: number }>(
      "SELECT class_id FROM teacher_classes WHERE teacher_id = ?",
      user.id
    );
    const classIds = classRows.map((r) => r.class_id);
    if (classIds.length === 0) {
      const ownRows = await db.all<{ id: number }>(
        `SELECT DISTINCT id FROM exams e WHERE e.created_by = ? AND ${EXAM_NOT_SOFT_DELETED_SQL}`,
        user.id
      );
      return await withQuizExamIds(await filterExamsByViewRestrictions(db, user.id, ownRows.map((r) => r.id)));
    }
    const rows = await db.all<{ id: number }>(
      `SELECT DISTINCT e.id FROM exams e
       WHERE (e.created_by = ? OR e.class_id IN (${classIds.map(() => "?").join(",")})) AND ${EXAM_NOT_SOFT_DELETED_SQL}`,
      user.id,
      ...classIds
    );
    // #246：班主任同样受权限矩阵查看标志约束（此前提前返回导致矩阵失效）
    return await withQuizExamIds(await filterExamsByViewRestrictions(db, user.id, rows.map((r) => r.id)));
  }

  if (user.teacher_role === "subject_teacher") {
    // 学科教师未配置学科时，至少仍应看到晨测（quiz=全量权限）
    if (!user.subject) return await withQuizExamIds([]);
    const classRows = await db.all<{ class_id: number }>(
      "SELECT class_id FROM teacher_classes WHERE teacher_id = ? AND (subject = ? OR subject IS NULL)",
      user.id,
      user.subject
    );
    const classIds = classRows.map((r) => r.class_id);
    if (classIds.length === 0) {
      const ownRows = await db.all<{ id: number }>(
        `SELECT DISTINCT id FROM exams e WHERE e.created_by = ? AND ${EXAM_NOT_SOFT_DELETED_SQL}`,
        user.id
      );
      return await withQuizExamIds(await filterExamsByViewRestrictions(db, user.id, ownRows.map((r) => r.id)));
    }
    const rows = await db.all<{ id: number }>(
      `SELECT DISTINCT e.id FROM exams e
       WHERE (e.created_by = ? OR (e.subject = ? AND e.class_id IN (${classIds.map(() => "?").join(",")}))) AND ${EXAM_NOT_SOFT_DELETED_SQL}`,
      user.id,
      user.subject,
      ...classIds
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
