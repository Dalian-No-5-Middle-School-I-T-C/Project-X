/**
 * 成绩分析页的 chart.js 图表集合。
 *
 * 本文件只负责「业务数据 → chart.js 数据集」的翻译，
 * 颜色 / 网格 / 主题一律交给 v2 `Chart` 适配器（components/ui/v2/chart.tsx），
 * 调色板唯一来源是 `theme.ts` 的 `tokens.chart1-8`——此处零硬编码十六进制。
 *
 * 六个导出函数的签名保持不变，调用方（AnalysisOverview / ExamGroupDetailPage /
 * ScoreDetailPage）无需改动；#218 新增的 ClassRadar 已适配为 v2 `Chart`。
 */
import { Chart as ChartJS, RadialLinearScale } from "chart.js";
import { classifyBand, type ThresholdBand } from "../../../../shared/stats";
import { tokens } from "../theme";
import { Chart, paletteColor, rampPalette, useChartTheme, withAlpha } from "./ui/v2";

// v2 适配器只注册了折线/柱/环所需元素，radar（#218 ClassRadar）需补注册 RadialLinearScale
ChartJS.register(RadialLinearScale);

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
    /** null = 缺考断点（chart.js 断线显示，不误作 0 分） */
    data: Array<number | null>;
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

/**
 * 各班分数段 100% 堆叠图：x=班级，每班一列、各分数段占比归一化堆叠。
 * 与 ClassDistributionBar（各段绝对人数分组柱）互补——突出班级分布形态差异（尖峰/偏态/两极）。
 */
export function ClassStackBar({
  labels,
  segments,
  matrix,
  height = 280,
}: {
  /** 班级名（x 轴类目） */
  labels: string[];
  /** 分数段标签（图例，按数组顺序自下而上堆叠） */
  segments: string[];
  /** matrix[segmentIndex][classIndex] = 人数 */
  matrix: number[][];
  height?: number;
}) {
  // 每班归一化到 100%，使各列等宽可比分布形态
  const byClass = labels.map((_, ci) => matrix.map((row) => row[ci] ?? 0));
  const pct = byClass.map((col) => {
    const sum = col.reduce((a, b) => a + b, 0);
    return sum > 0 ? col.map((v) => Math.round((v / sum) * 1000) / 10) : col.map(() => 0);
  });
  const colors = rampPalette(segments.length, undefined, 0.4, 1);

  const chartData = {
    labels,
    datasets: segments.map((seg, si) => ({
      label: seg,
      data: byClass.map((_, ci) => pct[ci][si]),
      backgroundColor: colors[si],
      stack: "s",
      borderRadius: 2,
    })),
  };

  return (
    <Chart
      type="bar"
      data={chartData}
      height={height}
      ariaLabel="各班分数段占比堆叠图"
      options={{
        scales: {
          x: { stacked: true, grid: { display: false } },
          y: { stacked: true, beginAtZero: true, max: 100, ticks: { precision: 0, callback: (v) => `${v}%` } },
        },
        plugins: { legend: { position: "bottom" } },
      }}
    />
  );
}

/**
 * Issue #175 / #263: 班级对比雷达图（多维度）。
 * 维度：平均分率 / 中位分率 / 及格率 / 优秀率 / 难度系数 / 区分度 / 离散度（标准差占满分比）。
 *
 * Issue #263 修复：七个维度的天然量纲差异极大（及格率 0-100、区分度 ~0.1-0.4、离散度 ~10-20%），
 * 此前共用一根固定 0-100 半径轴 → 区分度/离散度被压缩到圆心附近、及格/优秀率挤在边缘无法比较。
 * 现对每个维度按「本班集合内的最小/最大值」独立归一化到 0-100，让每根轴都用满半径、班级间差异可读；
 * 某维度各班数值全相等（无区分度）时取中性中点 50，避免整条轴塌陷到圆心。真实数值通过悬浮 tooltip 展示。
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
  const theme = useChartTheme();
  if (!(fullScore > 0)) {
    return <p className="py-5 text-center text-sm text-muted-foreground">满分未知，无法计算班级多维度雷达图</p>;
  }
  const score = (value: number) => (value / fullScore) * 100;
  // raw = 该维度的真实数值（tooltip 展示）；fmt = 真实数值的可读串
  const dims: Array<{ label: string; raw: (c: (typeof classes)[number]) => number; fmt: (v: number) => string }> = [
    { label: "平均分率", raw: (c) => score(c.avgScore), fmt: (v) => `${v.toFixed(1)}%` },
    { label: "中位分率", raw: (c) => score(c.median), fmt: (v) => `${v.toFixed(1)}%` },
    { label: "及格率", raw: (c) => c.passRate, fmt: (v) => `${v.toFixed(0)}%` },
    { label: "优秀率", raw: (c) => c.excellentRate, fmt: (v) => `${v.toFixed(0)}%` },
    { label: "难度系数", raw: (c) => c.difficulty, fmt: (v) => v.toFixed(3) },
    { label: "区分度", raw: (c) => c.discrimination, fmt: (v) => v.toFixed(3) },
    { label: "离散度", raw: (c) => score(c.stdDev), fmt: (v) => `${v.toFixed(1)}%` },
  ];
  // 每维度独立求 [min,max] 后归一化到 0-100（数据驱动，充分利用半径）
  const perDimRaw = dims.map((d) => classes.map((c) => d.raw(c)));
  const norm = (dimIndex: number, classIndex: number): number => {
    const list = perDimRaw[dimIndex];
    const min = Math.min(...list);
    const max = Math.max(...list);
    if (max - min < 1e-9) return 50; // 各班相同 → 中性中点，不塌陷
    return ((list[classIndex] - min) / (max - min)) * 100;
  };

  const chartData = {
    labels: dims.map((d) => d.label),
    datasets: classes.map((cls, ci) => {
      const color = paletteColor(ci);
      return {
        label: cls.className,
        data: dims.map((_, di) => Math.round(norm(di, ci) * 10) / 10),
        backgroundColor: withAlpha(color, 0.15),
        borderColor: color,
        borderWidth: 2,
        pointBackgroundColor: color,
        pointRadius: 3,
      };
    }),
  };

  return (
    <Chart
      type="radar"
      data={chartData}
      height={height}
      ariaLabel="班级多维度对比雷达图"
      options={{
        scales: {
          r: {
            min: 0,
            max: 100,
            ticks: { display: false },
            pointLabels: { font: { size: 11, weight: "bold" as const } },
            grid: { color: theme.grid },
            angleLines: { color: theme.axis },
          },
        },
        plugins: {
          legend: { position: "bottom" as const },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const cls = classes[ctx.datasetIndex];
                const dim = dims[ctx.dataIndex];
                if (cls == null || dim == null) return "";
                return `${cls.className}：${dim.fmt(dim.raw(cls))}`;
              },
            },
          },
        },
      }}
    />
  );
}

/**
 * 建议 10：班级知识点掌握雷达图。
 * 轴 = 知识点，系列 = 班级，值为各班得分率（0-100，null 按 0 处理并由调用方提示覆盖率）。
 */
/**
 * 难度-区分度散点（P-D 诊断四象限）。
 * 横轴难度 P（0-1，越左越难），纵轴区分度 D；
 * 点色 = 区分度档位（classifyBand），「高难度(高分组难) + 低区分度」标记为疑题（第二系列描边高亮）。
 */
export function PDScatter({
  points,
  discBands,
  height = 280,
}: {
  /** 逐题 P/D 与题号信息 */
  points: Array<{ questionNumber: string; x: number; y: number; scoreRate: number | null }>;
  discBands?: ThresholdBand[];
  height?: number;
}) {
  const theme = useChartTheme();
  const colorOf = (d: number) =>
    discBands && discBands.length > 0
      ? classifyBand(d, discBands).color
      : paletteColor(Math.max(0, Math.min(5, Math.floor(d * 10))));
  // 疑题：难度 P < 0.5（偏难）且区分度 D < 0.3（区分能力弱）
  const suspect = (p: { x: number; y: number }) => p.x < 0.5 && p.y < 0.3;
  const normal = points.filter((p) => !suspect(p));
  const flagged = points.filter((p) => suspect(p));

  const chartData = {
    datasets: [
      {
        label: "题目",
        type: "scatter" as const,
        data: normal.map((p) => ({ x: p.x, y: p.y, questionNumber: p.questionNumber, scoreRate: p.scoreRate })),
        backgroundColor: normal.map((p) => colorOf(p.y)),
        borderColor: theme.axis,
        borderWidth: 1,
        pointRadius: 5,
        pointHoverRadius: 7,
      },
      {
        label: "疑题（高难度+低区分度）",
        type: "scatter" as const,
        data: flagged.map((p) => ({ x: p.x, y: p.y, questionNumber: p.questionNumber, scoreRate: p.scoreRate })),
        backgroundColor: flagged.map((p) => colorOf(p.y)),
        borderColor: tokens.danger,
        borderWidth: 2,
        pointRadius: 7,
        pointHoverRadius: 9,
      },
    ],
  };

  return (
    <Chart
      type="scatter"
      data={chartData}
      height={height}
      ariaLabel="难度-区分度散点图"
      options={{
        scales: {
          x: {
            min: 0,
            max: 1,
            title: { display: true, text: "难度系数 P" },
          },
          y: {
            min: -0.2,
            max: 1,
            title: { display: true, text: "区分度 D" },
          },
        },
        plugins: {
          legend: { position: "bottom" },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const q = ctx.raw as { questionNumber: string; x: number; y: number; scoreRate: number | null };
                return `题 ${q.questionNumber}：难度 ${q.x.toFixed(3)}，区分度 ${q.y.toFixed(3)}${q.scoreRate != null ? `，得分率 ${q.scoreRate}%` : ""}`;
              },
            },
          },
        },
      }}
    />
  );
}

export function KnowledgeRadar({
  points,
  classes,
  matrix,
  height = 320,
}: {
  /** 知识点轴 */
  points: string[];
  classes: Array<{ classId: number; className: string }>;
  /** 每个知识点的各班得分率（按 classId 匹配） */
  matrix: Array<{ byClass: Array<{ classId: number; scoreRate: number | null }> }>;
  height?: number;
}) {
  const theme = useChartTheme();
  const chartData = {
    labels: points,
    datasets: classes.map((cls, ci) => {
      const color = paletteColor(ci);
      return {
        label: cls.className,
        data: points.map((_, pi) => {
          const rate = matrix[pi]?.byClass.find((b) => b.classId === cls.classId)?.scoreRate;
          return rate != null ? Math.round(rate * 10) / 10 : 0;
        }),
        backgroundColor: withAlpha(color, 0.15),
        borderColor: color,
        borderWidth: 2,
        pointBackgroundColor: color,
        pointRadius: 3,
      };
    }),
  };

  return (
    <Chart
      type="radar"
      data={chartData}
      height={height}
      ariaLabel="班级知识点掌握雷达图"
      options={{
        scales: {
          r: {
            min: 0,
            max: 100,
            ticks: { stepSize: 20, font: { size: 10 }, backdropColor: "transparent" },
            pointLabels: { font: { size: 11, weight: "bold" as const } },
            grid: { color: theme.grid },
            angleLines: { color: theme.axis },
          },
        },
        plugins: { legend: { position: "bottom" as const } },
      }}
    />
  );
}
