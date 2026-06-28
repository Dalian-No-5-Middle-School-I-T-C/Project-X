/**
 * Standardised API error codes.
 *
 * Frontend can match on `error.code` instead of scraping free-text messages
 * for localisation and retry logic.
 *
 * Usage:
 *   res.status(409).json({ code: ApiError.HANDLER_DUPLICATE_EXAM, message: "已存在同名考试" });
 *
 * New codes should be added here first so the enum stays the single source of
 * truth for the frontend.
 */
export enum ApiError {
  // ── Auth / permission ─────────────────────────────────────
  /** 未提供认证令牌 */
  UNAUTHORIZED = "UNAUTHORIZED",
  /** 权限不足 */
  FORBIDDEN = "FORBIDDEN",
  /** 令牌已过期或无效 */
  TOKEN_INVALID = "TOKEN_INVALID",

  // ── Resource ──────────────────────────────────────────────
  NOT_FOUND = "NOT_FOUND",

  // ── Validation ────────────────────────────────────────────
  /** 缺少必填字段 */
  MISSING_REQUIRED = "MISSING_REQUIRED",
  /** 字段格式/值无效 */
  INVALID_VALUE = "INVALID_VALUE",
  /** 上传的文件不是受支持的图片格式 */
  INVALID_IMAGE = "INVALID_IMAGE",
  /** 上传文件过大 */
  FILE_TOO_LARGE = "FILE_TOO_LARGE",

  // ── Business logic ────────────────────────────────────────
  /** 资源名/键重复 */
  HANDLER_DUPLICATE = "DUPLICATE",
  /** 考试与被引用的答题卡关联，无法直接删除 */
  HANDLER_CARD_REFERENCED = "CARD_REFERENCED",

  // ── External services ─────────────────────────────────────
  /** AI 服务不可达 */
  AI_SERVICE_UNREACHABLE = "AI_SERVICE_UNREACHABLE",
  /** AI 服务返回错误 */
  AI_SERVICE_ERROR = "AI_SERVICE_ERROR",
  /** AI 请求超时 */
  AI_SERVICE_TIMEOUT = "AI_SERVICE_TIMEOUT",
  /** OCR 识别失败 */
  OCR_FAILED = "OCR_FAILED",

  // ── Scanner (direct TWAIN) ────────────────────────────────
  SCANNER_DISABLED = "SCANNER_DISABLED",
  SCANNER_ERROR = "SCANNER_ERROR",

  // ── Infrastructure ────────────────────────────────────────
  /** 数据库错误 */
  DB_ERROR = "DB_ERROR",
  /** 内部服务器错误（未知） */
  INTERNAL = "INTERNAL",
}

/**
 * Convenience: build a response body with a code.
 * The `message` is still a human-readable zh-CN string (legacy compat).
 */
export function errorBody(code: ApiError, message: string): { code: string; message: string } {
  return { code, message };
}
