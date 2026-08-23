/**
 * 扫描端本机：答题卡同步包导入端点
 * POST /api/scanner/sync/import — 把主站拉取的答题卡数据包写入本机库（REPLACE 幂等）
 * 鉴权：本机登录（authMiddleware）
 */

import { Router } from "express";
import { authMiddleware } from "../../../../server/middleware/auth";
import { getMysqlDb } from "../../../../server/db";
import { importCardPackage } from "../../../../server/services/cardSync";

const router = Router();

router.post("/import", authMiddleware, async (req, res, next) => {
  try {
    const pkg = req.body;
    if (!pkg?.cardId || !pkg?.tables) {
      res.status(400).json({ message: "数据包格式无效（需含 cardId 与 tables）" });
      return;
    }
    const db = await getMysqlDb();
    const result = await importCardPackage(db, pkg);
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

export default router;
