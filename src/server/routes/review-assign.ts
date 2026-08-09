/**
 * 阅卷任务分配 API
 * 挂载点: /api/review-assign
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { requirePermission } from "../middleware/auth";
import { PERMISSIONS } from "../auth/permissions";
import { requireExamAccess } from "../../apps/answer-card/server/middleware";
import { optionalPositiveNumber } from "../../apps/answer-card/server/helpers";
import { getMysqlDb } from "../db";
import {
  getAssignmentsByBlock,
  getAssignmentsByTeacher,
  getAvailableBlocksForTeacher,
  createAssignments,
  deleteAssignment
} from "../services/ReviewAssignmentService";

const router = Router();

/** 阅卷分配仅限学年主任（grade_leader）或管理员；普通教师不得创建/删除分配。 */
function requireGradeLeaderOrAdmin(req: Request, res: Response, next: NextFunction): void {
  const user = (req as any).user as { role_id?: number; role_name?: string; teacher_role?: string | null } | undefined;
  if (!user) {
    res.status(401).json({ ok: false, error: "未登录" });
    return;
  }
  const isAdmin = user.role_id === 1;
  const isGradeLeader = user.role_name === "teacher" && user.teacher_role === "grade_leader";
  if (!isAdmin && !isGradeLeader) {
    res.status(403).json({ ok: false, error: "仅学年主任或管理员可执行阅卷分配" });
    return;
  }
  next();
}

// GET /api/review-assign/exams/:examId/eligible-teachers — 可分配教师列表（同科同年级）
router.get(
  "/exams/:examId/eligible-teachers",
  requireExamAccess,
  requirePermission(PERMISSIONS.GRADE_READ),
  async (req, res) => {
    try {
      const examId = Number(req.params.examId);
      const db = getMysqlDb();
      const exam = await db.get("SELECT subject, grade_id FROM exams WHERE id = ?", examId) as { subject: string | null; grade_id: number | null } | undefined;
      if (!exam) return res.status(404).json({ ok: false, error: "考试不存在" });

      // users 表没有 grade_id 列，年级过滤须经 teacher_classes → classes.grade_id；
      // 未绑定班级的教师不参与年级过滤（保持向后兼容）。
      const rows = await db.all(
        `SELECT u.id, u.name, u.subject
         FROM users u
         WHERE u.role_id = 2
           ${exam.subject ? "AND u.subject = ?" : ""}
           ${exam.grade_id !== null
             ? "AND (NOT EXISTS (SELECT 1 FROM teacher_classes tc WHERE tc.teacher_id = u.id) OR EXISTS (SELECT 1 FROM teacher_classes tc2 JOIN classes c2 ON c2.id = tc2.class_id WHERE tc2.teacher_id = u.id AND c2.grade_id = ?))"
             : ""}
         ORDER BY u.name`,
        ...(exam.subject ? [exam.subject] : []),
        ...(exam.grade_id !== null ? [exam.grade_id] : [])
      );
      res.json({ ok: true, data: rows });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  }
);

// GET /api/review-assign/exams/:examId/blocks/:blockId — 获取题块分配列表
router.get(
  "/exams/:examId/blocks/:blockId",
  requireExamAccess,
  requirePermission(PERMISSIONS.GRADE_READ),
  async (req, res) => {
    try {
      const examId = Number(req.params.examId);
      const blockId = String(req.params.blockId ?? "");
      const assignments = await getAssignmentsByBlock(examId, blockId);
      res.json({ ok: true, data: assignments });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  }
);

// GET /api/review-assign/exams/:examId/teachers/me/blocks — 教师查看自己可选块
router.get(
  "/exams/:examId/teachers/me/blocks",
  requireExamAccess,
  requirePermission(PERMISSIONS.GRADE_READ),
  async (req, res) => {
    try {
      const examId = Number(req.params.examId);
      const teacherId = (req as any).user?.id;
      if (!teacherId) return res.status(401).json({ ok: false, error: "未登录" });

      const blocks = await getAvailableBlocksForTeacher(examId, teacherId);
      res.json({ ok: true, data: blocks });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  }
);

// POST /api/review-assign/exams/:examId/blocks/:blockId — 创建分配（年级组长）
router.post(
  "/exams/:examId/blocks/:blockId",
  requireExamAccess,
  requirePermission(PERMISSIONS.GRADE_WRITE),
  requireGradeLeaderOrAdmin,
  async (req, res) => {
    try {
      const examId = Number(req.params.examId);
      const { teacherCounts } = req.body;
      if (!teacherCounts || typeof teacherCounts !== "object") {
        return res.status(400).json({ ok: false, error: "teacherCounts 必填，格式: {teacherId: count}" });
      }
      const db = getMysqlDb();

      const map = new Map<number, number>();
      for (const [key, val] of Object.entries(teacherCounts)) {
        const teacherId = Number(key);
        const count = Number(val);
        if (!Number.isInteger(teacherId) || teacherId <= 0 || !Number.isInteger(count) || count <= 0) {
          return res.status(400).json({ ok: false, error: `无效的分配参数: ${key}=${val}` });
        }
        map.set(teacherId, count);
      }
      // 校验教师存在且为教师角色（防止外键 500 / 误把学生 ID 当作阅卷教师）
      const teacherIds = Array.from(map.keys());
      const teacherRows = await db.all(
        `SELECT id FROM users WHERE id IN (${teacherIds.map(() => "?").join(",")}) AND role_id = 2`,
        ...teacherIds
      ) as Array<{ id: number }>;
      if (teacherRows.length !== teacherIds.length) {
        return res.status(400).json({ ok: false, error: "分配列表包含不存在的教师" });
      }

      const userId = (req as any).user?.id;
      const assignments = await createAssignments(examId, String(req.params.blockId ?? ""), map, userId);
      res.json({ ok: true, data: assignments });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  }
);

// DELETE /api/review-assign/:id — 删除分配
router.delete(
  "/:id",
  requirePermission(PERMISSIONS.GRADE_WRITE),
  requireGradeLeaderOrAdmin,
  async (req, res) => {
    try {
      await deleteAssignment(Number(req.params.id));
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  }
);

export default router;
