/**
 * 每周考试审计 API
 * 挂载点 /api/weekly-audit
 *
 * GET /api/weekly-audit/summary?week=YYYY-MM-DD&gradeId=N
 *  - week：周一日期（缺省 = 本周）；gradeId：年级（缺省 = 该周第一个年级）
 *  - 响应 { weeks, grades, active }，一次请求拿到周切换与年级切换所需全部数据
 * 权限：authMiddleware + GRADE_READ（与 /api/analysis 的 analysisGate 同权限，
 * 晨测本身全教师可见，无需额外 visibility 过滤）
 */
import { Router } from "express";
import { authMiddleware, requirePermission } from "../middleware/auth";
import { PERMISSIONS } from "../auth/permissions";
import { WeeklyAuditService } from "../services/WeeklyAuditService";

const router = Router();
router.use(authMiddleware);

router.get("/summary", requirePermission(PERMISSIONS.GRADE_READ), async (req, res, next) => {
  try {
    const weekParam = typeof req.query.week === "string" ? req.query.week : undefined;
    const rawGradeId = req.query.gradeId === undefined ? undefined : Number(req.query.gradeId);
    const gradeId = Number.isInteger(rawGradeId) && (rawGradeId as number) > 0 ? (rawGradeId as number) : undefined;
    const data = await new WeeklyAuditService().getSummary(weekParam, gradeId);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

export default router;
