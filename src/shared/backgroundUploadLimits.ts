/**
 * 个人背景图上传体积（issue #335）——**默认值 + 环境变量覆盖 + 安全天花板**三档决定。
 *
 * `POST /api/users/me/background` 原先把 multer `fileSize` 写成 `5 * 1024 * 1024`。
 * 5 MiB 够手机照片，老师从扫描件裁出的整页图会顶到 413，而现场只能改代码发版。
 * 环境变量可以放宽，但不能让一个非数字或超大值把闸门关掉，所以非法值回落默认、
 * 超过天花板则夹紧，只在启动时留一行 notice，解析本身不抛错。
 *
 * 单位：`PROJECTX_BACKGROUND_UPLOAD_MIB` 按 MiB 给；对外仍以字节导出。
 */

const MEBIBYTE = 1024 * 1024;

const ENV_NAME = "PROJECTX_BACKGROUND_UPLOAD_MIB";
const DEFAULT_MIB = 5;
const CEILING_MIB = 32;

export const BACKGROUND_UPLOAD_ENV_VARS = [ENV_NAME] as const;

export const DEFAULT_BACKGROUND_UPLOAD_BYTES = DEFAULT_MIB * MEBIBYTE;

export interface ResolvedBackgroundUploadLimit {
  limits: { maxUploadBytes: number };
  /** 生效的覆盖项与异常值说明，供启动日志使用 */
  notices: string[];
}

/**
 * 纯函数形式的解析器：不读 `process.env`、不打印、不抛错，便于单测与启动自检复用。
 */
export function resolveBackgroundUploadLimit(
  env: Record<string, string | undefined> = {}
): ResolvedBackgroundUploadLimit {
  const notices: string[] = [];
  const raw = env[ENV_NAME];
  if (raw === undefined || String(raw).trim() === "") {
    return { limits: { maxUploadBytes: DEFAULT_BACKGROUND_UPLOAD_BYTES }, notices };
  }
  const parsed = Number(String(raw).trim());
  if (!Number.isFinite(parsed) || parsed < 1) {
    notices.push(`${ENV_NAME}="${raw}" 不是 ≥1 的数，按默认值 ${DEFAULT_MIB} MiB 处理`);
    return { limits: { maxUploadBytes: DEFAULT_BACKGROUND_UPLOAD_BYTES }, notices };
  }
  const ceilingBytes = CEILING_MIB * MEBIBYTE;
  const requested = Math.round(parsed * MEBIBYTE);
  if (requested > ceilingBytes) {
    notices.push(
      `${ENV_NAME}="${raw}" 超过安全天花板 ${CEILING_MIB} MiB（默认 ${DEFAULT_MIB} MiB 的放宽上界），已按天花板夹紧`
    );
    return { limits: { maxUploadBytes: ceilingBytes }, notices };
  }
  notices.push(`maxUploadBytes 由 ${ENV_NAME} 覆盖为 ${formatBackgroundUploadMib(requested)}`);
  return { limits: { maxUploadBytes: requested }, notices };
}

/** 把字节数格式化成「5 MiB」或「1.5 MiB」，供 413 文案与设置接口使用。 */
export function formatBackgroundUploadMib(bytes: number): string {
  const rounded = Math.round((bytes / MEBIBYTE) * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${text} MiB`;
}

export function backgroundUploadTooLargeMessage(bytes: number): string {
  return `上传文件超过大小限制（≤${formatBackgroundUploadMib(bytes)}）`;
}

function readProcessEnv(): Record<string, string | undefined> {
  return typeof process !== "undefined" && process.env ? process.env : {};
}

const resolved = resolveBackgroundUploadLimit(readProcessEnv());
if (resolved.notices.length > 0 && typeof process !== "undefined" && process.env) {
  for (const notice of resolved.notices) console.warn(`[background-upload-limits] ${notice}`);
}

export const MAX_BACKGROUND_UPLOAD_BYTES = resolved.limits.maxUploadBytes;

/** 给启动日志用的一行摘要。 */
export function describeBackgroundUploadLimit(): string {
  return `上传 ≤${formatBackgroundUploadMib(MAX_BACKGROUND_UPLOAD_BYTES)}（天花板 ${CEILING_MIB} MiB）`;
}
