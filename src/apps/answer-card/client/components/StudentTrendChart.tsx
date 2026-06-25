import { useEffect, useState } from "react";
import { Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend, Filler } from "chart.js";
import { Line } from "react-chartjs-2";
import { fetchJson } from "../auth/api";
import type { StudentTrendPoint } from "../../../../shared/types";
import { LineChart, RefreshCw } from "lucide-react";

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend, Filler);

const SUBJECT_COLORS: Record<string, string> = {
  "语文": "#534AB7", "数学": "#D85A30", "英语": "#1D9E75",
  "物理": "#378ADD", "化学": "#639922", "生物": "#0F6E56",
  "历史": "#D4537E", "地理": "#EF9F27", "政治": "#993556",
};

interface Props {
  /** 从父组件传入的已有数据（可选，避免重复请求） */
  trends?: StudentTrendPoint[];
  onLoad?: (trends: StudentTrendPoint[]) => void;
}

export function StudentTrendChart({ trends: propTrends, onLoad }: Props) {
  const [trends, setTrends] = useState<StudentTrendPoint[]>(propTrends ?? []);
  const [loading, setLoading] = useState(!propTrends);
  const [selectedSubjects, setSelectedSubjects] = useState<Set<string>>(new Set());
  const [showClassAvg, setShowClassAvg] = useState(true);
  const [showGradeAvg, setShowGradeAvg] = useState(false);
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

  function toggleSubject(s: string) {
    const next = new Set(selectedSubjects);
    if (next.has(s)) next.delete(s);
    else next.add(s);
    setSelectedSubjects(next);
  }

  // Build datasets — align data to shared labels array
  // Get all unique exam names sorted chronologically (they're already ASC from API)
  const allExams = trends.filter((t) => selectedSubjects.has(t.subject));
  const allLabels = [...new Set(allExams.map((t) => t.examName))];
  const datasets: import("chart.js").ChartDataset<"line">[] = [];

  for (const subject of selectedSubjects) {
    const subjectTrends = trends.filter((t) => t.subject === subject);
    const color = SUBJECT_COLORS[subject] ?? "#888780";

    // Map each subject's data to the shared labels array
    const subjectMap = new Map(subjectTrends.map((t) => [t.examName, t]));
    const alignedScores = allLabels.map((name) => subjectMap.get(name)?.totalScore ?? null);
    const alignedClassAvg = allLabels.map((name) => subjectMap.get(name)?.classAvg ?? null);

    datasets.push({
      label: subject,
      data: alignedScores,
      borderColor: color,
      backgroundColor: color + "22",
      pointBackgroundColor: color,
      pointRadius: 4,
      pointHoverRadius: 6,
      tension: 0.3,
      fill: false,
      spanGaps: true,
    });

    if (showClassAvg) {
      datasets.push({
        label: `${subject}(班级均分)`,
        data: alignedClassAvg,
        borderColor: color + "88",
        backgroundColor: "transparent",
        pointBackgroundColor: color + "88",
        pointRadius: 3,
        pointHoverRadius: 5,
        borderDash: [5, 3],
        tension: 0.3,
        fill: false,
        spanGaps: true,
      });
    }
  }

  const chartData = {
    labels: allLabels,
    datasets,
  };

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index" as const, intersect: false },
    plugins: {
      legend: { display: true, position: "top" as const, labels: { boxWidth: 12, padding: 12, font: { size: 12 } } },
        tooltip: {
          callbacks: {
            afterLabel: function (this: any, context: any) {
              return "";
            } as any,
          }
        }
    },
    scales: {
      y: {
        beginAtZero: false,
        title: { display: true, text: "分数", font: { size: 12 } },
        ticks: { font: { size: 11 } }
      },
      x: {
        ticks: { font: { size: 10 }, maxRotation: 30 }
      }
    }
  };

  if (loading) {
    return <div className="empty-text" style={{ padding: 40, textAlign: "center" }}>加载中...</div>;
  }

  if (error) {
    return <div className="login-error" style={{ padding: 20 }}>{error}</div>;
  }

  if (trends.length === 0) {
    return <div className="empty-text" style={{ padding: 40, textAlign: "center" }}>暂无成绩趋势数据。</div>;
  }

  return (
    <div className="student-chart-section">
      <div className="student-chart-header">
        <div className="panel-title"><LineChart size={17} /> 成绩趋势</div>
        <button className="ghost-button" type="button" onClick={() => void loadTrends()} disabled={loading}>
          <RefreshCw size={14} /> 刷新
        </button>
      </div>

      {/* Controls */}
      <div className="student-chart-controls">
        <div className="student-subject-filters">
          {subjects.map((s) => (
            <button
              key={s}
              className={`student-subject-tag ${selectedSubjects.has(s) ? "active" : ""}`}
              style={selectedSubjects.has(s) ? { borderColor: SUBJECT_COLORS[s] ?? "#888780", background: (SUBJECT_COLORS[s] ?? "#888780") + "18" } : {}}
              type="button"
              onClick={() => toggleSubject(s)}
            >
              {s}
            </button>
          ))}
        </div>
        <div className="student-chart-toggles">
          <label className="chart-toggle">
            <input type="checkbox" checked={showClassAvg} onChange={() => setShowClassAvg(!showClassAvg)} />
            <span>班级均分</span>
          </label>
          <label className="chart-toggle">
            <input type="checkbox" checked={showGradeAvg} onChange={() => setShowGradeAvg(!showGradeAvg)} />
            <span>年级均分</span>
          </label>
        </div>
      </div>

      {/* Chart */}
      <div className="student-chart-canvas">
        <Line data={chartData} options={chartOptions} />
      </div>
    </div>
  );
}
