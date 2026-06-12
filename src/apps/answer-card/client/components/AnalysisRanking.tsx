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
      <div style={{ overflowX: "auto", border: "1px solid var(--line)", borderRadius: 8, background: "#fff", boxShadow: "var(--shadow-sm)" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "var(--surface-tint)", color: "var(--brand-strong)", fontSize: 12, fontWeight: 600 }}>
              <th style={{ padding: "8px 12px", textAlign: "left", width: 44 }}>#</th>
              <th style={{ padding: "8px 12px", textAlign: "left" }}>学号</th>
              <th style={{ padding: "8px 12px", textAlign: "left" }}>姓名</th>
              <th style={{ padding: "8px 12px", textAlign: "right", width: 70 }}>总分</th>
              <th style={{ padding: "8px 12px", textAlign: "right", width: 70 }}>客观</th>
              <th style={{ padding: "8px 12px", textAlign: "right", width: 70 }}>主观</th>
              <th style={{ padding: "8px 12px", textAlign: "center", width: 56 }}>复核</th>
            </tr>
          </thead>
          <tbody>
            {ranking.map((item) => (
              <tr key={item.studentNumber} style={{ borderTop: "1px solid var(--line)" }}>
                <td style={{ padding: "8px 12px", fontWeight: 600, color: "var(--brand)" }}>{item.rank}</td>
                <td style={{ padding: "8px 12px" }}>{item.studentNumber}</td>
                <td style={{ padding: "8px 12px" }}>{item.studentName}</td>
                <td style={{ padding: "8px 12px", textAlign: "right", fontWeight: 600 }}>{item.totalScore}</td>
                <td style={{ padding: "8px 12px", textAlign: "right" }}>{item.objectiveScore}</td>
                <td style={{ padding: "8px 12px", textAlign: "right" }}>{item.subjectiveScore}</td>
                <td style={{ padding: "8px 12px", textAlign: "center" }}>
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
