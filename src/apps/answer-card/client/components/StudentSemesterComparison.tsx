import { useCallback, useEffect, useState } from "react";
import { CalendarRange, RefreshCw, TrendingDown, TrendingUp } from "lucide-react";
import { fetchJson } from "../auth/api";
import type { StudentSemesterComparison as SemesterComparison } from "../../../../shared/types";
import { Card, CardContent, CardHeader, CardTitle, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/v2";

const SUBJECT_COLORS: Record<string, string> = {
  "语文": "#534AB7", "数学": "#D85A30", "英语": "#1D9E75",
  "物理": "#378ADD", "化学": "#639922", "生物": "#0F6E56",
  "历史": "#D4537E", "地理": "#EF9F27", "政治": "#993556",
};

export function StudentSemesterComparison() {
  const [data, setData] = useState<SemesterComparison | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await fetchJson<SemesterComparison>("/api/scores/me/semester-comparison");
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载学期对比失败");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return <div className="empty-text" style={{ padding: 40, textAlign: "center" }}>正在加载学期对比...</div>;
  }

  if (error) {
    return (
      <div style={{ padding: 24, textAlign: "center" }}>
        <p className="login-error">{error}</p>
        <button className="ghost-button" type="button" onClick={() => void load()}>
          <RefreshCw size={16} /> 重试
        </button>
      </div>
    );
  }

  if (!data?.current) {
    return (
      <div className="scores-empty">
        <CalendarRange size={40} />
        <h2>暂无学期数据</h2>
        <p>参加更多考试后，可在此查看本学期与上学期的成绩对比。</p>
      </div>
    );
  }

  const { current, previous, avgScoreChange, improvedSubjects, declinedSubjects } = data;

  return (
    <Card>
      <CardHeader><CardTitle><span className="inline-flex items-center gap-2"><CalendarRange size={17} /> 学期对比</span></CardTitle></CardHeader>
      <CardContent>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="student-stat-card highlight">
          <span className="student-stat-value">{current.label}</span>
          <span className="student-stat-label">当前学期</span>
        </div>
        <div className="student-stat-card">
          <span className="student-stat-value">{current.examCount}</span>
          <span className="student-stat-label">考试场次</span>
        </div>
        <div className="student-stat-card">
          <span className="student-stat-value">{current.avgScore}</span>
          <span className="student-stat-label">学期均分</span>
        </div>
        {avgScoreChange != null && (
          <div className={`student-stat-card ${avgScoreChange >= 0 ? "highlight" : "warn"}`}>
            <span className="student-stat-value">
              {avgScoreChange >= 0 ? <TrendingUp size={18} style={{ verticalAlign: "middle" }} /> : <TrendingDown size={18} style={{ verticalAlign: "middle" }} />}
              {" "}{avgScoreChange >= 0 ? "+" : ""}{avgScoreChange}
            </span>
            <span className="student-stat-label">较上学期均分</span>
          </div>
        )}
      </div>

      {previous && (
        <div className="semester-compare-bar">
          <span style={{ fontSize: 13, color: "var(--muted)" }}>
            对比上学期（{previous.label}，{previous.startDate} ~ {previous.endDate}）：
          </span>
          <span style={{ fontSize: 13, marginLeft: 12 }}>
            上学期均分 {previous.avgScore} · {previous.examCount} 场考试
          </span>
        </div>
      )}

      {(improvedSubjects.length > 0 || declinedSubjects.length > 0) && (
        <div className="semester-trend-tags">
          {improvedSubjects.map((subject) => (
            <span key={`up-${subject}`} className="semester-tag up" style={{ borderColor: SUBJECT_COLORS[subject] ?? "var(--line-strong)" }}>
              {subject} 进步
            </span>
          ))}
          {declinedSubjects.map((subject) => (
            <span key={`down-${subject}`} className="semester-tag down" style={{ borderColor: SUBJECT_COLORS[subject] ?? "var(--line-strong)" }}>
              {subject} 待加强
            </span>
          ))}
        </div>
      )}

      <div className="analysis-section">
        <div className="panel-title">本学期各学科</div>
        <div style={{ overflowX: "auto" }}>
          <table className="semester-subject-table">
            <thead>
              <tr>
                <th>学科</th>
                <th>考试次数</th>
                <th>平均分</th>
                <th>最高分</th>
                {previous && <th>上学期均分</th>}
              </tr>
            </thead>
            <tbody>
              {current.subjects.map((subject) => {
                const prevSubject = previous?.subjects.find((item) => item.subject === subject.subject);
                const delta = prevSubject ? Math.round((subject.avgScore - prevSubject.avgScore) * 10) / 10 : null;
                return (
                  <tr key={subject.subject}>
                    <td>
                      <span className="semester-subject-dot" style={{ background: SUBJECT_COLORS[subject.subject] ?? "#888780" }} />
                      {subject.subject}
                    </td>
                    <td>{subject.examCount}</td>
                    <td>{subject.avgScore}</td>
                    <td>{subject.bestScore}</td>
                    {previous && (
                      <td style={{ color: delta == null ? "var(--muted)" : delta >= 0 ? "#3B6D11" : "#A32D2D" }}>
                        {prevSubject ? (
                          <>
                            {prevSubject.avgScore}
                            {delta != null && (
                              <span style={{ marginLeft: 8, fontSize: 12 }}>
                                ({delta >= 0 ? "+" : ""}{delta})
                              </span>
                            )}
                          </>
                        ) : "—"}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      </CardContent>
    </Card>
  );
}
