export interface SkinPatchDecision {
  /** 本次 effect 运行是否允许向账号 PATCH 皮肤偏好 */
  patch: boolean;
  /** 护栏推进后的 prevUserId（调用方写回 ref） */
  nextPrevUserId: string | number | null;
}

/**
 * 皮肤偏好回写护栏（PR #260 缺陷修复）。
 *
 * 背景：ScannerApp 的「登录同步 effect」与「PATCH 回写 effect」在同一轮 effect
 * 刷新内先后执行，二者闭包中的 skin 都是本轮渲染的旧值。登录前若经切换器改过
 * 皮肤（或本机残留旧值），同步 effect 排队的 setSkin 尚未生效，PATCH effect 就
 * 会拿陈旧 skin 与 serverSkin 比较并误发 PATCH，把账号偏好覆盖成本机旧值。
 *
 * 规则：对每个 user.id 的首次见到（登录瞬态：冷启动恢复会话 / 登出后重登 /
 * 换账号），不信任闭包里的陈旧 skin，改用「同步落定值」chosen ?? serverSkin
 * 判定——仅当会话内存在显式选择且异于账号偏好时才立即回写该选择；其余情况
 * （含本机旧值 ≠ 账号）一律静默，交给同步 effect 落定。正常运行期则与既有
 * 语义一致：按 `skin !== serverSkin` 回写。
 *
 * 纯函数：无副作用，prevUserId 由调用方持有并在每次运行后写回 nextPrevUserId
 * （便于脚本化回归测试，见 scripts/verify-scanner-skin-patch-guard.ts）。
 */
export function skinPatchDecision(
  prevUserId: string | number | null,
  userId: string | number | null,
  skin: string,
  serverSkin: string,
  /** sessionStorage「本会话显式选择」（projectx-skin-chosen；未选择为 null） */
  chosen: string | null,
): SkinPatchDecision {
  // 登出态：不回写，重置护栏（下次登录重新视为瞬态）
  if (!userId) return { patch: false, nextPrevUserId: null };
  if (prevUserId !== userId) {
    // 登录瞬态：闭包 skin 可能是切换前的本机旧值，不可信；
    // 以同步落定值为准——显式选择异于账号时恰好回写一次该选择。
    const settledSkin = chosen ?? serverSkin;
    return { patch: settledSkin !== serverSkin, nextPrevUserId: userId };
  }
  // 正常运行期：与既有语义一致——仅当本地选择 ≠ 账号偏好时回写
  return { patch: skin !== serverSkin, nextPrevUserId: userId };
}
