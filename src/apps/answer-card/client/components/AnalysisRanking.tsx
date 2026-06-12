import { AlertTriangle, Eye, X } from "lucide-react";
import { useState } from "react";
import type { StudentRankingItem } from "../../../../shared/types";

interface Props {
  ranking: StudentRankingItem[];
  examId: number;
}

export function AnalysisRanking({ ranking, examId }: Props) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewTitle, setPreviewTitle] = useState("");

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
              <th style={{ padding: "8px 12px", textAlign: "center", width: 90 }}>答题卡</th>
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
                <td style={{ padding: "8px 12px", textAlign: "center" }}>
                  {item.scanImagePath ? (
                    <button
                      onClick={() => {
                        setPreviewTitle(`${item.studentName} (${item.studentNumber})`);
                        setPreviewUrl(`/api/analysis/exams/${examId}/scan/${item.studentNumber}`);
                      }}
                      style={{
                        background: "none", border: "1px solid var(--line-strong)", borderRadius: 4,
                        cursor: "pointer", padding: "2px 8px", fontSize: 12,
                        display: "inline-flex", alignItems: "center", gap: 4
                      }}
                      title="查看答题卡"
                    >
                      <Eye size={14} /> 预览
                    </button>
                  ) : (
                    <span style={{ color: "var(--muted)", fontSize: 12 }}>—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Preview Modal */}
      {previewUrl && (
        <div
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 1000,
            display: "flex", alignItems: "center", justifyContent: "center",
            padding: 24
          }}
          onClick={() => { setPreviewUrl(null); setPreviewTitle(""); }}
        >
          <div
            style={{
              background: "#fff", borderRadius: 12, maxWidth: "90vw", maxHeight: "90vh",
              overflow: "hidden", position: "relative"
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", borderBottom: "1px solid var(--line)" }}>
              <strong style={{ fontSize: 14 }}>答题卡预览 — {previewTitle}</strong>
              <button onClick={() => { setPreviewUrl(null); setPreviewTitle(""); }} style={{ background: "none", border: "none", cursor: "pointer", padding: 4 }}>
                <X size={20} />
              </button>
            </div>
            <img
              src={previewUrl}
              alt={`答题卡 ${previewTitle}`}
              style={{ maxWidth: "90vw", maxHeight: "calc(90vh - 50px)", objectFit: "contain" }}
              onError={(e) => { (e.currentTarget as HTMLImageElement).src = ""; }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
