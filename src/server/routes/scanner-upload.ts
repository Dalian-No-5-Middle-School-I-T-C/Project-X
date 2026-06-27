/**
 * v1.6.0 — 扫描上传端点
 * 供扫描端 Electron 通过 HTTP 上传扫描结果到服务端
 *
 * 鉴权: apiKeyAuth（X-Api-Key）或 authMiddleware（JWT token）
 *
 * POST /api/scanner/sessions            — 创建扫描会话
 * POST /api/scanner/sessions/:id/pages  — 上传扫描页
 * POST /api/scanner/sessions/:id/complete — 完成扫描，触发识别
 * GET  /api/scanner/sessions/:id/status   — 查询状态
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import path from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import crypto from "node:crypto";
import { apiKeyAuth } from "../middleware/api-key";
import { optionalAuth } from "../middleware/auth";
import { getMysqlDb } from "../db";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const router = Router();

// v1.6.0: 双鉴权 — API Key 优先，无 Key 时回退 JWT
// 单独使用 optionalAuth（不验证）配合 apiKeyAuth（主动校验）
// 逻辑：先尝试 X-Api-Key，有则校验；没有则走 optionalAuth 挂载用户
async function dualAuth(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.headers["x-api-key"] as string | undefined;
  if (apiKey) {
    // 有 API Key → 走 apiKey 验证
    const keyMw = apiKeyAuth({ scope: "scanner" });
    await keyMw(req, res, next);
  } else {
    // 无 API Key → 尝试 JWT token
    await optionalAuth(req, res, next);
  }
}

// 生成唯一 ID
function genId(): string {
  return crypto.randomBytes(12).toString("hex");
}

function scannerUploadDir(): string {
  const base = process.env.ANSWER_CARD_DATA_DIR
    || path.join(process.cwd(), "data", "answer-card");
  const dir = path.join(base, "scanner-uploads");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

// ── POST /api/scanner/sessions ────────────────────────
router.post("/sessions", dualAuth, async (req: Request, res: Response) => {
  try {
    const { cardId, examId, name, dpi, paperSize, pageCount } = req.body ?? {};
    if (!cardId) {
      res.status(400).json({ message: "cardId 必填" });
      return;
    }

    const sessionId = `scan_${genId()}`;
    const db = await getMysqlDb();

    await db.run(
      `INSERT INTO twain_scan_sessions (id, card_id, name, dpi, duplex, color_mode, paper_size, page_count, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'uploading')`,
      [
        sessionId,
        String(cardId),
        name || `扫描_${new Date().toISOString().slice(0, 10)}`,
        dpi || 300,
        1,            // duplex
        "gray",       // color_mode
        paperSize || "A4",
        pageCount || 0,
      ]
    );

    // 给每页生成上传 token（简单防篡改）
    const totalPages = pageCount || 1;
    const uploadTokens: string[] = [];
    for (let i = 0; i < totalPages; i++) {
      const token = genId();
      uploadTokens.push(token);
      await db.run(
        `INSERT INTO twain_scan_records (id, session_id, card_id, image_path, page_num, side, ocr_status)
         VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
        [token, sessionId, String(cardId), `pending:${token}`, i + 1, i === 0 ? "front" : "back"]
      );
    }

    res.status(201).json({
      sessionId,
      uploadTokens,
      message: `会话已创建，共 ${totalPages} 页待上传`,
    });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// ── POST /api/scanner/sessions/:sessionId/pages ─────────
router.post("/sessions/:sessionId/pages", dualAuth, upload.single("image"), async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const token = (req.body?.token ?? req.query?.token) as string;
    const pageNum = Number(req.body?.pageNum ?? 1);
    const side = (req.body?.side as string) || "front";

    if (!req.file) {
      res.status(400).json({ message: "未上传图片" });
      return;
    }
    if (!token) {
      res.status(400).json({ message: "缺少 upload token" });
      return;
    }

    const db = await getMysqlDb();

    // 验证 session
    const session = await db.get("SELECT id FROM twain_scan_sessions WHERE id = ?", [sessionId]);
    if (!session) {
      res.status(404).json({ message: "会话不存在" });
      return;
    }

    // 保存图片
    const ext = path.extname(req.file.originalname) || ".jpg";
    const fileName = `${sessionId}_p${String(pageNum).padStart(2, "0")}_${side}${ext}`;
    const filePath = path.join(scannerUploadDir(), fileName);
    writeFileSync(filePath, req.file.buffer);

    // 更新记录
    if (token) {
      await db.run(
        `UPDATE twain_scan_records SET image_path = ?, page_num = ?, side = ?, ocr_status = 'uploaded'
         WHERE id = ? AND session_id = ?`,
        [filePath, pageNum, side, token, sessionId]
      );
    }

    res.json({ ok: true, pageNum, side, fileName });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// ── POST /api/scanner/sessions/:sessionId/complete ──────
router.post("/sessions/:sessionId/complete", dualAuth, async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const db = await getMysqlDb();

    const session = await db.get("SELECT id, page_count FROM twain_scan_sessions WHERE id = ?", [sessionId]);
    if (!session) {
      res.status(404).json({ message: "会话不存在" });
      return;
    }

    // 统计上传进度
    const uploaded = await db.get<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM twain_scan_records WHERE session_id = ? AND ocr_status = 'uploaded'",
      [sessionId]
    );
    const total = await db.get<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM twain_scan_records WHERE session_id = ?",
      [sessionId]
    );

    // 标记会话完成
    await db.run(
      "UPDATE twain_scan_sessions SET status = 'completed', page_count = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [uploaded?.cnt ?? 0, sessionId]
    );

    res.json({
      ok: true,
      message: `扫描完成：${uploaded?.cnt ?? 0}/${total?.cnt ?? 0} 页已上传，等待服务端识别`,
      pagesUploaded: uploaded?.cnt ?? 0,
      pagesTotal: total?.cnt ?? 0,
    });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// ── GET /api/scanner/sessions/:sessionId/status ────────
router.get("/sessions/:sessionId/status", dualAuth, async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const db = await getMysqlDb();

    const session = await db.get<any>(
      `SELECT id, card_id, name, status, page_count, created_at, updated_at FROM twain_scan_sessions WHERE id = ?`,
      [sessionId]
    );
    if (!session) {
      res.status(404).json({ message: "会话不存在" });
      return;
    }

    const records = await db.all<any>(
      `SELECT id, page_num, side, ocr_status, scan_quality FROM twain_scan_records WHERE session_id = ? ORDER BY page_num`,
      [sessionId]
    );

    res.json({
      session,
      pages: records,
      progress: {
        total: records.length,
        uploaded: records.filter((r: any) => r.ocr_status === "uploaded" || r.ocr_status === "completed").length,
        recognized: records.filter((r: any) => r.ocr_status === "completed").length,
      },
    });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
