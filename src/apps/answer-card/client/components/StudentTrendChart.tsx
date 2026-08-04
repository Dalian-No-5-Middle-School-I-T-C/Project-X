import { useEffect, useState } from "react";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler,
  type ChartDataset,
  type ChartOptions,
} from "chart.js";
import { fetchJson } from "../auth/api";
import type { StudentTrendPoint } from "../../../../shared/types";
import { LineChart, RefreshCw } from "lucide-react";
import {
  Button,
  Chart,
  ToggleGroup,
  ToggleGroupItem,
  paletteColor,
  withAlpha,
} from "./ui/v2";

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend, Filler);

/**
 * 学科 → 数据色板序号（`--px-chart-N` / `tokens.chartN`，1..8）。
 * chart-1 品牌红按 DESIGN-SYSTEM §3.2 保留给「当前主体」，学科系列从 2 起取。
 */
const SUBJECT_CHART_INDEX: Record<string, number> = {
  "语文": 2, "数学": 3, "英语": 4,
  "物理": 5, "化学": 6, "生物": 7,
  "历史": 8, "地理": 2, "政治": 5,
};
/** 未登记学科兜底 = chart-8 中性灰 */
const FALLBACK_CHART_INDEX = 8;

/** 学科色只经由色板序号解析，组件内不出现任何十六进制（铁律 §4） */
function subjectColor(subject: string): string {
  return paletteColor((SUBJECT_CHART_INDEX[subject] ?? FALLBACK_CHART_INDEX) - 1);
}

/** 结构性配置；颜色/网格/字体由 v2 Chart 适配器按当前主题注入 */
const CHART_OPTIONS: ChartOptions<"line"> = {
  interaction: { mode: "index", intersect: false },
  plugins: {
    legend: { display: true, position: "top" },
  },
  scales: {
    y: { beginAtZero: false, title: { display: true, text: "分数" } },
    x: { ticks: { maxRotation: 30 } },
  },
};

const TOGGLE_ITEM_CLASS = [
  "inline-flex h-7 shrink-0 items-center justify-center rounded-sm px-2.5 whitespace-nowrap",
  "border-0 bg-transparent text-xs font-medium text-muted-foreground",
  "transition-[background-color,color,box-shadow] duration-(--px-dur-1) ease-standard",
  "hover:text-foreground outline-none focus-visible:shadow-focus",
  "data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-1",
].join(" ");

interface Props {
  /** 从父组件传入的已有数据（可选，避免重复请求） */
  trends?: StudentTrendPoint[];
  onLoad?: (trends: StudentTrendPoint[]) => void;
  compact?: boolean;
}

export function StudentTrendChart({ trends: propTrends, onLoad, compact = false }: Props) {
  const [trends, setTrends] = useState<StudentTrendPoint[]>(propTrends ?? []);
  const [loading, setLoading] = useState(!propTrends);
  const [selectedSubjects, setSelectedSubjects] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");

  const subjects = [...new Set(trends.map((t) => t.subject).filter(Boolean))].sort();

  useEffect(() => {
    if (propTrends) {
      setTrends(propTrends);
      setLoading(false);
      return;
    }
    loadTrends();
  }, [propTrends]);

  useEffect(() => {
    if (trends.length > 0 && selectedSubjects.size === 0) {
      setSelectedSubjects(new Set(subjects.slice(0, 3)));
    }
  }, [trends]);

  async function loadTrends() {
    setLoading(true);
    setError("");
    try {
      const data = await fetchJson<StudentTrendPoint[]>("/api/scores/me/trends");
      setTrends(data);
      onLoad?.(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载趋势数据失败");
    } finally {
      setLoading(false);
    }
  }

  // Build datasets — align data to shared labels array
  // Get all unique exam names sorted chronologically (they're already ASC from API)
  const allExams = trends.filter((t) => selectedSubjects.has(t.subject));
  const allLabels = [...new Set(allExams.map((t) => t.examName))];
  const datasets: ChartDataset<"line">[] = [];

  for (const subject of selectedSubjects) {
    const subjectTrends = trends.filter((t) => t.subject === subject);
    const color = subjectColor(subject);

    // Map each subject's data to the shared labels array
    const subjectMap = new Map(subjectTrends.map((t) => [t.examName, t]));
    const alignedScores = allLabels.map((name) => subjectMap.get(name)?.totalScore ?? null);
    datasets.push({
      label: subject,
      data: alignedScores,
      borderColor: color,
      backgroundColor: withAlpha(color, 0.13),
      pointBackgroundColor: color,
      pointRadius: 4,
      pointHoverRadius: 6,
      tension: 0.3,
      fill: false,
      spanGaps: true,
    });
  }

  const chartData = {
    labels: allLabels,
    datasets,
  };

  if (loading) return <div className="flex h-full min-h-20 items-center justify-center text-sm text-muted-foreground">加载中...</div>;
  if (error) return <div className="flex items-center justify-center p-4 text-sm text-destructive-fg">{error}</div>;
  if (trends.length === 0) return <div className="flex h-full min-h-20 items-center justify-center text-sm text-muted-foreground">暂无成绩趋势数据。</div>;

  return (
    <div className={compact ? "flex h-full flex-col" : "rounded-lg border border-border-subtle bg-card p-5"}>
      {!compact && (
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="inline-flex items-center gap-2 text-base font-semibold text-foreground">
            <LineChart className="size-4" /> 成绩趋势
          </div>
          <Button
            variant="ghost"
            size="sm"
            type="button"
            onClick={() => void loadTrends()}
            disabled={loading}
            loading={loading}
            icon={<RefreshCw className="size-4" />}
          >
            刷新
          </Button>
        </div>
      )}

      {!compact && subjects.length > 0 && (
        <ToggleGroup
          type="multiple"
          value={[...selectedSubjects]}
          onValueChange={(next: string[]) => setSelectedSubjects(new Set(next))}
          aria-label="学科筛选"
          className="mb-3 inline-flex flex-wrap items-center gap-0.5 self-start rounded-md bg-secondary p-0.5"
        >
          {subjects.map((s) => (
            <ToggleGroupItem key={s} value={s} className={TOGGLE_ITEM_CLASS}>
              {s}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      )}

      {/* Chart */}
      <Chart
        type="line"
        data={chartData}
        options={CHART_OPTIONS}
        height={compact ? 88 : 288}
        ariaLabel="个人成绩趋势折线图"
      />
    </div>
  );
}
