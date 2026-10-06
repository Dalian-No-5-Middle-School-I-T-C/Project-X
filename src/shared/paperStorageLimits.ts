/**
 * 原卷上传的容量限制（安全 R10）——**默认值 + 环境变量覆盖 + 安全天花板**三档决定。
 *
 * 之前只有一道「单个文件 50 MiB」的硬编码闸门：单次最多 40 个文件、同一张答题卡可以反复上传、
 * 上传接口也没有累计体积口径。也就是说 40×50 MiB 一次、无限次，就能把数据盘写满——
 * 单文件上限挡不住「累计容量」这一维度的资源耗尽。
 *
 * 因此这里把四道口径分开：
 *  - `maxPaperFileBytes`：单个上传件（沿用历史 50 MiB 口径，改为可配）
 *  - `maxPaperRequestBytes`：单次请求体的累计字节（含 multipart 开销）
 *  - `maxPaperPagesPerCard` / `maxPaperBytesPerCard`：一张答题卡的原卷页数与占盘体积
 *  - `maxPaperBytesTotal`：`data/answer-card/papers` 整个目录的占盘体积上限
 *
 * 与 `scanUploadLimits` 同样的取舍：环境变量只能在默认值与天花板之间调，非法值回落默认、
 * 超天花板夹紧，解析发生在导入期且绝不抛错——一个拼错的数字不能把保护整个关掉。
 */

const MEBIBYTE = 1024 * 1024;

export type PaperStorageLimitKey =
  | "maxPaperFileBytes"
  | "maxPaperRequestBytes"
  | "maxPaperFilesPerRequest"
  | "maxPaperPagesPerCard"
  | "maxPaperBytesPerCard"
  | "maxPaperBytesTotal";

export type PaperStorageLimits = Record<PaperStorageLimitKey, number>;

const LIMIT_DEFS: Array<{
  key: PaperStorageLimitKey;
  env: string;
  unit: "MiB" | "count";
  default: number;
  ceiling: number;
}> = [
  // 单个上传件：沿用历史的 50 MiB 口径，只是不再写死；天花板给整份高清扫描 PDF 留余地。
  { key: "maxPaperFileBytes", env: "PROJECTX_PAPER_MAX_FILE_MIB", unit: "MiB", default: 50, ceiling: 512 },
  // 单次请求：multer 允许一次 40 个文件，40×50 MiB = 2 GiB 全进临时目录，压到 512 MiB。
  { key: "maxPaperRequestBytes", env: "PROJECTX_PAPER_MAX_REQUEST_MIB", unit: "MiB", default: 512, ceiling: 4096 },
  // 单次请求文件数：与历史写死的 40 一致，改成可配；再大属于误用（一页一文件）。
  { key: "maxPaperFilesPerRequest", env: "PROJECTX_PAPER_MAX_FILES_PER_REQUEST", unit: "count", default: 40, ceiling: 200 },
  // 单卡页数：一份原卷几十页已到头，600 页是给「整学期合订卷」留的余量。
  { key: "maxPaperPagesPerCard", env: "PROJECTX_PAPER_MAX_PAGES_PER_CARD", unit: "count", default: 60, ceiling: 600 },
  // 单卡体积：图片页会同时落 jpg 与配对 pdf，按页数上限的若干倍给。
  { key: "maxPaperBytesPerCard", env: "PROJECTX_PAPER_MAX_BYTES_PER_CARD_MIB", unit: "MiB", default: 1024, ceiling: 8192 },
  // 全局体积：这是 R10 的正主——累计容量必须有上限，否则前面三道闸只是摆设。
  { key: "maxPaperBytesTotal", env: "PROJECTX_PAPER_MAX_TOTAL_MIB", unit: "MiB", default: 20480, ceiling: 204800 },
];

export const PAPER_STORAGE_ENV_VARS = LIMIT_DEFS.map((def) => def.env);

function defaultLimits(): PaperStorageLimits {
  const limits = {} as PaperStorageLimits;
  for (const def of LIMIT_DEFS) limits[def.key] = def.unit === "MiB" ? def.default * MEBIBYTE : def.default;
  return limits;
}

/** 未配置时的默认容量口径（文档、界面提示与测试都用它做基准）。 */
export const DEFAULT_PAPER_STORAGE_LIMITS: PaperStorageLimits = defaultLimits();

export interface ResolvedPaperStorageLimits {
  limits: PaperStorageLimits;
  /** 生效的覆盖项与异常值说明，供启动日志使用 */
  notices: string[];
}

/**
 * 纯函数形式的解析器：不读 `process.env`、不打印、不抛错，便于单测与启动自检复用。
 */
export function resolvePaperStorageLimits(env: Record<string, string | undefined> = {}): ResolvedPaperStorageLimits {
  const limits = defaultLimits();
  const notices: string[] = [];
  for (const def of LIMIT_DEFS) {
    const raw = env[def.env];
    if (raw === undefined || String(raw).trim() === "") continue;
    const label = `${def.env}=${def.default}${def.unit === "MiB" ? " MiB" : " 页"}`;
    const parsed = Number(String(raw).trim());
    if (!Number.isFinite(parsed) || parsed < 1) {
      notices.push(`${def.env}="${raw}" 不是 ≥1 的数，按默认值 ${label} 处理`);
      continue;
    }
    const maxAllowed = def.unit === "MiB" ? def.ceiling * MEBIBYTE : def.ceiling;
    const valueInUnit = def.unit === "MiB" ? parsed * MEBIBYTE : parsed;
    if (valueInUnit > maxAllowed) {
      limits[def.key] = maxAllowed;
      const ceilingLabel = def.unit === "MiB" ? `${def.ceiling} MiB` : `${def.ceiling} 页`;
      notices.push(`${def.env}="${raw}" 超过安全天花板 ${ceilingLabel}（${label} 的放宽上界），已按天花板夹紧`);
      continue;
    }
    limits[def.key] = def.unit === "MiB" ? Math.round(valueInUnit) : Math.floor(valueInUnit);
    notices.push(`${def.key} 由 ${def.env} 覆盖为 ${def.unit === "MiB" ? `${parsed} MiB` : `${limits[def.key]} 页`}`);
  }
  return { limits, notices };
}

/**
 * shared 层允许被前端打包，`process` 不一定存在——解析必须对缺失的 `process.env` 免疫，
 * 拿到默认值即可。真正的闸门始终在服务端上传入口，客户端拿到的值只用于提示文案。
 */
function readProcessEnv(): Record<string, string | undefined> {
  return typeof process !== "undefined" && process.env ? process.env : {};
}

const resolved = resolvePaperStorageLimits(readProcessEnv());
if (resolved.notices.length > 0 && typeof process !== "undefined" && process.env) {
  for (const notice of resolved.notices) console.warn(`[paper-limits] ${notice}`);
}

export const MAX_PAPER_FILE_BYTES = resolved.limits.maxPaperFileBytes;
export const MAX_PAPER_REQUEST_BYTES = resolved.limits.maxPaperRequestBytes;
export const MAX_PAPER_FILES_PER_REQUEST = resolved.limits.maxPaperFilesPerRequest;
export const MAX_PAPER_PAGES_PER_CARD = resolved.limits.maxPaperPagesPerCard;
export const MAX_PAPER_BYTES_PER_CARD = resolved.limits.maxPaperBytesPerCard;
export const MAX_PAPER_BYTES_TOTAL = resolved.limits.maxPaperBytesTotal;

/** 给启动日志与健康检查用的一行摘要。 */
export function describePaperStorageLimits(): string {
  const mib = (bytes: number) => `${Math.round(bytes / MEBIBYTE)}MiB`;
  return [
    `单文件 ≤${mib(MAX_PAPER_FILE_BYTES)}`,
    `单请求 ≤${MAX_PAPER_FILES_PER_REQUEST}个/${mib(MAX_PAPER_REQUEST_BYTES)}`,
    `单卡 ≤${MAX_PAPER_PAGES_PER_CARD}页/${mib(MAX_PAPER_BYTES_PER_CARD)}`,
    `原卷目录累计 ≤${mib(MAX_PAPER_BYTES_TOTAL)}`
  ].join(" | ");
}
