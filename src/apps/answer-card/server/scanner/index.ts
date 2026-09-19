import { processScannerSession } from "../../../../server/services/scannerSubmissions";
import { scannerLegacyRecoveryRouter } from "../../../../server/routes/scanner-legacy-recovery";
import { requireScannerExamScope } from "../../../../server/middleware/scanner-scope";
import { Router, type Response } from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { listSources, runScanSession, createScanSession, runOcrOnSession, getCardScansWithStudents } from "./scanner-service";
import { cancelScan } from "./twain-bridge";
import {
  listScanRecords,
  getScanRecordWithResult,
  deleteScanRecord,
  getSession,
  updateSessionStatus,
  listSessions,
  deleteSession,
  listScanRecordsGroupedByStudent
} from "../database/scan-store";
import { safeId, readCard, dataDir } from "../storage";
import type { ScanSessionConfig, ScanProgressEvent } from "./scanner-types";
import { collectSessionResults, groupSessionPages } from "./session-results";

// persistScannerResultToMainDb 的串行队列（模块级，跨请求生效）：
// better-sqlite3 是单连接,并发事务会在 BEGIN/COMMIT 之间互相穿插（见 SqliteAdapter.transaction 注释），
// 因此所有「扫描 → 主库」持久化必须串行执行；MariaDB 下也能避免瞬时打满连接池。
let persistQueue: Promise<void> = Promise.resolve();
function enqueuePersist(task: () => Promise<void>): Promise<void> {
  const run = persistQueue.then(() => task());
  persistQueue = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * 创建扫描路由。
 * @param twainEnabled 是否启用 TWAIN 原生扫描（依赖本机 scanner-bridge.exe）。
 *                     Web 部署关闭时，/sources、/scan、/progress 返回 404，
 *                     但答题卡图片预览等纯文件/存储路由始终可用。
 */
export function createScannerRouter(twainEnabled = true): Router {
  const router = Router();
  router.use("/session/:sessionId", requireScannerExamScope);
  router.use(scannerLegacyRecoveryRouter());

  // Write scanner result to projectx.db for linked exams
  // Progress event emitters by sessionId (for WebSocket integration)
  const progressEmitters = new Map<string, Set<(event: ScanProgressEvent) => void>>();

  function emitProgress(sessionId: string, event: ScanProgressEvent) {
    const listeners = progressEmitters.get(sessionId);
    if (listeners) {
      for (const fn of listeners) fn(event);
    }
  }

  // ── TWAIN 专用路由（依赖本机 scanner-bridge.exe）──────────
  if (twainEnabled) {
    router.get("/sources", async (_req, res, next) => {
      try {
        const result = await listSources();
        res.json(result);
      } catch (error) {
        next(error);
      }
    });

    router.post("/scan", async (req, res, next) => {
      try {
        const body = req.body as Partial<ScanSessionConfig>;

        if (!body.cardId) {
          res.status(400).json({ message: "缺少 cardId 参数" });
          return;
        }

        const config: ScanSessionConfig = {
          cardId: safeId(body.cardId),
          sessionName: body.sessionName || `扫描_${new Date().toLocaleDateString("zh-CN")}`,
          sourceName: body.sourceName || "",
          dpi: body.dpi && body.dpi > 0 ? body.dpi : 300,
          duplex: body.duplex === true,
          colorMode: body.colorMode || "gray",
          paperSize: body.paperSize || "A4",
          maxPages: body.maxPages || 0,
          showUi: body.showUi === true
        };

        // 先建会话拿 sessionId，立即返回 202；扫描 + OCR 后台执行。
        const sessionId = await createScanSession(config);

        res.status(202).json({
          sessionId,
          message: "扫描已启动",
          status: "scanning"
        });

        void runScanSession(sessionId, config, (event) => {
          emitProgress(event.sessionId, event);
        }).catch((error) => {
          console.error(`[Scanner] Scan session ${sessionId} failed:`, error);
        });
      } catch (error) {
        next(error);
      }
    });

    // ── Cancel Scan Session ──────────────────────────────
    // 真正终止 scanner-bridge.exe 子进程（kill + 强杀兜底），并广播 cancelled 事件
    router.post("/scan/:sessionId/cancel", async (req, res, next) => {
      try {
        const id = safeId(req.params.sessionId);
        const session = await getSession(id);
        if (!session) {
          res.status(404).json({ message: "扫描会话不存在" });
          return;
        }
        if (session.status === "completed" || session.status === "error" || session.status === "cancelled") {
          res.json({ message: "扫描已结束，无需取消", status: session.status });
          return;
        }

        const terminated = cancelScan(id);
        await updateSessionStatus(id, "cancelled", "用户取消扫描");
        emitProgress(id, { sessionId: id, type: "cancelled", message: "扫描已取消" });

        res.json({
          message: "扫描已取消",
          status: "cancelled",
          // terminated=false 表示子进程尚未启动（取消意图已记录，runBridge 启动前会拦截）
          terminated
        });
      } catch (error) {
        next(error);
      }
    });

    // ── Progress Events (SSE) ────────────────────────────
    router.get("/progress/:sessionId", async (req, res) => {
      try {
        const sessionId = safeId(req.params.sessionId);

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no"
        });

        const removeHandler = () => {
          const listeners = progressEmitters.get(sessionId);
          if (listeners) {
            listeners.delete(handler);
            if (listeners.size === 0) progressEmitters.delete(sessionId);
          }
        };

        const handler = (event: ScanProgressEvent) => {
          if (res.writableEnded || res.destroyed) return;
          res.write(`data: ${JSON.stringify(event)}\n\n`);
          if (event.type === "done" || event.type === "error" || event.type === "cancelled") {
            // 终态即移除自己（不依赖 close 事件的延迟清理），缩小竞态窗口
            removeHandler();
            res.end();
          }
        };

        // Register listener
        if (!progressEmitters.has(sessionId)) {
          progressEmitters.set(sessionId, new Set());
        }
        progressEmitters.get(sessionId)!.add(handler);

        req.on("close", () => {
          removeHandler();
        });

        // 订阅时若会话已终态（扫描可能在订阅前就完成/失败/被取消），补发终态事件
        const session = await getSession(sessionId);
        if (res.writableEnded || res.destroyed) return;
        if (session && (session.status === "completed" || session.status === "error" || session.status === "cancelled")) {
          removeHandler();
          if (session.status === "completed") {
            res.write(`data: ${JSON.stringify({ sessionId, type: "done", message: "扫描已完成" })}\n\n`);
          } else if (session.status === "cancelled") {
            res.write(`data: ${JSON.stringify({ sessionId, type: "cancelled", message: "扫描已取消" })}\n\n`);
          } else {
            res.write(`data: ${JSON.stringify({ sessionId, type: "error", message: session.error_msg || "扫描出错" })}\n\n`);
          }
          res.end();
        }
      } catch (error) {
        // getSession 等 DB 异常：关闭连接，避免 unhandled rejection 挂住
        console.error(`[Scanner] SSE progress ${req.params.sessionId} failed:`, error);
        res.end();
      }
    });
  } else {
    router.all(["/sources", "/scan", "/progress/:sessionId"], (_req, res) => {
      res.status(404).json({ message: "Scanner (TWAIN) is disabled in this Project-X package." });
    });
  }

  // ── Scan Session Status ──────────────────────────────

  router.get("/scan/:sessionId", async (req, res, next) => {
    try {
      const session = await getSession(safeId(req.params.sessionId));
      if (!session) {
        res.status(404).json({ message: "扫描会话不存在" });
        return;
      }

      const records = await listScanRecords(session.id);
      res.json({
        session,
        records: records.map((r) => ({
          id: r.id,
          pageNum: r.page_num,
          side: r.side,
          studentId: r.student_id,
          studentConf: r.student_conf,
          ocrStatus: r.ocr_status,
          scanQuality: r.scan_quality,
          imagePath: r.image_path
        }))
      });
    } catch (error) {
      next(error);
    }
  });

  // ── List Sessions for a Card ─────────────────────────

  router.get("/sessions/:cardId", async (req, res, next) => {
    try {
      const sessions = await listSessions(safeId(req.params.cardId));
      res.json(sessions);
    } catch (error) {
      next(error);
    }
  });

  // ── Cancel / Delete Session ──────────────────────────

  router.delete("/scan/:sessionId", async (req, res, next) => {
    try {
      const id = safeId(req.params.sessionId);
      const session = await getSession(id);
      if (!session) {
        res.status(404).json({ message: "扫描会话不存在" });
        return;
      }
      await deleteSession(id);
      res.json({ message: "已删除" });
    } catch (error) {
      next(error);
    }
  });

  // ── Scan Record Detail ───────────────────────────────

  router.get("/record/:recordId", async (req, res, next) => {
    try {
      const record = await getScanRecordWithResult(safeId(req.params.recordId));
      if (!record) {
        res.status(404).json({ message: "扫描记录不存在" });
        return;
      }
      res.json(record);
    } catch (error) {
      next(error);
    }
  });

  // ── Delete Scan Record ───────────────────────────────

  router.delete("/record/:recordId", async (req, res, next) => {
    try {
      const id = safeId(req.params.recordId);
      const record = await getScanRecordWithResult(id);
      if (!record) {
        res.status(404).json({ message: "扫描记录不存在" });
        return;
      }
      await deleteScanRecord(id);
      res.json({ message: "已删除" });
    } catch (error) {
      next(error);
    }
  });

  // ── Card Scans Summary ───────────────────────────────

  router.get("/card/:cardId/scans", async (req, res, next) => {
    try {
      const scans = await getCardScansWithStudents(safeId(req.params.cardId));
      res.json(
        scans.map((s) => ({
          recordId: s.record.id,
          studentId: s.record.student_id,
          studentConf: s.record.student_conf,
          ocrStatus: s.record.ocr_status,
          pageNum: s.record.page_num,
          side: s.record.side,
          imagePath: s.record.image_path,
          scanQuality: s.record.scan_quality,
          createdAt: s.record.created_at,
          recognition: s.recognition
            ? {
                totalScore: s.recognition.total_score,
                maxScore: s.recognition.max_score,
                gradeStatus: s.recognition.grade_status
              }
            : null
        }))
      );
    } catch (error) {
      next(error);
    }
  });

  // ── Find Scans by Exam + Student (for ScoreTable preview) ──

  router.get("/exam/:examId/student/:studentId/scans", async (req, res, next) => {
    try {
      const examId = Number(req.params.examId);
      const studentId = Number(req.params.studentId);
      if (!Number.isFinite(examId) || !Number.isFinite(studentId)) {
        res.status(400).json({ message: "Invalid examId or studentId" });
        return;
      }

      const { getMysqlDb } = await import("../../../../server/db");
      const db = getMysqlDb();

      const exam = await db.get("SELECT card_id FROM exams WHERE id = ?", examId) as { card_id: string | null } | undefined;
      if (!exam || !exam.card_id) {
        res.json({ studentId, studentNumber: "", pages: [] });
        return;
      }

      const cardId = exam.card_id;
      const user = await db.get("SELECT student_number FROM users WHERE id = ?", studentId) as { student_number: string | null } | undefined;

      // Query scan_records for this student in this exam
      const records = await db.all(`
        SELECT sr.id, sr.file_path, sr.file_name
        FROM scan_records sr
        JOIN scan_batches sb ON sr.batch_id = sb.id
        WHERE sb.exam_id = ? AND sr.student_id = ?
        ORDER BY sr.id
      `, examId, studentId) as Array<{ id: number; file_path: string; file_name: string }>;

      if (records.length === 0) {
        res.json({ studentId, studentNumber: user?.student_number || "", pages: [] });
        return;
      }

      // Try to resolve actual files
      const pages: Array<{ recordId: string; pageNum: number; side: string; fileName: string }> = [];
      const { existsSync: fsExists } = await import("node:fs");

      for (const rec of records) {
        // Check if file_path is an actual file (new data stores multer path)
        if (rec.file_path && fsExists(rec.file_path)) {
          const fileName = path.basename(rec.file_path);
          pages.push({
            recordId: String(rec.id),
            pageNum: pages.length + 1,
            side: "front",
            fileName
          });
        }
      }

      res.json({
        studentId,
        studentNumber: user?.student_number || "",
        cardId,
        pages
      });
    } catch (error) {
      next(error);
    }
  });

  // ── Serve grading upload image ──
  router.get("/grading-image/:cardId/:fileName", (req, res, next) => {
    try {
      const cardId = safeId(req.params.cardId);
      const fileName = path.basename(req.params.fileName);
      // Prevent directory traversal
      if (fileName.includes("..") || fileName.includes("/") || fileName.includes("\\")) {
        res.status(400).json({ message: "Invalid file name" });
        return;
      }
      const targetPath = path.join(dataDir, "recognition", "uploads", cardId, fileName);
      if (!existsSync(targetPath)) {
        res.status(404).json({ message: "图片不存在" });
        return;
      }
      const ext = path.extname(targetPath).toLowerCase();
      const contentType = ext === ".png" ? "image/png" : "image/jpeg";
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "private, max-age=3600");
      res.sendFile(targetPath);
    } catch (error) {
      next(error);
    }
  });

  // ── Combined Student Results (Session-level) ─────────

  // Preview is read-only. Saving is explicit and each card is isolated from failures in others.
  router.route("/session/:sessionId/results")
    .get(async (req, res, next) => {
      try { await sessionResults(req.params.sessionId, false, res, false, req.query.previewOnly === "1"); } catch (error) { next(error); }
    })
    .post(async (req, res, next) => {
      try {
        await enqueuePersist(async () => { await sessionResults(req.params.sessionId, true, res); });
      } catch (error) { next(error); }
    });

  router.post("/session/:sessionId/validate", async (req, res, next) => {
    try { await enqueuePersist(() => sessionResults(req.params.sessionId, false, res, true)); }
    catch (error) { next(error); }
  });

  async function sessionResults(id: string, save: boolean, res: Response, validate = false, previewOnly = false) {
    const sessionId = safeId(id);
    const session = await getSession(sessionId);
    if (!session) { res.status(404).json({ message: "扫描会话不存在" }); return; }
    if (session.status !== "completed") { res.status(409).json({ message: "请等待扫描和识别全部完成" }); return; }
    const card = await readCard(session.card_id);
    if (!card) { res.status(404).json({ message: "答题卡不存在" }); return; }
    const result = previewOnly
      ? await collectSessionResults(card, (await listScanRecordsGroupedByStudent(sessionId)).flatMap(g => g.records), [])
      : await processScannerSession(card, sessionId, save ? "save" : validate ? "validate" : "preview");
    res.json(result);
  }

  router.post("/session/:sessionId/retry", async (req, res, next) => {
    try {
      if (!twainEnabled) { res.status(409).json({ message: "请在 Windows 扫描端重新识别" }); return; }
      const sessionId = safeId(req.params.sessionId);
      // Share the save queue: corrections cannot race a save or another retry.
      await enqueuePersist(async () => {
        const session = await getSession(sessionId);
        if (!session) { res.status(404).json({ message: "扫描会话不存在" }); return; }
        if (session.status !== "completed") { res.status(409).json({ message: "请等待扫描完成" }); return; }
        const card = await readCard(session.card_id);
        if (!card) { res.status(404).json({ message: "答题卡不存在" }); return; }
        const records = (await listScanRecordsGroupedByStudent(sessionId)).flatMap(g => g.records);
        const preview = await processScannerSession(card, sessionId);
        const groupId = String(req.body?.groupId ?? "");
        if (!preview.failures.some(f => f.groupId === groupId)
          && !preview.reviewCards?.some(c => c.sessionId === sessionId && c.groupId === groupId)) {
          res.status(409).json({ message: "此答题卡未失败，请刷新结果后重试" }); return;
        }
        const studentId = req.body?.studentId;
        if (studentId !== undefined && (typeof studentId !== "string" || !/^[0-9A-Za-z_-]{1,64}$/.test(studentId))) {
          res.status(400).json({ message: "请输入有效学号（1–64 位字母、数字、下划线或短横线）" }); return;
        }
        const rows = groupSessionPages(card, records).groups.get(groupId)!;
        await runOcrOnSession(sessionId, session.card_id, () => {}, {
          recordIds: new Set(rows.map(r => r.record.id)), studentId,
        });
        await sessionResults(sessionId, false, res, true);
      });
    } catch (error) { next(error); }
  });

  // ── Scan Image Serving ────────────────────────────────

  router.get("/scan-image/:recordId", async (req, res, next) => {
    try {
      const record = await getScanRecordWithResult(safeId(req.params.recordId));
      if (!record || !record.image_path) {
        res.status(404).json({ message: "扫描记录不存在" });
        return;
      }
      if (!existsSync(record.image_path)) {
        res.status(404).json({ message: "图片文件不存在" });
        return;
      }
      const ext = path.extname(record.image_path).toLowerCase();
      const contentType = ext === ".png" ? "image/png" : "image/jpeg";
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "private, max-age=3600");
      res.sendFile(record.image_path);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
