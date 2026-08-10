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

export { PERMISSIONS };
