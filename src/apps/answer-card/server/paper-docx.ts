import { createReadStream } from "node:fs";
import type { Readable } from "node:stream";
import mammoth from "mammoth";
import { fromBuffer, type ZipFile, type Entry } from "yauzl";

export class PaperInputError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
  }
}

// Per paper, not per file. Keep both the ZIP validation and Mammoth parsing serial.
export const DOCX_LIMITS = {
  files: 40, entries: 4096, compressedBytes: 20 * 1024 * 1024,
  expandedBytes: 32 * 1024 * 1024, textCharacters: 512 * 1024,
} as const;
function overBudget(): never {
  throw new PaperInputError("PAPER_TOO_LARGE", "原卷超过分析限制：DOCX 合计压缩大小 20 MiB、解压大小 32 MiB、提取文字 524288 字符。请拆分或精简后重试。", 413);
}
type Budget = { compressed: number; expanded: number; entries: number; text: number };
let extracting = false;

async function readBounded(filePath: string, budget: Budget): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of createReadStream(filePath)) {
    budget.compressed += chunk.length;
    if (budget.compressed > DOCX_LIMITS.compressedBytes) overBudget();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function validateArchive(buffer: Buffer, budget: Budget): Promise<void> {
  let activeStream: Readable | undefined;
  const zip = await new Promise<ZipFile>((resolve, reject) => {
    fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (error, value) => error ? reject(error) : resolve(value!));
  });
  try {
    if (budget.entries + zip.entryCount > DOCX_LIMITS.entries) overBudget();
    await new Promise<void>((resolve, reject) => {
      const names = new Set<string>();
      zip.on("error", reject);
      zip.on("end", resolve);
      zip.on("entry", (entry: Entry) => {
        void (async () => {
          if (++budget.entries > DOCX_LIMITS.entries ||
              budget.expanded + entry.uncompressedSize > DOCX_LIMITS.expandedBytes) overBudget();
          if (names.has(entry.fileName) || entry.isEncrypted()) throw new Error("Unsupported DOCX archive");
          names.add(entry.fileName);
          const stream = await new Promise<Readable>((res, rej) => {
            zip.openReadStream(entry, (error, value) => error ? rej(error) : res(value!));
          });
          activeStream = stream;
          // Validate actual output too: forged ZIP sizes must not bypass the cap.
          // Discard chunks immediately; Mammoth only receives this same validated buffer.
          for await (const chunk of stream) {
            budget.expanded += chunk.length;
            if (budget.expanded > DOCX_LIMITS.expandedBytes) overBudget();
          }
          zip.readEntry();
        })().catch(reject);
      });
      zip.readEntry();
    });
  } finally {
    activeStream?.destroy();
    zip.close();
  }
}

export async function extractDocxFiles(filePaths: string[]): Promise<string | null> {
  // Bound aggregate memory across simultaneous requests, without an unbounded queue.
  if (extracting) throw new PaperInputError("PAPER_ANALYSIS_BUSY", "正在提取其他原卷，请稍后重试。", 429);
  extracting = true;
  const budget: Budget = { compressed: 0, expanded: 0, entries: 0, text: 0 };
  try {
    if (filePaths.length > DOCX_LIMITS.files) overBudget();
    const texts: string[] = [];
    for (const filePath of filePaths) {
      const buffer = await readBounded(filePath, budget);
      await validateArchive(buffer, budget);
      const result = await mammoth.extractRawText({ buffer });
      const text = result.value?.trim();
      if (!text) return null;
      budget.text += text.length + (texts.length ? 2 : 0);
      if (budget.text > DOCX_LIMITS.textCharacters) overBudget();
      texts.push(text);
    }
    return texts.join("\n\n") || null;
  } catch (error) {
    if (error instanceof PaperInputError) throw error;
    throw new PaperInputError("INVALID_DOCX", "原卷 DOCX 损坏、已加密或格式不受支持，请重新导出后上传。", 422);
  } finally {
    extracting = false;
  }
}
