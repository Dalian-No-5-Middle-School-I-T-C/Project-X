import { useMemo, useState } from "react";
import type { QuestionAnalysisItem } from "../../../../shared/types";
import type { ThresholdBand } from "../../../../shared/stats";
import { DifficultyBadge, DiscriminationBadge } from "./MetricBadge";

interface Props {
  questions: QuestionAnalysisItem[];
  bands?: { difficulty: ThresholdBand[]; discrimination: ThresholdBand[] };
  /** 点击某题行（逐题下钻全班得分）。提供则整行可点击。 */
  onRowClick?: (questionNumber: string) => void;
}

type SortKey =
  | "questionNumber" | "questionType" | "scoreRate" | "correctRate"
  | "avgScore" | "maxScore" | "errorRate" | "difficulty" | "discrimination";

function errorLevelText(level: QuestionAnalysisItem["errorRateLevel"]): string {
  if (level === "high") return "高";
  if (level === "medium") return "中";
  if (level === "low") return "低";
  return "正常";
}

function getSortValue(q: QuestionAnalysisItem, key: SortKey): number | string | null {
  switch (key) {
    case "questionNumber": return Number(q.questionNumber);
    case "questionType": return q.questionType;
    case "scoreRate": return q.scoreRate;
    case "correctRate": return q.correctRate;
    case "avgScore": return q.avgScore;
    case "maxScore": return q.maxScore;
    case "errorRate": return q.errorRate;
    case "difficulty": return q.difficulty;
    case "discrimination": return q.discrimination;
  }
}

export function AnalysisQuestions({ questions, bands, onRowClick }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>("questionNumber");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const sorted = useMemo(() => {
    const arr = [...questions];
    arr.sort((a, b) => {
      const va = getSortValue(a, sortKey);
      const vb = getSortValue(b, sortKey);
      let cmp = 0;
      if (va == null && vb == null) cmp = 0;
      else if (va == null) cmp = -1;
      else if (vb == null) cmp = 1;
      else if (typeof va === "number" && typeof vb === "number") cmp = va - vb;
      else cmp = String(va).localeCompare(String(vb), "zh");
      return sortDir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [questions, sortKey, sortDir]);

  if (!questions || questions.length === 0) {
    return (
      <div className="analysis-section">
        <div className="panel-title">题目分析</div>
        <div className="empty-text">暂无题目数据。</div>
      </div>
    );
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir(key === "questionNumber" || key === "errorRate" || key === "difficulty" ? "asc" : "desc"); }
  }

  function sortIndicator(key: SortKey) {
    if (sortKey !== key) return <span style={{ opacity: 0.35, fontSize: 10 }}>⇅</span>;
    return <span style={{ fontSize: 10, color: "var(--brand)" }}>{sortDir === "asc" ? "▲" : "▼"}</span>;
  }

  const thStyle: React.CSSProperties = { padding: "8px 12px", textAlign: "left", fontWeight: 600, cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" };
  const thRight: React.CSSProperties = { ...thStyle, textAlign: "right" };

  return (
    <div className="analysis-section">
      <div className="panel-title">题目得分率排行{onRowClick ? "（点击题目可下钻全班得分）" : ""}</div>
      <div style={{ overflowX: "auto", border: "1px solid var(--line)", borderRadius: 8, background: "var(--surface)", boxShadow: "var(--shadow-sm)" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "var(--surface-tint)", color: "var(--brand)", fontSize: 12 }}>
              <th style={{ ...thStyle, width: 52 }} onClick={() => toggleSort("questionNumber")}>题号 {sortIndicator("questionNumber")}</th>
              <th style={{ ...thStyle, width: 52 }} onClick={() => toggleSort("questionType")}>类型 {sortIndicator("questionType")}</th>
              <th style={{ ...thRight, width: 140 }} onClick={() => toggleSort("scoreRate")}>得分率 {sortIndicator("scoreRate")}</th>
              <th style={{ ...thRight, width: 72 }} onClick={() => toggleSort("correctRate")}>正确率 {sortIndicator("correctRate")}</th>
              <th style={{ ...thRight, width: 72 }} onClick={() => toggleSort("avgScore")}>平均分 {sortIndicator("avgScore")}</th>
              <th style={{ ...thRight, width: 56 }} onClick={() => toggleSort("maxScore")}>满分 {sortIndicator("maxScore")}</th>
              <th style={{ ...thRight, width: 92 }} onClick={() => toggleSort("errorRate")}>错误/低分率 {sortIndicator("errorRate")}</th>
              <th style={{ ...thRight, width: 120 }} onClick={() => toggleSort("difficulty")}>难度系数 P {sortIndicator("difficulty")}</th>
              <th style={{ ...thRight, width: 120 }} onClick={() => toggleSort("discrimination")}>区分度 D {sortIndicator("discrimination")}</th>
              <th style={{ ...thRight, width: 64 }}>档位</th>
              {onRowClick && <th style={{ ...thRight, width: 44 }}>下钻</th>}
            </tr>
          </thead>
          <tbody>
            {sorted.map((q) => {
              const isLow = q.scoreRate < 60;
              return (
                <tr key={`${q.questionNumber}-${q.questionType}`} style={{ borderTop: "1px solid var(--line)", cursor: onRowClick ? "pointer" : "default" }}
                  onClick={onRowClick ? () => onRowClick(q.questionNumber) : undefined}
                  onMouseEnter={onRowClick ? (e) => (e.currentTarget.style.background = "var(--bg-soft)") : undefined}
                  onMouseLeave={onRowClick ? (e) => (e.currentTarget.style.background = "") : undefined}>
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
                    <span className={q.errorRateLevel === "none" ? undefined : "rate-text-low"}>
                      {q.errorRate}% ({q.errorCount}/{q.totalCount})
                    </span>
                  </td>
                  <td style={{ padding: "8px 12px", textAlign: "right" }}>
                    <DifficultyBadge value={q.difficulty} bands={bands?.difficulty} />
                  </td>
                  <td style={{ padding: "8px 12px", textAlign: "right" }}>
                    <DiscriminationBadge value={q.discrimination} bands={bands?.discrimination} />
                  </td>
                  <td style={{ padding: "8px 12px", textAlign: "right" }}>
                    <span className={`error-level-badge error-level-${q.errorRateLevel}`}>
                      {errorLevelText(q.errorRateLevel)}
                    </span>
                  </td>
                  {onRowClick && (
                    <td style={{ padding: "8px 12px", textAlign: "right", color: "var(--brand)" }}>›</td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
