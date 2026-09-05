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
import path from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import crypto from "node:crypto";
import { dualAuth } from "../middleware/scanner-auth";
import { getMysqlDb } from "../db";
import { persistAnswerBlockCrops } from "../services/AnswerBlockCropService";
import { isValidImageBuffer } from "../../apps/answer-card/server/validate-upload";
import type { RecognitionBlockCrop } from "../../shared/types";
import { z } from "zod";
import { CardRepository } from "../repositories/CardRepository";
import { ExamRepository } from "../repositories/ExamRepository";
import { ensureExamParticipants, listMissingParticipants } from "../services/examParticipants";
import { recomputeExamRankings } from "../services/rankingUpdate";
import { gradeSessionStudentResults } from "../../shared/grading";
import { persistScannerResultToMainDb } from "../services/scannerResultPersistence";
import { listScanRecordsGroupedByStudent, upsertRecognitionResult } from "../../apps/answer-card/server/database/scan-store";

const recognitionSchema = z.object({
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

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const router = Router();

// v1.6.0: 双鉴权 — API Key 优先，无 Key 时强制 JWT（见 scanner-auth.ts）

// 生成唯一 ID
function genId(): string {
  return crypto.randomBytes(12).toString("hex");
}

function scannerUploadDir(): string {
  const base = process.env.ANSWER_CARD_DATA_DIR
    || path.join(process.cwd(), "data", "answer-card");
  const dir = path.join(base, "scanner-uploads");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

// ── POST /api/scanner/sessions ────────────────────────
router.post("/sessions", dualAuth, async (req: Request, res: Response) => {
  try {
    const { cardId, name, dpi, paperSize, pageCount } = req.body ?? {};
    if (!cardId) {
      res.status(400).json({ message: "cardId 必填" });
      return;
    }

    const sessionId = `scan_${genId()}`;
    const db = await getMysqlDb();

    await db.run(
      `INSERT INTO twain_scan_sessions (id, card_id, name, dpi, duplex, color_mode, paper_size, page_count, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'uploading')`,
      sessionId,
      String(cardId),
      name || `扫描_${new Date().toISOString().slice(0, 10)}`,
      dpi || 300,
      1,            // duplex
      "gray",       // color_mode
      paperSize || "A4",
      pageCount || 0,
    );

    // 给每页生成上传 token（简单防篡改）
    const totalPages = pageCount || 1;
    const uploadTokens: string[] = [];
    for (let i = 0; i < totalPages; i++) {
      const token = genId();
      uploadTokens.push(token);
      await db.run(
        `INSERT INTO twain_scan_records (id, session_id, card_id, image_path, page_num, side, ocr_status)
         VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
        token, sessionId, String(cardId), `pending:${token}`, i + 1, i === 0 ? "front" : "back"
      );
    }

    res.status(201).json({
      sessionId,
      uploadTokens,
      message: `会话已创建，共 ${totalPages} 页待上传`,
    });
  } catch (err: any) {
    // 安全审计（F-12-1）：不向客户端回传内部错误原文，仅写服务端日志
    console.error("[scanner-upload] 请求处理失败:", err);
    res.status(500).json({ message: "请求处理失败，请查看服务器日志" });
  }
});

// ── POST /api/scanner/sessions/:sessionId/pages ─────────
router.post("/sessions/:sessionId/pages", dualAuth, upload.single("image"), async (req: Request, res: Response) => {
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
    const session = await db.get("SELECT id FROM twain_scan_sessions WHERE id = ?", sessionId);
    if (!session) {
      res.status(404).json({ message: "会话不存在" });
      return;
    }
    const record = await db.get("SELECT id FROM twain_scan_records WHERE id = ? AND session_id = ?", token, sessionId);
    if (!record) { res.status(400).json({ message: "扫描页不属于当前会话" }); return; }
    let recognition: z.infer<typeof recognitionSchema> | undefined;
    if (req.body.recognition) {
      try { recognition = recognitionSchema.parse(JSON.parse(req.body.recognition)); }
      catch { res.status(400).json({ message: "识别结果格式无效，请更新扫描端后重试" }); return; }
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
router.post("/sessions/:sessionId/pages/:recordId/crops", dualAuth, upload.array("crops", 50), async (req: Request, res: Response) => {
  try {
    const sessionId = String(req.params.sessionId);
    const recordId = String(req.params.recordId);
    const db = await getMysqlDb();
    const record = await db.get<any>(
      "SELECT id, card_id, student_id FROM twain_scan_records WHERE id = ? AND session_id = ?",
      recordId,
      sessionId
    );
    if (!record) {
      res.status(404).json({ message: "扫描页不存在" });
      return;
    }

    const manifestRaw = typeof req.body?.manifest === "string" ? req.body.manifest : "[]";
    let manifest: Array<RecognitionBlockCrop & { fileName?: string }>;
    try {
      manifest = JSON.parse(manifestRaw) as Array<RecognitionBlockCrop & { fileName?: string }>;
      if (!Array.isArray(manifest)) throw new Error("manifest 必须是数组");
    } catch (err: any) {
      res.status(400).json({ message: `切块清单无效: ${err.message}` });
      return;
    }
    const files = Array.isArray(req.files) ? req.files as Express.Multer.File[] : [];
    for (const file of files) {
      if (!isValidImageBuffer(file.buffer)) {
        res.status(400).json({ message: `切块文件 ${file.originalname} 不是受支持的图片格式` });
        return;
      }
    }
    const tempDir = path.join(scannerUploadDir(), "crops-temp", sessionId, recordId);
    if (!existsSync(tempDir)) mkdirSync(tempDir, { recursive: true });

    const crops = manifest.map((crop, index) => {
      const file = crop.fileName
        ? files.find((item) => item.originalname === crop.fileName)
        : files[index];
      if (!file) return null;
      const targetPath = path.join(tempDir, `${index}_${path.basename(file.originalname || "crop.png")}`);
      writeFileSync(targetPath, file.buffer);
      return { ...crop, path: targetPath };
    }).filter((crop): crop is RecognitionBlockCrop => Boolean(crop));

    const saved = await persistAnswerBlockCrops({
      cardId: String(record.card_id),
      studentNumber: record.student_id ?? null,
      sourceType: "twain_scan_record",
      sourceRecordId: recordId,
      crops
    }, db);

    res.json({ ok: true, count: saved.persisted, skipped: saved.skipped, crops: [] });
  } catch (err: any) {
    // 安全审计（F-12-1）：不向客户端回传内部错误原文，仅写服务端日志
    console.error("[scanner-upload] 请求处理失败:", err);
    res.status(500).json({ message: "请求处理失败，请查看服务器日志" });
  }
});
router.post("/sessions/:sessionId/complete", dualAuth, async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const db = await getMysqlDb();

    const session = await db.get<{ id: string; page_count: number; status: string }>(
      "SELECT id, page_count, status FROM twain_scan_sessions WHERE id = ?",
      sessionId
    );
    if (!session) {
      res.status(404).json({ message: "会话不存在" });
      return;
    }
    if (session.status === "completed") {
      res.json({ ok: true, message: "扫描会话已提交", pagesUploaded: session.page_count, pagesTotal: session.page_count });
      return;
    }

    const uploaded = await db.get<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM twain_scan_records WHERE session_id = ? AND ocr_status = 'uploaded'",
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

    if (complete) {
      const fullSession = await db.get<{ card_id: string }>("SELECT card_id FROM twain_scan_sessions WHERE id = ?", sessionId);
      const card = await new CardRepository().findById(fullSession!.card_id);
      if (!card) { res.status(404).json({ message: "答题卡不存在" }); return; }
      const activeExams = await db.all<{ id: number }>("SELECT e.id FROM exams e WHERE e.card_id = ? AND e.status != 'closed' AND NOT EXISTS (SELECT 1 FROM exam_archives ea WHERE ea.exam_id = e.id AND ea.is_deleted = 1)", fullSession!.card_id);
      if (activeExams.length !== 1) {
        res.status(409).json({ message: activeExams.length === 0
          ? "答题卡没有进行中的考试，请先创建考试后重试提交"
          : "答题卡关联了多个进行中的考试，无法确定成绩和图块归属；请先保留一个目标考试后重试提交" });
        return;
      }
      const groups = await listScanRecordsGroupedByStudent(String(sessionId));
      if (groups.some(group => group.records.some(record => !record.recognition || !record.student_id))) {
        res.status(409).json({ message: "图片已保存，但缺少本机识别结果；请使用新版扫描端重试上传，成绩尚未入库" });
        return;
      }
      for (const group of groups) {
        const result = gradeSessionStudentResults(card, group.records.map(record => ({
          recordId: record.id, pageNum: record.page_num, side: record.side, imagePath: record.image_path,
          ocrStatus: "done", recognition: { status: "ok", studentId: { status: "ok", value: record.student_id },
            questions: JSON.parse(record.recognition!.objective_json || "[]"),
            subjectiveQuestions: JSON.parse(record.recognition!.subjective_json || "[]") },
        })));
        await persistScannerResultToMainDb(fullSession!.card_id, result, true);
        const student = await db.get<{ id: number }>("SELECT id FROM users WHERE student_number = ?", result.studentId);
        // Bind uploaded blocks to the same active exams as the persisted scores.
        const exams = await db.all<{ id: number }>("SELECT e.id FROM exams e JOIN student_scores ss ON ss.exam_id = e.id WHERE e.card_id = ? AND ss.student_id = ? AND e.status != 'closed' AND NOT EXISTS (SELECT 1 FROM exam_archives ea WHERE ea.exam_id = e.id AND ea.is_deleted = 1)", fullSession!.card_id, student!.id);
        for (const record of group.records) {
          // A scan block represents one exam attempt. Do not silently bind a
          // shared card's crop to an arbitrary exam when several are active.
          if (exams.length === 1) await db.run("UPDATE answer_block_crops SET exam_id = ?, student_id = ? WHERE source_type = 'twain_scan_record' AND source_record_id = ?", exams[0].id, student!.id, record.id);
        }
      }
      const linkedExams = await db.all<{ id: number }>("SELECT e.id FROM exams e WHERE e.card_id = ? AND e.status = 'grading' AND NOT EXISTS (SELECT 1 FROM exam_archives ea WHERE ea.exam_id = e.id AND ea.is_deleted = 1)", fullSession!.card_id);
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
