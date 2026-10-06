/**
 * 客观题模式的统一口径（R46）。
 *
 * 规范拼写是 `indefinite`（见 `shared/types.ts` 的 `ObjectiveMode`），但仓库里历史上出现过
 * `indeterminate`：命名映射、多选判定都写过这个拼写，于是**合法的不定项题**在这些分支里
 * 一律走不到——标题落到兜底名、答案编辑把多选渲染成单选。类型是 `string` 的地方
 * （分析面板 DTO）TypeScript 也拦不住这种拼写错误。
 *
 * 这里把「哪些模式算多选」和「模式怎么显示」收成一个出口：
 * 判定同时接受旧拼写，保证历史卡数据不被误判成单选；新代码只写 `indefinite`。
 */
import type { ObjectiveMode } from "./types";

export const INDEFINITE_MODE = "indefinite" satisfies ObjectiveMode;

/** 兼容别名：只用于**读取**历史数据，不再作为写入值。 */
const LEGACY_INDEFINITE_ALIASES = ["indeterminate"];

const MULTI_MODES = new Set<string>(["multiple", INDEFINITE_MODE, ...LEGACY_INDEFINITE_ALIASES]);

/** 该模式是否允许多个正确选项（含不定项）。 */
export function isMultiSelectMode(mode: string | null | undefined): boolean {
  return typeof mode === "string" && MULTI_MODES.has(mode);
}

/** 题块/题目模式的中文名称。 */
export function objectiveModeLabel(mode: string | null | undefined): string {
  if (mode === "single") return "单选";
  if (mode === "multiple") return "多选";
  if (isMultiSelectMode(mode)) return "不定项";
  return "单选";
}
