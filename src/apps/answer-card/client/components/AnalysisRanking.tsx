import type { StudentRankingItem } from "../../../../shared/types";

interface Props {
  ranking: StudentRankingItem[];
}

function errorLevelText(level: StudentRankingItem["errorRateLevel"]): string {
  if (level === "high") return "高";
  if (level === "medium") return "中";
  if (level === "low") return "低";
  return "正常";
}

export function AnalysisRanking({ ranking }: Props) {
  if (!ranking || ranking.length === 0) {
    return (
      <div className="analysis-section">
        <div className="panel-title">学生排名</div>
        <div className="empty-text">暂无排名数据。</div>
      </div>
    );
  }

  return (
    <div className="analysis-section">
      <div className="panel-title">学生排名</div>
      <div className="analysis-ranking-table-wrap">
        <table className="analysis-ranking-table">
          <thead>
            <tr>
              <th className="rank-col">#</th>
              <th>学号</th>
              <th>姓名</th>
              <th className="score-col">总分</th>
              <th className="score-col">客观</th>
              <th className="score-col">主观</th>
              <th className="review-col">低分题占比</th>
            </tr>
          </thead>
          <tbody>
            {ranking.map((item) => (
              <tr key={item.studentNumber}>
                <td className="rank-cell">{item.rank}</td>
                <td>{item.studentNumber}</td>
                <td>{item.studentName}</td>
                <td className="score-col score-value">{item.totalScore}</td>
                <td className="score-col">{item.objectiveScore}</td>
                <td className="score-col">{item.subjectiveScore}</td>
                <td className="review-col">
                  {item.errorRateLevel === "none" ? (
                    <span style={{ color: "var(--muted)" }}>—</span>
                  ) : (
                    <span title={`${item.lowScoreCount}/${item.questionCount} 题低于半分，约 ${item.errorRate}%`}>
                      <span className={`error-level-badge error-level-${item.errorRateLevel}`}>
                        {errorLevelText(item.errorRateLevel)}
                      </span>
                      <span style={{ marginLeft: 6 }}>{item.errorRate}%</span>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
