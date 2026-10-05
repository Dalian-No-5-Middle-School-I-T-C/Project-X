import { Router } from "express";
import multer from "multer";
import path from "node:path";
import { existsSync, unlinkSync } from "node:fs";
import { ensurePaperDir, paperDir, paperTmpDir, safeId } from "../storage";
import {
  validatePaperFile,
  storePaperPageFile,
  discardStoredPaths,
} from "../paper-converter";
import {
  MAX_PAPER_BYTES_PER_CARD,
  MAX_PAPER_BYTES_TOTAL,
  MAX_PAPER_FILE_BYTES,
  MAX_PAPER_FILES_PER_REQUEST,
  MAX_PAPER_PAGES_PER_CARD,
  MAX_PAPER_REQUEST_BYTES,
} from "../../../../shared/paperStorageLimits";
import {
  assertWrittenPaperWithinQuota,
  evaluatePaperQuota,
  invalidatePaperUsageCache,
  PaperQuotaRollbackError,
  purgeStaleTmpUploads,
  readPaperQuota,
} from "../paperQuota";
import { requestUploadBudget } from "../../../../server/lib/uploadBudget";
import { autoExtractPaperText, getFileMime, getPaperInputKind } from "../paper-ocr";
import { PaperInputError } from "../paper-docx";
import type { DbAdapter } from "../../../../server/db/mysql";
import { getMysqlDb } from "../../../../server/db/mysql";
import { CardRepository } from "../../../../server/repositories/CardRepository";
import { KnowledgePointRepository } from "../../../../server/repositories/KnowledgePointRepository";
import type { Request, Response } from "express";
import { readFile, readdir } from "node:fs/promises";
import { llmClientUrl, llmClientHeaders, fetchLlmClient } from "../llm-client";
import { finalizeAiRun } from "../../../../server/services/aiTelemetry";
// 安全（R11）：AI 计费与并发配额（占位与判定原子完成）；安全（R25）：对外错误摘要脱敏
import { AiQuotaError, reserveAiCall } from "../../../../server/services/aiQuota";
import { sanitizeOpsMessage } from "../../../../server/lib/opsErrorMessage";
import { decryptField } from "../../../../server/lib/field-crypto";
import { isVisionProvider, resolveKnowledgePointMode } from "../llm-capabilities";
import { buildObjectiveContext } from "../objective-context";

function decodeMultipartFilename(name: string): string {
  try {
    const decoded = Buffer.from(name, "latin1").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("latin1") === name) return decoded;
    return name;
  } catch { return name; }
}

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

/** multer 的暂存目录在 storage 里定义：容量扫描要把这棵子树整棵排除，两边必须指向同一个路径。 */
const paperUpload = multer({
  dest: paperTmpDir,
  // 安全 R10：单文件与单次文件数都走「默认 + 环境变量 + 天花板」三档，不再是硬编码 50MB/40 个
  limits: { fileSize: MAX_PAPER_FILE_BYTES, files: MAX_PAPER_FILES_PER_REQUEST },
  fileFilter: (_req, file, cb) => {
    const name = decodeMultipartFilename(file.originalname);
    const err = validatePaperFile(name, MAX_PAPER_FILE_BYTES);
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
        // api_key 已加密存储（F-7），透传前解密
        api_key: decryptField(provider.api_key) ?? "",
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
  //
  // 安全 R10：除了单文件体积，还要看「这张卡已有多少」「整个 papers/ 还剩多少额度」；
  // 安全 R14：任何失败路径（校验、转换、入库、请求中断）都不留无人引用的文件。
  router.post(
    "/api/cards/:cardId/paper",
    requestUploadBudget({ maxTotalBytes: MAX_PAPER_REQUEST_BYTES, label: "原卷上传" }),
    (req: Request, res: Response, next) => {
      paperUpload.array("files", MAX_PAPER_FILES_PER_REQUEST)(req, res, (err) => {
        if (err) {
          // 安全（R14）：multer 因体积/数量越界而报错时，已经落盘的兄弟文件不会经过
          // 下面那个带 `finally` 的处理函数——这里必须自己清掉，否则每次越界尝试都在
          // `_tmp` 里留下一份无人引用的副本（越界重试本身就是免费的磁盘填满攻击）。
          const partial = (req.files as Express.Multer.File[] | undefined) ?? (req.file ? [req.file] : []);
          void discardStoredPaths(partial.map((f) => f.path));
          res.status(400).json({ error: err.message || "原卷上传失败" });
          return;
        }
        next();
      });
    },
    async (req: Request, res: Response) => {
      const staged = ((req.files as Express.Multer.File[]) || []).filter(Boolean);
      // 本次已落盘但尚未被 DB 行引用的文件；提交成功后清空，失败时逐个删除（安全 R14）
      const storedPaths: string[] = [];
      try {
        const cardId = String(req.params.cardId);
        if (staged.length === 0) {
          res.status(400).json({ error: "未选择文件" });
          return;
        }

        // 上一次进程留下的滞留临时件（请求被中断、multer 越界拒绝都不会进到这个路由）：
        // 顺手扫一遍，只删超过存活期的普通文件，不阻塞本次上传。
        purgeStaleTmpUploads(paperTmpDir)
          .then((removed) => { if (removed > 0) console.log(`[paper] 清理滞留临时上传件 ${removed} 个`); })
          .catch(() => {});

        await ensurePaperDir(cardId);
        const dir = paperDir(cardId);
        const db = getMysqlDb();

        // 先校验全部文件，收集通过/失败列表（不静默跳过）
        const validFiles: Array<{ file: Express.Multer.File; originalname: string }> = [];
        const failed: Array<{ filename: string; error: string }> = [];
        for (const file of staged) {
          const name = decodeMultipartFilename(file.originalname);
          const errMsg = validatePaperFile(name, file.size);
          if (errMsg) {
            failed.push({ filename: name, error: errMsg });
          } else {
            validFiles.push({ file, originalname: name });
          }
        }

        if (validFiles.length === 0) {
          res.status(400).json({
            error: "文件校验失败，未上传任何页",
            failed,
          });
          return;
        }

        // ── 累计容量闸门（安全 R10）：admission 只能按上传件字节数**估算**，真实产物在下述
        //    落盘后用 assertWrittenPaperWithinQuota 复测——原卷转换会变大（jpg + 配对 PDF）。
        const incomingBytes = validFiles.reduce((sum, item) => sum + Math.max(0, item.file.size), 0);
        const usageBefore = await readPaperQuota(db, cardId);
        const quota = evaluatePaperQuota(usageBefore, { pages: validFiles.length, bytes: incomingBytes });
        if (!quota.ok) {
          res.status(413).json({
            code: "PAPER_QUOTA_EXCEEDED",
            reason: quota.reason,
            error: quota.message,
            limits: { pagesPerCard: MAX_PAPER_PAGES_PER_CARD, bytesPerCard: MAX_PAPER_BYTES_PER_CARD, bytesTotal: MAX_PAPER_BYTES_TOTAL },
          });
          return;
        }

        // 事务内完成 page_index 分配与入库，避免并发竞争

        const uploaded: Array<{ pageIndex: number; filename: string }> = [];
        let firstFilename = "";
        let firstRelPath = "";


        await db.transaction(async (tx) => {
          const maxRow = await tx.get(
            "SELECT COALESCE(MAX(page_index), 0) AS mx FROM original_paper_pages WHERE card_id = ?",
            cardId
          ) as { mx: number } | undefined;
          let nextIndex = (maxRow?.mx ?? 0) + 1;

          let writtenPages = 0;
          let writtenBytes = 0;
          for (const { file, originalname } of validFiles) {
            const pageIndex = nextIndex;
            nextIndex += 1;

            const stored = await storePaperPageFile(file.path, originalname, dir, pageIndex);
            // 先登记再入库：这一页此刻还没有任何 DB 行引用，失败时必须由本路由删掉（安全 R14）
            storedPaths.push(...stored.writtenPaths);
            writtenPages += 1;
            writtenBytes += stored.bytes;

            // UNIQUE(card_id, page_index) 约束保证不会重复写入
            await tx.run(
              "INSERT INTO original_paper_pages (card_id, page_index, filename, stored_path) VALUES (?, ?, ?, ?)",
              cardId, pageIndex, stored.diskFilename, stored.relPath
            );
            if (pageIndex === 1) {
              firstFilename = stored.diskFilename;
              firstRelPath = stored.relPath;
            }
            uploaded.push({ pageIndex, filename: stored.diskFilename });
          }
          // 提交前用**实际落盘体积**复测容量（PR #312 CR14）：上面的 admission 只能按输入字节估，
          // 而原卷转换会变大（jpg + 配对 PDF）。越界就在这里抛错——事务回滚掉这批页行，
          // 已写出的文件由下面的 catch 逐个删除，不会留下「按输入算合格、按产物算超限」的占盘。
          await assertWrittenPaperWithinQuota(tx, cardId, usageBefore, { pages: writtenPages, bytes: writtenBytes });
        });
        // 事务已提交：这些文件正式被 DB 行引用，回滚窗口到此结束
        storedPaths.length = 0;


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


        res.json({
          success: true,
          pages: uploaded,
          count: uploaded.length,
          ...(failed.length > 0 ? { failed } : {}),
        });

      } catch (err: any) {
        // 事务未提交就失败：本轮落地的文件没有任何 DB 行引用，全部删掉（安全 R14）
        if (storedPaths.length > 0) await discardStoredPaths(storedPaths);
        if (err instanceof PaperQuotaRollbackError) {
          // 落盘后复测越界（CR14）：页行已随事务回滚、文件已删，这里给出与 admission 同一形状的 413
          res.status(413).json({
            code: "PAPER_QUOTA_EXCEEDED",
            reason: err.reason,
            error: err.message,
            measuredAfterConversion: true,
            limits: { pagesPerCard: MAX_PAPER_PAGES_PER_CARD, bytesPerCard: MAX_PAPER_BYTES_PER_CARD, bytesTotal: MAX_PAPER_BYTES_TOTAL },
          });
          return;
        }
        console.error("[paper] upload failed:", err);
        res.status(500).json({ error: err.message || "上传失败" });
      } finally {
        // multer 已把文件写进 _tmp：任何返回路径（400 校验失败 / 413 配额 / 500）都要清干净
        for (const file of staged) {
          try { unlinkSync(file.path); } catch {}
        }
        invalidatePaperUsageCache();
      }
    }
  );

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
        // 查询总页数
        const db = getMysqlDb();
        const countRow = await db.get(
          "SELECT COUNT(*) AS c FROM original_paper_pages WHERE card_id = ?",
          cardId
        ) as { c: number } | undefined;
        const totalPages = countRow?.c ?? 0;

        for (const ext of [".jpg", ".jpeg", ".png", ".bmp", ".webp"]) {
          const fp = path.join(dir, `${baseName}${ext}`);

          if (existsSync(fp)) { res.json({ mimeType: getFileMime(`${baseName}${ext}`), filename: `${baseName}${ext}`, page, totalPages }); return; }
        }
        const pdfPath = path.join(dir, `${baseName}.pdf`);
        if (existsSync(pdfPath)) { res.json({ mimeType: "application/pdf", filename: `${baseName}.pdf`, page, totalPages }); return; }
        for (const ext of [".docx"]) {
          const fp = path.join(dir, `${baseName}${ext}`);
          if (existsSync(fp)) { res.json({ mimeType: getFileMime(`${baseName}${ext}`), filename: `${baseName}${ext}`, page, totalPages }); return; }

        }
        // 文件已在磁盘但 DB 无记录（旧数据回溯）：总页数为 1
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
      invalidatePaperUsageCache(); // 删除改变了磁盘占用：让下一次配额判定重新实测（安全 R10）
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
      // P2: 每页附带 MIME 类型，前端按 图片/PDF/DOCX 分别渲染缩略/嵌入/链接
      const pagesWithMime = pages.map((pg) => ({ ...pg, mime_type: getFileMime(pg.filename) }));

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
        pages: pagesWithMime,
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
    let runId: number | null = null;
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

      // 安全（R11 + PR #312 CR8/CR9）：知识点分析是同步打模型的，它过去只出现在
      // 计费账本里、不占并发名额——同一用户可以把「单用户在途 ≤2」刷成任意多个并行调用。
      // 现在判定与占位（一条 success IS NULL 的运行行）在同一临界区里原子完成；
      // 被拒时事务回滚，不会留下无法结算的幽灵行污染「谁在打模型」的账本。
      runId = await reserveAiCall(db, req.user?.id ?? null, {
        feature: "knowledge_points",
        model: provider.model ?? null,
        stage: "request"
      });

      // 2. 判断提供商类型 → 选择分析模式
      const range = questionRange || "全部";
      const notes = extraNotes || "";
      const isMultimodal = isVisionProvider(provider.providerType, provider.model);

      // 3. 获取答题卡科目
      const cardRow = await db.get("SELECT subject_label FROM answer_cards WHERE id = ?", cardId);
      const subject = cardRow?.subject_label || "";

      // 3.5 答题卡客观题结构化上下文（题号/题型/分值/标准答案），供 AI 核对题号与答案
      const card = await new CardRepository().findById(cardId);
      const objectiveItems = buildObjectiveContext(card);
      const answerCardJson = objectiveItems.length > 0
        ? JSON.stringify({ objectiveQuestions: objectiveItems })
        : "";

      // 4. 构建对 llmclient 的请求
      let knowledgePoints: any[] = [];
      // DOCX is a ZIP document, not an image input. Even vision models need its
      // extracted text when there are no image/PDF inputs.
      const kind = await getPaperInputKind(cardId);
      const mode = resolveKnowledgePointMode(isMultimodal && kind !== "docx");

      if (mode === "direct") {
        const files = await getPaperFiles(cardId);
        // 多模态：读取文件 → base64 → 直传
        if (files.length === 0) {
          await finalizeAiRun(runId, { success: false, errorCode: "NO_FILES" });
          res.status(400).json({ error: "NO_FILES", message: "未找到原卷文件" });
          return;
        }

        const resp = await fetchLlmClient("/analysis/knowledge-points", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode, providerId: provider.providerId, model: provider.model, providerOverride: provider.providerOverride,
            subject, questionRange: range, extraNotes: notes, files, answerCardJson,
          }),
        }, 60_000, { runId, provider: "llmclient", model: provider.model ?? null, stage: "knowledge_points" });

        knowledgePoints = await readKnowledgePointResponse(resp);
      } else {
        // 纯文本模型：本地提取文字后发送
        const extracted = await autoExtractPaperText(cardId);
        if (!extracted.text || extracted.text.length < 10) {
          await finalizeAiRun(runId, { success: false, errorCode: "TEXT_EXTRACTION_FAILED" });
          res.status(400).json({
            error: "TEXT_EXTRACTION_FAILED",
            message: "无法从原卷提取文字。请上传带文字层的 DOCX/PDF，或改用具备视觉能力的模型（如 deepseek-v4-flash-vision-exp / Gemini / GPT）直读扫描件"
          });
          return;
        }

        const resp = await fetchLlmClient("/analysis/knowledge-points", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode, providerId: provider.providerId, model: provider.model, providerOverride: provider.providerOverride,
            subject,
            questionRange: range, extraNotes: notes, paperText: extracted.text, answerCardJson,
          }),
        }, 60_000, { runId, provider: "llmclient", model: provider.model ?? null, stage: "knowledge_points" });

        knowledgePoints = await readKnowledgePointResponse(resp);
      }

      await finalizeAiRun(runId, { success: true });
      res.json({ mode, knowledgePoints });
    } catch (err: any) {
      if (err instanceof PaperInputError) {
        await finalizeAiRun(runId, { success: false, errorCode: err.code });
        res.status(err.status).json({ error: err.code, message: err.message });
        return;
      }
      // 安全（R11）：配额拒绝原样 429 + Retry-After，不当成「分析失败」的 500 处理
      if (err instanceof AiQuotaError) {
        res.setHeader("Retry-After", String(err.retryAfterSeconds));
        res.status(429).json({ error: err.code, message: err.message, retryAfterSeconds: err.retryAfterSeconds });
        return;
      }
      console.error("[knowledge-points] analyze failed:", err);
      await finalizeAiRun(runId, { success: false, errorCode: "EXCEPTION" });
      // 安全（R25）：异常消息可能带本机绝对路径（读原卷文件失败时常见），对外只给脱敏文案
      res.status(500).json({ error: "ANALYZE_FAILED", message: sanitizeOpsMessage(err?.message, { fallback: "分析失败，请查看服务端日志中的 [knowledge-points] 记录" }) });
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
 *
 * 安全（R10）：AI 组包也受预算约束。一张「合法但很大」的卡（例如 60 页 × 每页 50MB）
 * 在旧实现里会被整份读进内存再 base64（体积再涨约 4/3），一次点击就能把服务端内存打满。
 * 这里复用同一档「单次请求体积」预算：页数 ≤ 每请求文件数、字节 ≤ 每请求体积，
 * 超限直接 413，而不是悄悄截断——截断会让 AI 分析出「只看了前几页」的错误结论。
 */
async function getPaperFiles(cardId: string): Promise<Array<{ mimeType: string; base64: string }>> {
  const dir = paperDir(cardId);
  const files: Array<{ mimeType: string; base64: string }> = [];
  let entries: string[] = [];
  try { entries = await readdir(dir); } catch { return files; }

  const imgRe = /^original(-\d+)?\.(jpg|jpeg|png|bmp|tiff|webp)$/i;
  const pdfRe = /^original(-\d+)?\.pdf$/i;
  let totalBytes = 0;

  const collect = async (names: string[], mimeOf: (name: string) => string) => {
    for (const name of names) {
      if (files.length >= MAX_PAPER_FILES_PER_REQUEST) {
        throw new PaperInputError("PAPER_AI_BUNDLE_TOO_LARGE",
          `原卷共 ${names.length} 个文件，超过 AI 组包上限 ${MAX_PAPER_FILES_PER_REQUEST} 个，请拆分后分析`, 413);
      }
      const buf = await readFile(path.join(dir, name));
      if (totalBytes + buf.length > MAX_PAPER_REQUEST_BYTES) {
        throw new PaperInputError("PAPER_AI_BUNDLE_TOO_LARGE",
          `原卷累计 ${Math.round((totalBytes + buf.length) / 1024 / 1024)}MB 超过 AI 组包预算 ${Math.round(MAX_PAPER_REQUEST_BYTES / 1024 / 1024)}MB`, 413);
      }
      totalBytes += buf.length;
      files.push({ mimeType: mimeOf(name), base64: buf.toString("base64") });
    }
  };

  // 所有页的图片（按页码排序）
  await collect(entries.filter((e) => imgRe.test(e)).sort(), (name) => getFileMime(name));
  if (files.length) return files;

  // 回退：所有页的 PDF
  await collect(entries.filter((e) => pdfRe.test(e)).sort(), () => "application/pdf");
  return files;
}
