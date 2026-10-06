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
import { invalidateScanRecognition } from "../../../../server/services/scannerSubmissions";
import { gradeCombinedRecognition } from "../../../../shared/grading";
import type { CombinedRecognitionResult } from "../../../../shared/types";
import { getMysqlDb } from "../../../../server/db";
import { persistAnswerBlockCrops } from "../../../../server/services/AnswerBlockCropService";
import { prepareCardLayoutById } from "../card-layout";
import { parseRecognitionDpi } from "../helpers";
import { mapScanPageToLayout, applyScanStudentId, assignScanRecordPageNums } from "../../../../shared/scanPages";

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

export { mapScanPageToLayout } from "../../../../shared/scanPages";
export type ScanPageMapping = ReturnType<typeof mapScanPageToLayout>;

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
    paperSize: config.paperSize,
    identityMode: config.identityMode
  });
  return session.id;
}

/**
 * B13 的页号换算见 shared/scanPages.ts:assignScanRecordPageNums（纯函数，便于单测）。
 * 落库页号必须同时满足「跨扫描进程按会话累计」与「正反两面共享纸张号」两条约束，
 * 任一条写反都会分别表现为「100 张塌缩成 1 组」与「双面卷正反面被拆散」。
 */
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
      showUi: config.showUi,
      // 等纸空闲超时：路由层已把它规范化为恒定正数（默认 PAGE_TIMEOUT_DEFAULT_MS=60s），
      // 因此这里总要透传——随包预编译 exe 的内部默认值仍是 15s，不传就等于没改。
      // 厚纸/慢速 ADF 进纸间隔可能超过更短超时，若不透传就会出现「扫了一半提前收尾」。
      pageTimeoutMs: config.pageTimeoutMs
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
    // B13：page_num 必须按「会话内累计**纸张序号**」落库，而不是直接用 native 的 page。
    // native 的 page 是「单次进程内」递增（twain_controller.cpp 里 int pageNum=0 起），
    // 每次重启扫描都是新进程、必然从 1 重来；若原样落库，mapScanPageToLayout 的
    // groupIndex = floor((page_num-1)/sheetsPerStudent) 会把所有页都算成第 0 组，
    // 表现为「扫进 100 张只显示 1 份答题卡」。
    //
    // 但累计的单位是**纸**，不是**张图**：ScanPage.page 是物理纸张号，同一张纸的正反两面
    // 共享同一个 page（twain_controller.cpp:473 与 :513 写的是同一个 pageNum），
    // mapScanPageToLayout 也按「physicalPage + side」还原布局页与正反面
    // （src/shared/scanPages.ts:17 「TWAIN pageNum identifies a physical sheet: its front
    // and back share the number」）。若按图片下标递增，两份双面卷的分组会从 [0,0,1,1]
    // 变成 [0,1,2,3]：正反面被拆到相邻两张「纸」上，首页学号继承与完整性校验随之失效。
    // 故偏移量取「本会话已落库的最大纸张号」，同一批内沿用 native 的 page 不变。
    const existingRecords = await listScanRecords(sessionId);
    const sheetOffset = existingRecords.reduce((max, record) => Math.max(max, Number(record.page_num) || 0), 0);
    const sidesPerSheet = isSingleSided ? 1 : 2;
    const pageNums = assignScanRecordPageNums(filteredPages, { sheetOffset, sidesPerSheet });
    for (const [index, page] of filteredPages.entries()) {
      const cumulativePageNum = pageNums[index];
      const record = await createScanRecord({
        sessionId, cardId: config.cardId,
        imagePath: page.path, pageNum: cumulativePageNum,
        side: page.side as "front" | "back"
      });
      recordIds.push(record.id);
      await incrementPageCount(sessionId);

      onProgress({
        sessionId, type: "page_done",
        recordId: record.id, pageNum: cumulativePageNum, side: page.side,
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
  onProgress: ProgressHandler,
  retry?: { recordIds: Set<string>; studentId?: string },
): Promise<void> {
  const records = (await listScanRecords(sessionId))
    .filter(r => !retry || retry.recordIds.has(r.id))
    .sort((a, b) => a.page_num - b.page_num || (a.side === b.side ? 0 : a.side === "front" ? -1 : 1));
  const prepared = await prepareCardLayoutById(cardId);
  if (!prepared) {
    throw new Error("答题卡不存在，无法识别扫描结果");
  }
  const { card, layout, layoutPath: currentLayoutPath } = prepared;
  const session = await getSession(sessionId);
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
      // Invalidate before retry: a failed new attempt must not expose old grades/crops.
      await invalidateScanRecognition(sessionId, record.id);
      const recognition = (await recognizeAnswerCard({
        identityMode: session?.identity_mode ?? "strict",
        imagePath: record.image_path,
        layoutPath: currentLayoutPath,
        pageNumber: layoutPage,
        // 安全（#24）：会话里可能是修复前落库的超大 DPI，识别前统一夹紧。
        dpi: parseRecognitionDpi(session?.dpi),
        cropsDir: await createRecognitionCropTempDir(cardId, record.id)
      })) as CombinedRecognitionResult;

      await getMysqlDb().run("UPDATE twain_scan_records SET identity_json = ? WHERE id = ?", JSON.stringify(recognition.identity), record.id);
      const recognizedStudentId = retry?.studentId ?? (recognition.studentId?.status === "ok" ? recognition.studentId.value : null);
      if (retry?.studentId) applyScanStudentId(recognition, retry.studentId);
      // 安全 R34：兼容模式（无二维码）没有可校验页序的身份信息，分组完全依赖物理页序，
      // 而学号填涂区只在布局第 1 页生成（layout.ts 只对 page 1 调 layoutStudentArea）。
      // 若允许任意页把学号写进分组表，缺页/乱序/ADF 双进纸造成的错位就会让后一份答卷
      // 静默继承前一名学生的学号。因此兼容模式下只有第 1 页能为本组定学号；
      // 其它页即使读到了学号也只记在自己名下（进而在汇总时暴露为「学号不一致」），
      // 人工订正（retry.studentId）不受此限。
      const legacyIdentity = (session?.identity_mode ?? "strict") === "legacy";
      const maySeedGroupStudentId = !legacyIdentity || layoutPage === 1 || Boolean(retry?.studentId);
      if (recognizedStudentId && maySeedGroupStudentId) {
        studentIdsByGroup.set(groupIndex, recognizedStudentId);
      } else if (recognizedStudentId && legacyIdentity) {
        console.warn(
          `[checkpoint] ocr session=${sessionId} record=${record.id} page=${record.page_num} side=${record.side} ` +
            `第 ${layoutPage} 页读到学号 ${recognizedStudentId}，但兼容模式只认第 1 页的学号，未写入分组（疑似缺页/乱序/双进纸）`,
        );
      }
      const inheritedStudentId = studentIdsByGroup.get(groupIndex) ?? null;
      const studentId = recognizedStudentId ?? inheritedStudentId;
      const inherited = !recognizedStudentId && Boolean(inheritedStudentId);
      if (inherited) {
        applyScanStudentId(recognition, inheritedStudentId!, true);
      }
      const studentConf = recognizedStudentId ? 0.9 : inherited ? 0.9 : 0.0;
      const ocrStatus = recognition.status === "ok" ? "done" : recognition.status === "failed" ? "failed" : "review";

      // 诊断检查点：每页识别结果摘要（考号是否读到/识别状态/失败原因），进 main.log 便于实机取证
      const objectiveHits = Array.isArray(recognition.questions) ? recognition.questions.length : -1;
      console.log(`[checkpoint] ocr session=${sessionId} record=${record.id} page=${record.page_num} side=${record.side} studentId=${recognizedStudentId ?? "none"} conf=${studentConf} status=${ocrStatus} objectiveHits=${objectiveHits}${recognition.message ? ` msg=${recognition.message}` : ""}`);

      await updateScanOcrResult(record.id, studentId, studentConf,
        ocrStatus as "done" | "failed" | "review", recognition.message);

      if (card && recognition.status !== "failed") {
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
          crops: recognition.status === "failed" ? [] : recognition.blockCrops ?? []
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
        studentId, studentConf, ocrStatus, message: recognition.message
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await updateScanOcrResult(record.id, null, null, "failed", msg);

      onProgress({
        sessionId, type: "ocr_page_done",
        recordId: record.id, pageNum: record.page_num, side: record.side,
        studentId: null, ocrStatus: "failed", message: msg
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
