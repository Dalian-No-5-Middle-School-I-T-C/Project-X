/**
 * 成绩分析页的 chart.js 图表集合。
 *
 * 本文件只负责「业务数据 → chart.js 数据集」的翻译，
 * 颜色 / 网格 / 主题一律交给 v2 `Chart` 适配器（components/ui/v2/chart.tsx），
 * 调色板唯一来源是 `theme.ts` 的 `tokens.chart1-8`——此处零硬编码十六进制。
 *
 * 五个导出函数的签名保持不变，调用方（AnalysisOverview / ExamGroupDetailPage /
 * ScoreDetailPage）无需改动。
 */
import { Chart, paletteColor, rampPalette, withAlpha } from "./ui/v2";

// ── 环形图（分数段占比）────────────────────────────────

interface DistributionData {
  labels: string[];
  values: number[];
}

/** 分数段占比环形图。分段用品牌红顺序色阶，强→弱表达段位。 */
export function ScoreDoughnut({
  data,
  height = 220,
}: {
  data: DistributionData;
  height?: number;
}) {
  const chartData = {
    labels: data.labels,
    datasets: [
      {
        data: data.values,
        backgroundColor: rampPalette(data.labels.length),
        borderWidth: 0,
      },
    ],
  };

  return (
    <Chart
      type="doughnut"
      data={chartData}
      height={height}
      ariaLabel="分数段占比环形图"
      options={{ cutout: "60%" }}
    />
  );
}

// ── 柱状图（班级 / 科目对比）────────────────────────────

interface BarData {
  labels: string[];
  datasets: Array<{ label: string; data: number[]; color?: string }>;
}

/** 多系列对比柱状图，支持横向（horizontal）排布。 */
export function ComparisonBar({
  data,
  height = 250,
  horizontal = false,
}: {
  data: BarData;
  height?: number;
  horizontal?: boolean;
}) {
  const chartData = {
    labels: data.labels,
    datasets: data.datasets.map((ds, index) => ({
      label: ds.label,
      data: ds.data,
      backgroundColor: ds.color || paletteColor(index),
      borderRadius: 6,
      barPercentage: 0.7,
    })),
  };

  // 横向柱状图的「数值轴」是 x，「类目轴」是 y，网格显示需要对调
  const valueAxis = horizontal ? "x" : "y";
  const categoryAxis = horizontal ? "y" : "x";

  return (
    <Chart
      type="bar"
      data={chartData}
      height={height}
      ariaLabel="对比柱状图"
      options={{
        indexAxis: horizontal ? "y" : "x",
        scales: {
          [valueAxis]: { beginAtZero: true, grid: { display: true } },
          [categoryAxis]: { grid: { display: false } },
        },
      }}
    />
  );
}

// ── 折线图（成绩 / 排名趋势）────────────────────────────

interface TrendData {
  labels: string[];
  datasets: Array<{
    label: string;
    data: number[];
    color?: string;
    dashed?: boolean;
  }>;
}

/** 趋势折线图。reverseY 用于排名类指标（名次越小越好）。 */
export function TrendLine({
  data,
  height = 220,
  reverseY = false,
}: {
  data: TrendData;
  height?: number;
  reverseY?: boolean;
}) {
  const chartData = {
    labels: data.labels,
    datasets: data.datasets.map((ds, index) => {
      const color = ds.color || paletteColor(index);
      return {
        label: ds.label,
        data: ds.data,
        borderColor: color,
        backgroundColor: withAlpha(color, 0.08),
        borderWidth: 2,
        borderDash: ds.dashed ? [4, 3] : undefined,
        fill: true,
        tension: 0.4,
        pointRadius: 4,
        pointHoverRadius: 6,
        pointBackgroundColor: color,
      };
    }),
  };

  return (
    <Chart
      type="line"
      data={chartData}
      height={height}
      ariaLabel="趋势折线图"
      options={{
        interaction: { mode: "index", intersect: false },
        scales: {
          y: { beginAtZero: !reverseY, reverse: reverseY },
          x: { grid: { display: false } },
        },
      }}
    />
  );
}

// ── 分数段直方图（单班）──────────────────────────────

interface HistogramData {
  labels: string[];
  values: number[];
}

/**
 * 分数段柱状图（单班）。柱色按分数段由弱到强渐变，
 * 用于替换原分析页 CSS 分布条 + 重复展示的环形图。
 */
export function DistributionBar({
  data,
  height = 240,
}: {
  data: HistogramData;
  height?: number;
}) {
  const chartData = {
    labels: data.labels,
    datasets: [
      {
        data: data.values,
        // 低分段浅、高分段深：与 ScoreDoughnut 的强→弱方向相反
        backgroundColor: rampPalette(data.labels.length, undefined, 0.4, 1),
        borderRadius: 6,
        barPercentage: 0.85,
      },
    ],
  };

  return (
    <Chart
      type="bar"
      data={chartData}
      height={height}
      ariaLabel="分数段分布柱状图"
      options={{
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, ticks: { precision: 0 } },
          x: { grid: { display: false } },
        },
      }}
    />
  );
}

/**
 * 多班对比分段柱状图（分组）。每个分段一组柱，每班一根。
 * classes 列表决定图例顺序；matrix 为 [分段][班级] 的二维人数数组。
 */
export function ClassDistributionBar({
  labels,
  classes,
  matrix,
  height = 280,
}: {
  labels: string[];
  classes: Array<{ className: string }>;
  /** matrix[groupIndex][classIndex] = 人数 */
  matrix: number[][];
  height?: number;
}) {
  const chartData = {
    labels,
    datasets: classes.map((cls, classIndex) => ({
      label: cls.className,
      data: matrix.map((row) => row[classIndex] ?? 0),
      backgroundColor: paletteColor(classIndex),
      borderRadius: 4,
      barPercentage: 0.8,
    })),
  };

  return (
    <Chart
      type="bar"
      data={chartData}
      height={height}
      ariaLabel="多班分数段对比柱状图"
      options={{
        scales: {
          y: { beginAtZero: true, ticks: { precision: 0 } },
          x: { grid: { display: false } },
        },
      }}
    />
  );
}
