import { access, mkdtemp, open, readFile, readdir, rm, type FileHandle } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { copyOcrModels } from "./ocr-models";
import { DOCX_LIMITS, extractDocxFiles, validateDocxArchives, PaperInputError } from "./paper-docx";
import { MAX_PAPER_FILE_BYTES, MAX_PAPER_FILES_PER_REQUEST, MAX_PAPER_REQUEST_BYTES } from "../../../shared/paperStorageLimits";
import { withAnswerCardDataMutationLock } from "../../../server/lib/answerCardDataLock";
import { isImageExtension } from "./validate-upload";
import { resolveKnowledgePointMode } from "./llm-capabilities";
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

// The model sidecar accepts 40 physical pages and 32,000 characters per analysis.
const MAX_ANALYSIS_PAGES = 40;
const MAX_ANALYSIS_CHARACTERS = 32_000;

class PaperText {
  value = "";
  private pages = 0;
  private characters = 0;

  addPages(count: number): number {
    const firstPage = this.pages + 1;
    this.pages += count;
    if (this.pages > MAX_ANALYSIS_PAGES) {
      throw new PaperInputError("PAPER_TOO_LARGE", `原卷分析最多支持 ${MAX_ANALYSIS_PAGES} 页，请拆分后分析。`, 413);
    }
    return firstPage;
  }

  append(text: string, separator: string): void {
    const prefix = this.value ? separator : "";
    this.characters += prefix.length;
    // Count Unicode code points as the Python sidecar does, including non-BMP math symbols.
    for (const _ of text) {
      if (++this.characters > MAX_ANALYSIS_CHARACTERS) {
        throw new PaperInputError("PAPER_TOO_LARGE", `原卷分析最多支持 ${MAX_ANALYSIS_CHARACTERS} 个字符，请拆分后分析。`, 413);
      }
    }
    this.value += prefix + text;
  }
}

async function appendPdfText(bytes: Buffer, output: PaperText): Promise<boolean> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const root = path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
  const loading = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    cMapUrl: path.join(root, "cmaps") + path.sep,
    cMapPacked: true,
    standardFontDataUrl: path.join(root, "standard_fonts") + path.sep,
  });
  try {
    const doc = await loading.promise;
    const firstPage = output.addPages(doc.numPages);
    const start = output.value.length;
    for (let i = 1; i <= doc.numPages; i++) {
      const beforePage = output.value.length;
      const page = await doc.getPage(i);
      const reader = page.streamTextContent().getReader();
      let separator = "\n\n";
      try {
        for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
          for (const item of chunk.value.items) {
            if (!("str" in item)) continue;
            const text = item.str.trim();
            if (text) {
              output.append(text, separator);
              separator = " ";
            }
            if (item.hasEOL) separator = "\n";
          }
        }
      } finally {
        reader.releaseLock();
        page.cleanup();
      }
      if (output.value.length === beforePage) {
        throw new PaperInputError("PDF_PAGE_NO_TEXT",
          `原卷第 ${firstPage + i - 1} 页（此 PDF 第 ${i} 页）没有可提取的文字。请移除空白页，或用视觉模型分析扫描页和图形页。`, 422);
      }
    }
    return output.value.length > start;
  } catch (error) {
    if (error instanceof PaperInputError) throw error;
    return false;
  } finally {
    await loading.destroy();
  }
}

export async function extractPdfText(filePath: string | Buffer): Promise<string | null> {
  if (typeof filePath === "string" && !existsSync(filePath)) return null;
  const text = new PaperText();
  const bytes = typeof filePath === "string" ? await readFile(filePath) : filePath;
  return await appendPdfText(bytes, text) ? text.value : null;
}

export type OcrInput = { extension: string; bytes: Buffer };

export async function readOcrInput(filePath: string): Promise<OcrInput> {
  const extension = path.extname(filePath).toLowerCase();
  const limit = extension === ".docx" ? Math.min(DOCX_LIMITS.compressedBytes, MAX_PAPER_FILE_BYTES) : MAX_PAPER_FILE_BYTES;
  const file = await open(filePath, "r");
  try {
    const size = (await file.stat()).size;
    if (size > limit) {
      throw new PaperInputError("PAPER_TOO_LARGE", "文件超过识别大小限制。", 413);
    }
    return { extension, bytes: await file.readFile() };
  } finally {
    await file.close();
  }
}

let recognizing = false;

// Admit the job before reading its private copy. Uploads and manual retries share this slot.
export async function withOcrCapacity<T>(work: () => Promise<T>): Promise<T> {
  if (recognizing) throw new PaperInputError("PAPER_OCR_BUSY", "正在识别其他页面，请稍后重新识别。", 429);
  recognizing = true;
  try {
    return await work();
  } finally {
    recognizing = false;
  }
}

export function extractOcrInputText({ extension, bytes }: OcrInput): Promise<string | null> {
  if (extension === ".docx") return extractDocxFiles([bytes]);
  if (extension === ".pdf") return extractPdfText(bytes);
  return recognizeImage(bytes);
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
  } catch (error) {
    console.warn("[paper-ocr] 图片文字识别失败:", error);
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

type PaperPage = { name: string; extension: string; file: FileHandle };
type ExtractedText = { text: string | null; source: "docx" | "pdf" | "ocr" | null };

function selectPaperPages(names: string[]): string[] {
  const kind = paperInputKind(names);
  const pages = new Map<number, string>();
  for (const name of names) {
    const index = Number(name.match(/-(\d+)/)?.[1] ?? 1);
    const ext = path.extname(name).toLowerCase();
    // The paired PDF of an image contains that same image. An independent PDF has its own index.
    if (kind === "docx" || isImageExtension(ext) || (ext === ".pdf" && !pages.has(index))) pages.set(index, name);
  }
  return [...pages.entries()].sort(([a], [b]) => a - b).map(([, name]) => name);
}

async function withPaperSnapshot<T>(cardId: string, use: (pages: PaperPage[]) => Promise<T>): Promise<T> {
  const pages: PaperPage[] = [];
  try {
    // Uploads install new files by rename. Open all current versions under the same
    // write lock, then release it before reading bytes, parsing documents or running OCR.
    await withAnswerCardDataMutationLock(async () => {
      const names = selectPaperPages(await originalPaperFiles(cardId));
      const docx = names.some(name => /\.docx$/i.test(name));
      if (docx && names.length > DOCX_LIMITS.files) {
        throw new PaperInputError("PAPER_TOO_LARGE", `一份原卷最多分析 ${DOCX_LIMITS.files} 个 DOCX 文件。`, 413);
      }
      if (names.length > MAX_PAPER_FILES_PER_REQUEST) {
        throw new PaperInputError("PAPER_AI_BUNDLE_TOO_LARGE", `原卷超过分析上限 ${MAX_PAPER_FILES_PER_REQUEST} 个文件，请拆分后分析。`, 413);
      }
      let totalBytes = 0;
      for (const name of names) {
        const file = await open(path.join(paperDir(cardId), name), "r");
        pages.push({ name, file, extension: path.extname(name).toLowerCase() });
        const { size } = await file.stat();
        totalBytes += size;
        if (size > MAX_PAPER_FILE_BYTES || (docx && totalBytes > DOCX_LIMITS.compressedBytes)) {
          throw new PaperInputError("PAPER_TOO_LARGE", "原卷文件超过识别大小限制，请拆分后分析。", 413);
        }
        if (totalBytes > MAX_PAPER_REQUEST_BYTES) {
          throw new PaperInputError("PAPER_AI_BUNDLE_TOO_LARGE", "原卷累计大小超过分析上限，请拆分后分析。", 413);
        }
      }
    });
    return await use(pages);
  } finally {
    await Promise.all(pages.map(page => page.file.close()));
  }
}

async function extractSnapshotText(pages: PaperPage[]): Promise<ExtractedText> {
  return withOcrCapacity(async () => {
    const output = new PaperText();
    if (pages[0]?.extension === ".docx") {
      const buffers = [];
      for (const page of pages) buffers.push(await page.file.readFile());
      const text = await extractDocxFiles(buffers);
      if (text) output.append(text, "");
      return { text, source: text ? "docx" : null };
    }
    let source: "ocr" | "pdf" = "pdf";
    for (const page of pages) {
      const bytes = await page.file.readFile();
      if (page.extension === ".pdf") {
        if (!await appendPdfText(bytes, output)) return { text: null, source: null };
      } else {
        output.addPages(1);
        const text = await recognizeImage(bytes);
        if (!text) return { text: null, source: null };
        output.append(text, "\n\n");
        source = "ocr";
      }
    }
    return output.value ? { text: output.value, source } : { text: null, source: null };
  });
}

export function autoExtractPaperText(cardId: string): Promise<ExtractedText> {
  return withPaperSnapshot(cardId, extractSnapshotText);
}

type AnalysisInput = { mode: "text"; paperText: string | null } | { mode: "direct"; files: { mimeType: string; base64: string }[] };

export function readPaperForAnalysis(cardId: string, useVision: boolean): Promise<AnalysisInput> {
  return withPaperSnapshot(cardId, async (pages): Promise<AnalysisInput> => {
    const mode = resolveKnowledgePointMode(useVision && pages[0]?.extension !== ".docx");
    if (mode === "text") {
      return { mode, paperText: (await extractSnapshotText(pages)).text };
    }
    const files = [];
    for (const page of pages) {
      files.push({ mimeType: getFileMime(page.name), base64: await page.file.readFile("base64") });
    }
    return { mode, files };
  });
}
