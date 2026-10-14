import { Router } from "express";
import {
  requireExamAccess,
  requirePermissionCompat,
  requireWholeExamGradingAccess,
} from "../../apps/answer-card/server/middleware";
import { PERMISSIONS } from "../auth/permissions";
import { getAccessibleClassIds } from "./scores";
import {
  listPendingScans,
  confirmPendingScan,
} from "../services/scannerPending";
const router = Router();
// Scanner keys cannot approve their own uploads. Only authenticated whole-exam teachers can.
router.use(
  "/:examId/scanner-pending",
  (req, res, next) => {
    if (!req.user || !["teacher", "admin"].includes(req.user.role_name)) {
      res.status(403).json({ message: "仅教师可确认扫描成绩" });
      return;
    }
    next();
  },
  requireExamAccess,
  requirePermissionCompat(PERMISSIONS.GRADE_WRITE),
  requireWholeExamGradingAccess,
);
router.get("/:examId/scanner-pending", async (req, res, next) => {
  try {
    res.json({ items: await listPendingScans(Number(req.params.examId)) });
  } catch (error) {
    next(error);
  }
});
router.post("/:examId/scanner-pending", async (req, res) => {
  try {
    const { sessionId, groupId, action, token } = req.body ?? {};
    if (
      typeof sessionId !== "string" ||
      typeof groupId !== "string" ||
      !["accept", "discard"].includes(action) ||
      typeof token !== "string"
    ) {
      res.status(400).json({ message: "无效的确认请求" });
      return;
    }
    await confirmPendingScan(
      Number(req.params.examId),
      sessionId,
      groupId,
      action,
      token,
      req.user!.id,
      await getAccessibleClassIds(req.user),
    );
    res.json({ ok: true });
  } catch (error) {
    res
      .status(409)
      .json({ message: error instanceof Error ? error.message : "确认失败" });
  }
});
export default router;
