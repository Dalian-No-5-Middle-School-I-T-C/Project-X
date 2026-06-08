import express from "express";
import multer from "multer";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import type { AnswerCard } from "../shared/types";
import { createPdf } from "./pdf";
import {
  assetsDir,
  cardAssetsDir,
  createCard,
  ensureDataDirs,
  listCards,
  readCard,
  readLayout,
  rootDir,
  safeId,
  saveCard
} from "./storage";

const app = express();
const port = Number(process.env.PORT ?? 5174);

await ensureDataDirs();

app.use(express.json({ limit: "8mb" }));
app.use("/assets", express.static(assetsDir));

function paramValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] : value ?? "";
}

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
    const card = await readCard(req.params.cardId);
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
    const saved = await saveCard({ ...card, id: safeId(req.params.cardId) });
    res.json(saved);
  } catch (error) {
    next(error);
  }
});

app.get("/api/cards/:cardId/layout", async (req, res, next) => {
  try {
    const layout = await readLayout(req.params.cardId);
    if (!layout) {
      res.status(404).json({ message: "答题卡不存在" });
      return;
    }
    res.json(layout);
  } catch (error) {
    next(error);
  }
});

app.post("/api/cards/:cardId/assets", upload.single("file"), async (req, res, next) => {
  try {
    const card = await readCard(paramValue(req.params.cardId));
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
      url: `/assets/${safeId(paramValue(req.params.cardId))}/${req.file.filename}`
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/cards/:cardId/pdf", async (req, res, next) => {
  try {
    const card = await readCard(req.params.cardId);
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

const clientDist = path.join(rootDir, "dist", "client");
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

app.listen(port, "127.0.0.1", () => {
  console.log(`Answer card designer API running at http://127.0.0.1:${port}`);
});
