import express from "express";
import multer from "multer";
import { cpus } from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { pathToFileURL } from "node:url";
import { ensureDefaultAdmin, initializeDatabase } from "../../../server/db";
import { scheduleCleanup } from "../../../server/db/cleanup";
import { CardRepository } from "../../../server/repositories/CardRepository";
import { ExamRepository } from "../../../server/repositories/ExamRepository";
import { AnalysisRepository } from "../../../server/repositories/AnalysisRepository";
import { UserRepository } from "../../../server/repositories/UserRepository";
import authRoutes from "../../../server/routes/auth";
import userRoutes from "../../../server/routes/users";
import classRoutes from "../../../server/routes/classes";
import scoreRoutes from "../../../server/routes/scores";
import { optionalAuth } from "../../../server/middleware/auth";
import { loadRolePermissions, roleHasPermission, PERMISSIONS } from "../../../server/auth/permissions";
import { createDefaultCard } from "../../../shared/defaultCard";
import { gradeCombinedRecognition, gradeObjectiveRecognition, normalizeObjectiveAnswerKey } from "../../../shared/grading";
import { buildLayout } from "../../../shared/layout";
import type {
  AnswerCard,
  CardSummary,
  CombinedGradingBatchResult,
  CombinedGradingRow,
  CombinedRecognitionResult,
  LayoutDocument,
  ObjectiveGradingBatchResult,
  ObjectiveRecognitionResult
} from "../../../shared/types";
import { createPdf } from "./pdf";
import { recognizeAnswerCard, recognizeObjectiveAnswers } from "./recognition";
import { createScannerRouter } from "./scanner/index";
import { assetsDir, cardAssetsDir, dataDir, ensureDataDirs, layoutPath, rootDir, safeId } from "./storage";

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

function normalizeCard(card: AnswerCard, cardId: string): AnswerCard {
  return {
    ...card,
    id: safeId(cardId),
    bodyBlocks: (card.bodyBlocks ?? []).map((block) =>
      block.type === "objective" ? { ...block, answerKey: normalizeObjectiveAnswerKey(block) } : block
    ),
    paper: { size: "A4", orientation: "portrait" },
    layoutVersion: 1,
    updatedAt: new Date().toISOString()
  };
}

function toCardSummary(row: { id: string; title: string; updated_at?: string; updatedAt?: string }): CardSummary {
  return {
    id: row.id,
    title: row.title || "未命名答题卡",
    updatedAt: row.updatedAt ?? row.updated_at ?? new Date(0).toISOString()
  };
}

async function writeLayoutDocument(cardId: string, layout: LayoutDocument): Promise<void> {
  const targetPath = layoutPath(cardId);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, JSON.stringify(layout, null, 2), "utf8");
}

async function saveCardWithLayout(cardRepo: CardRepository, card: AnswerCard, createdBy?: number): Promise<AnswerCard> {
  const normalized = normalizeCard(card, card.id);
  const layout = buildLayout(normalized);
  const exists = cardRepo.findById(normalized.id);

  if (exists) {
    cardRepo.updateCard(normalized, layout);
  } else {
    cardRepo.createCard(normalized, createdBy);
    cardRepo.updateCard(normalized, layout);
  }

  await writeLayoutDocument(normalized.id, layout);
  return normalized;
}

async function prepareLayoutForCard(cardRepo: CardRepository, card: AnswerCard): Promise<string> {
  const layout = buildLayout(card);
  cardRepo.updateLayoutData(card.id, layout);
  await writeLayoutDocument(card.id, layout);
  return layoutPath(card.id);
}

function parsePositiveNumber(value: unknown, fallback: number): number {
  const parsed = Number(fieldValue(value) || String(fallback));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function gradingPreviewUrl(cardId: string, imagePath?: string): string | undefined {
  if (!imagePath) return undefined;
  return `/api/cards/${encodeURIComponent(cardId)}/grading/preview/${encodeURIComponent(path.basename(imagePath))}`;
}

type GradingProgressEvent = {
  type: "start" | "progress" | "done" | "error";
  batchId: string;
  finished: number;
  total: number;
};

const gradingProgressListeners = new Map<string, Set<(event: GradingProgressEvent) => void>>();
const gradingProgressSnapshots = new Map<string, GradingProgressEvent>();

function recognitionConcurrency(): number {
  const configured = Number(process.env.ANSWER_CARD_RECOGNITION_CONCURRENCY);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.max(1, Math.floor(configured));
  }
  return Math.min(4, Math.max(2, Math.floor(cpus().length / 2)));
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex++;
        results[currentIndex] = await worker(items[currentIndex], currentIndex);
      }
    })
  );
  return results;
}

function emitGradingProgress(event: GradingProgressEvent): void {
  gradingProgressSnapshots.set(event.batchId, event);
  const listeners = gradingProgressListeners.get(event.batchId);
  if (listeners) {
    for (const listener of listeners) listener(event);
  }
  if (event.type === "done" || event.type === "error") {
    gradingProgressListeners.delete(event.batchId);
    setTimeout(() => gradingProgressSnapshots.delete(event.batchId), 60_000).unref();
  }
}

/** Background persistence: save grading results to database without blocking response */
async function persistGradingResults(
  examIdParam: string,
  rows: CombinedGradingRow[],
  createdBy?: number
): Promise<void> {
  const { ExamRepository } = await import("../../../server/repositories/ExamRepository");
  const { getDatabase } = await import("../../../server/db");

  const examRepo = new ExamRepository();
  const db = getDatabase();

  const examId = Number(examIdParam);
  const exam = examRepo.findExamById(examId);
  if (!exam) return;

  examRepo.updateStatus(examId, "grading");
  const batchId = examRepo.createScanBatch(examId, `阅卷_${new Date().toLocaleDateString("zh-CN")}`, createdBy);

  const ensureStudent = db.prepare(`
    INSERT OR IGNORE INTO users (username, password_hash, name, role_id, student_number)
    VALUES (?, '', ?, 3, ?)
  `);
  const findStudent = db.prepare(`
    SELECT id FROM users WHERE student_number = ? AND role_id = 3 LIMIT 1
  `);

  const insertQs = db.prepare(`
    INSERT OR REPLACE INTO question_scores
      (exam_id, student_id, question_number, block_id, score, max_score, score_type)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  let persisted = 0;

  const persistTx = db.transaction(() => {
    for (const row of rows) {
      if (!row.studentId) continue;
      try {
        // Synchronous: ensure student exists
        ensureStudent.run(row.studentId, row.studentId, row.studentId);
        const stu = findStudent.get(row.studentId) as { id: number } | undefined;
        if (!stu) continue;

        // Add scan record
        examRepo.addScanRecord({
          batch_id: batchId,
          file_path: row.fileName,
          file_name: row.fileName,
          student_number: row.studentId,
          student_id: stu.id
        });

        // Save total score
        examRepo.saveStudentScore(examId, stu.id, row.objectiveScore, row.subjectiveScore);

        // Save per-question scores
        for (const q of row.questions) {
          insertQs.run(examId, stu.id, q.questionNumber, "", q.score, q.maxScore, "objective");
        }
        for (const sq of row.subjectiveQuestions ?? []) {
          insertQs.run(examId, stu.id, String(sq.questionNumber), sq.questionId, sq.score, sq.maxScore, "subjective");
        }
        persisted++;
      } catch (err) {
        console.error(`[Grading] Failed to persist row for ${row.studentId}:`, err);
      }
    }
  });

  persistTx();
  examRepo.finishBatch(batchId);
  examRepo.updateStatus(examId, "closed");
  console.log(`[Grading] Persisted ${persisted} student scores to exam ${examId}`);
}

/**
 * 业务路由的 RBAC 网关。
 *
 * 兼容性设计：通过环境变量 PROJECTX_AUTH_ENFORCE 控制是否强制鉴权。
 *  - 关闭（默认）：仅 optionalAuth 解析用户（用于 created_by），不拦截，保持 v1.0 前端无登录可用；
 *  - 开启（=1/true）：未登录返回 401，权限不足返回 403。
 * GET/HEAD 走 readPerm，写操作走 writePerm。
 */
function makeGate(enforce: boolean, readPerm: string, writePerm: string) {
  return (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    if (!enforce) {
      next();
      return;
    }
    if (!req.user) {
      res.status(401).json({ message: "未提供认证令牌" });
      return;
    }
    const required = req.method === "GET" || req.method === "HEAD" ? readPerm : writePerm;
    if (!roleHasPermission(req.user.role_id, required)) {
      res.status(403).json({ message: `权限不足：缺少 ${required}` });
      return;
    }
    next();
  };
}

export async function createApp(): Promise<express.Express> {
  const app = express();

  console.log("[Server] 正在初始化数据库...");
  initializeDatabase();
  await ensureDefaultAdmin();
  loadRolePermissions(true); // 预热角色权限缓存
  const cleanupTimer = scheduleCleanup(24, 30);
  cleanupTimer.unref();
  await ensureDataDirs();
  console.log("[Server] 数据库初始化完成");

  const enforceAuth =
    process.env.PROJECTX_AUTH_ENFORCE === "1" || process.env.PROJECTX_AUTH_ENFORCE === "true";
  console.log(`[Server] RBAC 鉴权强制模式: ${enforceAuth ? "开启" : "关闭（仅解析身份）"}`);

  app.use(express.json({ limit: "8mb" }));
  app.use("/assets", express.static(assetsDir));

  // 在所有 /api 路由前解析身份（有 token 即挂载 req.user，无 token 放行）
  app.use("/api", optionalAuth);

  // 认证与账号控制系统路由
  app.use("/api/auth", authRoutes);
  app.use("/api/users", userRoutes);
  app.use("/api/classes", classRoutes);
  app.use("/api/scores", scoreRoutes);

  // 业务路由 RBAC 网关
  const cardGate = makeGate(enforceAuth, PERMISSIONS.CARD_READ, PERMISSIONS.GRADE_WRITE);
  const examGate = makeGate(enforceAuth, PERMISSIONS.EXAM_READ, PERMISSIONS.EXAM_WRITE);
  const analysisGate = makeGate(enforceAuth, PERMISSIONS.GRADE_READ, PERMISSIONS.GRADE_READ);
  const scannerGate = makeGate(enforceAuth, PERMISSIONS.GRADE_WRITE, PERMISSIONS.GRADE_WRITE);
  app.use("/api/cards", cardGate);
  app.use("/api/exams", examGate);
  app.use("/api/analysis", analysisGate);

  const cardRepo = new CardRepository();

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
      res.json(cardRepo.listCards().map(toCardSummary));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/cards", async (req, res, next) => {
    try {
      const card = createDefaultCard(String(Date.now()));
      const saved = await saveCardWithLayout(cardRepo, card, req.user?.id);
      res.status(201).json(saved);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/cards/:cardId", async (req, res, next) => {
    try {
      const card = cardRepo.findById(safeId(paramValue(req.params.cardId)));
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
      const card = normalizeCard(req.body as AnswerCard, paramValue(req.params.cardId));
      const saved = await saveCardWithLayout(cardRepo, card, req.user?.id);
      res.json(saved);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/cards/:cardId/layout", async (req, res, next) => {
    try {
      const card = cardRepo.findById(safeId(paramValue(req.params.cardId)));
      if (!card) {
        res.status(404).json({ message: "答题卡不存在" });
        return;
      }
      const layout = buildLayout(card);
      cardRepo.updateLayoutData(card.id, layout);
      await writeLayoutDocument(card.id, layout);
      res.json(layout);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/cards/:cardId/recognition/objective", recognitionUpload.single("file"), async (req, res, next) => {
    try {
      const cardId = safeId(paramValue(req.params.cardId));
      const card = cardRepo.findById(cardId);
      if (!card) {
        res.status(404).json({ message: "答题卡不存在" });
        return;
      }
      if (!req.file) {
        res.status(400).json({ message: "没有收到答题卡图片" });
        return;
      }

      const pageNumber = parsePositiveNumber(req.body.page || req.query.page, 1);
      const dpi = parsePositiveNumber(req.body.dpi || req.query.dpi, 300);
      const debug = boolField(req.body.debug || req.query.debug);
      const debugDir = debug ? path.join(dataDir, "processed", "recognition-debug", cardId, String(Date.now())) : undefined;
      if (debugDir) {
        await mkdir(debugDir, { recursive: true });
      }

      const result = await recognizeObjectiveAnswers({
        imagePath: req.file.path,
        layoutPath: await prepareLayoutForCard(cardRepo, card),
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
      const cardId = safeId(paramValue(req.params.cardId));
      const card = cardRepo.findById(cardId);
      if (!card) {
        res.status(404).json({ message: "答题卡不存在" });
        return;
      }
      if (!req.file) {
        res.status(400).json({ message: "没有收到答题卡图片" });
        return;
      }

      const pageNumber = parsePositiveNumber(req.body.page || req.query.page, 1);
      const dpi = parsePositiveNumber(req.body.dpi || req.query.dpi, 300);
      const debug = boolField(req.body.debug || req.query.debug);
      const debugDir = debug ? path.join(dataDir, "processed", "recognition-debug", cardId, String(Date.now())) : undefined;
      if (debugDir) {
        await mkdir(debugDir, { recursive: true });
      }

      const result = await recognizeAnswerCard({
        imagePath: req.file.path,
        layoutPath: await prepareLayoutForCard(cardRepo, card),
        pageNumber,
        dpi,
        debugDir
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/cards/:cardId/grading/progress/:batchId", (req, res) => {
    const batchId = safeId(paramValue(req.params.batchId));

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });

    const handler = (event: GradingProgressEvent) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (event.type === "done" || event.type === "error") {
        res.end();
      }
    };

    if (!gradingProgressListeners.has(batchId)) {
      gradingProgressListeners.set(batchId, new Set());
    }
    gradingProgressListeners.get(batchId)!.add(handler);

    const snapshot = gradingProgressSnapshots.get(batchId);
    if (snapshot) {
      handler(snapshot);
    }

    req.on("close", () => {
      const listeners = gradingProgressListeners.get(batchId);
      if (listeners) {
        listeners.delete(handler);
        if (listeners.size === 0) gradingProgressListeners.delete(batchId);
      }
    });
  });

  app.post("/api/cards/:cardId/grading/objective", recognitionUpload.array("files"), async (req, res, next) => {
    let progressId = "";
    try {
      const cardId = safeId(paramValue(req.params.cardId));
      progressId = safeId(fieldValue(req.body.progressId));
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

      // Single-sided card: filter out back-side images
      const backSidePattern = /B\.(jpg|jpeg|png|bmp|tiff|tif)$/i;
      const gradingFiles = card.sided === "single"
        ? files.filter((f) => !backSidePattern.test(f.originalname))
        : files;

      const pageNumber = parsePositiveNumber(req.body.page || req.query.page, 1);
      const dpi = parsePositiveNumber(req.body.dpi || req.query.dpi, 300);
      const currentLayoutPath = await prepareLayoutForCard(cardRepo, card);

      let finished = 0;
      if (progressId) {
        emitGradingProgress({ type: "start", batchId: progressId, finished, total: gradingFiles.length });
      }

      const rows = await mapWithConcurrency(gradingFiles, recognitionConcurrency(), async (file) => {
        try {
          const recognition = (await recognizeObjectiveAnswers({
            imagePath: file.path,
            layoutPath: currentLayoutPath,
            pageNumber,
            dpi
          })) as ObjectiveRecognitionResult;
          return {
            ...gradeObjectiveRecognition(card, file.originalname || path.basename(file.path), recognition),
            previewUrl: gradingPreviewUrl(cardId, file.path)
          };
        } catch (error) {
          const recognition: ObjectiveRecognitionResult = {
            status: "failed",
            imagePath: file.path,
            pageNumber,
            message: error instanceof Error ? error.message : String(error),
            questions: []
          };
          return {
            ...gradeObjectiveRecognition(card, file.originalname || path.basename(file.path), recognition),
            previewUrl: gradingPreviewUrl(cardId, file.path)
          };
        } finally {
          finished++;
          if (progressId) {
            emitGradingProgress({ type: "progress", batchId: progressId, finished, total: gradingFiles.length });
          }
        }
      });

      if (progressId) {
        emitGradingProgress({ type: "done", batchId: progressId, finished, total: gradingFiles.length });
      }

      const result: ObjectiveGradingBatchResult = {
        batchId: `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        cardId,
        rows
      };
      res.json(result);
    } catch (error) {
      if (progressId) {
        const snapshot = gradingProgressSnapshots.get(progressId);
        emitGradingProgress({
          type: "error",
          batchId: progressId,
          finished: snapshot?.finished ?? 0,
          total: snapshot?.total ?? 0
        });
      }
      next(error);
    }
  });

  app.post("/api/cards/:cardId/grading", recognitionUpload.array("files"), async (req, res, next) => {
    let progressId = "";
    try {
      const cardId = safeId(paramValue(req.params.cardId));
      progressId = safeId(fieldValue(req.body.progressId));
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

      // Single-sided card: filter out back-side images
      const backSidePattern = /B\.(jpg|jpeg|png|bmp|tiff|tif)$/i;
      const gradingFiles = card.sided === "single"
        ? files.filter((f) => !backSidePattern.test(f.originalname))
        : files;

      const pageNumber = parsePositiveNumber(req.body.page || req.query.page, 1);
      const dpi = parsePositiveNumber(req.body.dpi || req.query.dpi, 300);
      const currentLayoutPath = await prepareLayoutForCard(cardRepo, card);

      const examIdParam = fieldValue(req.body.examId);

      let finished = 0;
      if (progressId) {
        emitGradingProgress({ type: "start", batchId: progressId, finished, total: gradingFiles.length });
      }

      const rows = await mapWithConcurrency(gradingFiles, recognitionConcurrency(), async (file) => {
        try {
          const recognition = (await recognizeAnswerCard({
            imagePath: file.path,
            layoutPath: currentLayoutPath,
            pageNumber,
            dpi
          })) as CombinedRecognitionResult;
          recognition.subjectiveQuestions = recognition.subjectiveQuestions ?? [];
          return {
            ...gradeCombinedRecognition(card, file.originalname || path.basename(file.path), recognition),
            previewUrl: gradingPreviewUrl(cardId, file.path)
          };
        } catch (error) {
          const recognition: CombinedRecognitionResult = {
            status: "failed",
            imagePath: file.path,
            pageNumber,
            message: error instanceof Error ? error.message : String(error),
            questions: [],
            subjectiveQuestions: []
          };
          return {
            ...gradeCombinedRecognition(card, file.originalname || path.basename(file.path), recognition),
            previewUrl: gradingPreviewUrl(cardId, file.path)
          };
        } finally {
          finished++;
          if (progressId) {
            emitGradingProgress({ type: "progress", batchId: progressId, finished, total: gradingFiles.length });
          }
        }
      });

      if (progressId) {
        emitGradingProgress({ type: "done", batchId: progressId, finished, total: gradingFiles.length });
      }

      // Send response immediately so user sees results
      const result: CombinedGradingBatchResult = {
        batchId: `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        cardId,
        rows
      };
      res.json(result);

      // Persist to database asynchronously (non-blocking)
      if (examIdParam) {
        persistGradingResults(examIdParam, rows, req.user?.id).catch((err) => {
          console.error("[Grading] Persist failed:", err);
        });
      }
    } catch (error) {
      if (progressId) {
        const snapshot = gradingProgressSnapshots.get(progressId);
        emitGradingProgress({
          type: "error",
          batchId: progressId,
          finished: snapshot?.finished ?? 0,
          total: snapshot?.total ?? 0
        });
      }
      next(error);
    }
  });

  app.get("/api/cards/:cardId/grading/preview/:fileName", (req, res, next) => {
    try {
      const cardId = safeId(paramValue(req.params.cardId));
      const fileName = path.basename(paramValue(req.params.fileName));
      const targetPath = path.join(dataDir, "recognition", "uploads", cardId, fileName);
      if (!existsSync(targetPath)) {
        res.status(404).json({ message: "答题卡图片不存在" });
        return;
      }
      res.sendFile(targetPath);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/cards/:cardId/assets", upload.single("file"), async (req, res, next) => {
    try {
      const cardId = safeId(paramValue(req.params.cardId));
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
        url: `/assets/${cardId}/${req.file.filename}`
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/cards/:cardId/pdf", async (req, res, next) => {
    try {
      const card = cardRepo.findById(safeId(paramValue(req.params.cardId)));
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

  // ── Exam API ──────────────────────────────────────────

  app.get("/api/exams", async (_req, res, next) => {
    try {
      const examRepo = new ExamRepository();
      res.json(examRepo.listExams());
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/exams", async (req, res, next) => {
    try {
      const { name, cardId, gradeId, classId, subject } = req.body as Record<string, unknown>;
      if (!name || !cardId) {
        res.status(400).json({ message: "缺少 name 或 cardId" });
        return;
      }
      const examRepo = new ExamRepository();
      const exam = examRepo.createExam({
        name: String(name),
        card_id: String(cardId),
        grade_id: gradeId ? Number(gradeId) : undefined,
        class_id: classId ? Number(classId) : undefined,
        subject: subject ? String(subject) : undefined,
        created_by: req.user?.id
      });
      res.status(201).json(exam);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/exams/:examId", async (req, res, next) => {
    try {
      const examRepo = new ExamRepository();
      const exam = examRepo.findExamById(Number(req.params.examId));
      if (!exam) {
        res.status(404).json({ message: "考试不存在" });
        return;
      }
      const results = examRepo.getExamResults(exam.id);
      res.json({ ...exam, results });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/exams/:examId", async (req, res, next) => {
    try {
      const examRepo = new ExamRepository();
      const exam = examRepo.findExamById(Number(req.params.examId));
      if (!exam) {
        res.status(404).json({ message: "考试不存在" });
        return;
      }
      const { getDatabase } = await import("../../../server/db");
      const db = getDatabase();
      // Cascade: scores → students linked via scores, then exam itself
      db.transaction(() => {
        db.prepare("DELETE FROM question_scores WHERE exam_id = ?").run(exam.id);
        db.prepare("DELETE FROM student_scores WHERE exam_id = ?").run(exam.id);
        db.prepare("DELETE FROM scan_batches WHERE exam_id = ?").run(exam.id);
        db.prepare("DELETE FROM exams WHERE id = ?").run(exam.id);
      })();
      res.json({ message: "已删除" });
    } catch (error) {
      next(error);
    }
  });

  // ── Analysis API ──────────────────────────────────────

  app.get("/api/analysis/exams/:examId/classes", async (req, res, next) => {
    try {
      const analysisRepo = new AnalysisRepository();
      const classes = analysisRepo.getExamClasses(Number(req.params.examId));
      res.json(classes);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/analysis/exams/:examId/overview", async (req, res, next) => {
    try {
      const analysisRepo = new AnalysisRepository();
      const classId = req.query.classId ? Number(req.query.classId) : undefined;
      const overview = analysisRepo.getExamOverview(Number(req.params.examId), classId);
      res.json(overview);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/analysis/exams/:examId/students", async (req, res, next) => {
    try {
      const analysisRepo = new AnalysisRepository();
      const classId = req.query.classId ? Number(req.query.classId) : undefined;
      const ranking = analysisRepo.getStudentRanking(Number(req.params.examId), classId);
      res.json(ranking);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/analysis/exams/:examId/questions", async (req, res, next) => {
    try {
      const analysisRepo = new AnalysisRepository();
      const classId = req.query.classId ? Number(req.query.classId) : undefined;
      const questions = analysisRepo.getQuestionAnalysis(Number(req.params.examId), classId);
      res.json(questions);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/analysis/exams/:examId/export-csv", async (req, res, next) => {
    try {
      const analysisRepo = new AnalysisRepository();
      const classId = req.query.classId ? Number(req.query.classId) : undefined;
      const examId = Number(req.params.examId);

      const { students, questionHeaders } = analysisRepo.getExportData(examId, classId);

      // Build header row
      const header = ["班级", "考号", "姓名", "成绩", "班级排名", "年级排名", "客观题成绩", "主观题成绩", ...questionHeaders];

      // Build CSV lines
      const csvEscape = (v: unknown): string => {
        const s = v === "" || v === null || v === undefined ? "" : String(v);
        if (s.includes(",") || s.includes("\"") || s.includes("\n")) {
          return `"${s.replace(/"/g, '""')}"`;
        }
        return s;
      };

      const lines = [
        header.map((h) => csvEscape(h)).join(","),
        ...students.map((s) => [
          csvEscape(s.className),
          csvEscape(s.studentNumber),
          csvEscape(s.name),
          csvEscape(s.totalScore),
          csvEscape(s.classRank),
          csvEscape(s.gradeRank),
          csvEscape(s.objectiveScore),
          csvEscape(s.subjectiveScore),
          ...s.questionScores.map((qs) => csvEscape(qs))
        ].join(","))
      ];

      const csv = "\uFEFF" + lines.join("\n");

      // Get exam name for the filename
      const exam = analysisRepo.getExam(examId);
      const filename = `${exam?.name ?? "成绩表"}_${classId ? "班级" : "年级"}.csv`;

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(filename)}"`);
      res.send(csv);
    } catch (error) {
      next(error);
    }
  });

  app.use("/api/scanner", scannerGate, createScannerRouter());

  const clientDist = process.env.ANSWER_CARD_CLIENT_DIST
    ? path.resolve(process.env.ANSWER_CARD_CLIENT_DIST)
    : path.join(rootDir, "dist", "client");
  if (existsSync(clientDist)) {
    app.use(
      express.static(clientDist, {
        setHeaders: (res, filePath) => {
          const ext = path.extname(filePath).toLowerCase();
          if (ext === ".html" || ext === ".js" || ext === ".mjs" || ext === ".css" || ext === ".json") {
            const type = res.getHeader("Content-Type") as string | undefined;
            if (type && !type.toLowerCase().includes("charset")) {
              res.setHeader("Content-Type", `${type}; charset=utf-8`);
            }
          }
        }
      })
    );
    app.get("/{*splat}", (_req, res) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
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
