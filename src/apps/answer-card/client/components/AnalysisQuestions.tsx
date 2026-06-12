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

  // Show lowest score-rate questions first (already sorted by API)
  return (
    <div className="analysis-section">
      <div className="panel-title">题目得分率排行</div>
      <div className="score-table" style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr className="score-table-head">
              <th style={{ width: 56 }}>题号</th>
              <th style={{ width: 56 }}>类型</th>
              <th style={{ width: 80 }}>得分率</th>
              <th style={{ width: 80 }}>正确率</th>
              <th style={{ width: 72 }}>平均分</th>
              <th style={{ width: 56 }}>满分</th>
              <th style={{ width: 56 }}>待复核</th>
            </tr>
          </thead>
          <tbody>
            {questions.map((q) => {
              const isLow = q.scoreRate < 60;
              return (
                <tr key={`${q.questionNumber}-${q.questionType}`} className="score-row">
                  <td>{q.questionNumber}</td>
                  <td>{q.questionType}</td>
                  <td>
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
                  <td>
                    {q.correctRate !== null ? (
                      <span className={q.correctRate < 60 ? "rate-text-low" : ""}>
                        {q.correctRate}%
                      </span>
                    ) : (
                      <span style={{ color: "var(--muted)" }}>—</span>
                    )}
                  </td>
                  <td>{q.avgScore}</td>
                  <td>{q.maxScore}</td>
                  <td>
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
