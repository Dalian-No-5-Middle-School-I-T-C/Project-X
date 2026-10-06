/**
 * 微信小程序订阅链路的超时与配额（安全 R20）——**默认值 + 环境变量覆盖 + 安全天花板**三档决定。
 *
 * 原来的绑定路径是「一次前端点击 → 一次不带超时的 `fetch(api.weixin.qq.com)`」：
 *  1. 微信侧网络半挂时请求永不返回，学生的订阅请求会一直占着连接与 sidecar 之外的出站额度；
 *  2. 没有任何服务端计数，前端脚本（或被劫持的会话）可以无限刷 `jscode2session`。微信对
 *     该接口有应用级频控，刷爆之后返回 45009，**全校**的绑定与推送一起失效——
 *     也就是说这里的受害者不是攻击者，而是所有真实用户。
 *
 * 这里的计数**刻意放在内存里**（区别于 R11 的 DB 账本）：它限的是「出站呼叫次数」，
 * 进程重启后从头计数不影响任何资金或数据事实；而 AI 配额限的是账单，必须落库。
 * 判定窗口是滚动窗口，按「分钟/小时」各一档即可，不需要持久化。
 */

export type WechatLimitKey =
  | "requestTimeoutMs"
  | "bindPerUserPerHour"
  | "bindGlobalPerMinute"
  | "maxConcurrentRequests";

export type WechatLimits = Record<WechatLimitKey, number>;

const LIMIT_DEFS: Array<{
  key: WechatLimitKey;
  env: string;
  default: number;
  min: number;
  ceiling: number;
  unit: "ms" | "count";
}> = [
  // 单次出站请求超时：微信接口正常在几百毫秒内返回，8 秒已经覆盖慢链路。
  { key: "requestTimeoutMs", env: "PROJECTX_WECHAT_TIMEOUT_MS", default: 8000, min: 500, ceiling: 60000, unit: "ms" },
  // 单个学生每小时可发起的绑定次数：一次性订阅每场考试前重新引导一次，10 次足够宽松。
  { key: "bindPerUserPerHour", env: "PROJECTX_WECHAT_BIND_MAX_PER_HOUR", default: 10, min: 1, ceiling: 600, unit: "count" },
  // 全局每分钟绑定次数：按「整校学生同一时刻集中订阅」的场景留余量，同时挡住无脑脚本。
  { key: "bindGlobalPerMinute", env: "PROJECTX_WECHAT_BIND_MAX_GLOBAL_PER_MINUTE", default: 60, min: 1, ceiling: 6000, unit: "count" },
  // 并发出站请求：微信对同一 AppID 的调用有频控，串行度越高越容易撞 45009。
  { key: "maxConcurrentRequests", env: "PROJECTX_WECHAT_MAX_CONCURRENT", default: 4, min: 1, ceiling: 32, unit: "count" },
];

export const WECHAT_ENV_VARS = LIMIT_DEFS.map((def) => def.env);

function defaultLimits(): WechatLimits {
  const limits = {} as WechatLimits;
  for (const def of LIMIT_DEFS) limits[def.key] = def.default;
  return limits;
}

/** 未配置时的默认档位（文档、启动日志与测试都用它做基准）。 */
export const DEFAULT_WECHAT_LIMITS: WechatLimits = defaultLimits();

export interface ResolvedWechatLimits {
  limits: WechatLimits;
  /** 生效的覆盖项与异常值说明，供启动日志使用 */
  notices: string[];
}

/** 纯函数形式的解析器：不读 `process.env`、不打印、不抛错。 */
export function resolveWechatLimits(env: Record<string, string | undefined> = {}): ResolvedWechatLimits {
  const limits = defaultLimits();
  const notices: string[] = [];
  for (const def of LIMIT_DEFS) {
    const raw = env[def.env];
    if (raw === undefined || String(raw).trim() === "") continue;
    const parsed = Number(String(raw).trim());
    if (!Number.isFinite(parsed) || parsed < def.min) {
      notices.push(`${def.env}="${raw}" 不是 ≥${def.min} 的数值，按默认值 ${def.default} 处理`);
      continue;
    }
    const value = Math.floor(parsed);
    if (value > def.ceiling) {
      limits[def.key] = def.ceiling;
      notices.push(`${def.env}="${raw}" 超过安全天花板 ${def.ceiling}，已按天花板夹紧`);
      continue;
    }
    limits[def.key] = value;
    notices.push(`${def.key} 由 ${def.env} 覆盖为 ${value}`);
  }
  return { limits, notices };
}

function readProcessEnv(): Record<string, string | undefined> {
  return typeof process !== "undefined" && process.env ? process.env : {};
}

const resolved = resolveWechatLimits(readProcessEnv());
if (resolved.notices.length > 0 && typeof process !== "undefined" && process.env) {
  for (const notice of resolved.notices) console.warn(`[wechat-limits] ${notice}`);
}

export const WECHAT_REQUEST_TIMEOUT_MS = resolved.limits.requestTimeoutMs;
export const MAX_WECHAT_BIND_PER_USER_HOUR = resolved.limits.bindPerUserPerHour;
export const MAX_WECHAT_BIND_GLOBAL_PER_MINUTE = resolved.limits.bindGlobalPerMinute;
export const WECHAT_MAX_CONCURRENT_REQUESTS = resolved.limits.maxConcurrentRequests;

/** 给启动日志与健康检查用的一行摘要。 */
export function describeWechatLimits(): string {
  return [
    `出站超时 ≤${WECHAT_REQUEST_TIMEOUT_MS}ms`,
    `并发 ≤${WECHAT_MAX_CONCURRENT_REQUESTS}`,
    `单用户 1 小时绑定 ≤${MAX_WECHAT_BIND_PER_USER_HOUR} 次`,
    `全局 1 分钟绑定 ≤${MAX_WECHAT_BIND_GLOBAL_PER_MINUTE} 次`
  ].join(" | ");
}
