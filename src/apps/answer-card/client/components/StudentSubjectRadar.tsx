import { useEffect, useState } from "react";
import { Chart as ChartJS, RadialLinearScale, PointElement, LineElement, Filler, Tooltip, Legend } from "chart.js";
import { Radar } from "react-chartjs-2";
import { fetchJson } from "../auth/api";
import type { SubjectWeaknessItem, StudentTrendPoint } from "../../../../shared/types";
import { Radar as RadarIcon, RefreshCw, AlertTriangle, TrendingUp, TrendingDown } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/v2";

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

  const chartData = {
    labels,
    datasets: [
      {
        label: "我的平均分",
        data: myScores,
        backgroundColor: "rgba(192, 15, 40, 0.12)",
        borderColor: "#C00F28",
        borderWidth: 2,
        pointBackgroundColor: "#C00F28",
        pointRadius: 4,
      },
    ],
  };

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    scales: {
      r: {
        beginAtZero: true,
        max: Math.ceil(maxVal / 10) * 10,
        ticks: { stepSize: 10, font: { size: 10 }, backdropColor: "transparent" },
        pointLabels: { font: { size: 12, weight: "bold" as const } },
        grid: { color: "rgba(24, 24, 27, 0.10)" },
        angleLines: { color: "rgba(24, 24, 27, 0.10)" },
      },
    },
    plugins: {
      legend: { position: "bottom" as const, labels: { boxWidth: 12, padding: 12, font: { size: 12 } } },
    },
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle><span className="inline-flex items-center gap-2"><RadarIcon size={17} /> 学科雷达</span></CardTitle>
        <button className="ghost-button" type="button" onClick={() => void loadData()} disabled={loading}>
          <RefreshCw size={14} /> 刷新
        </button>
      </CardHeader>
      <CardContent>
      <div className="mb-3 flex items-center justify-between text-xs text-muted-foreground">
        <span>基于 {totalExams} 场考试 · {subjects.length} 个学科</span>
        {weakSubject && (
          <span className="weak-subject-badge">
            <AlertTriangle size={14} />
            薄弱学科：{weakSubject}
          </span>
        )}
      </div>

      <div className="h-64">
        <Radar data={chartData} options={chartOptions} />
      </div>

      {/* Subject detail table */}
      <Table>
        <TableHeader><TableRow><TableHead>学科</TableHead><TableHead numeric>考试次数</TableHead><TableHead numeric>平均分</TableHead><TableHead>趋势</TableHead></TableRow></TableHeader>
        <TableBody>{subjects.map((s) => <TableRow key={s.subject} selected={s.subject === weakSubject}><TableCell>{s.subject}</TableCell><TableCell numeric>{s.examCount}</TableCell><TableCell numeric>{s.avgScore}</TableCell><TableCell>{s.trend === "up" ? <TrendingUp size={14} className="text-success-foreground" /> : s.trend === "down" ? <TrendingDown size={14} className="text-destructive-fg" /> : "—"}</TableCell></TableRow>)}</TableBody>
      </Table>
      </CardContent>
    </Card>
  );
}
