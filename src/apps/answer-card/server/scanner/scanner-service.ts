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
  incrementPageCount,
  upsertRecognitionResult
} from "../database/scan-store";
import type { ScanProgressEvent, ScanSessionConfig } from "./scanner-types";
import { listSources, scan } from "./twain-bridge";
import { recognizeAnswerCard } from "../recognition";
import { readLayout, layoutPath, readCard } from "../storage";
import { gradeCombinedRecognition } from "../../../../shared/grading";
import type { AnswerCard, CombinedRecognitionResult } from "../../../../shared/types";

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
      throw new Error(result.message || "扫描未产生任何页面");
    }

    // Read card to check if single-sided → discard back sides
    const card = await readCard(config.cardId);
    const isSingleSided = card?.sided === "single";
    const filteredPages = isSingleSided
      ? result.pages.filter((page) => page.side === "front")
      : result.pages;

    if (filteredPages.length === 0) {
      throw new Error("扫描结果中没有任何正面页面");
    }

    // Create scan records for each page (filtered for single-sided cards)
    const recordIds: string[] = [];
    for (const page of filteredPages) {
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
        totalPages: filteredPages.length
      });
    }

    if (isSingleSided && result.pages.length > filteredPages.length) {
      const skipped = result.pages.length - filteredPages.length;
      onProgress({
        sessionId,
        type: "scanning",
        message: `（单面答题卡：已跳过 ${skipped} 张背面）`
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

  // Ensure layout exists and read card for sided info
  await readLayout(cardId);
  const card = await readCard(cardId);
  const isSingleSided = card?.sided === "single";

  for (const record of records) {
    if (!record.image_path) continue;

    // Compute layout page number
    const layoutPage = isSingleSided
      ? record.page_num
      : (record.page_num - 1) * 2 + (record.side === "front" ? 1 : 2);

    try {
      const recognition = (await recognizeAnswerCard({
        imagePath: record.image_path,
        layoutPath: layoutJsonPath,
        pageNumber: layoutPage,
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

      // Store recognition results + grading
      if (card) {
        try {
          const graded = gradeCombinedRecognition(card, record.image_path, recognition);
          upsertRecognitionResult({
            scanRecordId: record.id,
            objectiveJson: JSON.stringify(recognition.questions),
            subjectiveJson: JSON.stringify(recognition.subjectiveQuestions ?? []),
            totalScore: graded.totalScore,
            maxScore: graded.totalMaxScore,
            gradeStatus: "done"
          });
        } catch (gradeError) {
          console.error(`[Scanner] Grading failed for record ${record.id}:`, gradeError);
          upsertRecognitionResult({
            scanRecordId: record.id,
            objectiveJson: JSON.stringify(recognition.questions),
            subjectiveJson: JSON.stringify(recognition.subjectiveQuestions ?? []),
            gradeStatus: "pending"
          });
        }
      }

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
