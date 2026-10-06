/**
 * 单次资源票据（安全 R30）的有效期与数量档位——**默认值 + 环境变量覆盖 + 安全天花板**三档决定。
 *
 * 背景：跨域 API 模式下浏览器无法用 HttpOnly Cookie 认证，前端只能把**主会话令牌**拼进 URL
 * （`?token=`）来加载 PDF / 图片 / SSE。URL 会进浏览器历史、代理与访问日志，而主令牌本来
 * 可以读任意 GET 接口——泄漏一次等于整份只读权限外泄。
 * 整改方向是给「一次性资源访问」发**短命、限路径、限方法**的票据，并限制主令牌只能走媒体白名单。
 *
 * 为什么可配：SSE 判分进度、扫描进度这类长连接要吃满一个批次的时长，票据太短会让现场「看一半掉线」，
 * 太长又违背短命票据的初衷——所以让运维在安全天花板内按现场节奏调。
 * 为什么不能只留环境变量：一个拼错的数字只会回落默认值，不会把票据变成永久令牌。
 */

export type MediaTicketLimitKey = "ttlSeconds" | "maxActivePerUser" | "maxActiveTotal";

export type MediaTicketLimits = Record<MediaTicketLimitKey, number>;

const LIMIT_DEFS: Array<{
  key: MediaTicketLimitKey;
  env: string;
  unit: "seconds" | "count";
  default: number;
  ceiling: number;
}> = [
  // 票据寿命：默认 5 分钟——够打开一份 PDF、看完一段 SSE 首屏，又不值得被长期囤积。
  { key: "ttlSeconds", env: "PROJECTX_MEDIA_TICKET_TTL_SEC", unit: "seconds", default: 300, ceiling: 3600 },
  // 单账号同时存活的票据数：一次导入/预览可能连开十几张图，8 张够用且泄漏面可控。
  { key: "maxActivePerUser", env: "PROJECTX_MEDIA_TICKET_MAX_PER_USER", unit: "count", default: 8, ceiling: 64 },
  // 全局存活上限：票据在内存里，上限就是内存与误用上限（约 2 万条 × 短字符串）。
  { key: "maxActiveTotal", env: "PROJECTX_MEDIA_TICKET_MAX_TOTAL", unit: "count", default: 20000, ceiling: 100000 },
];

export const MEDIA_TICKET_ENV_VARS = LIMIT_DEFS.map((def) => def.env);

function defaultLimits(): MediaTicketLimits {
  const limits = {} as MediaTicketLimits;
  for (const def of LIMIT_DEFS) limits[def.key] = def.default;
  return limits;
}

/** 未配置时的默认档位（文档与测试基准）。 */
export const DEFAULT_MEDIA_TICKET_LIMITS: MediaTicketLimits = defaultLimits();

export interface ResolvedMediaTicketLimits {
  limits: MediaTicketLimits;
  notices: string[];
}

/** 纯函数解析器：不读 process.env、不打印、不抛错。 */
export function resolveMediaTicketLimits(env: Record<string, string | undefined> = {}): ResolvedMediaTicketLimits {
  const limits = defaultLimits();
  const notices: string[] = [];
  for (const def of LIMIT_DEFS) {
    const raw = env[def.env];
    if (raw === undefined || String(raw).trim() === "") continue;
    const label = `${def.env}=${def.default}${def.unit === "seconds" ? " 秒" : " 张"}`;
    const parsed = Number(String(raw).trim());
    if (!Number.isFinite(parsed) || parsed < 1) {
      notices.push(`${def.env}="${raw}" 不是 ≥1 的数，按默认值 ${label} 处理`);
      continue;
    }
    if (parsed > def.ceiling) {
      limits[def.key] = def.ceiling;
      notices.push(`${def.env}="${raw}" 超过安全天花板 ${def.ceiling}${def.unit === "seconds" ? " 秒" : " 张"}（${label} 的放宽上界），已按天花板夹紧`);
      continue;
    }
    limits[def.key] = Math.floor(parsed);
    notices.push(`${def.key} 由 ${def.env} 覆盖为 ${limits[def.key]}${def.unit === "seconds" ? " 秒" : " 张"}`);
  }
  return { limits, notices };
}

function readProcessEnv(): Record<string, string | undefined> {
  return typeof process !== "undefined" && process.env ? process.env : {};
}

const resolved = resolveMediaTicketLimits(readProcessEnv());
if (resolved.notices.length > 0 && typeof process !== "undefined" && process.env) {
  for (const notice of resolved.notices) console.warn(`[media-ticket-limits] ${notice}`);
}

export const MEDIA_TICKET_TTL_SECONDS = resolved.limits.ttlSeconds;
export const MEDIA_TICKET_MAX_PER_USER = resolved.limits.maxActivePerUser;
export const MEDIA_TICKET_MAX_TOTAL = resolved.limits.maxActiveTotal;

/** 给启动日志用的一行摘要。 */
export function describeMediaTicketLimits(): string {
  return `票据寿命 ${MEDIA_TICKET_TTL_SECONDS}s | 单账号 ≤${MEDIA_TICKET_MAX_PER_USER} 张 | 全局 ≤${MEDIA_TICKET_MAX_TOTAL} 张`;
}
