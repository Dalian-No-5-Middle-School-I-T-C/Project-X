/**
 * Upload file validation helpers.
 *
 * Multer's `fileFilter` callback runs *before* the file is written to disk,
 * so it can only inspect MIME headers — which are trivially forgeable.
 *
 * This module provides post-write validation via magic bytes (file header
 * signatures) so that an attacker cannot bypass the image filter by sending
 * a crafted `Content-Type` header.
 *
 * Supported image types: PNG, JPEG, BMP, TIFF, WebP.
 */
import { open, rm } from "node:fs/promises";
import path from "node:path";

const MAGIC_BYTES: Array<{ signature: Buffer; label: string }> = [
  { signature: Buffer.from([0x89, 0x50, 0x4e, 0x47]), label: "PNG" },
  { signature: Buffer.from([0xff, 0xd8, 0xff]), label: "JPEG" },
  { signature: Buffer.from([0x42, 0x4d]), label: "BMP" },
  { signature: Buffer.from([0x49, 0x49, 0x2a, 0x00]), label: "TIFF (LE)" },
  { signature: Buffer.from([0x4d, 0x4d, 0x00, 0x2a]), label: "TIFF (BE)" },
  { signature: Buffer.from([0x52, 0x49, 0x46, 0x46]), label: "RIFF (WebP)" },
];

const MAX_HEADER_BYTES = 12;

/** 允许落盘并对外提供的图片扩展名（预览按扩展名推导 Content-Type）。 */
export const IMAGE_EXTENSIONS: readonly string[] = [".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff", ".webp"];

/**
 * 白名单化上传扩展名：非图片扩展名一律回落为 .png。
 * 防止上传 payload.html 后由同源预览端点按 text/html 提供（存储型 XSS）。
 */
export function safeImageExtension(originalName: string): string {
  const ext = path.extname(originalName || "").toLowerCase();
  return IMAGE_EXTENSIONS.includes(ext) ? ext : ".png";
}

/** 判断扩展名是否允许由图片端点提供。 */
export function isImageExtension(ext: string): boolean {
  return IMAGE_EXTENSIONS.includes(ext.toLowerCase());
}

/** Reads the first N bytes of a file and checks magic signatures. */
export async function isValidImageFile(filePath: string): Promise<boolean> {
  let fd;
  try {
    fd = await open(filePath, "r");
    const buf = Buffer.alloc(MAX_HEADER_BYTES);
    const { bytesRead } = await fd.read(buf, 0, MAX_HEADER_BYTES, 0);
    if (bytesRead < 4) return false;
    const header = buf.subarray(0, bytesRead);
    return MAGIC_BYTES.some(({ signature }) =>
      header.subarray(0, signature.length).equals(signature)
    );
  } catch {
    return false;
  } finally {
    if (fd) await fd.close();
  }
}

/** 内存态文件（multer memoryStorage）的魔数校验，供扫描上传等场景复用。 */
export function isValidImageBuffer(buffer: Buffer): boolean {
  if (!buffer || buffer.length < 4) return false;
  if (buffer.subarray(0, 4).equals(Buffer.from([0x52, 0x49, 0x46, 0x46]))) {
    // RIFF 容器还须校验 WEBP 四字符标识，避免 WAV/AVI 等 RIFF 文件混入
    return buffer.length >= 12 && buffer.subarray(8, 12).toString("ascii") === "WEBP";
  }
  return MAGIC_BYTES.some(({ signature }) =>
    buffer.subarray(0, signature.length).equals(signature)
  );
}

/**
 * Validates uploaded image files (multer single or array).
 * On invalid image, removes the file from disk and sends 400.
 *
 * Usage (inside route handler, right after multer):
 *   if (!await assertImageFile(req.file?.path)) return; // res already sent
 */
export async function assertImageFile(
  filePath: string | undefined,
  res: { status: (c: number) => { json: (b: unknown) => void } }
): Promise<boolean> {
  if (!filePath) {
    res.status(400).json({ message: "没有收到图片文件" });
    return false;
  }
  if (await isValidImageFile(filePath)) return true;
  // Not a real image — delete the file and reject
  try { await rm(filePath); } catch { /* best-effort cleanup */ }
  res.status(400).json({ message: "上传的文件不是受支持的图片格式" });
  return false;
}
