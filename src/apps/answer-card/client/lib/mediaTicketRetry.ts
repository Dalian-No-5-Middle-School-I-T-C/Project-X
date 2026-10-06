import { invalidateMediaTicket, resignMediaTicketUrl } from "../auth/api";

/**
 * 票据图片失败后的一次性重签（安全 R30 的 P2 返修）。
 *
 * 背景：单次资源票据在服务端是「单账号 N 张、超额淘汰最早过期」的短命凭据。
 * 连续翻完一批切块再回看第一张时，客户端手里的那张可能已经被服务端淘汰（或被改密/
 * 撤销清掉），`<img src>` 直接 401 变破图。浏览器自己发的图片请求拿不到响应码，
 * 也没有拦截器可挂，所以只能在 `onError` 里重签一张再试一次。
 *
 * 只重试一次、且以「本次失败的完整 URL」为键：图片元素会被 React 复用，
 * 用固定布尔标记会让后面几张图失去重试机会，用 URL 为键则换图即换键。
 */
export const MEDIA_IMAGE_RETRY_KEY = "pxTicketRetried";

/**
 * @returns true 表示已发起重签重试（调用方此时不要把界面切成「加载失败」）
 */
export function retryMediaTicketImage(element: HTMLImageElement): boolean {
  const failedUrl = element.getAttribute("src") ?? element.src;
  if (!failedUrl.includes("mt=")) return false; // 同源或已回落 token：没有票据可重签
  if (element.dataset[MEDIA_IMAGE_RETRY_KEY] === failedUrl) return false; // 同一 URL 只重试一次
  element.dataset[MEDIA_IMAGE_RETRY_KEY] = failedUrl;
  invalidateMediaTicket(failedUrl);
  void resignMediaTicketUrl(failedUrl).then((fresh) => {
    if (fresh && fresh !== failedUrl) element.src = fresh;
  });
  return true;
}
