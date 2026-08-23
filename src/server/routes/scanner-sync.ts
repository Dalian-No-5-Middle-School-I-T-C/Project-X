/**
 * 主站侧答题卡同步端点（供扫描端拉取答题卡配置）
 * GET /api/scanner/sync/cards        — 答题卡轻量列表
 * GET /api/scanner/sync/cards/:id    — 单张答题卡完整数据包
 * 鉴权：dualAuth（X-Api-Key scope scanner，或 JWT + 写权限）
 */

import { Router } from "express";
import { dualAuth } from "../middleware/scanner-auth";
import { getMysqlDb } from "../db";
import { listSyncCards, exportCardPackage } from "../services/cardSync";

const router = Router();

router.get("/cards", dualAuth, async (_req, res, next) => {
  try {
    const db = await getMysqlDb();
    res.json({ cards: await listSyncCards(db) });
  } catch (err) {
    next(err);
  }
});

router.get("/cards/:id", dualAuth, async (req, res, next) => {
  try {
    const db = await getMysqlDb();
    const pkg = await exportCardPackage(db, String(req.params.id));
    if (!pkg) {
      res.status(404).json({ message: "答题卡不存在" });
      return;
    }
    res.json(pkg);
  } catch (err) {
    next(err);
  }
});

export default router;
