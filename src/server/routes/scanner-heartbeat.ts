/**
 * 主站侧扫描端心跳上报端点
 * POST /api/scanner/heartbeat — 扫描端定时上报在线状态（X-Api-Key 或 JWT+写权限）
 */

import { Router } from "express";
import { dualAuth } from "../middleware/scanner-auth";
import { recordHeartbeat } from "../services/scannerHeartbeat";

const router = Router();

router.post("/", dualAuth, async (req, res) => {
  try {
    const { clientId, name, version } = req.body ?? {};
    if (!clientId || typeof clientId !== "string") {
      res.status(400).json({ message: "clientId 必填" });
      return;
    }
    const host =
      (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ||
      req.socket?.remoteAddress ||
      "";
    const ok = await recordHeartbeat({
      clientId: clientId.slice(0, 64),
      name: typeof name === "string" ? name.slice(0, 128) : "",
      version: typeof version === "string" ? version.slice(0, 32) : "",
      host,
    });
    res.json({ ok, serverTime: new Date().toISOString() });
  } catch (err: any) {
    console.error("[heartbeat] 处理失败:", err?.message ?? err);
    res.status(500).json({ message: "心跳处理失败" });
  }
});

export default router;
