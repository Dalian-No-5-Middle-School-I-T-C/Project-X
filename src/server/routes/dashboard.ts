/**
 * 首页仪表盘 API
 * 挂载点 /api/dashboard
 */
import { Router } from "express";
import { authMiddleware } from "../middleware/auth";
import { PERMISSIONS } from "../auth/permissions";
import { requirePermission } from "../middleware/auth";
import { getDashboardData } from "../services/DashboardService";

const router = Router();
router.use(authMiddleware);

router.get("/", requirePermission(PERMISSIONS.EXAM_READ), async (req, res) => {
  try {
    if (!req.user?.id) return res.status(401).json({ ok: false, error: "未登录" });
    const data = await getDashboardData(req.user);
    res.json({ ok: true, data });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
