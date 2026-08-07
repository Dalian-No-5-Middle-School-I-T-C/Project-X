import { useEffect, useMemo, useState } from "react";
import {
  CalendarDays,
  Inbox,
  Layers,
  Save,
  Search,
  Trash2,
} from "lucide-react";
import { fetchJson } from "../auth/api";
import { cn } from "../lib/utils";
import { formatScore } from "../util/format";
import {
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ExamStatusBadge,
  Input,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatCard,
  StatCardRow,
  type ColumnDef,
  type ExamStatus,
} from "./ui/v2";
import type {
  CrossExamAttendanceMode,
  CrossExamGroup,
  CrossExamTotalRequest,
  CrossExamTotalResponse,
  ExamFilterItem,
  ExamGroupFilterItem,
} from "../../../../shared/types";

/**
 * 考试选择页（分析入口）。
 *
 * 迁移说明：单科 / 大考 / 跨考三模式与全部取数逻辑、API 端点原样保留；
 * 旧 `DataCard` + 手写 `exam-list-table` 统一换成 v2 `DataTable`
 * （移动端由 DataTable 自身的响应式表格承接），
 * 手写删除弹层换 `ConfirmDialog`，筛选控件换 `Select`/`Input`，
 * 模式切换换 `SegmentedControl`。
 */

interface ClassOption {
  id: number;
  name: string;
  grade_name?: string;
}

interface FilterOptions {
  academicYears: string[];
  subjects: string[];
}

interface Props {
  onSelectExam: (examId: number) => void;
  onSelectGroup?: (groupId: number) => void;
  refreshKey?: number;
}

type MainMode = "single" | "group" | "cross";
type CrossMode = "week" | "selected" | "group";

/** Radix Select 不接受空字符串 value，用哨兵值表示「全部」 */
const ALL = "__all__";

const MAIN_MODES = [
  { value: "single" as const, label: "单科" },
  { value: "group" as const, label: "大考" },
  { value: "cross" as const, label: "跨考", icon: <Layers /> },
];

const CROSS_MODES = [
  { value: "week" as const, label: "按日期打包", icon: <CalendarDays /> },
  { value: "selected" as const, label: "选定考试", icon: <Layers /> },
  { value: "group" as const, label: "已存组", icon: <Save /> },
];

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 后端 exam.status → v2 ExamStatusBadge 语义（文案与旧实现逐字一致） */
function toExamStatus(status: string): { status: ExamStatus; label: string } {
  if (status === "closed") return { status: "done", label: "已完成" };
  if (status === "grading") return { status: "grading", label: "阅卷中" };
  if (status === "draft") return { status: "pending", label: "草稿" };
  return { status: "pending", label: status };
}

export function ExamSelectPage({
  onSelectExam,
  onSelectGroup,
  refreshKey = 0,
}: Props) {
  const [mainMode, setMainMode] = useState<MainMode>("single");
  const [crossMode, setCrossMode] = useState<CrossMode>("week");
  const [filters, setFilters] = useState<FilterOptions>({
    academicYears: [],
    subjects: [],
  });
  const [academicYear, setAcademicYear] = useState("");
  const [gradeId, setGradeId] = useState("");
  const [subject, setSubject] = useState("");
  const [exams, setExams] = useState<ExamFilterItem[]>([]);
  const [groupExams, setGroupExams] = useState<ExamGroupFilterItem[]>([]);
  const [grades, setGrades] = useState<Array<{ id: number; name: string }>>([]);
  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [loading, setLoading] = useState(true);

  // ── Cross-exam states ──
  const [endDate, setEndDate] = useState(today());
  const [startDate, setStartDate] = useState(addDays(today(), -6));
  const [attendanceMode, setAttendanceMode] =
    useState<CrossExamAttendanceMode>("all");
  const [classId, setClassId] = useState("");
  const [crossGroups, setCrossGroups] = useState<CrossExamGroup[]>([]);
  const [selectedExamIds, setSelectedExamIds] = useState<Set<number>>(
    new Set(),
  );
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [groupName, setGroupName] = useState("");
  const [crossResult, setCrossResult] = useState<CrossExamTotalResponse | null>(
    null,
  );
  const [crossSearch, setCrossSearch] = useState("");
  const [crossLoading, setCrossLoading] = useState(false);
  const [crossMessage, setCrossMessage] = useState("");
  const [savingGroup, setSavingGroup] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteCount, setDeleteCount] = useState(0);
  const [deleteGroupName, setDeleteGroupName] = useState("");

  // Week preview: exams within date range
  const weekPreviewExams = useMemo(
    () =>
      exams.filter(
        (e) => e.exam_date && e.exam_date >= startDate && e.exam_date <= endDate,
      ),
    [exams, startDate, endDate],
  );

  useEffect(() => {
    fetchJson<FilterOptions>("/api/exams/filters")
      .then(setFilters)
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchJson<Array<{ id: number; name: string }>>("/api/classes/grades")
      .then(setGrades)
      .catch(() => setGrades([]));
    fetchJson<ClassOption[]>("/api/classes")
      .then(setClasses)
      .catch(() => setClasses([]));
    loadCrossGroups();
  }, []);

  // Load single/group exams
  useEffect(() => {
    if (mainMode === "cross") return;
    setLoading(true);
    const params = new URLSearchParams({ selection: "1" });
    if (academicYear) params.set("academic_year", academicYear);
    if (gradeId) params.set("grade_id", gradeId);
    if (subject) params.set("subject", subject);

    if (mainMode === "single") {
      fetchJson<ExamFilterItem[]>(`/api/exams?${params.toString()}`)
        .then(setExams)
        .catch(() => setExams([]))
        .finally(() => setLoading(false));
    } else {
      const gParams = new URLSearchParams();
      if (gradeId) gParams.set("grade_id", gradeId);
      fetchJson<ExamGroupFilterItem[]>(`/api/exam-groups?${gParams.toString()}`)
        .then(setGroupExams)
        .catch(() => setGroupExams([]))
        .finally(() => setLoading(false));
    }
  }, [mainMode, academicYear, gradeId, subject, refreshKey]);

  // Load exams for cross-exam picker / week preview
  useEffect(() => {
    if (mainMode !== "cross") return;
    setLoading(true);
    const params = new URLSearchParams({ selection: "1" });
    if (gradeId) params.set("grade_id", gradeId);
    if (subject && crossMode === "selected") params.set("subject", subject);
    fetchJson<ExamFilterItem[]>(`/api/exams?${params.toString()}`)
      .then(setExams)
      .catch(() => setExams([]))
      .finally(() => setLoading(false));
  }, [mainMode, gradeId, subject, crossMode, refreshKey]);

  // ── Cross-exam functions ──
  async function loadCrossGroups(preferredGroupId?: string) {
    try {
      const data = await fetchJson<CrossExamGroup[]>(
        "/api/analysis/cross-exam/groups",
      );
      setCrossGroups(data);
      if (preferredGroupId) setSelectedGroupId(preferredGroupId);
      else if (!selectedGroupId && data.length > 0)
        setSelectedGroupId(String(data[0].id));
    } catch {
      setCrossGroups([]);
    }
  }

  async function runCrossTotal(request: CrossExamTotalRequest) {
    setCrossLoading(true);
    setCrossMessage("");
    try {
      const data = await fetchJson<CrossExamTotalResponse>(
        "/api/analysis/cross-exam/total",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...request,
            gradeId: gradeId ? Number(gradeId) : undefined,
            classId: classId ? Number(classId) : undefined,
            subject: crossMode === "selected" ? subject || undefined : undefined,
            attendanceMode,
          }),
        },
      );
      setCrossResult(data);
      if (data.exams.length === 0) setCrossMessage("当前条件下没有可统计的考试。");
    } catch (err) {
      setCrossResult(null);
      setCrossMessage(err instanceof Error ? err.message : "统计失败");
    } finally {
      setCrossLoading(false);
    }
  }

  async function saveCrossGroup(
    source: "cross-manual" | "week",
    examIds: number[],
    fallbackName: string,
  ) {
    const name = groupName.trim() || fallbackName;
    if (examIds.length === 0) {
      setCrossMessage("没有可保存的考试。");
      return;
    }
    setSavingGroup(true);
    setCrossMessage("正在保存考试组...");
    try {
      const group = await fetchJson<CrossExamGroup>(
        "/api/analysis/cross-exam/groups",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, examIds, source, startDate, endDate }),
        },
      );
      setGroupName("");
      setSelectedGroupId(String(group.id));
      setCrossMode("group");
      await loadCrossGroups(String(group.id));
      await runCrossTotal({ mode: "group", groupId: group.id });
      setCrossMessage(`已保存并统计：${group.name}`);
    } catch (err) {
      setCrossMessage(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSavingGroup(false);
    }
  }

  async function deleteCrossGroup() {
    if (!selectedGroupId) return;
    try {
      await fetchJson(`/api/analysis/cross-exam/groups/${selectedGroupId}`, {
        method: "DELETE",
      });
      setSelectedGroupId("");
      setCrossResult(null);
      await loadCrossGroups();
      setShowDeleteConfirm(false);
      setCrossMessage("考试组已删除。");
    } catch (err) {
      setCrossMessage(err instanceof Error ? err.message : "删除失败");
    }
  }

  function confirmDeleteCrossGroup() {
    if (!selectedGroupId) return;
    const group = crossGroups.find((g) => String(g.id) === selectedGroupId);
    setDeleteGroupName(group?.name ?? "");
    setDeleteCount(group?.examIds.length ?? 0);
    setShowDeleteConfirm(true);
  }

  function toggleExamSelected(examId: number) {
    const next = new Set(selectedExamIds);
    if (next.has(examId)) next.delete(examId);
    else next.add(examId);
    setSelectedExamIds(next);
  }

  const selectedIds = useMemo(
    () => Array.from(selectedExamIds),
    [selectedExamIds],
  );
  const weekResultExamIds =
    crossResult?.mode === "week" ? crossResult.exams.map((e) => e.id) : [];
  const crossFilteredRows = useMemo(() => {
    if (!crossResult) return [];
    const q = crossSearch.trim().toLowerCase();
    if (!q) return crossResult.rows;
    return crossResult.rows.filter(
      (row) =>
        row.studentName.toLowerCase().includes(q) ||
        row.studentNumber.toLowerCase().includes(q) ||
        row.className.toLowerCase().includes(q),
    );
  }, [crossResult, crossSearch]);

  // ── Columns ──

  const examColumns = useMemo<ColumnDef<ExamFilterItem, unknown>[]>(
    () => [
      {
        accessorKey: "name",
        header: "考试名称",
        cell: ({ row }) => (
          <span className="font-medium text-foreground">{row.original.name}</span>
        ),
      },
      {
        accessorKey: "subject",
        header: "科目",
        cell: ({ row }) => row.original.subject || "—",
        meta: { widthClass: "w-20" },
      },
      {
        accessorKey: "grade_name",
        header: "年级",
        cell: ({ row }) => row.original.grade_name || "—",
        meta: { widthClass: "w-20" },
      },
      {
        accessorKey: "exam_date",
        header: "日期",
        cell: ({ row }) => (
          <span className="tabular-nums">{row.original.exam_date || "—"}</span>
        ),
        meta: { widthClass: "w-28" },
      },
      {
        accessorKey: "graded_count",
        header: "已阅",
        meta: { numeric: true, widthClass: "w-20" },
      },
      {
        accessorKey: "avg_score",
        header: "均分",
        cell: ({ row }) =>
          row.original.graded_count > 0 ? row.original.avg_score : "—",
        meta: { numeric: true, widthClass: "w-20" },
      },
      {
        id: "status",
        header: "状态",
        enableSorting: false,
        cell: ({ row }) => {
          const mapped = toExamStatus(row.original.status);
          return <ExamStatusBadge status={mapped.status} label={mapped.label} />;
        },
        meta: { widthClass: "w-24" },
      },
    ],
    [],
  );

  const groupColumns = useMemo<ColumnDef<ExamGroupFilterItem, unknown>[]>(
    () => [
      {
        accessorKey: "name",
        header: "大考名称",
        cell: ({ row }) => (
          <span className="font-medium text-foreground">{row.original.name}</span>
        ),
      },
      {
        id: "tag",
        header: "标签",
        enableSorting: false,
        cell: ({ row }) => {
          const tag = (row.original as { tag?: string }).tag;
          return tag ? <Badge tone="solid">{tag}</Badge> : <span>—</span>;
        },
        meta: { widthClass: "w-24" },
      },
      {
        id: "grade_name",
        header: "年级",
        cell: ({ row }) =>
          (row.original as { grade_name?: string }).grade_name || "—",
        meta: { widthClass: "w-20" },
      },
      {
        id: "member_count",
        header: "含考试数",
        cell: ({ row }) => (row.original as { member_count?: number }).member_count ?? 0,
        meta: { numeric: true, widthClass: "w-24" },
      },
      {
        id: "has_results",
        header: "有无成绩",
        enableSorting: false,
        cell: ({ row }) =>
          (row.original as { has_results?: boolean | number }).has_results ? (
            <ExamStatusBadge status="done" label="有成绩" />
          ) : (
            <ExamStatusBadge status="pending" label="无成绩" />
          ),
        meta: { widthClass: "w-28" },
      },
      {
        id: "created_at",
        header: "创建日期",
        cell: ({ row }) => {
          const createdAt = (row.original as { created_at?: string }).created_at;
          return (
            <span className="tabular-nums">
              {createdAt ? createdAt.slice(0, 10) : "—"}
            </span>
          );
        },
        meta: { widthClass: "w-28" },
      },
    ],
    [],
  );

  const previewColumns = useMemo<ColumnDef<ExamFilterItem, unknown>[]>(
    () => [
      {
        accessorKey: "name",
        header: "考试名称",
        cell: ({ row }) => (
          <span className="font-medium text-foreground">{row.original.name}</span>
        ),
      },
      {
        accessorKey: "subject",
        header: "科目",
        cell: ({ row }) => row.original.subject || "—",
        meta: { widthClass: "w-20" },
      },
      {
        accessorKey: "grade_name",
        header: "年级",
        cell: ({ row }) => row.original.grade_name || "—",
        meta: { widthClass: "w-20" },
      },
      {
        accessorKey: "exam_date",
        header: "日期",
        cell: ({ row }) => (
          <span className="tabular-nums">{row.original.exam_date || "—"}</span>
        ),
        meta: { widthClass: "w-28" },
      },
      {
        accessorKey: "graded_count",
        header: "已阅",
        meta: { numeric: true, widthClass: "w-20" },
      },
      {
        accessorKey: "avg_score",
        header: "均分",
        cell: ({ row }) =>
          row.original.graded_count > 0 ? row.original.avg_score : "—",
        meta: { numeric: true, widthClass: "w-20" },
      },
    ],
    [],
  );

  const pickerColumns = useMemo<ColumnDef<ExamFilterItem, unknown>[]>(
    () => [
      {
        id: "pick",
        header: "",
        enableSorting: false,
        cell: ({ row }) => (
          <Checkbox
            checked={selectedExamIds.has(row.original.id)}
            onCheckedChange={() => toggleExamSelected(row.original.id)}
            aria-label={`选择 ${row.original.name}`}
          />
        ),
        meta: { widthClass: "w-10" },
      },
      ...previewColumns,
    ],
    [previewColumns, selectedExamIds],
  );

  const crossColumns = useMemo<
    ColumnDef<CrossExamTotalResponse["rows"][number], unknown>[]
  >(() => {
    if (!crossResult) return [];
    const examCount = crossResult.exams.length;
    return [
      {
        accessorKey: "gradeRank",
        header: "年排",
        meta: { numeric: true, widthClass: "w-16" },
      },
      {
        accessorKey: "classRank",
        header: "班排",
        meta: { numeric: true, widthClass: "w-16" },
      },
      {
        accessorKey: "studentName",
        header: "姓名",
        cell: ({ row }) => (
          <div className="flex flex-col">
            <strong className="font-medium text-foreground">
              {row.original.studentName}
            </strong>
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {row.original.studentNumber}
            </span>
          </div>
        ),
      },
      { accessorKey: "className", header: "班级" },
      {
        id: "totalScore",
        header: "总分",
        accessorFn: (row) => row.totalScore,
        cell: ({ row }) => (
          <span className="font-semibold tabular-nums">
            {formatScore(row.original.totalScore)} /{" "}
            {formatScore(row.original.totalFullScore)}
          </span>
        ),
        meta: { numeric: true },
      },
      {
        accessorKey: "scoreRate",
        header: "得分率",
        cell: ({ row }) =>
          row.original.scoreRate == null
            ? "—"
            : `${formatScore(row.original.scoreRate)}%`,
        meta: { numeric: true },
      },
      {
        id: "attendance",
        header: "出勤",
        enableSorting: false,
        cell: ({ row }) => (
          <span className="tabular-nums">
            {row.original.attendedCount}/{examCount}
            {row.original.absentCount > 0 ? (
              <span className="ml-1 text-destructive-fg">
                缺{row.original.absentCount}
              </span>
            ) : null}
          </span>
        ),
        meta: { numeric: true },
      },
      ...crossResult.exams.map<
        ColumnDef<CrossExamTotalResponse["rows"][number], unknown>
      >((exam, examIndex) => ({
        id: `exam-${exam.id}`,
        header:
          exam.name.length > 8 ? `${exam.name.slice(0, 8)}...` : exam.name,
        enableSorting: false,
        cell: ({ row }) => {
          const cell = row.original.scores[examIndex];
          if (!cell) return <span className="text-muted-foreground">—</span>;
          return cell.absent ? (
            <span className="text-muted-foreground">缺考</span>
          ) : (
            <span className="tabular-nums">{formatScore(cell.score ?? 0)}</span>
          );
        },
        meta: { numeric: true },
      })),
    ];
  }, [crossResult]);

  /** 交叉考试加载骨架屏使用的列：结果未到达时给出占位列头。 */
  const crossSkeletonColumns = useMemo<
    ColumnDef<CrossExamTotalResponse["rows"][number], unknown>[]
  >(() => {
    if (crossColumns.length > 0) return crossColumns;
    return [
      {
        id: "skeleton_grade_rank",
        header: "年排",
        cell: () => "—",
        meta: { numeric: true, widthClass: "w-16" },
      },
      {
        id: "skeleton_class_rank",
        header: "班排",
        cell: () => "—",
        meta: { numeric: true, widthClass: "w-16" },
      },
      {
        id: "skeleton_student",
        header: "姓名",
        cell: () => "—",
      },
      {
        id: "skeleton_class",
        header: "班级",
        cell: () => "—",
        meta: { widthClass: "w-28" },
      },
      {
        id: "skeleton_total",
        header: "总分",
        cell: () => "—",
        meta: { numeric: true, widthClass: "w-24" },
      },
    ];
  }, [crossColumns]);

  // ── Render ──

  const showSingleGroup = mainMode !== "cross";

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="shrink-0 px-8 pt-6">
        <div className="mb-5 flex items-end justify-between gap-4">
          <div>
            <h2 className="m-0 mb-1 text-lg font-semibold text-foreground">
              考试选择
            </h2>
            <p className="m-0 text-sm text-muted-foreground">
              {mainMode === "cross"
                ? "按日期打包或手动选择考试计算总分排名"
                : "选择单科考试或大考合集查看成绩"}
            </p>
          </div>
          <SegmentedControl
            value={mainMode}
            onValueChange={setMainMode}
            items={MAIN_MODES}
            size="sm"
            aria-label="分析模式"
            className="shrink-0"
          />
        </div>

        {/* Filter row — shared for single/group */}
        {showSingleGroup && (
          <div className="mb-6 flex flex-wrap items-end gap-3">
            <FilterCol label="学年">
              <Select
                value={academicYear === "" ? ALL : academicYear}
                onValueChange={(v) => setAcademicYear(v === ALL ? "" : v)}
              >
                <SelectTrigger className="h-control-sm w-40 text-sm">
                  <SelectValue placeholder="全部学年" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>全部学年</SelectItem>
                  {filters.academicYears.map((y) => (
                    <SelectItem key={y} value={y}>
                      {y}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FilterCol>
            <FilterCol label="年级">
              <Select
                value={gradeId === "" ? ALL : gradeId}
                onValueChange={(v) => setGradeId(v === ALL ? "" : v)}
              >
                <SelectTrigger className="h-control-sm w-40 text-sm">
                  <SelectValue placeholder="全部年级" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>全部年级</SelectItem>
                  {grades.map((g) => (
                    <SelectItem key={g.id} value={String(g.id)}>
                      {g.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FilterCol>
            {mainMode === "single" && (
              <FilterCol label="学科">
                <Select
                  value={subject === "" ? ALL : subject}
                  onValueChange={(v) => setSubject(v === ALL ? "" : v)}
                >
                  <SelectTrigger className="h-control-sm w-40 text-sm">
                    <SelectValue placeholder="全部学科" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>全部学科</SelectItem>
                    {filters.subjects.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FilterCol>
            )}
            {((mainMode === "single" && exams.length > 0) ||
              (mainMode === "group" && groupExams.length > 0)) && (
              <span className="pb-2.5 text-sm tabular-nums text-muted-foreground">
                共 {mainMode === "single" ? exams.length : groupExams.length}{" "}
                {mainMode === "single" ? "场考试" : "个大考"}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Scrollable content area */}
      <div className="flex-1 overflow-auto px-8 pb-6">
        {/* ── Single exam list ── */}
        {mainMode === "single" && (
          <DataTable
            columns={examColumns}
            data={exams}
            loading={loading}
            onRowClick={(exam) => onSelectExam(exam.id)}
            getRowId={(exam) => String(exam.id)}
            empty={
              <EmptyState
                icon={<Search />}
                title="暂无考试"
                description="请在「考试管理」中创建考试后再回到这里查看成绩。"
              />
            }
          />
        )}

        {/* ── Exam group list ── */}
        {mainMode === "group" && (
          <DataTable
            columns={groupColumns}
            data={groupExams}
            loading={loading}
            onRowClick={
              onSelectGroup ? (group) => onSelectGroup(group.id) : undefined
            }
            getRowId={(group) => String(group.id)}
            empty={
              <EmptyState
                icon={<Layers />}
                title="暂无大考"
                description="请在「考试管理」中创建大考合集后再回到这里查看。"
              />
            }
          />
        )}

        {/* ── Cross-exam analysis ── */}
        {mainMode === "cross" && (
          <div className="flex flex-col">
            {/* Cross mode tabs + filters */}
            <div className="mb-4 flex flex-wrap items-end gap-3">
              <SegmentedControl
                value={crossMode}
                onValueChange={setCrossMode}
                items={CROSS_MODES}
                size="sm"
                aria-label="跨考模式"
              />

              <FilterCol label="年级">
                <Select
                  value={gradeId === "" ? ALL : gradeId}
                  onValueChange={(v) => setGradeId(v === ALL ? "" : v)}
                >
                  <SelectTrigger className="h-control-sm w-32 text-sm">
                    <SelectValue placeholder="全部" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>全部</SelectItem>
                    {grades.map((g) => (
                      <SelectItem key={g.id} value={String(g.id)}>
                        {g.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FilterCol>
              {crossMode === "selected" && (
                <FilterCol label="科目">
                  <Select
                    value={subject === "" ? ALL : subject}
                    onValueChange={(v) => setSubject(v === ALL ? "" : v)}
                  >
                    <SelectTrigger className="h-control-sm w-32 text-sm">
                      <SelectValue placeholder="全部" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL}>全部</SelectItem>
                      {filters.subjects.map((s) => (
                        <SelectItem key={s} value={s}>
                          {s}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FilterCol>
              )}
              <FilterCol label="班级">
                <Select
                  value={classId === "" ? ALL : classId}
                  onValueChange={(v) => setClassId(v === ALL ? "" : v)}
                >
                  <SelectTrigger className="h-control-sm w-44 text-sm">
                    <SelectValue placeholder="全部班级" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>全部班级</SelectItem>
                    {classes.map((c) => (
                      <SelectItem key={c.id} value={String(c.id)}>
                        {c.grade_name ? `${c.grade_name}/${c.name}` : c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FilterCol>
              <FilterCol label="出勤">
                <Select
                  value={attendanceMode}
                  onValueChange={(v) =>
                    setAttendanceMode(v as CrossExamAttendanceMode)
                  }
                >
                  <SelectTrigger className="h-control-sm w-32 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">缺考计0</SelectItem>
                    <SelectItem value="full">仅全勤</SelectItem>
                  </SelectContent>
                </Select>
              </FilterCol>
            </div>

            {/* Week mode — date row + preview */}
            {crossMode === "week" && (
              <div className="mb-4 flex flex-col gap-2.5">
                <div className="flex flex-wrap items-end gap-2.5">
                  <FilterCol label="开始日期">
                    <Input
                      type="date"
                      value={startDate}
                      onChange={(e) => setStartDate(e.target.value)}
                      className="h-control-sm w-40 text-sm tabular-nums"
                    />
                  </FilterCol>
                  <FilterCol label="结束日期">
                    <Input
                      type="date"
                      value={endDate}
                      onChange={(e) => setEndDate(e.target.value)}
                      className="h-control-sm w-40 text-sm tabular-nums"
                    />
                  </FilterCol>
                  <Button
                    variant="primary"
                    size="sm"
                    loading={crossLoading}
                    onClick={() =>
                      runCrossTotal({ mode: "week", startDate, endDate })
                    }
                  >
                    统计这一周
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!weekResultExamIds.length}
                    loading={savingGroup}
                    onClick={() =>
                      saveCrossGroup(
                        "week",
                        weekResultExamIds,
                        `${startDate}至${endDate}考试组`,
                      )
                    }
                  >
                    保存为组
                  </Button>
                </div>
                {/* Week preview */}
                <div className="flex flex-col gap-1">
                  <div className="text-xs text-muted-foreground">
                    本周预览（
                    <span className="tabular-nums">
                      {weekPreviewExams.length}
                    </span>{" "}
                    场考试）：
                  </div>
                  <DataTable
                    columns={previewColumns}
                    data={weekPreviewExams}
                    loading={loading}
                    getRowId={(exam) => String(exam.id)}
                    wrapClassName="max-h-[200px]"
                    empty={
                      <EmptyState
                        size="sm"
                        icon={<CalendarDays />}
                        title="该日期范围内暂无考试"
                        description="调整开始/结束日期后再试。"
                      />
                    }
                  />
                </div>
              </div>
            )}

            {/* Selected mode */}
            {crossMode === "selected" && (
              <div className="mb-4 flex flex-col gap-3">
                <div className="flex flex-wrap items-end gap-2.5">
                  <Input
                    value={groupName}
                    onChange={(e) => setGroupName(e.target.value)}
                    placeholder="考试组名称（可选）"
                    className="h-control-sm w-52 text-sm"
                  />
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={selectedIds.length === 0}
                    loading={savingGroup}
                    onClick={() =>
                      saveCrossGroup(
                        "cross-manual",
                        selectedIds,
                        `手动组-${today()}`,
                      )
                    }
                  >
                    合并保存并统计
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={selectedIds.length === 0}
                    loading={crossLoading}
                    onClick={() =>
                      runCrossTotal({ mode: "selected", examIds: selectedIds })
                    }
                  >
                    仅统计
                  </Button>
                  <span className="pb-1.5 text-sm tabular-nums text-muted-foreground">
                    已选 {selectedIds.length} 场
                  </span>
                </div>
                {/* Exam picker list */}
                <DataTable
                  columns={pickerColumns}
                  data={exams}
                  loading={loading}
                  getRowId={(exam) => String(exam.id)}
                  isRowSelected={(exam) => selectedExamIds.has(exam.id)}
                  onRowClick={(exam) => toggleExamSelected(exam.id)}
                  wrapClassName="max-h-[260px]"
                  empty={
                    <EmptyState
                      size="sm"
                      icon={<Inbox />}
                      title="暂无匹配考试"
                      description="放宽年级/科目筛选后再试。"
                    />
                  }
                />
              </div>
            )}

            {/* Group mode */}
            {crossMode === "group" && (
              <div className="mb-4 flex flex-wrap items-end gap-2.5">
                <FilterCol label="考试组">
                  <Select
                    value={selectedGroupId}
                    onValueChange={setSelectedGroupId}
                  >
                    <SelectTrigger className="h-control-sm w-60 text-sm">
                      <SelectValue placeholder="请选择..." />
                    </SelectTrigger>
                    <SelectContent>
                      {crossGroups.map((g) => (
                        <SelectItem key={g.id} value={String(g.id)}>
                          {g.name}（{g.examIds.length}场）
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FilterCol>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!selectedGroupId}
                  loading={crossLoading}
                  onClick={() =>
                    runCrossTotal({
                      mode: "group",
                      groupId: Number(selectedGroupId),
                    })
                  }
                >
                  统计
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Trash2 />}
                  disabled={!selectedGroupId}
                  onClick={confirmDeleteCrossGroup}
                >
                  删除
                </Button>
              </div>
            )}

            {/* Delete confirm */}
            <ConfirmDialog
              open={showDeleteConfirm}
              onOpenChange={setShowDeleteConfirm}
              title="确认删除考试组"
              description={
                <>
                  将删除「<strong className="text-foreground">{deleteGroupName}</strong>
                  」。该组关联了{" "}
                  <strong className="tabular-nums text-foreground">
                    {deleteCount}
                  </strong>{" "}
                  场考试（考试本身不受影响）。关联的考试仍可用于其他大考合集。
                </>
              }
              confirmLabel="确认删除"
              onConfirm={deleteCrossGroup}
            />

            {/* Results */}
            {crossMessage && (
              <div className="mb-3 py-3 text-center text-sm text-muted-foreground">
                {crossMessage}
              </div>
            )}
            {crossResult && !crossLoading && (
              <CrossResultTable
                result={crossResult}
                columns={crossColumns}
                rows={crossFilteredRows}
                search={crossSearch}
                setSearch={setCrossSearch}
                loading={crossLoading}
              />
            )}
            {crossLoading && (
              <DataTable
                columns={crossSkeletonColumns}
                data={[]}
                loading
                skeletonRows={6}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Sub-components ──

function FilterCol({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function CrossResultTable({
  result,
  columns,
  rows,
  search,
  setSearch,
  loading,
}: {
  result: CrossExamTotalResponse;
  columns: ColumnDef<CrossExamTotalResponse["rows"][number], unknown>[];
  rows: CrossExamTotalResponse["rows"];
  search: string;
  setSearch: (v: string) => void;
  loading: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      <StatCardRow>
        <StatCard value={result.summary.examCount} label="考试数" />
        <StatCard value={result.summary.studentCount} label="统计人数" />
        <StatCard
          value={formatScore(result.summary.totalFullScore)}
          label="总满分"
        />
        <StatCard
          value={formatScore(result.summary.avgTotalScore)}
          label="平均总分"
        />
        <StatCard
          value={formatScore(result.summary.maxTotalScore)}
          label="最高总分"
        />
        <StatCard
          value={result.summary.fullAttendanceCount}
          label="全勤人数"
        />
      </StatCardRow>

      <section className="flex flex-col gap-2">
        <h3 className="m-0 text-base font-semibold text-foreground">考试包</h3>
        <div className="flex flex-wrap gap-2">
          {result.exams.map((exam) => (
            <Badge key={exam.id} tone="neutral" className="rounded-full">
              {exam.examDate || "无日期"} · {exam.name} · 满分
              {formatScore(exam.fullScore)}
            </Badge>
          ))}
        </div>
      </section>

      {result.classSummaries.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="m-0 text-base font-semibold text-foreground">
            班级汇总
          </h3>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-2">
            {result.classSummaries.map((item) => (
              <div
                key={`${item.classId ?? "unknown"}`}
                className="rounded-md border border-border-subtle bg-secondary p-2.5 text-sm"
              >
                <div className="font-semibold text-foreground">
                  {item.gradeName
                    ? `${item.gradeName} / ${item.className}`
                    : item.className}
                </div>
                <div className="mt-1 tabular-nums text-muted-foreground">
                  人数 {item.count} · 均分 {formatScore(item.avgScore)}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <h3 className="m-0 text-base font-semibold text-foreground">
            总成绩排名
          </h3>
          <div
            className={cn(
              "ml-auto flex items-center gap-1.5",
              "rounded-md border border-border-subtle bg-card px-2.5",
            )}
          >
            <Search className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索姓名/学号/班级"
              aria-label="搜索姓名/学号/班级"
              className="h-control-sm w-52 border-none bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>
        </div>
        <DataTable
          columns={columns}
          data={rows}
          loading={loading}
          getRowId={(row) => String(row.studentId)}
          empty={
            <EmptyState
              size="sm"
              icon={<Inbox />}
              title="没有匹配的学生"
              description="换个关键字，或清空搜索框查看全部。"
            />
          }
        />
      </section>
    </div>
  );
}
