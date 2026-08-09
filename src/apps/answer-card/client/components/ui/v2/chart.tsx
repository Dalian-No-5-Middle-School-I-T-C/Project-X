import * as React from "react";
import {
  Chart as ChartJS,
  ArcElement,
  Tooltip,
  Legend,
  CategoryScale,
  LinearScale,
  BarElement,
  PointElement,
  LineElement,
  Filler,
  type ChartData,
  type ChartOptions,
  type ChartType,
} from "chart.js";
import { Chart as ReactChart } from "react-chartjs-2";
import { cn } from "../../../lib/utils";
import { tokens } from "../../../theme";

/**
 * Chart —— chart.js 主题适配器（DESIGN-SYSTEM §6「数据可视化」）
 *
 * 存在的唯一理由：chart.js 画在 <canvas> 上，拿不到 Tailwind 工具类，
 * 因此需要把「语义令牌」翻译成实际颜色值喂给 chart.js。
 *
 * 纪律：
 *  · 调色板唯一来源 = `theme.ts` 的 `tokens.chart1-8`（运行时优先读同名 CSS 变量以支持暗色主题，
 *    读不到时回落 tokens），业务组件**禁止**再写任何十六进制。
 *  · 网格 / 刻度 / 提示气泡颜色一律取自 `--px-*` 语义令牌，随 `data-theme` 切换自动重算。
 *  · 容器高度是画布约束（canvas 必须有确定高度），故允许 `style={{ minHeight }}`，
 *    这是铁律 §2 明确豁免的动态值场景。
 */

ChartJS.register(
  ArcElement,
  Tooltip,
  Legend,
  CategoryScale,
  LinearScale,
  BarElement,
  PointElement,
  LineElement,
  Filler,
);

/* ══════════════════════════════════════════════════════════════════
   调色板：单一来源 theme.ts tokens.chart1-8
   ══════════════════════════════════════════════════════════════════ */

/** 8 类数据系列色，序号与 `--px-chart-N` / `tokens.chartN` 一一对应 */
export const chartPalette: readonly string[] = [
  tokens.chart1,
  tokens.chart2,
  tokens.chart3,
  tokens.chart4,
  tokens.chart5,
  tokens.chart6,
  tokens.chart7,
  tokens.chart8,
] as const;

/** 取第 index 个系列色（自动环绕，支持负数） */
export function paletteColor(index: number): string {
  const size = chartPalette.length;
  return chartPalette[((index % size) + size) % size];
}

/**
 * 给颜色附加透明度。入参可以是 `#RRGGBB` / `rgb()` / `rgba()`，
 * 其它格式（CSS 变量、颜色名）原样返回，不做危险猜测。
 */
export function withAlpha(color: string, alpha: number): string {
  const a = Math.min(1, Math.max(0, alpha));
  const value = color.trim();

  const hex = /^#([0-9a-fA-F]{6})$/.exec(value);
  if (hex) {
    const int = parseInt(hex[1], 16);
    const r = (int >> 16) & 255;
    const g = (int >> 8) & 255;
    const b = int & 255;
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }

  const rgb = /^rgba?\(([^)]+)\)$/i.exec(value);
  if (rgb) {
    const parts = rgb[1].split(",").map((part) => part.trim());
    if (parts.length >= 3) {
      return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${a})`;
    }
  }

  return value;
}

/**
 * 单色顺序色阶（直方图 / 环形图的「同一指标不同分段」用）。
 * 通过同一基色的透明度渐变表达强弱，避免引入调色板之外的硬编码色。
 *
 * @param count 分段数
 * @param base  基色，默认品牌红 `tokens.chart1`
 * @param from  第 0 段的透明度
 * @param to    最后一段的透明度
 */
export function rampPalette(
  count: number,
  base: string = chartPalette[0],
  from = 1,
  to = 0.28,
): string[] {
  if (count <= 0) return [];
  if (count === 1) return [withAlpha(base, from)];
  const result: string[] = [];
  for (let i = 0; i < count; i += 1) {
    result.push(withAlpha(base, from + ((to - from) * i) / (count - 1)));
  }
  return result;
}

/* ══════════════════════════════════════════════════════════════════
   主题解析：语义令牌 → canvas 可用色值，随 data-theme 热更新
   ══════════════════════════════════════════════════════════════════ */

export interface ChartTheme {
  /** 数据系列色板（已按当前主题解析） */
  palette: readonly string[];
  /** 网格线 */
  grid: string;
  /** 坐标轴 / 边框 */
  axis: string;
  /** 刻度与图例文字 */
  tick: string;
  /** 主文字（提示气泡标题） */
  foreground: string;
  /** 提示气泡底色 */
  surface: string;
}

const FALLBACK_THEME: ChartTheme = {
  palette: chartPalette,
  grid: tokens.lineLight,
  axis: tokens.line,
  tick: tokens.muted,
  foreground: tokens.text,
  surface: tokens.surfaceRaised,
};

/** 读取 documentElement 上的 CSS 变量；SSR / 读不到时回落 */
function readCssVar(name: string, fallback: string): string {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return fallback;
  }
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value || fallback;
}

function resolveChartTheme(): ChartTheme {
  return {
    palette: chartPalette.map((fallback, index) =>
      readCssVar(`--px-chart-${index + 1}`, fallback),
    ),
    grid: readCssVar("--px-border-subtle", FALLBACK_THEME.grid),
    axis: readCssVar("--px-border-default", FALLBACK_THEME.axis),
    tick: readCssVar("--px-fg-tertiary", FALLBACK_THEME.tick),
    foreground: readCssVar("--px-fg-primary", FALLBACK_THEME.foreground),
    surface: readCssVar("--px-bg-raised", FALLBACK_THEME.surface),
  };
}

/**
 * 订阅当前主题下的图表配色。`data-theme` 切换时自动重算，
 * 让 canvas 图表跟着亮/暗模式走，而不需要业务侧关心。
 */
export function useChartTheme(): ChartTheme {
  const [theme, setTheme] = React.useState<ChartTheme>(FALLBACK_THEME);

  React.useEffect(() => {
    setTheme(resolveChartTheme());

    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => {
      setTheme(resolveChartTheme());
    });
    observer.observe(document.documentElement, {
      attributes: true,
      // v2.1.0: data-skin 为皮肤维度（风格，与明暗正交），未来新增皮肤时图表自动跟随
      attributeFilter: ["data-theme", "data-skin", "class", "style"],
    });
    return () => observer.disconnect();
  }, []);

  return theme;
}

/* ══════════════════════════════════════════════════════════════════
   选项装配
   ══════════════════════════════════════════════════════════════════ */

type UnknownRecord = Record<string, unknown>;

function isPlainObject(value: unknown): value is UnknownRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== null
  );
}

/** 深合并：调用方的 options 覆盖主题默认值，嵌套对象逐层合并而非整块替换 */
function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch as T;

  const result: UnknownRecord = { ...base };
  for (const key of Object.keys(patch)) {
    const next = patch[key];
    const prev = result[key];
    result[key] =
      isPlainObject(prev) && isPlainObject(next) ? deepMerge(prev, next) : next;
  }
  return result as T;
}

/** 无坐标轴的图表类型（不注入 scales 默认值） */
const RADIAL_TYPES: ReadonlySet<string> = new Set([
  "doughnut",
  "pie",
  "polarArea",
  "radar",
]);

/**
 * 主题化的 chart.js 基础选项。业务侧只需覆盖结构性配置
 * （indexAxis / beginAtZero / reverse / precision…），颜色不用管。
 */
export function chartBaseOptions(
  theme: ChartTheme,
  type: ChartType,
): ChartOptions<ChartType> {
  const base: UnknownRecord = {
    responsive: true,
    maintainAspectRatio: false,
    color: theme.tick,
    plugins: {
      legend: {
        labels: {
          boxWidth: 12,
          padding: 12,
          color: theme.tick,
          font: { size: 11 },
          usePointStyle: true,
          pointStyle: "circle",
        },
      },
      tooltip: {
        backgroundColor: theme.surface,
        titleColor: theme.foreground,
        bodyColor: theme.tick,
        borderColor: theme.grid,
        borderWidth: 1,
        padding: 10,
        cornerRadius: 8,
        boxPadding: 4,
        displayColors: true,
      },
    },
  };

  if (!RADIAL_TYPES.has(type)) {
    base.scales = {
      x: {
        grid: { display: false, color: theme.grid },
        border: { color: theme.axis },
        ticks: { color: theme.tick, font: { size: 11 } },
      },
      y: {
        grid: { color: theme.grid, drawTicks: false },
        border: { display: false },
        ticks: { color: theme.tick, font: { size: 11 } },
      },
    };
  }

  return base as ChartOptions<ChartType>;
}

/* ══════════════════════════════════════════════════════════════════
   Chart 组件
   ══════════════════════════════════════════════════════════════════ */

export interface ChartProps<TType extends ChartType = ChartType> {
  type: TType;
  data: ChartData<TType>;
  /** 结构性覆盖项；颜色相关默认值由适配器按主题注入 */
  options?: ChartOptions<TType>;
  /**
   * 画布最小高度（px）。canvas 需要确定高度才能绘制，
   * 容器同时 `flex-1`，在弹性父容器里可自然撑高。
   */
  height?: number;
  className?: string;
  /** 无障碍描述，缺省时由调用方在外层容器提供 */
  ariaLabel?: string;
}

export function Chart<TType extends ChartType = ChartType>({
  type,
  data,
  options,
  height = 240,
  className,
  ariaLabel,
}: ChartProps<TType>) {
  const theme = useChartTheme();

  const mergedOptions = React.useMemo(
    () =>
      deepMerge(
        chartBaseOptions(theme, type),
        options,
      ) as ChartOptions<ChartType>,
    [theme, type, options],
  );

  return (
    <div
      className={cn("relative w-full min-h-0 flex-1", className)}
      style={{ minHeight: height }}
      role="img"
      aria-label={ariaLabel}
    >
      <ReactChart
        type={type}
        data={data as ChartData<ChartType>}
        options={mergedOptions}
      />
    </div>
  );
}
