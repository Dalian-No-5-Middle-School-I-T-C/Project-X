import express from "express";
import multer from "multer";
import { cpus } from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";
import { ensureDefaultAdmin, getDatabase, initializeDatabase } from "../../../server/db";
import { scheduleCleanup } from "../../../server/db/cleanup";
import { CardRepository } from "../../../server/repositories/CardRepository";
import { ExamRepository } from "../../../server/repositories/ExamRepository";
import { AnalysisRepository } from "../../../server/repositories/AnalysisRepository";
import { UserRepository } from "../../../server/repositories/UserRepository";
import { AssignedScoreService } from "../../../server/services/AssignedScoreService";
import type { AssignedFormula } from "../../../shared/types";
import authRoutes from "../../../server/routes/auth";
import userRoutes from "../../../server/routes/users";
import classRoutes from "../../../server/routes/classes";
import teacherRoutes from "../../../server/routes/teachers";
import exportRoutes from "../../../server/routes/export";
import scoreRoutes from "../../../server/routes/scores";
import sponsorRoutes from "../../../server/routes/sponsor";
import backupRoutes from "../../../server/routes/backup";
import exportScoresRoutes from "../../../server/routes/export-scores";
import aiProviderRoutes from "../../../server/routes/ai-providers";
import { optionalAuth } from "../../../server/middleware/auth";
import { loadRolePermissions, roleHasPermission, PERMISSIONS } from "../../../server/auth/permissions";
import { createDefaultCard, generateCardId } from "../../../shared/defaultCard";
import { applySubjectTemplate } from "../../../shared/cardTemplates";
import { gradeCombinedRecognition, gradeObjectiveRecognition, normalizeObjectiveAnswerKey, normalizeObjectiveQuestions } from "../../../shared/grading";
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

const EXAM_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MIN_EXAM_YEAR = 1900;
const MAX_EXAM_YEAR = 2100;

function isValidExamDate(value: string | undefined): boolean {
  if (!value) return false;
  const match = EXAM_DATE_PATTERN.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < MIN_EXAM_YEAR || year > MAX_EXAM_YEAR || month < 1 || month > 12 || day < 1) {
    return false;
  }

  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function normalizeCard(card: AnswerCard, cardId: string): AnswerCard {
  const examDate = fieldValue((card as any).examDate ?? card.examDate).trim();
  return {
    ...card,
    id: safeId(cardId),
    subjectLabel: (card as any).subjectLabel ?? card.subjectLabel ?? undefined,
    examDate: isValidExamDate(examDate) ? examDate : undefined,
    bodyBlocks: (card.bodyBlocks ?? []).map((block) => {
      if (block.type !== "objective") return block;
      const answerKey = normalizeObjectiveAnswerKey(block);
      const normalizedBlock = { ...block, answerKey };
      return { ...normalizedBlock, questions: normalizeObjectiveQuestions(normalizedBlock) };
    }),
    paper: { size: "A4", orientation: "portrait" },
    layoutVersion: 1,
    updatedAt: new Date().toISOString()
  };
}

function toCardSummary(row: { id: string; title: string; updated_at?: string; updatedAt?: string; subject?: string; subject_label?: string; exam_date?: string }): CardSummary {
  return {
    id: row.id,
    title: row.title || "未命名答题卡",
    subject: (row as any).subject ?? undefined,
    subjectLabel: (row as any).subject_label ?? undefined,
    examDate: (row as any).exam_date ?? undefined,
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

function requestFlag(value: unknown): boolean {
  return value === true || boolField(value);
}

function deleteExamRows(db: ReturnType<typeof getDatabase>, examIds: number[]): void {
  for (const examId of examIds) {
    db.prepare("DELETE FROM question_scores WHERE exam_id = ?").run(examId);
    db.prepare("DELETE FROM student_scores WHERE exam_id = ?").run(examId);
    db.prepare("DELETE FROM scan_batches WHERE exam_id = ?").run(examId);
    db.prepare("DELETE FROM exams WHERE id = ?").run(examId);
  }
}

async function deleteCardFiles(cardId: string): Promise<void> {
  const cardJsonPath = path.join(dataDir, "cards", `${cardId}.json`);
  const layoutJsonPath = layoutPath(cardId);
  const assetsPath = cardAssetsDir(cardId);
  try { if (existsSync(cardJsonPath)) await rm(cardJsonPath); } catch {}
  try { if (existsSync(layoutJsonPath)) await rm(layoutJsonPath); } catch {}
  try { if (existsSync(assetsPath)) await rm(assetsPath, { recursive: true, force: true }); } catch {}
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
  const { getDatabase, hashPassword } = await import("../../../server/db");

  const examRepo = new ExamRepository();
  const db = getDatabase();

  const examId = Number(examIdParam);
  const exam = examRepo.findExamById(examId);
  if (!exam) return;

  examRepo.updateStatus(examId, "grading");
  const batchId = examRepo.createScanBatch(examId, `阅卷_${new Date().toLocaleDateString("zh-CN")}`, createdBy);

  const ensureStudent = db.prepare(`
    INSERT OR IGNORE INTO users (username, password_hash, name, role_id, student_number)
    VALUES (?, ?, ?, 3, ?)
  `);
  const updateBlankStudentPassword = db.prepare(`
    UPDATE users
    SET password_hash = ?, updated_at = CURRENT_TIMESTAMP
    WHERE student_number = ? AND role_id = 3 AND password_hash = ''
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
  const studentPasswordHashes = new Map<string, string>();
  for (const row of rows) {
    if (row.studentId && !studentPasswordHashes.has(row.studentId)) {
      studentPasswordHashes.set(row.studentId, await hashPassword(row.studentId));
    }
  }

  const persistTx = db.transaction(() => {
    for (const row of rows) {
      if (!row.studentId) continue;
      try {
        // Synchronous: ensure student exists
        const studentPasswordHash = studentPasswordHashes.get(row.studentId) ?? "";
        ensureStudent.run(row.studentId, studentPasswordHash, row.studentId, row.studentId);
        updateBlankStudentPassword.run(studentPasswordHash, row.studentId);
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

/**
 * 根据当前用户的教师角色和所教班级，返回可见的考试ID列表。
 * - admin / grade_leader → 全部可见（返回 null）
 * - head_teacher → 只看自己班级的考试（全科目，本年级）
 * - subject_teacher → 只看自己教的科目 + 自己教的班级
 * - 普通 teacher（无 teacher_role）→ 全部可见（向后兼容）
 */
function getVisibleExamIds(user: express.Request["user"]): number[] | null {
  if (!user || user.role_name === "admin") return null;
  if (user.role_name !== "teacher") return null;
  if (!user.teacher_role) return null; // 普通教师向后兼容，全部可见

  if (user.teacher_role === "grade_leader") return null; // 学年主任全可见

  const db = getDatabase();

  if (user.teacher_role === "head_teacher") {
    // 班主任：只看自己班级的考试
    const classIds = db.prepare(
      "SELECT class_id FROM teacher_classes WHERE teacher_id = ?"
    ).all(user.id).map((r: any) => r.class_id) as number[];
    if (classIds.length === 0) return [];
    const rows = db.prepare(
      `SELECT DISTINCT e.id FROM exams e
       JOIN classes c ON c.id = e.class_id
       WHERE e.class_id IN (${classIds.map(() => "?").join(",")})`
    ).all(...classIds) as Array<{ id: number }>;
    return rows.map((r) => r.id);
  }

  if (user.teacher_role === "subject_teacher") {
    // 学科老师：只看本科目+所教班级
    if (!user.subject) return [];
    const classIds = db.prepare(
      "SELECT class_id FROM teacher_classes WHERE teacher_id = ? AND (subject = ? OR subject IS NULL)"
    ).all(user.id, user.subject).map((r: any) => r.class_id) as number[];
    if (classIds.length === 0) return [];
    const rows = db.prepare(
      `SELECT DISTINCT e.id FROM exams e
       WHERE e.subject = ? AND e.class_id IN (${classIds.map(() => "?").join(",")})`
    ).all(user.subject, ...classIds) as Array<{ id: number }>;
    return rows.map((r) => r.id);
  }

  return null;
}

/**
 * 中间件：验证当前用户有权访问指定的 examId。
 * 在 analysis / exams/:examId 路由之前使用。
 *
 * 如果 req.user 不存在（未登录/未强制鉴权），放行通过。
 */
function requireExamAccess(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!req.user) {
    next(); // 未登录时放行（makeGate 已处理 auth 强制逻辑）
    return;
  }
  const examId = Number(req.params.examId);
  if (!examId) {
    res.status(400).json({ message: "缺少 examId" });
    return;
  }
  const visibleIds = getVisibleExamIds(req.user);
  if (visibleIds === null) {
    next(); // 全部可见
    return;
  }
  if (visibleIds.includes(examId)) {
    next();
    return;
  }
  res.status(403).json({ message: "权限不足：无权访问此考试" });
}

function scannerEnabled(): boolean {
  if (process.env.PROJECTX_ENABLE_SCANNER === "1" || process.env.PROJECTX_ENABLE_SCANNER === "true") {
    return true;
  }
  if (process.env.PROJECTX_ENABLE_SCANNER === "0" || process.env.PROJECTX_ENABLE_SCANNER === "false") {
    return false;
  }
  return process.env.PROJECTX_VARIANT === "teacher-scanner" || !process.env.PROJECTX_VARIANT;
}

function llmClientUrl(pathname = ""): string {
  const base = (process.env.LLMCLIENT_URL || "http://127.0.0.1:8766").replace(/\/+$/, "");
  return `${base}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
}

function llmClientHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...(extra ?? {}) };
  const internalKey = process.env.LLMCLIENT_INTERNAL_API_KEY;
  if (internalKey && !headers.Authorization) {
    headers.Authorization = `Bearer ${internalKey}`;
  }
  return headers;
}

async function fetchLlmClient(pathname: string, init?: RequestInit, timeoutMs = 5_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(llmClientUrl(pathname), {
      ...init,
      headers: llmClientHeaders(init?.headers ? Object.fromEntries(new Headers(init.headers).entries()) : undefined),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
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
  app.use("/api/teachers", teacherRoutes);
  app.use("/api/export", exportRoutes);
  app.use("/api/export", exportScoresRoutes);
  app.use("/api/scores", scoreRoutes);
  app.use("/api/sponsor", sponsorRoutes);
  app.use("/api/db", backupRoutes);
  app.use("/api/ai/providers", aiProviderRoutes);
  console.log("[Server] v1.2.1 routes mounted: /api/teachers, /api/export, /api/users/import-csv, /api/analysis/ai");

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
      const subject = (req.body?.subject ?? "").trim();
      const title = (req.body?.title ?? "").trim();
      const subjectLabel = (req.body?.subjectLabel ?? "").trim();
      const examDate = (req.body?.examDate ?? "").trim();
      const englishListening = req.body?.englishListening !== false;
      const chineseChoicePlacement = req.body?.chineseChoicePlacement === "inline" ? "inline" : "front";
      if (!subject) {
        res.status(400).json({ error: "科目（subject）为必填项" });
        return;
      }
      if (!title) {
        res.status(400).json({ error: "考试名称为必填项" });
        return;
      }
      if (!isValidExamDate(examDate)) {
        res.status(400).json({ error: `考试时间为必填项，需为 ${MIN_EXAM_YEAR}-${MAX_EXAM_YEAR} 范围内的有效日期（YYYY-MM-DD）` });
        return;
      }
      let id = generateCardId(subject);
      let retry = 0;
      while (cardRepo.findById(id) && retry < 100) {
        id = generateCardId(subject + "_" + String(retry++));
      }
      let card = createDefaultCard(id, subject);
      card.title = title;
      card.subjectLabel = subjectLabel || undefined;
      card.examDate = examDate;
      card = applySubjectTemplate(card, { englishListening, chineseChoicePlacement });
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
      const examDate = fieldValue((req.body as AnswerCard)?.examDate).trim();
      if (examDate && !isValidExamDate(examDate)) {
        res.status(400).json({ message: `考试时间需为 ${MIN_EXAM_YEAR}-${MAX_EXAM_YEAR} 范围内的有效日期（YYYY-MM-DD）` });
        return;
      }
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

  // ── 答题卡导出/导入/删除 ──────────────────────────────

  // DELETE: 删除答题卡
  app.delete("/api/cards/:cardId", async (req, res, next) => {
    try {
      const cardId = safeId(paramValue(req.params.cardId));
      const card = cardRepo.findById(cardId);
      if (!card) {
        res.status(404).json({ message: "答题卡不存在" });
        return;
      }
      // 检查是否被考试引用
      const examRepo = new ExamRepository();
      const exams = examRepo.listExams();
      const referenced = exams.filter((e: any) => e.card_id === cardId);
      if (referenced.length > 0) {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const unlinkExams = requestFlag(body.unlinkExams);
        const deleteReferencedExams = requestFlag(body.deleteReferencedExams);
        if (!unlinkExams && !deleteReferencedExams) {
          res.status(409).json({
            message: `无法直接删除答题卡：已被 ${referenced.length} 个考试引用`,
            referencedExamCount: referenced.length,
            referencedExamNames: referenced.map((e: any) => e.name)
          });
          return;
        }
        const db = getDatabase();
        db.transaction(() => {
          if (deleteReferencedExams) {
            deleteExamRows(db, referenced.map((e: any) => Number(e.id)));
          } else {
            db.prepare("UPDATE exams SET card_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE card_id = ?").run(cardId);
          }
          cardRepo.deleteCard(cardId);
        })();
        await deleteCardFiles(cardId);
        res.json({
          ok: true,
          deleted: true,
          unlinkedExamCount: deleteReferencedExams ? 0 : referenced.length,
          deletedExamCount: deleteReferencedExams ? referenced.length : 0,
          referencedExamCount: referenced.length,
          referencedExamNames: referenced.map((e: any) => e.name)
        });
        return;
      }
      // 删除 SQLite 记录（外键 CASCADE 自动删子表）
      const deleted = cardRepo.deleteCard(cardId);
      // 删除 JSON 文件
      await deleteCardFiles(cardId);
      res.json({
        ok: true,
        deleted,
        referencedExamCount: referenced.length,
        referencedExamNames: referenced.map((e: any) => e.name)
      });
    } catch (error) {
      next(error);
    }
  });

  // GET: 导出答题卡（含答案 + assets base64）
  app.get("/api/cards/:cardId/export", async (req, res, next) => {
    try {
      const cardId = safeId(paramValue(req.params.cardId));
      const card = cardRepo.findById(cardId);
      if (!card) {
        res.status(404).json({ message: "答题卡不存在" });
        return;
      }
      const layout = cardRepo.getLayoutData(cardId);
      // 收集 assets base64
      const assetsMap: Record<string, string> = {};
      const assetsPath = cardAssetsDir(cardId);
      if (existsSync(assetsPath)) {
        const { readdir } = await import("node:fs/promises");
        const files = await readdir(assetsPath);
        for (const file of files) {
          try {
            const data = await readFile(path.join(assetsPath, file));
            assetsMap[file] = data.toString("base64");
          } catch {}
        }
      }
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(card.title || cardId)}.projectx-card.json`
      );
      res.json({
        format: "projectx-card",
        version: 1,
        exportedAt: new Date().toISOString(),
        card,
        layout,
        assets: assetsMap
      });
    } catch (error) {
      next(error);
    }
  });

  // POST: 导入答题卡
  app.post("/api/cards/import", async (req, res, next) => {
    try {
      const imported = req.body as { format?: string; version?: number; card?: AnswerCard; layout?: unknown; assets?: Record<string, string> };
      if (!imported || imported.format !== "projectx-card" || imported.version !== 1) {
        res.status(400).json({ message: "不支持的文件格式，请使用 .projectx-card.json 导出文件" });
        return;
      }
      if (!imported.card) {
        res.status(400).json({ message: "文件中缺少答题卡数据" });
        return;
      }
      const importedExamDate = fieldValue(imported.card.examDate).trim();
      if (importedExamDate && !isValidExamDate(importedExamDate)) {
        res.status(400).json({ message: `导入文件中的考试时间需为 ${MIN_EXAM_YEAR}-${MAX_EXAM_YEAR} 范围内的有效日期（YYYY-MM-DD）` });
        return;
      }
      const subject = imported.card.subject ?? "";
      let newId = generateCardId(subject || "imported");
      let retry = 0;
      while (cardRepo.findById(newId) && retry < 100) {
        newId = generateCardId((subject || "imported") + "_" + String(retry++));
      }
      const card = { ...imported.card, id: newId, updatedAt: new Date().toISOString() };
      const saved = await saveCardWithLayout(cardRepo, card, req.user?.id);
      // 导入 assets
      if (imported.assets && Object.keys(imported.assets).length > 0) {
        const assetsPath = cardAssetsDir(newId);
        await mkdir(assetsPath, { recursive: true });
        for (const [filename, base64] of Object.entries(imported.assets)) {
          // 安全检查：仅允许安全的文件名
          const safeFilename = path.basename(filename);
          if (safeFilename && /^[a-zA-Z0-9_\-\.]+$/.test(safeFilename)) {
            try {
              const buffer = Buffer.from(base64, "base64");
              await writeFile(path.join(assetsPath, safeFilename), buffer);
            } catch {}
          }
        }
      }
      res.status(201).json(toCardSummary({ id: saved.id, title: saved.title, updatedAt: saved.updatedAt }));
    } catch (error) {
      next(error);
    }
  });

  // ── Exam API ──────────────────────────────────────────

  app.get("/api/exams", async (req, res, next) => {
    try {
      const examRepo = new ExamRepository();
      const { grade_id, subject, academic_year, selection } = req.query as Record<string, string>;

      // 数据范围过滤
      const visibleIds = getVisibleExamIds(req.user);
      const scopeFilter = visibleIds !== null ? { examIds: visibleIds } : {};

      if (selection === "1") {
        // 如果可见列表为空且非 null，直接返回空数组
        if (visibleIds !== null && visibleIds.length === 0) {
          res.json([]);
          return;
        }
        const exams = examRepo.listExamsForSelection({
          grade_id: grade_id ? Number(grade_id) : undefined,
          subject: subject || undefined,
          academic_year: academic_year || undefined,
          ...scopeFilter
        });
        res.json(exams);
        return;
      }

      // 如果可见列表为空且非 null，直接返回空数组
      if (visibleIds !== null && visibleIds.length === 0) {
        res.json([]);
        return;
      }
      const exams = examRepo.listExams({
        grade_id: grade_id ? Number(grade_id) : undefined,
        subject: subject || undefined,
        ...scopeFilter
      });
      res.json(exams);
    } catch (error) {
      next(error);
    }
  });

  // 学年/科目列表（考试选择页用）
  app.get("/api/exams/filters", async (_req, res, next) => {
    try {
      const examRepo = new ExamRepository();
      res.json({
        academicYears: examRepo.getAcademicYears(),
        subjects: examRepo.getSubjects()
      });
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

  app.get("/api/exams/:examId", requireExamAccess, async (req, res, next) => {
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

  app.delete("/api/exams/:examId", requireExamAccess, async (req, res, next) => {
    try {
      const examRepo = new ExamRepository();
      const exam = examRepo.findExamById(Number(req.params.examId));
      if (!exam) {
        res.status(404).json({ message: "考试不存在" });
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const deleteLinkedCard = requestFlag(body.deleteLinkedCard);
      const linkedCardId = exam.card_id ? safeId(exam.card_id) : null;
      if (deleteLinkedCard && linkedCardId) {
        const referencedByOtherExams = examRepo.listExams().filter((item) => item.card_id === linkedCardId && item.id !== exam.id);
        if (referencedByOtherExams.length > 0) {
          res.status(409).json({
            message: `无法同时删除答题卡：仍被 ${referencedByOtherExams.length} 个其它考试引用`,
            referencedExamCount: referencedByOtherExams.length,
            referencedExamNames: referencedByOtherExams.map((item) => item.name)
          });
          return;
        }
      }
      const db = getDatabase();
      db.transaction(() => {
        deleteExamRows(db, [exam.id]);
        if (deleteLinkedCard && linkedCardId) {
          cardRepo.deleteCard(linkedCardId);
        }
      })();
      if (deleteLinkedCard && linkedCardId) {
        await deleteCardFiles(linkedCardId);
      }
      res.json({ message: "已删除", deletedLinkedCard: Boolean(deleteLinkedCard && linkedCardId) });
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/exams/:examId", requireExamAccess, async (req, res, next) => {
    try {
      const examRepo = new ExamRepository();
      const exam = examRepo.findExamById(Number(req.params.examId));
      if (!exam) {
        res.status(404).json({ message: "考试不存在" });
        return;
      }
      const { cardId, name, subject } = req.body as Record<string, unknown>;
      const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (cardId !== undefined) updates.card_id = String(cardId);
      if (name !== undefined) updates.name = String(name);
      if (subject !== undefined) updates.subject = String(subject);
      const { getDatabase } = await import("../../../server/db");
      const db = getDatabase();
      const setClauses = Object.keys(updates).map((k) => `${k} = ?`).join(", ");
      const values = Object.values(updates);
      db.prepare(`UPDATE exams SET ${setClauses} WHERE id = ?`).run(...values, exam.id);
      const updated = examRepo.findExamById(exam.id);
      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  // ── Analysis API ──────────────────────────────────────

  app.get("/api/analysis/trends", async (req, res, next) => {
    try {
      const subject = typeof req.query.subject === "string" ? req.query.subject : "";
      const classId = req.query.classId ? Number(req.query.classId) : undefined;
      const analysisRepo = new AnalysisRepository();
      const trend = analysisRepo.getScoreTrend(subject, classId);
      res.json(trend);
    } catch (error) {
      next(error);
    }
  });

  // 以下分析端点需要 examId 访问权限验证
  app.get("/api/analysis/exams/:examId/classes", requireExamAccess, async (req, res, next) => {
    try {
      const analysisRepo = new AnalysisRepository();
      const classes = analysisRepo.getExamClasses(Number(req.params.examId));
      res.json(classes);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/analysis/exams/:examId/overview", requireExamAccess, async (req, res, next) => {
    try {
      const analysisRepo = new AnalysisRepository();
      const classId = req.query.classId ? Number(req.query.classId) : undefined;
      const overview = analysisRepo.getExamOverview(Number(req.params.examId), classId);
      res.json(overview);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/analysis/exams/:examId/students", requireExamAccess, async (req, res, next) => {
    try {
      const analysisRepo = new AnalysisRepository();
      const classId = req.query.classId ? Number(req.query.classId) : undefined;
      const ranking = analysisRepo.getStudentRanking(Number(req.params.examId), classId);
      res.json(ranking);
    } catch (error) {
      next(error);
    }
  });

  // v1.4.0: 成绩表格数据（含排名变化、偏差值）
  app.get("/api/analysis/exams/:examId/score-table", requireExamAccess, async (req, res, next) => {
    try {
      const analysisRepo = new AnalysisRepository();
      const classId = req.query.classId ? Number(req.query.classId) : undefined;
      const displayMode = (req.query.displayMode as string) || "deviation";
      const data = analysisRepo.getScoreTableData(
        Number(req.params.examId),
        classId,
        displayMode as "deviation" | "zscore" | "percentile"
      );
      res.json(data);
    } catch (error) {
      next(error);
    }
  });

  // v1.4.0: 上次考试对比
  app.get("/api/analysis/exams/:examId/previous", requireExamAccess, async (_req, res, next) => {
    try {
      res.json({ message: "TODO: implement previous exam comparison" });
    } catch (error) {
      next(error);
    }
  });

  // v1.4.0: 用户设置
  app.get("/api/users/me/settings", async (req, res, next) => {
    try {
      const db = getDatabase();
      const user = db.prepare(
        "SELECT score_display_mode, review_confidence_threshold, ai_api_key FROM users WHERE id = ?"
      ).get(req.user!.id) as { score_display_mode: string; review_confidence_threshold: number; ai_api_key: string | null } | undefined;
      res.json({
        scoreDisplayMode: user?.score_display_mode ?? "zscore",
        reviewConfidenceThreshold: user?.review_confidence_threshold ?? 0.12,
        aiApiKey: user?.ai_api_key ?? ""
      });
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/users/me/settings", async (req, res, next) => {
    try {
      const { scoreDisplayMode, reviewConfidenceThreshold, aiApiKey } = req.body as Record<string, unknown>;
      const db = getDatabase();
      if (scoreDisplayMode && ["deviation", "zscore", "percentile"].includes(String(scoreDisplayMode))) {
        db.prepare("UPDATE users SET score_display_mode = ? WHERE id = ?")
          .run(String(scoreDisplayMode), req.user!.id);
      }
      if (typeof reviewConfidenceThreshold === "number") {
        const t = Math.max(0, Math.min(1, reviewConfidenceThreshold));
        db.prepare("UPDATE users SET review_confidence_threshold = ? WHERE id = ?")
          .run(t, req.user!.id);
      }
      if (aiApiKey !== undefined) {
        db.prepare("UPDATE users SET ai_api_key = ? WHERE id = ?")
          .run(typeof aiApiKey === "string" ? aiApiKey : null, req.user!.id);
      }
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/analysis/exams/:examId/questions", requireExamAccess, async (req, res, next) => {
    try {
      const analysisRepo = new AnalysisRepository();
      const classId = req.query.classId ? Number(req.query.classId) : undefined;
      const questions = analysisRepo.getQuestionAnalysis(Number(req.params.examId), classId);
      res.json(questions);
    } catch (error) {
      next(error);
    }
  });

  // v1.4.0: 赋分引擎 API
  app.get("/api/exams/:examId/assigned-formula", requireExamAccess, async (req, res, next) => {
    try {
      const service = new AssignedScoreService();
      const formula = service.getFormula(Number(req.params.examId));
      const presets = AssignedScoreService.getFormulaPresets();
      const exam = new ExamRepository().findExamById(Number(req.params.examId));
      res.json({
        formula,
        isAssignedSubject: exam?.subject ? AssignedScoreService.isAssignedSubject(exam.subject) : false,
        presets
      });
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/exams/:examId/assigned-formula", requireExamAccess, async (req, res, next) => {
    try {
      const { formula, recalculate } = req.body as { formula: AssignedFormula | null; recalculate?: boolean };
      const examId = Number(req.params.examId);
      const service = new AssignedScoreService();

      if (!formula || !formula.enabled) {
        service.disableFormula(examId);
        res.json({ ok: true, updated: 0 });
        return;
      }

      service.saveFormula(examId, formula);
      let result = { updated: 0, skipped: 0 };
      if (recalculate !== false) {
        result = service.recalculateAll(examId);
      }
      res.json({ ok: true, ...result });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/exams/:examId/recalculate-assigned", requireExamAccess, async (req, res, next) => {
    try {
      const service = new AssignedScoreService();
      const result = service.recalculateAll(Number(req.params.examId));
      res.json({ ok: true, ...result });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/app/health", (_req, res) => {
    res.json({
      ok: true,
      variant: process.env.PROJECTX_VARIANT ?? null,
      scanner: process.env.PROJECTX_ENABLE_SCANNER === "1"
    });
  });

  app.get("/api/analysis/ai/status", async (req, res) => {
    try {
      // Fetch health status from llmclient
      const response = await fetchLlmClient("/health", { method: "GET" }, 2_500);
      const healthOk = response.ok;
      let llmStatus: { ok?: boolean; dbExists?: boolean; defaultModel?: string; models?: Array<{ id: string; provider: string; label: string; available: boolean; thinking?: boolean }> } = {};
      if (healthOk) {
        llmStatus = await response.json() as any;
      }

      // Fetch user's configured providers from DB
      const db = getDatabase();
      const providerRows = db.prepare(`
        SELECT id, name, provider_type, base_url, api_key, models, is_active
        FROM ai_providers
        WHERE user_id = ? AND is_active = 1
        ORDER BY sort_order, id
      `).all((req as any).userId) as any[];

      const userProviders = providerRows.map((p: any) => ({
        id: p.id,
        name: p.name,
        providerType: p.provider_type,
        baseUrl: p.base_url,
        apiKey: p.api_key,
        models: p.models ? JSON.parse(p.models) : null,
        isActive: true
      }));

      const configuredModels = llmStatus.models ?? [];
      const hasAvailableModel = configuredModels.some((model) => model.available);
      const hasUserProvider = userProviders.length > 0;

      res.json({
        available: Boolean((healthOk && llmStatus.dbExists && hasAvailableModel) || hasUserProvider),
        reason: !healthOk
          ? `LLM service returned ${response.status}`
          : !llmStatus.dbExists && !hasUserProvider
            ? "LLM service is running, but Project-X database was not found."
            : !hasAvailableModel && !hasUserProvider
              ? "LLM service is running, but no provider API key is configured."
              : undefined,
        defaultModel: llmStatus.defaultModel ?? (hasUserProvider ? "auto" : null),
        models: configuredModels,
        providers: userProviders
      });
    } catch (error) {
      // Even if llmclient is down, still return user providers if available
      try {
        const db = getDatabase();
        const providerRows = db.prepare(`
          SELECT id, name, provider_type, base_url, api_key, models, is_active
          FROM ai_providers
          WHERE user_id = ? AND is_active = 1
          ORDER BY sort_order, id
        `).all((req as any).userId) as any[];

        const userProviders = providerRows.map((p: any) => ({
          id: p.id,
          name: p.name,
          providerType: p.provider_type,
          baseUrl: p.base_url,
          apiKey: p.api_key,
          models: p.models ? JSON.parse(p.models) : null,
          isActive: true
        }));

        res.json({
          available: userProviders.length > 0,
          reason: userProviders.length > 0 ? undefined : "LLM service is not reachable and no local providers configured.",
          defaultModel: userProviders.length > 0 ? "auto" : null,
          models: [],
          providers: userProviders
        });
      } catch {
        res.json({
          available: false,
          reason: error instanceof Error ? error.message : "LLM service is not reachable.",
          defaultModel: null,
          models: [],
          providers: []
        });
      }
    }
  });

  app.post("/api/analysis/exams/:examId/ai-analysis", requireExamAccess, async (req, res, next) => {
    try {
      const examId = Number(req.params.examId);
      if (!Number.isFinite(examId) || examId <= 0) {
        res.status(400).json({ message: "Invalid exam id" });
        return;
      }

      const analysisRepo = new AnalysisRepository();
      const exam = analysisRepo.getExam(examId);
      if (!exam) {
        res.status(404).json({ message: "Exam not found" });
        return;
      }

      const classIdValue = req.body?.classId;
      const classId = classIdValue === undefined || classIdValue === null || classIdValue === ""
        ? undefined
        : Number(classIdValue);
      if (classId !== undefined && !Number.isFinite(classId)) {
        res.status(400).json({ message: "Invalid class id" });
        return;
      }

      // Build provider override from user config if provided
      const providerId = req.body?.providerId ? Number(req.body.providerId) : undefined;
      let providerOverride: Record<string, unknown> | undefined;
      if (providerId && Number.isFinite(providerId)) {
        const db = getDatabase();
        const prov = db.prepare(
          "SELECT * FROM ai_providers WHERE id = ? AND user_id = ?"
        ).get(providerId, (req as any).userId) as any;
        if (prov) {
          providerOverride = {
            provider_type: prov.provider_type,
            base_url: prov.base_url,
            api_key: prov.api_key
          };
        }
      }

      const response = await fetchLlmClient("/analysis/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          examId,
          classId,
          model: typeof req.body?.model === "string" ? req.body.model : undefined,
          locale: "zh-CN",
          providerOverride: providerOverride ?? undefined
        })
      }, 120_000);

      if (!response.ok) {
        let message = `LLM service returned ${response.status}`;
        try {
          const body = await response.json() as { detail?: string; message?: string };
          message = body.detail || body.message || message;
        } catch {
          const text = await response.text().catch(() => "");
          if (text) message = text;
        }
        res.status(response.status >= 400 && response.status < 500 ? response.status : 502).json({ message });
        return;
      }

      res.json(await response.json());
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/analysis/exams/:examId/export-csv", requireExamAccess, async (req, res, next) => {
    try {
      const analysisRepo = new AnalysisRepository();
      const classId = req.query.classId ? Number(req.query.classId) : undefined;
      const examId = Number(req.params.examId);

      const { students, questionHeaders } = analysisRepo.getExportData(examId, classId);

      // Build data rows
      const header = ["班级", "考号", "姓名", "成绩", "班级排名", "年级排名", "客观题", "主观题", ...questionHeaders];
      const data = students.map((s) => [
        s.className,
        s.studentNumber,
        s.name,
        s.totalScore,
        s.classRank,
        s.gradeRank,
        s.objectiveScore,
        s.subjectiveScore,
        ...s.questionScores
      ]);

      // Build XLSX
      const XLSX = await import("xlsx");
      const ws = XLSX.utils.aoa_to_sheet([header, ...data]);
      ws["!cols"] = [
        { wch: 10 }, { wch: 12 }, { wch: 10 }, { wch: 8 },
        { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 12 }
      ];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "成绩表");
      const buf = Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));

      // Get exam name for the filename
      const exam = analysisRepo.getExam(examId);
      const filename = `${exam?.name ?? "成绩表"}_${classId ? "班级" : "年级"}.xlsx`;

      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(filename)}"`);
      res.send(buf);
    } catch (error) {
      next(error);
    }
  });

  if (scannerEnabled()) {
    app.use("/api/scanner", scannerGate, createScannerRouter());
  } else {
    app.use("/api/scanner", (_req, res) => {
      res.status(404).json({ message: "Scanner is disabled in this Project-X package." });
    });
  }

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

export type ProjectXServer = Server & { actualPort?: number; localUrl?: string };

export async function startServer(port = Number(process.env.PORT ?? 5174)): Promise<ProjectXServer> {
  const app = await createApp();

  return new Promise((resolve, reject) => {
    const server = createServer(app);
    server.once("error", reject);
    server.once("listening", () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      (server as ProjectXServer).actualPort = actualPort;
      (server as ProjectXServer).localUrl = `http://127.0.0.1:${actualPort}`;
      console.log(`Answer card designer API running at http://127.0.0.1:${actualPort}`);
      resolve(server as ProjectXServer);
    });
    server.listen(port, "127.0.0.1");
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startServer();
}
