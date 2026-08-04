import { useMemo } from "react";
import { ChevronRight } from "lucide-react";
import type { QuestionAnalysisItem } from "../../../../shared/types";
import type { ThresholdBand } from "../../../../shared/stats";
import { cn } from "../lib/utils";
import { DifficultyBadge, DiscriminationBadge } from "./MetricBadge";
import {
  Badge,
  DataTable,
  Progress,
  type BadgeProps,
  type ColumnDef,
} from "./ui/v2";

/**
 * AnalysisQuestions —— T2 迁移（T03 主分析页 + 图表子树）
 *
 * 换肤范围（功能守恒，接口/路由/权限零改动）：
 *  · 手写 `<table>` + 自研 sortKey/sortDir 状态 → v2 `DataTable`（TanStack）
 *    首次点击方向与旧实现逐列对齐：题号/错误率/难度 升序优先，其余降序优先
 *  · `.rate-bar-container/.rate-bar/.rate-bar-low`（青绿→红渐变）→ v2 `Progress` + tone 分档
 *  · `.error-level-badge.error-level-*`（4 组硬编码 rgba）→ v2 `Badge` 语义 tone
 *  · `.analysis-section/.panel-title/.empty-text` → Tailwind 语义类
 *  · 行 hover 由 onMouseEnter 直改 style → `TableRow` 内建 clickable 态
 */

interface Props {
  questions: QuestionAnalysisItem[];
  bands?: { difficulty: ThresholdBand[]; discrimination: ThresholdBand[] };
  /** 点击某题行（逐题下钻全班得分）。提供则整行可点击。 */
  onRowClick?: (questionNumber: string) => void;
}

type ErrorLevel = QuestionAnalysisItem["errorRateLevel"];

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

function errorLevelText(level: ErrorLevel): string {
  return ERROR_LEVEL_TEXT[level] ?? "正常";
}

/** null 视为最小值（与旧实现 `va == null → -1` 一致） */
function nullableNumberCompare(a: number | null | undefined, b: number | null | undefined): number {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  return a - b;
}

export function AnalysisQuestions({ questions, bands, onRowClick }: Props) {
  const columns = useMemo<ColumnDef<QuestionAnalysisItem, unknown>[]>(() => {
    const base: ColumnDef<QuestionAnalysisItem, unknown>[] = [
      {
        id: "questionNumber",
        header: "题号",
        sortDescFirst: false,
        sortingFn: (a, b) => Number(a.original.questionNumber) - Number(b.original.questionNumber),
        meta: { widthClass: "w-16" },
        cell: ({ row }) => (
          <span className="font-medium tabular-nums">{row.original.questionNumber}</span>
        ),
      },
      {
        id: "questionType",
        header: "类型",
        sortDescFirst: true,
        sortingFn: (a, b) =>
          String(a.original.questionType).localeCompare(String(b.original.questionType), "zh"),
        meta: { widthClass: "w-16" },
        cell: ({ row }) => <span className="text-muted-foreground">{row.original.questionType}</span>,
      },
      {
        id: "scoreRate",
        header: "得分率",
        sortDescFirst: true,
        sortingFn: (a, b) => nullableNumberCompare(a.original.scoreRate, b.original.scoreRate),
        meta: { widthClass: "w-40" },
        cell: ({ row }) => {
          const rate = row.original.scoreRate;
          const isLow = rate < 60;
          return (
            <div className="flex items-center gap-2">
              <Progress
                value={rate}
                size="sm"
                tone={isLow ? "destructive" : "primary"}
                className="w-15 shrink-0"
              />
              <span
                className={cn(
                  "text-xs font-semibold tabular-nums",
                  isLow ? "text-destructive-fg" : "text-foreground",
                )}
              >
                {rate}%
              </span>
            </div>
          );
        },
      },
      {
        id: "correctRate",
        header: "正确率",
        sortDescFirst: true,
        sortingFn: (a, b) => nullableNumberCompare(a.original.correctRate, b.original.correctRate),
        meta: { numeric: true, widthClass: "w-20" },
        cell: ({ row }) => {
          const v = row.original.correctRate;
          if (v === null) return <span className="text-muted-foreground">—</span>;
          return (
            <span className={cn("tabular-nums", v < 60 && "font-semibold text-destructive-fg")}>
              {v}%
            </span>
          );
        },
      },
      {
        id: "avgScore",
        header: "平均分",
        sortDescFirst: true,
        sortingFn: (a, b) => nullableNumberCompare(a.original.avgScore, b.original.avgScore),
        meta: { numeric: true, widthClass: "w-20" },
        cell: ({ row }) => <span className="tabular-nums">{row.original.avgScore}</span>,
      },
      {
        id: "maxScore",
        header: "满分",
        sortDescFirst: true,
        sortingFn: (a, b) => nullableNumberCompare(a.original.maxScore, b.original.maxScore),
        meta: { numeric: true, widthClass: "w-16" },
        cell: ({ row }) => <span className="tabular-nums">{row.original.maxScore}</span>,
      },
      {
        id: "errorRate",
        header: "错误/低分率",
        sortDescFirst: false,
        sortingFn: (a, b) => nullableNumberCompare(a.original.errorRate, b.original.errorRate),
        meta: { numeric: true, widthClass: "w-28" },
        cell: ({ row }) => {
          const q = row.original;
          return (
            <span
              className={cn(
                "tabular-nums",
                q.errorRateLevel !== "none" && "font-semibold text-destructive-fg",
              )}
            >
              {q.errorRate}% ({q.errorCount}/{q.totalCount})
            </span>
          );
        },
      },
      {
        id: "difficulty",
        header: "难度系数 P",
        sortDescFirst: false,
        sortingFn: (a, b) => nullableNumberCompare(a.original.difficulty, b.original.difficulty),
        meta: { numeric: true, widthClass: "w-32" },
        cell: ({ row }) => <DifficultyBadge value={row.original.difficulty} bands={bands?.difficulty} />,
      },
      {
        id: "discrimination",
        header: "区分度 D",
        sortDescFirst: true,
        sortingFn: (a, b) => nullableNumberCompare(a.original.discrimination, b.original.discrimination),
        meta: { numeric: true, widthClass: "w-32" },
        cell: ({ row }) => (
          <DiscriminationBadge value={row.original.discrimination} bands={bands?.discrimination} />
        ),
      },
      {
        id: "errorRateLevel",
        header: "档位",
        enableSorting: false,
        meta: { numeric: true, widthClass: "w-20" },
        cell: ({ row }) => (
          <Badge tone={ERROR_LEVEL_TONE[row.original.errorRateLevel]} dot>
            {errorLevelText(row.original.errorRateLevel)}
          </Badge>
        ),
      },
    ];

    if (onRowClick) {
      base.push({
        id: "drill",
        header: "下钻",
        enableSorting: false,
        meta: { action: true, widthClass: "w-12" },
        cell: () => <ChevronRight className="ml-auto size-4 text-primary" aria-hidden />,
      });
    }
    return base;
  }, [bands, onRowClick]);

  if (!questions || questions.length === 0) {
    return (
      <section className="my-4 flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-foreground">题目分析</h3>
        <p className="py-6 text-center text-sm text-muted-foreground">暂无题目数据。</p>
      </section>
    );
  }

  return (
    <section className="my-4 flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-foreground">
        题目得分率排行{onRowClick ? "（点击题目可下钻全班得分）" : ""}
      </h3>
      <DataTable<QuestionAnalysisItem>
        columns={columns}
        data={questions}
        getRowId={(row) => `${row.questionNumber}-${row.questionType}`}
        initialSorting={[{ id: "questionNumber", desc: false }]}
        onRowClick={onRowClick ? (row) => onRowClick(row.questionNumber) : undefined}
      />
    </section>
  );
}
