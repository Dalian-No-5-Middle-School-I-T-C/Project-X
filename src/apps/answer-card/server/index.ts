import express from "express";
import multer from "multer";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import type { Server } from "node:http";
import { pathToFileURL } from "node:url";
import { gradeCombinedRecognition, gradeObjectiveRecognition } from "../../../shared/grading";
import type { AnswerCard, CombinedGradingBatchResult, CombinedRecognitionResult, ObjectiveGradingBatchResult, ObjectiveRecognitionResult } from "../../../shared/types";
import { createPdf } from "./pdf";
import { recognizeAnswerCard, recognizeObjectiveAnswers } from "./recognition";
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
  saveCard
} from "./storage";

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

  app.use(express.json({ limit: "8mb" }));
  app.use("/assets", express.static(assetsDir));

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

  app.get("/api/cards", async (_req, res, next) => {
    try {
      res.json(await listCards());
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/cards", async (_req, res, next) => {
    try {
      res.status(201).json(await createCard());
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/cards/:cardId", async (req, res, next) => {
    try {
      const card = await readCard(paramValue(req.params.cardId));
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
      const saved = await saveCard({ ...card, id: safeId(paramValue(req.params.cardId)) });
      res.json(saved);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/cards/:cardId/layout", async (req, res, next) => {
    try {
      const layout = await readLayout(paramValue(req.params.cardId));
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
      const card = await readCard(cardId);
      if (!card) {
        res.status(404).json({ message: "绛旈鍗′笉瀛樺湪" });
        return;
      }
      if (!req.file) {
        res.status(400).json({ message: "娌℃湁鏀跺埌鍥剧墖鏂囦欢" });
        return;
      }

      await readLayout(cardId);
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

  app.post("/api/cards/:cardId/recognition", recognitionUpload.single("file"), async (req, res, next) => {
    try {
      const cardId = safeId(paramValue(req.params.cardId));
      const card = await readCard(cardId);
      if (!card) {
        res.status(404).json({ message: "答题卡不存在" });
        return;
      }
      if (!req.file) {
        res.status(400).json({ message: "没有收到答题卡图片" });
        return;
      }

      await readLayout(cardId);
      const pageNumber = Number(fieldValue(req.body.page || req.query.page) || "1");
      const dpi = Number(fieldValue(req.body.dpi || req.query.dpi) || "300");
      const debug = boolField(req.body.debug || req.query.debug);
      const debugDir = debug ? path.join(dataDir, "processed", "recognition-debug", cardId, String(Date.now())) : undefined;
      if (debugDir) {
        await mkdir(debugDir, { recursive: true });
      }

      const result = await recognizeAnswerCard({
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

  app.post("/api/cards/:cardId/grading/objective", recognitionUpload.array("files", 200), async (req, res, next) => {
    try {
      const cardId = safeId(paramValue(req.params.cardId));
      const card = await readCard(cardId);
      if (!card) {
        res.status(404).json({ message: "答题卡不存在" });
        return;
      }

      const files = Array.isArray(req.files) ? req.files : [];
      if (files.length === 0) {
        res.status(400).json({ message: "没有收到答题卡图片" });
        return;
      }

      await readLayout(cardId);
      const pageNumber = Number(fieldValue(req.body.page || req.query.page) || "1");
      const dpi = Number(fieldValue(req.body.dpi || req.query.dpi) || "300");
      const safePageNumber = Number.isFinite(pageNumber) && pageNumber > 0 ? pageNumber : 1;
      const safeDpi = Number.isFinite(dpi) && dpi > 0 ? dpi : 300;

      const rows = [];
      for (const file of files) {
        try {
          const recognition = (await recognizeObjectiveAnswers({
            imagePath: file.path,
            layoutPath: layoutPath(cardId),
            pageNumber: safePageNumber,
            dpi: safeDpi
          })) as ObjectiveRecognitionResult;
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

  app.post("/api/cards/:cardId/grading", recognitionUpload.array("files", 200), async (req, res, next) => {
    try {
      const cardId = safeId(paramValue(req.params.cardId));
      const card = await readCard(cardId);
      if (!card) {
        res.status(404).json({ message: "答题卡不存在" });
        return;
      }

      const files = Array.isArray(req.files) ? req.files : [];
      if (files.length === 0) {
        res.status(400).json({ message: "没有收到答题卡图片" });
        return;
      }

      await readLayout(cardId);
      const pageNumber = Number(fieldValue(req.body.page || req.query.page) || "1");
      const dpi = Number(fieldValue(req.body.dpi || req.query.dpi) || "300");
      const safePageNumber = Number.isFinite(pageNumber) && pageNumber > 0 ? pageNumber : 1;
      const safeDpi = Number.isFinite(dpi) && dpi > 0 ? dpi : 300;

      const rows = [];
      for (const file of files) {
        try {
          const recognition = (await recognizeAnswerCard({
            imagePath: file.path,
            layoutPath: layoutPath(cardId),
            pageNumber: safePageNumber,
            dpi: safeDpi
          })) as CombinedRecognitionResult;
          recognition.subjectiveQuestions = recognition.subjectiveQuestions ?? [];
          rows.push(gradeCombinedRecognition(card, file.originalname || path.basename(file.path), recognition));
        } catch (error) {
          const recognition: CombinedRecognitionResult = {
            status: "failed",
            imagePath: file.path,
            pageNumber: safePageNumber,
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

  app.post("/api/cards/:cardId/assets", upload.single("file"), async (req, res, next) => {
    try {
      const cardId = paramValue(req.params.cardId);
      const card = await readCard(cardId);
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
      const card = await readCard(paramValue(req.params.cardId));
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

  const clientDist = process.env.ANSWER_CARD_CLIENT_DIST
    ? path.resolve(process.env.ANSWER_CARD_CLIENT_DIST)
    : path.join(rootDir, "dist", "client");
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
      console.log(`Answer card designer API running at http://127.0.0.1:${actualPort}`);
      resolve(server);
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startServer();
}
