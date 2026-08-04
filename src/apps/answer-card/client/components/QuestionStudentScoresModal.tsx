import { useEffect, useMemo, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { fetchJson } from "../auth/api";
import type { QuestionStudentScore } from "../../../../shared/types";
import { formatScore, formatPercent } from "../util/format";
import {
  Badge,
  DataTable,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  type ColumnDef,
} from "./ui/v2";

/**
 * QuestionStudentScoresModal —— T2 迁移（T04 明细/订正/弹窗）
 *
 * 换肤范围（功能守恒，接口/路由/权限零改动）：
 *  · `modal-overlay` / `modal-card` / `ghost-button` 手写弹窗 → v2 `Dialog`
 *  · 手写排序表头（含 ⇅ ▲ ▼ 字符）→ v2 `DataTable`，排序比较函数逐条搬运，
 *    默认序与「点新列先降/先升」的方向沿用原实现（score/scoreRate 先降，其余先升）
 *  · 原生 `<select>` 班级筛选 → v2 `Select`（空值走 `__all__` 哨兵，Radix 不接受空串）
 *  · `#A32D2D` 错误色 → DataTable 内建 error 态
 */

const ALL_CLASSES = "__all__";

interface Props {
  examId: number;
  questionNumber: string;
  questionMaxScore: number;
  classId?: string;
  onClose: () => void;
}

export function QuestionStudentScoresModal({ examId, questionNumber, questionMaxScore, classId, onClose }: Props) {
  const [students, setStudents] = useState<QuestionStudentScore[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filterClass, setFilterClass] = useState("");

  useEffect(() => {
    setLoading(true); setError("");
    const params = new URLSearchParams();
    params.set("questionNumber", questionNumber);
    if (classId) params.set("classId", classId);
    fetchJson<QuestionStudentScore[]>(`/api/analysis/exams/${examId}/question-students?${params.toString()}`)
      .then((d) => setStudents(Array.isArray(d) ? d : []))
      .catch((e) => setError(e.message ?? "加载失败"))
      .finally(() => setLoading(false));
  }, [examId, questionNumber, classId]);

  const classOptions = useMemo(() => {
    const set = new Set<string>();
    students.forEach((s) => { if (s.className) set.add(s.className); });
    return Array.from(set).sort();
  }, [students]);

  const display = useMemo(
    () => (filterClass ? students.filter((s) => s.className === filterClass) : students),
    [students, filterClass],
  );

  const knowledgePoint = students.find((s) => s.knowledgePoint)?.knowledgePoint ?? null;
  const avg = display.length ? display.reduce((s, x) => s + x.score, 0) / display.length : 0;
  const fullCount = display.filter((s) => s.isFull).length;

  const columns = useMemo<ColumnDef<QuestionStudentScore, unknown>[]>(() => [
    {
      id: "studentNumber",
      header: "学号",
      accessorFn: (row) => row.studentNumber,
      cell: ({ row }) => <span className="tabular-nums text-muted-foreground">{row.original.studentNumber}</span>,
      sortDescFirst: false,
      sortingFn: (a, b) =>
        a.original.studentNumber.localeCompare(b.original.studentNumber, "zh", { numeric: true }),
    },
    {
      id: "name",
      header: "姓名",
      accessorFn: (row) => row.name,
      cell: ({ row }) => row.original.name,
      sortDescFirst: false,
      sortingFn: (a, b) => a.original.name.localeCompare(b.original.name, "zh"),
    },
    {
      id: "className",
      header: "班级",
      accessorFn: (row) => row.className ?? "",
      cell: ({ row }) => (
        <span className="text-muted-foreground">{row.original.className ?? "—"}</span>
      ),
      sortDescFirst: false,
      sortingFn: (a, b) =>
        (a.original.className ?? "").localeCompare(b.original.className ?? "", "zh"),
    },
    {
      id: "score",
      header: "得分",
      accessorFn: (row) => row.score,
      cell: ({ row }) => <span className="font-semibold">{formatScore(row.original.score)}</span>,
      meta: { numeric: true },
      sortDescFirst: true,
      sortingFn: (a, b) => a.original.score - b.original.score,
    },
    {
      id: "scoreRate",
      header: "得分率",
      accessorFn: (row) => row.scoreRate,
      cell: ({ row }) => formatPercent(row.original.scoreRate),
      meta: { numeric: true },
      sortDescFirst: true,
      sortingFn: (a, b) => a.original.scoreRate - b.original.scoreRate,
    },
    {
      id: "isFull",
      header: "满分",
      accessorFn: (row) => row.isFull,
      cell: ({ row }) =>
        row.original.isFull ? (
          <CheckCircle2 className="inline-block size-4 text-success" aria-label="满分" />
        ) : null,
      meta: { numeric: true },
      sortDescFirst: false,
      sortingFn: (a, b) =>
        a.original.isFull === b.original.isFull ? 0 : a.original.isFull ? -1 : 1,
    },
    {
      id: "knowledgePoint",
      header: "知识点",
      accessorFn: (row) => row.knowledgePoint ?? "",
      cell: ({ row }) => (
        <span className="text-xs text-primary">{row.original.knowledgePoint ?? "—"}</span>
      ),
      enableSorting: false,
      meta: { action: true },
    },
  ], []);

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent size="lg" className="max-w-[760px]">
        <DialogHeader>
          <DialogTitle>
            第 {questionNumber} 题 · 全班得分{questionMaxScore ? `（满分 ${questionMaxScore}）` : ""}
          </DialogTitle>
          <DialogDescription>
            共 <span className="tabular-nums">{display.length}</span> 人 · 平均{" "}
            <span className="tabular-nums">{formatScore(avg)}</span> · 满分{" "}
            <span className="tabular-nums">{fullCount}</span> 人
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-3">
          {(knowledgePoint || classOptions.length > 1) && (
            <div className="flex flex-wrap items-center gap-3">
              {knowledgePoint && <Badge tone="accent">知识点：{knowledgePoint}</Badge>}
              {classOptions.length > 1 && (
                <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                  班级筛选：
                  <Select
                    value={filterClass === "" ? ALL_CLASSES : filterClass}
                    onValueChange={(v) => setFilterClass(v === ALL_CLASSES ? "" : v)}
                  >
                    <SelectTrigger className="h-control-sm w-40 text-sm" aria-label="班级筛选">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL_CLASSES}>全部</SelectItem>
                      {classOptions.map((c) => (
                        <SelectItem key={c} value={c}>{c}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
              )}
            </div>
          )}

          <DataTable
            columns={columns}
            data={display}
            loading={loading}
            error={error || null}
            skeletonRows={6}
            getRowId={(row) => String(row.studentId)}
            initialSorting={[{ id: "score", desc: true }]}
            wrapClassName="max-h-[60vh] rounded-md border border-border-subtle"
          />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
