import type { QuestionAnalysisItem } from "../../../../shared/types";

interface Props {
  questions: QuestionAnalysisItem[];
}

export function AnalysisQuestions({ questions }: Props) {
  if (!questions || questions.length === 0) {
    return (
      <div className="analysis-section">
        <div className="panel-title">题目分析</div>
        <div className="empty-text">暂无题目数据。</div>
      </div>
    );
  }

  return (
    <div className="analysis-section">
      <div className="panel-title">题目得分率排行</div>
      <div style={{ overflowX: "auto", border: "1px solid var(--line)", borderRadius: 8, background: "#fff", boxShadow: "var(--shadow-sm)" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "var(--surface-tint)", color: "var(--brand)", fontSize: 12, fontWeight: 600 }}>
              <th style={{ padding: "8px 12px", textAlign: "left", width: 52 }}>题号</th>
              <th style={{ padding: "8px 12px", textAlign: "left", width: 52 }}>类型</th>
              <th style={{ padding: "8px 12px", textAlign: "left", width: 140 }}>得分率</th>
              <th style={{ padding: "8px 12px", textAlign: "right", width: 72 }}>正确率</th>
              <th style={{ padding: "8px 12px", textAlign: "right", width: 72 }}>平均分</th>
              <th style={{ padding: "8px 12px", textAlign: "right", width: 56 }}>满分</th>
              <th style={{ padding: "8px 12px", textAlign: "right", width: 56 }}>待复核</th>
            </tr>
          </thead>
          <tbody>
            {questions.map((q) => {
              const isLow = q.scoreRate < 60;
              return (
                <tr key={`${q.questionNumber}-${q.questionType}`} style={{ borderTop: "1px solid var(--line)" }}>
                  <td style={{ padding: "8px 12px" }}>{q.questionNumber}</td>
                  <td style={{ padding: "8px 12px" }}>{q.questionType}</td>
                  <td style={{ padding: "8px 12px" }}>
                    <div className="rate-bar-container">
                      <div
                        className={`rate-bar ${isLow ? "rate-bar-low" : ""}`}
                        style={{ width: `${Math.max(q.scoreRate, 4)}%` }}
                      />
                    </div>
                    <span className={`rate-text ${isLow ? "rate-text-low" : ""}`}>
                      {q.scoreRate}%
                    </span>
                  </td>
                  <td style={{ padding: "8px 12px", textAlign: "right" }}>
                    {q.correctRate !== null ? (
                      <span className={q.correctRate < 60 ? "rate-text-low" : ""}>
                        {q.correctRate}%
                      </span>
                    ) : (
                      <span style={{ color: "var(--muted)" }}>—</span>
                    )}
                  </td>
                  <td style={{ padding: "8px 12px", textAlign: "right" }}>{q.avgScore}</td>
                  <td style={{ padding: "8px 12px", textAlign: "right" }}>{q.maxScore}</td>
                  <td style={{ padding: "8px 12px", textAlign: "right" }}>
                    {q.reviewCount > 0 ? (
                      <span className="rate-text-low">{q.reviewCount}</span>
                    ) : (
                      "0"
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
