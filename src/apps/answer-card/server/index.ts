import express from "express";
import multer from "multer";
import { cpus } from "node:os";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { pathToFileURL, fileURLToPath } from "node:url";

// 服务端启动时一次性读取 package.json 拿到版本号，避免在源码各处写死 v1.x.x；
// 与客户端 import.meta.env.VITE_APP_VERSION（vite.config.ts 注入）保持同源。
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
function readServerVersion(): string {
  try {
    // 兼容开发（tsx 读取源码，相对 cwd）与构建后（dist/server/index.mjs 位于 dist/server/）。
    const candidates = [
      path.join(process.cwd(), "package.json"),
      path.join(__dirname, "..", "..", "..", "package.json"),
    ];
    for (const p of candidates) {
      if (!existsSync(p)) continue;
      const pkg = JSON.parse(readFileSync(p, "utf8")) as { version?: string };
      if (pkg.version) return pkg.version;
    }
  } catch {
    // 忽略：继续使用兜底值
  }
  return "0.0.0";
}
const SERVER_VERSION = readServerVersion();
import { ensureDefaultAdmin, getDatabase, getMysqlDb, buildUpsertSQL, initializeDatabase, initMariadbSchema, healthCheck, resolveProjectDbPath, detectDialect, encryptLegacyInitialPasswords, migrateLegacyPlaintextApiKeys, type DbAdapter } from "../../../server/db";
import { scheduleCleanup } from "../../../server/db/cleanup";
import { CardRepository } from "../../../server/repositories/CardRepository";
import { ExamRepository } from "../../../server/repositories/ExamRepository";
import { AnalysisRepository } from "../../../server/repositories/AnalysisRepository";
import { ScoreRepository } from "../../../server/repositories/ScoreRepository";
import { UserRepository } from "../../../server/repositories/UserRepository";
import { AssignedScoreService } from "../../../server/services/AssignedScoreService";
import type { AssignedFormula, StudentInfoSettings } from "../../../shared/types";
import { asyncHandler, wrapRouter } from "../../../server/lib/asyncHandler";
import { isAuthEnforced } from "../../../server/lib/authEnforce";
import { isScannerClientApiEnabled, isScannerClientOrigin } from "../../../server/lib/scannerClientAccess";
import { recordLifecycleEvent } from "../../../server/services/lifecycleEvents";
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
import reviewAssignRoutes from "../../../server/routes/review-assign";
import reviewSessionRoutes from "../../../server/routes/review-session";
import reviewArbitrationRoutes from "../../../server/routes/review-arbitration";
import reviewAnnotationsRoutes from "../../../server/routes/review-annotations";
import blockGradingConfigRoutes from "../../../server/routes/block-grading-config";
import reviewPoolRoutes from "../../../server/routes/review-pool";
import systemSettingsRoutes from "../../../server/routes/system-settings";
import { startLlmClientSidecar, shutdownLlmClient } from "./llm-launcher";
import dashboardRoutes from "../../../server/routes/dashboard";
import weeklyAuditRoutes from "../../../server/routes/weekly-audit";
import { scheduleWeeklyAuditRefresh } from "../../../server/services/WeeklyAuditService";
import { cleanupInterruptedAiJobs } from "../../../server/services/aiAnalysisJobs";
import adminPermissionsRoutes from "../../../server/routes/admin-permissions";
import apiKeysRoutes from "../../../server/routes/api-keys";
import dataRetentionRoutes from "../../../server/routes/data-retention";
import consoleRoutes from "../../../server/routes/console";
import scannerUploadRoutes from "../../../server/routes/scanner-upload";
import scannerQueueRoutes from "../../../server/routes/scanner-queue";
import scannerHeartbeatRoutes from "../../../server/routes/scanner-heartbeat";
import scannerSyncRoutes from "../../../server/routes/scanner-sync";
import scannerSyncImportRoutes from "./routes/scanner-sync-import";
import { startUploadQueue, cleanupExpiredUploads } from "../../../server/services/uploadQueue";
import ladderRoutes from "../../../server/routes/ladder";
import {
  getAnswerBlockCropFile,
  persistAnswerBlockCrops
} from "../../../server/services/AnswerBlockCropService";
import { optionalAuth, authMiddleware, requirePermission } from "../../../server/middleware/auth";
import { requirePasswordChangeCompleted } from "../../../server/middleware/auth";
import { authService } from "../../../server/services/AuthService";
import { initPermissionCache, roleHasPermission, PERMISSIONS } from "../../../server/auth/permissions";
import { createDefaultCard, DEFAULT_STUDENT_INFO, generateCardId } from "../../../shared/defaultCard";
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
  ObjectiveRecognitionResult,
  GradingPersistenceFailure,
  GradingPersistenceResult
} from "../../../shared/types";
import { createPdf } from "./pdf";
import { recognizeAnswerCard, recognizeObjectiveAnswers } from "./recognition";
import { createScannerRouter } from "./scanner/index";
import { makeScannerAuth } from "../../../server/middleware/scanner-auth";

import { assertImageFile } from "./validate-upload";
import {
  paramValue, fieldValue, boolField, isValidExamDate,
  MIN_EXAM_YEAR, MAX_EXAM_YEAR, requestFlag, numberArray,
  optionalPositiveNumber, parsePositiveNumber, deleteExamRows, deleteCardFiles
} from "./helpers";
import {
  makeGate, getVisibleExamIds, requireExamAccess,
  validateExamIdsAccess, setAuthEnforced, hasViewPermission
} from "./middleware";
import { llmClientUrl, llmClientHeaders, fetchLlmClient } from "./llm-client";
import analysisRoutes from "./routes/analysis";
import { paperRoutes } from "./routes/paper-routes";
import {
  CreateCardSchema,
  CreateExamSchema,
  UpdateAssignedFormulaSchema,
  UpdateUserSettingsSchema,
  validateBody
} from "./validation";
import { ApiError } from "../../../server/api-error";
import { assetsDir, cardAssetsDir, dataDir, ensureDataDirs, layoutPath, rootDir, safeId } from "./storage";





/**
 * 解析当前请求用户配置的客观题复核置信度阈值。
 * 未登录或读取失败时回落到默认阈值。
 */
async function resolveConfidenceThreshold(req: express.Request): Promise<number> {
  const { resolveReviewConfidenceThreshold } = await import("../../../server/services/userSettings");
  return resolveReviewConfidenceThreshold(req.user?.id);
}

/** 数值夹紧：非有限数回落到 fallback，并约束在 [min, max] 区间。 */
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}

/** 整数夹紧：四舍五入后约束在 [min, max] 区间。 */
function clampInt(value: unknown, min: number, max: number, fallback: number = 0): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizeStudentInfo(info: StudentInfoSettings | undefined, paperSize: "A4" | "A3"): StudentInfoSettings {
  const legacyFields = Array.isArray(info?.fields) ? info!.fields : [];
  const base = {
    studentNumberDigits: clampInt(info?.studentNumberDigits, 1, 12, DEFAULT_STUDENT_INFO.studentNumberDigits),
    showName: info?.showName ?? legacyFields.includes("姓名"),
    showClass: info?.showClass ?? legacyFields.includes("班级"),
    showSeat: info?.showSeat ?? false,
    showExamNumber: info?.showExamNumber ?? false,
    showStudentNumber: info?.showStudentNumber ?? legacyFields.includes("学号") ?? true,
    // A3 默认带注意事项（参考模板）；A4 默认不带
    showNotes: info?.showNotes ?? (paperSize === "A3"),
    notesText: typeof info?.notesText === "string" && info.notesText.length <= 1000
      ? info.notesText
      : DEFAULT_STUDENT_INFO.notesText
  };
  return base;
}

function normalizeCard(card: AnswerCard, cardId: string): AnswerCard {
  const examDate = fieldValue((card as any).examDate ?? card.examDate).trim();
  const paperSize = card.paper?.size === "A3" ? "A3" : "A4";
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
          questions: (block as any).questions.map((q: any) => {
            const normalized = {
              ...q,
              score: typeof q.score === "number" ? q.score : 0,
              minHeightMm: typeof q.minHeightMm === "number" ? q.minHeightMm : 68,
            };
            // 作文格参数上限校验，防止 targetChars/rows/columns 过大导致布局与 PDF 生成 DoS。
            if (q.essayGrid) {
              const g = q.essayGrid;
              normalized.essayGrid = {
                columns: clampInt(g.columns, 0, 60),
                rows: clampInt(g.rows, 0, 200),
                cellWidthMm: clampNumber(g.cellWidthMm, 4, 12, 7),
                cellHeightMm: clampNumber(g.cellHeightMm, 4, 12, 7),
                targetChars: clampInt(g.targetChars, 1, 5000, 600),
                showTitle: g.showTitle !== false,
                lineColor: typeof g.lineColor === "string" ? g.lineColor : "#222",
                lineWidthMm: clampNumber(g.lineWidthMm, 0.05, 0.5, 0.15),
                showFrame: g.showFrame !== false,
                showWordScale: g.showWordScale !== false,
              };
            }
            return normalized;
          })
        };
      }
      return block;
    }),
    paper: { size: paperSize, orientation: paperSize === "A3" ? "landscape" : "portrait" },
    studentInfo: normalizeStudentInfo(card.studentInfo, paperSize),
    layoutVersion: card.layoutVersion === 2 ? 2 : 1,
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
  // MariaDB 模式下主数据在远端，本地不存在可备份的 SQLite 主库；
  // 直接跳过，避免 getDatabase() 误建空库并生成无意义备份。
  if (detectDialect() === "mariadb") return;
  const backupDir = path.join(dataDir, "backups");
  await mkdir(backupDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  // 以真实数据库路径为准（支持自定义 PROJECTX_DB_PATH，不能靠 dataDir/.. 推算）
  const src = resolveProjectDbPath();
  if (!existsSync(src)) return;
  const dst = path.join(backupDir, `projectx_exam${examId}_${ts}.db`);
  try {
    // WAL 模式下直接 copyFile 主库会丢失未 checkpoint 的最近写入；
    // 使用 SQLite Online Backup API 生成一致性快照。
    const db = getDatabase();
    await db.backup(dst);
    console.log(`[AutoBackup] exam ${examId} → ${path.basename(dst)}`);
  } catch (err) {
    console.error(`[AutoBackup] Online backup failed for exam ${examId}:`, err);
    try {
      const { copyFile } = await import("node:fs/promises");
      if (existsSync(src)) {
        await copyFile(src, dst);
        console.log(`[AutoBackup] exam ${examId} → ${path.basename(dst)} (file copy fallback)`);
      }
    } catch (copyErr) {
      console.error(`[AutoBackup] Copy failed for exam ${examId}:`, copyErr);
    }
  }
}

/** Persist grading results before responding; each student is atomic. */
export async function persistGradingResults(
  examIdParam: string,
  rows: CombinedGradingRow[],
  createdBy?: number
): Promise<GradingPersistenceResult> {
  const { ExamRepository } = await import("../../../server/repositories/ExamRepository");
  const { getMysqlDb } = await import("../../../server/db");

  const examRepo = new ExamRepository();
  const db = getMysqlDb();

  const examId = Number(examIdParam);
  const exam = await examRepo.findExamById(examId);
  if (!exam) {
    throw Object.assign(new Error("考试不存在"), { status: 404, code: ApiError.NOT_FOUND });
  }
  const previousExamStatus = exam.status;

  // 重新阅卷会逐学生改写 student_scores —— 已公布的考试先自动撤下（记审计），
  // 避免学生看到阅卷中途的半成品成绩（与 v41 公布门控配套）；阅卷完成结考后需教师重新公布。
  await db.transaction(async (tx) => {
    const txExamRepo = new ExamRepository(tx);
    await txExamRepo.updateStatus(examId, "grading");
    if (exam.score_published === 1) {
      await tx.run(
        "UPDATE exams SET score_published = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND score_published = 1",
        examId
      );
      await tx.run(
        "INSERT INTO exam_publish_events (exam_id, action, actor_id, reason) VALUES (?, 'unpublish', ?, ?)",
        examId, createdBy ?? null, "重新阅卷自动撤回"
      );
    }
  });
  const batchId = await examRepo.createScanBatch(examId, `阅卷_${new Date().toLocaleDateString("zh-CN")}`, createdBy);
  await db.run("UPDATE scan_batches SET status = 'processing' WHERE id = ?", batchId);

  const findStudentSql = `
    SELECT id FROM users WHERE student_number = ? AND role_id = 3 LIMIT 1
  `;

  // Bugfix: 使用 ON CONFLICT upsert 代替 REPLACE INTO，避免重新阅卷时
  // 静默清除 manually_modified/modified_by/modified_at 等手动改分标记。
  // 冲突时仅更新分数相关列，保留手动修改元数据。
  const upsertObjectiveQsSql = buildUpsertSQL(
    db.dialect, "question_scores",
    ["exam_id", "student_id", "question_number", "question_id", "score", "max_score", "score_type", "selected_options"],
    ["exam_id", "student_id", "question_number", "score_type"],
    ["question_id", "score", "max_score", "selected_options"]
  );
  const upsertSubjectiveQsSql = buildUpsertSQL(
    db.dialect, "question_scores",
    ["exam_id", "student_id", "question_number", "question_id", "score", "max_score", "score_type"],
    ["exam_id", "student_id", "question_number", "score_type"],
    ["question_id", "score", "max_score"]
  );

  let persisted = 0;
  const failedStudents: GradingPersistenceFailure[] = [];
  for (const row of rows) {
    if (row.recognitionStatus === "failed" || row.recognition.status === "failed") {
      failedStudents.push({
        fileName: row.fileName,
        ...(row.studentId ? { studentId: row.studentId } : {}),
        code: "RECOGNITION_FAILED",
        message: "答题卡识别失败"
      });
      continue;
    }
    if (!row.studentId) {
      failedStudents.push({ fileName: row.fileName, code: "STUDENT_ID_MISSING", message: "未识别到学生 ID" });
      continue;
    }
    const studentId = row.studentId;
    const stu = await db.get(findStudentSql, studentId) as { id: number } | undefined;
    if (!stu) {
      failedStudents.push({ fileName: row.fileName, studentId, code: "STUDENT_NOT_FOUND", message: "学生不存在" });
      continue;
    }
    try {
      await db.transaction(async (tx) => {
        const txExamRepo = new ExamRepository(tx);
        const recordId = await txExamRepo.addScanRecord({
          batch_id: batchId,
          file_path: (row as any).actualPath || row.fileName,
          file_name: row.fileName,
          student_number: studentId,
          student_id: stu.id
        });
        await persistAnswerBlockCrops({
          cardId: row.recognition.cardId ?? String(exam.card_id ?? ""),
          examId,
          studentId: stu.id,
          studentNumber: studentId,
          sourceType: "scan_record",
          sourceRecordId: recordId,
          crops: row.recognition.blockCrops ?? []
        }, tx);

        await txExamRepo.saveStudentScore(examId, stu.id, row.objectiveScore, row.subjectiveScore);

        for (const q of row.questions) {
          await tx.run(
            upsertObjectiveQsSql,
            examId, stu.id, q.questionNumber, "", q.score, q.maxScore, "objective",
            JSON.stringify(q.selectedOptions ?? [])
          );
        }
        for (const sq of row.subjectiveQuestions ?? []) {
          await tx.run(upsertSubjectiveQsSql, examId, stu.id, sq.questionNumber, sq.questionId, sq.score, sq.maxScore, "subjective");
        }
      });
      persisted++;
    } catch (err) {
      console.error(`[Grading] Failed to persist row for ${studentId}:`, err);
      failedStudents.push({
        fileName: row.fileName,
        studentId,
        code: "PERSISTENCE_FAILED",
        message: "成绩持久化失败"
      });
    }
  }
  const status: GradingPersistenceResult["status"] = failedStudents.length === 0 && persisted > 0
    ? "done"
    : persisted > 0 ? "partial" : "error";
  await examRepo.finishBatchWithOutcome(
    batchId,
    status,
    persisted,
    failedStudents.length,
    failedStudents.length > 0 ? JSON.stringify(failedStudents) : null
  );

  if (status === "done") {
    await examRepo.updateStatus(examId, "closed");
    autoBackupOnExamClose(examId).catch((e) => console.error("[AutoBackup] Failed:", e));
  } else if (status === "error") {
    await examRepo.updateStatus(examId, previousExamStatus);
  } else {
    await examRepo.updateStatus(examId, "grading");
  }
  console.log(`[Grading] exam=${examId} batch=${batchId} status=${status} persisted=${persisted} failed=${failedStudents.length}`);
  return { batchId, status, persisted, failedCount: failedStudents.length, failed: failedStudents };
}

/**
 * 业务路由的 RBAC 网关。
 *
 * 兼容性设计：通过环境变量 PROJECTX_AUTH_ENFORCE 控制是否强制鉴权。
 *  - 关闭（显式设 "0"/"false"）：仅 optionalAuth 解析用户（用于 created_by），不拦截，保持 v1.0 前端无登录可用；
 *  - 开启（默认，含未设置）：未登录返回 401，权限不足返回 403。
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
  // 仅显式开启（Electron main.cjs 设置 PROJECTX_ENABLE_SCANNER=1）或 teacher-scanner 变体启用；
  // Web 部署默认关闭，避免暴露依赖本机原生 exe 的扫描 API。
  if (process.env.PROJECTX_ENABLE_SCANNER === "1" || process.env.PROJECTX_ENABLE_SCANNER === "true") {
    return true;
  }
  if (process.env.PROJECTX_ENABLE_SCANNER === "0" || process.env.PROJECTX_ENABLE_SCANNER === "false") {
    return false;
  }
  return process.env.PROJECTX_VARIANT === "teacher-scanner";
}




export async function createApp(): Promise<express.Express> {
  const app = express();
  // 安全审计（F-12-3）：关闭 X-Powered-By，避免暴露 Express 版本指纹
  app.disable("x-powered-by");
  const scannerClientApiEnabled = isScannerClientApiEnabled();

  // 服务仅监听 127.0.0.1，公网流量必然经反代/隧道进入；
  // 信任最近一跳让登录限速等拿到真实客户端 IP（可用 PROJECTX_TRUST_PROXY=0 关闭）。
  app.set("trust proxy", process.env.PROJECTX_TRUST_PROXY === "0" ? false : 1);

  console.log("[Server] 正在初始化数据库...");
  initializeDatabase();
  // 确保连接池在使用前已创建（MariaDB 模式下 initMariadbSchema / ensureDefaultAdmin 依赖）
  getMysqlDb();
  // 安全审计（F-2）：迁移历史明文 initial_password 为加密存储（幂等）
  await encryptLegacyInitialPasswords(getMysqlDb());
  // 安全审计（P1）：迁移历史明文 api_keys 为 SHA-256 哈希存储（幂等），
  // 让 API Key 哈希化安全目标对存量库同样生效
  await migrateLegacyPlaintextApiKeys(getMysqlDb());
  await initMariadbSchema();
  const adminBootstrap = await ensureDefaultAdmin();
  if (adminBootstrap.rotated) authService.revokeUserTokens(adminBootstrap.adminId);
  await initPermissionCache();
  // 扫描原图保留期可通过 PROJECTX_SCAN_RETENTION_DAYS 配置（默认 30 天）。
  // 只保留成绩、需要长期存原图的部署请显式调大；阅卷中的考试始终不清理。
  const cleanupRetainDays = (() => {
    const raw = Number(process.env.PROJECTX_SCAN_RETENTION_DAYS);
    return Number.isFinite(raw) && raw >= 1 ? raw : 30;
  })();
  const cleanupTimer = scheduleCleanup(24, cleanupRetainDays);
  cleanupTimer.unref();
  // 每周考试审计：每日刷新当前周与上周的晨测组（懒加载 ensure 为主，定时兜底成员漂移）
  scheduleWeeklyAuditRefresh();
  // 仅启动时清理一次上次进程残留的 AI 任务（不可放在每次创建任务的路径里，否则会把正在执行的任务误标为失败）
  await cleanupInterruptedAiJobs();
  await ensureDataDirs();
  console.log("[Server] 数据库初始化完成");

// P0-4 (C-S2): 鉴权默认开启，仅显式设置 0/false 才关闭（向后兼容开发环境）。
  // 判定统一委托给 isAuthEnforced()（server/lib/authEnforce.ts）作为唯一真相源。
  const enforceAuth = isAuthEnforced();
  console.log(`[Server] RBAC 鉴权强制模式: ${enforceAuth ? "开启" : "关闭（仅解析身份）"}`);
  // P0-5 (C-S3): 同步鉴权状态到 middleware 模块，供 requireExamAccess 使用
  setAuthEnforced(enforceAuth);

  // ── Express 5 异步错误处理（防请求挂死）──
  // Express 5 不再自动捕获 async handler 抛出的异常；这里在注册层
  // 统一包裹所有 app.get/post/put/delete/patch/use 调用（含已挂载的
  // Router），使任意未捕获的 rejection 都被转发到全局错误中间件，
  // 返回 500 JSON 而非让请求永久挂起。
  {
    const methods = ["get", "post", "put", "delete", "patch", "use"] as const;
    for (const m of methods) {
      const original = (app as any)[m].bind(app);
      (app as any)[m] = (pathOrHandler: unknown, ...handlers: unknown[]) => {
        const args = [pathOrHandler, ...handlers].map((h: unknown) => {
          if (typeof h !== "function") return h; // 路径字符串 / Router 选项等
          if ((h as any).length === 4) return h; // 错误处理中间件保持原样
          if ((h as any).stack) return wrapRouter(h as any); // Router 实例 → 递归包裹
          return asyncHandler(h as any); // 普通处理器 / 中间件
        });
        return original(...args);
      };
    }
  }

  // 安全审计（F-10）：最小安全响应头。
  // X-Frame-Options 不设（保留 iframe 嵌入场景）；由 CSP frame-ancestors 精确放行。
  // HSTS 仅在 HTTPS 请求或显式开启时下发，避免本地 HTTP 调试被浏览器强制升级。
  // connect-src 显式放行 http/https：扫描端页面由本机 serve，但会把识别结果 fetch 到
  // 用户输入的任意远端服务器（连接测试/上传），strict 'self' 会阻断这类跨域请求；
  // 同时兼容前端与 API 分离部署（跨域 Web 部署）。其余指令维持 'self' 收紧不变。
  const hstsEnabled = process.env.PROJECTX_HSTS === "1";
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; connect-src 'self' http: https:; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'self' http://127.0.0.1:5173 http://localhost:5173; base-uri 'self'; form-action 'self'"
    );
    if (hstsEnabled || req.secure) {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
  });

  // 阅卷提交路由使用 64 KB 限制，覆盖全局 8 MB；须在全局解析器前注册
  app.use("/api/review/exams/:examId/block-crops/:cropId/submit", express.json({ limit: "64kb" }));

  app.use(express.json({ limit: "8mb" }));
  // P1-2 (M-S1): CORS — 从环境变量读取允许的 origin 白名单，不再使用通配符 *
  const allowedOrigins = (process.env.PROJECTX_CORS_ORIGIN ?? "http://127.0.0.1:5173,http://localhost:5173")
    .split(",").map(s => s.trim()).filter(Boolean);
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && (allowedOrigins.includes(origin) || isScannerClientOrigin(origin))) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Api-Key");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    if (req.method === "OPTIONS") { res.status(204).end(); return; }
    next();
  });

  // 受控资源路由：替换原先公开的 app.use("/assets", express.static(...))。
  // 通过 cardAssetsDir 落盘，使用 path.basename 防止路径穿越；仍置于 /api 下便于统一鉴权与缓存策略。
  // 答题卡资源含考试插图/原卷，强制鉴权模式下必须登录且具备 card:read（兼容模式下仍放行）。
  // 注意：本路由注册在全局 optionalAuth 之前，必须先挂 optionalAuth 再挂 gate，
  // 否则 req.user 永远为空，强制模式下连教师都会被 401。
  app.get("/api/assets/:cardId/:assetId", optionalAuth, makeGate(enforceAuth, PERMISSIONS.CARD_READ, PERMISSIONS.CARD_READ), (req, res) => {
    const cardId = safeId(paramValue(req.params.cardId));
    const assetId = path.basename(String(req.params.assetId));
    const dir = cardAssetsDir(cardId);
    const target = path.join(dir, assetId);
    if (!target.startsWith(dir)) {
      res.status(400).json({ message: "非法路径" });
      return;
    }
    if (!existsSync(target)) {
      res.status(404).json({ message: "资源不存在" });
      return;
    }
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.sendFile(target);
  });


  app.get("/api/app/health", async (_req, res) => {
    const db = await healthCheck();
    // 安全审计（F-12-8）：脱敏 —— 只暴露存活布尔，不回传 dialect/latencyMs 等内网细节
    res.status(db.ok ? 200 : 503).json({
      ok: db.ok,
      db: { ok: db.ok },
      capabilities: {
        scannerClientApi: scannerClientApiEnabled,
        nativeScannerApi: scannerEnabled()
      }
    });
  });

  // 在所有 /api 路由前解析身份（有 token 即挂载 req.user，无 token 放行）
  app.use("/api", optionalAuth);

  // 认证与账号控制系统路由
  app.use("/api/auth", authRoutes);
  // 强制改密账号的自助认证端点已在上方处理；其它 API 一律拒绝。
  app.use("/api", requirePasswordChangeCompleted);

  // ── 用户自身设置（无需管理员权限） ──
  // GET  /api/users/me/settings — 读取当前用户设置
  // PATCH /api/users/me/settings — 更新当前用户设置
  app.get("/api/users/me/settings", authMiddleware, async (_req, res, next) => {
    try {
      const userId = _req.user!.id;
      const userRepo = new UserRepository();
      const user = await userRepo.findById(userId);
      if (!user) { res.status(404).json({ message: "用户不存在" }); return; }
      const themeSkinRaw = (user as any).theme_skin ?? "paper-edge";
      const uiStyleRaw = (user as any).ui_style as string | null | undefined;
      // ui_style 优先；缺失时由 theme_skin 反向推导（flat=clarity / paper-edge=paper_edge）
      const uiStyle = uiStyleRaw && uiStyleRaw.length > 0
        ? uiStyleRaw
        : (themeSkinRaw === "flat" ? "clarity" : "paper_edge");
      res.json({
        scoreDisplayMode: (user as any).score_display_mode ?? "zscore",
        reviewConfidenceThreshold: (user as any).review_confidence_threshold ?? 0.12,
        backgroundOpacity: (user as any).background_opacity ?? 0,
        showTabBar: (user as any).show_tab_bar ?? 0,
        themeSkin: themeSkinRaw,
        uiStyle,
        colorScheme: (user as any).color_scheme ?? "light",
      });
    } catch (err) { next(err); }
  });
  app.patch("/api/users/me/settings", authMiddleware, validateBody(UpdateUserSettingsSchema), async (_req, res, next) => {
    try {
      const userId = _req.user!.id;
      const body = _req.body as Record<string, unknown>;
      const db = getMysqlDb();

      // 读取切换前快照，用于主题审计（from_*）
      const prev = await db.get(
        "SELECT theme_skin, ui_style, color_scheme FROM users WHERE id = ?",
        userId
      ) as { theme_skin?: string | null; ui_style?: string | null; color_scheme?: string | null } | undefined;
      const prevSkin = prev?.theme_skin ?? "paper-edge";
      const prevStyle = prev?.ui_style && prev.ui_style.length > 0
        ? prev.ui_style
        : (prevSkin === "flat" ? "clarity" : "paper_edge");
      const prevScheme = prev?.color_scheme ?? "light";

      const setClauses: string[] = [];
      const values: unknown[] = [];
      if (body.scoreDisplayMode !== undefined) { setClauses.push("score_display_mode = ?"); values.push(body.scoreDisplayMode); }
      if (body.reviewConfidenceThreshold !== undefined) { setClauses.push("review_confidence_threshold = ?"); values.push(body.reviewConfidenceThreshold); }
      if (body.backgroundOpacity !== undefined) { setClauses.push("background_opacity = ?"); values.push(body.backgroundOpacity); }
      if (body.showTabBar !== undefined) { setClauses.push("show_tab_bar = ?"); values.push(body.showTabBar ? 1 : 0); }

      // 皮肤风格：uiStyle 与 themeSkin 双向同步，避免双源不一致（枚举校验，拒绝脏值）
      if (body.uiStyle !== undefined) {
        const uiStyle = body.uiStyle as string;
        if (uiStyle !== "clarity" && uiStyle !== "paper_edge") {
          res.status(400).json({ message: "uiStyle 仅支持 clarity / paper_edge" });
          return;
        }
        setClauses.push("ui_style = ?"); values.push(uiStyle);
        setClauses.push("theme_skin = ?"); values.push(uiStyle === "clarity" ? "flat" : "paper-edge");
      } else if (body.themeSkin !== undefined) {
        const themeSkin = body.themeSkin as string;
        if (themeSkin !== "flat" && themeSkin !== "paper-edge") {
          res.status(400).json({ message: "themeSkin 仅支持 flat / paper-edge" });
          return;
        }
        setClauses.push("theme_skin = ?"); values.push(themeSkin);
        setClauses.push("ui_style = ?"); values.push(themeSkin === "flat" ? "clarity" : "paper_edge");
      }
      if (body.colorScheme !== undefined) {
        const colorScheme = body.colorScheme as string;
        if (colorScheme !== "light" && colorScheme !== "dark") {
          res.status(400).json({ message: "colorScheme 仅支持 light / dark" });
          return;
        }
        setClauses.push("color_scheme = ?"); values.push(colorScheme);
      }

      let nextStyle = prevStyle;
      let nextScheme = prevScheme;
      if (body.uiStyle !== undefined) nextStyle = body.uiStyle as string;
      else if (body.themeSkin !== undefined) nextStyle = (body.themeSkin as string) === "flat" ? "clarity" : "paper_edge";
      if (body.colorScheme !== undefined) nextScheme = body.colorScheme as string;

      if (setClauses.length > 0) {
        setClauses.push("updated_at = CURRENT_TIMESTAMP");
        values.push(userId);
        await db.run(`UPDATE users SET ${setClauses.join(", ")} WHERE id = ?`, ...values);
      }

      // 主题/明暗发生实际变化才写审计事件
      if (nextStyle !== prevStyle || nextScheme !== prevScheme) {
        await db.run(
          `INSERT INTO theme_change_events (user_id, from_style, to_style, from_scheme, to_scheme, changed_at)
           VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
          userId, prevStyle, nextStyle, prevScheme, nextScheme
        );
      }
      res.json({ message: "已保存" });
    } catch (err) { next(err); }
  });

  // v1.4.6: 背景图 — GET 返回背景图，POST 上传自定义背景
  const backgroundsDir = path.join(dataDir, "backgrounds");

  app.get("/api/app/background", optionalAuth, (req, res) => {
    // 用户自定义背景优先
    if (req.user) {
      const customBg = path.join(backgroundsDir, `${req.user?.id}.jpg`);
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
      const ext = path.extname(file.originalname).toLowerCase();
      const allowedExts = [".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff", ".webp"];
      if (!allowedExts.includes(ext)) {
        cb(new Error("仅支持图片文件"));
        return;
      }
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
      if (!await assertImageFile(req.file.path, res)) return;
      // 重命名为 user_${userId}.jpg，覆盖旧背景
      const target = path.join(backgroundsDir, `${req.user?.id}.jpg`);
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
  app.use("/api/admin/permissions", adminPermissionsRoutes);
  app.use("/api/admin/data-retention-policies", dataRetentionRoutes);
  app.use("/api/admin/console", consoleRoutes);
  if (scannerClientApiEnabled) {
    app.use("/api/scanner/upload", scannerUploadRoutes);
  } else {
    app.use("/api/scanner/upload", (_req, res) => {
      res.status(404).json({
        code: "SCANNER_CLIENT_API_DISABLED",
        message: "Remote scanner client API is disabled on this server."
      });
    });
  }
  // 扫描端远程上传队列（断线重传）：入队/查询/重试/删除（仅扫描端本机 SQLite 生效）
  app.use("/api/scanner/queue", scannerQueueRoutes);
  // 主站侧：扫描端心跳上报 + 答题卡同步导出
  app.use("/api/scanner/heartbeat", scannerHeartbeatRoutes);
  app.use("/api/scanner/sync", scannerSyncRoutes);
  // 扫描端本机：答题卡同步包导入
  app.use("/api/scanner/sync", scannerSyncImportRoutes);
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

  console.log("[Server] v" + SERVER_VERSION + " routes mounted");

  // 业务路由 RBAC 网关
  const cardGate = makeGate(enforceAuth, PERMISSIONS.CARD_READ, PERMISSIONS.GRADE_WRITE);
  const examGate = makeGate(enforceAuth, PERMISSIONS.EXAM_READ, PERMISSIONS.EXAM_WRITE);
  const analysisGate = makeGate(enforceAuth, PERMISSIONS.GRADE_READ, PERMISSIONS.GRADE_READ);
  const scannerAuth = makeScannerAuth(enforceAuth);
  const cropGate = answerBlockCropGate(enforceAuth);
  app.use("/api/cards", cardGate);
  app.use("/api/exams", examGate);
  app.use("/api/analysis", analysisGate, analysisRoutes);
  app.use("/api/answer-block-crops", cropGate);
  app.use("/api/review", analysisGate, reviewRoutes);
  app.use("/api/review-assign", analysisGate, reviewAssignRoutes);
  app.use("/api/review-session", analysisGate, reviewSessionRoutes);
  app.use("/api/review-arbitration", analysisGate, reviewArbitrationRoutes);
  app.use("/api/review-annotations", analysisGate, reviewAnnotationsRoutes);
  app.use("/api/block-grading-config", analysisGate, blockGradingConfigRoutes);
  app.use("/api/review-pool", analysisGate, reviewPoolRoutes);
  app.use("/api/system-settings", systemSettingsRoutes);
  app.use("/api/dashboard", dashboardRoutes);
  app.use("/api/weekly-audit", weeklyAuditRoutes);
  app.use(paperRoutes());

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
      const ext = path.extname(file.originalname).toLowerCase();
      const allowedExts = [".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff", ".webp"];
      if (!allowedExts.includes(ext)) {
        cb(new Error("仅支持图片文件"));
        return;
      }
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
      const paperSize = req.body?.paperSize === "A3" ? "A3" : "A4";
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
      let card = createDefaultCard(id, subject, paperSize);
      card.title = title;
      card.subjectLabel = subjectLabel || undefined;
      card.examDate = examDate;
      card = applySubjectTemplate(card, { englishListening, chineseChoicePlacement });
      const saved = await saveCardWithLayout(cardRepo, card, req.user?.id);
      await recordLifecycleEvent({ entityType: "answer_card", entityId: saved.id, action: "create", actorId: req.user?.id });
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
      const confidenceThreshold = await resolveConfidenceThreshold(req);

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
            ...gradeObjectiveRecognition(card, file.originalname || path.basename(file.path), recognition, confidenceThreshold),
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
            ...gradeObjectiveRecognition(card, file.originalname || path.basename(file.path), recognition, confidenceThreshold),
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
      const confidenceThreshold = await resolveConfidenceThreshold(req);

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
            ...gradeCombinedRecognition(card, file.originalname || path.basename(file.path), recognition, confidenceThreshold),
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
            ...gradeCombinedRecognition(card, file.originalname || path.basename(file.path), recognition, confidenceThreshold),
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

      let persistence: GradingPersistenceResult | undefined;
      if (examIdParam) {
        persistence = await persistGradingResults(examIdParam, rows, req.user?.id);
      }

      const result: CombinedGradingBatchResult = {
        batchId: `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        cardId,
        rows,
        ...(persistence ? { persistence } : {})
      };
      const responseStatus = persistence?.status === "partial" ? 207 : persistence?.status === "error" ? 422 : 200;
      res.status(responseStatus).json(result);
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
      if (!await assertImageFile(req.file.path, res)) return;
      res.status(201).json({
        assetId: req.file.filename,
        originalName: req.file.originalname,
        url: `/api/assets/${cardId}/${req.file.filename}`
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
          for (const e of referenced as Array<{ id: number }>) {
            await recordLifecycleEvent({ entityType: "exam", entityId: e.id, action: "delete", actorId: req.user?.id });
          }
        } else {
          await db.run("UPDATE exams SET card_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE card_id = ?", cardId);
        }
        await cardRepo.deleteCard(cardId);
        await recordLifecycleEvent({ entityType: "answer_card", entityId: cardId, action: "delete", actorId: req.user?.id });
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
      const failedAssets: string[] = [];
      const assetsPath = cardAssetsDir(cardId);
      if (existsSync(assetsPath)) {
        const { readdir } = await import("node:fs/promises");
        const files = await readdir(assetsPath);
        for (const file of files) {
          try {
            const data = await readFile(path.join(assetsPath, file));
            assetsMap[file] = data.toString("base64");
          } catch (err) {
            console.warn(`[Export Card] 读取资源失败 ${file}:`, err);
            failedAssets.push(file);
          }
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
        assets: assetsMap,
        ...(failedAssets.length > 0 ? { warnings: { failedAssets } } : {})
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
      const failedImports: string[] = [];
      if (imported.assets && Object.keys(imported.assets).length > 0) {
        const assetsPath = cardAssetsDir(newId);
        await mkdir(assetsPath, { recursive: true });
        for (const [filename, base64] of Object.entries(imported.assets)) {
          const safeFilename = path.basename(filename);
          if (safeFilename && /^[a-zA-Z0-9_\-\.]+$/.test(safeFilename)) {
            try {
              const buffer = Buffer.from(base64, "base64");
              if (buffer.length === 0) throw new Error("空数据");
              await writeFile(path.join(assetsPath, safeFilename), buffer);
            } catch (err) {
              console.warn(`[Import Card] 写入资源失败 ${safeFilename}:`, err);
              failedImports.push(safeFilename);
            }
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
        idConflictMsg: conflictMsg || undefined,
        ...(failedImports.length > 0 ? { warnings: { failedImports } } : {})
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
      const { name, cardId, gradeId, classId, subject, mode, retentionPolicyId } = req.body as Record<string, unknown>;
      if (!name || !cardId) {
        res.status(400).json({ message: "缺少 name 或 cardId" });
        return;
      }
      // 评审 P1：显式指定保留策略（含 null 解绑）是数据生命周期管理——绑定即挂上
      // 自动归档/删除，与 PATCH /api/exams/:examId 的语义一致，仅管理员可操作。
      // 教师不传该字段走按类型默认分配（quiz→周测策略），不受影响。
      let retentionPolicyIdValue: number | null | undefined;
      if (retentionPolicyId !== undefined) {
        if (req.user?.role_name !== "admin") {
          res.status(403).json({ message: "权限不足：仅管理员可指定数据保留策略" });
          return;
        }
        if (retentionPolicyId !== null) {
          const pid = Number(retentionPolicyId);
          if (!Number.isInteger(pid) || pid <= 0) {
            res.status(400).json({ message: "无效的保留策略 ID" });
            return;
          }
          const policy = await getMysqlDb().get("SELECT id FROM data_retention_policies WHERE id = ?", pid);
          if (!policy) {
            res.status(400).json({ message: "保留策略不存在" });
            return;
          }
          retentionPolicyIdValue = pid;
        } else {
          retentionPolicyIdValue = null;
        }
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
        exam_mode: mode === "formal" ? "formal" : "quiz",
        retention_policy_id: retentionPolicyIdValue,
        created_by: req.user?.id
      });
      await recordLifecycleEvent({ entityType: "exam", entityId: exam.id, action: "create", actorId: req.user?.id });
      res.status(201).json(exam);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/exams/:examId/assigned-formula", requireExamAccess, async (req, res, next) => {
    try {
      const examId = Number(req.params.examId);
      if (!Number.isInteger(examId) || examId <= 0) {
        res.status(400).json({ message: "examId 必须为正整数" });
        return;
      }

      const examRepo = new ExamRepository();
      const exam = await examRepo.findExamById(examId);
      if (!exam) {
        res.status(404).json({ message: "考试不存在" });
        return;
      }

      const assignedScoreService = new AssignedScoreService();
      res.json({
        formula: await assignedScoreService.getFormula(examId),
        customFormulaDisabled: true,
        isAssignedSubject: AssignedScoreService.isAssignedSubject(exam.subject ?? ""),
        presets: AssignedScoreService.getFormulaPresets()
      });
    } catch (error) {
      next(error);
    }
  });

  app.put(
    "/api/exams/:examId/assigned-formula",
    requireExamAccess,
    validateBody(UpdateAssignedFormulaSchema),
    async (req, res, next) => {
      try {
        const examId = Number(req.params.examId);
        if (!Number.isInteger(examId) || examId <= 0) {
          res.status(400).json({ message: "examId 必须为正整数" });
          return;
        }

        const examRepo = new ExamRepository();
        if (!(await examRepo.findExamById(examId))) {
          res.status(404).json({ message: "考试不存在" });
          return;
        }

        const { formula, recalculate } = req.body as {
          formula: AssignedFormula | null;
          recalculate: boolean;
        };
        const assignedScoreService = new AssignedScoreService();

        if (formula?.type === "custom") {
          res.status(422).json({
            code: "CUSTOM_FORMULA_DISABLED",
            message: "自定义赋分表达式已因安全原因停用，请改用比例或线性公式"
          });
          return;
        }

        if (!formula?.enabled) {
          await assignedScoreService.disableFormula(examId);
          res.json({ ok: true, updated: 0, skipped: 0 });
          return;
        }

        await assignedScoreService.saveFormula(examId, formula);
        const result = recalculate
          ? await assignedScoreService.recalculateAll(examId)
          : { updated: 0, skipped: 0 };
        res.json({ ok: true, ...result });
      } catch (error) {
        next(error);
      }
    }
  );

  app.get("/api/exams/:examId", requireExamAccess, async (req, res, next) => {
    try {
      const examRepo = new ExamRepository();
      const exam = await examRepo.findExamById(Number(req.params.examId));
      if (!exam) {
        res.status(404).json({ message: "考试不存在" });
        return;
      }
      // 评审 P1：results 含学生姓名/考号/分数，属名单类数据：
      // - 仅教师/管理员可获取，且须对本场考试仍有「查看学生名单」权限
      //   （can_view_students，管理员/年级组长恒放行）；
      // - 学生角色一律不返回 results（此前参加考试的学生可借本端点读全班成绩单，
      //   与 hasViewPermission 的「未配置矩阵→兼容放行」教师语义一并收口）；
      // 元数据（名称/状态/答题卡等）不受影响。
      const role = req.user?.role_name;
      const isStaff = role === "admin" || role === "teacher";
      if (isStaff && await hasViewPermission(req.user, exam.id, "can_view_students")) {
        const results = await examRepo.getExamResults(exam.id);
        res.json({ ...exam, results });
        return;
      }
      res.json(exam);
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
      await recordLifecycleEvent({ entityType: "exam", entityId: exam.id, action: "delete", actorId: req.user?.id });
      if (deleteLinkedCard && linkedCardId) {
        await cardRepo.deleteCard(linkedCardId);
        await recordLifecycleEvent({ entityType: "answer_card", entityId: linkedCardId, action: "delete", actorId: req.user?.id });
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
      const { cardId, name, subject, mode, retentionPolicyId } = req.body as Record<string, unknown>;
      const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (cardId !== undefined) updates.card_id = String(cardId);
      if (name !== undefined) updates.name = String(name);
      if (subject !== undefined) updates.subject = String(subject);
      if (mode === "quiz" || mode === "formal") updates.exam_mode = mode;
      if (retentionPolicyId !== undefined) {
        // 评审 P1：保留策略绑定/解绑是数据生命周期管理，仅管理员可操作
        //（涉及自动归档/删除；SYSTEM_MANAGE 语义，与 data-retention-policies 路由一致）
        if (req.user?.role_name !== "admin") {
          res.status(403).json({ message: "权限不足：仅管理员可修改数据保留策略绑定" });
          return;
        }
        if (retentionPolicyId === null) {
          updates.retention_policy_id = null; // 解绑 = 恢复默认行为（不归档不删除）
        } else {
          const pid = Number(retentionPolicyId);
          if (!Number.isInteger(pid) || pid <= 0) {
            res.status(400).json({ message: "无效的保留策略 ID" });
            return;
          }
          const policy = await getMysqlDb().get("SELECT id FROM data_retention_policies WHERE id = ?", pid);
          if (!policy) {
            res.status(400).json({ message: "保留策略不存在" });
            return;
          }
          updates.retention_policy_id = pid;
        }
      }

      // Whitelist: only these columns may appear in a dynamic UPDATE
      const ALLOWED_COLUMNS = new Set(["updated_at", "card_id", "name", "subject", "exam_mode", "retention_policy_id"]);
      for (const col of Object.keys(updates)) {
        if (!ALLOWED_COLUMNS.has(col)) {
          res.status(400).json({ message: `不支持的更新字段：${col}` });
          return;
        }
      }

      // getMysqlDb 已在文件顶部静态导入（此处不再动态导入，避免遮蔽同名绑定）
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

  // v41: 单场成绩公布 —— 教师手动公布后学生方可查看。幂等（已公布直接返回 ok）。
  app.post("/api/exams/:examId/publish", requireExamAccess, requirePermission(PERMISSIONS.GRADE_WRITE), async (req, res, next) => {
    try {
      const examId = Number(req.params.examId);
      if (!Number.isInteger(examId) || examId <= 0) {
        res.status(400).json({ message: "无效的考试 ID" });
        return;
      }
      const { getMysqlDb } = await import("../../../server/db");
      const db = getMysqlDb();
      const exam = await db.get("SELECT id, status, score_published FROM exams WHERE id = ?", examId) as { id: number; status?: string; score_published?: number } | undefined;
      if (!exam) {
        res.status(404).json({ message: "考试不存在" });
        return;
      }
      // 仅已结考（阅卷完成出分）的考试可公布，防止草稿/未完成成绩提前暴露给学生
      if (exam.status !== "closed") {
        res.status(409).json({ message: "考试尚未结考（阅卷未完成），无法公布成绩" });
        return;
      }
      // 幂等：已公布直接返回，不重复写审计事件
      if (exam.score_published === 1) {
        res.json({ ok: true, scorePublished: 1 });
        return;
      }
      // 状态更新与审计日志在同一事务中保证原子性；
      // WHERE 带状态条件，防止校验与写入之间考试被并发改回阅卷中（TOCTOU）
      await db.transaction(async (tx) => {
        const result = await tx.run(
          "UPDATE exams SET score_published = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'closed' AND (score_published IS NULL OR score_published <> 1)",
          examId
        );
        if (result.changes !== 1) {
          throw Object.assign(new Error("考试状态已变更，公布失败，请刷新后重试"), { status: 409, code: ApiError.INVALID_VALUE });
        }
        // v42: 审计日志（首次公布/撤回后重新公布都记录）
        await tx.run(
          "INSERT INTO exam_publish_events (exam_id, action, actor_id) VALUES (?, 'publish', ?)",
          examId, req.user?.id ?? null
        );
      });
      res.json({ ok: true, scorePublished: 1 });
    } catch (error) {
      next(error);
    }
  });

  // v41: 批量成绩公布 —— body { examIds: number[] }，逐场校验存在性与数据权限范围。
  app.post("/api/exams/publish-batch", requirePermission(PERMISSIONS.GRADE_WRITE), async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as { examIds?: unknown };
      const rawIds = Array.isArray(body.examIds) ? body.examIds : [];
      // 去重：重复 ID 会导致存在性校验误判与审计重复插入
      const examIds = [...new Set(rawIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
      if (examIds.length === 0) {
        res.status(400).json({ message: "examIds 必须为非空数字数组" });
        return;
      }
      const { getMysqlDb } = await import("../../../server/db");
      const db = getMysqlDb();
      // 存在性与结考状态校验
      const existing = await db.all(
        `SELECT id, status, score_published FROM exams WHERE id IN (${examIds.map(() => "?").join(",")})`,
        ...examIds
      ) as Array<{ id: number; status?: string; score_published?: number }>;
      if (existing.length !== examIds.length) {
        res.status(400).json({ message: "部分考试不存在" });
        return;
      }
      const notClosed = existing.filter((item) => item.status !== "closed").map((item) => item.id);
      if (notClosed.length > 0) {
        res.status(409).json({ message: `以下考试尚未结考（阅卷未完成），无法公布成绩: ${notClosed.join(", ")}` });
        return;
      }
      // 数据范围校验（与 GET /api/exams 的可见性过滤一致）
      const visibleIds = await getVisibleExamIds(req.user);
      const denied = visibleIds === null ? [] : examIds.filter((id) => !visibleIds.includes(id));
      if (denied.length > 0) {
        res.status(403).json({ message: `以下考试超出你的数据权限范围，无法公布: ${denied.join(", ")}` });
        return;
      }
      // 幂等：跳过已公布的考试，不重复写审计事件
      const toPublish = existing
        .filter((item) => item.score_published !== 1)
        .map((item) => item.id);
      // 状态更新与审计日志在同一事务中保证原子性；
      // WHERE 带状态条件，防止校验与写入之间考试被并发改回阅卷中（TOCTOU）
      await db.transaction(async (tx) => {
        for (const id of toPublish) {
          const result = await tx.run(
            "UPDATE exams SET score_published = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'closed' AND (score_published IS NULL OR score_published <> 1)",
            id
          );
          if (result.changes !== 1) {
            throw Object.assign(new Error(`考试 ${id} 状态已变更，公布失败，请刷新后重试`), { status: 409, code: ApiError.INVALID_VALUE });
          }
          // v42: 审计日志（首次公布/撤回后重新公布都记录）
          await tx.run(
            "INSERT INTO exam_publish_events (exam_id, action, actor_id) VALUES (?, 'publish', ?)",
            id, req.user?.id ?? null
          );
        }
      });
      res.json({ ok: true, publishedCount: toPublish.length });
    } catch (error) {
      next(error);
    }
  });

  // v42: 撤回成绩公布 —— 仅"已公布(1)"可撤回为"已撤回(2)"；学生立即不可见。
  // body { reason? }：撤回原因写入审计日志；支持再次公布（保留版本记录）。
  app.post("/api/exams/:examId/unpublish", requireExamAccess, requirePermission(PERMISSIONS.GRADE_WRITE), async (req, res, next) => {
    try {
      const examId = Number(req.params.examId);
      if (!Number.isInteger(examId) || examId <= 0) {
        res.status(400).json({ message: "无效的考试 ID" });
        return;
      }
      const { getMysqlDb } = await import("../../../server/db");
      const db = getMysqlDb();
      const exam = await db.get("SELECT id, score_published FROM exams WHERE id = ?", examId) as { id: number; score_published?: number } | undefined;
      if (!exam) {
        res.status(404).json({ message: "考试不存在" });
        return;
      }
      if (exam.score_published !== 1) {
        res.status(400).json({ message: "仅已公布的成绩可撤回" });
        return;
      }
      const reason = typeof (req.body ?? {}).reason === "string"
        ? (req.body as { reason?: string }).reason!.trim().slice(0, 500)
        : "";
      // 状态更新与审计日志在同一事务中保证原子性；
      // WHERE 带状态条件，防止校验与写入之间公布状态被并发修改（TOCTOU）
      await db.transaction(async (tx) => {
        const result = await tx.run(
          "UPDATE exams SET score_published = 2, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND score_published = 1",
          examId
        );
        if (result.changes !== 1) {
          throw Object.assign(new Error("考试状态已变更，撤回失败，请刷新后重试"), { status: 409, code: ApiError.INVALID_VALUE });
        }
        await tx.run(
          "INSERT INTO exam_publish_events (exam_id, action, actor_id, reason) VALUES (?, 'unpublish', ?, ?)",
          examId, req.user?.id ?? null, reason || null
        );
      });
      res.json({ ok: true, scorePublished: 2 });
    } catch (error) {
      next(error);
    }
  });


  // TWAIN 扫描仅在显式启用时开放；答题卡图片预览等纯文件/存储路由始终可用
  // （Web 部署下成绩详情/改分页的整页预览依赖它们）。
  app.use("/api/scanner", scannerAuth, createScannerRouter(scannerEnabled()));

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
    // 上传类错误映射：multer 超限应 413、其它上传错误 400，而不是 500
    if (error && typeof error === "object" && (error as any)?.name === "MulterError") {
      const multerCode = String((error as any)?.code ?? "");
      const isSizeLimit = multerCode === "LIMIT_FILE_SIZE";
      res.status(isSizeLimit ? 413 : 400).json({
        code: "UPLOAD_ERROR",
        message: isSizeLimit ? "上传文件超过大小限制" : `上传错误：${multerCode}`
      });
      return;
    }
    // JSON 请求体解析失败应 400
    if (error && typeof error === "object" && (error as any)?.type === "entity.parse.failed") {
      res.status(400).json({ code: "INVALID_JSON", message: "请求体不是有效的 JSON" });
      return;
    }
    const typed = error as { status?: unknown; code?: unknown; message?: unknown };
    const status = typeof typed?.status === "number" && typed.status >= 400 && typed.status < 600 ? typed.status : 500;
    const code = typeof typed?.code === "string" ? typed.code : ApiError.INTERNAL;
    const message = typeof typed?.message === "string" ? typed.message : "服务器内部错误";
    res.status(status).json({ code, message });
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
      startLlmClientSidecar();
      // 扫描端远程上传队列：恢复中断项 + 清理超期项；每 6 小时再清一次
      startUploadQueue();
      const uploadCleanupTimer = setInterval(() => {
        void cleanupExpiredUploads().catch(() => undefined);
      }, 6 * 60 * 60 * 1000);
      uploadCleanupTimer.unref?.();
      const shutdown = () => {
        clearInterval(uploadCleanupTimer);
        shutdownLlmClient();
        server.close(() => process.exit(0));
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      resolve(server as ProjectXServer);
    });
    server.listen(port, "127.0.0.1");
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startServer();
}
