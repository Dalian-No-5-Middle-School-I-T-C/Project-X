import type { AnswerCard } from "./types";

/**
 * 答题卡版本指纹（安全 R35）。
 *
 * 扫描端可以长时间离线，本机缓存的答题卡会与服务器上的版本分叉（布局挪了、答案改了、
 * 分数调了），继续按旧卡识别判分等于把分数算错、而且现场看不出来。因此上传必须带上
 * 「我正在用哪一版卡」，由服务端拿自己那一版比对。
 *
 * 为什么不用 `updatedAt`：本机导入远端卡走的是 PUT /api/cards/:id，
 * `updateCard` 一律把 `updated_at` 重写成 CURRENT_TIMESTAMP，所以本地时间戳与服务器
 * 时间戳永远不相等，拿它当版本会拒掉每一次上传。指纹只看**内容**，导入几次都不变，
 * 也不受两边时钟影响。
 *
 * 这是「分叉探测器」，不是密码学完整性校验：它防的是缓存过期，不防恶意客户端
 * （恶意客户端本来就能读到服务器上的卡、算出同样的指纹）。上传接口自身另有鉴权。
 */

/** 参与版本比对的字段：只留会影响印刷版面、识别与判分的内容，去掉 updatedAt 这类易变元数据。 */
export function canonicalCardForVersion(card: AnswerCard): Record<string, unknown> {
  return {
    id: card.id,
    title: card.title,
    subject: card.subject ?? null,
    subjectLabel: card.subjectLabel ?? null,
    examDate: card.examDate ?? null,
    paper: card.paper,
    studentInfo: card.studentInfo,
    bodyBlocks: card.bodyBlocks,
    sided: card.sided,
    layoutVersion: card.layoutVersion,
  };
}

/**
 * 键排序后序列化：客户端与服务端构造对象的路径不同，键序不能影响指纹。
 *
 * **必须与 `JSON.stringify` 的规范化语义逐条一致**（评审 P1）：对象里值为 `undefined` 的键
 * 被**省略**，数组里的 `undefined` 元素落成 `null`。两边拿到的是同一份 JSON 文本，但内存里的
 * 形状不同——服务端从库里构造时会写出 `{ marker: undefined }`，而这份键经 HTTP 传输后在客户端
 * 根本不存在。旧实现把前者编成 `"marker":null`、后者编成没有这个键，于是同一张卡得到两个指纹，
 * 普通客观题卡与主观题卡都在上传时 409 `CARD_VERSION_MISMATCH`。
 * 指纹是「两边是不是同一版」的唯一依据，这种差异等于把校验本身变成故障源。
 */
function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    // 数字 NaN/Infinity 经 JSON 也是 null；字符串/数字/布尔按 JSON 的转义与格式产出。
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function hash32(text: string, basis: number, prime: number): number {
  let hash = basis >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, prime) >>> 0;
  }
  return hash >>> 0;
}

/** 24 位十六进制（96 bit）。三段用不同基/乘子，其中一段混入长度，避免「前缀相同就相近」。 */
export function cardFingerprint(card: AnswerCard): string {
  const canonical = stableStringify(canonicalCardForVersion(card));
  const a = hash32(canonical, 0x811c9dc5, 0x01000193);
  const b = hash32(canonical, 0x00001505, 0x01000193);
  const c = hash32(`${canonical.length}:${a.toString(16)}:${b.toString(16)}`, 0x9e3779b9, 0x85ebca6b);
  return [a, b, c].map((part) => part.toString(16).padStart(8, "0")).join("");
}

/** 给人看的短版本（界面提示、日志）：完整指纹太长，前 12 位足以让老师确认「两边是不是同一版」。 */
export function shortCardVersion(card: AnswerCard): string {
  return cardFingerprint(card).slice(0, 12);
}

const VERSION_PATTERN = /^[0-9a-f]{24}$/;

/** 上传接口入参校验：只接受本模块产出的指纹形状，避免把任意字符串当版本塞进日志与错误信息。 */
export function parseCardVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return VERSION_PATTERN.test(normalized) ? normalized : null;
}
