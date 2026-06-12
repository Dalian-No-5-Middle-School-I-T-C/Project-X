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
      <div className="score-table" style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr className="score-table-head">
              <th style={{ width: 48 }}>#</th>
              <th>学号</th>
              <th>姓名</th>
              <th style={{ width: 70 }}>总分</th>
              <th style={{ width: 70 }}>客观</th>
              <th style={{ width: 70 }}>主观</th>
              <th style={{ width: 60 }}>复核</th>
            </tr>
          </thead>
          <tbody>
            {ranking.map((item) => (
              <tr key={item.studentNumber} className="score-row">
                <td className="rank-cell">{item.rank}</td>
                <td>{item.studentNumber}</td>
                <td>{item.studentName}</td>
                <td className="score-cell">{item.totalScore}</td>
                <td className="score-cell">{item.objectiveScore}</td>
                <td className="score-cell">{item.subjectiveScore}</td>
                <td>
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
