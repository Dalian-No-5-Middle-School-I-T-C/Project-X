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

import { Router, type Request, type Response } from "express";
import multer from "multer";
import path from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import crypto from "node:crypto";
import { dualAuth } from "../middleware/scanner-auth";
import { getMysqlDb } from "../db";
import { persistAnswerBlockCrops } from "../services/AnswerBlockCropService";
import { isValidImageBuffer } from "../../apps/answer-card/server/validate-upload";
import type { RecognitionBlockCrop } from "../../shared/types";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const router = Router();

// v1.6.0: 双鉴权 — API Key 优先，无 Key 时强制 JWT（见 scanner-auth.ts）

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
    const { cardId, name, dpi, paperSize, pageCount } = req.body ?? {};
    if (!cardId) {
      res.status(400).json({ message: "cardId 必填" });
      return;
    }

    const sessionId = `scan_${genId()}`;
    const db = await getMysqlDb();

    await db.run(
      `INSERT INTO twain_scan_sessions (id, card_id, name, dpi, duplex, color_mode, paper_size, page_count, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'uploading')`,
      sessionId,
      String(cardId),
      name || `扫描_${new Date().toISOString().slice(0, 10)}`,
      dpi || 300,
      1,            // duplex
      "gray",       // color_mode
      paperSize || "A4",
      pageCount || 0,
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
        token, sessionId, String(cardId), `pending:${token}`, i + 1, i === 0 ? "front" : "back"
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
    const rawSide = (req.body?.side as string) || "front";
    // 白名单校验，防止 side 参数触发路径遍历
    const side = rawSide === "back" ? "back" : "front";
    if (!Number.isInteger(pageNum) || pageNum < 1 || pageNum > 999) {
      res.status(400).json({ message: "无效的页码" });
      return;
    }

    if (!req.file) {
      res.status(400).json({ message: "未上传图片" });
      return;
    }
    // 魔数校验（Content-Type/扩展名可伪造，文件头不可）
    if (!isValidImageBuffer(req.file.buffer)) {
      res.status(400).json({ message: "上传的文件不是受支持的图片格式" });
      return;
    }
    if (!token) {
      res.status(400).json({ message: "缺少 upload token" });
      return;
    }

    const db = await getMysqlDb();

    // 验证 session
    const session = await db.get("SELECT id FROM twain_scan_sessions WHERE id = ?", sessionId);
    if (!session) {
      res.status(404).json({ message: "会话不存在" });
      return;
    }

    // 保存图片（对扩展名做白名单，session id 用 basename 兜底，避免路径遍历）
    const rawExt = path.extname(req.file.originalname).toLowerCase();
    const ext = [".jpg", ".jpeg", ".png", ".webp", ".bmp"].includes(rawExt) ? rawExt : ".jpg";
    const safeSessionId = path.basename(String(sessionId));
    const fileName = `${safeSessionId}_p${String(pageNum).padStart(2, "0")}_${side}${ext}`;
    const filePath = path.join(scannerUploadDir(), fileName);
    writeFileSync(filePath, req.file.buffer);

    // 更新记录
    if (token) {
      await db.run(
        `UPDATE twain_scan_records SET image_path = ?, page_num = ?, side = ?, ocr_status = 'uploaded'
         WHERE id = ? AND session_id = ?`,
        filePath, pageNum, side, token, sessionId
      );
    }

    res.json({ ok: true, pageNum, side, fileName });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// ── POST /api/scanner/sessions/:sessionId/complete ──────
router.post("/sessions/:sessionId/pages/:recordId/crops", dualAuth, upload.array("crops", 50), async (req: Request, res: Response) => {
  try {
    const sessionId = String(req.params.sessionId);
    const recordId = String(req.params.recordId);
    const db = await getMysqlDb();
    const record = await db.get<any>(
      "SELECT id, card_id, student_id FROM twain_scan_records WHERE id = ? AND session_id = ?",
      recordId,
      sessionId
    );
    if (!record) {
      res.status(404).json({ message: "扫描页不存在" });
      return;
    }

    const manifestRaw = typeof req.body?.manifest === "string" ? req.body.manifest : "[]";
    let manifest: Array<RecognitionBlockCrop & { fileName?: string }>;
    try {
      manifest = JSON.parse(manifestRaw) as Array<RecognitionBlockCrop & { fileName?: string }>;
      if (!Array.isArray(manifest)) throw new Error("manifest 必须是数组");
    } catch (err: any) {
      res.status(400).json({ message: `切块清单无效: ${err.message}` });
      return;
    }
    const files = Array.isArray(req.files) ? req.files as Express.Multer.File[] : [];
    for (const file of files) {
      if (!isValidImageBuffer(file.buffer)) {
        res.status(400).json({ message: `切块文件 ${file.originalname} 不是受支持的图片格式` });
        return;
      }
    }
    const tempDir = path.join(scannerUploadDir(), "crops-temp", sessionId, recordId);
    if (!existsSync(tempDir)) mkdirSync(tempDir, { recursive: true });

    const crops = manifest.map((crop, index) => {
      const file = crop.fileName
        ? files.find((item) => item.originalname === crop.fileName)
        : files[index];
      if (!file) return null;
      const targetPath = path.join(tempDir, `${index}_${path.basename(file.originalname || "crop.png")}`);
      writeFileSync(targetPath, file.buffer);
      return { ...crop, path: targetPath };
    }).filter((crop): crop is RecognitionBlockCrop => Boolean(crop));

    const saved = await persistAnswerBlockCrops({
      cardId: String(record.card_id),
      studentNumber: record.student_id ?? null,
      sourceType: "twain_scan_record",
      sourceRecordId: recordId,
      crops
    }, db);

    res.json({ ok: true, count: saved.length, crops: saved });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});
router.post("/sessions/:sessionId/complete", dualAuth, async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const db = await getMysqlDb();

    const session = await db.get<{ id: string; page_count: number }>(
      "SELECT id, page_count FROM twain_scan_sessions WHERE id = ?",
      sessionId
    );
    if (!session) {
      res.status(404).json({ message: "会话不存在" });
      return;
    }

    const uploaded = await db.get<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM twain_scan_records WHERE session_id = ? AND ocr_status = 'uploaded'",
      sessionId
    );
    const total = await db.get<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM twain_scan_records WHERE session_id = ?",
      sessionId
    );

    const uploadedCount = Number(uploaded?.cnt ?? 0);
    const totalCount = Number(total?.cnt ?? 0);

    // v1.6.0: 检查完整性 — 未全部上传完成时阻止标记 completed
    const complete = uploadedCount >= totalCount && totalCount > 0;
    const status = complete ? "completed" : "incomplete";

    await db.run(
      "UPDATE twain_scan_sessions SET status = ?, page_count = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      status, uploadedCount, sessionId
    );

    if (!complete) {
      res.status(400).json({
        ok: false,
        message: `上传未完成：${uploadedCount}/${totalCount} 页已上传，请补传缺失页面后再提交`,
        pagesUploaded: uploadedCount,
        pagesTotal: totalCount,
      });
      return;
    }

    res.json({
      ok: true,
      message: `扫描完成：${uploadedCount}/${totalCount} 页全部上传，等待服务端识别`,
      pagesUploaded: uploadedCount,
      pagesTotal: totalCount,
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
      sessionId
    );
    if (!session) {
      res.status(404).json({ message: "会话不存在" });
      return;
    }

    const records = await db.all<any>(
      `SELECT id, page_num, side, ocr_status, scan_quality FROM twain_scan_records WHERE session_id = ? ORDER BY page_num`,
      sessionId
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
