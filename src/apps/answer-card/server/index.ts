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
import { ExamRepository } from "../../../server/repositories/ExamRepository";
import { AnalysisRepository } from "../../../server/repositories/AnalysisRepository";
import { UserRepository } from "../../../server/repositories/UserRepository";
import authRoutes from "../../../server/routes/auth";
import { createDefaultCard } from "../../../shared/defaultCard";
import { gradeCombinedRecognition, gradeObjectiveRecognition, normalizeObjectiveAnswerKey } from "../../../shared/grading";
import { buildLayout } from "../../../shared/layout";
import type {
  AnswerCard,
  CardSummary,
  CombinedGradingBatchResult,
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

export async function createApp(): Promise<express.Express> {
  const app = express();

  console.log("[Server] 正在初始化数据库...");
  initializeDatabase();
  await ensureDefaultAdmin();
  const cleanupTimer = scheduleCleanup(24, 30);
  cleanupTimer.unref();
  await ensureDataDirs();
  console.log("[Server] 数据库初始化完成");

  app.use(express.json({ limit: "8mb" }));
  app.use("/assets", express.static(assetsDir));
  app.use("/api/auth", authRoutes);

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

  app.post("/api/cards/:cardId/grading/objective", recognitionUpload.array("files", 200), async (req, res, next) => {
    try {
      const cardId = safeId(paramValue(req.params.cardId));
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

      const pageNumber = parsePositiveNumber(req.body.page || req.query.page, 1);
      const dpi = parsePositiveNumber(req.body.dpi || req.query.dpi, 300);
      const currentLayoutPath = await prepareLayoutForCard(cardRepo, card);

      const rows = [];
      for (const file of files) {
        try {
          const recognition = (await recognizeObjectiveAnswers({
            imagePath: file.path,
            layoutPath: currentLayoutPath,
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
      const cardId = safeId(paramValue(req.params.cardId));
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

      const pageNumber = parsePositiveNumber(req.body.page || req.query.page, 1);
      const dpi = parsePositiveNumber(req.body.dpi || req.query.dpi, 300);
      const currentLayoutPath = await prepareLayoutForCard(cardRepo, card);

      // examId support: if provided in form data, persist results to database
      const examIdParam = fieldValue(req.body.examId);
      const examRepo = new ExamRepository();
      const userRepo = new UserRepository();

      let examId: number | null = null;
      if (examIdParam) {
        const exam = examRepo.findExamById(Number(examIdParam));
        if (exam) {
          examId = exam.id;
          examRepo.updateStatus(examId, "grading");
        }
      }

      const rows = [];
      for (const file of files) {
        try {
          const recognition = (await recognizeAnswerCard({
            imagePath: file.path,
            layoutPath: currentLayoutPath,
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

      // Persist to database if examId provided
      let persistResult: { persisted: number; skippedNoStudentId: number } | null = null;
      if (examId && examIdParam) {
        const batchId = examRepo.createScanBatch(examId, `阅卷_${new Date().toLocaleDateString("zh-CN")}`, req.user?.id);

        for (const row of rows) {
          if (!row.studentId) continue;

          // Find or create student
          let student = userRepo.findByStudentNumber(row.studentId);
          if (!student) {
            student = await userRepo.createUser({
              username: row.studentId,
              password: row.studentId,  // simple default, can be changed later
              name: row.studentId,
              role_id: 3,  // student role
              student_number: row.studentId
            });
            if (!student) { student = userRepo.findByStudentNumber(row.studentId)!; }
          }

          // Add scan record
          const recordId = examRepo.addScanRecord({
            batch_id: batchId,
            file_path: row.fileName,
            file_name: row.fileName,
            student_number: row.studentId,
            student_id: student.id
          });

          // Save objective grades
          for (const q of row.questions) {
            examRepo.saveObjectiveGrade(
              recordId, q.questionNumber, "",
              q.score, q.maxScore,
              q.status === "correct" ? 1 : 0
            );
          }

          // Save student total score
          examRepo.saveStudentScore(examId, student.id, row.objectiveScore, row.subjectiveScore);

          // Save question-level scores
          const db = require("../../../server/db").getDatabase();
          const insertQs = db.prepare(`
            INSERT OR REPLACE INTO question_scores
              (exam_id, student_id, question_number, block_id, score, max_score, score_type)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `);

          for (const q of row.questions) {
            insertQs.run(examId, student.id, q.questionNumber, "", q.score, q.maxScore, "objective");
          }
          for (const sq of row.subjectiveQuestions ?? []) {
            insertQs.run(examId, student.id, String(sq.questionNumber), sq.questionId, sq.score, sq.maxScore, "subjective");
          }
        }

        examRepo.finishBatch(batchId);
        examRepo.updateStatus(examId, "closed");
        persistResult = { persisted: rows.filter((r) => r.studentId).length, skippedNoStudentId: rows.filter((r) => !r.studentId).length };
      }

      const result: CombinedGradingBatchResult & { persisted?: typeof persistResult } = {
        batchId: `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        cardId,
        rows
      };

      if (persistResult) {
        Object.assign(result, { persisted: persistResult });
      }

      res.json(result);
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

  // ── Analysis API ──────────────────────────────────────

  app.get("/api/analysis/exams/:examId/overview", async (req, res, next) => {
    try {
      const analysisRepo = new AnalysisRepository();
      const overview = analysisRepo.getExamOverview(Number(req.params.examId));
      res.json(overview);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/analysis/exams/:examId/students", async (req, res, next) => {
    try {
      const analysisRepo = new AnalysisRepository();
      const ranking = analysisRepo.getStudentRanking(Number(req.params.examId));
      res.json(ranking);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/analysis/exams/:examId/questions", async (req, res, next) => {
    try {
      const analysisRepo = new AnalysisRepository();
      const questions = analysisRepo.getQuestionAnalysis(Number(req.params.examId));
      res.json(questions);
    } catch (error) {
      next(error);
    }
  });

  app.use("/api/scanner", createScannerRouter());

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
