/**
 * 备份恢复 ZIP 的解压预算（安全 R43）——**默认值 + 环境变量覆盖 + 安全天花板**三档决定。
 *
 * 为什么需要预算而不是只看上传体积：上传侧只约束**压缩后**的字节数（且恢复接口已改为
 * 流式落盘，上限跟随这里的累计预算），而 ZIP 的解压体积由条目自己声明。一个高压缩比包
 * 可以声明数百 GB 的解压产物，服务端会照单全收地写进临时目录（磁盘打满）。
 * 因此解压必须有自己的三道闸：条目数、单条解压后体积、累计解压后体积。
 * 第四档 `maxCompressionRatio` 不管正常条目，它管的是「头部把解压后体积声明成 0」的谎报条目：
 * 解压库按声明封顶，声明为 0 就等于不封顶，所以这类条目只能按压缩负载的最坏展开来预估体积。
 *
 * 为什么不能只留硬编码：真实备份的规模差异很大（整校答题卡目录可能有几万个小文件），
 * 写死意味着现场只能改代码发版。
 * 为什么不能只留环境变量：那等于让一个拼错的数字把保护整个关掉。
 * 所以 `PROJECTX_RESTORE_ZIP_*` 只能在默认值与安全天花板之间调；非法值（非数字、0、负数、
 * 超天花板）回落默认值或被夹紧，只在启动时留一行日志——解析发生在导入期，任何情况下都不抛错。
 *
 * 单位约定：体积类环境变量按 **MiB** 给（`..._MIB`），数量类按个数给；对外仍以字节/个数导出。
 */

import { resolveFeedbackStorageMib, MAX_FEEDBACK_STORAGE_MIB } from "./feedbackLimits";
import { resolvePaperStorageLimits, MAX_PAPER_STORAGE_TOTAL_CEILING_MIB } from "./paperStorageLimits";

const MEBIBYTE = 1024 * 1024;

/** 数据库、答案页、导出等不属于原卷 / 反馈配额的数据预留。 */
const DATABASE_RESERVE_MIB = 4096;
/** 累计解压预算的天花板：原卷 + 数据库预留 + 反馈附件，三项都取各自的安全天花板。 */
const MAX_TOTAL_CEILING_MIB =
  MAX_PAPER_STORAGE_TOTAL_CEILING_MIB + DATABASE_RESERVE_MIB + MAX_FEEDBACK_STORAGE_MIB;

export type RestoreZipLimitKey =
  | "maxZipEntries" | "maxEntryUncompressedBytes" | "maxTotalUncompressedBytes" | "maxCompressionRatio";

export type RestoreZipLimits = Record<RestoreZipLimitKey, number>;

/** DEFLATE 的最坏展开比：stored block 每 8 位可吐出 1 字节，实测上界约 1032:1。 */
const DEFLATE_WORST_RATIO = 1032;

const LIMIT_DEFS: Array<{
  key: RestoreZipLimitKey;
  env: string;
  unit: "MiB" | "count" | "ratio";
  default: number;
  ceiling: number;
}> = [
  // 条目数：备份的正常形态是「2 个库文件 + data/answer-card 下的原卷/答案页」。
  // 2 万条已够几千场考试的整页图；天花板 10 万条是防止有人把它调成「不设限」。
  { key: "maxZipEntries", env: "PROJECTX_RESTORE_ZIP_MAX_ENTRIES", unit: "count", default: 20000, ceiling: 100000 },
  // 单条解压后体积：projectx.db 在长期运行的学校可以涨到几百 MiB，给到 1 GiB 起步。
  { key: "maxEntryUncompressedBytes", env: "PROJECTX_RESTORE_ZIP_MAX_ENTRY_MIB", unit: "MiB", default: 1024, ceiling: 8192 },
  // 累计解压后体积：实际默认值由 resolveDefaultTotalMib 按「原卷配额 + 数据库预留 +
  // 反馈附件配额」动态计算；备份必须能装下自己导出的合法数据，天花板同理。
  { key: "maxTotalUncompressedBytes", env: "PROJECTX_RESTORE_ZIP_MAX_TOTAL_MIB", unit: "MiB", default: 1, ceiling: MAX_TOTAL_CEILING_MIB },
  // 最坏展开比：只用于「头部声明解压后 0 字节」的条目——那是解压炸弹的谎报签名（此时库自身的
  // 按声明封顶等于没封顶）。上界取 DEFLATE 的物理极值，所以这项只能收紧、不能放宽。
  { key: "maxCompressionRatio", env: "PROJECTX_RESTORE_ZIP_MAX_RATIO", unit: "ratio", default: DEFLATE_WORST_RATIO, ceiling: DEFLATE_WORST_RATIO },
];

export const RESTORE_ZIP_ENV_VARS = LIMIT_DEFS.map((def) => def.env);

/** 默认累计预算跟随实际存储配额：原卷 + 数据库预留 + 反馈附件，备份必须装得下自己的数据。 */
function resolveDefaultTotalMib(env: Record<string, string | undefined>): { mib: number; notices: string[] } {
  const paperMib = Math.round(resolvePaperStorageLimits(env).limits.maxPaperBytesTotal / MEBIBYTE);
  const feedback = resolveFeedbackStorageMib(env);
  return { mib: paperMib + DATABASE_RESERVE_MIB + feedback.mib, notices: [] };
}

function defaultLimits(env: Record<string, string | undefined>): { limits: RestoreZipLimits; notices: string[] } {
  const total = resolveDefaultTotalMib(env);
  const limits = {} as RestoreZipLimits;
  for (const def of LIMIT_DEFS) {
    const fallback = def.key === "maxTotalUncompressedBytes" ? total.mib : def.default;
    limits[def.key] = def.unit === "MiB" ? fallback * MEBIBYTE : fallback;
  }
  return { limits, notices: total.notices };
}

/** 未配置时的默认预算（文档、界面提示与测试都用它做基准）。 */
export const DEFAULT_RESTORE_ZIP_LIMITS: RestoreZipLimits = defaultLimits(readProcessEnv()).limits;

export interface ResolvedRestoreZipLimits {
  limits: RestoreZipLimits;
  /** 生效的覆盖项与异常值说明，供启动日志使用 */
  notices: string[];
}

/**
 * 纯函数形式的解析器：不读 `process.env`、不打印、不抛错，便于单测与启动自检复用。
 */
function unitLabel(unit: "MiB" | "count" | "ratio", value: number): string {
  if (unit === "MiB") return `${value} MiB`;
  if (unit === "ratio") return `${value} 倍`;
  return `${value} 条`;
}

export function resolveRestoreZipLimits(env: Record<string, string | undefined> = {}): ResolvedRestoreZipLimits {
  const base = defaultLimits(env);
  const limits = base.limits;
  const notices: string[] = [...base.notices];
  for (const def of LIMIT_DEFS) {
    const raw = env[def.env];
    if (raw === undefined || String(raw).trim() === "") continue;
    const fallback = def.unit === "MiB" ? Math.round(limits[def.key] / MEBIBYTE) : limits[def.key];
    const label = `${def.env}=${unitLabel(def.unit, fallback)}`;
    const parsed = Number(String(raw).trim());
    if (!Number.isFinite(parsed) || parsed < 1) {
      notices.push(`${def.env}="${raw}" 不是 ≥1 的数，按默认值 ${label} 处理`);
      continue;
    }
    const maxAllowed = def.unit === "MiB" ? def.ceiling * MEBIBYTE : def.ceiling;
    const valueInUnit = def.unit === "MiB" ? parsed * MEBIBYTE : parsed;
    if (valueInUnit > maxAllowed) {
      limits[def.key] = maxAllowed;
      notices.push(`${def.env}="${raw}" 超过安全天花板 ${unitLabel(def.unit, def.ceiling)}（${label} 的放宽上界），已按天花板夹紧`);
      continue;
    }
    limits[def.key] = def.unit === "MiB" ? Math.round(valueInUnit) : Math.floor(valueInUnit);
    const effective = def.unit === "MiB" ? Math.round(limits[def.key] / MEBIBYTE) : limits[def.key];
    notices.push(`${def.key} 由 ${def.env} 覆盖为 ${unitLabel(def.unit, effective)}`);
  }
  return { limits, notices };
}

/**
 * shared 层允许被前端打包，`process` 不一定存在——解析必须对缺失的 `process.env` 免疫。
 * 真正的闸门始终在服务端解压入口处，客户端拿到默认值只用于提示文案。
 */
function readProcessEnv(): Record<string, string | undefined> {
  return typeof process !== "undefined" && process.env ? process.env : {};
}

const resolved = resolveRestoreZipLimits(readProcessEnv());
if (resolved.notices.length > 0 && typeof process !== "undefined" && process.env) {
  for (const notice of resolved.notices) console.warn(`[restore-zip-limits] ${notice}`);
}

export const MAX_RESTORE_ZIP_ENTRIES = resolved.limits.maxZipEntries;
export const MAX_RESTORE_ZIP_ENTRY_BYTES = resolved.limits.maxEntryUncompressedBytes;
export const MAX_RESTORE_ZIP_TOTAL_BYTES = resolved.limits.maxTotalUncompressedBytes;
export const MAX_RESTORE_ZIP_RATIO = resolved.limits.maxCompressionRatio;

/** 给启动日志与健康检查用的一行摘要。 */
export function describeRestoreZipLimits(): string {
  return [
    `条目 ≤${MAX_RESTORE_ZIP_ENTRIES}`,
    `单条解压后 ≤${Math.round(MAX_RESTORE_ZIP_ENTRY_BYTES / MEBIBYTE)}MiB`,
    `累计解压后 ≤${Math.round(MAX_RESTORE_ZIP_TOTAL_BYTES / MEBIBYTE)}MiB`,
    `谎报条目按 ≤${MAX_RESTORE_ZIP_RATIO} 倍最坏展开计`
  ].join(" | ");
}
