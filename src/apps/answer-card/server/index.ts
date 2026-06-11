import express from "express";
import multer from "multer";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import type { Server } from "node:http";
import { pathToFileURL } from "node:url";
import { initializeDatabase, ensureDefaultAdmin, getDatabase } from "./db";
import { runCleanup, scheduleCleanup } from "./db/cleanup";
import { CardRepository } from "./repositories/CardRepository";
import { ExamRepository } from "./repositories/ExamRepository";
import { recognizeObjectiveAnswers } from "./recognition";
import { createPdf } from "./pdf";
import authRoutes from "./routes/auth";
import type { AnswerCard, ObjectiveGradingBatchResult, ObjectiveRecognitionResult } from "../../../shared/types";
import { gradeObjectiveRecognition } from "../../../shared/grading";
import { buildLayout } from "../../../shared/layout";
import { createDefaultCard } from "../../../shared/defaultCard";

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

  // ========== 初始化数据库 ==========
  console.log("[Server] 正在初始化数据库...");
  initializeDatabase();
  await ensureDefaultAdmin();

  // 注册定时清理任务（每24小时，保留30天）
  scheduleCleanup(24, 30);
  console.log("[Server] 数据库初始化完成");

  // ========== 中间件 ==========
  app.use(express.json({ limit: "8mb" }));

  // 静态资源（答题卡图片）
  const assetsDir = path.join(process.cwd(), "data", "answer-card", "assets");
  app.use("/assets", express.static(assetsDir));

  // ========== 认证路由（不需要token） ==========
  app.use("/api/auth", authRoutes);

  // ========== 文件上传配置 ==========
  const upload = multer({
    storage: multer.diskStorage({
      destination: async (_req, _file, cb) => {
        const dir = path.join(process.cwd(), "data", "answer-card", "assets");
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
      destination: async (_req, _file, cb) => {
        const dir = path.join(process.cwd(), "data", "recognition", "uploads");
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

  // ========== 答题卡 API（数据库版） ==========
  const cardRepo = new CardRepository();
  const examRepo = new ExamRepository();

  // GET /api/cards - 列表
  app.get("/api/cards", async (_req, res, next) => {
    try {
      res.json(cardRepo.listCards());
    } catch (error) {
      next(error);
    }
  });

  // POST /api/cards - 新建
  app.post("/api/cards", async (req, res, next) => {
    try {
      const card = createDefaultCard(String(Date.now()));
      cardRepo.createCard(card, (req as any).user?.id);
      // 同时保存 layout
      const layout = buildLayout(card);
      cardRepo.updateLayoutData(card.id, layout);
      res.status(201).json(card);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/cards/:cardId - 获取详情
  app.get("/api/cards/:cardId", async (req, res, next) => {
    try {
      const card = cardRepo.findById(paramValue(req.params.cardId));
      if (!card) {
        res.status(404).json({ message: "答题卡不存在" });
        return;
      }
      res.json(card);
    } catch (error) {
      next(error);
    }
  });

  // PUT /api/cards/:cardId - 保存
  app.put("/api/cards/:cardId", async (req, res, next) => {
    try {
      const card = req.body as AnswerCard;
      const safeId = paramValue(req.params.cardId).replace(/[^a-zA-Z0-9_-]/g, "");
      const layout = buildLayout(card);
      cardRepo.updateCard({ ...card, id: safeId }, layout);
      res.json(card);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/cards/:cardId/layout - 获取布局
  app.get("/api/cards/:cardId/layout", async (req, res, next) => {
    try {
      const cardId = paramValue(req.params.cardId).replace(/[^a-zA-Z0-9_-]/g, "");
      const card = cardRepo.findById(cardId);
      if (!card) {
        res.status(404).json({ message: "答题卡不存在" });
        return;
      }
      const layout = buildLayout(card);
      cardRepo.updateLayoutData(cardId, layout);
      res.json(layout);
    } catch (error) {
      next(error);
    }
  });

  // POST /api/cards/:cardId/assets - 上传资源
  app.post("/api/cards/:cardId/assets", upload.single("file"), async (req, res, next) => {
    try {
      if (!req.file) {
        res.status(400).json({ message: "没有收到图片文件" });
        return;
      }
      res.status(201).json({
        assetId: req.file.filename,
        originalName: req.file.originalname,
        url: `/assets/${req.file.filename}`
      });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/cards/:cardId/pdf - 生成 PDF
  app.get("/api/cards/:cardId/pdf", async (req, res, next) => {
    try {
      const cardId = paramValue(req.params.cardId).replace(/[^a-zA-Z0-9_-]/g, "");
      const card = cardRepo.findById(cardId);
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

  // ========== 识别与阅卷 API ==========

  // POST /api/cards/:cardId/recognition/objective - 单张识别
  app.post("/api/cards/:cardId/recognition/objective", recognitionUpload.single("file"), async (req, res, next) => {
    try {
      const cardId = paramValue(req.params.cardId).replace(/[^a-zA-Z0-9_-]/g, "");
      const card = cardRepo.findById(cardId);
      if (!card) {
        res.status(404).json({ message: "答题卡不存在" });
        return;
      }
      if (!req.file) {
        res.status(400).json({ message: "没有收到答题卡图片" });
        return;
      }

      // 生成 layout 并保存（识别需要 layout 文件路径）
      const layout = buildLayout(card);
      const layoutPath = path.join(process.cwd(), "data", "answer-card", "layouts", `${cardId}.json`);
      const fs = require("node:fs");
      fs.mkdirSync(path.dirname(layoutPath), { recursive: true });
      fs.writeFileSync(layoutPath, JSON.stringify(layout, null, 2));

      const pageNumber = Number(fieldValue(req.body.page || req.query.page) || 1);
      const dpi = Number(fieldValue(req.body.dpi || req.query.dpi) || 300);
      const debug = boolField(req.body.debug || req.query.debug);
      const debugDir = debug
        ? path.join(process.cwd(), "data", "processed", "recognition-debug", cardId, String(Date.now()))
        : undefined;

      const result = await recognizeObjectiveAnswers({
        imagePath: req.file.path,
        layoutPath,
        pageNumber: Number.isFinite(pageNumber) && pageNumber > 0 ? pageNumber : 1,
        dpi: Number.isFinite(dpi) && dpi > 0 ? dpi : 300,
        debugDir
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  // POST /api/cards/:cardId/grading/objective - 批量阅卷
  app.post("/api/cards/:cardId/grading/objective", recognitionUpload.array("files", 200), async (req, res, next) => {
    try {
      const cardId = paramValue(req.params.cardId).replace(/[^a-zA-Z0-9_-]/g, "");
      const card = cardRepo.findById(cardId);
      if (!card) {
        res.status(404).json({ message: "答题卡不存在" });
        return;
      }

      const files = Array.isArray(req.files) ? req.files : [];
      if (files.length === 0) {
        res.status(400).json({ message: "没有收到答题卡图片" });
        return;
      }

      const layout = buildLayout(card);
      const layoutPath = path.join(process.cwd(), "data", "answer-card", "layouts", `${cardId}.json`);
      const fs = require("node:fs");
      fs.mkdirSync(path.dirname(layoutPath), { recursive: true });
      fs.writeFileSync(layoutPath, JSON.stringify(layout, null, 2));

      const pageNumber = Number(fieldValue(req.body.page || req.query.page) || 1);
      const dpi = Number(fieldValue(req.body.dpi || req.query.dpi) || 300);
      const safePageNumber = Number.isFinite(pageNumber) && pageNumber > 0 ? pageNumber : 1;
      const safeDpi = Number.isFinite(dpi) && dpi > 0 ? dpi : 300;

      const rows = [];
      for (const file of files) {
        try {
          const recognition = await recognizeObjectiveAnswers({
            imagePath: file.path,
            layoutPath,
            pageNumber: safePageNumber,
            dpi: safeDpi
          }) as ObjectiveRecognitionResult;
          rows.push(gradeObjectiveRecognition(card, file.originalname || path.basename(file.path), recognition));
        } catch (error) {
          const recognition: ObjectiveRecognitionResult = {
            status: "failed",
            imagePath: file.path,
            pageNumber: safePageNumber,
            message: error instanceof Error ? error.message : String(error),
            questions: []
          };
          rows.push(gradeObjectiveRecognition(card, file.originalname || path.basename(file.path), recognition));
        }
      }

      const result: ObjectiveGradingBatchResult = {
        batchId: `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        cardId,
        rows
      };
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  // ========== 前端静态文件（生产环境） ==========
  const clientDist = process.env.ANSWER_CARD_CLIENT_DIST
    ? path.resolve(process.env.ANSWER_CARD_CLIENT_DIST)
    : path.join(process.cwd(), "dist", "client");
  if (existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.get("/{*splat}", (_req, res) => {
      res.sendFile(path.join(clientDist, "index.html"));
    });
  }

  // ========== 错误处理 ==========
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(error);
    res.status(500).json({ message: error instanceof Error ? error.message : "服务器错误" });
  });

  return app;
}

export async function startServer(port = Number(process.env.PORT ?? 5174)): Promise<Server> {
  const app = await createApp();

  return new Promise((resolve) => {
    const server = app.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      console.log(`Answer card API running at http://127.0.0.1:${actualPort}`);
      resolve(server);
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startServer();
}
