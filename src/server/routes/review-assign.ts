/**
 * 阅卷任务分配 API
 * 挂载点: /api/review-assign
 */
import { Router } from "express";
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

      const rows = await db.all(
        `SELECT u.id, u.name, u.subject
         FROM users u
         WHERE u.role_id = 2
           ${exam.subject ? "AND u.subject = ?" : ""}
           ${exam.grade_id !== null ? "AND u.grade_id = ?" : ""}
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
  async (req, res) => {
    try {
      const examId = Number(req.params.examId);
      const { teacherCounts } = req.body;
      if (!teacherCounts || typeof teacherCounts !== "object") {
        return res.status(400).json({ ok: false, error: "teacherCounts 必填，格式: {teacherId: count}" });
      }

      const map = new Map<number, number>();
      for (const [key, val] of Object.entries(teacherCounts)) {
        map.set(Number(key), Number(val));
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
