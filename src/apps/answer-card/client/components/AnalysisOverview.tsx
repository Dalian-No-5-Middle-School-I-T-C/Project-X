import type { ExamOverview, StudentRankingItem } from "../../../../shared/types";
import { cn } from "../lib/utils";
import { AnalysisDistribution } from "./AnalysisDistribution";
import { ScoreDoughnut } from "./AnalysisCharts";
import { formatScore } from "../util/format";
import {
  EmptyState,
  Progress,
  StatCard,
  StatCardRow,
  type ProgressTone,
} from "./ui/v2";

/**
 * AnalysisOverview —— T2 迁移（T03 主分析页 + 图表子树）
 *
 * 换肤范围（功能守恒，接口/路由/权限零改动）：
 *  · `.overview-info-grid/.overview-info-card/.overview-info-value/.overview-info-label`
 *    → v2 `StatCard` / `StatCardRow`
 *  · `.overview-compare-bar` 里的硬编码涨跌绿／红 → StatCard 的 delta 语义着色
 *  · `.dist-bar-chart/.dist-bar-*` 手写条形（含硬编码红／绿）
 *    → v2 `Progress` + tone 分档（首段=destructive，末段=success，其余=primary）
 *  · 榜单 `rankRowStyle/rankNumStyle` 两个 style 工厂 → Tailwind 语义类
 *
 * ⚠ 现状备注：本组件当前在客户端**无引用**（ScoreDetailPage 已内联「概况」Tab）。
 *   为保证仓库内不残留旧 token，此处一并换肤；是否删除由后续清理决定。
 */

interface Props {
  overview: ExamOverview | null;
  ranking?: StudentRankingItem[];
  selectedClassId?: string;
  onClassSelect?: (classId: string) => void;
  previousComparison?: {
    prevExamName: string | null;
    avgScoreChange: number | null;
    passRateChange: number | null;
  };
  progressTop5?: Array<{ studentName: string; studentNumber?: string; rankChange: number }>;
  declineTop5?: Array<{ studentName: string; studentNumber?: string; rankChange: number }>;
}

/** 分段条着色：最低分段红、最高分段绿、其余品牌色（与旧版三色一致，改走语义 token） */
function segmentTone(index: number, lastIndex: number): ProgressTone {
  if (index === 0) return "destructive";
  if (index === lastIndex) return "success";
  return "primary";
}

function RankPanel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1 rounded-lg border border-border-subtle bg-card px-4 py-3">
      <h3 className="mb-1 text-sm font-semibold text-foreground">{title}</h3>
      {children}
    </section>
  );
}

export function AnalysisOverview({
  overview,
  ranking,
  selectedClassId = "",
  onClassSelect,
  previousComparison,
  progressTop5,
  declineTop5
}: Props) {
  if (!overview) {
    return <EmptyState title="暂无数据" description="请先完成阅卷。" />;
  }

  if (overview.gradedCount === 0) {
    return <EmptyState title="此考试暂无阅卷数据" description="完成阅卷后即可查看概况。" />;
  }

  const visibleDistribution = overview.distribution.filter((d) => d.count > 0);
  const maxBarCount = Math.max(...visibleDistribution.map((d) => d.count), 1);
  const lastIdx = visibleDistribution.length - 1;

  return (
    <div className="flex flex-col gap-5">
      {/* Section 1: Info Cards */}
      <StatCardRow>
        <StatCard label="考试人数" value={String(overview.gradedCount)} />
        <StatCard label="平均分" value={formatScore(overview.avgScore)} />
        <StatCard label="最高分" value={formatScore(overview.maxScore)} />
        <StatCard label="最低分" value={formatScore(overview.minScore)} />
        <StatCard label="及格率 (60%)" value={`${overview.passRate}%`} />
        <StatCard label="优秀率 (90%)" value={`${overview.excellentRate}%`} />
        <StatCard label="标准差" value={formatScore(overview.stdDev)} />
      </StatCardRow>

      {/* Previous exam comparison */}
      {previousComparison && previousComparison.prevExamName && (
        <div className="flex flex-wrap items-center gap-4 rounded-lg border border-border-subtle bg-card px-4 py-3">
          <span className="text-sm text-muted-foreground">
            对比上次（{previousComparison.prevExamName}）
          </span>
          {previousComparison.avgScoreChange != null && (
            <span
              className={cn(
                "text-sm font-medium tabular-nums",
                previousComparison.avgScoreChange >= 0 ? "text-success-foreground" : "text-destructive-fg",
              )}
            >
              均分 {previousComparison.avgScoreChange >= 0 ? "+" : "−"}
              {Math.abs(previousComparison.avgScoreChange).toFixed(1)}
            </span>
          )}
          {previousComparison.passRateChange != null && (
            <span
              className={cn(
                "text-sm font-medium tabular-nums",
                previousComparison.passRateChange >= 0 ? "text-success-foreground" : "text-destructive-fg",
              )}
            >
              及格率 {previousComparison.passRateChange >= 0 ? "+" : "−"}
              {Math.abs(previousComparison.passRateChange).toFixed(1)}%
            </span>
          )}
        </div>
      )}

      {/* Section 2: Score Distribution Bar Chart */}
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-foreground">分数段分布</h3>
        <div className="flex flex-col gap-1.5 rounded-lg border border-border-subtle bg-card px-4 py-3">
          {visibleDistribution.map((d, i) => {
            const pct = ((d.count / overview.gradedCount) * 100).toFixed(1);
            const barPct = (d.count / maxBarCount) * 100;
            return (
              <div key={d.range} className="flex items-center gap-3 text-xs">
                <span className="w-20 shrink-0 tabular-nums text-muted-foreground">{d.range}</span>
                <Progress
                  value={Math.max(barPct, 2)}
                  tone={segmentTone(i, lastIdx)}
                  size="sm"
                  className="min-w-0 flex-1"
                />
                <span className="w-12 shrink-0 text-right tabular-nums text-foreground">{d.count}人</span>
                <span className="w-14 shrink-0 text-right tabular-nums text-muted-foreground">{pct}%</span>
              </div>
            );
          })}
        </div>
      </section>

      {/* Section 3: Box Plot */}
      {overview.scoreSummary && overview.overallScoreSummary && (
        <AnalysisDistribution
          summary={overview.scoreSummary}
          overallSummary={overview.overallScoreSummary}
          classSummaries={overview.classSummaries}
          selectedClassId={selectedClassId}
          onClassSelect={onClassSelect}
        />
      )}

      {/* Section 4: Grade Rankings (top5/bottom5 by score) */}
      {ranking && ranking.length > 0 && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <RankPanel title="年级前五">
            {ranking.slice(0, 5).map((r) => (
              <div key={r.studentName} className="flex items-center gap-2.5 py-0.5 text-sm">
                <span className="min-w-8 font-semibold tabular-nums text-success-foreground">#{r.rank}</span>
                <span className="truncate text-foreground">{r.studentName}</span>
                <span className="ml-auto text-xs tabular-nums text-muted-foreground">{formatScore(r.totalScore)}分</span>
              </div>
            ))}
          </RankPanel>
          <RankPanel title="年级后五">
            {ranking.slice(-5).reverse().map((r) => (
              <div key={r.studentName} className="flex items-center gap-2.5 py-0.5 text-sm">
                <span className="min-w-8 font-semibold tabular-nums text-destructive-fg">#{r.rank}</span>
                <span className="truncate text-foreground">{r.studentName}</span>
                <span className="ml-auto text-xs tabular-nums text-muted-foreground">{formatScore(r.totalScore)}分</span>
              </div>
            ))}
          </RankPanel>
        </div>
      )}

      {/* Section 5: Progress & Decline Rankings (rankChange-based) */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <RankPanel title="进步前五">
          {progressTop5 && progressTop5.length > 0 ? (
            progressTop5.map((r, i) => (
              <div key={`${r.studentName}-${i}`} className="flex items-center gap-2.5 py-0.5 text-sm">
                <span className="min-w-8 font-semibold tabular-nums text-success-foreground">↑ {Math.abs(r.rankChange)}</span>
                <span className="truncate text-foreground">{r.studentName}</span>
                {r.studentNumber && <span className="ml-auto text-xs tabular-nums text-muted-foreground">{r.studentNumber}</span>}
              </div>
            ))
          ) : (
            <p className="py-3 text-center text-sm text-muted-foreground">暂无数据</p>
          )}
        </RankPanel>
        <RankPanel title="退步前五">
          {declineTop5 && declineTop5.length > 0 ? (
            declineTop5.map((r, i) => (
              <div key={`${r.studentName}-${i}`} className="flex items-center gap-2.5 py-0.5 text-sm">
                <span className="min-w-8 font-semibold tabular-nums text-destructive-fg">↓ {Math.abs(r.rankChange)}</span>
                <span className="truncate text-foreground">{r.studentName}</span>
                {r.studentNumber && <span className="ml-auto text-xs tabular-nums text-muted-foreground">{r.studentNumber}</span>}
              </div>
            ))
          ) : (
            <p className="py-3 text-center text-sm text-muted-foreground">暂无数据</p>
          )}
        </RankPanel>
      </div>

      {/* Section 6: Chart visualization */}
      {overview.distribution && overview.distribution.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-foreground">图表可视化</h3>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="rounded-lg border border-border-subtle bg-card p-4">
              <ScoreDoughnut
                data={{
                  labels: overview.distribution.map((d) => d.range),
                  values: overview.distribution.map((d) => d.count),
                }}
                height={200}
              />
            </div>
            <div className="flex flex-col gap-2.5 rounded-lg border border-border-subtle bg-card p-4 text-sm">
              {[
                { label: "标准差", value: formatScore(overview.stdDev) },
                { label: "及格率", value: `${overview.passRate}%` },
                { label: "优秀率", value: `${overview.excellentRate}%` },
                { label: "最高分", value: formatScore(overview.maxScore) },
                { label: "最低分", value: formatScore(overview.minScore) },
              ].map((item) => (
                <div key={item.label} className="flex items-center justify-between">
                  <span className="text-secondary-foreground">{item.label}</span>
                  <span className="font-semibold tabular-nums text-foreground">{item.value}</span>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
