import type { ExamOverview } from "../../../../shared/types";
import { AnalysisDistribution } from "./AnalysisDistribution";

interface Props {
  overview: ExamOverview | null;
  previousComparison?: {
    prevExamName: string | null;
    avgScoreChange: number | null;
    passRateChange: number | null;
  };
}

function formatScore(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function AnalysisOverview({ overview, previousComparison }: Props) {
  if (!overview) {
    return <div className="empty-text" style={{ padding: 40, textAlign: "center" }}>暂无数据，请先完成阅卷。</div>;
  }

  if (overview.gradedCount === 0) {
    return <div className="empty-text" style={{ padding: 40, textAlign: "center" }}>此考试暂无阅卷数据。</div>;
  }

  const maxBarCount = Math.max(...overview.distribution.map((d) => d.count), 1);

  return (
    <div>
      {/* Section 1: Info Cards */}
      <div className="overview-info-grid">
        <div className="overview-info-card">
          <span className="overview-info-value">{overview.gradedCount}</span>
          <span className="overview-info-label">考试人数</span>
        </div>
        <div className="overview-info-card highlight">
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
          <span className="overview-info-label">及格率 (60+)</span>
        </div>
        <div className="overview-info-card">
          <span className="overview-info-value">{overview.excellentRate}%</span>
          <span className="overview-info-label">优秀率 (85+)</span>
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
          {overview.distribution.map((d) => {
            const pct = ((d.count / overview.gradedCount) * 100).toFixed(1);
            const barPct = (d.count / maxBarCount) * 100;
            const isBelowPass = d.range === "0-59";
            const isHigh = d.range === "90-100";
            let barColor = "var(--brand)";
            if (isBelowPass) barColor = "#E24B4A";
            else if (isHigh) barColor = "#639922";

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
    </div>
  );
}
