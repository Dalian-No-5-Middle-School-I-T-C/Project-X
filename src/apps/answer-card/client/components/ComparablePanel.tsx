import { useEffect, useState } from "react";
import { fetchJson } from "../auth/api";
import { formatScore } from "../util/format";
import type { ComparableResponse } from "../../../../shared/types";
import {
  Badge,
  EmptyState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableWrap,
} from "./ui/v2";
import { ComparisonBar, TrendLine } from "./AnalysisCharts";

/**
 * 建议 14：年级间同类考试对比（同答题卡模板跨年级）。
 * 数据源：GET /api/analysis/exams/:examId/comparable。
 */
export function ComparablePanel({ examId }: { examId: number }) {
  const [data, setData] = useState<ComparableResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchJson<ComparableResponse>(`/api/analysis/exams/${examId}/comparable`)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [examId]);

  if (loading) return <p className="py-4 text-center text-sm text-muted-foreground">加载同类考试...</p>;
  if (!data || data.exams.length <= 1) return null;

  const labelOf = (e: ComparableResponse["exams"][number]) =>
    `${e.examName}${e.gradeName ? `（${e.gradeName}）` : ""}`;

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border-subtle bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-foreground">年级间同类考试对比</h3>
        <Badge tone="neutral">同答题卡模板（{data.cardTitle || "无标题"}）共 {data.exams.length} 场</Badge>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-2">
          <h4 className="text-xs font-semibold text-muted-foreground">各场平均分对比</h4>
          <ComparisonBar
            data={{
              labels: data.exams.map(labelOf),
              datasets: [{ label: "平均分", data: data.exams.map((e) => e.avgScore) }],
            }}
            height={240}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <h4 className="text-xs font-semibold text-muted-foreground">难度系数 P / 区分度 D（0-100%）</h4>
          <TrendLine
            data={{
              labels: data.exams.map(labelOf),
              datasets: [
                { label: "难度系数 P%", data: data.exams.map((e) => Math.round(e.difficulty * 1000) / 10) },
                { label: "区分度 D%", data: data.exams.map((e) => Math.round(e.discrimination * 1000) / 10), dashed: true },
              ],
            }}
            height={240}
          />
        </div>
      </div>

      <TableWrap>
        <Table className="text-sm">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>考试</TableHead>
              <TableHead>年级</TableHead>
              <TableHead>日期</TableHead>
              <TableHead numeric>人数</TableHead>
              <TableHead numeric>均分</TableHead>
              <TableHead numeric>标准差</TableHead>
              <TableHead numeric>难度 P</TableHead>
              <TableHead numeric>区分度 D</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.exams.map((e) => (
              <TableRow key={e.examId} selected={e.examId === data.currentExamId}>
                <TableCell className="font-medium text-foreground">{e.examName}</TableCell>
                <TableCell className="text-muted-foreground">{e.gradeName ?? "—"}</TableCell>
                <TableCell className="tabular-nums text-muted-foreground">{e.examDate ?? "—"}</TableCell>
                <TableCell numeric>{e.gradedCount}</TableCell>
                <TableCell numeric className="font-semibold tabular-nums">{formatScore(e.avgScore)}</TableCell>
                <TableCell numeric className="tabular-nums">{formatScore(e.stdDev)}</TableCell>
                <TableCell numeric className="tabular-nums">{e.difficulty.toFixed(3)}</TableCell>
                <TableCell numeric className="tabular-nums">{e.discrimination.toFixed(3)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableWrap>
    </section>
  );
}
