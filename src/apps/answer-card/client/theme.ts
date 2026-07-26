// 设计令牌镜像（与 styles.css :root 保持一致）
// JS 侧逻辑（图表、状态点、动态样式）引用此处，杜绝“同一文件混用 var(--brand) 与 #2E7D32”。
// 暗色主题由 CSS [data-theme="dark"] 覆盖，这里只放亮色基准。

export const tokens = {
  brand: "#C00F28",
  brandLight: "#E8354A",
  brandDark: "#9A0B21",
  brandGlow: "rgba(192, 15, 40, 0.35)",
  brandSoft: "rgba(192, 15, 40, 0.08)",
  brandTint: "rgba(192, 15, 40, 0.04)",

  text: "#0F0F0F",
  textSecondary: "#3D3D3D",
  muted: "#8A8A8A",

  line: "rgba(0, 0, 0, 0.06)",
  lineStrong: "rgba(0, 0, 0, 0.10)",

  surface: "#FFFFFF",
  surfaceRaised: "#FAFAFA",
  surfaceSoft: "rgba(255, 255, 255, 0.72)",

  background: "#F2F2F7",
  backgroundDeep: "#E5E5EA",

  // 语义色（替代散落的 #2E7D32 / #E24B4A / #639922 等）
  success: "#2E7D32",
  successSoft: "rgba(46, 125, 50, 0.12)",
  danger: "#E24B4A",
  dangerSoft: "rgba(226, 75, 74, 0.12)",
  warning: "#B7791F",
  warningSoft: "rgba(183, 121, 31, 0.12)",

  // z-index 阶梯（与 styles.css :root --z-* 对应）
  zDropdown: 900,
  zModal: 1000,
  zToast: 1100,
  zLightbox: 1200,
} as const;

export type ThemeTokens = typeof tokens;

// 语义色名 → 令牌键，便于在需要时统一取色
export const semantic: Record<"success" | "danger" | "warning", string> = {
  success: tokens.success,
  danger: tokens.danger,
  warning: tokens.warning,
};

// 响应式断点镜像（单一事实源在 breakpoints.ts，此处仅 re-export 便于组件统一入口）
export { BP as breakpoints } from "./breakpoints";
export type { Breakpoint } from "./breakpoints";
