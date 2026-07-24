import { Router } from "express";
import multer from "multer";
import path from "node:path";
import { existsSync, unlinkSync } from "node:fs";
import { ensurePaperDir, paperDir, safeId } from "../storage";
import {
  validatePaperFile,
  storePaperFile,
  storePaperPageFile,
} from "../paper-converter";
import { autoExtractPaperText, getFileMime } from "../paper-ocr";
import type { DbAdapter } from "../../../../server/db/mysql";
import { getMysqlDb } from "../../../../server/db/mysql";
import { KnowledgePointRepository } from "../../../../server/repositories/KnowledgePointRepository";
import type { Request, Response } from "express";
import { readFile, readdir } from "node:fs/promises";
import { llmClientUrl, llmClientHeaders } from "../llm-client";

type AiProviderRow = {
  id: number;
  user_id?: number;
  name: string;
  provider_type: string;
  base_url: string;
  api_key: string;
  models: string | null;
  is_active: number;
  sort_order: number;
  is_system?: number;
};

const paperUpload = multer({
  dest: path.resolve(process.cwd(), "data", "answer-card", "papers", "_tmp"),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const err = validatePaperFile(file.originalname, 50 * 1024 * 1024);
    if (err) {
      cb(new Error(err));
    } else {
      cb(null, true);
    }
  },
});

function firstConfiguredModel(models: string | null | undefined): string | undefined {
  if (!models) return undefined;
  try {
    const parsed = JSON.parse(models);
    if (Array.isArray(parsed)) {
      const first = parsed[0];
      if (typeof first === "string") return first;
      if (first && typeof first === "object" && typeof first.id === "string") return first.id;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function getKnowledgePointProvider(db: ReturnType<typeof getMysqlDb>, userId?: number): Promise<{
  providerId: number;
  providerType: string;
  model?: string;
  providerOverride?: Record<string, string>;
} | null> {
  const systemProvider = await db.get<AiProviderRow>(
    "SELECT * FROM ai_providers WHERE is_system = 1 AND is_active = 1 ORDER BY sort_order, id LIMIT 1"
  );
  const provider = systemProvider ?? (userId
    ? await db.get<AiProviderRow>(
      "SELECT * FROM ai_providers WHERE user_id = ? AND is_active = 1 ORDER BY sort_order, id LIMIT 1",
      userId
    )
    : null);

  if (provider) {
    return {
      providerId: provider.id,
      providerType: provider.provider_type,
      model: firstConfiguredModel(provider.models),
      providerOverride: {
        provider_type: provider.provider_type,
        base_url: provider.base_url || "",
        api_key: provider.api_key,
      },
    };
  }

  const response = await fetch(llmClientUrl("/health"), {
    method: "GET",
    headers: llmClientHeaders(),
    signal: AbortSignal.timeout(2500),
  });
  if (!response.ok) return null;
  const status = await response.json() as {
    defaultModel?: string;
    models?: Array<{ id: string; provider: string; available: boolean }>;
  };
  const model = status.models?.find((item) => item.id === status.defaultModel)
    ?? status.models?.find((item) => item.available);
  if (!model?.available) return null;
  return {
    providerId: 0,
    providerType: model.provider,
    model: model.id,
  };
}

async function readKnowledgePointResponse(resp: globalThis.Response): Promise<any[]> {
  const data = await resp.json().catch(() => ({} as any));
  if (!resp.ok) {
    const detail = data?.detail || data?.message || data?.error || `LLM 服务返回 ${resp.status}`;
    throw new Error(String(detail));
  }
  return data.knowledgePoints || [];
}

export function paperRoutes(): Router {
  const router = Router();

  // POST /api/cards/:cardId/paper — 上传原卷（支持多页）
  router.post("/api/cards/:cardId/paper", paperUpload.array("files", 40), async (req: Request, res: Response) => {
    try {
      const cardId = String(req.params.cardId);
      const files = ((req.files as Express.Multer.File[]) || []).filter(Boolean);
      if (files.length === 0) {
        res.status(400).json({ error: "未选择文件" });
        return;
      }

      const db = getMysqlDb();
      const maxRow = await db.get(
        "SELECT COALESCE(MAX(page_index), 0) AS mx FROM original_paper_pages WHERE card_id = ?",
        cardId
      ) as { mx: number } | undefined;
      let nextIndex = (maxRow?.mx ?? 0) + 1;

      await ensurePaperDir(cardId);
      const dir = paperDir(cardId);

      const uploaded: Array<{ pageIndex: number; filename: string }> = [];
      let firstFilename = "";
      let firstRelPath = "";

      for (const file of files) {
        const error = validatePaperFile(file.originalname, file.size);
        if (error) {
          try { unlinkSync(file.path); } catch {}
          continue;
        }
        const pageIndex = nextIndex;
        nextIndex += 1;
        const { diskFilename, relPath } = await storePaperPageFile(file.path, file.originalname, dir, pageIndex);
        try { unlinkSync(file.path); } catch {}

        await db.run(
          "INSERT INTO original_paper_pages (card_id, page_index, filename, stored_path) VALUES (?, ?, ?, ?)",
          cardId, pageIndex, diskFilename, relPath
        );
        if (pageIndex === 1) {
          firstFilename = diskFilename;
          firstRelPath = relPath;
        }
        uploaded.push({ pageIndex, filename: diskFilename });
      }

      if (uploaded.length === 0) {
        res.status(400).json({ error: "文件校验失败，未上传任何页" });
        return;
      }

      // legacy 字段保留首页，向后兼容预览/导出/AI 读取
      const firstRow = firstFilename
        ? { filename: firstFilename, stored_path: firstRelPath }
        : await db.get(
            "SELECT filename, stored_path FROM original_paper_pages WHERE card_id = ? ORDER BY page_index LIMIT 1",
            cardId
          ) as { filename: string; stored_path: string } | undefined;
      const firstFilenameOut = firstRow?.filename || "";
      const firstRelPathOut = firstFilename ? firstRelPath : (firstRow?.stored_path || "");
      await db.run(
        "UPDATE answer_cards SET has_original_paper = 1, original_paper_filename = ?, original_paper_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        firstFilenameOut, firstRelPathOut, cardId
      );

      res.json({ success: true, pages: uploaded, count: uploaded.length });
    } catch (err: any) {
      console.error("[paper] upload failed:", err);
      res.status(500).json({ error: err.message || "上传失败" });
    }
  });

  // GET /api/cards/:cardId/paper — 预览/下载原卷（支持 ?page=N 指定页码）
  // ?info=type 返回 { mimeType, filename, page } JSON（前端判断渲染方式）
  router.get("/api/cards/:cardId/paper", async (req: Request, res: Response) => {
    try {
      const cardId = String(req.params.cardId);
      const dir = paperDir(cardId);
      const page = Number(req.query.page) || 1;
      const baseName = page === 1 ? "original" : `original-${page}`;

      // ?info=type — 只返回文件类型信息，不返回文件
      if (req.query.info === "type") {
        for (const ext of [".jpg", ".jpeg", ".png", ".bmp", ".webp"]) {
          const fp = path.join(dir, `${baseName}${ext}`);
          if (existsSync(fp)) { res.json({ mimeType: getFileMime(`${baseName}${ext}`), filename: `${baseName}${ext}`, page }); return; }
        }
        const pdfPath = path.join(dir, `${baseName}.pdf`);
        if (existsSync(pdfPath)) { res.json({ mimeType: "application/pdf", filename: `${baseName}.pdf`, page }); return; }
        for (const ext of [".docx"]) {
          const fp = path.join(dir, `${baseName}${ext}`);
          if (existsSync(fp)) { res.json({ mimeType: getFileMime(`${baseName}${ext}`), filename: `${baseName}${ext}`, page }); return; }
        }
        res.status(404).json({ error: "原卷文件不存在" });
        return;
      }

      // ?format=image — 优先返回图片（用于 <img> 预览）
      if (req.query.format === "image") {
        for (const ext of [".jpg", ".jpeg", ".png", ".bmp", ".webp"]) {
          const fp = path.join(dir, `${baseName}${ext}`);
          if (existsSync(fp)) { res.sendFile(fp); return; }
        }
        const pdfPath = path.join(dir, `${baseName}.pdf`);
        if (existsSync(pdfPath)) { res.sendFile(pdfPath); return; }
        res.status(404).json({ error: "无可预览的图片格式" });
        return;
      }

      // 默认：优先返回 PDF（保持向后兼容）
      const pdfPath = path.join(dir, `${baseName}.pdf`);
      if (existsSync(pdfPath)) {
        res.contentType("application/pdf");
        res.sendFile(pdfPath);
        return;
      }

      // 其次返回图片
      for (const ext of [".jpg", ".jpeg", ".png", ".bmp", ".webp"]) {
        const filePath = path.join(dir, `${baseName}${ext}`);
        if (existsSync(filePath)) { res.sendFile(filePath); return; }
      }

      // DOCX
      for (const ext of [".docx"]) {
        const filePath = path.join(dir, `${baseName}${ext}`);
        if (existsSync(filePath)) { res.sendFile(filePath); return; }
      }

      res.status(404).json({ error: "原卷文件不存在" });
    } catch (err: any) {
      console.error("[paper] download failed:", err);
      res.status(500).json({ error: err.message || "下载失败" });
    }
  });

  // DELETE /api/cards/:cardId/paper — 删除原卷（全部页）
  router.delete("/api/cards/:cardId/paper", async (req: Request, res: Response) => {
    try {
      const cardId = String(req.params.cardId);
      const dir = paperDir(cardId);

      // 删除 papers/<cardId> 目录下所有 original* 文件（含多页 original-N.*）
      let entries: string[] = [];
      try { entries = await readdir(dir); } catch {}
      for (const e of entries) {
        if (/^original(-\d+)?\.(jpg|jpeg|png|bmp|tiff|webp|pdf|docx)$/i.test(e)) {
          try { unlinkSync(path.join(dir, e)); } catch {}
        }
      }

      // 更新数据库标记
      const db = getMysqlDb();
      await db.run("DELETE FROM original_paper_pages WHERE card_id = ?", cardId);
      await db.run(
        "UPDATE answer_cards SET has_original_paper = 0, original_paper_filename = NULL, original_paper_path = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        cardId
      );

      res.json({ success: true });
    } catch (err: any) {
      console.error("[paper] delete failed:", err);
      res.status(500).json({ error: err.message || "删除失败" });
    }
  });

  // DELETE /api/cards/:cardId/paper/page/:pageIndex — 删除单页
  router.delete("/api/cards/:cardId/paper/page/:pageIndex", async (req: Request, res: Response) => {
    try {
      const cardId = String(req.params.cardId);
      const pageIndex = Number(req.params.pageIndex);
      const dir = paperDir(cardId);
      const db = getMysqlDb();
      const row = await db.get(
        "SELECT filename FROM original_paper_pages WHERE card_id = ? AND page_index = ?",
        cardId, pageIndex
      ) as { filename: string } | undefined;
      if (row) {
        const baseName = pageIndex === 1 ? "original" : `original-${pageIndex}`;
        for (const ext of [".docx", ".pdf", ".jpg", ".jpeg", ".png", ".bmp", ".tiff", ".webp"]) {
          const fp = path.join(dir, `${baseName}${ext}`);
          if (existsSync(fp)) { try { unlinkSync(fp); } catch {} }
        }
        await db.run("DELETE FROM original_paper_pages WHERE card_id = ? AND page_index = ?", cardId, pageIndex);
      }
      const remaining = await db.get("SELECT COUNT(*) AS c FROM original_paper_pages WHERE card_id = ?", cardId) as { c: number };
      if (remaining.c === 0) {
        await db.run(
          "UPDATE answer_cards SET has_original_paper = 0, original_paper_filename = NULL, original_paper_path = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          cardId
        );
      }
      res.json({ success: true });
    } catch (err: any) {
      console.error("[paper] delete page failed:", err);
      res.status(500).json({ error: err.message || "删除失败" });
    }
  });

  // GET /api/cards/:cardId/paper/info — 获取原卷状态（支持 DB+文件双检查）
  router.get("/api/cards/:cardId/paper/info", async (req: Request, res: Response) => {
    try {
      const cardId = String(req.params.cardId);
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

      const pages = await db.all(
        "SELECT page_index AS pageIndex, filename FROM original_paper_pages WHERE card_id = ? ORDER BY page_index",
        cardId
      ) as Array<{ pageIndex: number; filename: string }>;

      const dbHas = !!(row as any).has_original_paper || pages.length > 0;
      const filenameOnDisk = fileOnDisk?.filename || (row as any).original_paper_filename || pages[0]?.filename;

      // 如果 DB 未标记但文件或分页数据存在，自动修复 DB
      if (!dbHas && (fileOnDisk || pages.length > 0)) {
        const fixFilename = filenameOnDisk || pages[0]?.filename || null;
        const fixPath = pages[0]
          ? `papers/${safeId(cardId)}/${pages[0].filename}`
          : (fileOnDisk ? `papers/${safeId(cardId)}/${fileOnDisk.filename}` : null);
        await db.run(
          "UPDATE answer_cards SET has_original_paper = 1, original_paper_filename = ?, original_paper_path = ? WHERE id = ?",
          fixFilename, fixPath, cardId
        );
      }

      res.json({
        has_original_paper: dbHas || !!fileOnDisk,
        filename: filenameOnDisk,
        mime_type: fileOnDisk?.mimeType,
        question_range: (row as any).question_range,
        extra_notes: (row as any).extra_notes,
        pages,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "获取失败" });
    }
  });

  // PUT /api/cards/:cardId/paper/info — 保存题目范围 + 特别描述
  router.put("/api/cards/:cardId/paper/info", async (req: Request, res: Response) => {
    try {
      const cardId = String(req.params.cardId);
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
        "UPDATE answer_cards SET question_range = ?, extra_notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
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
      const cardId = String(req.params.cardId);
      const { questionRange, extraNotes } = req.body as {
        questionRange?: string;
        extraNotes?: string;
      };

      // 1. 获取系统 AI 配置
      const db = getMysqlDb();
      const provider = await getKnowledgePointProvider(db, req.user?.id);

      if (!provider) {
        res.status(400).json({ error: "AI_NOT_CONFIGURED", message: "未配置可用 AI 服务。请配置系统/个人 AI 服务商，或在 llmclient.env 中填写可用模型 Key" });
        return;
      }

      // 2. 判断提供商类型 → 选择分析模式
      const range = questionRange || "全部";
      const notes = extraNotes || "";
      const isMultimodal = provider.providerType === "gemini" || provider.providerType === "openai";

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
            mode, providerId: provider.providerId, model: provider.model, providerOverride: provider.providerOverride,
            subject, questionRange: range, extraNotes: notes, files,
          }),
          signal: AbortSignal.timeout(60000),
        });

        knowledgePoints = await readKnowledgePointResponse(resp);
      } else {
        // 纯文本提供商：读配置 → 自动/OCR增强
        const textModeRow = await db.get(
          "SELECT value FROM system_settings WHERE `key` = ?",
          "ai_knowledge_points_text_mode"
        );
        const textMode = textModeRow?.value || "auto";

        if (textMode === "ocr") {
          // OCR 增强
          mode = "ocr";
          const ocrRow = await db.get(
            "SELECT value FROM system_settings WHERE `key` = ?",
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
              mode, providerId: provider.providerId, model: provider.model, providerOverride: provider.providerOverride,
              ocrProviderId: Number(ocrProviderId),
              subject, questionRange: range, extraNotes: notes, files,
            }),
            signal: AbortSignal.timeout(120000),
          });

          knowledgePoints = await readKnowledgePointResponse(resp);
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
              mode: "text", providerId: provider.providerId, model: provider.model, providerOverride: provider.providerOverride,
              subject,
              questionRange: range, extraNotes: notes, paperText: extracted.text,
            }),
            signal: AbortSignal.timeout(60000),
          });

          knowledgePoints = await readKnowledgePointResponse(resp);
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
      const cardId = String(req.params.cardId);
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
      const cardId = String(req.params.cardId);
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
        "UPDATE answer_cards SET knowledge_points_text = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
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
  let entries: string[] = [];
  try { entries = await readdir(dir); } catch { return files; }

  const imgRe = /^original(-\d+)?\.(jpg|jpeg|png|bmp|tiff|webp)$/i;
  const pdfRe = /^original(-\d+)?\.pdf$/i;

  // 所有页的图片（按页码排序）
  const imgEntries = entries.filter((e) => imgRe.test(e)).sort();
  for (const e of imgEntries) {
    const fp = path.join(dir, e);
    const buf = await readFile(fp);
    files.push({ mimeType: getFileMime(e), base64: buf.toString("base64") });
  }
  if (files.length) return files;

  // 回退：所有页的 PDF
  const pdfEntries = entries.filter((e) => pdfRe.test(e)).sort();
  for (const e of pdfEntries) {
    const fp = path.join(dir, e);
    const buf = await readFile(fp);
    files.push({ mimeType: "application/pdf", base64: buf.toString("base64") });
  }
  return files;
}
