import { access, mkdtemp, open, readFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { copyOcrModels } from "./ocr-models";
import { DOCX_LIMITS, extractDocxFiles, validateDocxArchives, PaperInputError } from "./paper-docx";
import { MAX_PAPER_FILE_BYTES, MAX_PAPER_FILES_PER_REQUEST, MAX_PAPER_REQUEST_BYTES } from "../../../shared/paperStorageLimits";
import { isImageExtension } from "./validate-upload";
import * as path from "node:path";
import { paperDir } from "./storage";

/**
 * 从 DOCX 提取纯文本
 */
export async function extractDocxText(filePath: string): Promise<string | null> {
  if (!existsSync(filePath)) return null;
  return extractDocxFiles([filePath]);
}

async function originalPaperFiles(cardId: string): Promise<string[]> {
  try {
    return (await readdir(paperDir(cardId))).filter(name => /^original(-\d+)?\.[^.]+$/i.test(name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function paperInputKind(formats: string[]): "docx" | "other" {
  const hasDocx = formats.some(name => /\.docx$/i.test(name));
  if (hasDocx && formats.some(name => !/\.docx$/i.test(name))) {
    throw new PaperInputError("MIXED_PAPER_FORMATS", "同一份原卷不能混用 DOCX 与 PDF/图片。请将整份原卷统一为 DOCX，或统一转为 PDF/图片后重新上传。");
  }
  return hasDocx ? "docx" : "other";
}

/** Refuse a partial analysis, including when a vision model would skip DOCX. */
export async function getPaperInputKind(cardId: string): Promise<"docx" | "other"> {
  return paperInputKind(await originalPaperFiles(cardId));
}

export async function validatePaperUpload(cardId: string, incoming: { originalname: string; file: { path: string } }[]): Promise<void> {
  const stored = await originalPaperFiles(cardId);
  if (paperInputKind([...stored, ...incoming.map(item => item.originalname)]) === "docx") {
    // Validate the complete paper while the card is locked, before storing this batch.
    await validateDocxArchives([
      ...stored.map(name => path.join(paperDir(cardId), name)),
      ...incoming.map(item => item.file.path),
    ]);
  }
}

/**
 * 从 PDF 提取纯文本，检测文字层。
 * 返回 null 表示无文字层或提取失败（触发 OCR 或视觉增强兜底）。
 */
export async function extractPdfText(filePath: string | Buffer): Promise<string | null> {
  if (typeof filePath === "string" && !existsSync(filePath)) return null;
  try {
    // pdfjs-dist 为可选依赖，尝试动态加载
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const data = new Uint8Array(typeof filePath === "string" ? await readFile(filePath) : filePath);
    const doc = await pdfjsLib.getDocument({ data }).promise;

    let fullText = "";
    for (let i = 1; i <= Math.min(doc.numPages, 5); i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      fullText += content.items.map((item: any) => item.str).join(" ");
    }
    doc.destroy();
    fullText = fullText.trim();
    return fullText.length >= 50 ? fullText : null;
  } catch {
    return null; // 提取失败 → 走 OCR 或视觉增强
  }
}

type OcrInput = { extension: string; bytes: Buffer };

export async function readOcrInput(filePath: string, remainingBytes = Infinity): Promise<OcrInput> {
  const extension = path.extname(filePath).toLowerCase();
  const limit = extension === ".docx" ? Math.min(DOCX_LIMITS.compressedBytes, MAX_PAPER_FILE_BYTES) : MAX_PAPER_FILE_BYTES;
  const file = await open(filePath, "r");
  try {
    const size = (await file.stat()).size;
    if (size > limit) {
      throw new PaperInputError("PAPER_TOO_LARGE", "文件超过识别大小限制。", 413);
    }
    if (size > remainingBytes) {
      throw new PaperInputError("PAPER_AI_BUNDLE_TOO_LARGE", "原卷文件累计体积超过分析上限，请拆分后分析。", 413);
    }
    return { extension, bytes: await file.readFile() };
  } finally {
    await file.close();
  }
}

let recognizing = false;

// Admit the job before reading its private copy. Uploads and manual retries share this slot.
async function withOcrCapacity(work: () => Promise<string | null>): Promise<string | null> {
  if (recognizing) throw new PaperInputError("PAPER_OCR_BUSY", "正在识别其他页面，请稍后重新识别。", 429);
  recognizing = true;
  try {
    return await work();
  } finally {
    recognizing = false;
  }
}

export function recognizePaperPage(load: () => Promise<OcrInput>): Promise<string | null> {
  return withOcrCapacity(async () => {
    const { extension, bytes } = await load();
    if (extension === ".docx") return extractDocxFiles([bytes]);
    if (extension === ".pdf") return extractPdfText(bytes);
    return recognizeImage(bytes);
  });
}

export async function extractImageText(filePath: string): Promise<string | null> {
  if (!existsSync(filePath)) return null;
  try {
    return await withOcrCapacity(async () => recognizeImage((await readOcrInput(filePath)).bytes));
  } catch (error) {
    if (error instanceof PaperInputError) throw error;
    return null;
  }
}

async function recognizeImage(bytes: Buffer): Promise<string | null> {
  const bundled = fileURLToPath(new URL("./ocr-models/", import.meta.url));
  let temporary: string | undefined;
  try {
    // Source-based development uses the same pinned models as the production bundle.
    if (!existsSync(bundled)) {
      temporary = await mkdtemp(path.join(tmpdir(), "projectx-paper-ocr-"));
      await copyOcrModels(temporary);
    }
    const langPath = temporary ?? bundled;
    await Promise.all(["chi_sim", "eng"].map(code => access(path.join(langPath, code + ".traineddata.gz"))));
    const { default: tesseract } = await import("tesseract.js");
    const result = await tesseract.recognize(bytes, "chi_sim+eng", {
      langPath,
      cacheMethod: "none",
      errorHandler: (error) => console.warn("[paper-ocr] OCR worker error:", String(error)),
    });
    return result.data.text.trim() || null;
  } catch {
    return null;
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

/**
 * 获取文件 MIME type
 */
export function getFileMime(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const mimeMap: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".bmp": "image/bmp",
    ".tiff": "image/tiff",
    ".tif": "image/tiff",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  };
  return mimeMap[ext] || "application/octet-stream";
}

/**
 * 自动提取试卷文本（根据文件类型选择策略）
 * 1. DOCX → mammoth
 * 2. PDF → PDF.js 文字层
 * 3. 图片 → Tesseract.js OCR
 *
 * 返回 { text, source: "docx"|"pdf"|"ocr"|null }
 */
export async function autoExtractPaperText(
  cardId: string
): Promise<{ text: string | null; source: "docx" | "pdf" | "ocr" | null }> {
  const dir = paperDir(cardId);
  const stored = await originalPaperFiles(cardId);
  const kind = paperInputKind(stored);

  const pageNumber = (name: string) => Number(name.match(/-(\d+)/)?.[1] ?? 1);
  if (kind === "docx") {
    const docxFiles = stored.sort((a, b) => pageNumber(a) - pageNumber(b));
    const text = await extractDocxFiles(docxFiles.map(name => path.join(dir, name)));
    return { text, source: text ? "docx" : null };
  }

  // An image upload has both a JPEG and a PDF containing that same image.
  // Select the image for that page; a standalone PDF uses its text layer.
  const pages = new Map<number, string>();
  for (const name of stored) {
    const index = pageNumber(name);
    const extension = path.extname(name).toLowerCase();
    if (isImageExtension(extension) || (extension === ".pdf" && !pages.has(index))) pages.set(index, name);
  }
  if (pages.size > MAX_PAPER_FILES_PER_REQUEST) {
    throw new PaperInputError("PAPER_AI_BUNDLE_TOO_LARGE", `原卷超过分析上限 ${MAX_PAPER_FILES_PER_REQUEST} 页，请拆分后分析。`, 413);
  }
  const texts: string[] = [];
  let source: "ocr" | "pdf" = "pdf";
  let remainingBytes = MAX_PAPER_REQUEST_BYTES;
  for (const filename of [...pages.values()].sort((a, b) => pageNumber(a) - pageNumber(b))) {
    const text = await recognizePaperPage(async () => {
      const input = await readOcrInput(path.join(dir, filename), remainingBytes);
      remainingBytes -= input.bytes.length;
      return input;
    });
    if (!text) return { text: null, source: null };
    if (isImageExtension(path.extname(filename))) source = "ocr";
    texts.push(text);
  }
  return texts.length ? { text: texts.join("\n\n"), source } : { text: null, source: null };
}
