import { useEffect, useState } from "react";
import { Chart as ChartJS, RadialLinearScale, PointElement, LineElement, Filler, Tooltip, Legend } from "chart.js";
import { Radar } from "react-chartjs-2";
import { fetchJson } from "../auth/api";
import type { SubjectWeaknessItem, StudentTrendPoint } from "../../../../shared/types";
import { Radar as RadarIcon, RefreshCw, AlertTriangle, TrendingUp, TrendingDown } from "lucide-react";

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

  if (loading) return <div className="empty-text" style={{ padding: 40, textAlign: "center" }}>加载中...</div>;
  if (error) return <div className="login-error" style={{ padding: 20 }}>{error}</div>;
  if (!data || data.subjects.length === 0) {
    return <div className="empty-text" style={{ padding: 40, textAlign: "center" }}>暂无学科对比数据。</div>;
  }

  const { subjects, weakSubject, totalExams } = data;
  const labels = subjects.map((s) => s.subject);
  const myScores = subjects.map((s) => Math.max(s.avgScore, 0));
  const classAvgs = subjects.map((s) => Math.max(s.avgClassAvg, 0));

  // Determine max scale
  const maxVal = Math.max(...myScores, ...classAvgs, 100);

  const chartData = {
    labels,
    datasets: [
      {
        label: "我的平均分",
        data: myScores,
        backgroundColor: "rgba(83, 74, 183, 0.15)",
        borderColor: "#534AB7",
        borderWidth: 2,
        pointBackgroundColor: "#534AB7",
        pointRadius: 4,
      },
      {
        label: "班级平均分",
        data: classAvgs,
        backgroundColor: "rgba(136, 135, 128, 0.08)",
        borderColor: "#888780",
        borderWidth: 1.5,
        borderDash: [4, 3],
        pointBackgroundColor: "#888780",
        pointRadius: 3,
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
        grid: { color: "rgba(0,0,0,0.06)" },
        angleLines: { color: "rgba(0,0,0,0.08)" },
      },
    },
    plugins: {
      legend: { position: "bottom" as const, labels: { boxWidth: 12, padding: 12, font: { size: 12 } } },
    },
  };

  return (
    <div className="student-chart-section">
      <div className="student-chart-header">
        <div className="panel-title"><RadarIcon size={17} /> 学科对比</div>
        <button className="ghost-button" type="button" onClick={() => void loadData()} disabled={loading}>
          <RefreshCw size={14} /> 刷新
        </button>
      </div>

      <div className="student-subject-summary">
        <span>基于 {totalExams} 场考试 · {subjects.length} 个学科</span>
        {weakSubject && (
          <span className="weak-subject-badge">
            <AlertTriangle size={14} />
            薄弱学科：{weakSubject}
          </span>
        )}
      </div>

      <div className="student-chart-canvas radar">
        <Radar data={chartData} options={chartOptions} />
      </div>

      {/* Subject detail table */}
      <div className="student-subject-table">
        <div className="student-subject-table-head">
          <span>学科</span>
          <span>考试次数</span>
          <span>平均分</span>
          <span>班级均分</span>
          <span>差距</span>
          <span>趋势</span>
        </div>
        {subjects.map((s) => (
          <div key={s.subject} className={`student-subject-table-row ${s.subject === weakSubject ? "weak" : ""}`}>
            <span className="subject-name">{s.subject}</span>
            <span>{s.examCount}</span>
            <span>{s.avgScore}</span>
            <span>{s.avgClassAvg}</span>
            <span className={s.gapToClass < 0 ? "gap-negative" : "gap-positive"}>
              {s.gapToClass > 0 ? "+" : ""}{s.gapToClass}
            </span>
            <span className={`trend-${s.trend}`}>
              {s.trend === "up" && <TrendingUp size={14} />}
              {s.trend === "down" && <TrendingDown size={14} />}
              {s.trend === "stable" && "—"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
