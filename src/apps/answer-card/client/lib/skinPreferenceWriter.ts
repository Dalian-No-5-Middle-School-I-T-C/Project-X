/**
 * 皮肤偏好回写（安全 R49）——与 React 无关的核心实现。
 *
 * 单独成文件的原因：客户端组件里的 `useRef` 版本无法在 Node 回归脚本里驱动，
 * 而这条「成功/失败/并发次序」判定恰恰是 R49 的验收点（见
 * `scripts/verify-scanner-skin-patch-guard.ts` 场景 R49-1~3）。组件侧入口是
 * `./skinSync.ts` 的 `useSkinPreferenceWriter()`。
 *
 * 背景：Web 端与扫描端原先都只做了「发一次 PATCH」，成功后不更新本地用户快照，
 * `user.themeSkin` 一直停在登录时的值。于是「切 A→B→A」的最后一步——本地 skin 又等于登录快照 A——
 * 被「相同就不用回写」的判断跳过，账号最终留在 B：用户以为自己在用 A，重登或换设备却恢复成 B。
 *
 * 三条口径：
 *  1. 成功**且仍是最后一次请求**才回调 `onApplied(skin)`；更早发出的请求后到（用户已再次切换）
 *     判为 `superseded`，不回写本地权威值，免得旧响应把最新选择盖掉；
 *  2. 失败回调 `onFailed()`，调用方应以服务端为准（`refreshUser()`），不能假装本地已生效；
 *  3. 请求体与回写值都用本次传入的 `skin`，不引用渲染前的旧值。
 */

/** 账号级偏好设置端点（themeSkin / colorScheme 都走它）。 */
export const ACCOUNT_SETTINGS_PATH = "/api/users/me/settings";

export type SkinWriteOutcome = "applied" | "superseded" | "failed";

export type SkinFetcher = (skin: string) => Promise<unknown>;

export function createSkinPreferenceWriter(fetcher: SkinFetcher) {
  let issued = 0;
  return async function write(
    skin: string,
    onApplied: (skin: string) => void,
    onFailed: () => void
  ): Promise<SkinWriteOutcome> {
    const request = ++issued;
    try {
      await fetcher(skin);
    } catch {
      // 离线/鉴权失败不打扰用户，但要把「没写进去」告诉调用方。
      onFailed();
      return "failed";
    }
    if (request !== issued) return "superseded";
    onApplied(skin);
    return "applied";
  };
}
