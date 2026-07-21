import React, { useState, useEffect, useCallback } from "react";
import { fetchJson } from "../auth/api";
import type { ReviewTraceItem } from "../../../../shared/types";

interface Props {
  examId: number;
}

export function ReviewTracePage({ examId }: Props) {
  const [traces, setTraces] = useState<ReviewTraceItem[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchJson<{ ok: boolean; data: ReviewTraceItem[] }>(
        `/api/review/exams/${examId}/trace`
      );
      if (res.ok) setTraces(res.data);
    } catch { /* silent */ }
    setLoading(false);
  }, [examId]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div style={{ padding: 24 }}>加载中...</div>;

  return (
    <div style={{ padding: 24 }}>
      <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 16 }}>阅卷溯源</div>

      {traces.length === 0 ? (
        <div style={{ color: "var(--color-text-tertiary)" }}>暂无溯源数据</div>
      ) : (
        <div style={{ overflow: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--color-border-primary)", textAlign: "left" }}>
                <th style={{ padding: "8px 12px" }}>学生</th>
                <th style={{ padding: "8px 12px" }}>学号</th>
                <th style={{ padding: "8px 12px" }}>题块</th>
                <th style={{ padding: "8px 12px" }}>评分历史</th>
                <th style={{ padding: "8px 12px" }}>最终分</th>
                <th style={{ padding: "8px 12px" }}>状态</th>
              </tr>
            </thead>
            <tbody>
              {traces.map((t) => (
                <tr key={t.cropId} style={{ borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
                  <td style={{ padding: "8px 12px" }}>{t.studentName}</td>
                  <td style={{ padding: "8px 12px", color: "var(--color-text-secondary)" }}>{t.studentNumber}</td>
                  <td style={{ padding: "8px 12px" }}>{t.blockTitle}</td>
                  <td style={{ padding: "8px 12px" }}>
                    {t.rounds.map((r, i) => (
                      <span key={i} style={{ marginRight: 8, fontSize: 12, color: "var(--color-text-secondary)" }}>
                        R{r.round}: {r.reviewerName}({r.score})
                      </span>
                    ))}
                  </td>
                  <td style={{ padding: "8px 12px", fontWeight: 500 }}>
                    {t.finalScore != null ? t.finalScore : t.status === "disputed" ? "争议中" : "-"}
                  </td>
                  <td style={{ padding: "8px 12px" }}>
                    <span style={{
                      fontSize: 12,
                      padding: "2px 8px",
                      borderRadius: 4,
                      background: t.status === "reviewed" ? "rgba(99,153,34,0.1)" : t.status === "disputed" ? "rgba(226,75,74,0.1)" : "var(--color-background-tertiary)",
                      color: t.status === "reviewed" ? "#639922" : t.status === "disputed" ? "#E24B4A" : "var(--color-text-secondary)",
                    }}>
                      {t.status === "reviewed" ? "已审" : t.status === "disputed" ? "争议" : t.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
