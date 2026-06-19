import type { ExamOverview, StudentRankingItem } from "../../../../shared/types";
import { AnalysisDistribution } from "./AnalysisDistribution";

interface Props {
  overview: ExamOverview | null;
  ranking?: StudentRankingItem[];
  previousComparison?: {
    prevExamName: string | null;
    avgScoreChange: number | null;
    passRateChange: number | null;
  };
  progressTop5?: Array<{ studentName: string; studentNumber?: string; rankChange: number }>;
  declineTop5?: Array<{ studentName: string; studentNumber?: string; rankChange: number }>;
}

function formatScore(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function AnalysisOverview({ overview, ranking, previousComparison, progressTop5, declineTop5 }: Props) {
  if (!overview) {
    return <div className="empty-text" style={{ padding: 40, textAlign: "center" }}>暂无数据，请先完成阅卷。</div>;
  }

  if (overview.gradedCount === 0) {
    return <div className="empty-text" style={{ padding: 40, textAlign: "center" }}>此考试暂无阅卷数据。</div>;
  }

  const visibleDistribution = overview.distribution.filter((d) => d.count > 0);
  const maxBarCount = Math.max(...visibleDistribution.map((d) => d.count), 1);

  return (
    <div>
      {/* Section 1: Info Cards */}
      <div className="overview-info-grid">
        <div className="overview-info-card">
          <span className="overview-info-value">{overview.gradedCount}</span>
          <span className="overview-info-label">考试人数</span>
        </div>
        <div className="overview-info-card">
          <span className="overview-info-value">{formatScore(overview.avgScore)}</span>
          <span className="overview-info-label">平均分</span>
        </div>
        <div className="overview-info-card">
          <span className="overview-info-value">{formatScore(overview.maxScore)}</span>
          <span className="overview-info-label">最高分</span>
        </div>
        <div className="overview-info-card">
          <span className="overview-info-value">{formatScore(overview.minScore)}</span>
          <span className="overview-info-label">最低分</span>
        </div>
        <div className="overview-info-card">
          <span className="overview-info-value">{overview.passRate}%</span>
          <span className="overview-info-label">及格率 (60%)</span>
        </div>
        <div className="overview-info-card">
          <span className="overview-info-value">{overview.excellentRate}%</span>
          <span className="overview-info-label">优秀率 (90%)</span>
        </div>
        <div className="overview-info-card">
          <span className="overview-info-value">{formatScore(overview.stdDev)}</span>
          <span className="overview-info-label">标准差</span>
        </div>
      </div>

      {/* Previous exam comparison */}
      {previousComparison && previousComparison.prevExamName && (
        <div className="overview-compare-bar">
          <span style={{ fontSize: 13, color: "var(--muted)" }}>
            对比上次 ({previousComparison.prevExamName}):
          </span>
          {previousComparison.avgScoreChange != null && (
            <span style={{
              fontSize: 13, fontWeight: 500,
              color: previousComparison.avgScoreChange >= 0 ? "#3B6D11" : "#A32D2D",
              marginLeft: 12
            }}>
              均分 {previousComparison.avgScoreChange >= 0 ? "↑" : "↓"} {Math.abs(previousComparison.avgScoreChange).toFixed(1)}
            </span>
          )}
          {previousComparison.passRateChange != null && (
            <span style={{
              fontSize: 13, fontWeight: 500,
              color: previousComparison.passRateChange >= 0 ? "#3B6D11" : "#A32D2D",
              marginLeft: 12
            }}>
              及格率 {previousComparison.passRateChange >= 0 ? "↑" : "↓"} {Math.abs(previousComparison.passRateChange).toFixed(1)}%
            </span>
          )}
        </div>
      )}

      {/* Section 2: Score Distribution Bar Chart */}
      <div className="analysis-section" style={{ marginTop: 20 }}>
        <div className="panel-title">分数段分布</div>
        <div className="dist-bar-chart">
          {visibleDistribution.map((d, i) => {
            const pct = ((d.count / overview.gradedCount) * 100).toFixed(1);
            const barPct = (d.count / maxBarCount) * 100;
            const lastIdx = visibleDistribution.length - 1;
            let barColor = "var(--brand)";
            if (i === 0) barColor = "#E24B4A";      // 最低分段 → 红
            else if (i === lastIdx) barColor = "#639922"; // 最高分段 → 绿

            return (
              <div key={d.range} className="dist-bar-row">
                <span className="dist-bar-label">{d.range}</span>
                <div className="dist-bar-track">
                  <div
                    className="dist-bar-fill"
                    style={{
                      width: `${Math.max(barPct, 2)}%`,
                      background: barColor
                    }}
                  />
                </div>
                <span className="dist-bar-count">{d.count}人</span>
                <span className="dist-bar-pct">{pct}%</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Section 3: Box Plot */}
      {overview.scoreSummary && overview.overallScoreSummary && (
        <AnalysisDistribution
          summary={overview.scoreSummary}
          overallSummary={overview.overallScoreSummary}
          classSummaries={overview.classSummaries}
        />
      )}

      {/* Section 4: Grade Rankings (top5/bottom5 by score) */}
      {ranking && ranking.length > 0 && (
        <div style={{ marginTop: 20, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <div className="analysis-section">
            <div className="panel-title">年级前五</div>
            {ranking.slice(0, 5).map((r) => (
              <div key={r.studentName} style={rankRowStyle}>
                <span style={rankNumStyle("#3B6D11")}>#{r.rank}</span>
                <span>{r.studentName}</span>
                <span style={{ color: "var(--muted)", fontSize: 12 }}>{formatScore(r.totalScore)}分</span>
              </div>
            ))}
          </div>
          <div className="analysis-section">
            <div className="panel-title">年级后五</div>
            {ranking.slice(-5).reverse().map((r) => (
              <div key={r.studentName} style={rankRowStyle}>
                <span style={rankNumStyle("#A32D2D")}>#{r.rank}</span>
                <span>{r.studentName}</span>
                <span style={{ color: "var(--muted)", fontSize: 12 }}>{formatScore(r.totalScore)}分</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Section 5: Progress & Decline Rankings (rankChange-based) */}
      <div style={{ marginTop: 20, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div className="analysis-section">
          <div className="panel-title">进步前五</div>
          {progressTop5 && progressTop5.length > 0 ? (
            progressTop5.map((r, i) => (
              <div key={r.studentName} style={rankRowStyle}>
                <span style={rankNumStyle("#3B6D11")}>↑ {Math.abs(r.rankChange)}</span>
                <span>{r.studentName}</span>
                {r.studentNumber && <span style={{ color: "var(--muted)", fontSize: 12 }}>{r.studentNumber}</span>}
              </div>
            ))
          ) : (
            <div style={{ padding: "12px 0", color: "var(--muted)", fontSize: 13, textAlign: "center" }}>暂无数据</div>
          )}
        </div>
        <div className="analysis-section">
          <div className="panel-title">退步前五</div>
          {declineTop5 && declineTop5.length > 0 ? (
            declineTop5.map((r, i) => (
              <div key={r.studentName} style={rankRowStyle}>
                <span style={rankNumStyle("#A32D2D")}>↓ {Math.abs(r.rankChange)}</span>
                <span>{r.studentName}</span>
                {r.studentNumber && <span style={{ color: "var(--muted)", fontSize: 12 }}>{r.studentNumber}</span>}
              </div>
            ))
          ) : (
            <div style={{ padding: "12px 0", color: "var(--muted)", fontSize: 13, textAlign: "center" }}>暂无数据</div>
          )}
        </div>
      </div>
    </div>
  );
}

const rankRowStyle: React.CSSProperties = {
  display: "flex", gap: 10, padding: "3px 0", fontSize: 13, alignItems: "center"
};
const rankNumStyle = (color: string): React.CSSProperties => ({
  fontWeight: 600, color, minWidth: 32, fontSize: 12
});
