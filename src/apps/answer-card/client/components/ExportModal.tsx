import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Download,
  GripVertical,
  Plus,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { fetchJson, authFetch } from "../auth/api";
import { cn } from "../lib/utils";
import {
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableWrap,
  notify,
} from "./ui/v2";

interface Props {
  examId: number;
  examName: string;
  classId?: string;
  onClose: () => void;
}

interface ColumnMeta {
  id: string;
  label: string;
  category: string;
}

interface Template {
  id?: number;
  slot: number;
  name: string;
  columns: string[];
  side_table_n: number;
  gap_cols: number;
}

const A4_MAX_CHARS = 63;
const COL_WIDTHS: Record<string, number> = {
  studentNumber: 14, grade: 8, className: 8, studentName: 8,
  totalScore: 7, assignedScore: 7, objectiveScore: 7, subjectiveScore: 7,
  gradeRank: 5, classRank: 5, rankChange: 10, displayValue: 10,
  needsReview: 6, confidence: 7,
  objectiveSubScores: 7, subjectiveSubScores: 7
};
const SIDE_COL_WIDTHS = [5, 8, 7]; // 年排, 班级, 分数

// Default: classRank(5)+name(8)+totalScore(7)+assignedScore(7)+gradeRank(5)+obj(7)+subj(7) = 46 + gap(3) + side(5+8+7=20) = 69 → slightly over. Let's tighten.
// Adjusted: classRank(5)+name(8)+totalScore(6)+assignedScore(6)+gradeRank(4)+obj(6)+subj(6)=41, +gap(3)+side(4+7+6=17)=61 ✓

const DEFAULT_COLUMNS = ["classRank", "studentName", "totalScore", "assignedScore", "gradeRank", "objectiveScore", "subjectiveScore"];

const ALL_COLUMNS = [
  "studentNumber", "studentName", "className", "totalScore", "assignedScore",
  "gradeRank", "classRank", "objectiveScore", "subjectiveScore", "rankChange",
  "displayValue",
];

/**
 * 列分类 → 数据可视化色板类名。
 *
 * 迁移说明：原实现返回三段硬编码 hex（绿 / 橙 / 紫），
 * 现改为语义化的 chart-N 令牌类，色相与旧值一一对应且随主题切换。
 */
const CATEGORY_ACCENT: Record<string, { border: string; text: string }> = {
  basic: { border: "border-chart-1", text: "text-chart-1" },
  score: { border: "border-chart-3", text: "text-chart-3" },
  ranking: { border: "border-chart-4", text: "text-chart-4" },
  questions: { border: "border-chart-5", text: "text-chart-5" },
  other: { border: "border-border-strong", text: "text-muted-foreground" },
};

function categoryAccent(category: string) {
  return CATEGORY_ACCENT[category] ?? CATEGORY_ACCENT.other;
}

function computeTotalWidth(columns: string[], sideN: number, gap: number): number {
  const mainW = columns.reduce((sum, c) => sum + (COL_WIDTHS[c] ?? 8), 0);
  if (sideN > 0) {
    const sideW = SIDE_COL_WIDTHS.reduce((a, b) => a + b, 0);
    return mainW + gap + sideW;
  }
  return mainW;
}

export function ExportModal({ examId, examName, classId, onClose }: Props) {
  const [allColumns, setAllColumns] = useState<ColumnMeta[]>([]);
  const [selected, setSelected] = useState<string[]>(DEFAULT_COLUMNS);
  const [sideN, setSideN] = useState(10);
  const [gapCols, setGapCols] = useState(1);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templateNames, setTemplateNames] = useState<Record<number, string>>({});
  const [activeTemplate, setActiveTemplate] = useState<number | null>(null);
  const [previewRows, setPreviewRows] = useState<Record<string, unknown>[]>([]);
  const [exporting, setExporting] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const dragItem = useRef<number | null>(null);
  const dragOverItem = useRef<number | null>(null);

  // Hardcoded Chinese column definitions (no API needed)
  const COLUMN_DEFS: ColumnMeta[] = [
    { id: "studentNumber", label: "考号", category: "basic" },
    { id: "studentName", label: "姓名", category: "basic" },
    { id: "className", label: "班级", category: "basic" },
    { id: "totalScore", label: "成绩", category: "score" },
    { id: "assignedScore", label: "赋分", category: "score" },
    { id: "objectiveScore", label: "客观分", category: "score" },
    { id: "subjectiveScore", label: "主观分", category: "score" },
    { id: "gradeRank", label: "年排", category: "ranking" },
    { id: "classRank", label: "班排", category: "ranking" },
    { id: "rankChange", label: "名次变化", category: "ranking" },
    { id: "displayValue", label: "偏差值/Z值", category: "other" },
    { id: "needsReview", label: "需要复核", category: "other" },
    { id: "objectiveSubScores", label: "客观题小分", category: "questions" },
    { id: "subjectiveSubScores", label: "主观题小分", category: "questions" },
  ];

  useEffect(() => {
    setAllColumns(COLUMN_DEFS);
    fetchJson<Template[]>("/api/export/templates").then(setTemplates).catch(() => {});
    const params = new URLSearchParams();
    if (classId) params.set("classId", classId);
    fetchJson<{ rows: Record<string, unknown>[]; hasAssignedScore: boolean }>(`/api/analysis/exams/${examId}/score-table?${params.toString()}`)
      .then((data) => { setPreviewRows(data.rows.slice(0, 3)); })
      .catch(() => setPreviewRows([]));
  }, [examId, classId]);

  const unselected = allColumns.filter((c) => !selected.includes(c.id));

  function addColumn(colId: string) {
    if (!selected.includes(colId)) setSelected([...selected, colId]);
  }

  function removeColumn(index: number) {
    setSelected(selected.filter((_, i) => i !== index));
  }

  function handleDragStart(index: number) {
    dragItem.current = index;
    setDragIndex(index);
  }
  function handleDragOver(e: React.DragEvent, index: number) {
    e.preventDefault();
    dragOverItem.current = index;
  }
  function handleDrop() {
    if (dragItem.current == null || dragOverItem.current == null) return;
    const copy = [...selected];
    const [item] = copy.splice(dragItem.current, 1);
    copy.splice(dragOverItem.current, 0, item);
    setSelected(copy);
    dragItem.current = null;
    dragOverItem.current = null;
    setDragIndex(null);
  }
  function handleDragEnd() {
    dragItem.current = null;
    dragOverItem.current = null;
    setDragIndex(null);
  }

  function saveTemplate(slot: number) {
    const name = templateNames[slot] || `模板${slot}`;
    fetchJson(`/api/export/templates/${slot}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, columns: selected, sideTableN: sideN, gapCols })
    }).then(() => {
      fetchJson<Template[]>("/api/export/templates").then(setTemplates).catch(() => {});
    }).catch(() => {});
  }

  function loadTemplate(t: Template) {
    setSelected(t.columns);
    setSideN(t.side_table_n ?? 10);
    setGapCols(t.gap_cols ?? 1);
    setActiveTemplate(t.slot);
    setTemplateNames({ ...templateNames, [t.slot]: t.name });
  }

  function deleteTemplate(slot: number) {
    fetchJson(`/api/export/templates/${slot}`, { method: "DELETE" })
      .then(() => { fetchJson<Template[]>("/api/export/templates").then(setTemplates).catch(() => {}); })
      .catch(() => {});
    if (activeTemplate === slot) setActiveTemplate(null);
  }

  async function doExport() {
    setExporting(true);
    try {
      const resp = await authFetch(`/api/export/exams/${examId}/scores`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ examId, classId: classId ? Number(classId) : undefined, columns: selected, sideTableN: sideN, gapCols })
      });
      if (!resp.ok) throw new Error("导出失败");
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${examName.replace(/[\/:*?"<>|]/g, "_")}_成绩表.xlsx`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      notify.success("成绩表已导出");
    } catch (err) {
      notify.error(err instanceof Error ? err.message : "导出失败");
    } finally { setExporting(false); }
  }

  function colLabel(id: string) { return COLUMN_DEFS.find((c) => c.id === id)?.label ?? id; }
  function colValue(colId: string, row: Record<string, unknown>): string | number {
    const map: Record<string, string> = { studentNumber: "studentNumber", studentName: "studentName", className: "className", totalScore: "totalScore", assignedScore: "assignedScore", objectiveScore: "objectiveScore", subjectiveScore: "subjectiveScore", gradeRank: "gradeRank", classRank: "classRank", displayValue: "displayValue" };
    const key = map[colId];
    if (!key) return "—";
    const v = row[key];
    return v != null ? String(v) : "—";
  }

  const totalWidth = computeTotalWidth(selected, sideN, gapCols);
  const overA4 = totalWidth > A4_MAX_CHARS;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !exporting) onClose();
      }}
    >
      <DialogContent size="md" className="max-h-[90vh]">
        <DialogHeader>
          <DialogTitle>导出成绩 — {examName}</DialogTitle>
          <DialogDescription>
            拖拽调整列顺序，可存为模板复用；导出为 Excel 工作簿。
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-4">
          {/* 快捷预设 */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-foreground">快捷</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setSelected(DEFAULT_COLUMNS);
                setSideN(10);
                setActiveTemplate(null);
              }}
            >
              基础表
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSelected(ALL_COLUMNS)}
            >
              全列
            </Button>
          </div>

          {/* 已选列胶囊 */}
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-foreground">
              列排列（拖拽调整）
            </span>
            <div className="flex min-h-11 flex-wrap items-center gap-2 rounded-md border border-border-subtle bg-secondary p-2">
              {selected.map((colId, i) => {
                const accent = categoryAccent(
                  COLUMN_DEFS.find((c) => c.id === colId)?.category ?? "other",
                );
                return (
                  <div
                    key={colId}
                    draggable
                    onDragStart={() => handleDragStart(i)}
                    onDragOver={(e) => handleDragOver(e, i)}
                    onDrop={handleDrop}
                    onDragEnd={handleDragEnd}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-md border bg-card px-2 py-1 text-xs text-foreground",
                      "transition-opacity duration-(--px-dur-1) ease-standard",
                      accent.border,
                      dragIndex === i && "opacity-50",
                    )}
                  >
                    <GripVertical className="size-3 cursor-grab text-muted-foreground" />
                    <span>{colLabel(colId)}</span>
                    <button
                      type="button"
                      aria-label={`移除 ${colLabel(colId)}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        removeColumn(i);
                      }}
                      className={cn(
                        "ml-0.5 inline-flex size-4 items-center justify-center rounded-xs",
                        "text-muted-foreground transition-colors duration-(--px-dur-1) ease-standard",
                        "hover:bg-secondary hover:text-foreground",
                        "outline-none focus-visible:shadow-focus",
                      )}
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                );
              })}
              {selected.length === 0 && (
                <span className="text-xs text-muted-foreground">
                  点击下方列添加
                </span>
              )}
            </div>
          </div>

          {/* 可选列 */}
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">可选列</span>
            <div className="flex flex-wrap gap-1.5">
              {unselected.map((c) => {
                const accent = categoryAccent(c.category);
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => addColumn(c.id)}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-md border border-dashed bg-card px-2 py-1 text-xs",
                      "transition-colors duration-(--px-dur-1) ease-standard hover:bg-secondary",
                      "outline-none focus-visible:shadow-focus",
                      accent.border,
                      accent.text,
                    )}
                  >
                    <Plus className="size-3" /> {c.label}
                  </button>
                );
              })}
              {unselected.length === 0 && (
                <span className="text-xs text-muted-foreground">
                  已选择全部列
                </span>
              )}
            </div>
          </div>

          {/* A4 超宽告警 */}
          {overA4 && (
            <div className="flex items-start gap-2 rounded-md border border-warning-border bg-warning-soft px-3 py-2 text-xs text-warning-foreground">
              <AlertTriangle className="mt-px size-4 shrink-0" aria-hidden="true" />
              <span>
                所选列总宽可能超出 1 页竖版 A4（Word 默认页边距）。当前约{" "}
                <span className="tabular-nums">{totalWidth}</span>ch / 建议 ≤
                <span className="tabular-nums">{A4_MAX_CHARS}</span>ch。请减少列或调整侧表。
              </span>
            </div>
          )}

          {/* 数据预览 */}
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-foreground">数据预览</span>
            <TableWrap className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    {selected.map((colId) => (
                      <TableHead key={colId} className="whitespace-nowrap">
                        {colLabel(colId)}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {previewRows.length > 0 ? (
                    previewRows.map((row, ri) => (
                      <TableRow key={ri}>
                        {selected.map((colId) => (
                          <TableCell
                            key={colId}
                            className="tabular-nums whitespace-nowrap"
                          >
                            {colValue(colId, row)}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))
                  ) : (
                    <TableRow>
                      <TableCell
                        colSpan={selected.length || 1}
                        className="text-center text-muted-foreground"
                      >
                        加载预览数据中…
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </TableWrap>
          </div>

          {/* 侧表 */}
          <div className="flex flex-col gap-2">
            <label
              htmlFor="export-side-table"
              className="flex cursor-pointer items-center gap-2 text-sm font-medium text-foreground select-none"
            >
              <Checkbox
                id="export-side-table"
                checked={sideN > 0}
                onCheckedChange={(v) => setSideN(v === true ? 10 : 0)}
              />
              附加年级排名参照表（同 Sheet 右侧）
            </label>
            {sideN > 0 && (
              <div className="flex flex-wrap items-center gap-4 pl-6">
                <label className="flex items-center gap-2 text-xs text-secondary-foreground">
                  前
                  <Input
                    type="number"
                    value={sideN}
                    onChange={(e) => setSideN(Math.max(1, Number(e.target.value)))}
                    className="h-control-sm w-16 tabular-nums"
                  />
                  名
                </label>
                <label className="flex items-center gap-2 text-xs text-secondary-foreground">
                  间隙
                  <Input
                    type="number"
                    value={gapCols}
                    onChange={(e) => setGapCols(Math.max(1, Number(e.target.value)))}
                    className="h-control-sm w-16 tabular-nums"
                  />
                  列
                </label>
              </div>
            )}
          </div>

          {/* 自定义模板 */}
          <div className="flex flex-col gap-2 border-t border-border-subtle pt-3">
            <span className="text-sm font-medium text-foreground">自定义模板</span>
            <div className="flex flex-col gap-2">
              {[1, 2, 3, 4].map((slot) => {
                const t = templates.find((tp) => tp.slot === slot);
                const isActive = activeTemplate === slot;
                return (
                  <div
                    key={slot}
                    onClick={() => t && loadTemplate(t)}
                    className={cn(
                      "flex items-center gap-2 rounded-md border px-2.5 py-1.5",
                      "transition-colors duration-(--px-dur-1) ease-standard",
                      t ? "cursor-pointer" : "cursor-default",
                      isActive
                        ? "border-accent-border bg-accent"
                        : "border-border-subtle bg-card",
                    )}
                  >
                    <span
                      className={cn(
                        "w-14 shrink-0 text-xs text-muted-foreground",
                        isActive && "font-semibold text-accent-foreground",
                      )}
                    >
                      模板<span className="tabular-nums">{slot}</span>
                    </span>
                    <Input
                      type="text"
                      value={t ? templateNames[slot] ?? t.name : templateNames[slot] ?? ""}
                      onChange={(e) => {
                        e.stopPropagation();
                        setTemplateNames({ ...templateNames, [slot]: e.target.value });
                      }}
                      onClick={(e) => e.stopPropagation()}
                      placeholder="模板名称"
                      className="h-control-sm flex-1"
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<Save className="size-3" />}
                      onClick={(e) => {
                        e.stopPropagation();
                        saveTemplate(slot);
                      }}
                    >
                      保存
                    </Button>
                    {t && (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`删除模板${slot}`}
                        className="text-destructive-fg hover:text-destructive-fg"
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteTemplate(slot);
                        }}
                      >
                        <Trash2 className="size-3" />
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={exporting}>
            取消
          </Button>
          <Button
            variant="primary"
            icon={<Download className="size-4" />}
            onClick={() => void doExport()}
            loading={exporting}
            disabled={selected.length === 0}
          >
            导出 Excel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
