import { Router } from "express";
import multer from "multer";
import path from "node:path";
import { existsSync, unlinkSync } from "node:fs";
import { ensurePaperDir, paperDir, safeId } from "../storage";
import {
  validatePaperFile,
  storePaperFile,
} from "../paper-converter";
import { autoExtractPaperText, getFileMime } from "../paper-ocr";
import type { DbAdapter } from "../../../../server/db/mysql";
import { getMysqlDb } from "../../../../server/db/mysql";
import { KnowledgePointRepository } from "../../../../server/repositories/KnowledgePointRepository";
import type { Request, Response } from "express";
import { readFile } from "node:fs/promises";
import { llmClientUrl, llmClientHeaders } from "../llm-client";

const paperUpload = multer({
  dest: path.resolve(process.cwd(), "data", "answer-card", "papers", "_tmp"),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const err = validatePaperFile(file.originalname, 50 * 1024 * 1024);
    cb(err ? new Error(err) : null, true);
  },
});

export function paperRoutes(): Router {
  const router = Router();

  // POST /api/cards/:cardId/paper — 上传原卷
  router.post("/api/cards/:cardId/paper", paperUpload.single("file"), async (req: Request, res: Response) => {
    try {
      const { cardId } = req.params;
      const file = req.file;
      if (!file) {
        res.status(400).json({ error: "未选择文件" });
        return;
      }

      const error = validatePaperFile(file.originalname, file.size);
      if (error) {
        unlinkSync(file.path);
        res.status(400).json({ error });
        return;
      }

      await ensurePaperDir(cardId);
      const dir = paperDir(cardId);

      const { originalPath, pdfPath } = await storePaperFile(
        file.path,
        file.originalname,
        dir
      );

      // 清理 multer 临时文件
      try { unlinkSync(file.path); } catch {}

      // 更新 answer_cards 表
      const db = getMysqlDb();
      const relPath = path.relative(path.resolve(process.cwd(), "data", "answer-card"), originalPath);
      await db.run(
        "UPDATE answer_cards SET has_original_paper = 1, original_paper_filename = ?, original_paper_path = ?, updated_at = datetime('now') WHERE id = ?",
        file.originalname, relPath, cardId
      );

      res.json({
        success: true,
        filename: file.originalname,
        size: file.size,
        pdfAvailable: !!pdfPath,
      });
    } catch (err: any) {
      console.error("[paper] upload failed:", err);
      res.status(500).json({ error: err.message || "上传失败" });
    }
  });

  // GET /api/cards/:cardId/paper — 预览/下载原卷
  // ?info=type 返回 { mimeType, filename } JSON（前端判断渲染方式）
  router.get("/api/cards/:cardId/paper", async (req: Request, res: Response) => {
    try {
      const { cardId } = req.params;
      const dir = paperDir(cardId);

      // ?info=type — 只返回文件类型信息，不返回文件
      if (req.query.info === "type") {
        for (const ext of [".jpg", ".jpeg", ".png", ".bmp", ".webp"]) {
          const fp = path.join(dir, `original${ext}`);
          if (existsSync(fp)) { res.json({ mimeType: getFileMime(`original${ext}`), filename: `original${ext}` }); return; }
        }
        const pdfPath = path.join(dir, "original.pdf");
        if (existsSync(pdfPath)) { res.json({ mimeType: "application/pdf", filename: "original.pdf" }); return; }
        for (const ext of [".docx"]) {
          const fp = path.join(dir, `original${ext}`);
          if (existsSync(fp)) { res.json({ mimeType: getFileMime(`original${ext}`), filename: `original${ext}` }); return; }
        }
        res.status(404).json({ error: "原卷文件不存在" });
        return;
      }

      // ?format=image — 优先返回图片（用于 <img> 预览）
      if (req.query.format === "image") {
        for (const ext of [".jpg", ".jpeg", ".png", ".bmp", ".webp"]) {
          const fp = path.join(dir, `original${ext}`);
          if (existsSync(fp)) { res.sendFile(fp); return; }
        }
        // 无图片时回退到 PDF
        const pdfPath = path.join(dir, "original.pdf");
        if (existsSync(pdfPath)) { res.sendFile(pdfPath); return; }
        res.status(404).json({ error: "无可预览的图片格式" });
        return;
      }

      // 默认：优先返回 PDF（保持向后兼容）
      const pdfPath = path.join(dir, "original.pdf");
      if (existsSync(pdfPath)) {
        res.contentType("application/pdf");
        res.sendFile(pdfPath);
        return;
      }

      // 其次返回图片
      for (const ext of [".jpg", ".jpeg", ".png", ".bmp", ".webp"]) {
        const filePath = path.join(dir, `original${ext}`);
        if (existsSync(filePath)) { res.sendFile(filePath); return; }
      }

      // DOCX
      for (const ext of [".docx"]) {
        const filePath = path.join(dir, `original${ext}`);
        if (existsSync(filePath)) { res.sendFile(filePath); return; }
      }

      res.status(404).json({ error: "原卷文件不存在" });
    } catch (err: any) {
      console.error("[paper] download failed:", err);
      res.status(500).json({ error: err.message || "下载失败" });
    }
  });

  // DELETE /api/cards/:cardId/paper — 删除原卷
  router.delete("/api/cards/:cardId/paper", async (req: Request, res: Response) => {
    try {
      const { cardId } = req.params;
      const dir = paperDir(cardId);

      // 删除文件
      for (const ext of [".docx", ".pdf", ".jpg", ".jpeg", ".png", ".bmp", ".tiff", ".webp"]) {
        const filePath = path.join(dir, `original${ext}`);
        if (existsSync(filePath)) {
          try { unlinkSync(filePath); } catch {}
        }
      }

      // 更新数据库标记
      const db = getMysqlDb();
      await db.run(
        "UPDATE answer_cards SET has_original_paper = 0, original_paper_filename = NULL, original_paper_path = NULL, updated_at = datetime('now') WHERE id = ?",
        cardId
      );

      res.json({ success: true });
    } catch (err: any) {
      console.error("[paper] delete failed:", err);
      res.status(500).json({ error: err.message || "删除失败" });
    }
  });

  // GET /api/cards/:cardId/paper/info — 获取原卷状态（支持 DB+文件双检查）
  router.get("/api/cards/:cardId/paper/info", async (req: Request, res: Response) => {
    try {
      const { cardId } = req.params;
      const dir = paperDir(cardId);

      // 检查文件实际是否存在（兼容 DB 未同步/旧数据）
      let fileOnDisk: { filename: string; mimeType?: string } | null = null;
      for (const ext of [".jpg", ".jpeg", ".png", ".bmp", ".webp"]) {
        const fp = path.join(dir, `original${ext}`);
        if (existsSync(fp)) { fileOnDisk = { filename: `original${ext}`, mimeType: getFileMime(`original${ext}`) }; break; }
      }
      if (!fileOnDisk) {
        const pdfPath = path.join(dir, "original.pdf");
        if (existsSync(pdfPath)) { fileOnDisk = { filename: "original.pdf", mimeType: "application/pdf" }; }
      }
      if (!fileOnDisk) {
        for (const ext of [".docx"]) {
          const fp = path.join(dir, `original${ext}`);
          if (existsSync(fp)) { fileOnDisk = { filename: `original${ext}`, mimeType: getFileMime(`original${ext}`) }; break; }
        }
      }

      const db = getMysqlDb();
      const row = await db.get(
        "SELECT has_original_paper, original_paper_filename, question_range, extra_notes FROM answer_cards WHERE id = ?",
        cardId
      );
      if (!row) { res.status(404).json({ error: "答题卡不存在" }); return; }

      const dbHas = !!(row as any).has_original_paper;
      const filenameOnDisk = fileOnDisk?.filename || (row as any).original_paper_filename;

      // 如果 DB 未标记但文件存在，自动修复 DB
      if (!dbHas && fileOnDisk) {
        await db.run(
          "UPDATE answer_cards SET has_original_paper = 1, original_paper_filename = ?, original_paper_path = ? WHERE id = ?",
          fileOnDisk.filename, `papers/${safeId(cardId)}/${fileOnDisk.filename}`, cardId
        );
      }

      res.json({
        has_original_paper: dbHas || !!fileOnDisk,
        filename: filenameOnDisk,
        mime_type: fileOnDisk?.mimeType,
        question_range: (row as any).question_range,
        extra_notes: (row as any).extra_notes,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "获取失败" });
    }
  });

  // PUT /api/cards/:cardId/paper/info — 保存题目范围 + 特别描述
  router.put("/api/cards/:cardId/paper/info", async (req: Request, res: Response) => {
    try {
      const { cardId } = req.params;
      const { questionRange, extraNotes } = req.body as {
        questionRange?: string;
        extraNotes?: string;
      };

      if (!questionRange || !questionRange.trim()) {
        res.status(400).json({ error: "题目范围不能为空" });
        return;
      }

      const db = getMysqlDb();
      await db.run(
        "UPDATE answer_cards SET question_range = ?, extra_notes = ?, updated_at = datetime('now') WHERE id = ?",
        questionRange.trim(), extraNotes?.trim() || null, cardId
      );

      res.json({ success: true });
    } catch (err: any) {
      console.error("[paper] info update failed:", err);
      res.status(500).json({ error: err.message || "保存失败" });
    }
  });

  // POST /api/cards/:cardId/knowledge-points/analyze — AI 分析
  router.post("/api/cards/:cardId/knowledge-points/analyze", async (req: Request, res: Response) => {
    try {
      const { cardId } = req.params;
      const { questionRange, extraNotes } = req.body as {
        questionRange?: string;
        extraNotes?: string;
      };

      // 1. 获取系统 AI 配置
      const db = getMysqlDb();
      const sysProvider = await db.get(
        "SELECT * FROM ai_providers WHERE is_system = 1 AND is_active = 1 ORDER BY sort_order LIMIT 1"
      );

      if (!sysProvider) {
        res.status(400).json({ error: "SYSTEM_AI_NOT_CONFIGURED", message: "管理员尚未配置系统 AI 服务，请联系管理员" });
        return;
      }

      // 2. 判断提供商类型 → 选择分析模式
      const range = questionRange || "全部";
      const notes = extraNotes || "";
      const isMultimodal = sysProvider.provider_type === "gemini" || sysProvider.provider_type === "openai";

      // 3. 获取答题卡科目
      const cardRow = await db.get("SELECT subject_label FROM answer_cards WHERE id = ?", cardId);
      const subject = cardRow?.subject_label || "";

      // 4. 构建对 llmclient 的请求
      let knowledgePoints: any[] = [];
      let mode = "text";

      if (isMultimodal) {
        // 多模态：读取文件 → base64 → 直传
        mode = "direct";
        const files = await getPaperFiles(cardId);
        if (files.length === 0) {
          res.status(400).json({ error: "NO_FILES", message: "未找到原卷文件" });
          return;
        }

        const resp = await fetch(llmClientUrl("/analysis/knowledge-points"), {
          method: "POST",
          headers: { ...llmClientHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({
            mode, providerId: sysProvider.id, subject, questionRange: range, extraNotes: notes, files,
          }),
          signal: AbortSignal.timeout(60000),
        });

        const data = await resp.json();
        knowledgePoints = data.knowledgePoints || [];
      } else {
        // 纯文本提供商：读配置 → 自动/OCR增强
        const textModeRow = await db.get(
          "SELECT value FROM system_settings WHERE key = ?",
          "ai_knowledge_points_text_mode"
        );
        const textMode = textModeRow?.value || "auto";

        if (textMode === "ocr") {
          // OCR 增强
          mode = "ocr";
          const ocrRow = await db.get(
            "SELECT value FROM system_settings WHERE key = ?",
            "ai_knowledge_points_ocr_provider_id"
          );
          const ocrProviderId = ocrRow?.value;
          if (!ocrProviderId) {
            res.status(400).json({ error: "OCR_NOT_CONFIGURED", message: "管理员未配置 OCR 视觉模型" });
            return;
          }

          const files = await getPaperFiles(cardId);
          const resp = await fetch(llmClientUrl("/analysis/knowledge-points"), {
            method: "POST",
            headers: { ...llmClientHeaders(), "Content-Type": "application/json" },
            body: JSON.stringify({
              mode, providerId: sysProvider.id, ocrProviderId: Number(ocrProviderId),
              subject, questionRange: range, extraNotes: notes, files,
            }),
            signal: AbortSignal.timeout(120000),
          });

          const data = await resp.json();
          knowledgePoints = data.knowledgePoints || [];
        } else {
          // 自动模式
          mode = "auto";
          const extracted = await autoExtractPaperText(cardId);
          if (!extracted.text || extracted.text.length < 10) {
            res.status(400).json({
              error: "TEXT_EXTRACTION_FAILED",
              message: "无法从原卷提取文字。扫描件 PDF/图片可尝试 OCR 增强模式"
            });
            return;
          }

          const resp = await fetch(llmClientUrl("/analysis/knowledge-points"), {
            method: "POST",
            headers: { ...llmClientHeaders(), "Content-Type": "application/json" },
            body: JSON.stringify({
              mode: "text", providerId: sysProvider.id, subject,
              questionRange: range, extraNotes: notes, paperText: extracted.text,
            }),
            signal: AbortSignal.timeout(60000),
          });

          const data = await resp.json();
          knowledgePoints = data.knowledgePoints || [];
        }
      }

      res.json({ mode, knowledgePoints });
    } catch (err: any) {
      console.error("[knowledge-points] analyze failed:", err);
      res.status(500).json({ error: err.message || "分析失败" });
    }
  });

  // GET /api/cards/:cardId/knowledge-points — 获取已保存知识点
  router.get("/api/cards/:cardId/knowledge-points", async (req: Request, res: Response) => {
    try {
      const { cardId } = req.params;
      const repo = new KnowledgePointRepository();
      const points = await repo.findByCardIdGrouped(cardId);
      res.json({ points });
    } catch (err: any) {
      console.error("[knowledge-points] get failed:", err);
      res.status(500).json({ error: err.message || "获取失败" });
    }
  });

  // PUT /api/cards/:cardId/knowledge-points — 保存教师编辑后的知识点
  router.put("/api/cards/:cardId/knowledge-points", async (req: Request, res: Response) => {
    try {
      const { cardId } = req.params;
      const { points } = req.body as {
        points: Array<{ question_number: number; point_text: string; category?: string }>;
      };

      if (!Array.isArray(points)) {
        res.status(400).json({ error: "points 必须为数组" });
        return;
      }

      const repo = new KnowledgePointRepository();
      await repo.replaceAll(cardId, points);

      // 更新纯文本备份
      const textBackup = points
        .map((p) => `${p.question_number}. ${p.point_text}`)
        .join("\n");
      const db = getMysqlDb();
      await db.run(
        "UPDATE answer_cards SET knowledge_points_text = ?, updated_at = datetime('now') WHERE id = ?",
        textBackup, cardId
      );

      res.json({ success: true, count: points.length });
    } catch (err: any) {
      console.error("[knowledge-points] save failed:", err);
      res.status(500).json({ error: err.message || "保存失败" });
    }
  });

  return router;
}

/**
 * 读取原卷文件并转为 base64 数组（用于多模态/OCR增强模式）
 */
async function getPaperFiles(cardId: string): Promise<Array<{ mimeType: string; base64: string }>> {
  const dir = paperDir(cardId);
  const files: Array<{ mimeType: string; base64: string }> = [];

  // 优先查找图片文件
  for (const ext of [".jpg", ".jpeg", ".png", ".bmp", ".tiff", ".webp"]) {
    const fp = path.join(dir, `original${ext}`);
    if (existsSync(fp)) {
      const buf = await readFile(fp);
      files.push({ mimeType: getFileMime(`original${ext}`), base64: buf.toString("base64") });
      return files;
    }
  }

  // PDF 文件
  const pdfPath = path.join(dir, "original.pdf");
  if (existsSync(pdfPath)) {
    const buf = await readFile(pdfPath);
    files.push({ mimeType: "application/pdf", base64: buf.toString("base64") });
    return files;
  }

  return files;
}
