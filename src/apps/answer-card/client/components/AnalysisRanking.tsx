import { AlertTriangle } from "lucide-react";
import type { StudentRankingItem } from "../../../../shared/types";

interface Props {
  ranking: StudentRankingItem[];
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
              <th className="review-col">复核</th>
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
                  {item.needReview && (
                    <span title="有待复核题">
                      <AlertTriangle size={14} color="#d97706" />
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
