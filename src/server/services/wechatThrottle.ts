import {
  MAX_WECHAT_BIND_GLOBAL_PER_MINUTE,
  MAX_WECHAT_BIND_PER_USER_HOUR,
  WECHAT_MAX_CONCURRENT_REQUESTS,
  WECHAT_REQUEST_TIMEOUT_MS,
} from "../../shared/wechatLimits";

/**
 * 微信出站调用的超时、并发与绑定配额（安全 R20）。
 *
 * 三层各自解决一个具体问题：
 *  - **超时**：`fetch` 不带信号时，微信侧半挂连接会永久占住这个请求；超时口径覆盖到**正文读完**
 *    为止（PR #312 CR15），只卡响应头的超时挡不住「头给得出、正文停顿」这种半挂；
 *  - **并发**：微信对同一 AppID 有接口级频控，批量公布成绩时 N 个学生并发取 token/发消息
 *    会直接换来 45009（应用调用超过限制），受害的是全站的推送；占位同样持续到正文读完，
 *    否则并发上限统计的是「发出去多少请求」而不是「挂着多少连接」；
 *  - **绑定配额**：绑定接口会真实调用 `jscode2session`，无配额时一个脚本就能把 AppID
 *    的日调用额度打空，导致当天所有学生都无法订阅。
 *
 * 计数放在内存：重启后从头计数，丢掉的只是「攻击者的续命窗口」，不涉及资金或数据事实。
 */

export class WechatThrottleError extends Error {
  readonly status = 429;
  readonly code = "WECHAT_QUOTA_EXCEEDED";
  readonly retryAfterSeconds: number;
  constructor(message: string, retryAfterSeconds: number) {
    super(message);
    this.name = "WechatThrottleError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** 微信接口超时（区别于业务 errcode：这是链路层故障，可重试）。 */
export class WechatTimeoutError extends Error {
  readonly status = 504;
  constructor(message = "微信接口请求超时") {
    super(message);
    this.name = "WechatTimeoutError";
  }
}

// ── 并发闸门 ──
let inFlight = 0;
const waiters: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
  if (inFlight < WECHAT_MAX_CONCURRENT_REQUESTS) {
    inFlight += 1;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  // 前一个持有者释放时已经把名额转交给本 promise；这里不再自增，避免交接期被别的调用插队。
}

function releaseSlot(): void {
  const next = waiters.shift();
  if (next) next();
  else inFlight = Math.max(0, inFlight - 1);
}

/** 串行度受限地执行一次微信出站调用（超过闸门时排队，而不是并发打出去）。 */
export async function withWechatSlot<T>(run: () => Promise<T>): Promise<T> {
  await acquireSlot();
  try {
    return await run();
  } finally {
    releaseSlot();
  }
}

/**
 * 微信出站响应：`body` 在闸门内就已经读完（PR #312 CR15）。
 *
 * 只有「响应头 + 正文」都落定才算这次调用结束。返回原始 `Response` 的话，占槽与计时在响应头
 * 到达时就结束了，而调用方紧接着还要 `response.json()`——那段读取既不在超时之内、也不在并发
 * 预算之内：微信侧半挂（头给得出来、正文不给）会把连接与槽位一起永久占住。
 */
export interface WechatFetchResponse {
  readonly status: number;
  readonly statusText: string;
  readonly ok: boolean;
  readonly headers: Headers;
  /** 已按截止时间读完的响应正文（微信一律返回小 JSON，不做流式处理） */
  readonly body: string;
  json(): Promise<unknown>;
}

/** 正文读取超出预算的内部信号；对外统一表现为 `WechatTimeoutError`。 */
class WechatBodyDeadlineError extends Error {
  constructor() {
    super("wechat response body deadline");
    this.name = "WechatBodyDeadlineError";
  }
}

async function readBodyWithinBudget(response: Response, remainingMs: number): Promise<string> {
  if (remainingMs <= 0) throw new WechatBodyDeadlineError();
  let tick: ReturnType<typeof setTimeout> | undefined;
  try {
    // 用 Promise.race 而不是只靠 AbortSignal：半挂的传输常常根本不理会 signal，
    // signal 只是让它尽早断开的辅助手段，真正的截止点必须由读侧自己守着。
    return await Promise.race([
      response.text(),
      new Promise<never>((_, reject) => {
        tick = setTimeout(() => reject(new WechatBodyDeadlineError()), remainingMs);
      }),
    ]);
  } finally {
    if (tick) clearTimeout(tick);
  }
}

/**
 * 带超时的微信 `fetch`。除请求本身外还叠加一次「等待槽位」的预算：
 * 队列本身也可能因为微信慢而堆积，所以总预算默认取「排队 + 请求」的两倍。
 * `budgetMs` 供回归脚本按毫秒级验证超时行为，生产调用一律用默认值。
 */
export async function wechatFetch(
  url: string | URL,
  init: RequestInit = {},
  budgetMs = WECHAT_REQUEST_TIMEOUT_MS * 2
): Promise<WechatFetchResponse> {
  const deadlineAt = Date.now() + budgetMs;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), budgetMs);
  const signal = mergeSignals(init.signal, deadline.signal);
  // 槽位从「排队」一直占到「正文读完」：并发上限约束的是在途连接数，不是响应头数。
  try {
    return await withWechatSlot(async () => {
      let response: Response;
      try {
        response = await fetch(url, { ...init, signal });
      } catch (error) {
        if (deadline.signal.aborted) throw new WechatTimeoutError(`微信接口在 ${budgetMs} 毫秒内没有返回响应头`);
        throw error;
      }
      try {
        const body = await readBodyWithinBudget(response, deadlineAt - Date.now());
        return {
          status: response.status,
          statusText: response.statusText,
          ok: response.ok,
          headers: response.headers,
          body,
          json: async () => JSON.parse(body) as unknown,
        };
      } catch (error) {
        // 正文停顿/读取失败：必须把体关掉，连接才会归还，否则占着的槽位跟着泄漏
        await response.body?.cancel().catch(() => {});
        if (error instanceof WechatBodyDeadlineError) {
          throw new WechatTimeoutError(`微信接口返回了响应头，但正文在 ${budgetMs} 毫秒内没有读完`);
        }
        if (deadline.signal.aborted) throw new WechatTimeoutError(`微信接口在 ${budgetMs} 毫秒内没有读完响应`);
        throw error;
      }
    });
  } finally {
    clearTimeout(timer);
  }
}

function mergeSignals(a: AbortSignal | null | undefined, b: AbortSignal): AbortSignal {
  if (!a) return b;
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (b.aborted || a.aborted) controller.abort();
  a.addEventListener("abort", abort, { once: true });
  b.addEventListener("abort", abort, { once: true });
  return controller.signal;
}

// ── 绑定配额（滚动窗口计数） ──
const userAttempts = new Map<number, number[]>();
let globalAttempts: number[] = [];

function prune(timestamps: number[], windowMs: number, now: number): number[] {
  const cutoff = now - windowMs;
  let i = 0;
  while (i < timestamps.length && timestamps[i] <= cutoff) i += 1;
  return i > 0 ? timestamps.slice(i) : timestamps;
}

/** 测试与自检用：清空计数，避免相互串扰。 */
export function resetWechatThrottleCounters(): void {
  userAttempts.clear();
  globalAttempts = [];
  waiters.length = 0;
  inFlight = 0;
}

export interface WechatBindQuotaSnapshot {
  userId: number;
  userAttemptsLastHour: number;
  globalAttemptsLastMinute: number;
}

/**
 * 一次「检查 + 登记」的原子动作：先判额度，通过后立刻计数，避免并发请求同时通过检查。
 * 这里不给「未登录」路径放行：绑定接口本身要求 Bearer 身份，拿不到 userId 就是异常调用。
 */
export function takeWechatBindAttempt(userId: number): WechatBindQuotaSnapshot {
  const now = Date.now();
  const userKey = Number(userId);
  const userWindow = 60 * 60 * 1000;
  const globalWindow = 60 * 1000;

  const userHistory = prune(userAttempts.get(userKey) ?? [], userWindow, now);
  const globalHistory = prune(globalAttempts, globalWindow, now);
  const snapshot: WechatBindQuotaSnapshot = {
    userId: userKey,
    userAttemptsLastHour: userHistory.length,
    globalAttemptsLastMinute: globalHistory.length,
  };

  if (userHistory.length >= MAX_WECHAT_BIND_PER_USER_HOUR) {
    userAttempts.set(userKey, userHistory);
    globalAttempts = globalHistory;
    throw new WechatThrottleError(
      `微信订阅操作过于频繁：最近 1 小时已尝试 ${userHistory.length} 次（单账号上限 ${MAX_WECHAT_BIND_PER_USER_HOUR} 次，可由 PROJECTX_WECHAT_BIND_MAX_PER_HOUR 调整），请稍后再试`,
      3600
    );
  }
  if (globalHistory.length >= MAX_WECHAT_BIND_GLOBAL_PER_MINUTE) {
    userAttempts.set(userKey, userHistory);
    globalAttempts = globalHistory;
    throw new WechatThrottleError(
      `微信订阅服务繁忙：最近 1 分钟全校已尝试 ${globalHistory.length} 次（上限 ${MAX_WECHAT_BIND_GLOBAL_PER_MINUTE} 次，可由 PROJECTX_WECHAT_BIND_MAX_GLOBAL_PER_MINUTE 调整），请稍后再试`,
      60
    );
  }

  userHistory.push(now);
  userAttempts.set(userKey, userHistory);
  globalHistory.push(now);
  globalAttempts = globalHistory;

  //  Map 只按活跃账号增长；全校学生规模有限，但仍设一道清理，避免长期驻留历史账号数组。
  if (userAttempts.size > 2000) {
    for (const [key, value] of userAttempts) {
      if (prune(value, userWindow, now).length === 0) userAttempts.delete(key);
    }
  }
  return snapshot;
}

export function describeWechatThrottle(): string {
  return `timeout=${WECHAT_REQUEST_TIMEOUT_MS}ms concurrency=${WECHAT_MAX_CONCURRENT_REQUESTS} bindUserHour=${MAX_WECHAT_BIND_PER_USER_HOUR} bindGlobalMinute=${MAX_WECHAT_BIND_GLOBAL_PER_MINUTE}`;
}
