/**
 * 网上阅卷 API
 * 挂载点: /api/review
 */
import { Router, type Request } from "express";
import { requirePermission } from "../middleware/auth";
import { PERMISSIONS } from "../auth/permissions";
import { requireExamAccess, requireGradingScope, getPermittedBlocks } from "../../apps/answer-card/server/middleware";
import { optionalPositiveNumber } from "../../apps/answer-card/server/helpers";
import {
  listReviewBlockCropItems,
  listReviewBlocks,
  submitReviewCropScores,
  ReviewValidationError
} from "../services/ReviewService";
import { getReviewTrace } from "../services/ReviewService";
import { buildAssignedSliceClause, type AssignedSliceClause } from "../services/ReviewPoolService";
import type { ReviewSubmitScoreInput } from "../../shared/types";
import { getMysqlDb } from "../db";

const router = Router();

/**
 * 当前调用者在这些题块内的逐生切片条件（PR #312 评审 B1）。
 *
 * `permitted === null` 表示 `getPermittedBlocks` 判定的「整场不受题块限制」（管理员 /
 * 学年主任 / 没有权限矩阵），这类账号本来就读全卷，不额外收口；本地模式未强制鉴权时
 * 也没有 `req.user`，同样返回 null 保持既有行为。
 */
async function assignedSliceFor(
  user: Request["user"],
  examId: number,
  blockIds: string[] | null
): Promise<AssignedSliceClause | null> {
  if (!user || !blockIds) return null;
  return buildAssignedSliceClause(examId, Number(user.id), blockIds);
}

// GET /api/review/my-exams — 教师有哪些考试有待阅任务
router.get("/my-exams", async (req, res) => {
  try {
    const userId = (req as any).user?.id;
    if (!userId) return res.status(401).json({ ok: false, error: "未登录" });

    // 修复：原先 LEFT JOIN 后对 ra.student_count 做 SUM 会按切块行数重复放大。
    // 改为按分配行聚合，已阅数用每块的子查询精确统计。
    const rows = await getMysqlDb().all(
      `SELECT examId, totalCount,
              CASE WHEN rawPending < 0 THEN 0 ELSE rawPending END AS pendingCount
       FROM (
         SELECT ra.exam_id AS examId,
                SUM(ra.student_count) AS totalCount,
                SUM(ra.student_count) - SUM(COALESCE((
                  SELECT COUNT(*)
                  FROM answer_block_crops abc2
                  WHERE abc2.exam_id = ra.exam_id
                    AND abc2.block_id = ra.block_id
                    AND abc2.status = 'reviewed'
                    AND abc2.reviewer_id = ?
                ), 0)) AS rawPending
         FROM review_assignments ra
         WHERE ra.teacher_id = ?
         GROUP BY ra.exam_id
       ) t`,
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
    // 安全 R03：`requireExamAccess` 只判定「能否看到这场考试」，题块级阅卷人因此能
    // 列出全卷题块与每题统计。读取侧按 `getPermittedBlocks` 收敛（null = 不受限）。
    const blocks = await listReviewBlocks(examId, getMysqlDb(), await getPermittedBlocks(req.user, examId));
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
    // 安全 R03：切块清单含学生姓名/学号与答案图，题块级阅卷人只能读本人题块；
    // 显式请求了越权题块时直接 403（而非静默返回空列表，避免前端误判「无待阅」）。
    const permitted = await getPermittedBlocks(req.user, examId);
    if (permitted && blockId && !permitted.includes(blockId)) {
      res.status(403).json({ message: `权限不足：未获分配题块 ${blockId}` });
      return;
    }
    // 安全 B1：题块内按逐生分配再切一刀，清单口径与领取/原图三处对齐
    const slice = await assignedSliceFor(req.user, examId, blockId && permitted ? [blockId] : permitted);
    const rows = await listReviewBlockCropItems({
      examId,
      blockId: blockId || undefined,
      blockIds: permitted ?? undefined,
      classId: classId ?? undefined,
      status: status || undefined,
      assignedSlice: slice
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
  requireGradingScope,
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
      let status: string | undefined;
      if (rawStatus === "") {
        status = undefined; // 未提供 → 服务层回退 "reviewed"（保持向后兼容）
      } else if (rawStatus === "draft" || rawStatus === "submitted" || rawStatus === "reviewed" || rawStatus === "disputed") {
        status = rawStatus;
      } else {
        throw new ReviewValidationError(`非法的 status 值: ${rawStatus}`);
      }
      const blockTotalScore =
        typeof req.body?.blockTotalScore === "number" ? req.body.blockTotalScore : undefined;
      const user = (req as any).user as { role_id?: number; role_name?: string; teacher_role?: string | null };
      const isAdmin = user?.role_id === 1;
      const isGradeLeader = user?.role_name === "teacher" && user?.teacher_role === "grade_leader";
      const result = await submitReviewCropScores({
        examId,
        cropId,
        scores,
        status,
        blockTotalScore,
        userId: req.user!.id,
        // 管理员与学年主任均可代交/强制处理他人已领取的试卷
        isAdmin: isAdmin || isGradeLeader
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
    // 安全 R03：溯源表暴露全卷每题得分与评审人，同样按题块范围收敛。
    const permitted = await getPermittedBlocks(req.user, examId);
    if (permitted && blockId && !permitted.includes(blockId)) {
      res.status(403).json({ message: `权限不足：未获分配题块 ${blockId}` });
      return;
    }
    const trace = await getReviewTrace(
      examId,
      blockId,
      getMysqlDb(),
      permitted,
      // 安全 B1：溯源比清单更敏感（每题得分 + 评审人 + 学号），同样要收到逐生切片
      await assignedSliceFor(req.user, examId, blockId && permitted ? [blockId] : permitted)
    );
    res.json({ ok: true, data: trace });
  } catch (error) {
    next(error);
  }
});

export default router;
