import express from "express";
import multer from "multer";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { pathToFileURL } from "node:url";
import { ensureDefaultAdmin, initializeDatabase } from "../../../server/db";
import { scheduleCleanup } from "../../../server/db/cleanup";
import { CardRepository } from "../../../server/repositories/CardRepository";
import authRoutes from "../../../server/routes/auth";
import { createDefaultCard } from "../../../shared/defaultCard";
import { gradeCombinedRecognition, gradeObjectiveRecognition } from "../../../shared/grading";
import { buildLayout } from "../../../shared/layout";
import type {
  AnswerCard,
  CombinedGradingBatchResult,
  CombinedRecognitionResult,
  ObjectiveGradingBatchResult,
  ObjectiveRecognitionResult
} from "../../../shared/types";
import { createPdf } from "./pdf";
import { recognizeAnswerCard, recognizeObjectiveAnswers } from "./recognition";

const answerCardDataDir = process.env.ANSWER_CARD_DATA_DIR
  ? path.resolve(process.env.ANSWER_CARD_DATA_DIR)
  : path.join(process.cwd(), "data", "answer-card");
const assetsDir = path.join(answerCardDataDir, "assets");
const layoutsDir = path.join(answerCardDataDir, "layouts");
const recognitionUploadsDir = path.join(answerCardDataDir, "recognition", "uploads");

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

function safeCardId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "");
}

function cardLayoutPath(cardId: string): string {
  return path.join(layoutsDir, `${safeCardId(cardId)}.json`);
}

async function writeCardLayout(cardId: string, card: AnswerCard): Promise<string> {
  const layout = buildLayout(card);
  const outputPath = cardLayoutPath(cardId);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(layout, null, 2), "utf8");
  return outputPath;
}

function readPositiveNumber(value: unknown, fallback: number): number {
  const parsed = Number(fieldValue(value) || String(fallback));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function createApp(): Promise<express.Express> {
  const app = express();

  console.log("[Server] Initializing database...");
  initializeDatabase();
  await ensureDefaultAdmin();
  scheduleCleanup(24, 30);
  console.log("[Server] Database initialized");

  app.use(express.json({ limit: "8mb" }));
  app.use("/assets", express.static(assetsDir));
  app.use("/api/auth", authRoutes);

  const upload = multer({
    storage: multer.diskStorage({
      destination: async (_req, _file, cb) => {
        await mkdir(assetsDir, { recursive: true });
        cb(null, assetsDir);
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
        const cardId = safeCardId(paramValue(req.params.cardId));
        const dir = path.join(recognitionUploadsDir, cardId);
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

  const cardRepo = new CardRepository();

  app.get("/api/cards", async (_req, res, next) => {
    try {
      res.json(cardRepo.listCards());
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/cards", async (req, res, next) => {
    try {
      const card = createDefaultCard(String(Date.now()));
      const layout = buildLayout(card);
      cardRepo.createCard(card, (req as express.Request & { user?: { id?: number } }).user?.id);
      cardRepo.updateLayoutData(card.id, layout);
      await writeCardLayout(card.id, card);
      res.status(201).json(card);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/cards/:cardId", async (req, res, next) => {
    try {
      const card = cardRepo.findById(safeCardId(paramValue(req.params.cardId)));
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
      const cardId = safeCardId(paramValue(req.params.cardId));
      const card = { ...(req.body as AnswerCard), id: cardId };
      const layout = buildLayout(card);
      cardRepo.updateCard(card, layout);
      await writeCardLayout(cardId, card);
      res.json(card);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/cards/:cardId/layout", async (req, res, next) => {
    try {
      const cardId = safeCardId(paramValue(req.params.cardId));
      const card = cardRepo.findById(cardId);
      if (!card) {
        res.status(404).json({ message: "答题卡不存在" });
        return;
      }
      const layout = buildLayout(card);
      cardRepo.updateLayoutData(cardId, layout);
      await writeCardLayout(cardId, card);
      res.json(layout);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/cards/:cardId/assets", upload.single("file"), async (req, res, next) => {
    try {
      const cardId = safeCardId(paramValue(req.params.cardId));
      const card = cardRepo.findById(cardId);
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
        url: `/assets/${req.file.filename}`
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/cards/:cardId/pdf", async (req, res, next) => {
    try {
      const card = cardRepo.findById(safeCardId(paramValue(req.params.cardId)));
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

  app.post("/api/cards/:cardId/recognition/objective", recognitionUpload.single("file"), async (req, res, next) => {
    try {
      const cardId = safeCardId(paramValue(req.params.cardId));
      const card = cardRepo.findById(cardId);
      if (!card) {
        res.status(404).json({ message: "答题卡不存在" });
        return;
      }
      if (!req.file) {
        res.status(400).json({ message: "没有收到答题卡图片" });
        return;
      }

      const layoutPath = await writeCardLayout(cardId, card);
      const pageNumber = readPositiveNumber(req.body.page || req.query.page, 1);
      const dpi = readPositiveNumber(req.body.dpi || req.query.dpi, 300);
      const debug = boolField(req.body.debug || req.query.debug);
      const debugDir = debug
        ? path.join(answerCardDataDir, "processed", "recognition-debug", cardId, String(Date.now()))
        : undefined;

      const result = await recognizeObjectiveAnswers({
        imagePath: req.file.path,
        layoutPath,
        pageNumber,
        dpi,
        debugDir
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/cards/:cardId/recognition", recognitionUpload.single("file"), async (req, res, next) => {
    try {
      const cardId = safeCardId(paramValue(req.params.cardId));
      const card = cardRepo.findById(cardId);
      if (!card) {
        res.status(404).json({ message: "答题卡不存在" });
        return;
      }
      if (!req.file) {
        res.status(400).json({ message: "没有收到答题卡图片" });
        return;
      }

      const layoutPath = await writeCardLayout(cardId, card);
      const pageNumber = readPositiveNumber(req.body.page || req.query.page, 1);
      const dpi = readPositiveNumber(req.body.dpi || req.query.dpi, 300);
      const debug = boolField(req.body.debug || req.query.debug);
      const debugDir = debug
        ? path.join(answerCardDataDir, "processed", "recognition-debug", cardId, String(Date.now()))
        : undefined;

      const result = await recognizeAnswerCard({
        imagePath: req.file.path,
        layoutPath,
        pageNumber,
        dpi,
        debugDir
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/cards/:cardId/grading/objective", recognitionUpload.array("files", 200), async (req, res, next) => {
    try {
      const cardId = safeCardId(paramValue(req.params.cardId));
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

      const layoutPath = await writeCardLayout(cardId, card);
      const pageNumber = readPositiveNumber(req.body.page || req.query.page, 1);
      const dpi = readPositiveNumber(req.body.dpi || req.query.dpi, 300);

      const rows = [];
      for (const file of files) {
        try {
          const recognition = (await recognizeObjectiveAnswers({
            imagePath: file.path,
            layoutPath,
            pageNumber,
            dpi
          })) as ObjectiveRecognitionResult;
          rows.push(gradeObjectiveRecognition(card, file.originalname || path.basename(file.path), recognition));
        } catch (error) {
          const recognition: ObjectiveRecognitionResult = {
            status: "failed",
            imagePath: file.path,
            pageNumber,
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

  app.post("/api/cards/:cardId/grading", recognitionUpload.array("files", 200), async (req, res, next) => {
    try {
      const cardId = safeCardId(paramValue(req.params.cardId));
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

      const layoutPath = await writeCardLayout(cardId, card);
      const pageNumber = readPositiveNumber(req.body.page || req.query.page, 1);
      const dpi = readPositiveNumber(req.body.dpi || req.query.dpi, 300);

      const rows = [];
      for (const file of files) {
        try {
          const recognition = (await recognizeAnswerCard({
            imagePath: file.path,
            layoutPath,
            pageNumber,
            dpi
          })) as CombinedRecognitionResult;
          recognition.subjectiveQuestions = recognition.subjectiveQuestions ?? [];
          rows.push(gradeCombinedRecognition(card, file.originalname || path.basename(file.path), recognition));
        } catch (error) {
          const recognition: CombinedRecognitionResult = {
            status: "failed",
            imagePath: file.path,
            pageNumber,
            message: error instanceof Error ? error.message : String(error),
            questions: [],
            subjectiveQuestions: []
          };
          rows.push(gradeCombinedRecognition(card, file.originalname || path.basename(file.path), recognition));
        }
      }

      const result: CombinedGradingBatchResult = {
        batchId: `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        cardId,
        rows
      };
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  const clientDist = process.env.ANSWER_CARD_CLIENT_DIST
    ? path.resolve(process.env.ANSWER_CARD_CLIENT_DIST)
    : path.join(process.cwd(), "dist", "client");
  if (existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.get("/{*splat}", (_req, res) => {
      res.sendFile(path.join(clientDist, "index.html"));
    });
  }

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
