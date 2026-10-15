import { imageSize } from "image-size";
import { imageSizeFromFile } from "image-size/fromFile";

const MAX_HEADER_BYTES = 512 * 1024;
const MAX_IMAGE_SIDE = 1_000_000;
const IMAGE_TYPES = new Set(["png", "jpg", "bmp", "tiff", "webp"]);

// Match recognizer_limits.cpp, including the existing operator override.
export function scanImagePixelLimit(raw = process.env.PROJECTX_RECOGNIZER_MAX_IMAGE_PIXELS, arch = process.arch): number {
  const fallback = arch === "ia32" ? 40_000_000 : 100_000_000;
  const ceiling = arch === "ia32" ? 70_000_000 : 400_000_000;
  const value = raw?.trim() ?? "";
  if (!/^\+?\d+$/.test(value)) return fallback;
  const parsed = BigInt(value);
  if (parsed <= 0n || parsed > 9_223_372_036_854_775_807n) return fallback;
  return Number(parsed > BigInt(ceiling) ? ceiling : parsed);
}

export class ScanImageBudgetError extends Error {
  readonly status = 413;
  readonly code = "SCAN_IMAGE_PIXEL_LIMIT";
}

/** Read bounded image headers only; never decode pixels to enforce this limit. */
export async function assertScanImageDimensions(source: string | Buffer): Promise<{ width: number; height: number }> {
  const dimensions = typeof source === "string"
    ? await imageSizeFromFile(source)
    : imageSize(source.subarray(0, MAX_HEADER_BYTES));
  const { width, height } = dimensions;
  if (!IMAGE_TYPES.has(dimensions.type ?? "")) throw new Error("不支持的扫描图片格式");
  const limit = scanImagePixelLimit();
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0
    || width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE || width > Math.floor(limit / height)) {
    throw new ScanImageBudgetError(`扫描图片尺寸 ${width}×${height} 超过安全像素上限 ${limit}，请降低分辨率后重试`);
  }
  return { width, height };
}
