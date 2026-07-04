import { useCallback, useEffect, useState } from "react";
import { BarChart3, BrainCircuit, CalendarRange, ChevronDown, LineChart, Radar, RefreshCw, Sparkles, TrendingUp } from "lucide-react";
import { fetchJson } from "../auth/api";
import type { StudentExamScore, StudentQuestionScore } from "../auth/types";
import type { StudentTrendPoint, AiAnalysisResponse } from "../../../../shared/types";
import { StudentTrendChart } from "./StudentTrendChart";
import { StudentSubjectRadar } from "./StudentSubjectRadar";
import { StudentAiPanel } from "./StudentAiPanel";
import { GradeLadder } from "./GradeLadder";
import { StudentSemesterComparison } from "./StudentSemesterComparison";
import { TrendLine } from "./AnalysisCharts";

interface ScoresResponse {
  studentId: number;
  name: string;
  scores: StudentExamScore[];
}

interface ExamDetailResponse {
  examId: number;
  questions: StudentQuestionScore[];
}

type TabId = "list" | "trend" | "subjects" | "semester" | "ai" | "ladder";

const TABS: { id: TabId; label: string; icon: React.ReactNode }[] = [
  { id: "list", label: "成绩列表", icon: <BarChart3 size={16} /> },
  { id: "trend", label: "趋势分析", icon: <LineChart size={16} /> },
  { id: "subjects", label: "学科对比", icon: <Radar size={16} /> },
  { id: "semester", label: "学期对比", icon: <CalendarRange size={16} /> },
  { id: "ai", label: "AI 分析", icon: <Sparkles size={16} /> },
  { id: "ladder", label: "成绩天梯", icon: <TrendingUp size={16} /> },
];

export function StudentScores() {
  const [activeTab, setActiveTab] = useState<TabId>("list");
  const [data, setData] = useState<ScoresResponse | null>(null);
  const [expandedExamId, setExpandedExamId] = useState<number | null>(null);
  const [examDetails, setExamDetails] = useState<Record<number, StudentQuestionScore[]>>({});
  const [trends, setTrends] = useState<StudentTrendPoint[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const loadScores = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const [scoreResult, trendResult] = await Promise.all([
        fetchJson<ScoresResponse>("/api/scores/me"),
        fetchJson<StudentTrendPoint[]>("/api/scores/me/trends").catch(() => []),
      ]);
      setData(scoreResult);
      setTrends(Array.isArray(trendResult) ? trendResult : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载成绩失败");
      setData(null);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void loadScores();
  }, [loadScores]);

  async function toggleExamDetail(examId: number) {
    if (expandedExamId === examId) {
      setExpandedExamId(null);
      return;
    }
    setExpandedExamId(examId);
    if (examDetails[examId]) return;
    try {
      const detail = await fetchJson<ExamDetailResponse>(`/api/scores/me/exams/${examId}`);
      setExamDetails((prev) => ({ ...prev, [examId]: detail.questions }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载明细失败");
    }
  }

  // ── 整体概览卡片 ──
  function renderOverview() {
    if (!data || !data.scores.length) return null;
    const totalExams = data.scores.length;
    const avgScore = Math.round((data.scores.reduce((s, x) => s + x.total_score, 0) / totalExams) * 10) / 10;
    const bestExam = [...data.scores].sort((a, b) => b.total_score - a.total_score)[0];
    const worstExam = [...data.scores].sort((a, b) => a.total_score - b.total_score)[0];

    const subjects = [...new Set(data.scores.map((s) => s.subject).filter(Boolean))];

    return (
      <div className="student-overview-cards">
        <div className="student-stat-card">
          <span className="student-stat-value">{totalExams}</span>
          <span className="student-stat-label">参加考试</span>
        </div>
        <div className="student-stat-card">
          <span className="student-stat-value">{avgScore}</span>
          <span className="student-stat-label">平均分</span>
        </div>
        <div className="student-stat-card">
          <span className="student-stat-value">{subjects.length}</span>
          <span className="student-stat-label">学科数</span>
        </div>
        {bestExam && (
          <div className="student-stat-card highlight">
            <span className="student-stat-value">{bestExam.subject} {bestExam.total_score}</span>
            <span className="student-stat-label">最佳成绩</span>
          </div>
        )}
        {worstExam && (
          <div className="student-stat-card warn">
            <span className="student-stat-value">{worstExam.subject} {worstExam.total_score}</span>
            <span className="student-stat-label">待提升</span>
          </div>
        )}
      </div>
    );
  }

  // ── Tab: 成绩列表 ──
  function renderScoreList() {
    return (
      <>
        {!data?.scores.length && !busy && !error && (
          <div className="scores-empty">
            <BarChart3 size={40} />
            <h2>暂无成绩记录</h2>
            <p>考试阅卷落库后，可在此查看各场考试得分与排名。</p>
          </div>
        )}

        <div className="scores-list">
          {data?.scores && data.scores.length >= 2 && (
            <div className="score-card" style={{ padding: 16 }}>
              <div className="panel-title" style={{ marginBottom: 8 }}>成绩趋势</div>
              <TrendLine
                data={{
                  labels: data.scores.map((s) => s.exam_name),
                  datasets: [{
                    label: "总分",
                    data: data.scores.map((s) => s.total_score),
                    color: "var(--brand)",
                  }],
                }}
                height={180}
              />
            </div>
          )}
          {data?.scores.map((score) => (
            <div key={score.exam_id} className="score-card">
              <button type="button" className="score-card-header" onClick={() => void toggleExamDetail(score.exam_id)}>
                <div>
                  <strong>{score.exam_name}</strong>
                  {score.subject && <span className="score-subject">{score.subject}</span>}
                </div>
                <div className="score-card-stats">
                  <span className="score-total">{score.total_score} 分</span>
                  {score.rank != null && (
                    <span className="score-rank">
                      第 {score.rank} / {score.class_size} 名
                      {score.percentile != null && ` · 前 ${score.percentile}%`}
                    </span>
                  )}
                </div>
                <ChevronDown size={16} className={expandedExamId === score.exam_id ? "rotated" : ""} />
              </button>
              <div className="score-card-meta">
                <span>客观 {score.objective_score}</span>
                <span>主观 {score.subjective_score}</span>
                <span>{new Date(score.graded_at).toLocaleString()}</span>
              </div>
              {expandedExamId === score.exam_id && examDetails[score.exam_id] && (
                <div className="score-detail-table">
                  <div className="score-detail-head">
                    <span>题号</span>
                    <span>得分</span>
                    <span>满分</span>
                    <span>类型</span>
                  </div>
                  {examDetails[score.exam_id].map((q, i) => (
                    <div className="score-detail-row" key={`${q.question_id ?? q.question_number}_${i}`}>
                      <span>{q.question_number ?? q.question_id ?? "—"}</span>
                      <span>{q.score}</span>
                      <span>{q.max_score}</span>
                      <span>{q.score_type}</span>
                    </div>
                  ))}
                  {/* AI analysis button per exam */}
                  <div className="score-detail-ai">
                    <AiAnalysisForExam examId={score.exam_id} examName={score.exam_name} />
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </>
    );
  }

  return (
    <div className="scores-panel">
      {/* Header */}
      <div className="account-panel-header">
        <div>
          <strong>我的成绩</strong>
          {data && <span className="account-summary">{data.name}</span>}
        </div>
        <button className="ghost-button" type="button" onClick={() => void loadScores()} disabled={busy}>
          <RefreshCw size={16} /> 刷新
        </button>
      </div>

      {error && <p className="login-error">{error}</p>}

      {/* Overview cards (always shown) */}
      {renderOverview()}

      {/* Tab navigation */}
      <div className="student-tabs">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`student-tab ${activeTab === tab.id ? "active" : ""}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.icon}
            <span>{tab.label}</span>
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="student-tab-content">
        {activeTab === "list" && renderScoreList()}
        {activeTab === "trend" && <StudentTrendChart trends={trends} />}
        {activeTab === "subjects" && <StudentSubjectRadar />}
        {activeTab === "semester" && <StudentSemesterComparison />}
        {activeTab === "ai" && <StudentAiPanel />}
        {activeTab === "ladder" && <GradeLadder />}
      </div>
    </div>
  );
}

/** 内联的按考试 AI 分析组件 */
function AiAnalysisForExam({ examId, examName }: { examId: number; examName: string }) {
  const [result, setResult] = useState<AiAnalysisResponse | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);

  async function generate() {
    if (result && !expanded) {
      setExpanded(true);
      return;
    }
    if (generating) return;
    setGenerating(true);
    setError("");
    try {
      const res = await fetchJson<AiAnalysisResponse>(`/api/scores/me/exams/${examId}/ai-analysis`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      setResult(res);
      setExpanded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="ai-exam-inline">
      <button className="ghost-button" type="button" onClick={() => void generate()} disabled={generating}>
        <BrainCircuit size={14} /> {generating ? "分析中..." : result ? "AI 分析结果" : "AI 分析"}
      </button>
      {error && <span className="ai-inline-error">{error}</span>}
      {expanded && result && (
        <div className="ai-exam-inline-result">
          <p><strong>{result.report.overallJudgement}</strong></p>
          {result.report.weakPoints.length > 0 && (
            <div className="ai-exam-weak">
              <span>薄弱点：</span>
              {result.report.weakPoints.join("；")}
            </div>
          )}
          {result.report.teachingSuggestions.length > 0 && (
            <div className="ai-exam-suggest">
              <span>建议：</span>
              {result.report.teachingSuggestions.join("；")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
