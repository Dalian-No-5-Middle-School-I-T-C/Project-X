/**
 * 导出 PDF 的版本闸门（安全审查 R45 / F072）。
 *
 * 缺陷：答题卡是 1200ms 防抖自动保存的。老师点「导出 PDF」的瞬间，屏幕上那一版可能还没落库，
 * 而 PDF 是从库里当前值渲染的；等 PDF 真的开始生成，随后一次防抖保存又可能已经覆盖成新版。
 * 结果是打印出来的答题卡和阅卷用的坐标布局不是同一版——纸上的格子和判分位置对不上，
 * 而且没有任何提示。原先前端虽然传了 ?v=，但 /pdf 路由从来不读它，等于没绑。
 *
 * 做法：前端把「它认为已经保存好的那版」的 revision 用 ?v= 带上来，服务端在渲染前与库里的
 * 当前 revision 比对。不一致就说明前端手里的快照已经不是当前版，拒绝渲染，
 * 让前端先把待存改动收敛掉、或重新加载后再导出。
 *
 * ?v= 保持可选：命令行冒烟脚本（scripts/deployment-business-smoke.ts）和修复基准工具
 * （tools/repair-benchmark/run.mjs）直接打 /pdf 不带版本号，它们不经过防抖自动保存、
 * 不在这个竞态里，照常渲染。
 *
 * 为什么不用 updated_at 当令牌：它由 CURRENT_TIMESTAMP 写入，只有秒级精度，同一秒内的两次保存
 * 取到同一个值；而且 PUT 响应里的 updatedAt 是 normalizeCard 用 new Date() 生成的，
 * 跟库里存的那个本来就不相等。只有单调递增的 revision 能唯一标识一次保存。
 */

export const CARD_REVISION_INVALID = "CARD_REVISION_INVALID";
export const CARD_REVISION_MISMATCH = "CARD_REVISION_MISMATCH";

/** 只认 0 或无前导零的最多 10 位数字。正负号、指数、小数、空白都会被 Number() 悄悄接受，一律拒。 */
const REVISION_PATTERN = /^(?:0|[1-9][0-9]{0,9})$/;

/** 回显给调用方的原值长度上限，避免把超长查询串塞进错误响应。 */
const RAW_ECHO_MAX = 32;

export type PdfRevisionGate =
  | { decision: "render"; revision: number }
  | { decision: "mismatch"; requested: number; current: number }
  | { decision: "invalid"; raw: string };

/** 纯函数：不碰库、不碰 req/res，便于单测穷举边界值。 */
export function resolvePdfRevisionGate(currentRevision: number, queryValue: unknown): PdfRevisionGate {
  if (queryValue === undefined) {
    return { decision: "render", revision: currentRevision };
  }

  // Express 的 query 只会给出字符串、字符串数组（?v=1&v=2）或嵌套对象（?v[a]=b）。
  // 数组意味着同一个参数传了多次，取哪个值都是猜——直接判畸形，不做 join 兜底；
  // 其余非字符串形态同样判畸形：不做 String() 转换，否则一个 toString() 返回 "7" 的对象就能冒充版本号。
  if (Array.isArray(queryValue)) {
    return { decision: "invalid", raw: queryValue.map((item) => String(item)).join(",").slice(0, RAW_ECHO_MAX) };
  }
  if (typeof queryValue !== "string") {
    return { decision: "invalid", raw: "" };
  }

  const raw = queryValue;
  if (!REVISION_PATTERN.test(raw)) {
    return { decision: "invalid", raw: raw.slice(0, RAW_ECHO_MAX) };
  }

  const requested = Number(raw);
  return requested === currentRevision
    ? { decision: "render", revision: currentRevision }
    : { decision: "mismatch", requested, current: currentRevision };
}

export function pdfRevisionMismatchMessage(requested: number, current: number): string {
  return `答题卡版本不一致：导出请求基于 v${requested}，服务器当前是 v${current}。请重新加载答题卡后再导出。`;
}

export function pdfRevisionInvalidMessage(raw: string): string {
  return `版本号 v 参数无效：${raw || "(空)"}。应传答题卡当前的 revision（非负整数），或省略该参数。`;
}
