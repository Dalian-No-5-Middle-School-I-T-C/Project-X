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
 * - head_teacher → own classes + created exams
 * - subject_teacher → own subject + classes + created exams
 * - plain teacher (no teacher_role) → null (back-compat)
 *
 * #178 双模式：quiz（晨测）考试对教师全量可见（放开精细权限），
 * formal（大考）继续按 teacher_role + teacher_permissions 精细过滤。
 */
export async function getVisibleExamIds(user: express.Request["user"]): Promise<number[] | null> {
  if (!user || user.role_name === "admin") return null;
  if (user.role_name !== "teacher") return null;
  if (!user.teacher_role) return null; // plain teacher: all visible (back-compat)

  if (user.teacher_role === "grade_leader") return null;

  const db = getMysqlDb();

  async function withQuizExamIds(ids: number[]): Promise<number[]> {
    // 晨测模式 = 全量权限：无论 teacher_role / teacher_permissions 如何限制，quiz 考试都可见
    const quizRows = await db.all<{ id: number }>("SELECT id FROM exams WHERE exam_mode = 'quiz'");
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
      const ownRows = await db.all<{ id: number }>("SELECT DISTINCT id FROM exams WHERE created_by = ?", user.id);
      return await withQuizExamIds(ownRows.map((r) => r.id));
    }
    const rows = await db.all<{ id: number }>(
      `SELECT DISTINCT e.id FROM exams e
       WHERE e.created_by = ? OR e.class_id IN (${classIds.map(() => "?").join(",")})`,
      user.id,
      ...classIds
    );
    return await withQuizExamIds(rows.map((r) => r.id));
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
      const ownRows = await db.all<{ id: number }>("SELECT DISTINCT id FROM exams WHERE created_by = ?", user.id);
      return await withQuizExamIds(ownRows.map((r) => r.id));
    }
    const rows = await db.all<{ id: number }>(
      `SELECT DISTINCT e.id FROM exams e
       WHERE e.created_by = ? OR (e.subject = ? AND e.class_id IN (${classIds.map(() => "?").join(",")}))`,
      user.id,
      user.subject,
      ...classIds
    );
    return await withQuizExamIds(rows.map((r) => r.id));
  }

  // Check teacher_permissions for additional restrictions
  if (user.role_name === "teacher") {
    if (await hasTable(db, "teacher_permissions")) {
      const restrictions = await db.all<{ grade_id: number | null }>(
        "SELECT grade_id, can_view_scores FROM teacher_permissions WHERE teacher_id = ? AND can_view_scores = 0",
        user.id
      );
      // If any restriction forbids all grades (grade_id = null), deny everything
      if (restrictions.some((r) => r.grade_id === null)) return await withQuizExamIds([]);
      if (restrictions.length > 0) {
        const restrictedGrades = restrictions.map((r) => r.grade_id).filter(Boolean) as number[];
        const rows = await db.all<{ id: number }>(
          `SELECT DISTINCT e.id FROM exams e
           JOIN classes c ON c.id = e.class_id
           WHERE e.grade_id NOT IN (${restrictedGrades.map(() => "?").join(",")})`,
          ...restrictedGrades
        );
        return await withQuizExamIds(rows.map((r) => r.id));
      }
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
 * - 该题块不存在任何分配记录时放行（向后兼容：避免未分配题块锁死所有人）。
 * - 否则仅允许被分配到该题块的教师。
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
  // 若该 (exam, block) 没有任何分配记录，放行（向后兼容旧部署 / 未分配题块）
  const anyAssignment = await db.get(
    "SELECT 1 FROM review_assignments WHERE exam_id = ? AND block_id = ? LIMIT 1",
    examId, blockId
  );
  return !anyAssignment;
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
    // 兼容判断须匹配本考试维度（含 grade_id），避免"他考试有权限 → 本考试被误锁"
    const anyPermission = await db.get(
      `SELECT 1 FROM teacher_permissions WHERE teacher_id = ? AND can_grade = 1
         AND (grade_id IS NULL OR grade_id = (SELECT grade_id FROM exams WHERE id = ?))
         AND (subject IS NULL OR subject = (SELECT subject FROM exams WHERE id = ?))
         AND (class_id IS NULL OR class_id = (SELECT class_id FROM exams WHERE id = ?))
       LIMIT 1`,
      teacherId, examId, examId, examId
    );
    if (!anyAssignment && !anyPermission) return null;
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
