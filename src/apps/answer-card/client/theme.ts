// 设计令牌镜像（与 design/tokens/tokens.css L2 Light 保持一致）
// JS 侧逻辑（图表、状态点、动态样式）引用此处，杜绝"同一文件混用 var(--brand) 与 #2E7D32"。
// 暗色主题由 CSS [data-theme="dark"] 覆盖 --px-*；此处只放亮色基准。
// 已修正原 tokens.css / styles.css / theme.ts 三处漂移：warning、zLightbox == 1200/9999 等。

export const tokens = {
  // 品牌（校绯红 #C00F28）
  brand: "#C00F28",
  brandLight: "#D93851",
  brandDark: "#A10D22",
  brandSoft: "rgba(192, 15, 40, 0.08)",
  brandTint: "rgba(192, 15, 40, 0.04)",
  brandGlow: "rgba(192, 15, 40, 0.30)",

  // 文字
  text: "#18181B",
  textSecondary: "#52525B",
  textPrimary: "#18181B",
  muted: "#71717A",

  // 表面 / 背景
  surface: "#FFFFFF",
  surfaceRaised: "#FFFFFF",
  surfaceSoft: "#FAFAFA",
  background: "#F4F4F5",
  backgroundDeep: "#F4F4F5",
  bgSoft: "#FAFAFA",
  bgSecondary: "#FFFFFF",
  bgAccent: "rgba(192, 15, 40, 0.08)",

  // 边框
  line: "rgba(24, 24, 27, 0.10)",
  lineStrong: "rgba(24, 24, 27, 0.18)",
  lineLight: "rgba(24, 24, 27, 0.06)",
  border: "rgba(24, 24, 27, 0.10)",

  // 阴影
  shadowSm: "0 1px 2px rgba(24, 24, 27, 0.05)",
  shadowMd: "0 1px 2px rgba(24, 24, 27, 0.04), 0 4px 12px rgba(24, 24, 27, 0.06)",
  shadowLg: "0 2px 4px rgba(24, 24, 27, 0.05), 0 12px 32px rgba(24, 24, 27, 0.10)",

  // 状态语义（danger 复用品牌红暗档，靠语境+图标+文案区分）
  success: "#16A34A",
  successSoft: "rgba(22, 163, 74, 0.12)",
  warning: "#D97706",
  warningSoft: "rgba(217, 119, 6, 0.12)",
  amber700: "#B45309", // --px-amber-700（档位徽章深琥珀，JS 侧镜像）
  danger: "#C00F28",
  dangerSoft: "rgba(192, 15, 40, 0.12)",
  info: "#2563EB",
  infoSoft: "rgba(37, 99, 235, 0.12)",

  // 数据可视化色板（8 类，chart-1 品牌红领衔）
  chart1: "#C00F28",
  chart2: "#2563EB",
  chart3: "#16A34A",
  chart4: "#D97706",
  chart5: "#7C3AED",
  chart6: "#0891B2",
  chart7: "#DB2777",
  chart8: "#71717A",

  // z-index 阶梯（统一到 tokens.css：dropdown 300 / modal 400 / toast 500 / lightbox 600）
  zDropdown: 300,
  zModal: 400,
  zToast: 500,
  zLightbox: 600,
} as const;

export type ThemeTokens = typeof tokens;

export const semantic: Record<"success" | "danger" | "warning", string> = {
  success: tokens.success,
  danger: tokens.danger,
  warning: tokens.warning,
};

export { BP as breakpoints } from "./breakpoints";
export type { Breakpoint } from "./breakpoints";
