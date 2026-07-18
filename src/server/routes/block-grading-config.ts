/**
 * 题块网阅设置 API
 * 挂载点: /api/block-grading-config
 */
import { Router } from "express";
import { requirePermission } from "../middleware/auth";
import { PERMISSIONS } from "../auth/permissions";
import { requireExamAccess } from "../../apps/answer-card/server/middleware";
import {
  getBlockConfig,
  getExamBlockConfigs,
  upsertBlockConfig,
  batchUpdateConfigs
} from "../services/BlockGradingConfigService";

const router = Router();

// GET /api/block-grading-config/exams/:examId — 获取所有题块配置
router.get(
  "/exams/:examId",
  requireExamAccess,
  requirePermission(PERMISSIONS.GRADE_READ),
  async (req, res) => {
    try {
      const examId = Number(req.params.examId);
      const configs = await getExamBlockConfigs(examId);
      res.json({ ok: true, data: configs });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  }
);

// GET /api/block-grading-config/exams/:examId/blocks/:blockId — 获取单题块配置
router.get(
  "/exams/:examId/blocks/:blockId",
  requireExamAccess,
  requirePermission(PERMISSIONS.GRADE_READ),
  async (req, res) => {
    try {
      const examId = Number(req.params.examId);
      const blockId = String(req.params.blockId ?? "");
      const config = await getBlockConfig(examId, blockId);
      res.json({ ok: true, data: config });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  }
);

// PUT /api/block-grading-config/exams/:examId/blocks/:blockId — 更新单题块配置
router.put(
  "/exams/:examId/blocks/:blockId",
  requireExamAccess,
  requirePermission(PERMISSIONS.GRADE_WRITE),
  async (req, res) => {
    try {
      const examId = Number(req.params.examId);
      const { disputeThreshold, rounding, arbitratorId, reviewMode } = req.body;

      const blockId = String(req.params.blockId ?? "");
      const config = await upsertBlockConfig(examId, blockId, {
        disputeThreshold,
        rounding,
        arbitratorId,
        reviewMode
      });
      res.json({ ok: true, data: config });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  }
);

// POST /api/block-grading-config/exams/:examId/batch — 批量更新
router.post(
  "/exams/:examId/batch",
  requireExamAccess,
  requirePermission(PERMISSIONS.GRADE_WRITE),
  async (req, res) => {
    try {
      const examId = Number(req.params.examId);
      const { blockIds, disputeThreshold, rounding, arbitratorId, reviewMode } = req.body;

      if (!Array.isArray(blockIds) || blockIds.length === 0) {
        return res.status(400).json({ ok: false, error: "blockIds 必填且不能为空" });
      }

      await batchUpdateConfigs(examId, blockIds, {
        disputeThreshold,
        rounding,
        arbitratorId,
        reviewMode
      });

      res.json({ ok: true, message: `已更新 ${blockIds.length} 道题的设置` });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  }
);

export default router;
