import type { ExamOverview } from "../../../../shared/types";

interface Props {
  overview: ExamOverview | null;
}

export function AnalysisOverview({ overview }: Props) {
  if (!overview) {
    return <div className="empty-text">暂无数据，请先完成阅卷。</div>;
  }

  if (overview.gradedCount === 0) {
    return <div className="empty-text">此考试暂无阅卷数据。</div>;
  }

  const cards: Array<{ label: string; value: string; sub?: string }> = [
    { label: "已阅卷", value: String(overview.gradedCount), sub: "人" },
    { label: "平均分", value: String(overview.avgScore) },
    { label: "最高分", value: String(overview.maxScore) },
    { label: "最低分", value: String(overview.minScore) },
    { label: "及格率", value: `${overview.passRate}%` },
    { label: "优秀率", value: `${overview.excellentRate}%` },
    { label: "标准差", value: String(overview.stdDev) },
    { label: "错误率高于 30%", value: String(overview.highErrorQuestionCount), sub: "题" },
    { label: "低错误率 30-49%", value: String(overview.errorRateBuckets.low), sub: "题" },
    { label: "中错误率 50-69%", value: String(overview.errorRateBuckets.medium), sub: "题" },
    { label: "高错误率 70%+", value: String(overview.errorRateBuckets.high), sub: "题" }
  ];

  return (
    <div className="analysis-cards">
      {cards.map((card) => (
        <div key={card.label} className="analysis-card">
          <span className="analysis-card-value">
            {card.value}
            {card.sub && <small>{card.sub}</small>}
          </span>
          <span className="analysis-card-label">{card.label}</span>
        </div>
      ))}
    </div>
  );
}
