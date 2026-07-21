/**
 * 阅卷会话（断点续批）API
 * 挂载点: /api/review-session
 */
import { Router } from "express";
import { requirePermission } from "../middleware/auth";
import { PERMISSIONS } from "../auth/permissions";
import { requireExamAccess } from "../../apps/answer-card/server/middleware";
import { getSession, saveSession, clearSession } from "../services/ReviewSessionService";

const router = Router();

// GET /api/review-session/exams/:examId/blocks/:blockId — 读取会话
router.get(
  "/exams/:examId/blocks/:blockId",
  requireExamAccess,
  requirePermission(PERMISSIONS.GRADE_READ),
  async (req, res) => {
    try {
      const teacherId = (req as any).user?.id;
      if (!teacherId) return res.status(401).json({ ok: false, error: "未登录" });

      const examId = Number(req.params.examId);
      const blockId = String(req.params.blockId ?? "");
      const session = await getSession(teacherId, examId, blockId);
      res.json({ ok: true, data: session });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  }
);

// PUT /api/review-session/exams/:examId/blocks/:blockId — 保存会话
router.put(
  "/exams/:examId/blocks/:blockId",
  requireExamAccess,
  requirePermission(PERMISSIONS.GRADE_WRITE),
  async (req, res) => {
    try {
      const teacherId = (req as any).user?.id;
      if (!teacherId) return res.status(401).json({ ok: false, error: "未登录" });

      const examId = Number(req.params.examId);
      const { currentIndex, positionJson, draftScores } = req.body;

      const blockId = String(req.params.blockId ?? "");
      await saveSession(teacherId, examId, blockId, currentIndex ?? 0, positionJson ?? null, draftScores ?? null);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  }
);

// DELETE /api/review-session/exams/:examId/blocks/:blockId — 清除会话
router.delete(
  "/exams/:examId/blocks/:blockId",
  requireExamAccess,
  requirePermission(PERMISSIONS.GRADE_WRITE),
  async (req, res) => {
    try {
      const teacherId = (req as any).user?.id;
      if (!teacherId) return res.status(401).json({ ok: false, error: "未登录" });

      const examId = Number(req.params.examId);
      const blockId = String(req.params.blockId ?? "");
      await clearSession(teacherId, examId, blockId);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  }
);

export default router;
