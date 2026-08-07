/**
 * Issue #175: 选择题各选项选择人数统计与分析
 * 数据源: GET /api/analysis/exams/:examId/option-analysis
 */
import { useEffect, useState } from "react";
import { fetchJson } from "../auth/api";
import type { OptionAnalysisResponse } from "../../../../shared/types";

interface Props {
  examId: number;
  classId?: string;
}

export function OptionAnalysisPanel({ examId, classId }: Props) {
  const [data, setData] = useState<OptionAnalysisResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    setLoading(true);
    setError("");
    const params = new URLSearchParams();
    if (classId) params.set("classId", classId);
    fetchJson<OptionAnalysisResponse>(`/api/analysis/exams/${examId}/option-analysis?${params.toString()}`)
      .then((d) => setData(d))
      .catch((e) => setError(e instanceof Error ? e.message : "加载选项分析失败"))
      .finally(() => setLoading(false));
  }, [examId, classId]);

  if (loading) {
    return (
      <div className="analysis-section" style={{ textAlign: "center", padding: 16, color: "var(--muted)" }}>
        加载选项分析...
      </div>
    );
  }

  if (error) {
    return (
      <div className="analysis-section" style={{ textAlign: "center", padding: 16, color: "#A32D2D" }}>
        {error}
      </div>
    );
  }

  if (!data || !data.hasOptionData || data.questions.length === 0) {
    return (
      <div className="analysis-section" style={{ textAlign: "center", padding: 16, color: "var(--muted)", border: "1px dashed var(--line-strong)", borderRadius: 10, background: "var(--bg-soft)" }}>
        暂无选项数据 —— 本次阅卷未记录每题所选选项（历史考试数据可能缺失）。
      </div>
    );
  }

  return (
    <div className="analysis-section">
      <div className="panel-title">选择题选项分析（各选项选择人数/比例）</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {data.questions.map((q) => (
          <div key={q.questionNumber} style={{ border: "1px solid var(--line)", borderRadius: 8, padding: "10px 12px", background: "var(--surface)" }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12, fontSize: 12, color: "var(--muted)", marginBottom: 8 }}>
              <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>第 {q.questionNumber} 题</span>
              <span>{q.mode === "multiple" ? "多选" : q.mode === "indeterminate" ? "不定项" : "单选"} · 满分 {q.maxScore}</span>
              <span>作答 {q.answeredCount} / 未答 {q.unansweredCount}</span>
              {q.correctRate != null && <span>满分率 {q.correctRate}%</span>}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {q.options.map((opt) => {
                const isCorrect = opt.isCorrect;
                const pct = opt.rate;
                return (
                  <div
                    key={opt.option}
                    style={{
                      minWidth: 92,
                      padding: "6px 10px",
                      borderRadius: 8,
                      border: `1.5px solid ${isCorrect ? "#3B6D11" : "var(--line-strong)"}`,
                      background: isCorrect ? "rgba(99,153,34,0.08)" : "var(--bg-soft)",
                      textAlign: "center",
                    }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 600, color: isCorrect ? "#3B6D11" : "var(--text-primary)" }}>
                      {opt.option}
                      {isCorrect && <span style={{ fontSize: 11, marginLeft: 4 }}>✓</span>}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                      {opt.count} 人 · {pct}%
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
