import { Router } from "express";
import { listSources, runScanSession, scansDir, getCardScansWithStudents } from "./scanner-service";
import { listScanRecords, getScanRecordWithResult, deleteScanRecord, getSession, listSessions, deleteSession } from "../database/scan-store";
import { safeId } from "../storage";
import type { ScanSessionConfig, ScanProgressEvent } from "./scanner-types";

export function createScannerRouter(): Router {
  const router = Router();

  // Progress event emitters by sessionId (for WebSocket integration)
  const progressEmitters = new Map<string, Set<(event: ScanProgressEvent) => void>>();

  function emitProgress(sessionId: string, event: ScanProgressEvent) {
    const listeners = progressEmitters.get(sessionId);
    if (listeners) {
      for (const fn of listeners) fn(event);
    }
  }

  // ── Scanner Sources ──────────────────────────────────

  router.get("/sources", async (_req, res, next) => {
    try {
      const result = await listSources();
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  // ── Scan Sessions ────────────────────────────────────

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
        maxPages: body.maxPages || 0
      };

      // Start scan in background
      const sessionId = await runScanSession(config, (event) => {
        emitProgress(event.sessionId, event);
      });

      res.status(202).json({
        sessionId,
        message: "扫描已启动",
        status: "scanning"
      });
    } catch (error) {
      next(error);
    }
  });

  // ── Scan Session Status ──────────────────────────────

  router.get("/scan/:sessionId", async (req, res, next) => {
    try {
      const session = getSession(safeId(req.params.sessionId));
      if (!session) {
        res.status(404).json({ message: "扫描会话不存在" });
        return;
      }

      const records = listScanRecords(session.id);
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
      const sessions = listSessions(safeId(req.params.cardId));
      res.json(sessions);
    } catch (error) {
      next(error);
    }
  });

  // ── Cancel / Delete Session ──────────────────────────

  router.delete("/scan/:sessionId", async (req, res, next) => {
    try {
      const id = safeId(req.params.sessionId);
      const session = getSession(id);
      if (!session) {
        res.status(404).json({ message: "扫描会话不存在" });
        return;
      }
      deleteSession(id);
      res.json({ message: "已删除" });
    } catch (error) {
      next(error);
    }
  });

  // ── Scan Record Detail ───────────────────────────────

  router.get("/record/:recordId", async (req, res, next) => {
    try {
      const record = getScanRecordWithResult(safeId(req.params.recordId));
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
      deleteScanRecord(id);
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

  // ── Progress Events (SSE) ────────────────────────────

  router.get("/progress/:sessionId", (req, res) => {
    const sessionId = safeId(req.params.sessionId);

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });

    const handler = (event: ScanProgressEvent) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (event.type === "done" || event.type === "error") {
        res.end();
      }
    };

    // Register listener
    if (!progressEmitters.has(sessionId)) {
      progressEmitters.set(sessionId, new Set());
    }
    progressEmitters.get(sessionId)!.add(handler);

    req.on("close", () => {
      const listeners = progressEmitters.get(sessionId);
      if (listeners) {
        listeners.delete(handler);
        if (listeners.size === 0) progressEmitters.delete(sessionId);
      }
    });
  });

  return router;
}
