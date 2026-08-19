import { useEffect, useState } from "react";
import { fetchJson } from "../auth/api";
import type { SubjectQualityResponse } from "../../../../shared/types";
import { Badge, EmptyState } from "./ui/v2";
import { TrendLine } from "./AnalysisCharts";

/**
 * 建议 15：学科命题质量趋势追踪。
 * 数据源：GET /api/analysis/subject-quality?subject=。
 * 历次考试的难度 P / 区分度 D 画成趋势线，帮助命题老师发现「区分度持续偏低」等问题。
 */
export function QualityTrendPanel({ subject }: { subject: string | null }) {
  const [data, setData] = useState<SubjectQualityResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!subject) { setData(null); setLoading(false); return; }
    setLoading(true);
    fetchJson<SubjectQualityResponse>(`/api/analysis/subject-quality?subject=${encodeURIComponent(subject)}`)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [subject]);

  if (!subject) return null;
  if (loading) return <p className="py-4 text-center text-sm text-muted-foreground">加载命题质量趋势...</p>;
  if (!data || data.points.length < 2) return null;

  const labels = data.points.map((p) => `${p.examName}${p.examDate ? `(${p.examDate.slice(5)})` : ""}`);

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border-subtle bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-foreground">命题质量趋势（{data.subject}）</h3>
        <Badge tone="neutral">难度系数 P = 得分率（越高越容易）；区分度 D &lt; 0.3 需关注</Badge>
      </div>
      <TrendLine
        data={{
          labels,
          datasets: [
            { label: "难度系数 P%", data: data.points.map((p) => Math.round(p.difficulty * 1000) / 10) },
            { label: "区分度 D%", data: data.points.map((p) => Math.round(p.discrimination * 1000) / 10), dashed: true },
          ],
        }}
        height={260}
      />
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>共 {data.points.length} 场有出分的考试</span>
        <span>平均难度 {Math.round(data.points.reduce((s, p) => s + p.difficulty, 0) / data.points.length * 1000) / 1000}</span>
        <span>
          平均区分度 {Math.round(data.points.reduce((s, p) => s + p.discrimination, 0) / data.points.length * 1000) / 1000}
        </span>
      </div>
    </section>
  );
}

/** 未达到两场考试时提示（可选引用）。 */
export function QualityTrendEmpty() {
  return <EmptyState size="sm" title="暂无趋势数据" description="至少两场同科考试出分后展示命题质量趋势。" />;
}
