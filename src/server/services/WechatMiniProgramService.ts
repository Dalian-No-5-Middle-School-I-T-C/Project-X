/**
 * 微信小程序服务端调用（成绩发布订阅消息）。
 *
 * 环境变量（缺失即抛错，不写入代码/日志明文）：
 *   WECHAT_MINIPROGRAM_APP_ID
 *   WECHAT_MINIPROGRAM_APP_SECRET
 *   WECHAT_GRADE_RELEASE_TEMPLATE_ID
 *   WECHAT_SUBSCRIBE_PAGE（可选，默认 pages/scores/scores）
 *   WECHAT_MINIPROGRAM_STATE（可选，developer/trial/formal，默认 formal）
 */

type WechatSessionResponse = {
  openid?: string;
  session_key?: string;
  unionid?: string;
  errcode?: number;
  errmsg?: string;
};

type WechatAccessTokenResponse = {
  access_token?: string;
  expires_in?: number;
  errcode?: number;
  errmsg?: string;
};

type WechatSendResponse = {
  errcode?: number;
  errmsg?: string;
};

type WechatMiniProgramState = "developer" | "trial" | "formal";

/**
 * 微信接口错误。errcode 为微信返回的业务错误码；
 * 网络/HTTP 层失败时 errcode 为 null（调用方按“可重试的基建故障”处理）。
 * message 只含错误码，不含 errmsg 原文，避免敏感信息进日志。
 */
export class WechatApiError extends Error {
  readonly errcode: number | null;

  constructor(message: string, errcode: number | null) {
    super(message);
    this.name = "WechatApiError";
    this.errcode = errcode;
  }
}

let cachedAccessToken: { token: string; expiresAt: number } | null = null;
/**
 * 并发单飞：批量公布会让多场考试在同一时刻取 token，而微信每次下发新 token 都会让上一个失效
 * （旧 token 发送报 40001，本场推送就此作废且去重位已被占用）。同一时刻只允许一次 token 请求，
 * 其余调用等待同一个 promise。
 */
let accessTokenInFlight: Promise<string> | null = null;

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function getAppId(): string {
  return getRequiredEnv("WECHAT_MINIPROGRAM_APP_ID");
}

function getAppSecret(): string {
  return getRequiredEnv("WECHAT_MINIPROGRAM_APP_SECRET");
}

export function getGradeReleaseTemplateId(): string {
  return getRequiredEnv("WECHAT_GRADE_RELEASE_TEMPLATE_ID");
}

const REQUIRED_ENV_NAMES = [
  "WECHAT_MINIPROGRAM_APP_ID",
  "WECHAT_MINIPROGRAM_APP_SECRET",
  "WECHAT_GRADE_RELEASE_TEMPLATE_ID",
] as const;

/** 返回缺失的环境变量名（不含值），用于启动自检与部署诊断。 */
export function getMissingWechatEnv(): string[] {
  return REQUIRED_ENV_NAMES.filter((name) => !process.env[name]);
}

export function isWechatConfigured(): boolean {
  return getMissingWechatEnv().length === 0;
}

function getSubscribePage(): string {
  return process.env.WECHAT_SUBSCRIBE_PAGE || "pages/scores/scores";
}

function getMiniProgramState(): WechatMiniProgramState {
  const value = process.env.WECHAT_MINIPROGRAM_STATE || "formal";
  if (value === "developer" || value === "trial" || value === "formal") return value;
  return "formal";
}

/** 非敏感的运行时配置，供管理端诊断接口回显。 */
export function getWechatRuntimeConfig(): { page: string; miniprogramState: WechatMiniProgramState } {
  return { page: getSubscribePage(), miniprogramState: getMiniProgramState() };
}

/**
 * 启动自检日志：未配置时安静说明，配置一半则告警
 * （部署最常见的坑是漏配变量导致发布后“静默不推送”）。只输出变量名，不输出值。
 */
export function logWechatSubscriptionStatus(): void {
  const missing = getMissingWechatEnv();
  if (missing.length === REQUIRED_ENV_NAMES.length) {
    console.info("[wechat] 未配置订阅消息环境变量，成绩发布推送关闭");
    return;
  }
  if (missing.length > 0) {
    console.warn(`[wechat] 订阅消息配置不完整，成绩发布推送关闭，缺少: ${missing.join(", ")}`);
    return;
  }
  const { page, miniprogramState } = getWechatRuntimeConfig();
  console.log(`[wechat] 成绩发布订阅推送已启用 (miniprogram_state=${miniprogramState}, page=${page})`);
}

async function readWechatJson<T>(response: globalThis.Response): Promise<T> {
  if (!response.ok) {
    throw new WechatApiError(`WeChat API request failed with status ${response.status}`, null);
  }
  return (await response.json()) as T;
}

/** 用小程序 wx.login 下发的 code 换取 openid（jscode2session）。 */
export async function getOpenIdByLoginCode(code: string): Promise<string> {
  const url = new URL("https://api.weixin.qq.com/sns/jscode2session");
  url.searchParams.set("appid", getAppId());
  url.searchParams.set("secret", getAppSecret());
  url.searchParams.set("js_code", code);
  url.searchParams.set("grant_type", "authorization_code");

  const data = await readWechatJson<WechatSessionResponse>(await fetch(url));
  if (!data.openid) {
    // 不回显 errmsg 原文以免泄露 AppID 相关信息，仅记 errcode
    throw new WechatApiError(`WeChat jscode2session failed: errcode=${data.errcode ?? "unknown"}`, data.errcode ?? null);
  }
  return data.openid;
}

async function requestAccessToken(): Promise<string> {
  const url = new URL("https://api.weixin.qq.com/cgi-bin/token");
  url.searchParams.set("grant_type", "client_credential");
  url.searchParams.set("appid", getAppId());
  url.searchParams.set("secret", getAppSecret());

  const data = await readWechatJson<WechatAccessTokenResponse>(await fetch(url));
  if (!data.access_token) {
    throw new WechatApiError(`WeChat access token failed: errcode=${data.errcode ?? "unknown"}`, data.errcode ?? null);
  }

  const expiresInSec = Math.max(0, (data.expires_in ?? 7200) - 300);
  cachedAccessToken = { token: data.access_token, expiresAt: Date.now() + expiresInSec * 1000 };
  return data.access_token;
}

async function getAccessToken(forceRefresh = false): Promise<string> {
  if (!forceRefresh && cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 60_000) {
    return cachedAccessToken.token;
  }
  accessTokenInFlight ??= requestAccessToken().finally(() => { accessTokenInFlight = null; });
  return accessTokenInFlight;
}

/**
 * 部署自检：绕过缓存实取一次 access_token，用于验证 AppID/AppSecret/IP 白名单。
 * 只返回错误码，不外泄 token 或 errmsg 原文。
 */
export async function probeWechatAccessToken(): Promise<{ ok: boolean; errcode: number | null }> {
  try {
    await getAccessToken(true);
    return { ok: true, errcode: null };
  } catch (error) {
    const errcode = error instanceof WechatApiError ? error.errcode : null;
    return { ok: false, errcode };
  }
}

/** 发送成绩发布订阅消息；微信返回非 0 errcode 时抛错，由调用方记录。 */
export async function sendGradeReleaseMessage(input: {
  openid: string;
  templateId: string;
  courseName: string;
  score: number;
}): Promise<void> {
  const accessToken = await getAccessToken();
  const url = new URL("https://api.weixin.qq.com/cgi-bin/message/subscribe/send");
  url.searchParams.set("access_token", accessToken);

  // thing 类型限 20 字符；number 类型需为数字字符串
  const courseName = input.courseName.length > 20 ? `${input.courseName.slice(0, 19)}…` : input.courseName;
  const scoreValue = String(Math.round(input.score * 10) / 10);

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      touser: input.openid,
      template_id: input.templateId,
      page: getSubscribePage(),
      miniprogram_state: getMiniProgramState(),
      lang: "zh_CN",
      data: {
        thing1: { value: courseName },
        number2: { value: scoreValue },
      },
    }),
  });

  const data = await readWechatJson<WechatSendResponse>(response);
  if (data.errcode && data.errcode !== 0) {
    // 40001/42001 = access_token 失效（他处重取或超时），清缓存让下一次发送换新 token
    if (data.errcode === 40001 || data.errcode === 42001) cachedAccessToken = null;
    // 43101 = 用户拒绝接受/无可用订阅额度，属正常情形，交由调用方按失败计数处理
    throw new WechatApiError(`WeChat subscribe send failed: errcode=${data.errcode}`, data.errcode);
  }
}
