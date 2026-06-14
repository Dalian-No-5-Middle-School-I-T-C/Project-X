import { useCallback, useEffect, useState } from "react";
import { BarChart3, ChevronDown, RefreshCw } from "lucide-react";
import { fetchJson } from "../auth/api";
import type { StudentExamScore, StudentQuestionScore } from "../auth/types";

interface ScoresResponse {
  studentId: number;
  name: string;
  scores: StudentExamScore[];
}

interface ExamDetailResponse {
  examId: number;
  questions: StudentQuestionScore[];
}

export function StudentScores() {
  const [data, setData] = useState<ScoresResponse | null>(null);
  const [expandedExamId, setExpandedExamId] = useState<number | null>(null);
  const [examDetails, setExamDetails] = useState<Record<number, StudentQuestionScore[]>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const loadScores = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const result = await fetchJson<ScoresResponse>("/api/scores/me");
      setData(result);
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

  return (
    <div className="scores-panel">
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

      {!data?.scores.length && !busy && !error && (
        <div className="scores-empty">
          <BarChart3 size={40} />
          <h2>暂无成绩记录</h2>
          <p>考试阅卷落库后，可在此查看各场考试得分与排名。</p>
        </div>
      )}

      <div className="scores-list">
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
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
