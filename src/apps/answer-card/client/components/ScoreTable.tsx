import { useEffect, useMemo, useState } from "react";
import { Minus, Search } from "lucide-react";
import { fetchJson, mediaUrl } from "../auth/api";
import { useIsMobile } from "../hooks/useMediaQuery";
import { cn } from "../lib/utils";
import { DataCard } from "./ui/DataCard";
import { formatScore } from "../util/format";
import type { ScoreTableRow, ScoreDisplayMode } from "../../../../shared/types";
import { ScanPreviewModal, type ScanPage } from "./ScanPreviewModal";
import {
  Button,
  DataTable,
  EmptyState,
  ErrorState,
  Input,
  type ColumnDef,
} from "./ui/v2";

/**
 * ScoreTable —— T2 迁移（T04 明细/订正/弹窗）
 *
 * 换肤范围（功能守恒，接口/路由/权限零改动）：
 *  · 桌面端手写 `<table>` + 斑马纹 + 手写排序箭头 → v2 `DataTable`
 *    （排序比较逐条搬运：`Number(a ?? 0) - Number(b ?? 0)`，一律先升序；
 *     初始排序键仍随 `classId` 走班排/年排，靠 `key` 重挂载复位）
 *  · 硬编码 `#3B6D11` / `#A32D2D` 名次涨跌色 → `text-success-foreground` / `text-destructive-fg`
 *  · 搜索框、预览按钮 → v2 `Input` / `Button`
 *  · 移动端 `DataCard` 分支保留（CardSelectPage / ExamManagePage 仍在用该组件），
 *    仅把内联样式换成语义类
 */

interface Props {
  examId: number;
  classId?: string;
  displayMode?: ScoreDisplayMode;
  onRowClick?: (studentId: number, studentName: string, studentNumber: string) => void;
}

type SortKey = "totalScore" | "gradeRank" | "classRank" | "displayValue" | "rankChange";

function modeLabel(m: ScoreDisplayMode): string {
  return m === "deviation" ? "偏差值" : m === "zscore" ? "Z值" : "百分位";
}

/** 与迁移前一致：null/undefined 视作 0 后按数值比较 */
function numericCompare(a: number | null | undefined, b: number | null | undefined): number {
  return Number(a ?? 0) - Number(b ?? 0);
}

export function ScoreTable({ examId, classId, displayMode: propDisplayMode, onRowClick }: Props) {
  const isMobile = useIsMobile();
  const [rows, setRows] = useState<ScoreTableRow[]>([]);
  const [hasAssigned, setHasAssigned] = useState(false);
  const [totalCount, setTotalCount] = useState(0);
  const displayMode = propDisplayMode || "deviation";
  const displayLabel = modeLabel(displayMode);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Preview modal state
  const [previewPages, setPreviewPages] = useState<ScanPage[] | null>(null);
  const [previewTitle, setPreviewTitle] = useState("");
  const [previewSubtitle, setPreviewSubtitle] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);

  async function openPreview(studentId: number, studentName: string, studentNumber: string) {
    setPreviewTitle(`学号: ${studentNumber} · ${studentName}`);
    setPreviewSubtitle("正在加载答题卡...");
    setPreviewPages([]);
    setPreviewLoading(true);
    try {
      const data = await fetchJson<{
        pages: Array<{ recordId: string; pageNum: number; side: string; fileName: string }>;
        cardId: string;
      }>(`/api/scanner/exam/${examId}/student/${studentId}/scans`);
      if (data.pages.length === 0) {
        setPreviewSubtitle("暂无答题卡扫描记录（旧考试需重新阅卷）");
      } else {
        setPreviewSubtitle(`${data.pages.length} 页`);
        const pages: ScanPage[] = data.pages.map((p) => ({
          recordId: p.recordId,
          pageNum: p.pageNum,
          side: p.side,
          imageUrl: mediaUrl(`/api/scanner/grading-image/${data.cardId}/${encodeURIComponent(p.fileName)}`)
        }));
        setPreviewPages(pages);
      }
    } catch {
      setPreviewSubtitle("加载答题卡失败");
    } finally {
      setPreviewLoading(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    setError("");
    const params = new URLSearchParams();
    if (classId) params.set("classId", classId);
    params.set("displayMode", displayMode);

    fetchJson<{
      examName: string; subject: string | null; hasAssignedScore: boolean;
      rows: ScoreTableRow[]; totalCount: number;
    }>(`/api/analysis/exams/${examId}/score-table?${params.toString()}`)
      .then((data) => {
        setHasAssigned(data.hasAssignedScore);
        setRows(data.rows);
        setTotalCount(data.totalCount);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "加载失败"))
      .finally(() => setLoading(false));
  }, [examId, classId, displayMode]);

  const filtered = useMemo(() => {
    if (!search.trim()) return rows;
    const q = search.trim().toLowerCase();
    return rows.filter((r) =>
      r.studentName.toLowerCase().includes(q) ||
      r.studentNumber.toLowerCase().includes(q) ||
      r.className.toLowerCase().includes(q)
    );
  }, [rows, search]);

  function renderChange(change: number | null | undefined) {
    if (change == null) return <span className="text-muted-foreground">—</span>;
    if (change > 0) return <span className="font-medium tabular-nums text-success-foreground">↑ +{change}</span>;
    if (change < 0) return <span className="font-medium tabular-nums text-destructive-fg">↓ {change}</span>;
    return (
      <span className="inline-flex items-center gap-1 tabular-nums text-muted-foreground">
        <Minus className="size-3" /> 0
      </span>
    );
  }

  const defaultSortKey: SortKey = classId ? "classRank" : "gradeRank";

  const columns = useMemo<ColumnDef<ScoreTableRow, unknown>[]>(() => {
    const list: ColumnDef<ScoreTableRow, unknown>[] = [
      {
        id: "index",
        header: "#",
        enableSorting: false,
        meta: { widthClass: "w-12" },
        cell: ({ row, table }) => (
          <span className="tabular-nums text-muted-foreground">
            {table.getSortedRowModel().flatRows.indexOf(row) + 1}
          </span>
        ),
      },
      {
        id: "studentName",
        header: "姓名",
        enableSorting: false,
        cell: ({ row }) => (
          <>
            <span className="font-medium">{row.original.studentName}</span>
            <span className="block text-xs tabular-nums text-muted-foreground">
              {row.original.studentNumber}
            </span>
          </>
        ),
      },
      {
        id: "className",
        header: "班级",
        enableSorting: false,
        cell: ({ row }) => row.original.className,
      },
      {
        id: "totalScore",
        header: hasAssigned ? "原始分" : "成绩",
        accessorFn: (row) => row.totalScore,
        meta: { numeric: true },
        sortDescFirst: false,
        sortingFn: (a, b) => numericCompare(a.original.totalScore, b.original.totalScore),
        cell: ({ row }) => <span className="font-semibold">{formatScore(row.original.totalScore)}</span>,
      },
    ];

    if (hasAssigned) {
      list.push({
        id: "assignedScore",
        header: "赋分",
        enableSorting: false,
        meta: { numeric: true },
        cell: ({ row }) => (
          <span
            className={cn(
              "font-medium",
              row.original.assignedScore != null ? "text-primary" : "text-muted-foreground",
            )}
          >
            {row.original.assignedScore != null ? formatScore(row.original.assignedScore) : "—"}
          </span>
        ),
      });
    }

    list.push(
      {
        id: "gradeRank",
        header: "年排",
        accessorFn: (row) => row.gradeRank,
        meta: { numeric: true },
        sortDescFirst: false,
        sortingFn: (a, b) => numericCompare(a.original.gradeRank, b.original.gradeRank),
        cell: ({ row }) => row.original.gradeRank,
      },
      {
        id: "classRank",
        header: "班排",
        accessorFn: (row) => row.classRank,
        meta: { numeric: true },
        sortDescFirst: false,
        sortingFn: (a, b) => numericCompare(a.original.classRank, b.original.classRank),
        cell: ({ row }) => row.original.classRank,
      },
      {
        id: "rankChange",
        header: "名次变化",
        accessorFn: (row) => row.rankChange,
        meta: { numeric: true },
        sortDescFirst: false,
        sortingFn: (a, b) => numericCompare(a.original.rankChange, b.original.rankChange),
        cell: ({ row }) => renderChange(row.original.rankChange),
      },
      {
        id: "displayValue",
        header: displayLabel,
        accessorFn: (row) => row.displayValue,
        meta: { numeric: true },
        sortDescFirst: false,
        sortingFn: (a, b) => numericCompare(a.original.displayValue, b.original.displayValue),
        cell: ({ row }) => (
          <span className="font-medium">
            {row.original.displayValue != null ? formatScore(row.original.displayValue) : "—"}
          </span>
        ),
      },
      {
        id: "scan",
        header: "答题卡",
        enableSorting: false,
        meta: { action: true },
        cell: ({ row }) => (
          <Button
            variant="ghost"
            size="sm"
            disabled={previewLoading}
            onClick={(e) => {
              // 预览是行内独立动作，不应连带触发「进入学生详情」的行点击
              e.stopPropagation();
              void openPreview(row.original.studentId, row.original.studentName, row.original.studentNumber);
            }}
          >
            预览
          </Button>
        ),
      },
    );

    return list;
    // openPreview 只依赖 examId，随组件生命周期稳定
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasAssigned, displayLabel, previewLoading]);

  if (loading) {
    return <div className="p-10 text-center text-sm text-muted-foreground">加载成绩数据...</div>;
  }
  if (error) {
    return <ErrorState description={error} />;
  }
  if (rows.length === 0) {
    return <EmptyState title="此考试暂无成绩数据" description="完成阅卷后成绩会自动出现在这里。" />;
  }

  return (
    <div>
      {/* Toolbar */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-80 min-w-50 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索姓名/学号/班级..."
            aria-label="搜索学生"
            className="h-control-sm pl-9 text-sm"
          />
        </div>
        <span className="ml-auto text-sm tabular-nums text-muted-foreground">
          共 {filtered.length}/{totalCount} 人
        </span>
      </div>

      {/* Table */}
      {isMobile ? (
        <div className="data-card-list">
          {filtered.map((row, i) => (
            <DataCard
              key={row.studentId}
              rows={[
                { label: "#", value: i + 1 },
                {
                  label: "姓名",
                  value: (
                    <>
                      <span className="font-medium">{row.studentName}</span>
                      <span className="block text-xs tabular-nums text-muted-foreground">{row.studentNumber}</span>
                    </>
                  ),
                  strong: true,
                },
                { label: "班级", value: row.className },
                { label: hasAssigned ? "原始分" : "成绩", value: formatScore(row.totalScore), strong: true },
                ...(hasAssigned ? [{ label: "赋分", value: row.assignedScore != null ? formatScore(row.assignedScore) : "—" }] : []),
                { label: "年排", value: row.gradeRank },
                { label: "班排", value: row.classRank },
                { label: "名次变化", value: renderChange(row.rankChange) },
                { label: displayLabel, value: row.displayValue != null ? formatScore(row.displayValue) : "—" },
              ]}
              actions={
                <Button
                  variant="ghost"
                  size="sm"
                  block
                  disabled={previewLoading}
                  onClick={(e) => {
                    e.stopPropagation();
                    void openPreview(row.studentId, row.studentName, row.studentNumber);
                  }}
                >
                  预览答题卡
                </Button>
              }
              onClick={onRowClick ? () => onRowClick(row.studentId, row.studentName, row.studentNumber) : undefined}
            />
          ))}
        </div>
      ) : (
        <DataTable
          key={classId ?? "__all__"}
          columns={columns}
          data={filtered}
          getRowId={(row) => String(row.studentId)}
          initialSorting={[{ id: defaultSortKey, desc: false }]}
          onRowClick={
            onRowClick
              ? (row) => onRowClick(row.studentId, row.studentName, row.studentNumber)
              : undefined
          }
          wrapClassName="rounded-lg border border-border-subtle"
        />
      )}

      {previewPages !== null && (
        <ScanPreviewModal
          title={previewTitle}
          subtitle={previewSubtitle}
          pages={previewPages}
          onClose={() => setPreviewPages(null)}
        />
      )}
    </div>
  );
}
