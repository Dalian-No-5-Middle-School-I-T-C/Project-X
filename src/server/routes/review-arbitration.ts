/**
 * 争议仲裁 API
 * 挂载点: /api/review-arbitration
 */
import { Router } from "express";
import { requirePermission } from "../middleware/auth";
import { PERMISSIONS } from "../auth/permissions";
import { requireExamAccess } from "../../apps/answer-card/server/middleware";
import { getDisputes, getEligibleArbitrators } from "../services/ArbitrationService";
import { getMysqlDb } from "../db";
import { recomputeExamRankings } from "../services/rankingUpdate";

const router = Router();

// GET /api/review-arbitration/exams/:examId/disputes — 争议列表
router.get(
  "/exams/:examId/disputes",
  requireExamAccess,
  requirePermission(PERMISSIONS.GRADE_READ),
  async (req, res) => {
    try {
      const examId = Number(req.params.examId);
      const blockId = typeof req.query.blockId === "string" ? req.query.blockId : undefined;
      const disputes = await getDisputes(examId, blockId);
      res.json({ ok: true, data: disputes });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  }
);

// GET /api/review-arbitration/exams/:examId/blocks/:blockId/arbitrators — 合格仲裁人列表
router.get(
  "/exams/:examId/blocks/:blockId/arbitrators",
  requireExamAccess,
  requirePermission(PERMISSIONS.GRADE_READ),
  async (req, res) => {
    try {
      const examId = Number(req.params.examId);
      const excludedIds = req.query.excludedReviewerIds
        ? String(req.query.excludedReviewerIds).split(",").map(Number)
        : [];

      const candidates = await getEligibleArbitrators(examId, String(req.params.blockId ?? ""), excludedIds);
      res.json({ ok: true, data: candidates });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  }
);

// POST /api/review-arbitration/crops/:cropId/resolve — 仲裁人提交最终分
router.post(
  "/crops/:cropId/resolve",
  requirePermission(PERMISSIONS.GRADE_WRITE),
  async (req, res) => {
    try {
      const db = getMysqlDb();
      const cropId = String(req.params.cropId ?? "");
      const { score } = req.body;
      const userId = (req as any).user?.id;

      if (score == null || !Number.isFinite(Number(score))) {
        return res.status(400).json({ ok: false, error: "score 必填" });
      }

      const crop = await db.get(
        "SELECT * FROM answer_block_crops WHERE id = ?",
        cropId
      ) as any;
      if (!crop) return res.status(404).json({ ok: false, error: "切块不存在" });

      const now = new Date().toISOString();

      // 检查仲裁人是否已参与该卷评审
      const existingBreakdown = crop.score_breakdown ? JSON.parse(crop.score_breakdown) : [];
      const reviewerIds = new Set(existingBreakdown.map((b: any) => b.reviewerId));
      if (reviewerIds.has(userId)) {
        return res.status(400).json({ ok: false, error: "仲裁人已是该卷评审人之一，无法仲裁" });
      }

      // 记录仲裁分数
      existingBreakdown.push({
        round: existingBreakdown.length + 1,
        reviewerId: userId,
        score: Number(score),
        reviewedAt: now
      });

      await db.run(
        `UPDATE answer_block_crops
         SET status = 'reviewed', final_score = ?, final_score_by = ?, review_round = ?,
             score_breakdown = ?, reviewed_at = ?
         WHERE id = ?`,
        Number(score),
        userId,
        existingBreakdown.length,
        JSON.stringify(existingBreakdown),
        now,
        cropId
      );

      // 同时写入 question_scores
      const questionNumbers = JSON.parse(crop.question_numbers ?? "[]");
      await db.transaction(async (tx) => {
        for (const qNum of questionNumbers) {
          await tx.run(
            `INSERT OR REPLACE INTO question_scores (exam_id, student_id, question_number, score, max_score, score_type, manually_modified, modified_by, modified_at)
             VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
            crop.exam_id,
            crop.student_id,
            qNum,
            Number(score),
            0,
            "subjective",
            userId,
            now
          );
        }
      });

      // 重算总分和排名
      if (crop.exam_id) {
        await recomputeExamRankings(db, crop.exam_id);
      }

      res.json({ ok: true, cropId, finalScore: Number(score) });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  }
);

export default router;
