/**
 * v1.6.0 — 扫描上传端点
 * 供扫描端 Electron 通过 HTTP 上传扫描结果到服务端
 *
 * 鉴权: apiKeyAuth（X-Api-Key）或 authMiddleware（JWT token）
 *
 * POST /api/scanner/sessions            — 创建扫描会话
 * POST /api/scanner/sessions/:id/pages  — 上传扫描页
 * POST /api/scanner/sessions/:id/complete — 完成扫描，触发识别
 * GET  /api/scanner/sessions/:id/status   — 查询状态
 */

import { Router, type Request, type Response } from "express";
import multer from "multer";
import { parseIdentityMode } from "../../shared/cardIdentity";
import { cardFingerprint, parseCardVersion } from "../../shared/cardVersion";
import { buildLayout } from "../../shared/layout";
import { mapScanPageToLayout } from "../../shared/scanPages";
import {
  MAX_SCAN_IMAGE_BYTES,
  MAX_SCAN_SESSION_PAGES,
  MAX_SCAN_PAGE_REQUEST_TOTAL_BYTES,
  MAX_CROP_IMAGE_BYTES,
  MAX_CROPS_PER_REQUEST,
  MAX_CROPS_TOTAL_BYTES,
} from "../../shared/scanUploadLimits";
import { requestUploadBudget } from "../lib/uploadBudget";
import path from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import crypto from "node:crypto";
import { dualAuth } from "../middleware/scanner-auth";
import { requireScannerExamScope, requireScannerRecordScope, enforceScannerCardScope } from "../middleware/scanner-scope";
import { resolveScannerExam } from "../services/scannerExam";
import { getMysqlDb } from "../db";
import { persistAnswerBlockCrops, isInsideDir, type CropPersistenceStats } from "../services/AnswerBlockCropService";
import { isValidImageBuffer } from "../../apps/answer-card/server/validate-upload";
import type { RecognitionBlockCrop } from "../../shared/types";
import { z } from "zod";
import { CardRepository } from "../repositories/CardRepository";
import { ExamRepository } from "../repositories/ExamRepository";
import { ensureExamParticipants, listMissingParticipants } from "../services/examParticipants";
import { recomputeExamRankings } from "../services/rankingUpdate";
import { processScannerSession, enqueueScannerSubmission, findSavedScannerOwners, invalidateScanRecognition, savedReceiptOwnerOfPage } from "../services/scannerSubmissions";
import { parseRecognitionDpi } from "../../apps/answer-card/server/helpers";
import { groupSessionPages } from "../../apps/answer-card/server/scanner/session-results";
import { scannerLegacyRecoveryRouter } from "./scanner-legacy-recovery";
import { listScanRecordsGroupedByStudent, upsertRecognitionResult } from "../../apps/answer-card/server/database/scan-store";

const recognitionSchema = z.object({
  identity: z.object({ status: z.enum(["verified", "unverified"]), code: z.string(), cardId: z.string().optional(), pageNumber: z.number().int().positive().optional() }),
  status: z.enum(["ok", "partial"]),
  studentId: z.object({ status: z.string(), value: z.string().min(1).max(64) }),
  questions: z.array(z.object({
    questionNumber: z.number().int().positive(), selectedOptions: z.array(z.string().max(8)),
    confidence: z.number().finite(),
  })).max(1000),
  subjectiveQuestions: z.array(z.object({
    blockId: z.string().optional(), questionId: z.string(), questionNumber: z.union([z.number(), z.string()]),
    score: z.number().finite().nonnegative(), maxScore: z.number().finite().nonnegative(),
    status: z.string(), confidence: z.number().finite(),
    validCells: z.array(z.any()), invalidCells: z.array(z.any()),
  })).max(1000),
});

/**
 * 安全（R07）：切块清单（manifest）参与服务端落盘文件名与题块记录，字段必须先收敛。
 *
 * 风险点：`pageNumber` / `segmentIndex` 会被拼进目标文件名，未校验时携带 `..` 或路径
 * 分隔符就能把切块写到切块目录之外；`path` 若采信客户端值则等于任意路径。
 * 因此这里只承认下列字段，其余（含客户端上报的 `path`）一律丢弃，落盘路径由服务端决定。
 */
const cropManifestSchema = z.object({
  blockId: z.string().min(1).max(64),
  blockTitle: z.string().max(120).optional(),
  blockType: z.string().max(32).optional(),
  pageNumber: z.number().int().min(1).max(MAX_SCAN_SESSION_PAGES),
  segmentIndex: z.number().int().min(0).max(MAX_CROPS_PER_REQUEST),
  questionNumbers: z.array(z.union([z.number().int().min(0).max(99999), z.string().min(1).max(16)])).min(1).max(200),
  rect: z.object({
    x: z.number().finite().min(0), y: z.number().finite().min(0),
    width: z.number().finite().min(0), height: z.number().finite().min(0),
  }),
  widthPx: z.number().finite().min(0).max(20000),
  heightPx: z.number().finite().min(0).max(20000),
  dpi: z.number().finite().min(0).max(2400),
  fileName: z.string().min(1).max(120).optional(),
});

/** 上传切块必须落在本次请求的临时目录内；任何越出该目录的路径都视为清单被篡改。 */
function insideDir(dir: string, target: string): boolean {
  const base = path.resolve(dir);
  const resolved = path.resolve(target);
  return resolved === base || resolved.startsWith(base + path.sep);
}

/**
 * 安全（R28）：扫描页与切块上传的三级限制。
 *  - 单文件：原卷 50 MiB、切块 12 MiB（multer limits.fileSize）；
 *  - 数量：单页请求 1 张、切块请求 50 张（multer limits.files，超限即 400）；
 *  - 累计：整个请求体的字节预算（requestUploadBudget，超限 413）。
 * 此前切块只有「单张 50 MiB」，最坏一次请求吃掉 50 × 50 MiB = 2.5 GiB 服务端内存。
 */
const pageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SCAN_IMAGE_BYTES, files: 1 },
});
const cropUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_CROP_IMAGE_BYTES, files: MAX_CROPS_PER_REQUEST },
});
const pageUploadBudget = requestUploadBudget({
  maxTotalBytes: MAX_SCAN_PAGE_REQUEST_TOTAL_BYTES, label: "扫描页上传",
});
const cropUploadBudget = requestUploadBudget({
  maxTotalBytes: MAX_CROPS_TOTAL_BYTES, label: "扫描切块上传",
});

/**
 * 安全（R22）：单个扫描会话的页数上界见 `shared/scanUploadLimits`。
 * pageCount 由远端扫描端上报，既决定会话创建时向 twain_scan_records 插入的行数，
 * 也决定一次性发放的上传令牌数量；没有上界时，一次请求就能写入任意多行。
 */
export function parseScanSessionPageCount(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return 1;
  const pages = Number(value);
  if (!Number.isInteger(pages) || pages < 1 || pages > MAX_SCAN_SESSION_PAGES) return null;
  return pages;
}

const router = Router();
// Same authorization as an upload, without creating a session or touching scans.
router.get("/check", dualAuth, (_req, res) => {
  res.json({ ok: true });
});
router.use("/sessions/:sessionId", dualAuth, requireScannerExamScope);
// 安全（R04）：/records/:recordId/* 只带记录 ID，此前任何扫描端凭据都能按 ID 逐个读走
// 其它考试、其它学生的原卷图片。先映射到所属会话再走考试范围校验。
router.use("/records/:recordId", dualAuth, requireScannerRecordScope({ recordIdParam: "recordId" }));
router.use("/legacy", dualAuth);
router.use(scannerLegacyRecoveryRouter());

// v1.6.0: 双鉴权 — API Key 优先，无 Key 时强制 JWT（见 scanner-auth.ts）

// 生成唯一 ID
function genId(): string {
  return crypto.randomBytes(12).toString("hex");
}

function scannerDataDir(): string {
  return process.env.ANSWER_CARD_DATA_DIR
    || path.join(process.cwd(), "data", "answer-card");
}

function scannerUploadDir(): string {
  const dir = path.join(scannerDataDir(), "scanner-uploads");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

// ── POST /api/scanner/sessions ────────────────────────
/**
 * 安全 R35：核验扫描端上报的答题卡版本。
 *
 * 扫描端可以长时间离线，本机缓存的卡会与服务器分叉（版面挪了、答案改了、分数调了）。
 * 客户端在**本机**完成识别与判分，用的就是那份缓存卡；服务器随后按自己那一版卡汇总入库。
 * 两边不是同一版时，分数是错的，而现场看不出任何异常——所以必须在入库前比对版本，
 * 不一致就拒绝，让老师重新同步答题卡。
 *
 * 返回 null 表示放行；否则返回要直接回给客户端的错误。
 */
async function cardVersionProblem(
  cardId: string,
  rawVersion: unknown,
): Promise<{ status: number; code: string; message: string } | null> {
  const version = parseCardVersion(rawVersion);
  if (!version) {
    return {
      status: 400,
      code: "CARD_VERSION_REQUIRED",
      message: "缺少或非法的 cardVersion：请升级扫描端，并重新选择该答题卡以同步最新版本后再上传",
    };
  }
  const card = await new CardRepository().findById(cardId);
  if (!card) {
    return { status: 404, code: "CARD_NOT_FOUND", message: "答题卡不存在或已删除，无法核验版本" };
  }
  const serverVersion = cardFingerprint(card);
  if (serverVersion !== version) {
    return {
      status: 409,
      code: "CARD_VERSION_MISMATCH",
      message:
        `答题卡已在服务器更新（服务器版本 ${serverVersion.slice(0, 12)}，扫描端版本 ${version.slice(0, 12)}）：` +
        "按旧版卡识别判分的结果不能入库，请重新同步答题卡后重扫或重新上传",
    };
  }
  return null;
}

router.post("/sessions", dualAuth, async (req: Request, res: Response) => {
  try {
    const { cardId, name, dpi, paperSize } = req.body ?? {};
    if (!cardId) {
      res.status(400).json({ message: "cardId 必填" });
      return;
    }
    // 安全（R22）：页数先夹紧再落库，避免一次请求插入任意多条记录/令牌
    const requestedPages = parseScanSessionPageCount(req.body?.pageCount);
    if (requestedPages === null) {
      res.status(400).json({ message: `pageCount 需为 1–${MAX_SCAN_SESSION_PAGES} 的整数` });
      return;
    }
    // 安全（PR #312 复核 · 会话创建越权）：先收口考试归属，再谈版本号。
    // `/sessions/:sessionId` 那组范围中间件在此刻还没有 sessionId，挂不上来；而 R35 的版本核验
    // 只证明「这张卡是真的」。于是原先一个读得到答题卡、却不在该考试范围内的教师（例如只被分配
    // 了另一场考试的阅卷人），可以对着这张卡反复建会话：每个会话落 1 行 session 与最多
    // MAX_SCAN_SESSION_PAGES 行待上传记录 + 令牌，后续页上传虽被 403 挡住，垃圾行已经写进去了。
    // 这里复用列表端点同一份判断（enforceScannerCardScope），API Key 扫描端凭据按设计继续直连。
    // 放在版本核验之前还有第二层作用：越权调用方不会从 409 文案里读到服务器侧的版本指纹。
    if (!(await enforceScannerCardScope(req, res, String(cardId)))) return;
    // 安全 R35：会话都不给建，旧版本的页自然一张也传不上来
    const versionProblem = await cardVersionProblem(String(cardId), req.body?.cardVersion);
    if (versionProblem) {
      console.warn(
        `[scanner-upload] 会话创建被拒（${versionProblem.code}）cardId=${cardId} ` +
          `clientVersion=${parseCardVersion(req.body?.cardVersion) ?? "none"}`,
      );
      res.status(versionProblem.status).json({ code: versionProblem.code, message: versionProblem.message });
      return;
    }

    const sessionId = `scan_${genId()}`;
    const db = await getMysqlDb();

    // 给每页生成上传 token（简单防篡改）
    const uploadTokens: string[] = [];
    for (let i = 0; i < requestedPages; i++) uploadTokens.push(genId());

    // 会话与其全部待上传页必须在同一事务内写入：中途失败会留下「会话存在但缺页」的半成品，
    // 客户端后续 complete 会因页数为 0 而卡死。
    await db.transaction(async (tx) => {
      await tx.run(
        `INSERT INTO twain_scan_sessions (id, card_id, name, dpi, duplex, color_mode, paper_size, page_count, identity_mode, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploading')`,
        sessionId,
        String(cardId),
        name || `扫描_${new Date().toISOString().slice(0, 10)}`,
        // 安全（#24）：远端扫描端上报的 DPI 同样夹紧后再落库。
        parseRecognitionDpi(dpi),
        1,            // duplex
        "gray",       // color_mode
        paperSize || "A4",
        requestedPages,
        parseIdentityMode(req.body?.identityMode),
      );
      for (let i = 0; i < requestedPages; i++) {
        await tx.run(
          `INSERT INTO twain_scan_records (id, session_id, card_id, image_path, page_num, side, ocr_status)
           VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
          uploadTokens[i], sessionId, String(cardId), `pending:${uploadTokens[i]}`, i + 1, i === 0 ? "front" : "back"
        );
      }
    });

    res.status(201).json({
      sessionId,
      uploadTokens,
      message: `会话已创建，共 ${requestedPages} 页待上传`,
    });
  } catch (err: any) {
    // 安全审计（F-12-1）：不向客户端回传内部错误原文，仅写服务端日志
    console.error("[scanner-upload] 请求处理失败:", err);
    res.status(500).json({ message: "请求处理失败，请查看服务器日志" });
  }
});

// ── POST /api/scanner/sessions/:sessionId/pages ─────────
router.post("/sessions/:sessionId/pages", dualAuth, pageUploadBudget, pageUpload.single("image"), async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const token = (req.body?.token ?? req.query?.token) as string;
    const pageNum = Number(req.body?.pageNum ?? 1);
    const rawSide = (req.body?.side as string) || "front";
    // 白名单校验，防止 side 参数触发路径遍历
    const side = rawSide === "back" ? "back" : "front";
    if (!Number.isInteger(pageNum) || pageNum < 1 || pageNum > 999) {
      res.status(400).json({ message: "无效的页码" });
      return;
    }

    if (!req.file) {
      res.status(400).json({ message: "未上传图片" });
      return;
    }
    // 魔数校验（Content-Type/扩展名可伪造，文件头不可）
    if (!isValidImageBuffer(req.file.buffer)) {
      res.status(400).json({ message: "上传的文件不是受支持的图片格式" });
      return;
    }
    if (!token) {
      res.status(400).json({ message: "缺少 upload token" });
      return;
    }

    const db = await getMysqlDb();

    // 验证 session
    const session = await db.get<{ id: string; card_id: string; identity_mode: string; status: string }>(
      "SELECT id, card_id, identity_mode, status FROM twain_scan_sessions WHERE id = ?", sessionId);
    if (!session) {
      res.status(404).json({ message: "会话不存在" });
      return;
    }
    const record = await db.get<{ ocr_status: string }>(
      "SELECT id, ocr_status FROM twain_scan_records WHERE id = ? AND session_id = ?", token, sessionId);
    if (!record) { res.status(400).json({ message: "扫描页不属于当前会话" }); return; }
    // 安全（R02）：会话完成（或该页已入库）后，令牌即失效。
    // 此前令牌在 ocr_status='completed' 后仍然可用，任何持有旧令牌者都能覆盖已判分页面
    // 的图片与识别结果，把「已完成扫描」变成对既有成绩的静默改写。
    // 需要重扫时由扫描端新建会话，归属仍按原会话回执保持不变。
    if (session.status === "completed" || record.ocr_status === "completed") {
      res.status(409).json({ message: "该扫描会话已完成，页面不可再改写；请新建扫描会话后重新上传" });
      return;
    }
    // 安全（PR #312 复核 CR2）：/complete 部分失败时已保存的分组既没有 completed 会话也没有
    // completed 页面，只看状态会漏掉它们——那一页的成绩其实已经入库。改看回执归属。
    const savedOwner = await savedReceiptOwnerOfPage(String(sessionId), token);
    if (savedOwner) {
      res.status(409).json({
        message: "该扫描页的成绩已入库，不能由上传直接改写；请在阅卷端撤回或订正后重新扫描",
        code: "SCAN_PAGE_SAVED", examId: savedOwner.exam_id,
      });
      return;
    }
    let recognition: z.infer<typeof recognitionSchema> | undefined;
    if (req.body.recognition) {
      try { recognition = recognitionSchema.parse(JSON.parse(req.body.recognition)); }
      catch {
        await invalidateScanRecognition(String(sessionId), token);
        await db.run("UPDATE twain_scan_records SET ocr_status = 'failed', ocr_error = ? WHERE id = ?", "识别结果格式无效，请更新扫描端后重试", token);
        res.status(400).json({ message: "识别结果格式无效，请更新扫描端后重试" }); return;
      }
    }

    const card = await new CardRepository().findById(session.card_id);
    if (!card) { res.status(404).json({ message: "答题卡不存在" }); return; }
    const mapped = mapScanPageToLayout(pageNum, side, buildLayout(card).pages.length, card.sided);
    const identity = recognition?.identity;
    const verified = identity?.status === "verified" && identity.cardId === card.id && identity.pageNumber === mapped.layoutPage;
    const legacy = session.identity_mode === "legacy" && identity?.status === "unverified" && ["QR_MISSING", "QR_UNREADABLE"].includes(identity.code);
    if (mapped.unusedSide || (!verified && !legacy)) {
      await invalidateScanRecognition(String(sessionId), token);
      await db.run("UPDATE twain_scan_records SET ocr_status = 'failed', ocr_error = ? WHERE id = ?", "页面未通过二维码身份校验", token);
      res.status(409).json({ message: "页面未通过二维码身份校验，请在 Windows 扫描端重新识别" }); return;
    }

    // 保存图片（对扩展名做白名单，session id 用 basename 兜底，避免路径遍历）
    const rawExt = path.extname(req.file.originalname).toLowerCase();
    const ext = [".jpg", ".jpeg", ".png", ".webp", ".bmp"].includes(rawExt) ? rawExt : ".jpg";
    const safeSessionId = path.basename(String(sessionId));
    const fileName = `${safeSessionId}_p${String(pageNum).padStart(2, "0")}_${side}${ext}`;
    const filePath = path.join(scannerUploadDir(), fileName);
    writeFileSync(filePath, req.file.buffer);

    // 更新记录
    if (token) {
      await db.run(
        `UPDATE twain_scan_records SET image_path = ?, page_num = ?, side = ?, ocr_status = 'uploaded'
         WHERE id = ? AND session_id = ?`,
        filePath, pageNum, side, token, sessionId
      );
    }

    if (recognition) {
      await db.run("UPDATE twain_scan_records SET identity_json = ? WHERE id = ?", JSON.stringify(recognition.identity), token);
      await upsertRecognitionResult({ scanRecordId: token,
        objectiveJson: JSON.stringify(recognition.questions),
        subjectiveJson: JSON.stringify(recognition.subjectiveQuestions), gradeStatus: "recognized" });
      await db.run("UPDATE twain_scan_records SET student_id = ?, recognized_at = CURRENT_TIMESTAMP WHERE id = ? AND session_id = ?",
        recognition.studentId.value, token, sessionId);
    }

    res.json({ ok: true, pageNum, side, fileName });
  } catch (err: any) {
    // 安全审计（F-12-1）：不向客户端回传内部错误原文，仅写服务端日志
    console.error("[scanner-upload] 请求处理失败:", err);
    res.status(500).json({ message: "请求处理失败，请查看服务器日志" });
  }
});

// ── POST /api/scanner/sessions/:sessionId/complete ──────
router.post("/sessions/:sessionId/pages/:recordId/crops", dualAuth, cropUploadBudget, cropUpload.array("crops", MAX_CROPS_PER_REQUEST), async (req: Request, res: Response) => {
  try {
    const sessionId = String(req.params.sessionId);
    const recordId = String(req.params.recordId);
    const db = await getMysqlDb();
    const record = await db.get<any>(
      "SELECT id, card_id, student_id, identity_json, ocr_status FROM twain_scan_records WHERE id = ? AND session_id = ?",
      recordId,
      sessionId
    );
    if (!record) {
      res.status(404).json({ message: "扫描页不存在" });
      return;
    }

    // 安全（R02）：会话终态后切块同样不可重放——否则已入库成绩的阅卷图会被静默替换
    const session = await db.get<{ status: string }>(
      "SELECT status FROM twain_scan_sessions WHERE id = ?", sessionId);
    if (!session) { res.status(404).json({ message: "会话不存在" }); return; }
    if (session.status === "completed") {
      res.status(409).json({ message: "该扫描会话已完成，切块不可再改写；请新建扫描会话后重新上传" });
      return;
    }
    // 安全（PR #312 复核 CR2）：切块是阅卷人实际看到的图，同样不能覆盖已入库回执的页面。
    if (await savedReceiptOwnerOfPage(sessionId, recordId)) {
      res.status(409).json({ message: "该扫描页的成绩已入库，切块不可再由上传改写", code: "SCAN_PAGE_SAVED" });
      return;
    }

    if (!record.identity_json || !["uploaded", "completed"].includes(record.ocr_status)) {
      res.status(409).json({ message: "页面尚未通过身份校验，不能上传切块" }); return;
    }
    const manifestRaw = typeof req.body?.manifest === "string" ? req.body.manifest : "[]";
    let manifest: Array<z.infer<typeof cropManifestSchema>>;
    try {
      const parsed: unknown = JSON.parse(manifestRaw);
      if (!Array.isArray(parsed)) throw new Error("manifest 必须是数组");
      if (parsed.length > MAX_CROPS_PER_REQUEST) throw new Error(`单次最多 ${MAX_CROPS_PER_REQUEST} 个切块`);
      manifest = parsed.map((item, index) => cropManifestSchema.parse(item));
    } catch (err: any) {
      res.status(400).json({ message: `切块清单无效: ${err?.message ?? "格式错误"}` });
      return;
    }
    const files = Array.isArray(req.files) ? req.files as Express.Multer.File[] : [];
    for (const file of files) {
      if (!isValidImageBuffer(file.buffer)) {
        res.status(400).json({ message: `切块文件 ${file.originalname} 不是受支持的图片格式` });
        return;
      }
    }
    const tempDir = path.resolve(scannerUploadDir(), "crops-temp", path.basename(sessionId), path.basename(recordId));
    if (!existsSync(tempDir)) mkdirSync(tempDir, { recursive: true });

    let saved: CropPersistenceStats;
    try {
      const crops: RecognitionBlockCrop[] = [];
      for (const [index, crop] of manifest.entries()) {
        const file = crop.fileName
          ? files.find((item) => item.originalname === crop.fileName)
          : files[index];
        if (!file) continue;
        const targetPath = path.join(tempDir, `${index}_${path.basename(file.originalname || "crop.png")}`);
        // 安全（R07）：写入前再确认一次路径仍在本次请求的临时目录内
        if (!insideDir(tempDir, targetPath)) continue;
        writeFileSync(targetPath, file.buffer);
        // 只采用校验过的字段；客户端上报的 path 与其它额外字段一律丢弃
        crops.push({
          blockId: crop.blockId,
          blockTitle: crop.blockTitle ?? "",
          blockType: crop.blockType ?? "",
          pageNumber: crop.pageNumber,
          segmentIndex: crop.segmentIndex,
          questionNumbers: crop.questionNumbers,
          rect: crop.rect,
          widthPx: crop.widthPx,
          heightPx: crop.heightPx,
          dpi: crop.dpi,
          path: targetPath,
        });
      }

      saved = await persistAnswerBlockCrops({
        cardId: String(record.card_id),
        studentNumber: record.student_id ?? null,
        sourceType: "twain_scan_record",
        sourceRecordId: recordId,
        crops
      }, db);
    } finally {
      // 切块要么被持久化搬走，要么本次无效；临时目录不留残余（否则每次重试都在涨盘）
      await rm(tempDir, { recursive: true, force: true }).catch((err) => console.warn("[scanner-upload] 切块临时目录清理失败:", err));
    }
    // 响应排在清理之后：客户端拿到 200 时磁盘状态已确定，重试不会与残余目录相互干扰
    res.json({ ok: true, count: saved.persisted, skipped: saved.skipped, crops: [] });
  } catch (err: any) {
    // 安全审计（F-12-1）：不向客户端回传内部错误原文，仅写服务端日志
    console.error("[scanner-upload] 请求处理失败:", err);
    res.status(500).json({ message: "请求处理失败，请查看服务器日志" });
  }
});
// The Linux service edits uploaded metadata only; it never invokes native recognition.
router.get("/records/:recordId/image", dualAuth, async (req, res, next) => {
  try {
    const row = await getMysqlDb().get<{ image_path: string }>("SELECT image_path FROM twain_scan_records WHERE id = ?", req.params.recordId);
    if (!row || !row.image_path || !existsSync(row.image_path)) { res.status(404).json({ message: "原卷图片不存在" }); return; }
    // 安全（R04）：只允许读取数据目录内的图片，路径被改写/遗留绝对路径时不外发任意文件
    const imagePath = path.resolve(row.image_path);
    if (!isInsideDir(scannerDataDir(), imagePath) || !/\.(jpg|jpeg|png|webp|bmp)$/i.test(imagePath)) {
      res.status(404).json({ message: "原卷图片不存在" }); return;
    }
    res.setHeader("Cache-Control", "private, no-store");
    res.sendFile(imagePath);
  } catch (error) { next(error); }
});
router.get("/sessions/:sessionId/results", dualAuth, async (req, res, next) => {
  try {
    const session = await getMysqlDb().get<{ card_id: string }>("SELECT card_id FROM twain_scan_sessions WHERE id = ?", req.params.sessionId);
    const card = session && await new CardRepository().findById(session.card_id);
    if (!card) { res.status(404).json({ message: "扫描会话或答题卡不存在" }); return; }
    res.json(await processScannerSession(card, String(req.params.sessionId)));
  } catch (error) { next(error); }
});
router.post("/sessions/:sessionId/correct", dualAuth, async (req, res, next) => {
  try {
    const sessionId = String(req.params.sessionId);
    const studentId = req.body?.studentId;
    if (typeof studentId !== "string" || !/^[0-9A-Za-z_-]{1,64}$/.test(studentId)) {
      res.status(400).json({ message: "请输入有效学号（1–64 位字母、数字、下划线或短横线）" }); return;
    }
    const session = await getMysqlDb().get<{ card_id: string }>("SELECT card_id FROM twain_scan_sessions WHERE id = ?", sessionId);
    const card = session && await new CardRepository().findById(session.card_id);
    if (!card) { res.status(404).json({ message: "扫描会话或答题卡不存在" }); return; }
    const preview = await processScannerSession(card, sessionId);
    const groupId = String(req.body?.groupId ?? "");
    if (!preview.failures.some(f => f.groupId === groupId && f.conflicts?.length)
      && !preview.reviewCards?.some(c => c.sessionId === sessionId && c.groupId === groupId)) {
      res.status(409).json({ message: "此卷没有重复学号冲突，请刷新结果" }); return;
    }
    await enqueueScannerSubmission(async () => {
      const records = (await listScanRecordsGroupedByStudent(sessionId)).flatMap(g => g.records);
      const group = groupSessionPages(card, records).groups.get(groupId);
      if (!group) throw new Error("答题卡分组不存在");
      await getMysqlDb().transaction(async tx => {
        for (const { record } of group) await tx.run("UPDATE twain_scan_records SET student_id = ? WHERE id = ? AND session_id = ?", studentId, record.id, sessionId);
      });
    });
    res.json(await processScannerSession(card, sessionId, "validate"));
  } catch (error) { next(error); }
});

router.post("/sessions/:sessionId/complete", dualAuth, async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const db = await getMysqlDb();

    const session = await db.get<{ id: string; card_id: string; page_count: number; status: string }>(
      "SELECT id, card_id, page_count, status FROM twain_scan_sessions WHERE id = ?",
      sessionId
    );
    if (!session) {
      res.status(404).json({ message: "会话不存在" });
      return;
    }

    // 安全 R35：扫描到入库之间可能隔了几十分钟，服务器上的卡在这期间被改过就不能再入库。
    const versionProblem = await cardVersionProblem(session.card_id, req.body?.cardVersion);
    if (versionProblem) {
      console.warn(
        `[scanner-upload] 会话完成被拒（${versionProblem.code}）session=${sessionId} cardId=${session.card_id} ` +
          `clientVersion=${parseCardVersion(req.body?.cardVersion) ?? "none"}`,
      );
      res.status(versionProblem.status).json({ code: versionProblem.code, message: versionProblem.message });
      return;
    }

    const uploaded = await db.get<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM twain_scan_records WHERE session_id = ? AND ocr_status IN ('uploaded', 'completed')",
      sessionId
    );
    const total = await db.get<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM twain_scan_records WHERE session_id = ?",
      sessionId
    );

    const uploadedCount = Number(uploaded?.cnt ?? 0);
    const totalCount = Number(total?.cnt ?? 0);

    // v1.6.0: 检查完整性 — 未全部上传完成时阻止标记 completed
    const complete = uploadedCount >= totalCount && totalCount > 0;
    const status = complete ? "completed" : "incomplete";
    let reviewCards: import("../../shared/scanPages").ScanConflictCard[] = [];

    if (complete) {
      const fullSession = await db.get<{ card_id: string }>("SELECT card_id FROM twain_scan_sessions WHERE id = ?", sessionId);
      const card = await new CardRepository().findById(fullSession!.card_id);
      if (!card) { res.status(404).json({ message: "答题卡不存在" }); return; }
      const groups = await listScanRecordsGroupedByStudent(String(sessionId));
      if (groups.some(group => group.records.some(record => !record.recognition || !record.student_id))) {
        res.status(409).json({ message: "图片已保存，但缺少本机识别结果；请使用新版扫描端重试上传，成绩尚未入库" });
        return;
      }
      const batch = await processScannerSession(card, String(sessionId), "save");
      reviewCards = batch.reviewCards ?? [];
      if (batch.failures.length) {
        res.status(409).json({ ok: false, message: "部分答题卡未入库，请处理以下问题后重试", ...batch });
        return;
      }
      for (const result of batch.results) {
        // The saved receipt owns this attempt, including retries after closure.
        // Reusing the card for another exam must never move the original crops.
        const owners = await findSavedScannerOwners(db, String(sessionId), result.groupId, result.studentId, fullSession!.card_id);
        if (owners.length !== 1) throw new Error("扫描成绩回执归属缺失或不唯一，切图关联未完成");
        const owner = owners[0];
        for (const record of result.pages) {
          await db.run("UPDATE answer_block_crops SET exam_id = ?, student_id = ? WHERE source_type = 'twain_scan_record' AND source_record_id = ?", owner.exam_id, owner.student_id, record.recordId);
        }
      }
      const { exam: savedExam } = await resolveScannerExam(fullSession!.card_id, String(sessionId));
      const linkedExams = savedExam?.status === "grading" ? [savedExam] : [];
      for (const exam of linkedExams) {
        await recomputeExamRankings(db, exam.id);
        const roster = await ensureExamParticipants(db, exam.id);
        if (roster.rosterKnown && roster.participantCount > 0 && (await listMissingParticipants(db, exam.id)).length === 0) {
          await new ExamRepository(db).updateStatus(exam.id, "closed");
        }
      }
    }

    await db.run(
      "UPDATE twain_scan_sessions SET status = ?, page_count = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      status, uploadedCount, sessionId
    );
    if (complete) await db.run("UPDATE twain_scan_records SET ocr_status = 'completed' WHERE session_id = ?", sessionId);

    if (!complete) {
      res.status(400).json({
        ok: false,
        message: `上传未完成：${uploadedCount}/${totalCount} 页已上传，请补传缺失页面后再提交`,
        pagesUploaded: uploadedCount,
        pagesTotal: totalCount,
      });
      return;
    }

    res.json({
      ok: true,
      message: `扫描完成：${uploadedCount}/${totalCount} 页已上传并完成服务端判分`,
      reviewCards,
      pagesUploaded: uploadedCount,
      pagesTotal: totalCount,
    });
  } catch (err: any) {
    // 安全审计（F-12-1）：不向客户端回传内部错误原文，仅写服务端日志
    console.error("[scanner-upload] 请求处理失败:", err);
    res.status(500).json({ message: "请求处理失败，请查看服务器日志" });
  }
});

// ── GET /api/scanner/sessions/:sessionId/status ────────
router.get("/sessions/:sessionId/status", dualAuth, async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const db = await getMysqlDb();

    const session = await db.get<any>(
      `SELECT id, card_id, name, status, page_count, created_at, updated_at FROM twain_scan_sessions WHERE id = ?`,
      sessionId
    );
    if (!session) {
      res.status(404).json({ message: "会话不存在" });
      return;
    }

    const records = await db.all<any>(
      `SELECT id, page_num, side, ocr_status, scan_quality FROM twain_scan_records WHERE session_id = ? ORDER BY page_num`,
      sessionId
    );

    res.json({
      session,
      pages: records,
      progress: {
        total: records.length,
        uploaded: records.filter((r: any) => r.ocr_status === "uploaded" || r.ocr_status === "completed").length,
        recognized: records.filter((r: any) => r.ocr_status === "completed").length,
      },
    });
  } catch (err: any) {
    // 安全审计（F-12-1）：不向客户端回传内部错误原文，仅写服务端日志
    console.error("[scanner-upload] 请求处理失败:", err);
    res.status(500).json({ message: "请求处理失败，请查看服务器日志" });
  }
});

export default router;
