/**
 * 题块网阅设置 API
 * 挂载点: /api/block-grading-config
 */
import { Router } from "express";
import { requirePermission } from "../middleware/auth";
import { PERMISSIONS } from "../auth/permissions";
import { requireExamAccess } from "../../apps/answer-card/server/middleware";
import { getMysqlDb } from "../db";
import {
  getBlockConfig,
  getExamBlockConfigs,
  upsertBlockConfig,
  batchUpdateConfigs
} from "../services/BlockGradingConfigService";

const router = Router();

/** v1.9.4 权限下调：仅管理员可改仲裁人/分差/取整/模式；教师仅可改 has_half_point，且限本人已分配块 */
const ADMIN_ONLY_FIELDS = [
  "disputeThreshold", "rounding", "arbitratorId", "reviewMode",
  "autoReassignNoArb", "workloadBalanceThreshold"
] as const;

async function teacherAssignedToBlock(
  examId: number,
  blockId: string,
  teacherId: number
): Promise<boolean> {
  const row = await getMysqlDb().get(
    "SELECT 1 FROM review_assignments WHERE exam_id = ? AND block_id = ? AND teacher_id = ? LIMIT 1",
    examId, blockId, teacherId
  );
  return Boolean(row);
}

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
      const blockId = String(req.params.blockId ?? "");
      const isAdmin = (req.user as any)?.role_id === 1;

      // v1.9.4 权限下调：非管理员只能改 has_half_point，且须本人已分配本题块
      if (!isAdmin) {
        const forbidden = ADMIN_ONLY_FIELDS.filter((f) => req.body[f] !== undefined);
        if (forbidden.length > 0) {
          return res.status(403).json({ ok: false, error: "无权限修改该字段，仅管理员可设置仲裁人/分差/取整/模式" });
        }
        if (!(await teacherAssignedToBlock(examId, blockId, (req.user as any).id))) {
          return res.status(403).json({ ok: false, error: "仅可修改本人已分配的题块" });
        }
      }

      const {
        disputeThreshold, rounding, arbitratorId, reviewMode,
        hasHalfPoint, autoReassignNoArb, workloadBalanceThreshold
      } = req.body;

      const config = await upsertBlockConfig(examId, blockId, {
        disputeThreshold,
        rounding,
        arbitratorId,
        reviewMode,
        hasHalfPoint,
        autoReassignNoArb,
        workloadBalanceThreshold
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
      const {
        blockIds, disputeThreshold, rounding, arbitratorId, reviewMode,
        hasHalfPoint, autoReassignNoArb, workloadBalanceThreshold
      } = req.body;

      if (!Array.isArray(blockIds) || blockIds.length === 0) {
        return res.status(400).json({ ok: false, error: "blockIds 必填且不能为空" });
      }

      // v1.9.4 权限下调：非管理员只能批量改 has_half_point，且限本人已分配块
      const isAdmin = (req.user as any)?.role_id === 1;
      let targetBlocks = blockIds.map((b: any) => String(b));
      if (!isAdmin) {
        const forbidden = ADMIN_ONLY_FIELDS.filter((f) => req.body[f] !== undefined);
        if (forbidden.length > 0) {
          return res.status(403).json({ ok: false, error: "无权限批量修改该字段，仅管理员可设置仲裁人/分差/取整/模式" });
        }
        const assigned = await Promise.all(
          targetBlocks.map((b: string) => teacherAssignedToBlock(examId, b, (req.user as any).id))
        );
        targetBlocks = targetBlocks.filter((_: string, i: number) => assigned[i]);
        if (targetBlocks.length === 0) {
          return res.status(403).json({ ok: false, error: "仅可修改本人已分配的题块" });
        }
      }

      await batchUpdateConfigs(examId, targetBlocks, {
        disputeThreshold,
        rounding,
        arbitratorId,
        reviewMode,
        hasHalfPoint,
        autoReassignNoArb,
        workloadBalanceThreshold
      });

      res.json({ ok: true, message: `已更新 ${targetBlocks.length} 道题的设置` });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  }
);

export default router;
