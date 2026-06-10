/**
 * 扫描输入模块
 * 功能：
 * 1. 监听用户配置的文件夹，自动发现扫描仪输出的新图片
 * 2. 复制图片到内部存储，生成缩略图
 * 3. 自动匹配答题卡并触发 C++ 识别引擎
 * 4. 预留扫描仪直连接口（ScannerDriver）
 */

import { watch, FSWatcher } from "chokidar";
import path from "node:path";
import { copyFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { unlink } from "node:fs/promises";
import sharp from "sharp";
import {
  generateScanId,
  getConfig,
  insertScan,
  updateScan,
  getScan,
  scansDir,
  thumbnailsDir,
  listCards,
  readLayout,
  layoutPath,
  type ScanRecord
} from "./database";
import { recognizeObjectiveAnswers } from "./recognition";

// ============================================================
// 扫描仪驱动接口（预留扩展）
// ============================================================

export interface ScanOptions {
  /** 扫描 DPI */
  dpi?: number;
  /** 色彩模式 */
  colorMode?: "color" | "grayscale" | "blackwhite";
  /** 纸张大小 */
  paperSize?: "A4" | "A3" | "letter";
  /** 是否双面扫描 */
  duplex?: boolean;
  /** 输出目录（覆盖配置的 input_folder） */
  outputDir?: string;
}

export interface ScannerStatus {
  connected: boolean;
  name: string;
  manufacturer: string;
  scanning: boolean;
}

export interface ScanResult {
  success: boolean;
  files: string[];
  error?: string;
}

/**
 * 扫描仪驱动抽象接口
 * 当前为文件夹模式（方案二），后续可接入 TWAIN/WIA/柯达 SDK（方案一）
 */
export interface ScannerDriver {
  /** 扫描并返回生成的文件路径列表 */
  scan(options: ScanOptions): Promise<ScanResult>;
  /** 获取扫描仪状态 */
  getStatus(): Promise<ScannerStatus>;
  /** 取消当前扫描任务 */
  cancel(): Promise<void>;
}

// ============================================================
// 文件夹监听器
// ============================================================

let watcher: FSWatcher | null = null;
let isProcessing = false;

/** 支持的图片扩展名 */
const IMAGE_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".tiff", ".tif", ".bmp", ".gif", ".webp"
]);

/**
 * 启动文件夹监听
 */
export function startWatching(onNewScan?: (scan: ScanRecord) => void): void {
  const inputFolder = getConfig("input_folder") || path.join(process.cwd(), "input");

  // 确保输入文件夹存在
  mkdirSync(inputFolder, { recursive: true });

  if (watcher) {
    void watcher.close();
  }

  console.log(`[scanner] 开始监听文件夹: ${inputFolder}`);

  watcher = watch(inputFolder, {
    // 只监听文件新增，避免处理已有文件
    ignored: /(^|[\/\\])\../, // 忽略隐藏文件
    persistent: true,
    depth: 0, // 只监听顶层，不递归
    awaitWriteFinish: {
      stabilityThreshold: 2000, // 文件写入完成后等 2 秒再处理
      pollInterval: 500
    }
  });

  watcher.on("add", async (filePath: string) => {
    const ext = path.extname(filePath).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) {
      console.log(`[scanner] 忽略非图片文件: ${filePath}`);
      return;
    }

    console.log(`[scanner] 发现新文件: ${filePath}`);

    try {
      const scan = await processFile(filePath);
      if (scan && onNewScan) {
        onNewScan(scan);
      }
    } catch (err) {
      console.error(`[scanner] 处理文件失败 ${filePath}:`, err);
    }
  });

  watcher.on("error", (error) => {
    console.error("[scanner] 文件夹监听错误:", error);
  });
}

/**
 * 停止文件夹监听
 */
export async function stopWatching(): Promise<void> {
  if (watcher) {
    await watcher.close();
    watcher = null;
    console.log("[scanner] 已停止文件夹监听");
  }
}

/**
 * 获取监听状态
 */
export function getWatcherStatus(): { watching: boolean; folder: string | null } {
  return {
    watching: watcher !== null,
    folder: getConfig("input_folder") || path.join(process.cwd(), "input")
  };
}

// ============================================================
// 文件处理
// ============================================================

/**
 * 处理扫描文件：复制 → 缩略图 → 写入数据库 → 触发识别
 */
export async function processFile(
  filePath: string,
  options?: { cardId?: string; dpi?: number; skipRecognition?: boolean }
): Promise<ScanRecord | null> {
  if (isProcessing) {
    console.log("[scanner] 正在处理其他文件，稍后重试...");
    return null;
  }

  isProcessing = true;
  try {
    // 1. 验证文件
    if (!existsSync(filePath)) {
      console.log(`[scanner] 文件不存在: ${filePath}`);
      return null;
    }

    const stat = statSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const fileName = path.basename(filePath);
    const scanId = generateScanId();

    // 2. 复制到内部存储
    const storedName = `${scanId}${ext}`;
    const storedPath = path.join(scansDir, storedName);
    copyFileSync(filePath, storedPath);

    // 3. 生成缩略图
    let thumbnailPath: string | null = null;
    try {
      const thumbName = `${scanId}_thumb.jpg`;
      thumbnailPath = path.join(thumbnailsDir, thumbName);
      await sharp(filePath)
        .resize(320, 440, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 75 })
        .toFile(thumbnailPath);
    } catch (thumbErr) {
      console.warn(`[scanner] 缩略图生成失败: ${thumbErr}`);
      thumbnailPath = null;
    }

    // 4. 获取图片尺寸
    let width: number | null = null;
    let height: number | null = null;
    try {
      const metadata = await sharp(filePath).metadata();
      width = metadata.width ?? null;
      height = metadata.height ?? null;
    } catch {
      // 尺寸获取失败不影响流程
    }

    // 5. 写入数据库
    const dpi = options?.dpi ?? Number(getConfig("default_dpi") ?? "300");
    const cardId = options?.cardId ?? null;

    const scan = insertScan({
      id: scanId,
      file_name: fileName,
      original_path: filePath,
      stored_path: storedPath,
      thumbnail_path: thumbnailPath,
      file_size: stat.size,
      width,
      height,
      dpi,
      status: "pending",
      card_id: cardId,
      page_number: 1,
      student_id: null,
      student_name: null,
      class_name: null,
      recognition_json: null,
      error_message: null
    });

    // 6. 自动触发识别（如果有 cardId 且未跳过）
    if (cardId && !options?.skipRecognition && getConfig("auto_recognize") !== "false") {
      void runRecognition(scan.id, storedPath, cardId, dpi);
    }

    // 7. 可选：删除原始文件（清理输入文件夹）
    // 当前保留原始文件，如需自动清理可取消注释：
    // try { await unlink(filePath); } catch {}

    return scan;
  } finally {
    isProcessing = false;
  }
}

// ============================================================
// 答题卡识别
// ============================================================

/**
 * 对扫描图片执行客观题识别
 */
export async function runRecognition(
  scanId: string,
  imagePath: string,
  cardId: string,
  dpi: number = 300
): Promise<void> {
  try {
    updateScan(scanId, { status: "processing" });

    // 确保布局文件存在
    const layoutFile = layoutPath(cardId);

    const result = await recognizeObjectiveAnswers({
      imagePath,
      layoutPath: layoutFile,
      pageNumber: 1,
      dpi
    });

    // 提取学号
    let studentId: string | null = null;
    const recognitionData = result as Record<string, unknown>;

    // C++ 识别结果中可能包含 student_id 字段
    if (recognitionData.student_id) {
      studentId = String(recognitionData.student_id);
    }
    // 也可能在 student 对象中
    if (recognitionData.student && typeof recognitionData.student === "object") {
      const student = recognitionData.student as Record<string, unknown>;
      if (student.id) studentId = String(student.id);
    }

    updateScan(scanId, {
      status: "recognized",
      student_id: studentId,
      recognition_json: JSON.stringify(result)
    });

    console.log(`[scanner] 识别完成 scan=${scanId} student=${studentId ?? "未识别"}`);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[scanner] 识别失败 scan=${scanId}:`, errorMsg);
    updateScan(scanId, {
      status: "error",
      error_message: errorMsg
    });
  }
}

/**
 * 手动触发某条扫描记录的识别
 */
export async function triggerRecognition(
  scanId: string,
  cardId: string,
  dpi: number = 300
): Promise<void> {
  const scan = getScan(scanId);
  if (!scan) throw new Error(`扫描记录不存在: ${scanId}`);

  await runRecognition(scanId, scan.stored_path, cardId, dpi);
}

// ============================================================
// 自动匹配答题卡
// ============================================================

/**
 * 尝试自动匹配扫描件到答题卡
 * 当前策略：如果只有一个答题卡，自动关联；否则需要手动指定
 */
export function autoMatchCard(): string | null {
  const cards = listCards();
  if (cards.length === 1) {
    return cards[0].id;
  }
  return null; // 多个答题卡时无法自动判断
}

// ============================================================
// 文件夹扫描仪驱动实现（实现 ScannerDriver 接口）
// ============================================================

export class FolderScannerDriver implements ScannerDriver {
  private scanning = false;

  async scan(options: ScanOptions): Promise<ScanResult> {
    // 文件夹模式下，"扫描"就是等待用户通过扫描仪软件输出文件
    // 此方法作为占位，实际由 chokidar 监听处理
    return {
      success: true,
      files: [],
      error: "文件夹模式：请将扫描仪输出目录设置为本程序的 input_folder，文件将自动导入。"
    };
  }

  async getStatus(): Promise<ScannerStatus> {
    return {
      connected: true,
      name: "文件夹扫描模式",
      manufacturer: "Generic",
      scanning: this.scanning
    };
  }

  async cancel(): Promise<void> {
    this.scanning = false;
  }
}

// ============================================================
// 导出
// ============================================================

export { IMAGE_EXTENSIONS };
