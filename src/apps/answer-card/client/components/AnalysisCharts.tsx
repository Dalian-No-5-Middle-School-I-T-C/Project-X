/**
 * Reusable chart components for the analysis dashboard.
 * Uses chart.js + react-chartjs-2 (already in project deps).
 */
import {
  Chart as ChartJS,
  ArcElement, Tooltip, Legend,
  CategoryScale, LinearScale, BarElement,
  PointElement, LineElement, Filler,
} from "chart.js";
import { Doughnut, Bar, Line } from "react-chartjs-2";

ChartJS.register(ArcElement, Tooltip, Legend, CategoryScale, LinearScale, BarElement, PointElement, LineElement, Filler);

const BRAND_COLORS = ["#C00F28", "#E8354A", "#FF6B7A", "#FFB3BC", "#FDE8EC"];
const CHART_COLORS = ["#C00F28", "#3B82F6", "#10B981", "#F59E0B", "#8B5CF6", "#EC4899", "#6366F1", "#14B8A6"];

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
    datasets: data.datasets.map((ds, i) => ({
      label: ds.label,
      data: ds.data,
      borderColor: ds.color || CHART_COLORS[i % CHART_COLORS.length],
      backgroundColor: (ds.color || CHART_COLORS[i % CHART_COLORS.length]) + "15",
      borderWidth: 2,
      borderDash: ds.dashed ? [4, 3] : undefined,
      fill: true,
      tension: 0.4,
      pointRadius: 4,
      pointHoverRadius: 6,
    })),
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
