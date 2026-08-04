import { useEffect, useState } from "react";
import {
  Chart as ChartJS,
  RadialLinearScale,
  PointElement,
  LineElement,
  Filler,
  Tooltip,
  Legend,
  type ChartData,
  type ChartOptions,
} from "chart.js";
import { fetchJson } from "../auth/api";
import type { SubjectWeaknessItem } from "../../../../shared/types";
import { Radar as RadarIcon, RefreshCw, AlertTriangle, TrendingUp, TrendingDown } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Chart,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  paletteColor,
  useChartTheme,
  withAlpha,
} from "./ui/v2";

// v2 Chart 适配器只注册了直角坐标系元素，雷达图额外需要径向刻度
ChartJS.register(RadialLinearScale, PointElement, LineElement, Filler, Tooltip, Legend);

interface SubjectComparisonResponse {
  subjects: SubjectWeaknessItem[];
  weakSubject: string | null;
  totalExams: number;
}

export function StudentSubjectRadar() {
  const [data, setData] = useState<SubjectComparisonResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const theme = useChartTheme();

  async function loadData() {
    setLoading(true);
    setError("");
    try {
      const result = await fetchJson<SubjectComparisonResponse>("/api/scores/me/subject-comparison");
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载学科对比数据失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void loadData(); }, []);

  if (loading) return <div className="flex min-h-24 items-center justify-center text-sm text-muted-foreground">加载中...</div>;
  if (error) return <div className="flex items-center justify-center p-4 text-sm text-destructive-fg">{error}</div>;
  if (!data || data.subjects.length === 0) return <div className="flex min-h-24 items-center justify-center text-sm text-muted-foreground">暂无学科数据。</div>;

  const { subjects, weakSubject, totalExams } = data;
  const labels = subjects.map((s) => s.subject);
  const myScores = subjects.map((s) => Math.max(s.avgScore, 0));
  // 仅绘制学生本人的学科成绩，学生端不展示班级比较数据。
  const maxVal = Math.max(...myScores, 100);

  // chart-1 = 品牌红「当前主体」（DESIGN-SYSTEM §3.2），色值来自 theme.ts 令牌镜像
  const seriesColor = paletteColor(0);

  const chartData: ChartData<"radar"> = {
    labels,
    datasets: [
      {
        label: "我的平均分",
        data: myScores,
        backgroundColor: withAlpha(seriesColor, 0.12),
        borderColor: seriesColor,
        borderWidth: 2,
        pointBackgroundColor: seriesColor,
        pointRadius: 4,
      },
    ],
  };

  const chartOptions: ChartOptions<"radar"> = {
    scales: {
      r: {
        beginAtZero: true,
        max: Math.ceil(maxVal / 10) * 10,
        ticks: { stepSize: 10, font: { size: 10 }, backdropColor: "transparent", color: theme.tick },
        pointLabels: { font: { size: 12, weight: "bold" }, color: theme.foreground },
        grid: { color: theme.grid },
        angleLines: { color: theme.grid },
      },
    },
    plugins: {
      legend: { position: "bottom" },
    },
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle><span className="inline-flex items-center gap-2"><RadarIcon size={17} /> 学科雷达</span></CardTitle>
        <Button
          variant="ghost"
          size="sm"
          type="button"
          onClick={() => void loadData()}
          disabled={loading}
          loading={loading}
          icon={<RefreshCw className="size-4" />}
        >
          刷新
        </Button>
      </CardHeader>
      <CardContent>
      <div className="mb-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>基于 {totalExams} 场考试 · {subjects.length} 个学科</span>
        {weakSubject && (
          <Badge tone="danger" icon={<AlertTriangle />}>
            薄弱学科：{weakSubject}
          </Badge>
        )}
      </div>

      <Chart
        type="radar"
        data={chartData}
        options={chartOptions}
        height={256}
        ariaLabel="本人各学科平均分雷达图"
      />

      {/* Subject detail table */}
      <Table>
        <TableHeader><TableRow><TableHead>学科</TableHead><TableHead numeric>考试次数</TableHead><TableHead numeric>平均分</TableHead><TableHead>趋势</TableHead></TableRow></TableHeader>
        <TableBody>{subjects.map((s) => <TableRow key={s.subject} selected={s.subject === weakSubject}><TableCell>{s.subject}</TableCell><TableCell numeric>{s.examCount}</TableCell><TableCell numeric>{s.avgScore}</TableCell><TableCell>{s.trend === "up" ? <TrendingUp size={14} className="text-success-foreground" /> : s.trend === "down" ? <TrendingDown size={14} className="text-destructive-fg" /> : "—"}</TableCell></TableRow>)}</TableBody>
      </Table>
      </CardContent>
    </Card>
  );
}
