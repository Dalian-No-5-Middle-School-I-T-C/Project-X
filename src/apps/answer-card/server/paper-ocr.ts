import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extractDocxFiles, PaperInputError } from "./paper-docx";
import * as path from "node:path";
import { paperDir } from "./storage";

/**
 * 从 DOCX 提取纯文本
 */
export async function extractDocxText(filePath: string): Promise<string | null> {
  if (!existsSync(filePath)) return null;
  return extractDocxFiles([filePath]);
}

/** Refuse a partial analysis, including when a vision model would skip DOCX. */
export async function getPaperInputKind(cardId: string): Promise<"docx" | "other"> {
  const entries = (await readdir(paperDir(cardId)).catch(() => []))
    .filter(name => /^original(-\d+)?\.[^.]+$/i.test(name));
  const hasDocx = entries.some(name => /\.docx$/i.test(name));
  if (hasDocx && entries.some(name => !/\.docx$/i.test(name))) {
    throw new PaperInputError("MIXED_PAPER_FORMATS", "DOCX 与 PDF/图片混合原卷暂不支持完整分析。请将整份原卷统一为 DOCX，或统一转为 PDF/图片后重新上传。");
  }
  return hasDocx ? "docx" : "other";
}

/**
 * 从 PDF 提取纯文本，检测文字层。
 * 返回 null 表示无文字层或提取失败（触发 OCR 或视觉增强兜底）。
 */
export async function extractPdfText(filePath: string): Promise<string | null> {
  if (!existsSync(filePath)) return null;
  try {
    // pdfjs-dist 为可选依赖，尝试动态加载
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const data = new Uint8Array(await readFile(filePath));
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

/**
 * 从图片文件提取文本（使用 Tesseract.js OCR）
 */
export async function extractImageText(filePath: string): Promise<string | null> {
  if (!existsSync(filePath)) return null;
  try {
    // 动态导入 tesseract.js（大 WASM 文件，按需加载）
    const Tesseract = await import("tesseract.js");
    const result = await Tesseract.recognize(filePath, "chi_sim+eng", {
      // 不使用 worker 缓存，每次新建（避免内存泄漏）
    });
    return result.data.text?.trim() || null;
  } catch {
    return null;
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
 * 2. PDF → pdf-parse（返回 null 则无文字层）
 * 3. 图片 → Tesseract.js OCR
 *
 * 返回 { text, source: "docx"|"pdf"|"ocr"|null }
 */
export async function autoExtractPaperText(
  cardId: string
): Promise<{ text: string | null; source: "docx" | "pdf" | "ocr" | null }> {
  const dir = paperDir(cardId);
  await getPaperInputKind(cardId);

  // Multi-file uploads use original-2.docx, original-3.docx, etc. Read every
  // document in page order; never hand a DOCX ZIP to the image OCR engine.
  const docxFiles = (await readdir(dir).catch(() => []))
    .filter((name) => /^original(-\d+)?\.docx$/i.test(name))
    .sort((a, b) => Number(a.match(/-(\d+)/)?.[1] ?? 1) - Number(b.match(/-(\d+)/)?.[1] ?? 1));
  if (docxFiles.length > 0) {
    const text = await extractDocxFiles(docxFiles.map(name => path.join(dir, name)));
    return { text, source: text ? "docx" : null };
  }

  // 查找原始文件（original.docx/original.pdf/original.jpg 等）
  const extensions = [".pdf", ".jpg", ".jpeg", ".png"];
  for (const ext of extensions) {
    const filePath = path.join(dir, `original${ext}`);
    if (!existsSync(filePath)) continue;

    if (ext === ".pdf") {
      const text = await extractPdfText(filePath);
      if (text) return { text, source: "pdf" };
      // 无文字层 → 需要 OCR（但 Tesseract 不支持直接处理 PDF，Skip）
      return { text: null, source: null };
    }

    // 图片 → Tesseract.js OCR
    const ocrText = await extractImageText(filePath);
    return { text: ocrText, source: ocrText ? "ocr" : null };
  }

  return { text: null, source: null };
}
