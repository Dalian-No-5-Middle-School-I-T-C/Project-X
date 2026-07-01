import express from "express";
import multer from "multer";
import { cpus } from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";
import { ensureDefaultAdmin, getMysqlDb, initializeDatabase, initMariadbSchema, healthCheck, type DbAdapter } from "../../../server/db";
import { scheduleCleanup } from "../../../server/db/cleanup";
import { CardRepository } from "../../../server/repositories/CardRepository";
import { ExamRepository } from "../../../server/repositories/ExamRepository";
import { AnalysisRepository } from "../../../server/repositories/AnalysisRepository";
import { ScoreRepository } from "../../../server/repositories/ScoreRepository";
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
import examGroupRoutes from "../../../server/routes/exam-groups";
import aiProviderRoutes from "../../../server/routes/ai-providers";
import scoreEditingRoutes from "../../../server/routes/score-editing";
import reviewRoutes from "../../../server/routes/review";
import apiKeysRoutes from "../../../server/routes/api-keys";
import scannerUploadRoutes from "../../../server/routes/scanner-upload";
import ladderRoutes from "../../../server/routes/ladder";
import {
  getAnswerBlockCropFile,
  persistAnswerBlockCrops
} from "../../../server/services/AnswerBlockCropService";
import { optionalAuth, authMiddleware, requirePermission } from "../../../server/middleware/auth";
import { initPermissionCache, roleHasPermission, PERMISSIONS } from "../../../server/auth/permissions";
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
  CrossExamTotalRequest,
  LayoutDocument,
  ObjectiveGradingBatchResult,
  ObjectiveRecognitionResult
} from "../../../shared/types";
import { createPdf } from "./pdf";
import { recognizeAnswerCard, recognizeObjectiveAnswers } from "./recognition";
import { createScannerRouter } from "./scanner/index";

import { assertImageFile } from "./validate-upload";
import {
  paramValue, fieldValue, boolField, isValidExamDate,
  MIN_EXAM_YEAR, MAX_EXAM_YEAR, requestFlag, numberArray,
  optionalPositiveNumber, parsePositiveNumber, deleteExamRows, deleteCardFiles
} from "./helpers";
import {
  makeGate, getVisibleExamIds, requireExamAccess,
  validateExamIdsAccess
} from "./middleware";
import { llmClientUrl, llmClientHeaders, fetchLlmClient } from "./llm-client";
import analysisRoutes from "./routes/analysis";
import { CreateCardSchema, CreateExamSchema, UpdateUserSettingsSchema, validateBody } from "./validation";
import { ApiError } from "../../../server/api-error";import { assetsDir, cardAssetsDir, dataDir, ensureDataDirs, layoutPath, rootDir, safeId } from "./storage";





function normalizeCard(card: AnswerCard, cardId: string): AnswerCard {
  const examDate = fieldValue((card as any).examDate ?? card.examDate).trim();
  return {
    ...card,
    id: safeId(cardId),
    subjectLabel: (card as any).subjectLabel ?? card.subjectLabel ?? undefined,
    examDate: isValidExamDate(examDate) ? examDate : undefined,
    bodyBlocks: (card.bodyBlocks ?? []).map((block) => {
      if (block.type === "objective") {
        const answerKey = normalizeObjectiveAnswerKey(block);
        const normalizedBlock = { ...block, answerKey };
        return { ...normalizedBlock, questions: normalizeObjectiveQuestions(normalizedBlock) };
      }
      // Sanitize subjective block: ensure all question scores are numbers
      if (block.type === "subjective" && Array.isArray((block as any).questions)) {
        return {
          ...block,
          questions: (block as any).questions.map((q: any) => ({
            ...q,
            score: typeof q.score === "number" ? q.score : 0,
            minHeightMm: typeof q.minHeightMm === "number" ? q.minHeightMm : 68,
          }))
        };
      }
      return block;
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
  const exists = await cardRepo.findById(normalized.id);

  if (exists) {
    await cardRepo.updateCard(normalized);
  } else {
    await cardRepo.createCard(normalized, createdBy);
    await cardRepo.updateCard(normalized);
  }

  await writeLayoutDocument(normalized.id, layout);
  return normalized;
}

async function prepareLayoutForCard(cardRepo: CardRepository, card: AnswerCard): Promise<string> {
  const normalized = normalizeCard(card, card.id);
  const layout = buildLayout(normalized);
  await writeLayoutDocument(normalized.id, layout);
  return layoutPath(normalized.id);
}





function gradingPreviewUrl(cardId: string, imagePath?: string): string | undefined {
  if (!imagePath) return undefined;
  return `/api/cards/${encodeURIComponent(cardId)}/grading/preview/${encodeURIComponent(path.basename(imagePath))}`;
}

async function createRecognitionCropTempDir(cardId: string): Promise<string> {
  const dir = path.join(
    dataDir,
    "recognition",
    "crop-temp",
    safeId(cardId),
    `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  );
  await mkdir(dir, { recursive: true });
  return dir;
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

function answerBlockCropGate(enforce: boolean) {
  return (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    if (!enforce) {
      next();
      return;
    }
    if (!req.user) {
      res.status(401).json({ message: "未登录" });
      return;
    }
    const canReadGrades = roleHasPermission(req.user.role_id, PERMISSIONS.GRADE_READ);
    const canReadOwnScores = (req.method === "GET" || req.method === "HEAD") &&
      roleHasPermission(req.user.role_id, PERMISSIONS.SCORE_READ);
    if (!canReadGrades && !canReadOwnScores) {
      res.status(403).json({ message: "权限不足" });
      return;
    }
    next();
  };
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

/**
 * Auto-backup projectx.db when an exam is closed.
 * Copies the WAL checkpointed DB to data/backups/ with a timestamp.
 * Fire-and-forget — errors are logged but never thrown to the caller.
 */
async function autoBackupOnExamClose(examId: number): Promise<void> {
  const backupDir = path.join(dataDir, "backups");
  await mkdir(backupDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const src = path.join(dataDir, "..", "projectx.db");
  const dst = path.join(backupDir, `projectx_exam${examId}_${ts}.db`);
  try {
    const { copyFile } = await import("node:fs/promises");
    if (existsSync(src)) {
      await copyFile(src, dst);
      console.log(`[AutoBackup] exam ${examId} → ${path.basename(dst)}`);
    }
  } catch (err) {
    console.error(`[AutoBackup] Copy failed for exam ${examId}:`, err);
  }
}

/** Background persistence: save grading results to database without blocking response */
async function persistGradingResults(
  examIdParam: string,
  rows: CombinedGradingRow[],
  createdBy?: number
): Promise<void> {
  const { ExamRepository } = await import("../../../server/repositories/ExamRepository");
  const { getMysqlDb, hashPassword, buildInsertIgnore } = await import("../../../server/db");

  const examRepo = new ExamRepository();
  const db = getMysqlDb();

  const examId = Number(examIdParam);
  const exam = await examRepo.findExamById(examId);
  if (!exam) return;

  await examRepo.updateStatus(examId, "grading");
  const batchId = await examRepo.createScanBatch(examId, `阅卷_${new Date().toLocaleDateString("zh-CN")}`, createdBy);

  const ensureStudentSql = buildInsertIgnore(db.dialect, "users", [
    "username", "password_hash", "name", "role_id", "student_number",
  ]);
  const updateBlankStudentPasswordSql = `
    UPDATE users
    SET password_hash = ?, updated_at = CURRENT_TIMESTAMP
    WHERE student_number = ? AND role_id = 3 AND password_hash = ''
  `;
  const findStudentSql = `
    SELECT id FROM users WHERE student_number = ? AND role_id = 3 LIMIT 1
  `;

  const insertQsSql = `
    REPLACE INTO question_scores
      (exam_id, student_id, question_number, question_id, score, max_score, score_type)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `;

  let persisted = 0;
  const studentPasswordHashes = new Map<string, string>();
  for (const row of rows) {
    if (row.studentId && !studentPasswordHashes.has(row.studentId)) {
      studentPasswordHashes.set(row.studentId, await hashPassword(row.studentId));
    }
  }

  for (const row of rows) {
    if (!row.studentId) continue;
    try {
      const studentPasswordHash = studentPasswordHashes.get(row.studentId) ?? "";
      await db.run(ensureStudentSql, row.studentId, studentPasswordHash, row.studentId, row.studentId);
      await db.run(updateBlankStudentPasswordSql, studentPasswordHash, row.studentId);
      const stu = await db.get(findStudentSql, row.studentId) as { id: number } | undefined;
      if (!stu) continue;

      const recordId = await examRepo.addScanRecord({
        batch_id: batchId,
        file_path: (row as any).actualPath || row.fileName,
        file_name: row.fileName,
        student_number: row.studentId,
        student_id: stu.id
      });
      await persistAnswerBlockCrops({
        cardId: row.recognition.cardId ?? String(exam.card_id ?? ""),
        examId,
        studentId: stu.id,
        studentNumber: row.studentId,
        sourceType: "scan_record",
        sourceRecordId: recordId,
        crops: row.recognition.blockCrops ?? []
      }, db);

      await examRepo.saveStudentScore(examId, stu.id, row.objectiveScore, row.subjectiveScore);

      for (const q of row.questions) {
        await db.run(insertQsSql, examId, stu.id, q.questionNumber, "", q.score, q.maxScore, "objective");
      }
      for (const sq of row.subjectiveQuestions ?? []) {
        await db.run(insertQsSql, examId, stu.id, sq.questionNumber, sq.questionId, sq.score, sq.maxScore, "subjective");
      }
      persisted++;
    } catch (err) {
      console.error(`[Grading] Failed to persist row for ${row.studentId}:`, err);
    }
  }

  await examRepo.finishBatch(batchId);
  await examRepo.updateStatus(examId, "closed");
  console.log(`[Grading] Persisted ${persisted} student scores to exam ${examId}`);

  // Auto-backup DB after exam closes (non-blocking)
  autoBackupOnExamClose(examId).catch((e) =>
    console.error("[AutoBackup] Failed:", e)
  );
}

/**
 * 业务路由的 RBAC 网关。
 *
 * 兼容性设计：通过环境变量 PROJECTX_AUTH_ENFORCE 控制是否强制鉴权。
 *  - 关闭（默认）：仅 optionalAuth 解析用户（用于 created_by），不拦截，保持 v1.0 前端无登录可用；
 *  - 开启（=1/true）：未登录返回 401，权限不足返回 403。
 * GET/HEAD 走 readPerm，写操作走 writePerm。
 */

/**
 * 根据当前用户的教师角色和所教班级，返回可见的考试ID列表。
 * - admin / grade_leader → 全部可见（返回 null）
 * - head_teacher → 只看自己班级的考试（全科目，本年级）
 * - subject_teacher → 只看自己教的科目 + 自己教的班级
 * - 普通 teacher（无 teacher_role）→ 全部可见（向后兼容）
 */

/**
 * 中间件：验证当前用户有权访问指定的 examId。
 * 在 analysis / exams/:examId 路由之前使用。
 *
 * 如果 req.user 不存在（未登录/未强制鉴权），放行通过。
 */




function scannerEnabled(): boolean {
  if (process.env.PROJECTX_ENABLE_SCANNER === "1" || process.env.PROJECTX_ENABLE_SCANNER === "true") {
    return true;
  }
  if (process.env.PROJECTX_ENABLE_SCANNER === "0" || process.env.PROJECTX_ENABLE_SCANNER === "false") {
    return false;
  }
  return process.env.PROJECTX_VARIANT === "teacher-scanner" || !process.env.PROJECTX_VARIANT;
}




export async function createApp(): Promise<express.Express> {
  const app = express();

  console.log("[Server] 正在初始化数据库...");
  initializeDatabase();
  // 确保连接池在使用前已创建（MariaDB 模式下 initMariadbSchema / ensureDefaultAdmin 依赖）
  getMysqlDb();
  await initMariadbSchema();
  await ensureDefaultAdmin();
  await initPermissionCache();
  const cleanupTimer = scheduleCleanup(24, 30);
  cleanupTimer.unref();
  await ensureDataDirs();
  console.log("[Server] 数据库初始化完成");

  const enforceAuth =
    process.env.PROJECTX_AUTH_ENFORCE === "1" || process.env.PROJECTX_AUTH_ENFORCE === "true";
  console.log(`[Server] RBAC 鉴权强制模式: ${enforceAuth ? "开启" : "关闭（仅解析身份）"}`);

  app.use(express.json({ limit: "8mb" }));
  // v1.6.0: CORS — 允许 WEB 客户端跨域访问（教师/学生在浏览器使用 HTTP API）
  app.use((_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Api-Key");
    if (_req.method === "OPTIONS") { res.status(204).end(); return; }
    next();
  });
  app.use("/assets", express.static(assetsDir));

  app.get("/api/app/health", async (_req, res) => {
    const db = await healthCheck();
    res.status(db.ok ? 200 : 503).json({ ok: db.ok, db });
  });

  // 在所有 /api 路由前解析身份（有 token 即挂载 req.user，无 token 放行）
  app.use("/api", optionalAuth);

  // 认证与账号控制系统路由
  app.use("/api/auth", authRoutes);

  // ── 用户自身设置（无需管理员权限） ──
  // GET  /api/users/me/settings — 读取当前用户设置
  // PATCH /api/users/me/settings — 更新当前用户设置
  app.get("/api/users/me/settings", authMiddleware, async (_req, res, next) => {
    try {
      const userId = (_req as any).user.userId ?? (_req as any).user.id;
      const userRepo = new UserRepository();
      const user = await userRepo.findById(userId);
      if (!user) { res.status(404).json({ message: "用户不存在" }); return; }
      res.json({
        scoreDisplayMode: (user as any).score_display_mode ?? "zscore",
        reviewConfidenceThreshold: (user as any).review_confidence_threshold ?? 0.12,
        backgroundOpacity: (user as any).background_opacity ?? 0,
      });
    } catch (err) { next(err); }
  });
  app.patch("/api/users/me/settings", authMiddleware, validateBody(UpdateUserSettingsSchema), async (_req, res, next) => {
    try {
      const userId = (_req as any).user.userId ?? (_req as any).user.id;
      const body = (_req as any).body as Record<string, unknown>;
      const setClauses: string[] = [];
      const values: unknown[] = [];
      if (body.scoreDisplayMode !== undefined) { setClauses.push("score_display_mode = ?"); values.push(body.scoreDisplayMode); }
      if (body.reviewConfidenceThreshold !== undefined) { setClauses.push("review_confidence_threshold = ?"); values.push(body.reviewConfidenceThreshold); }
      if (body.backgroundOpacity !== undefined) { setClauses.push("background_opacity = ?"); values.push(body.backgroundOpacity); }
      if (setClauses.length > 0) {
        setClauses.push("updated_at = CURRENT_TIMESTAMP");
        values.push(userId);
        const db = getMysqlDb();
        await db.run(`UPDATE users SET ${setClauses.join(", ")} WHERE id = ?`, ...values);
      }
      res.json({ message: "已保存" });
    } catch (err) { next(err); }
  });

  // v1.4.6: 背景图 — GET 返回背景图，POST 上传自定义背景
  const backgroundsDir = path.join(dataDir, "backgrounds");

  app.get("/api/app/background", optionalAuth, (req, res) => {
    // 用户自定义背景优先
    if ((req as any).user) {
      const customBg = path.join(backgroundsDir, `${(req as any).user.id}.jpg`);
      if (existsSync(customBg)) {
        res.setHeader("Cache-Control", "no-cache");
        res.sendFile(customBg);
        return;
      }
    }
    // 默认背景
    const bgPath = path.join(rootDir, "resources", "background.jpg");
    if (existsSync(bgPath)) {
      res.setHeader("Cache-Control", "public, max-age=86400");
      res.sendFile(bgPath);
    } else {
      res.status(404).json({ error: "background image not found" });
    }
  });

  // 上传自定义背景图
  const bgUpload = multer({
    storage: multer.diskStorage({
      destination: async (_req, _file, cb) => {
        await mkdir(backgroundsDir, { recursive: true });
        cb(null, backgroundsDir);
      },
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase() || ".jpg";
        cb(null, `upload_${Date.now()}${ext}`);
      }
    }),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      if (file.mimetype.startsWith("image/")) {
        cb(null, true);
      } else {
        cb(new Error("仅支持图片文件"));
      }
    }
  });

  app.post("/api/users/me/background", authMiddleware, bgUpload.single("file"), async (req, res, next) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: "请选择图片文件" });
        return;
      }
      // 重命名为 user_${userId}.jpg，覆盖旧背景
      const target = path.join(backgroundsDir, `${(req as any).user.id}.jpg`);
      await rename(req.file.path, target);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.use("/api/users", userRoutes);
  app.use("/api/classes", classRoutes);
  app.use("/api/teachers", teacherRoutes);
  app.use("/api/export", exportRoutes);
  app.use("/api/export", exportScoresRoutes);
  app.use("/api/exam-groups", examGroupRoutes);
  app.use("/api/scores", scoreRoutes);
  app.use("/api/sponsor", sponsorRoutes);
  app.use("/api/db", backupRoutes);
  app.use("/api/admin/api-keys", apiKeysRoutes);
  app.use("/api/scanner/upload", scannerUploadRoutes);
  app.use("/api/ai/providers", aiProviderRoutes);
  app.use("/api/ladder", ladderRoutes);

  // ── 应用配置（管理员） ──────────────────────────────────
  app.get("/api/app/db-config", authMiddleware, requirePermission(PERMISSIONS.USER_MANAGE), async (req: express.Request, res: express.Response) => {
    try {
      const { readDbConfig } = await import("../../../server/db/config");
      const config = readDbConfig();
      // 脱敏：不返回密码明文
      res.json({
        mode: config.mode,
        remote: config.remote ? {
          host: config.remote.host,
          port: config.remote.port ?? 3306,
          database: config.remote.database ?? "projectx",
          user: config.remote.user ?? "",
          hasPassword: !!(config.remote.password),
        } : null,
      });
    } catch (err: any) { res.status(500).json({ message: err.message }); }
  });

  app.patch("/api/app/db-config", authMiddleware, requirePermission(PERMISSIONS.USER_MANAGE), async (req: express.Request, res: express.Response) => {
    try {
      const { mode, remote } = req.body ?? {};
      if (mode !== "local" && mode !== "remote") {
        res.status(400).json({ message: "mode 必须为 local 或 remote" });
        return;
      }
      const { writeDbConfig } = await import("../../../server/db/config");
      writeDbConfig({
        mode,
        remote: remote ? {
          host: remote.host ?? "",
          port: remote.port ?? 3306,
          database: remote.database ?? "projectx",
          user: remote.user ?? "",
          password: remote.password ?? "",
        } : undefined,
      });
      res.json({
        ok: true,
        message: mode === "remote"
          ? "数据库配置已保存为远程模式。请重启服务器以使新设置生效。"
          : "数据库配置已保存为本地模式。请重启服务器以使新设置生效。"
      });
    } catch (err: any) { res.status(500).json({ message: err.message }); }
  });

  // ── 健康检查 ──
  app.get("/api/app/health", async (_req, res) => {
    try {
      const health = await healthCheck();
      res.json(health);
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  console.log("[Server] v1.6.1 routes mounted");

  // 业务路由 RBAC 网关
  const cardGate = makeGate(enforceAuth, PERMISSIONS.CARD_READ, PERMISSIONS.GRADE_WRITE);
  const examGate = makeGate(enforceAuth, PERMISSIONS.EXAM_READ, PERMISSIONS.EXAM_WRITE);
  const analysisGate = makeGate(enforceAuth, PERMISSIONS.GRADE_READ, PERMISSIONS.GRADE_READ);
  const scannerGate = makeGate(enforceAuth, PERMISSIONS.GRADE_WRITE, PERMISSIONS.GRADE_WRITE);
  const cropGate = answerBlockCropGate(enforceAuth);
  app.use("/api/cards", cardGate);
  app.use("/api/exams", examGate);
  app.use("/api/analysis", analysisGate, analysisRoutes);
  app.use("/api/answer-block-crops", cropGate);
  app.use("/api/review", analysisGate, reviewRoutes);

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
    limits: { fileSize: 12 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      if (file.mimetype.startsWith("image/")) {
        cb(null, true);
      } else {
        cb(new Error("仅支持图片文件"));
      }
    }
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
      res.json((await cardRepo.listCards()).map(toCardSummary));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/cards", validateBody(CreateCardSchema), async (req, res, next) => {
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
      if (await cardRepo.findByTitle(title)) {
        res.status(409).json({ error: `已存在同名答题卡「${title}」，请修改名称后重试` });
        return;
      }
      let id = generateCardId(subject);
      let retry = 0;
      while (await cardRepo.findById(id) && retry < 100) {
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
      const card = await cardRepo.findById(safeId(paramValue(req.params.cardId)));
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
      const card = await cardRepo.findById(safeId(paramValue(req.params.cardId)));
      if (!card) {
        res.status(404).json({ message: "答题卡不存在" });
        return;
      }
      const layout = buildLayout(card);
      await writeLayoutDocument(card.id, layout);
      res.json(layout);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/cards/:cardId/recognition/objective", recognitionUpload.single("file"), async (req, res, next) => {
    try {
      const cardId = safeId(paramValue(req.params.cardId));
      const card = await cardRepo.findById(cardId);
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
      const card = await cardRepo.findById(cardId);
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
      const card = await cardRepo.findById(cardId);
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
            previewUrl: gradingPreviewUrl(cardId, file.path),
            actualPath: file.path
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
            previewUrl: gradingPreviewUrl(cardId, file.path),
            actualPath: file.path
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
      const card = await cardRepo.findById(cardId);
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
          const cropsDir = await createRecognitionCropTempDir(cardId);
          const recognition = (await recognizeAnswerCard({
            imagePath: file.path,
            layoutPath: currentLayoutPath,
            pageNumber,
            dpi,
            cropsDir
          })) as CombinedRecognitionResult;
          recognition.subjectiveQuestions = recognition.subjectiveQuestions ?? [];
          return {
            ...gradeCombinedRecognition(card, file.originalname || path.basename(file.path), recognition),
            previewUrl: gradingPreviewUrl(cardId, file.path),
            actualPath: file.path
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
            previewUrl: gradingPreviewUrl(cardId, file.path),
            actualPath: file.path
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

  app.get("/api/answer-block-crops/:cropId/image", async (req, res, next) => {
    try {
      const cropId = safeId(paramValue(req.params.cropId));
      const cropRow = await getMysqlDb().get(
        "SELECT image_path, student_id FROM answer_block_crops WHERE id = ?",
        cropId
      ) as { image_path: string; student_id: number | null } | undefined;
      const targetPath = cropRow?.image_path ?? await getAnswerBlockCropFile(cropId);
      if (!cropRow || !targetPath || !existsSync(targetPath)) {
        res.status(404).json({ message: "作答切块图片不存在" });
        return;
      }
      if (
        enforceAuth &&
        req.user &&
        roleHasPermission(req.user.role_id, PERMISSIONS.SCORE_READ) &&
        !roleHasPermission(req.user.role_id, PERMISSIONS.GRADE_READ) &&
        cropRow.student_id !== req.user.id
      ) {
        res.status(403).json({ message: "权限不足" });
        return;
      }
      res.setHeader("Content-Type", "image/png");
      res.sendFile(targetPath);
    } catch (error) {
      next(error);
    }
  });


  app.post("/api/cards/:cardId/assets", upload.single("file"), async (req, res, next) => {
    try {
      const cardId = safeId(paramValue(req.params.cardId));
      const card = await cardRepo.findById(cardId);
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
      const card = await cardRepo.findById(safeId(paramValue(req.params.cardId)));
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
      const card = await cardRepo.findById(cardId);
      if (!card) {
        res.status(404).json({ message: "答题卡不存在" });
        return;
      }
      // 检查是否被考试引用
      const examRepo = new ExamRepository();
      const exams = await examRepo.listExams();
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
        const db = getMysqlDb();
        if (deleteReferencedExams) {
          await deleteExamRows(db, referenced.map((e: any) => Number(e.id)));
        } else {
          await db.run("UPDATE exams SET card_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE card_id = ?", cardId);
        }
        await cardRepo.deleteCard(cardId);
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
      const deleted = await cardRepo.deleteCard(cardId);
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
      const card = await cardRepo.findById(cardId);
      if (!card) {
        res.status(404).json({ message: "答题卡不存在" });
        return;
      }
      const layout = buildLayout(card);
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
      const imported = req.body as {
        format?: string; version?: number;
        card?: AnswerCard; layout?: unknown; assets?: Record<string, string>;
        overrideTitle?: string; overrideSubject?: string; overrideSubjectLabel?: string; overrideExamDate?: string;
        examAction?: "none" | "create" | "link"; examName?: string; linkExamId?: number;
      };
      if (!imported || imported.format !== "projectx-card" || imported.version !== 1) {
        res.status(400).json({ message: "不支持的文件格式，请使用 .projectx-card.json 导出文件" });
        return;
      }
      if (!imported.card) {
        res.status(400).json({ message: "文件中缺少答题卡数据" });
        return;
      }
      // Apply overrides from import modal (deep clone to avoid reference issues)
      const card = JSON.parse(JSON.stringify(imported.card)) as AnswerCard;
      if (imported.overrideTitle) card.title = imported.overrideTitle;
      if (imported.overrideSubject != null) card.subject = imported.overrideSubject;
      if (imported.overrideSubjectLabel != null) card.subjectLabel = imported.overrideSubjectLabel;
      if (imported.overrideExamDate) card.examDate = imported.overrideExamDate;

      // Validate exam date
      const importedExamDate = fieldValue(card.examDate).trim();
      if (importedExamDate && !isValidExamDate(importedExamDate)) {
        res.status(400).json({ message: `导入文件中的考试时间需为 ${MIN_EXAM_YEAR}-${MAX_EXAM_YEAR} 范围内的有效日期（YYYY-MM-DD）` });
        return;
      }

      // Sanitize null numeric values in blocks to avoid C++ JSON parse errors
      if (card.bodyBlocks) {
        for (const block of card.bodyBlocks) {
          if (block.type === "subjective" && Array.isArray((block as any).questions)) {
            for (const q of (block as any).questions) {
              if (q.score == null) q.score = 0;
              if (q.minHeightMm == null) q.minHeightMm = 68;
              if (q.maxScore == null) q.maxScore = 0;
            }
          }
          if (block.type === "objective") {
            if ((block as any).scorePerQuestion == null) (block as any).scorePerQuestion = 0;
            if (Array.isArray((block as any).questions)) {
              for (const q of (block as any).questions) {
                if (q.score == null) q.score = 0;
              }
            }
          }
        }
      }

      // Regenerate block IDs to avoid UNIQUE constraint conflicts
      const { randomUUID } = await import("node:crypto");
      const idMap = new Map<string, string>();
      if (card.bodyBlocks) {
        for (const block of card.bodyBlocks) {
          const oldId = block.id;
          const newBlockId = randomUUID();
          idMap.set(oldId, newBlockId);
          block.id = newBlockId;
          // Regenerate sub-question IDs
          if (block.type === "subjective" && Array.isArray((block as any).questions)) {
            for (const q of (block as any).questions) {
              const oldQid = q.id;
              const newQid = randomUUID();
              idMap.set(oldQid, newQid);
              q.id = newQid;
            }
          }
        }
      }

      // Check for duplicate title
      const existingCard = await cardRepo.findByTitle(card.title);
      if (existingCard && existingCard.id !== card.id) {
        res.status(409).json({ message: `已存在同名答题卡「${card.title}」（ID: ${existingCard.id}），请修改名称后重试` });
        return;
      }

      const subject = card.subject ?? "";
      let newId = generateCardId(subject || "imported");
      let retry = 0;
      const idConflict = await cardRepo.findById(imported.card.id ?? "");
      const conflictMsg = idConflict ? `原卡片ID ${imported.card.id} 已存在，已分配新ID ${newId}` : "";
      while (await cardRepo.findById(newId) && retry < 100) {
        newId = generateCardId((subject || "imported") + "_" + String(retry++));
      }
      card.id = newId;
      card.updatedAt = new Date().toISOString();
      const saved = await saveCardWithLayout(cardRepo, card, req.user?.id);

      // 导入 assets
      if (imported.assets && Object.keys(imported.assets).length > 0) {
        const assetsPath = cardAssetsDir(newId);
        await mkdir(assetsPath, { recursive: true });
        for (const [filename, base64] of Object.entries(imported.assets)) {
          const safeFilename = path.basename(filename);
          if (safeFilename && /^[a-zA-Z0-9_\-\.]+$/.test(safeFilename)) {
            try {
              const buffer = Buffer.from(base64, "base64");
              await writeFile(path.join(assetsPath, safeFilename), buffer);
            } catch {}
          }
        }
      }

      // Handle exam action
      let createdExamId: number | undefined;
      let duplicateExamName: string | undefined;
      if (imported.examAction === "create") {
        const examRepo = new ExamRepository();
        const examName = imported.examName || saved.title;
        const existingExam = await examRepo.findExamByName(examName);
        if (existingExam) {
          duplicateExamName = examName;
        } else {
          const exam = await examRepo.createExam({
            name: examName,
            card_id: newId,
            subject: saved.subjectLabel || saved.subject || undefined,
            created_by: req.user?.id ?? undefined
          });
          createdExamId = exam.id;
        }
      } else if (imported.examAction === "link" && imported.linkExamId) {
        const { getMysqlDb } = await import("../../../server/db");
        const db = getMysqlDb();
        await db.run("UPDATE exams SET card_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          newId, imported.linkExamId);
      }

      res.status(201).json({
        ...toCardSummary({ id: saved.id, title: saved.title, updatedAt: saved.updatedAt }),
        createdExamId,
        duplicateExamName: duplicateExamName || undefined,
        idConflictMsg: conflictMsg || undefined
      });
    } catch (error) {
      next(error);
    }
  });

  // ── Score editing: mounted before exam routes to match
  //     /api/exams/:examId/student/:studentId/scores before /api/exams/:examId
  app.use("/api/exams", scoreEditingRoutes);

  // ── Exam API ──────────────────────────────────────────

  app.get("/api/exams", async (req, res, next) => {
    try {
      const examRepo = new ExamRepository();
      const { grade_id, subject, academic_year, selection } = req.query as Record<string, string>;

      // 数据范围过滤
      const visibleIds = await getVisibleExamIds(req.user);
      const scopeFilter = visibleIds !== null ? { examIds: visibleIds } : {};

      if (selection === "1") {
        // 如果可见列表为空且非 null，直接返回空数组
        if (visibleIds !== null && visibleIds.length === 0) {
          res.json([]);
          return;
        }
        const exams = await examRepo.listExamsForSelection({
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
      const exams = await examRepo.listExams({
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
        academicYears: await examRepo.getAcademicYears(),
        subjects: await examRepo.getSubjects()
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/exams", validateBody(CreateExamSchema), async (req, res, next) => {
    try {
      const { name, cardId, gradeId, classId, subject } = req.body as Record<string, unknown>;
      if (!name || !cardId) {
        res.status(400).json({ message: "缺少 name 或 cardId" });
        return;
      }
      const examRepo = new ExamRepository();
      const existing = await examRepo.findExamByName(String(name));
      if (existing) {
        res.status(409).json({ message: `已存在同名考试「${name}」（ID: ${existing.id}），请修改名称后重试` });
        return;
      }
      const exam = await examRepo.createExam({
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
      const exam = await examRepo.findExamById(Number(req.params.examId));
      if (!exam) {
        res.status(404).json({ message: "考试不存在" });
        return;
      }
      const results = await examRepo.getExamResults(exam.id);
      res.json({ ...exam, results });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/exams/:examId", requireExamAccess, async (req, res, next) => {
    try {
      const examRepo = new ExamRepository();
      const exam = await examRepo.findExamById(Number(req.params.examId));
      if (!exam) {
        res.status(404).json({ message: "考试不存在" });
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const deleteLinkedCard = requestFlag(body.deleteLinkedCard);
      const linkedCardId = exam.card_id ? safeId(exam.card_id) : null;
      const db = getMysqlDb();
      if (deleteLinkedCard && linkedCardId) {
        const referencedByOtherExams = (await examRepo.listExams()).filter((item) => item.card_id === linkedCardId && item.id !== exam.id);
        if (referencedByOtherExams.length > 0) {
          res.status(409).json({
            message: `无法同时删除答题卡：仍被 ${referencedByOtherExams.length} 个其它考试引用`,
            referencedExamCount: referencedByOtherExams.length,
            referencedExamNames: referencedByOtherExams.map((item) => item.name)
          });
          return;
        }
      }
      await deleteExamRows(db, [exam.id]);
      if (deleteLinkedCard && linkedCardId) {
        await cardRepo.deleteCard(linkedCardId);
      }
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
      const exam = await examRepo.findExamById(Number(req.params.examId));
      if (!exam) {
        res.status(404).json({ message: "考试不存在" });
        return;
      }
      const { cardId, name, subject } = req.body as Record<string, unknown>;
      const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (cardId !== undefined) updates.card_id = String(cardId);
      if (name !== undefined) updates.name = String(name);
      if (subject !== undefined) updates.subject = String(subject);

      // Whitelist: only these columns may appear in a dynamic UPDATE
      const ALLOWED_COLUMNS = new Set(["updated_at", "card_id", "name", "subject"]);
      for (const col of Object.keys(updates)) {
        if (!ALLOWED_COLUMNS.has(col)) {
          res.status(400).json({ message: `不支持的更新字段：${col}` });
          return;
        }
      }

      const { getMysqlDb } = await import("../../../server/db");
      const db = getMysqlDb();
      const setClauses = Object.keys(updates).map((k) => `${k} = ?`).join(", ");
      const values = Object.values(updates);
      await db.run(`UPDATE exams SET ${setClauses} WHERE id = ?`, ...values, exam.id);
      const updated = await examRepo.findExamById(exam.id);
      res.json(updated);
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

  app.use("/api", (_req, res) => {
    res.status(404).json({ code: ApiError.NOT_FOUND, message: "API route not found" });
  });

  const clientDist = process.env.ANSWER_CARD_CLIENT_DIST
    ? path.resolve(process.env.ANSWER_CARD_CLIENT_DIST)
    : path.join(rootDir, "dist", "web");
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
          // 防止浏览器缓存前端文件，确保更新后立即可见
          if (ext === ".html" || ext === ".js" || ext === ".mjs" || ext === ".css") {
            res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
            res.setHeader("Pragma", "no-cache");
            res.setHeader("Expires", "0");
          }
        }
      })
    );
    app.get("/{*splat}", (_req, res) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
      res.sendFile(path.join(clientDist, "index.html"));
    });
  }

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(error);
    res.status(500).json({ code: ApiError.INTERNAL, message: error instanceof Error ? error.message : "服务器内部错误" });
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
