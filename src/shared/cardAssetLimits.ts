/**
 * 答题卡插图资源（导入与上传）的容量预算（安全 R05）——**默认值 + 环境变量覆盖 + 安全天花板**三档决定。
 *
 * 为什么单独一档：`scanUploadLimits`/`paperStorageLimits` 管的是扫描上传与试卷原卷，它们都有
 * multer 的 `limits` 兜底；答题卡**导入**走的是 JSON body（`.projectx-card.json` 把插图按 base64
 * 内联），完全不经过 multer——导入端点原先只校验文件名字符集，既不看类型也不看体积，
 * 于是「一份导出文件」可以塞进任意多、任意大的资源。
 *
 * 为什么不能只留硬编码：一张真实试卷的插图数量随学科浮动（历史/地理卷可能十几张地图），
 * 写死意味着现场只能改代码发版。
 * 为什么不能只留环境变量：那等于让一个拼错的数字把保护整个关掉。
 * 所以 `PROJECTX_CARD_ASSET_*` 只能在默认值与安全天花板之间调；非法值（非数字、0、负数、
 * 超天花板）回落默认值或被夹紧，只在启动时留一行日志——解析发生在导入期，任何情况下都不抛错。
 *
 * 单位约定：体积类环境变量按 **MiB** 给（`..._MIB`），数量类按个数给；对外仍以字节/个数导出。
 *
 * 与请求体上限的关系（必须说清，否则现场会以为放宽这里就能导更大的包）：
 * 导入端点仍受全局 `express.json({ limit: "8mb" })` 约束，base64 又比原图大约 4/3，
 * 所以「导入侧」真正的天花板是请求体；本模块的默认值刻意不越过它，只做**纵深防御**
 * （条数、累计体积、伪装类型）。要导入更大的图集，需要的是放宽该路由的请求体上限，
 * 而不是把这里的数字调大——放宽它会带来整包进内存的代价，属于产品决策。
 */

const MEBIBYTE = 1024 * 1024;

export type CardAssetLimitKey =
  | "maxAssetBytes"
  | "maxAssetsPerImport"
  | "maxAssetsTotalBytes"
  | "maxAssetUploadBytes";

export type CardAssetLimits = Record<CardAssetLimitKey, number>;

const LIMIT_DEFS: Array<{
  key: CardAssetLimitKey;
  env: string;
  unit: "MiB" | "count";
  default: number;
  ceiling: number;
}> = [
  // 单张插图解压后体积：真实试卷插图（扫描件、地图、几何图）在 300dpi 下可到 2~4 MiB，
  // 默认 6 MiB 与导入端点的全局 `express.json({limit:"8mb"})` 对齐——base64 膨胀约 4/3，
  // 6 MiB 解码字节正好压在请求体上限上，所以这一档不会拒掉任何今天能导入的图。
  { key: "maxAssetBytes", env: "PROJECTX_CARD_ASSET_MAX_MIB", unit: "MiB", default: 6, ceiling: 512 },
  // 单次导入的资源条数：一张卡的插图正常在个位数，200 已覆盖「整套联考多卷打包」。
  { key: "maxAssetsPerImport", env: "PROJECTX_CARD_ASSET_MAX_COUNT", unit: "count", default: 200, ceiling: 2000 },
  // 单次导入的资源累计体积：与请求体上限同级；条数多而单个不超限时由这一档兜底。
  { key: "maxAssetsTotalBytes", env: "PROJECTX_CARD_ASSET_TOTAL_MIB", unit: "MiB", default: 8, ceiling: 4096 },
  // 单张插图的 HTTP 上传体积（原 12 MiB 硬编码；上传走 multer，不受 JSON 请求体限制约束）。
  { key: "maxAssetUploadBytes", env: "PROJECTX_CARD_ASSET_UPLOAD_MIB", unit: "MiB", default: 12, ceiling: 512 },
];

export const CARD_ASSET_ENV_VARS = LIMIT_DEFS.map((def) => def.env);

function defaultLimits(): CardAssetLimits {
  const limits = {} as CardAssetLimits;
  for (const def of LIMIT_DEFS) limits[def.key] = def.unit === "MiB" ? def.default * MEBIBYTE : def.default;
  return limits;
}

/** 未配置时的默认预算（文档与测试都用它做基准）。 */
export const DEFAULT_CARD_ASSET_LIMITS: CardAssetLimits = defaultLimits();

export interface ResolvedCardAssetLimits {
  limits: CardAssetLimits;
  /** 生效的覆盖项与异常值说明，供启动日志使用 */
  notices: string[];
}

/**
 * 纯函数形式的解析器：不读 `process.env`、不打印、不抛错，便于单测与启动自检复用。
 */
export function resolveCardAssetLimits(env: Record<string, string | undefined> = {}): ResolvedCardAssetLimits {
  const limits = defaultLimits();
  const notices: string[] = [];
  for (const def of LIMIT_DEFS) {
    const raw = env[def.env];
    if (raw === undefined || String(raw).trim() === "") continue;
    const label = `${def.env}=${def.default}${def.unit === "MiB" ? " MiB" : " 条"}`;
    const parsed = Number(String(raw).trim());
    if (!Number.isFinite(parsed) || parsed < 1) {
      notices.push(`${def.env}="${raw}" 不是 ≥1 的数，按默认值 ${label} 处理`);
      continue;
    }
    const maxAllowed = def.unit === "MiB" ? def.ceiling * MEBIBYTE : def.ceiling;
    const valueInUnit = def.unit === "MiB" ? parsed * MEBIBYTE : parsed;
    if (valueInUnit > maxAllowed) {
      limits[def.key] = maxAllowed;
      const ceilingLabel = def.unit === "MiB" ? `${def.ceiling} MiB` : `${def.ceiling} 条`;
      notices.push(`${def.env}="${raw}" 超过安全天花板 ${ceilingLabel}（${label} 的放宽上界），已按天花板夹紧`);
      continue;
    }
    limits[def.key] = def.unit === "MiB" ? Math.round(valueInUnit) : Math.floor(valueInUnit);
    notices.push(`${def.key} 由 ${def.env} 覆盖为 ${def.unit === "MiB" ? `${parsed} MiB` : `${limits[def.key]} 条`}`);
  }
  return { limits, notices };
}

/**
 * shared 层允许被前端打包，`process` 不一定存在——解析必须对缺失的 `process.env` 免疫。
 * 真正的闸门始终在服务端导入/上传入口，客户端拿到默认值只用于提示文案。
 */
function readProcessEnv(): Record<string, string | undefined> {
  return typeof process !== "undefined" && process.env ? process.env : {};
}

const resolved = resolveCardAssetLimits(readProcessEnv());
if (resolved.notices.length > 0 && typeof process !== "undefined" && process.env) {
  for (const notice of resolved.notices) console.warn(`[card-asset-limits] ${notice}`);
}

export const MAX_CARD_ASSET_BYTES = resolved.limits.maxAssetBytes;
export const MAX_CARD_ASSETS_PER_IMPORT = resolved.limits.maxAssetsPerImport;
export const MAX_CARD_ASSETS_TOTAL_BYTES = resolved.limits.maxAssetsTotalBytes;
export const MAX_CARD_ASSET_UPLOAD_BYTES = resolved.limits.maxAssetUploadBytes;

/** 给启动日志用的一行摘要。 */
export function describeCardAssetLimits(): string {
  return [
    `单图 ≤${Math.round(MAX_CARD_ASSET_BYTES / MEBIBYTE)}MiB`,
    `单次导入 ≤${MAX_CARD_ASSETS_PER_IMPORT}条`,
    `导入累计 ≤${Math.round(MAX_CARD_ASSETS_TOTAL_BYTES / MEBIBYTE)}MiB`,
    `上传 ≤${Math.round(MAX_CARD_ASSET_UPLOAD_BYTES / MEBIBYTE)}MiB`
  ].join(" | ");
}
