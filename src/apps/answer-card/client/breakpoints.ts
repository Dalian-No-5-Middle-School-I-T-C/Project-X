/**
 * 响应式断点单一事实源。
 *
 * 约束(必须遵守):
 * - CSS 的 `@media` 查询不能引用 CSS 变量,断点数值在 styles.css 中仍以字面量书写;
 * - 本文件是 JS 侧唯一权威来源,`useMediaQuery` / `useIsMobile` 等 hook 的查询串由此拼接;
 * - styles.css `:root` 中的 `--bp-phone/tablet/desktop` 仅为语义镜像(供 getComputedStyle 读取与文档对照),
 *   修改断点时必须两侧同步,禁止只改一侧。
 *
 * 三级断点语义:
 * - phone   ≤ 480px   手机竖屏(底部导航、bottom sheet、卡片化表格)
 * - tablet  ≤ 768px   平板竖屏/手机横屏(紧凑布局、侧栏收起)
 * - desktop ≤ 1024px  平板横屏/小桌面(中等密度布局)
 */
export const BP = {
  phone: 480,
  tablet: 768,
  desktop: 1024,
} as const;

export type Breakpoint = keyof typeof BP;

/** 生成 max-width 媒体查询串,供 useMediaQuery 使用。 */
export function maxWidthQuery(bp: Breakpoint): string {
  return `(max-width: ${BP[bp]}px)`;
}

/** 生成 min-width 媒体查询串(下限,不含自身)。 */
export function minWidthQuery(bp: Breakpoint): string {
  return `(min-width: ${BP[bp] + 1}px)`;
}
