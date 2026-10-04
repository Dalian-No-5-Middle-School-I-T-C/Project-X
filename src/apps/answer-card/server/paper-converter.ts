import { copyFile, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import PDFDocument from "pdfkit";
import type { ReadStream } from "node:fs";
import { createWriteStream } from "node:fs";
import { dataDir } from "./storage";
import { MAX_PAPER_FILE_BYTES } from "../../../shared/paperStorageLimits";

export const ALLOWED_EXTENSIONS = new Set([
  ".docx", ".pdf", ".jpg", ".jpeg", ".png", ".bmp", ".tiff", ".tif", ".webp"
]);

export const ALLOWED_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/bmp",
  "image/tiff",
  "image/webp"
]);

/**
 * 单个上传件的体积上限（安全 R10）：不再是硬编码 50 MB，
 * 而是「默认 50 MiB + `PROJECTX_PAPER_MAX_FILE_MIB` 覆盖 + 512 MiB 天花板」。
 */
export const MAX_FILE_SIZE = MAX_PAPER_FILE_BYTES;

export function validatePaperFile(filename: string, size: number): string | null {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".doc") return "不支持 .doc 格式，请转为 .docx 后上传";
  if (!ALLOWED_EXTENSIONS.has(ext)) return `不支持 ${ext} 格式，请上传 DOCX/PDF/图片文件`;
  if (size > MAX_FILE_SIZE) {
    return `文件过大（${(size / 1024 / 1024).toFixed(1)}MB），最大 ${(MAX_FILE_SIZE / 1024 / 1024).toFixed(0)}MB`;
  }
  return null;
}

export function isImageFormat(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return [".jpg", ".jpeg", ".png", ".bmp", ".tiff", ".tif", ".webp"].includes(ext);
}

export function isPdf(filename: string): boolean {
  return path.extname(filename).toLowerCase() === ".pdf";
}

export function isDocx(filename: string): boolean {
  return path.extname(filename).toLowerCase() === ".docx";
}

/**
 * 图片压缩：限制长边 2048px，JPEG 80% 质量
 * 返回压缩后的 Buffer，控制在 ~500KB-1MB
 */
export async function compressImage(inputPath: string): Promise<Buffer> {
  let image = sharp(inputPath);
  const metadata = await image.metadata();

  if (metadata.width && metadata.width > 2048) {
    image = image.resize(2048, 2048, { fit: "inside", withoutEnlargement: true });
  }

  const buf = await image.jpeg({ quality: 80 }).toBuffer();

  // 如果压缩后仍然 > 10MB（极罕见），再压到 1600px
  if (buf.length > 10 * 1024 * 1024) {
    const img2 = sharp(inputPath).resize(1600, 1600, { fit: "inside", withoutEnlargement: true });
    return img2.jpeg({ quality: 70 }).toBuffer();
  }

  return buf;
}

/**
 * 图片 → 单页 PDF
 */
export async function imageToPdf(inputPath: string, outputPath: string): Promise<void> {
  const metadata = await sharp(inputPath).metadata();
  const width = metadata.width || 2480;
  const height = metadata.height || 3508;

  // pdfkit 使用 pt (1/72 inch)，假设 72 DPI
  const pageWidth = (width / 72) * 72; // scaled to fit
  const pageHeight = (height / 72) * 72;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: [pageWidth, pageHeight], margin: 0 });
    const stream = createWriteStream(outputPath);
    // 安全 R14：转换中途失败时，半截 PDF 会永久留在原卷目录里（既占盘又可能被当成有效页读到）。
    // 统一在失败路径上销毁流并删除产物后再抛出，让调用方看到「干净的失败」。
    let settled = false;
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      stream.destroy();
      void unlink(outputPath).catch(() => {});
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    doc.on("error", fail);
    stream.on("error", fail);
    try {
      doc.pipe(stream);
      doc.image(inputPath, 0, 0, { width: pageWidth, height: pageHeight });
      doc.end();
    } catch (err) {
      fail(err);
      return;
    }
    stream.on("finish", () => {
      if (settled) return;
      settled = true;
      resolve();
    });
  });
}

/**
 * 文件存储到 papers 目录
 * - PDF/DOCX：直接复制原文件
 * - 图片：压缩后存为 JPEG，同时生成 PDF
 */
export async function storePaperFile(
  sourcePath: string,
  filename: string,
  paperDirPath: string
): Promise<{ originalPath: string; pdfPath: string | null }> {
  const ext = path.extname(filename).toLowerCase();
  const originalPath = path.join(paperDirPath, `original${ext}`);

  if (isDocx(filename)) {
    await copyFile(sourcePath, originalPath);
    return { originalPath, pdfPath: null };
  }

  if (isPdf(filename)) {
    await copyFile(sourcePath, originalPath);
    return { originalPath, pdfPath: originalPath };
  }

  // 图片：压缩 JPEG + 生成 PDF
  const compressed = await compressImage(sourcePath);
  const jpgPath = path.join(paperDirPath, "original.jpg");
  await writeFile(jpgPath, compressed);

  const pdfPath = path.join(paperDirPath, "original.pdf");
  try {
    await imageToPdf(sourcePath, pdfPath);
  } catch (err) {
    await discardStoredPaths([jpgPath, pdfPath]); // 安全 R14：不留孤儿产物
    throw err;
  }

  return { originalPath: jpgPath, pdfPath };
}

/**
 * 按页码存储原卷文件（多页支持）
 * - pageIndex === 1 沿用 legacy 文件名 original.<ext>（向后兼容预览/导出/AI 读取）
 * - pageIndex > 1 使用 original-<N>.<ext>，避免覆盖首页
 * 返回磁盘文件名、相对路径（papers/<cardId>/...）、是否生成了 PDF，以及：
 *  - `writtenPaths`：本次真正落盘的全部文件（含配对 PDF），供调用方在事务失败时逐个回滚（安全 R14）
 *  - `bytes`：本次实际占盘字节数，供累计容量核算（安全 R10）
 */
export interface StoredPaperPage {
  diskFilename: string;
  relPath: string;
  pdfAvailable: boolean;
  writtenPaths: string[];
  bytes: number;
}

async function sizeOf(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size;
  } catch {
    return 0;
  }
}

/** 删除本次写入的文件（忽略不存在/无权删除的项）；用于失败回滚（安全 R14）。 */
export async function discardStoredPaths(paths: readonly string[]): Promise<void> {
  for (const filePath of paths) {
    try {
      await unlink(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        console.warn(`[paper] 回滚删除失败 (${path.basename(filePath)}):`, (err as Error)?.message);
      }
    }
  }
}

export async function storePaperPageFile(
  sourcePath: string,
  filename: string,
  paperDirPath: string,
  pageIndex: number
): Promise<StoredPaperPage> {
  const ext = path.extname(filename).toLowerCase();
  const baseName = pageIndex === 1 ? "original" : `original-${pageIndex}`;
  const originalPath = path.join(paperDirPath, `${baseName}${ext}`);
  const relRoot = dataDir;

  if (isDocx(filename)) {
    await copyFile(sourcePath, originalPath);
    return {
      diskFilename: `${baseName}${ext}`,
      relPath: path.relative(relRoot, originalPath),
      pdfAvailable: false,
      writtenPaths: [originalPath],
      bytes: await sizeOf(originalPath),
    };
  }

  if (isPdf(filename)) {
    await copyFile(sourcePath, originalPath);
    return {
      diskFilename: `${baseName}${ext}`,
      relPath: path.relative(relRoot, originalPath),
      pdfAvailable: true,
      writtenPaths: [originalPath],
      bytes: await sizeOf(originalPath),
    };
  }

  // 图片：压缩 JPEG + 生成 PDF
  const compressed = await compressImage(sourcePath);
  const jpgName = `${baseName}.jpg`;
  const jpgPath = path.join(paperDirPath, jpgName);
  await writeFile(jpgPath, compressed);

  const pdfName = `${baseName}.pdf`;
  const pdfPath = path.join(paperDirPath, pdfName);
  try {
    await imageToPdf(sourcePath, pdfPath);
  } catch (err) {
    // 安全 R14：配对 PDF 转换失败时，这一页的 jpg 与半截 pdf 都会变成没人记账的孤儿
    // （DB 里不会有这一行，预览与删除接口都找不到它们），必须在抛出前清掉。
    await discardStoredPaths([jpgPath, pdfPath]);
    throw err;
  }

  return {
    diskFilename: jpgName,
    relPath: path.relative(relRoot, jpgPath),
    pdfAvailable: true,
    writtenPaths: [jpgPath, pdfPath],
    bytes: (await sizeOf(jpgPath)) + (await sizeOf(pdfPath)),
  };
}

export type AnswerKeyPageKind = "image" | "pdf" | "docx";

/**
 * v54: 按页码存储考试级「本次正确答案」上传件。
 * 与 storePaperPageFile 的区别：答案页只用于教师核对与 OCR，学生端只展示文字答案，
 * 因此图片不生成配对 PDF，也使用独立文件名前缀避免与原卷混淆。
 */
export async function storeAnswerKeyPageFile(
  sourcePath: string,
  filename: string,
  targetDir: string,
  pageIndex: number
): Promise<{ diskFilename: string; relPath: string; kind: AnswerKeyPageKind }> {
  const ext = path.extname(filename).toLowerCase();
  const baseName = pageIndex === 1 ? "answerkey" : `answerkey-${pageIndex}`;
  const targetPath = path.join(targetDir, `${baseName}${ext}`);

  if (isDocx(filename)) {
    await copyFile(sourcePath, targetPath);
    return { diskFilename: `${baseName}${ext}`, relPath: path.relative(dataDir, targetPath), kind: "docx" };
  }
  if (isPdf(filename)) {
    await copyFile(sourcePath, targetPath);
    return { diskFilename: `${baseName}${ext}`, relPath: path.relative(dataDir, targetPath), kind: "pdf" };
  }
  if (!isImageFormat(filename)) throw new Error(`不支持 ${ext} 格式的答案文件`);

  const diskFilename = `${baseName}.jpg`;
  await writeFile(path.join(targetDir, diskFilename), await compressImage(sourcePath));
  return {
    diskFilename,
    relPath: path.relative(dataDir, path.join(targetDir, diskFilename)),
    kind: "image",
  };
}
