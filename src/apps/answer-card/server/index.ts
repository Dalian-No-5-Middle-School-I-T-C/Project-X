import express from "express";
import multer from "multer";
import path from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import type { Server } from "node:http";
import { pathToFileURL } from "node:url";
import type { AnswerCard } from "../../../shared/types";
import { createPdf } from "./pdf";
import { recognizeObjectiveAnswers } from "./recognition";
import {
  startWatching,
  stopWatching,
  getWatcherStatus,
  processFile,
  triggerRecognition,
  autoMatchCard,
  scanFolder,
  type ScannerDriver
} from "./scanner";
import {
  assetsDir,
  cardAssetsDir,
  createCard,
  dataDir,
  ensureDataDirs,
  layoutPath,
  listCards,
  readCard,
  readLayout,
  rootDir,
  safeId,
  saveCard,
  // 扫描相关
  getScan,
  listScans,
  getScanCount,
  updateScan,
  getConfig,
  setConfig,
  getAllConfig,
  scansDir,
  thumbnailsDir,
  closeDb,
  type ScanRecord,
  type ScanStatus
} from "./database";

function paramValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] : value ?? "";
}

function fieldValue(value: unknown): string {
  if (Array.isArray(value)) {
    return String(value[0] ?? "");
  }
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function boolField(value: unknown): boolean {
  const normalized = fieldValue(value).trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export async function createApp(): Promise<express.Express> {
  const app = express();

  await ensureDataDirs();

  // 启动文件夹监听
  startWatching((scan) => {
    console.log(`[api] 新扫描记录已创建: ${scan.id} (${scan.file_name})`);
  });

  app.use(express.json({ limit: "8mb" }));
  app.use("/assets", express.static(assetsDir));
  // 提供扫描缩略图访问
  app.use("/scans", express.static(scansDir));
  app.use("/thumbnails", express.static(thumbnailsDir));

  const upload = multer({
    storage: multer.diskStorage({
      destination: async (req, _file, cb) => {
        const cardId = safeId(paramValue(req.params.cardId));
        const dir = cardAssetsDir(cardId);
        await mkdir(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase() || ".png";
        const name = `asset_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
        cb(null, name);
      }
    }),
    limits: { fileSize: 12 * 1024 * 1024 }
  });

  const recognitionUpload = multer({
    storage: multer.diskStorage({
      destination: async (req, _file, cb) => {
        const cardId = safeId(paramValue(req.params.cardId));
        const dir = path.join(dataDir, "recognition", "uploads", cardId);
        await mkdir(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase() || ".png";
        const name = `scan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
        cb(null, name);
      }
    }),
    limits: { fileSize: 20 * 1024 * 1024 }
  });

  // ============================================================
  // 答题卡 API（保持原有接口）
  // ============================================================

  app.get("/api/cards", async (_req, res, next) => {
    try {
      res.json(listCards());
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/cards", async (_req, res, next) => {
    try {
      const card = await createCard();
      console.log(`[api] 新建答题卡: ${card.id}`);
      res.status(201).json(card);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error ?? "未知错误");
      console.error("[api] 新建答题卡失败:", msg);
      console.error(error instanceof Error ? error.stack : error);
      // 直接返回，不走 next(error)
      res.status(500).json({ message: msg });
    }
  });

  app.get("/api/cards/:cardId", async (req, res, next) => {
    try {
      const card = readCard(paramValue(req.params.cardId));
      if (!card) {
        res.status(404).json({ message: "答题卡不存在" });
        return;
      }
      res.json(card);
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/cards/:cardId", async (req, res, next) => {
    try {
      const card = req.body as AnswerCard;
      const saved = saveCard({ ...card, id: safeId(paramValue(req.params.cardId)) });
      res.json(saved);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/cards/:cardId/layout", async (req, res, next) => {
    try {
      const layout = readLayout(paramValue(req.params.cardId));
      if (!layout) {
        res.status(404).json({ message: "答题卡不存在" });
        return;
      }
      res.json(layout);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/cards/:cardId/recognition/objective", recognitionUpload.single("file"), async (req, res, next) => {
    try {
      const cardId = safeId(paramValue(req.params.cardId));
      const card = readCard(cardId);
      if (!card) {
        res.status(404).json({ message: "答题卡不存在" });
        return;
      }
      if (!req.file) {
        res.status(400).json({ message: "没有收到图片文件" });
        return;
      }

      readLayout(cardId);
      const pageNumber = Number(fieldValue(req.body.page || req.query.page) || "1");
      const dpi = Number(fieldValue(req.body.dpi || req.query.dpi) || "300");
      const debug = boolField(req.body.debug || req.query.debug);
      const debugDir = debug ? path.join(dataDir, "processed", "recognition-debug", cardId, String(Date.now())) : undefined;
      if (debugDir) {
        await mkdir(debugDir, { recursive: true });
      }

      const result = await recognizeObjectiveAnswers({
        imagePath: req.file.path,
        layoutPath: layoutPath(cardId),
        pageNumber: Number.isFinite(pageNumber) && pageNumber > 0 ? pageNumber : 1,
        dpi: Number.isFinite(dpi) && dpi > 0 ? dpi : 300,
        debugDir
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/cards/:cardId/assets", upload.single("file"), async (req, res, next) => {
    try {
      const cardId = paramValue(req.params.cardId);
      const card = readCard(cardId);
      if (!card) {
        res.status(404).json({ message: "答题卡不存在" });
        return;
      }
      if (!req.file) {
        res.status(400).json({ message: "没有收到图片文件" });
        return;
      }
      res.status(201).json({
        assetId: req.file.filename,
        originalName: req.file.originalname,
        url: `/assets/${safeId(cardId)}/${req.file.filename}`
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/cards/:cardId/pdf", async (req, res, next) => {
    try {
      const card = readCard(paramValue(req.params.cardId));
      if (!card) {
        res.status(404).json({ message: "答题卡不存在" });
        return;
      }

      const doc = createPdf(card);
      const filename = encodeURIComponent(`${card.title || card.id}.pdf`);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${filename}`);
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
      doc.pipe(res);
      doc.end();
    } catch (error) {
      next(error);
    }
  });

  // ============================================================
  // 扫描管理 API（新增）
  // ============================================================

  // 获取扫描列表
  app.get("/api/scans", async (req, res, next) => {
    try {
      const cardId = paramValue(req.query.cardId) || undefined;
      const status = paramValue(req.query.status) as ScanStatus | undefined;
      const studentId = paramValue(req.query.studentId) || undefined;
      const limit = Number(paramValue(req.query.limit) || "50");
      const offset = Number(paramValue(req.query.offset) || "0");

      const scans = listScans({
        cardId: cardId || undefined,
        status: status || undefined,
        studentId: studentId || undefined,
        limit: Number.isFinite(limit) ? limit : 50,
        offset: Number.isFinite(offset) ? offset : 0
      });

      const total = getScanCount({
        cardId: cardId || undefined,
        status: status || undefined
      });

      res.json({ scans, total });
    } catch (error) {
      next(error);
    }
  });

  // 获取单条扫描记录
  app.get("/api/scans/:scanId", async (req, res, next) => {
    try {
      const scan = getScan(paramValue(req.params.scanId));
      if (!scan) {
        res.status(404).json({ message: "扫描记录不存在" });
        return;
      }
      res.json(scan);
    } catch (error) {
      next(error);
    }
  });

  // 扫描文件夹（批量导入）
  app.post("/api/scans/folder", async (req, res, next) => {
    try {
      const folderPath = fieldValue(req.body.path);
      if (!folderPath) {
        res.status(400).json({ message: "请提供文件夹路径 (path)" });
        return;
      }
      if (!existsSync(folderPath)) {
        res.status(404).json({ message: `文件夹不存在: ${folderPath}` });
        return;
      }

      const result = await scanFolder(folderPath);
      res.status(201).json({ message: `已扫描 ${result.count} 个文件`, count: result.count, scans: result.scans });
    } catch (error) {
      next(error);
    }
  });

  // 上传单个文件（浏览器文件夹选择器用）
  const scanUpload = multer({
    storage: multer.diskStorage({
      destination: async (_req, _file, cb) => {
        mkdirSync(scansDir, { recursive: true });
        cb(null, scansDir);
      },
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase() || ".png";
        cb(null, `upload_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
      }
    }),
    limits: { fileSize: 30 * 1024 * 1024 }
  });

  app.post("/api/scans/upload-file", scanUpload.single("file"), async (req, res, next) => {
    try {
      if (!req.file) {
        res.status(400).json({ message: "没有收到文件" });
        return;
      }

      const cardId = fieldValue(req.body.cardId) || autoMatchCard() || undefined;
      const dpi = Number(fieldValue(req.body.dpi) || getConfig("default_dpi") || "300");

      const scan = await processFile(req.file.path, {
        cardId,
        dpi: Number.isFinite(dpi) ? dpi : 300
      });

      if (!scan) {
        res.status(500).json({ message: "文件处理失败" });
        return;
      }

      res.status(201).json(scan);
    } catch (error) {
      next(error);
    }
  });

  // 手动导入文件
  app.post("/api/scans/import", async (req, res, next) => {
    try {
      const filePath = fieldValue(req.body.path);
      const cardId = fieldValue(req.body.cardId) || autoMatchCard() || undefined;
      const dpi = Number(fieldValue(req.body.dpi) || getConfig("default_dpi") || "300");
      const skipRecognition = boolField(req.body.skipRecognition);

      if (!filePath) {
        res.status(400).json({ message: "请提供文件路径 (path)" });
        return;
      }
      if (!existsSync(filePath)) {
        res.status(404).json({ message: `文件不存在: ${filePath}` });
        return;
      }

      const scan = await processFile(filePath, {
        cardId,
        dpi: Number.isFinite(dpi) ? dpi : 300,
        skipRecognition
      });

      if (!scan) {
        res.status(500).json({ message: "文件处理失败" });
        return;
      }

      res.status(201).json(scan);
    } catch (error) {
      next(error);
    }
  });

  // 手动触发识别
  app.post("/api/scans/:scanId/recognize", async (req, res, next) => {
    try {
      const scanId = paramValue(req.params.scanId);
      const scan = getScan(scanId);
      if (!scan) {
        res.status(404).json({ message: "扫描记录不存在" });
        return;
      }

      const cardId = fieldValue(req.body.cardId) || scan.card_id;
      if (!cardId) {
        res.status(400).json({ message: "请指定答题卡 ID (cardId)" });
        return;
      }

      const dpi = Number(fieldValue(req.body.dpi) || scan.dpi || "300");

      // 异步执行识别
      triggerRecognition(scanId, cardId, dpi).catch((err) => {
        console.error(`[api] 识别触发失败:`, err);
      });

      res.json({ message: "识别已触发", scanId, cardId });
    } catch (error) {
      next(error);
    }
  });

  // 更新扫描记录（手动修正学号等）
  app.patch("/api/scans/:scanId", async (req, res, next) => {
    try {
      const scanId = paramValue(req.params.scanId);
      const existing = getScan(scanId);
      if (!existing) {
        res.status(404).json({ message: "扫描记录不存在" });
        return;
      }

      const updates: Partial<ScanRecord> = {};
      if (req.body.card_id !== undefined) updates.card_id = fieldValue(req.body.card_id) || null;
      if (req.body.student_id !== undefined) updates.student_id = fieldValue(req.body.student_id) || null;
      if (req.body.student_name !== undefined) updates.student_name = fieldValue(req.body.student_name) || null;
      if (req.body.class_name !== undefined) updates.class_name = fieldValue(req.body.class_name) || null;
      if (req.body.page_number !== undefined) updates.page_number = Number(req.body.page_number) || 1;
      if (req.body.status !== undefined) updates.status = fieldValue(req.body.status) as ScanStatus;

      const updated = updateScan(scanId, updates);
      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  // 删除扫描记录
  app.delete("/api/scans/:scanId", async (req, res, next) => {
    try {
      const scanId = paramValue(req.params.scanId);
      const scan = getScan(scanId);
      if (!scan) {
        res.status(404).json({ message: "扫描记录不存在" });
        return;
      }

      // 清理文件
      try {
        const { unlink } = await import("node:fs/promises");
        if (existsSync(scan.stored_path)) await unlink(scan.stored_path);
        if (scan.thumbnail_path && existsSync(scan.thumbnail_path)) await unlink(scan.thumbnail_path);
      } catch (cleanupErr) {
        console.warn(`[api] 清理扫描文件失败:`, cleanupErr);
      }

      // 数据库标记为已删除（软删除，实际是更新状态）
      updateScan(scanId, {
        status: "error",
        error_message: "用户已删除"
      });

      res.json({ message: "已删除" });
    } catch (error) {
      next(error);
    }
  });

  // ============================================================
  // 扫描配置 API
  // ============================================================

  // 获取所有配置
  app.get("/api/scans/config", async (_req, res, next) => {
    try {
      const config = getAllConfig();
      const status = getWatcherStatus();
      res.json({ config, watcher: status });
    } catch (error) {
      next(error);
    }
  });

  // 更新配置
  app.put("/api/scans/config", async (req, res, next) => {
    try {
      const updates: Record<string, string> = {};
      if (req.body.input_folder !== undefined) updates.input_folder = fieldValue(req.body.input_folder);
      if (req.body.auto_recognize !== undefined) updates.auto_recognize = boolField(req.body.auto_recognize) ? "true" : "false";
      if (req.body.default_dpi !== undefined) updates.default_dpi = String(Number(req.body.default_dpi) || 300);

      for (const [key, value] of Object.entries(updates)) {
        setConfig(key, value);
      }

      // 如果 input_folder 变了，重启监听
      if (updates.input_folder) {
        await stopWatching();
        startWatching((scan) => {
          console.log(`[api] 新扫描记录: ${scan.id}`);
        });
      }

      res.json({ config: getAllConfig(), watcher: getWatcherStatus() });
    } catch (error) {
      next(error);
    }
  });

  // 获取扫描仪状态（预留接口）
  app.get("/api/scanner/status", async (_req, res, next) => {
    try {
      const driverType = getConfig("scanner_driver") || "folder";
      res.json({
        driver: driverType,
        watcher: getWatcherStatus(),
        supportedDrivers: ["folder", "twain", "wia", "kodak_sdk"]
      });
    } catch (error) {
      next(error);
    }
  });

  // ============================================================
  // 静态文件 & SPA fallback
  // ============================================================

  const clientDist = process.env.ANSWER_CARD_CLIENT_DIST
    ? path.resolve(process.env.ANSWER_CARD_CLIENT_DIST)
    : path.join(rootDir, "dist", "client");
  if (existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.get("/{*splat}", (_req, res) => {
      res.sendFile(path.join(clientDist, "index.html"));
    });
  }

  // ============================================================
  // 错误处理
  // ============================================================

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = error instanceof Error ? error.message : String(error ?? "未知错误");
    const stack = error instanceof Error ? error.stack : undefined;
    console.error("[api] 500 错误:", message);
    if (stack) console.error(stack);
    // 确保发送 JSON，不依赖类型推导
    res.status(500).setHeader("Content-Type", "application/json; charset=utf-8").end(JSON.stringify({ message }));
  });

  return app;
}

export async function startServer(port = Number(process.env.PORT ?? 5174)): Promise<Server> {
  const app = await createApp();

  return new Promise((resolve) => {
    const server = app.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      console.log(`Answer card designer API running at http://127.0.0.1:${actualPort}`);

      // 优雅关闭
      const gracefulShutdown = () => {
        console.log("[api] 正在关闭...");
        void stopWatching();
        closeDb();
        server.close(() => {
          console.log("[api] 服务器已关闭");
          process.exit(0);
        });
      };

      process.on("SIGINT", gracefulShutdown);
      process.on("SIGTERM", gracefulShutdown);
    });
    resolve(server);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startServer();
}
