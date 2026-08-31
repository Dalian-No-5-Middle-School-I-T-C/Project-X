import path from "node:path";
import { mkdir } from "node:fs/promises";
import { dataDir } from "../storage";
import {
  createSession, createScanRecord, getSession, listScanRecords,
  updateScanOcrResult, updateScanQuality, updateSessionStatus,
  incrementPageCount, upsertRecognitionResult
} from "../database/scan-store";
import type { ScanProgressEvent, ScanSessionConfig } from "./scanner-types";
import { listSources, scan } from "./twain-bridge";
import { recognizeAnswerCard } from "../recognition";
import { gradeCombinedRecognition } from "../../../../shared/grading";
import type { CombinedRecognitionResult } from "../../../../shared/types";
import { getMysqlDb } from "../../../../server/db";
import { persistAnswerBlockCrops } from "../../../../server/services/AnswerBlockCropService";
import { prepareCardLayoutById } from "../card-layout";

export { listSources };

export function scansDir(cardId: string): string {
  return path.join(dataDir, "scans", cardId);
}

async function createRecognitionCropTempDir(cardId: string, recordId: string): Promise<string> {
  const dir = path.join(dataDir, "recognition", "crop-temp", cardId, recordId);
  await mkdir(dir, { recursive: true });
  return dir;
}

export type ProgressHandler = (event: ScanProgressEvent) => void;

export type ScanPageMapping = {
  groupIndex: number;
  layoutPage: number;
  unusedSide: boolean;
};

export function mapScanPageToLayout(
  physicalPage: number,
  side: "front" | "back",
  layoutPageCount: number,
  sided: "single" | "double"
): ScanPageMapping {
  const sidesPerSheet = sided === "single" ? 1 : 2;
  const sheetsPerStudent = Math.max(1, Math.ceil(layoutPageCount / sidesPerSheet));
  const sheetIndex = Math.max(0, physicalPage - 1);
  const groupIndex = Math.floor(sheetIndex / sheetsPerStudent);
  const sheetWithinGroup = sheetIndex % sheetsPerStudent;
  const sideOffset = sidesPerSheet === 1 || side === "front" ? 1 : 2;
  const layoutPage = sheetWithinGroup * sidesPerSheet + sideOffset;
  return { groupIndex, layoutPage, unusedSide: layoutPage > layoutPageCount };
}

/** 创建扫描会话并立即返回 sessionId（POST /scan 先调它拿 id 提前返回 202） */
export async function createScanSession(config: ScanSessionConfig): Promise<string> {
  const prepared = await prepareCardLayoutById(config.cardId);
  if (!prepared) {
    throw new Error("答题卡不存在，无法开始扫描");
  }
  const session = await createSession(config.cardId, config.sessionName, {
    dpi: config.dpi,
    duplex: config.duplex,
    colorMode: config.colorMode,
    paperSize: config.paperSize
  });
  return session.id;
}

/** Full scan + OCR workflow（后台运行；sessionId 由 createScanSession 预先创建） */
export async function runScanSession(
  sessionId: string,
  config: ScanSessionConfig,
  onProgress: ProgressHandler
): Promise<string> {
  const prepared = await prepareCardLayoutById(config.cardId);
  if (!prepared) {
    throw new Error("答题卡不存在，无法开始扫描");
  }
  const card = prepared.card;
  const outputDir = scansDir(config.cardId);
  await mkdir(outputDir, { recursive: true });

  try {
    // 竞态防线 1：createScanSession 返回 202 后用户可能立即取消（此时子进程尚未注册），
    // 若取消已写入 cancelled，这里必须退出而不是把状态覆盖回 scanning
    const preScan = await getSession(sessionId);
    if (preScan?.status === "cancelled") {
      return sessionId;
    }
    await updateSessionStatus(sessionId, "scanning");
    onProgress({ sessionId, type: "scanning", message: "正在连接扫描仪..." });

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

    const result = await scan(scanConfig, sessionId);

    if (!result.pages || result.pages.length === 0) {
      throw new Error(result.message || "扫描未产生任何页面");
    }

    const isSingleSided = card.sided === "single";
    const filteredPages = isSingleSided
      ? result.pages.filter((page) => page.side === "front")
      : result.pages;

    if (filteredPages.length === 0) {
      throw new Error("扫描结果中没有任何正面页面");
    }

    const recordIds: string[] = [];
    for (const page of filteredPages) {
      const record = await createScanRecord({
        sessionId, cardId: config.cardId,
        imagePath: page.path, pageNum: page.page,
        side: page.side as "front" | "back"
      });
      recordIds.push(record.id);
      await incrementPageCount(sessionId);

      onProgress({
        sessionId, type: "page_done",
        recordId: record.id, pageNum: page.page, side: page.side,
        totalPages: filteredPages.length
      });
    }

    if (isSingleSided && result.pages.length > filteredPages.length) {
      const skipped = result.pages.length - filteredPages.length;
      onProgress({
        sessionId, type: "scanning",
        message: `（单面答题卡：已跳过 ${skipped} 张背面）`
      });
    }

    // 诊断检查点：本会话扫描结束的权威记录（页数/DPI/纸型），进 main.log 便于实机取证
    console.log(`[checkpoint] scan session=${sessionId} card=${config.cardId} pages=${filteredPages.length} dpi=${config.dpi} duplex=${config.duplex} size=${config.paperSize}`);

    // 页面落库后不置 completed：OCR 是流水线的一部分，全部完成才算终态。
    // 否则 OCR 阶段取消会被"已 completed"拒绝、SSE 补发也会提前发 done
    onProgress({
      sessionId, type: "ocr_start",
      message: "正在识别答题卡...", totalPages: recordIds.length
    });

    await runOcrOnSession(sessionId, config.cardId, onProgress);

    // 竞态防线 2：OCR 期间被取消则不再写 completed
    const postScan = await getSession(sessionId);
    if (postScan?.status === "cancelled") {
      return sessionId;
    }
    await updateSessionStatus(sessionId, "completed");

    onProgress({
      sessionId, type: "done",
      message: `扫描完成，共 ${recordIds.length} 张`
    });

    return sessionId;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    // 主动取消（cancel 接口已把状态标记为 cancelled）：不覆盖为 error 也不向上抛，
    // 避免 POST 处理器把主动取消当失败打 error 日志
    const current = await getSession(sessionId);
    if (current?.status === "cancelled") {
      return sessionId;
    }
    await updateSessionStatus(sessionId, "error", msg);
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
  const records = await listScanRecords(sessionId);
  const prepared = await prepareCardLayoutById(cardId);
  if (!prepared) {
    throw new Error("答题卡不存在，无法识别扫描结果");
  }
  const { card, layout, layoutPath: currentLayoutPath } = prepared;
  const session = await getSession(sessionId);
  const isSingleSided = card.sided === "single";
  const studentIdsByGroup = new Map<number, string>();

  for (const record of records) {
    if (!record.image_path) continue;
    const { groupIndex, layoutPage, unusedSide } = mapScanPageToLayout(
      record.page_num,
      record.side,
      layout.pages.length,
      card.sided
    );

    if (unusedSide) {
      await updateScanOcrResult(record.id, studentIdsByGroup.get(groupIndex) ?? null, null, "done", "已跳过未使用的空白背面");
      onProgress({
        sessionId,
        type: "ocr_page_done",
        recordId: record.id,
        pageNum: record.page_num,
        side: record.side,
        studentId: studentIdsByGroup.get(groupIndex) ?? null,
        message: "已跳过未使用的空白背面"
      });
      continue;
    }

    try {
      const recognition = (await recognizeAnswerCard({
        imagePath: record.image_path,
        layoutPath: currentLayoutPath,
        pageNumber: layoutPage,
        dpi: session?.dpi || 300,
        cropsDir: await createRecognitionCropTempDir(cardId, record.id)
      })) as CombinedRecognitionResult;

      const recognizedStudentId = recognition.studentId?.status === "ok" ? recognition.studentId.value : null;
      if (recognizedStudentId) {
        studentIdsByGroup.set(groupIndex, recognizedStudentId);
      }
      const inheritedStudentId = studentIdsByGroup.get(groupIndex) ?? null;
      const studentId = recognizedStudentId ?? inheritedStudentId;
      const inherited = !recognizedStudentId && Boolean(inheritedStudentId);
      if (inherited) {
        recognition.studentId = { status: "inherited", value: inheritedStudentId, source: "inherited" };
      }
      const studentConf = recognizedStudentId ? 0.9 : inherited ? 0.9 : 0.0;
      const ocrStatus = recognition.status === "ok" ? "done" : recognition.status === "failed" ? "failed" : "review";

      // 诊断检查点：每页识别结果摘要（考号是否读到/识别状态/失败原因），进 main.log 便于实机取证
      const objectiveHits = Array.isArray(recognition.questions) ? recognition.questions.length : -1;
      console.log(`[checkpoint] ocr session=${sessionId} record=${record.id} page=${record.page_num} side=${record.side} studentId=${recognizedStudentId ?? "none"} conf=${studentConf} status=${ocrStatus} objectiveHits=${objectiveHits}${recognition.message ? ` msg=${recognition.message}` : ""}`);

      await updateScanOcrResult(record.id, studentId, studentConf,
        ocrStatus as "done" | "failed" | "review", recognition.message);

      if (card) {
        try {
          const graded = gradeCombinedRecognition(card, record.image_path, recognition);
          await upsertRecognitionResult({
            scanRecordId: record.id,
            objectiveJson: JSON.stringify(recognition.questions),
            subjectiveJson: JSON.stringify(recognition.subjectiveQuestions ?? []),
            totalScore: graded.totalScore,
            maxScore: graded.totalMaxScore,
            gradeStatus: "done"
          });
        } catch (gradeError) {
          console.error(`[Scanner] Grading failed for record ${record.id}:`, gradeError);
          await upsertRecognitionResult({
            scanRecordId: record.id,
            objectiveJson: JSON.stringify(recognition.questions),
            subjectiveJson: JSON.stringify(recognition.subjectiveQuestions ?? []),
            gradeStatus: "pending"
          });
        }
      }

      try {
        await persistAnswerBlockCrops({
          cardId,
          studentNumber: studentId,
          sourceType: "twain_scan_record",
          sourceRecordId: record.id,
          crops: recognition.blockCrops ?? []
        }, getMysqlDb());
      } catch (cropError) {
        console.error(`[Scanner] Block crop persistence failed for record ${record.id}:`, cropError);
      }

      if (recognition.quality?.overallScore !== undefined) {
        await updateScanQuality(record.id, recognition.quality.overallScore as number);
      }

      onProgress({
        sessionId, type: "ocr_page_done",
        recordId: record.id, pageNum: record.page_num, side: record.side,
        studentId, studentConf
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await updateScanOcrResult(record.id, null, null, "failed", msg);

      onProgress({
        sessionId, type: "ocr_page_done",
        pageNum: record.page_num, side: record.side,
        studentId: null, message: msg
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
