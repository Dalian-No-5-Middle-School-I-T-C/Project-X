/**
 * Issue #174: 网阅试卷池 API
 * 挂载点: /api/review-pool
 */
import { Router } from "express";
import { requirePermission } from "../middleware/auth";
import { PERMISSIONS } from "../auth/permissions";
import { requireExamAccess, requireGradingScope } from "../../apps/answer-card/server/middleware";
import {
  getPoolSummary,
  getPoolEntries,
  claimNextPaper,
  claimSpecificPaper,
  releasePaper,
  getAssignedStudentIdSet,
  ReviewPoolError,
  ReviewPoolScopeError
} from "../services/ReviewPoolService";

const router = Router();

function poolError(res: any, err: unknown): void {
  if (err instanceof ReviewPoolScopeError) {
    // 安全 R15：越权领取（逐生分配范围外 / 持有量超限）与「池里没有卷」语义不同
    res.status(403).json({ ok: false, error: err.message });
    return;
  }
  if (err instanceof ReviewPoolError) {
    res.status(409).json({ ok: false, error: err.message });
    return;
  }
  res.status(500).json({ ok: false, error: err instanceof Error ? err.message : "服务器错误" });
}

/** 特权阅卷人（管理员 / 学年主任）：处理积压与争议卷，不受持有量配额限制 */
function isPrivilegedCaller(user: any): boolean {
  return user?.role_id === 1 || (user?.role_name === "teacher" && user?.teacher_role === "grade_leader");
}

// GET /api/review-pool/exams/:examId/blocks/:blockId — 试卷池汇总 + 条目
router.get(
  "/exams/:examId/blocks/:blockId",
  requireExamAccess,
  requirePermission(PERMISSIONS.GRADE_READ),
  async (req, res) => {
    try {
      const examId = Number(req.params.examId);
      const blockId = String(req.params.blockId ?? "");
      const mine = req.query.mine === "1" || req.query.mine === "true";
      const teacherId = (req as any).user?.id;
      const summary = await getPoolSummary(examId, blockId, teacherId);
      // 安全 R15：逐生分配的教师列出的是「谁的卷子」清单，不应包含未分配给他的学生
      const assignedIds = isPrivilegedCaller((req as any).user) || !teacherId
        ? null
        : await getAssignedStudentIdSet(examId, blockId, Number(teacherId));
      const entries = await getPoolEntries(
        examId,
        blockId,
        {
          ...(mine && teacherId ? { claimedBy: teacherId } : {}),
          ...(assignedIds ? { onlyStudentIds: assignedIds } : {})
        }
      );
      res.json({ ok: true, data: { summary, entries } });
    } catch (err: unknown) {
      poolError(res, err);
    }
  }
);

// POST /api/review-pool/exams/:examId/blocks/:blockId/claim — 领取池中下一份
router.post(
  "/exams/:examId/blocks/:blockId/claim",
  requireExamAccess,
  requirePermission(PERMISSIONS.GRADE_WRITE),
  requireGradingScope,
  async (req, res) => {
    try {
      const examId = Number(req.params.examId);
      const blockId = String(req.params.blockId ?? "");
      const teacherId = (req as any).user?.id;
      if (!teacherId) return res.status(401).json({ ok: false, error: "未登录" });
      const classId = req.body?.classId ? Number(req.body.classId) : undefined;
      const entry = await claimNextPaper(examId, blockId, teacherId, undefined, {
        classId: classId && Number.isFinite(classId) ? classId : undefined,
        privileged: isPrivilegedCaller((req as any).user)
      });
      res.json({ ok: true, data: entry });
    } catch (err: unknown) {
      poolError(res, err);
    }
  }
);

// POST /api/review-pool/exams/:examId/blocks/:blockId/crops/:cropId/claim — 领取指定试卷
router.post(
  "/exams/:examId/blocks/:blockId/crops/:cropId/claim",
  requireExamAccess,
  requirePermission(PERMISSIONS.GRADE_WRITE),
  requireGradingScope,
  async (req, res) => {
    try {
      const examId = Number(req.params.examId);
      const blockId = String(req.params.blockId ?? "");
      const cropId = String(req.params.cropId ?? "");
      const teacherId = (req as any).user?.id;
      if (!teacherId) return res.status(401).json({ ok: false, error: "未登录" });
      const entry = await claimSpecificPaper(examId, blockId, cropId, teacherId, undefined, {
        privileged: isPrivilegedCaller((req as any).user)
      });
      res.json({ ok: true, data: entry });
    } catch (err: unknown) {
      poolError(res, err);
    }
  }
);

// POST /api/review-pool/exams/:examId/blocks/:blockId/crops/:cropId/release — 释放回池（本人/强制）
router.post(
  "/exams/:examId/blocks/:blockId/crops/:cropId/release",
  requireExamAccess,
  requirePermission(PERMISSIONS.GRADE_WRITE),
  requireGradingScope,
  async (req, res) => {
    try {
      const examId = Number(req.params.examId);
      const blockId = String(req.params.blockId ?? "");
      const cropId = String(req.params.cropId ?? "");
      const teacherId = (req as any).user?.id;
      if (!teacherId) return res.status(401).json({ ok: false, error: "未登录" });
      const force = req.body?.force === true;
      const user = (req as any).user as { role_id?: number; role_name?: string; teacher_role?: string | null };
      const isAdmin = user?.role_id === 1;
      const isGradeLeader = user?.role_name === "teacher" && user?.teacher_role === "grade_leader";
      if (force && !isAdmin && !isGradeLeader) {
        return res.status(403).json({ ok: false, error: "仅管理员或学年主任可强制释放他人领取的试卷" });
      }
      await releasePaper(examId, blockId, cropId, teacherId, undefined, { force });
      res.json({ ok: true });
    } catch (err: unknown) {
      poolError(res, err);
    }
  }
);

export default router;
