import path from "node:path";
import { mkdir } from "node:fs/promises";
import { dataDir } from "../storage";
import {
  createSession,
  createScanRecord,
  getScanRecord,
  listScanRecords,
  updateScanOcrResult,
  updateScanQuality,
  updateSessionStatus,
  incrementPageCount
} from "../database/scan-store";
import type { ScanProgressEvent, ScanSessionConfig } from "./scanner-types";
import { listSources, scan } from "./twain-bridge";
import { recognizeAnswerCard } from "../recognition";
import { readLayout, layoutPath } from "../storage";
import type { CombinedRecognitionResult } from "../../../../shared/types";

export { listSources };

export function scansDir(cardId: string): string {
  return path.join(dataDir, "scans", cardId);
}

export type ProgressHandler = (event: ScanProgressEvent) => void;

/** Full scan + OCR workflow */
export async function runScanSession(
  config: ScanSessionConfig,
  onProgress: ProgressHandler
): Promise<string> {
  const session = createSession(config.cardId, config.sessionName, {
    dpi: config.dpi,
    duplex: config.duplex,
    colorMode: config.colorMode,
    paperSize: config.paperSize
  });

  const sessionId = session.id;
  const outputDir = scansDir(config.cardId);
  await mkdir(outputDir, { recursive: true });

  try {
    // Update status
    updateSessionStatus(sessionId, "scanning");
    onProgress({ sessionId, type: "scanning", message: "正在连接扫描仪..." });

    // Execute scan via TWAIN bridge
    const filePrefix = `session_${sessionId}`;
    const scanConfig = {
      sourceName: config.sourceName,
      dpi: config.dpi,
      duplex: config.duplex,
      colorMode: config.colorMode,
      paperSize: config.paperSize,
      outputDir,
      filePrefix,
      maxPages: config.maxPages || 0,
      showUi: config.showUi
    };

    // Run scan with progress
    const result = await scan(scanConfig);

    if (!result.pages || result.pages.length === 0) {
      throw new Error(result.message || "Scan produced no pages");
    }

    // Create scan records for each page
    const recordIds: string[] = [];
    for (const page of result.pages) {
      const record = createScanRecord({
        sessionId,
        cardId: config.cardId,
        imagePath: page.path,
        pageNum: page.page,
        side: page.side as "front" | "back"
      });
      recordIds.push(record.id);
      incrementPageCount(sessionId);

      onProgress({
        sessionId,
        type: "page_done",
        pageNum: page.page,
        side: page.side,
        totalPages: result.pages.length
      });
    }

    updateSessionStatus(sessionId, "completed");

    // Auto-trigger OCR recognition
    onProgress({
      sessionId,
      type: "ocr_start",
      message: "正在识别答题卡...",
      totalPages: recordIds.length
    });

    await runOcrOnSession(sessionId, config.cardId, onProgress);

    onProgress({
      sessionId,
      type: "done",
      message: `扫描完成，共 ${recordIds.length} 张`
    });

    return sessionId;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    updateSessionStatus(sessionId, "error", msg);
    onProgress({ sessionId, type: "error", message: msg });
    throw error;
  }
}

/** Run OCR recognition on all scan records in a session */
export async function runOcrOnSession(
  sessionId: string,
  cardId: string,
  onProgress: ProgressHandler
): Promise<void> {
  const records = listScanRecords(sessionId);
  const layoutJsonPath = layoutPath(cardId);

  // Ensure layout exists
  await readLayout(cardId);

  for (const record of records) {
    if (!record.image_path) continue;

    try {
      const recognition = (await recognizeAnswerCard({
        imagePath: record.image_path,
        layoutPath: layoutJsonPath,
        pageNumber: record.page_num,
        dpi: 300
      })) as CombinedRecognitionResult;

      // Extract student ID
      const studentId = recognition.studentId?.value ?? null;
      const studentConf = recognition.studentId?.status === "ok" ? 0.9 : 0.0;
      const ocrStatus = recognition.status === "ok" ? "done" : recognition.status === "failed" ? "failed" : "review";

      // Update scan record with OCR results
      updateScanOcrResult(
        record.id,
        studentId,
        studentConf,
        ocrStatus as "done" | "failed" | "review",
        recognition.message
      );

      // Update quality if available
      if (recognition.quality?.overallScore !== undefined) {
        updateScanQuality(record.id, recognition.quality.overallScore as number);
      }

      onProgress({
        sessionId,
        type: "ocr_page_done",
        pageNum: record.page_num,
        side: record.side,
        studentId,
        studentConf
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      updateScanOcrResult(record.id, null, null, "failed", msg);

      onProgress({
        sessionId,
        type: "ocr_page_done",
        pageNum: record.page_num,
        side: record.side,
        studentId: null,
        message: msg
      });
    }
  }

  onProgress({ sessionId, type: "ocr_done", message: "识别完成" });
}

/** Get scan records with their recognized student IDs for a card */
export async function getCardScansWithStudents(cardId: string) {
  const { listScansForCard } = await import("../database/scan-store");
  return listScansForCard(cardId);
}
