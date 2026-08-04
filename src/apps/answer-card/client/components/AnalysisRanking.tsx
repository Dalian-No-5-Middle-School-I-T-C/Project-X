import { useMemo } from "react";
import type { StudentRankingItem } from "../../../../shared/types";
import {
  Badge,
  DataTable,
  type BadgeProps,
  type ColumnDef,
} from "./ui/v2";

/**
 * AnalysisRanking —— T2 迁移（T03 支撑组件）
 *
 * 换肤范围（功能守恒，接口/路由/权限零改动）：
 *  · `.analysis-ranking-table-wrap/.analysis-ranking-table`（含 `background:#fff` 硬编码、
 *    sticky 表头、11 行高度上限）→ v2 `DataTable` + `wrapClassName` 高度限制
 *  · `.error-level-badge.error-level-*`（4 组硬编码 rgba）→ v2 `Badge` 语义 tone
 *  · `.rank-cell/.score-value` 等旧类 → Tailwind 语义类 + tabular-nums
 *
 * ⚠ 现状备注：本组件当前在客户端**无引用**（成绩列表统一走 ScoreTable）。
 *   为保证仓库内不残留旧 token，此处一并换肤；是否删除由后续清理决定。
 */

interface Props {
  ranking: StudentRankingItem[];
}

type ErrorLevel = StudentRankingItem["errorRateLevel"];

const ERROR_LEVEL_TEXT: Record<ErrorLevel, string> = {
  none: "正常",
  low: "低",
  medium: "中",
  high: "高",
};

const ERROR_LEVEL_TONE: Record<ErrorLevel, BadgeProps["tone"]> = {
  none: "neutral",
  low: "success",
  medium: "warning",
  high: "danger",
};

export function AnalysisRanking({ ranking }: Props) {
  const columns = useMemo<ColumnDef<StudentRankingItem, unknown>[]>(() => [
    {
      id: "rank",
      header: "#",
      sortDescFirst: false,
      sortingFn: (a, b) => a.original.rank - b.original.rank,
      meta: { widthClass: "w-12" },
      cell: ({ row }) => <span className="font-bold tabular-nums text-primary">{row.original.rank}</span>,
    },
    {
      id: "studentNumber",
      header: "学号",
      sortDescFirst: false,
      sortingFn: (a, b) =>
        String(a.original.studentNumber).localeCompare(String(b.original.studentNumber), "zh", { numeric: true }),
      cell: ({ row }) => <span className="tabular-nums text-muted-foreground">{row.original.studentNumber}</span>,
    },
    {
      id: "studentName",
      header: "姓名",
      sortDescFirst: false,
      sortingFn: (a, b) => String(a.original.studentName).localeCompare(String(b.original.studentName), "zh"),
      cell: ({ row }) => <span className="text-foreground">{row.original.studentName}</span>,
    },
    {
      id: "totalScore",
      header: "总分",
      sortDescFirst: true,
      sortingFn: (a, b) => a.original.totalScore - b.original.totalScore,
      meta: { numeric: true, widthClass: "w-20" },
      cell: ({ row }) => <span className="font-semibold tabular-nums">{row.original.totalScore}</span>,
    },
    {
      id: "objectiveScore",
      header: "客观",
      sortDescFirst: true,
      sortingFn: (a, b) => a.original.objectiveScore - b.original.objectiveScore,
      meta: { numeric: true, widthClass: "w-20" },
      cell: ({ row }) => <span className="tabular-nums">{row.original.objectiveScore}</span>,
    },
    {
      id: "subjectiveScore",
      header: "主观",
      sortDescFirst: true,
      sortingFn: (a, b) => a.original.subjectiveScore - b.original.subjectiveScore,
      meta: { numeric: true, widthClass: "w-20" },
      cell: ({ row }) => <span className="tabular-nums">{row.original.subjectiveScore}</span>,
    },
    {
      id: "errorRate",
      header: "低分题占比",
      sortDescFirst: true,
      sortingFn: (a, b) => a.original.errorRate - b.original.errorRate,
      meta: { numeric: true, widthClass: "w-36" },
      cell: ({ row }) => {
        const item = row.original;
        if (item.errorRateLevel === "none") {
          return <span className="text-muted-foreground">—</span>;
        }
        return (
          <span
            className="inline-flex items-center justify-end gap-1.5"
            title={`${item.lowScoreCount}/${item.questionCount} 题低于半分，约 ${item.errorRate}%`}
          >
            <Badge tone={ERROR_LEVEL_TONE[item.errorRateLevel]} dot>
              {ERROR_LEVEL_TEXT[item.errorRateLevel]}
            </Badge>
            <span className="tabular-nums">{item.errorRate}%</span>
          </span>
        );
      },
    },
  ], []);

  return (
    <section className="my-4 flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-foreground">学生排名</h3>
      <DataTable<StudentRankingItem>
        columns={columns}
        data={ranking}
        getRowId={(row) => String(row.studentNumber)}
        initialSorting={[{ id: "rank", desc: false }]}
        wrapClassName="max-h-[400px]"
        empty={<p className="py-6 text-center text-sm text-muted-foreground">暂无排名数据。</p>}
      />
    </section>
  );
}
