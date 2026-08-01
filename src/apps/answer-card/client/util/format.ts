/**
 * 成绩分析共享格式化工具（消除散布在多个组件中的重复 formatScore 定义）。
 */

/** 整数显示原值、小数保留 1 位 */
export function formatScore(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** 百分比：整数显示原值、小数保留 1 位，加 % */
export function formatPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}

/** 变化量：正数加 ↑、负数加 ↓、零显示 — */
export function formatChange(value: number | null | undefined, unit = ""): string {
  if (value == null || !Number.isFinite(value) || value === 0) return "—";
  const sign = value > 0 ? "↑" : "↓";
  const abs = Number.isInteger(value) ? Math.abs(value) : Math.abs(value).toFixed(1);
  return `${sign}${abs}${unit}`;
}