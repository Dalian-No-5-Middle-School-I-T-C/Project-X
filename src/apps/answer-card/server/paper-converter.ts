import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import PDFDocument from "pdfkit";
import type { ReadStream } from "node:fs";
import { createWriteStream } from "node:fs";

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

export const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

export function validatePaperFile(filename: string, size: number): string | null {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".doc") return "不支持 .doc 格式，请转为 .docx 后上传";
  if (!ALLOWED_EXTENSIONS.has(ext)) return `不支持 ${ext} 格式，请上传 DOCX/PDF/图片文件`;
  if (size > MAX_FILE_SIZE) return `文件过大（${(size / 1024 / 1024).toFixed(1)}MB），最大 50MB`;
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
    doc.pipe(stream);
    doc.image(inputPath, 0, 0, { width: pageWidth, height: pageHeight });
    doc.end();
    stream.on("finish", resolve);
    stream.on("error", reject);
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
  await imageToPdf(sourcePath, pdfPath);

  return { originalPath: jpgPath, pdfPath };
}

/**
 * 按页码存储原卷文件（多页支持）
 * - pageIndex === 1 沿用 legacy 文件名 original.<ext>（向后兼容预览/导出/AI 读取）
 * - pageIndex > 1 使用 original-<N>.<ext>，避免覆盖首页
 * 返回磁盘文件名、相对路径（papers/<cardId>/...）与是否生成了 PDF
 */
export async function storePaperPageFile(
  sourcePath: string,
  filename: string,
  paperDirPath: string,
  pageIndex: number
): Promise<{ diskFilename: string; relPath: string; pdfAvailable: boolean }> {
  const ext = path.extname(filename).toLowerCase();
  const baseName = pageIndex === 1 ? "original" : `original-${pageIndex}`;
  const originalPath = path.join(paperDirPath, `${baseName}${ext}`);
  const relRoot = path.resolve(process.cwd(), "data", "answer-card");

  if (isDocx(filename)) {
    await copyFile(sourcePath, originalPath);
    return { diskFilename: `${baseName}${ext}`, relPath: path.relative(relRoot, originalPath), pdfAvailable: false };
  }

  if (isPdf(filename)) {
    await copyFile(sourcePath, originalPath);
    return { diskFilename: `${baseName}${ext}`, relPath: path.relative(relRoot, originalPath), pdfAvailable: true };
  }

  // 图片：压缩 JPEG + 生成 PDF
  const compressed = await compressImage(sourcePath);
  const jpgName = `${baseName}.jpg`;
  await writeFile(path.join(paperDirPath, jpgName), compressed);

  const pdfName = `${baseName}.pdf`;
  await imageToPdf(sourcePath, path.join(paperDirPath, pdfName));

  return { diskFilename: jpgName, relPath: path.relative(relRoot, path.join(paperDirPath, jpgName)), pdfAvailable: true };
}
