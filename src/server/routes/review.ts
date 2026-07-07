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
  submitReviewCropScores
} from "../services/ReviewService";
import type { ReviewSubmitScoreInput } from "../../shared/types";

const router = Router();

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

      const status = typeof req.body?.status === "string" ? req.body.status.trim() : "reviewed";
      const result = await submitReviewCropScores({
        examId,
        cropId,
        scores,
        status,
        userId: req.user!.id
      });
      res.json(result);
    } catch (error) {
      if (error instanceof Error && /不存在|未关联/.test(error.message)) {
        res.status(404).json({ message: error.message });
        return;
      }
      next(error);
    }
  }
);

export default router;
