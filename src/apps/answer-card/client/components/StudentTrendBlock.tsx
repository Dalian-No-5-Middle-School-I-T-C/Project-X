import { useEffect, useState } from "react";
import { fetchJson } from "../auth/api";
import type { StudentTrendPoint } from "../../../../shared/types";
import { TrendLine } from "./AnalysisCharts";
import { EmptyState } from "./ui/v2";

/**
 * 建议 3：学生个人跨考试成长曲线（得分率 + 年级百分位双线）。
 * 数据源：GET /api/analysis/students/:studentId/trend。
 */
export function StudentTrendBlock({ studentId }: { studentId: number }) {
  const [points, setPoints] = useState<StudentTrendPoint[] | null>(null);

  useEffect(() => {
    fetchJson<StudentTrendPoint[]>(`/api/analysis/students/${studentId}/trend`)
      .then(setPoints)
      .catch(() => setPoints([]));
  }, [studentId]);

  if (points === null) {
    return <div className="py-4 text-center text-sm text-muted-foreground">加载成长趋势...</div>;
  }
  if (points.length === 0) return null;

  return (
    <section className="mt-4 rounded-lg border border-border-subtle bg-card p-3">
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">成长趋势（跨考试）</h3>
        <span className="text-xs text-muted-foreground">得分率 % ｜ 年级百分位（两线均为 0-100）</span>
      </div>
      <TrendLine
        data={{
          labels: points.map((p) => p.examName),
          datasets: [
            { label: "得分率%", data: points.map((p) => p.scoreRate ?? null) },
            { label: "年级百分位", data: points.map((p) => p.percentile), dashed: true },
          ],
        }}
        height={220}
      />
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {points.slice(-3).reverse().map((p) => (
          <span key={p.examId} className="inline-flex items-center gap-1">
            <span className="max-w-32 truncate font-medium text-foreground">{p.examName}</span>
            <span className="tabular-nums">{p.totalScore}分</span>
            <span className="tabular-nums">班{p.classAvg} 年{p.gradeAvg}</span>
            <span className="tabular-nums">名次{p.rank}</span>
          </span>
        ))}
      </div>
    </section>
  );
}

/** 空态占位（无历史成绩时不渲染，此组件直接返回 null）。 */
export function StudentTrendEmpty() {
  return <EmptyState size="sm" title="暂无历史成绩" description="该学生还没有其它考试的记录。" />;
}
