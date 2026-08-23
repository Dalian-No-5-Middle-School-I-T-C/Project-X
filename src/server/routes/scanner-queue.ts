/**
 * 扫描端远程上传队列路由（断线重传）
 * 供扫描端渲染进程入队 / 查询 / 重试 / 删除；本机服务端后台串行上传主站。
 * 本机 SQLite 方言下有效；主站（MariaDB）下队列表不存在，操作返回空。
 */

import { Router } from "express";
import { authMiddleware } from "../middleware/auth";
import {
  enqueueUpload,
  listUploadQueue,
  retryUploadQueueItem,
  deleteUploadQueueItem,
} from "../services/uploadQueue";

const router = Router();

/** POST /api/scanner/queue — 入队（幂等：同一本地会话未完成时复用并重置为 pending） */
router.post("/", authMiddleware, async (req, res, next) => {
  try {
    const { localSessionId, serverUrl, apiKey, cardId, dpi, paperSize, pageCount } = req.body ?? {};
    if (!localSessionId || !serverUrl || !cardId) {
      res.status(400).json({ message: "localSessionId / serverUrl / cardId 必填" });
      return;
    }
    const item = await enqueueUpload({
      localSessionId: String(localSessionId),
      serverUrl: String(serverUrl).replace(/\/+$/, ""),
      apiKey: typeof apiKey === "string" && apiKey.trim() ? apiKey.trim() : null,
      cardId: String(cardId),
      dpi: Number(dpi) || 300,
      paperSize: String(paperSize || "A4"),
      pageCount: Number(pageCount) || 0,
    });
    res.json({ ok: true, item });
  } catch (err) {
    next(err);
  }
});

/** GET /api/scanner/queue — 队列列表（最近 50 条，倒序） */
router.get("/", authMiddleware, async (_req, res, next) => {
  try {
    res.json(await listUploadQueue());
  } catch (err) {
    next(err);
  }
});

/** POST /api/scanner/queue/:id/retry — 手动重试（failed 项重置为 pending） */
router.post("/:id/retry", authMiddleware, async (req, res, next) => {
  try {
    const ok = await retryUploadQueueItem(Number(req.params.id));
    res.json({ ok });
  } catch (err) {
    next(err);
  }
});

/** DELETE /api/scanner/queue/:id — 删除队列项 */
router.delete("/:id", authMiddleware, async (req, res, next) => {
  try {
    const ok = await deleteUploadQueueItem(Number(req.params.id));
    res.json({ ok });
  } catch (err) {
    next(err);
  }
});

export default router;
