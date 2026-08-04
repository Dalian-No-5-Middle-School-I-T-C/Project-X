/**
 * Reusable chart components for the analysis dashboard.
 * Uses chart.js + react-chartjs-2 (already in project deps).
 */
import {
  Chart as ChartJS,
  ArcElement, Tooltip, Legend,
  CategoryScale, LinearScale, BarElement,
  PointElement, LineElement, Filler, RadialLinearScale,
} from "chart.js";
import { Doughnut, Bar, Line, Radar } from "react-chartjs-2";

ChartJS.register(ArcElement, Tooltip, Legend, CategoryScale, LinearScale, BarElement, PointElement, LineElement, Filler, RadialLinearScale);

const BRAND_COLORS = ["#C00F28", "#E8354A", "#FF6B7A", "#FFB3BC", "#FDE8EC"];
const CHART_COLORS = ["#C00F28", "#3B82F6", "#10B981", "#F59E0B", "#8B5CF6", "#EC4899", "#6366F1", "#14B8A6"];
const DISTRIBUTION_GRADIENT = ["#E8354A", "#C00F28", "#9E0B20", "#7A0818", "#5A0612"];

/** Chart.js uses Canvas API — resolve CSS variables to actual values */
function resolveColor(input: string): string {
  if (input.startsWith("var(") && typeof document !== "undefined") {
    const varName = input.slice(4, -1).trim();
    const value = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
    return value || "#C00F28";
  }
  return input;
}

/** Append alpha to a hex color (e.g. "#C00F28" + "20" → "#C00F2820") */
function withAlpha(color: string, alpha: string): string {
  const resolved = resolveColor(color);
  if (resolved.startsWith("#") && resolved.length === 7) return resolved + alpha;
  return resolved; // can't add alpha to named/rgb colors safely, just return solid
}

const CHART_BASE = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: { legend: { labels: { boxWidth: 12, padding: 12, font: { size: 11 } } } },
};

// ── Pie / Doughnut (score distribution) ─────────────────

interface DistributionData {
  labels: string[];
  values: number[];
}

export function ScoreDoughnut({ data, height = 220 }: { data: DistributionData; height?: number }) {
  const chartData = {
    labels: data.labels,
    datasets: [{ data: data.values, backgroundColor: BRAND_COLORS, borderWidth: 0 }],
  };
  return (
    <div style={{ height }}>
      <Doughnut data={chartData} options={{ ...CHART_BASE, cutout: "60%" } as any} />
    </div>
  );
}

// ── Bar chart (class comparison / subject scores) ────────

interface BarData {
  labels: string[];
  datasets: Array<{ label: string; data: number[]; color?: string }>;
}

export function ComparisonBar({ data, height = 250, horizontal = false }: { data: BarData; height?: number; horizontal?: boolean }) {
  const chartData = {
    labels: data.labels,
    datasets: data.datasets.map((ds, i) => ({
      label: ds.label,
      data: ds.data,
      backgroundColor: ds.color || CHART_COLORS[i % CHART_COLORS.length],
      borderRadius: 6,
      barPercentage: 0.7,
    })),
  };
  return (
    <div style={{ height }}>
      <Bar
        data={chartData}
        options={{
          ...CHART_BASE,
          indexAxis: horizontal ? ("y" as const) : ("x" as const),
          scales: {
            [horizontal ? "x" : "y"]: { beginAtZero: true, grid: { color: "rgba(0,0,0,0.04)" } },
            [horizontal ? "y" : "x"]: { grid: { display: false } },
          },
        } as any}
      />
    </div>
  );
}

// ── Line chart (score trends / rank trends) ──────────────

interface TrendData {
  labels: string[];
  datasets: Array<{ label: string; data: number[]; color?: string; dashed?: boolean }>;
}

export function TrendLine({ data, height = 220, reverseY = false }: { data: TrendData; height?: number; reverseY?: boolean }) {
  const chartData = {
    labels: data.labels,
    datasets: data.datasets.map((ds, i) => {
      const c = resolveColor(ds.color || CHART_COLORS[i % CHART_COLORS.length]);
      return {
        label: ds.label,
        data: ds.data,
        borderColor: c,
        backgroundColor: withAlpha(c, "15"),
        borderWidth: 2,
        borderDash: ds.dashed ? [4, 3] : undefined,
        fill: true,
        tension: 0.4,
        pointRadius: 4,
        pointHoverRadius: 6,
      };
    }),
  };
  return (
    <div style={{ height }}>
      <Line
        data={chartData}
        options={{
          ...CHART_BASE,
          interaction: { mode: "index" as const, intersect: false },
          scales: {
            y: {
              beginAtZero: !reverseY,
              reverse: reverseY,
              grid: { color: "rgba(0,0,0,0.04)" },
            },
            x: { grid: { display: false } },
          },
        } as any}
      />
    </div>
  );
}

// ── Distribution bar chart (score range histogram) ───────

interface HistogramData {
  labels: string[];
  values: number[];
}

/**
 * 分数段柱状图（单班）。柱色按分数高低渐变（低分段深红 → 高分段红）。
 * 用于替换原分析页 CSS 分布条 + 重复展示的环形图。
 */
export function DistributionBar({ data, height = 240 }: { data: HistogramData; height?: number }) {
  const chartData = {
    labels: data.labels,
    datasets: [{
      data: data.values,
      backgroundColor: data.labels.map((_, i) =>
        DISTRIBUTION_GRADIENT[Math.min(Math.floor(i * DISTRIBUTION_GRADIENT.length / Math.max(1, data.labels.length)), DISTRIBUTION_GRADIENT.length - 1)]
      ),
      borderRadius: 6,
      barPercentage: 0.85,
    }],
  };
  return (
    <div style={{ height }}>
      <Bar
        data={chartData}
        options={{
          ...CHART_BASE,
          plugins: { ...CHART_BASE.plugins, legend: { display: false } },
          scales: {
            y: { beginAtZero: true, grid: { color: "rgba(0,0,0,0.04)" }, ticks: { precision: 0 } },
            x: { grid: { display: false } },
          },
        } as any}
      />
    </div>
  );
}

/**
 * 多班对比分段柱状图（分组）。每个分段一组柱，每班一根。
 * className 列表决定图例顺序；class 排名为 [分段][班级] 的二维数组。
 */
export function ClassDistributionBar({
  labels, classes, matrix, height = 280,
}: {
  labels: string[];
  classes: Array<{ className: string }>;
  /** matrix[groupIndex][classIndex] = 人数 */
  matrix: number[][];
  height?: number;
}) {
  const chartData = {
    labels,
    datasets: classes.map((cls, ci) => ({
      label: cls.className,
      data: matrix.map((row) => row[ci] ?? 0),
      backgroundColor: CHART_COLORS[ci % CHART_COLORS.length],
      borderRadius: 4,
      barPercentage: 0.8,
    })),
  };
  return (
    <div style={{ height }}>
      <Bar
        data={chartData}
        options={{
          ...CHART_BASE,
          scales: {
            y: { beginAtZero: true, grid: { color: "rgba(0,0,0,0.04)" }, ticks: { precision: 0 } },
            x: { grid: { display: false } },
          },
        } as any}
      />
    </div>
  );
}

/**
 * Issue #175: 班级对比雷达图（多维度）。
 * 维度：平均分率 / 中位分率 / 及格率 / 优秀率 / 难度系数 / 区分度 / 离散度（标准差占满分比）。
 * 除离散度外均为“越高越好”口径，便于直观比较。
 */
export function ClassRadar({
  classes,
  fullScore,
  height = 320,
}: {
  classes: Array<{
    className: string;
    avgScore: number;
    median: number;
    stdDev: number;
    passRate: number;
    excellentRate: number;
    difficulty: number;
    discrimination: number;
  }>;
  fullScore: number;
  height?: number;
}) {
  const score = (value: number) => (fullScore > 0 ? (value / fullScore) * 100 : 0);
  const dims = [
    { label: "平均分率", get: (c: (typeof classes)[number]) => score(c.avgScore) },
    { label: "中位分率", get: (c: (typeof classes)[number]) => score(c.median) },
    { label: "及格率", get: (c: (typeof classes)[number]) => c.passRate },
    { label: "优秀率", get: (c: (typeof classes)[number]) => c.excellentRate },
    { label: "难度系数", get: (c: (typeof classes)[number]) => Math.max(0, Math.min(100, c.difficulty * 100)) },
    { label: "区分度", get: (c: (typeof classes)[number]) => Math.max(0, Math.min(100, c.discrimination * 100)) },
    { label: "离散度", get: (c: (typeof classes)[number]) => Math.max(0, Math.min(100, score(c.stdDev))) },
  ];

  const chartData = {
    labels: dims.map((d) => d.label),
    datasets: classes.map((cls, ci) => {
      const color = resolveColor(CHART_COLORS[ci % CHART_COLORS.length]);
      return {
        label: cls.className,
        data: dims.map((d) => Math.round(d.get(cls) * 10) / 10),
        backgroundColor: withAlpha(color, "18"),
        borderColor: color,
        borderWidth: 2,
        pointBackgroundColor: color,
        pointRadius: 3,
      };
    }),
  };

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    scales: {
      r: {
        min: 0,
        max: 100,
        ticks: { stepSize: 20, font: { size: 10 }, backdropColor: "transparent" },
        pointLabels: { font: { size: 11, weight: "bold" as const } },
        grid: { color: "rgba(0,0,0,0.06)" },
        angleLines: { color: "rgba(0,0,0,0.08)" },
      },
    },
    plugins: {
      legend: { position: "bottom" as const, labels: { boxWidth: 12, padding: 12, font: { size: 11 } } },
    },
  };

  return (
    <div style={{ height }}>
      <Radar data={chartData} options={chartOptions} />
    </div>
  );
}
