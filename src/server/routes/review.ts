/**
 * 网上阅卷 API
 * 挂载点: /api/review
 */
import { Router } from "express";
import { requirePermission } from "../middleware/auth";
import { PERMISSIONS } from "../auth/permissions";
import { requireExamAccess } from "../../apps/answer-card/server/middleware";
import { optionalPositiveNumber } from "../../apps/answer-card/server/helpers";
import {
  listReviewBlockCropItems,
  listReviewBlocks,
  submitReviewCropScores,
  ReviewValidationError
} from "../services/ReviewService";
import { getReviewTrace } from "../services/ReviewService";
import type { ReviewSubmitScoreInput } from "../../shared/types";
import { getMysqlDb } from "../db";

const router = Router();

// GET /api/review/my-exams — 教师有哪些考试有待阅任务
router.get("/my-exams", async (req, res) => {
  try {
    const userId = (req as any).user?.id;
    if (!userId) return res.status(401).json({ ok: false, error: "未登录" });

    const rows = await getMysqlDb().all(
      `SELECT ra.exam_id AS examId,
              SUM(ra.student_count) AS totalCount,
              SUM(ra.student_count) - COUNT(CASE WHEN abc.status = 'reviewed' AND abc.reviewer_id = ? THEN 1 END) AS pendingCount
       FROM review_assignments ra
       LEFT JOIN answer_block_crops abc ON abc.exam_id = ra.exam_id AND abc.block_id = ra.block_id
       WHERE ra.teacher_id = ?
       GROUP BY ra.exam_id`,
      userId, userId
    );

    res.json({ ok: true, data: rows });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get("/exams/:examId/blocks", requireExamAccess, async (req, res, next) => {
  try {
    const examId = Number(req.params.examId);
    if (!Number.isFinite(examId)) {
      res.status(400).json({ message: "Invalid examId" });
      return;
    }
    const blocks = await listReviewBlocks(examId);
    res.json({ examId, blocks });
  } catch (error) {
    next(error);
  }
});

router.get("/exams/:examId/block-crops", requireExamAccess, async (req, res, next) => {
  try {
    const examId = Number(req.params.examId);
    if (!Number.isFinite(examId)) {
      res.status(400).json({ message: "Invalid examId" });
      return;
    }
    const blockId = typeof req.query.blockId === "string" ? req.query.blockId.trim() : "";
    const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
    const classId = optionalPositiveNumber(req.query.classId);
    const rows = await listReviewBlockCropItems({
      examId,
      blockId: blockId || undefined,
      classId: classId ?? undefined,
      status: status || undefined
    });
    res.json({ examId, rows });
  } catch (error) {
    next(error);
  }
});

router.post(
  "/exams/:examId/block-crops/:cropId/submit",
  requireExamAccess,
  requirePermission(PERMISSIONS.GRADE_WRITE),
  async (req, res, next) => {
    try {
      const examId = Number(req.params.examId);
      const cropId = String(req.params.cropId ?? "").trim();
      if (!Number.isFinite(examId) || !cropId) {
        res.status(400).json({ message: "参数无效" });
        return;
      }

      const scores = req.body?.scores as ReviewSubmitScoreInput[] | undefined;
      if (!Array.isArray(scores) || scores.length === 0) {
        res.status(400).json({ message: "请提供分数数据" });
        return;
      }

      const rawStatus = typeof req.body?.status === "string" ? req.body.status.trim() : "";
      const status = rawStatus === "draft" || rawStatus === "submitted" ? rawStatus : undefined;
      const result = await submitReviewCropScores({
        examId,
        cropId,
        scores,
        status,
        userId: req.user!.id
      });
      res.json(result);
    } catch (error) {
      if (error instanceof ReviewValidationError) {
        res.status(422).json({ message: error.message });
        return;
      }
      if (error instanceof Error && /不存在|未关联/.test(error.message)) {
        res.status(404).json({ message: error.message });
        return;
      }
      next(error);
    }
  }
);

// GET /api/review/exams/:examId/trace — 阅卷溯源
router.get("/exams/:examId/trace", requireExamAccess, async (req, res, next) => {
  try {
    const examId = Number(req.params.examId);
    if (!Number.isFinite(examId)) {
      res.status(400).json({ message: "Invalid examId" });
      return;
    }
    const blockId = typeof req.query.blockId === "string" ? req.query.blockId : undefined;
    const trace = await getReviewTrace(examId, blockId);
    res.json({ ok: true, data: trace });
  } catch (error) {
    next(error);
  }
});

export default router;
