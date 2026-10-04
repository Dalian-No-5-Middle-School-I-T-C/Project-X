/**
 * 扫描/判分上传的限制值（安全 R22/R28）——**默认值 + 环境变量覆盖 + 安全天花板**三档决定。
 *
 * 为什么不能只留硬编码：真实规模差异很大（300dpi 整场联考一次提交、单页原卷体积随扫描仪
 * 设置浮动），把上限写死意味着现场要么上传被拒、要么只能改代码发版。
 * 为什么不能只留环境变量：那等于让一个拼错的数字把保护整个关掉。
 * 因此：`PROJECTX_UPLOAD_*` 可以调，但**只能在默认值与安全天花板之间调**；
 * 非法值（非数字、0、负数、超天花板）一律回落到默认值或被夹紧，并在启动时留一行日志——
 * 解析发生在导入期，任何情况下都不抛错，避免「一个错别字导致服务起不来」。
 *
 * 单位约定：体积类环境变量按 **MiB** 给（`..._MIB`），数量类按个数给；
 * 对外仍以字节/个数导出，调用方不需要再换算。
 */

const MEBIBYTE = 1024 * 1024;

export type ScanUploadLimitKey =
  | "maxScanImageBytes"
  | "maxScanSessionPages"
  | "maxCropsPerRequest"
  | "maxCropImageBytes"
  | "maxCropsTotalBytes"
  | "maxScanPageRequestTotalBytes"
  | "maxGradingBatchFiles"
  | "maxGradingBatchTotalBytes";

export type ScanUploadLimits = Record<ScanUploadLimitKey, number>;

/** 环境变量名与档位、默认值、天花板（单位：MiB 或个数）的对应关系。 */
const LIMIT_DEFS: Array<{
  key: ScanUploadLimitKey;
  env: string;
  unit: "MiB" | "count";
  default: number;
  ceiling: number;
}> = [
  // 单张原卷：默认 50 MiB；天花板 512 MiB 只是给超高分辨率整页留余地，再大属于误配。
  { key: "maxScanImageBytes", env: "PROJECTX_UPLOAD_MAX_SCAN_IMAGE_MIB", unit: "MiB", default: 50, ceiling: 512 },
  // 单个会话页数：pageCount 由扫描端上报，直接决定会话创建时写入的记录与令牌数量（R22）。
  // 200 页 = A4 双面连扫 100 张卡；天花板 2000 页已远超任何单机扫描场景。
  { key: "maxScanSessionPages", env: "PROJECTX_UPLOAD_MAX_SESSION_PAGES", unit: "count", default: 200, ceiling: 2000 },
  // 单次切块数量：扫描端单页题块数远小于 50。
  { key: "maxCropsPerRequest", env: "PROJECTX_UPLOAD_MAX_CROPS_PER_REQUEST", unit: "count", default: 50, ceiling: 500 },
  // 单张切块是题块裁图，12 MiB 足够容纳 300dpi 整栏主观题大块。
  { key: "maxCropImageBytes", env: "PROJECTX_UPLOAD_MAX_CROP_IMAGE_MIB", unit: "MiB", default: 12, ceiling: 128 },
  // 切块请求累计字节：默认值把「50 张 × 50 MiB = 2.5 GiB 全进内存」压到 160 MiB（R28）。
  { key: "maxCropsTotalBytes", env: "PROJECTX_UPLOAD_MAX_CROPS_TOTAL_MIB", unit: "MiB", default: 160, ceiling: 2048 },
  // 单页上传请求只允许一张原卷，累计预算给单张上限留出 multipart 开销余量。
  { key: "maxScanPageRequestTotalBytes", env: "PROJECTX_UPLOAD_MAX_PAGE_REQUEST_TOTAL_MIB", unit: "MiB", default: 64, ceiling: 1024 },
  // 批量判分/识别：落盘而非内存，300 张已覆盖一整场考试。
  { key: "maxGradingBatchFiles", env: "PROJECTX_UPLOAD_MAX_BATCH_FILES", unit: "count", default: 300, ceiling: 5000 },
  // 批量累计 1 GiB：历史验收口径是 24 张 × 3 MiB（72 MiB）必须通过；再大属于磁盘与耗时风险，需分批。
  { key: "maxGradingBatchTotalBytes", env: "PROJECTX_UPLOAD_MAX_BATCH_TOTAL_MIB", unit: "MiB", default: 1024, ceiling: 8192 },
];

export const SCAN_UPLOAD_ENV_VARS = LIMIT_DEFS.map((def) => def.env);

function defaultLimits(): ScanUploadLimits {
  const limits = {} as ScanUploadLimits;
  for (const def of LIMIT_DEFS) limits[def.key] = def.unit === "MiB" ? def.default * MEBIBYTE : def.default;
  return limits;
}

/** 未配置时的默认限制（文档、界面提示与测试都用它做基准）。 */
export const DEFAULT_SCAN_UPLOAD_LIMITS: ScanUploadLimits = defaultLimits();

export interface ResolvedScanUploadLimits {
  limits: ScanUploadLimits;
  /** 生效的覆盖项与异常值说明，供启动日志使用 */
  notices: string[];
}

/**
 * 纯函数形式的解析器：不读 `process.env`、不打印、不抛错，便于单测与启动自检复用。
 */
export function resolveScanUploadLimits(env: Record<string, string | undefined> = {}): ResolvedScanUploadLimits {
  const limits = defaultLimits();
  const notices: string[] = [];
  for (const def of LIMIT_DEFS) {
    const raw = env[def.env];
    if (raw === undefined || String(raw).trim() === "") continue;
    const label = `${def.env}=${def.default}${def.unit === "MiB" ? " MiB" : " 个"}`;
    const parsed = Number(String(raw).trim());
    if (!Number.isFinite(parsed) || parsed < 1) {
      notices.push(`${def.env}="${raw}" 不是 ≥1 的数，按默认值 ${label} 处理`);
      continue;
    }
    const maxAllowed = def.unit === "MiB" ? def.ceiling * MEBIBYTE : def.ceiling;
    const valueInUnit = def.unit === "MiB" ? parsed * MEBIBYTE : parsed;
    if (valueInUnit > maxAllowed) {
      limits[def.key] = maxAllowed;
      const ceilingLabel = def.unit === "MiB" ? `${def.ceiling} MiB` : `${def.ceiling} 个`;
      notices.push(`${def.env}="${raw}" 超过安全天花板 ${ceilingLabel}（${label} 的放宽上界），已按天花板夹紧`);
      continue;
    }
    limits[def.key] = def.unit === "MiB" ? Math.round(valueInUnit) : Math.floor(valueInUnit);
    notices.push(`${def.key} 由 ${def.env} 覆盖为 ${def.unit === "MiB" ? `${parsed} MiB` : `${limits[def.key]} 个`}`);
  }
  return { limits, notices };
}

/**
 * 本文件目前只被服务端（`src/server/routes/scanner-upload.ts`、答题卡服务端）与校验脚本 import，
 * 但 shared 层允许被前端打包，`process` 不一定存在——解析必须对缺失的 `process.env` 免疫，
 * 拿到默认值即可。真正的闸门始终在服务端，客户端拿到的值只用于提示文案。
 */
function readProcessEnv(): Record<string, string | undefined> {
  return typeof process !== "undefined" && process.env ? process.env : {};
}

const resolved = resolveScanUploadLimits(readProcessEnv());
if (resolved.notices.length > 0 && typeof process !== "undefined" && process.env) {
  for (const notice of resolved.notices) console.warn(`[upload-limits] ${notice}`);
}

/**
 * 本地识别与远程页面存储必须接受同一张原卷图，所以两者共用 `maxScanImageBytes`。
 * 它是**单文件**上限，下面的 *TOTAL* 常量约束**整次请求体**（安全 R28），两者必须同时成立。
 */
export const MAX_SCAN_IMAGE_BYTES = resolved.limits.maxScanImageBytes;
export const MAX_SCAN_SESSION_PAGES = resolved.limits.maxScanSessionPages;
export const MAX_CROPS_PER_REQUEST = resolved.limits.maxCropsPerRequest;
export const MAX_CROP_IMAGE_BYTES = resolved.limits.maxCropImageBytes;
export const MAX_CROPS_TOTAL_BYTES = resolved.limits.maxCropsTotalBytes;
export const MAX_SCAN_PAGE_REQUEST_TOTAL_BYTES = resolved.limits.maxScanPageRequestTotalBytes;
export const MAX_GRADING_BATCH_FILES = resolved.limits.maxGradingBatchFiles;
export const MAX_GRADING_BATCH_TOTAL_BYTES = resolved.limits.maxGradingBatchTotalBytes;

/** 给启动日志与健康检查用的一行摘要。 */
export function describeScanUploadLimits(): string {
  return [
    `原卷单张 ${Math.round(MAX_SCAN_IMAGE_BYTES / MEBIBYTE)}MiB`,
    `会话页数 ≤${MAX_SCAN_SESSION_PAGES}`,
    `切块 ≤${MAX_CROPS_PER_REQUEST}张/单张${Math.round(MAX_CROP_IMAGE_BYTES / MEBIBYTE)}MiB/累计${Math.round(MAX_CROPS_TOTAL_BYTES / MEBIBYTE)}MiB`,
    `页请求累计 ${Math.round(MAX_SCAN_PAGE_REQUEST_TOTAL_BYTES / MEBIBYTE)}MiB`,
    `批量 ≤${MAX_GRADING_BATCH_FILES}张/累计${Math.round(MAX_GRADING_BATCH_TOTAL_BYTES / MEBIBYTE)}MiB`
  ].join(" | ");
}
