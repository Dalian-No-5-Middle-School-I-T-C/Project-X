// ExamManagePage — 从 App.tsx 抽出的「考试管理」页面（B2：改由 useWorkspace 消费共享状态）。
// P4/T5：整页迁移到 v2 视觉体系（Button / SegmentedControl / Table / ExamStatusBadge / EmptyState）。
// 行为与迁移前完全一致：API 端点、请求体、路由与权限判断零改动。
import { CalendarDays, CalendarX2, ClipboardList, Layers, Megaphone, Plus, Search, Trash2, UserRoundPlus, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { fetchJson } from "../auth/api";
import { useWorkspace } from "../WorkspaceContext";
import { ExamDetailPage } from "../components/ExamDetailPage";
import { useIsMobile } from "../hooks/useMediaQuery";
import {
  Badge,
  Button,
  Calendar,
  Card,
  Checkbox,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  ExamStatusBadge,
  Input,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableWrap,
  type ExamStatus,
  type SegmentedItem,
} from "../components/ui/v2";
import { cn } from "../lib/utils";
import { EXAM_MODE_LABELS, type ExamMode, type ExamRecord } from "../../../../shared/types";

/** 答题卡下拉「未选择」哨兵：Radix Select 不接受空字符串 value */
const CARD_PLACEHOLDER = "__no_card__";

type ExamStatusFilter = "all" | "draft" | "grading" | "closed";

const STATUS_FILTER_ITEMS: ReadonlyArray<SegmentedItem<ExamStatusFilter>> = [
  { value: "all", label: "全部" },
  { value: "draft", label: "未开始" },
  { value: "grading", label: "阅卷中" },
  { value: "closed", label: "已完成" },
];

const MANAGE_MODE_ITEMS: ReadonlyArray<SegmentedItem<"single" | "group">> = [
  { value: "single", label: "单科考试" },
  { value: "group", label: "大考", icon: <Layers /> },
];

type ExamView = "list" | "calendar";

const EXAM_VIEW_ITEMS: ReadonlyArray<SegmentedItem<ExamView>> = [
  { value: "list", label: "列表" },
  { value: "calendar", label: "日历", icon: <CalendarDays /> },
];

/** 本地时区今天 "YYYY-MM-DD"（与后端考试日期语义一致） */
function todayDateString(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** "YYYY-MM-DD" → "2026 年 8 月 18 日 · 星期二" */
function formatExamDateLabel(dateStr: string): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  const weekday = ["日", "一", "二", "三", "四", "五", "六"][new Date(year, month - 1, day).getDay()];
  return `${year} 年 ${month} 月 ${day} 日 · 星期${weekday}`;
}

/** 后端 exam.status → v2 考试状态枚举（未开始 / 阅卷中 / 已完成 / 异常） */
function toExamStatus(status: string): ExamStatus {
  if (status === "closed") return "done";
  if (status === "grading") return "grading";
  if (status === "draft") return "pending";
  return "error";
}

/** 状态徽章文案：草稿/阅卷中/已完成，未知状态原样透出 */
function examStatusLabel(status: string): string {
  if (status === "closed") return "已完成";
  if (status === "grading") return "阅卷中";
  if (status === "draft") return "草稿";
  return status;
}

export function ExamManagePage() {
  const {
    user,
    mode,
    selectedExamId,
    setSelectedExamId,
    examManageMode,
    setExamManageMode,
    showCreateExam,
    setShowCreateExam,
    showCreateGroup,
    setShowCreateGroup,
    selectedExamIds,
    setSelectedExamIds,
    newExamName,
    setNewExamName,
    newExamSubject,
    setNewExamSubject,
    newExamCardId,
    setNewExamCardId,
    exams,
    examGroups,
    loadExams,
    loadExamGroups,
    setExamDeleteTarget,
    setGroupDeleteTarget,
    setAssignedFormulaExamId,
    cards,
    card,
    setStatus,
    switchMode,
    onStartReview,
  } = useWorkspace();

  const active = mode === "exam-manage";
  const teacherId = user?.id ?? 0;
  const teacherRole = user?.teacher_role ?? null;
  const userRole = user?.role_name ?? "";
  const isMobile = useIsMobile();
  const [examSearch, setExamSearch] = useState("");
  const [examStatusFilter, setExamStatusFilter] = useState<ExamStatusFilter>("all");
  const [examView, setExamView] = useState<ExamView>("list");
  const [selectedCalendarDate, setSelectedCalendarDate] = useState(() => todayDateString());
  const [creating, setCreating] = useState(false);
  const [newExamMode, setNewExamMode] = useState<ExamMode>("formal");
  // 评审 P1-2：创建考试必须确定应考范围（年级或班级至少其一）
  const [newExamGradeId, setNewExamGradeId] = useState<string>(CARD_PLACEHOLDER);
  const [newExamClassId, setNewExamClassId] = useState<string>(CARD_PLACEHOLDER);
  const [gradesList, setGradesList] = useState<Array<{ id: number; name: string }>>([]);
  const [classesList, setClassesList] = useState<Array<{ id: number; name: string }>>([]);
  // 评审 P1-2：显式应考名单管理（跨班/跨年级联考、补救无范围考试）
  const [rosterExam, setRosterExam] = useState<ExamRecord | null>(null);
  const [rosterData, setRosterData] = useState<{ source: string | null; known: boolean; total: number; students: Array<{ studentId: number; studentNumber: string | null; name: string; source?: string }> } | null>(null);
  const [rosterGradeId, setRosterGradeId] = useState<string>(CARD_PLACEHOLDER);
  const [rosterClassOptions, setRosterClassOptions] = useState<Array<{ id: number; name: string }>>([]);
  const [rosterClassId, setRosterClassId] = useState<string>(CARD_PLACEHOLDER);
  const [rosterClassStudents, setRosterClassStudents] = useState<Array<{ student_id: number; name: string; student_number: string | null }>>([]);
  const [rosterKeyword, setRosterKeyword] = useState("");
  const [rosterSearchResults, setRosterSearchResults] = useState<Array<{ id: number; name: string; studentNumber?: string; student_number?: string | null }>>([]);
  const [rosterSaving, setRosterSaving] = useState(false);
  // 保留策略（评审 P1）：仅管理员可见；"auto"= 按考试类型自动分配（quiz→周测、formal→不绑定）
  const [availablePolicies, setAvailablePolicies] = useState<Array<{ id: number; name: string; retainDays: number }>>([]);
  const [newExamRetentionPolicy, setNewExamRetentionPolicy] = useState<string>("auto");
  // v41/v42: 成绩公布/撤回 —— 单场公布/撤回确认框、批量公布确认框、请求中标志
  const [publishTarget, setPublishTarget] = useState<ExamRecord | null>(null);
  const [batchPublishOpen, setBatchPublishOpen] = useState(false);
  const [unpublishTarget, setUnpublishTarget] = useState<ExamRecord | null>(null);
  const [unpublishReason, setUnpublishReason] = useState("");
  const [publishing, setPublishing] = useState(false);

  useEffect(() => {
    // 保留策略列表为管理员接口（SYSTEM_MANAGE），仅管理员拉取
    if (userRole !== "admin") return;
    let active = true;
    fetchJson<{ ok: boolean; data: Array<{ id: number; name: string; retainDays: number }> }>("/api/admin/data-retention-policies")
      .then((res) => { if (active && res?.ok) setAvailablePolicies(res.data); })
      .catch(() => {});
    return () => { active = false; };
  }, [userRole]);

  // 评审 P1-2：加载年级/班级（创建考试应考范围必选其一）
  useEffect(() => {
    fetchJson<Array<{ id: number; name: string }>>("/api/classes/grades")
      .then((grades) => { if (Array.isArray(grades)) setGradesList(grades); })
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!newExamGradeId || newExamGradeId === CARD_PLACEHOLDER) {
      setClassesList([]);
      return;
    }
    fetchJson<Array<{ id: number; name: string }>>(`/api/classes?gradeId=${Number(newExamGradeId)}`)
      .then((cls) => { if (Array.isArray(cls)) setClassesList(cls); })
      .catch(() => setClassesList([]));
  }, [newExamGradeId]);

  /** 评审 P1-2：打开应考名单管理（拉取当前名单） */
  async function openRosterModal(exam: ExamRecord) {
    setRosterExam(exam);
    setRosterData(null);
    setRosterGradeId(CARD_PLACEHOLDER);
    setRosterClassOptions([]);
    setRosterClassId(CARD_PLACEHOLDER);
    setRosterClassStudents([]);
    setRosterKeyword("");
    setRosterSearchResults([]);
    try {
      const data = await fetchJson<{ source: string | null; known: boolean; total: number; students: Array<{ studentId: number; studentNumber: string | null; name: string; source?: string }> }>(`/api/exams/${exam.id}/participants`);
      setRosterData(data ?? { source: null, known: false, total: 0, students: [] });
    } catch {
      setRosterData({ source: null, known: false, total: 0, students: [] });
    }
  }

  /** 评审 P1-2：选择年级 → 加载班级列表 */
  async function loadRosterClasses(gradeId: string) {
    setRosterGradeId(gradeId);
    setRosterClassId(CARD_PLACEHOLDER);
    setRosterClassStudents([]);
    if (!gradeId || gradeId === CARD_PLACEHOLDER) {
      setRosterClassOptions([]);
      return;
    }
    try {
      const cls = await fetchJson<Array<{ id: number; name: string }>>(`/api/classes?gradeId=${Number(gradeId)}`);
      setRosterClassOptions(Array.isArray(cls) ? cls : []);
    } catch {
      setRosterClassOptions([]);
    }
  }

  /** 评审 P1-2：选择班级 → 加载学生（供添加到显式名单） */
  async function loadRosterClassStudents(classId: string) {
    setRosterClassId(classId);
    if (!classId || classId === CARD_PLACEHOLDER) {
      setRosterClassStudents([]);
      return;
    }
    try {
      const rows = await fetchJson<Array<{ student_id: number; name: string; student_number: string | null }>>(`/api/classes/${Number(classId)}/students`);
      setRosterClassStudents(Array.isArray(rows) ? rows : []);
    } catch {
      setRosterClassStudents([]);
    }
  }

  /** 评审 P1-2：搜索学生（学号/姓名） */
  async function searchRosterStudents(keyword: string) {
    setRosterKeyword(keyword);
    if (!keyword.trim()) {
      setRosterSearchResults([]);
      return;
    }
    try {
      const res = await fetchJson<{ users?: Array<{ id: number; name: string; student_number?: string | null; studentNumber?: string | null }> }>(`/api/users?keyword=${encodeURIComponent(keyword.trim())}&pageSize=20`);
      setRosterSearchResults((res?.users ?? []).map((u) => ({ id: u.id, name: u.name, student_number: u.student_number ?? u.studentNumber ?? null })));
    } catch {
      setRosterSearchResults([]);
    }
  }

  /** 评审 P1-2：保存显式名单（整体替换） */
  async function handleSaveRoster() {
    if (!rosterExam || rosterSaving) return;
    setRosterSaving(true);
    try {
      const ids = (rosterData?.students ?? []).map((s) => s.studentId);
      await fetchJson(`/api/exams/${rosterExam.id}/participants`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentIds: ids }),
      });
      setStatus("应考名单已保存（发布完整性将按此名单校验）");
      await openRosterModal(rosterExam);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "保存名单失败");
    } finally {
      setRosterSaving(false);
    }
  }

  /** 评审 P1-2：清除显式名单（回落班级/年级名册） */
  async function handleClearRoster() {
    if (!rosterExam) return;
    try {
      await fetchJson(`/api/exams/${rosterExam.id}/participants`, { method: "DELETE" });
      setStatus("显式应考名单已清除（将按年级/班级名册校验）");
      await openRosterModal(rosterExam);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "清除名单失败");
    }
  }

  const visibleExams = useMemo(() => exams.filter((exam) => {
    const matchesSearch = !examSearch.trim() || exam.name.toLowerCase().includes(examSearch.trim().toLowerCase());
    return matchesSearch && (examStatusFilter === "all" || exam.status === examStatusFilter);
  }), [exams, examSearch, examStatusFilter]);

  /** 日历角标：日期 → 当天考试数 */
  const examDateMarks = useMemo(() => {
    const marks = new Map<string, number>();
    for (const exam of exams) {
      if (!exam.exam_date) continue;
      marks.set(exam.exam_date, (marks.get(exam.exam_date) ?? 0) + 1);
    }
    return marks;
  }, [exams]);

  const examsOnDate = useMemo(
    () => exams.filter((exam) => exam.exam_date === selectedCalendarDate),
    [exams, selectedCalendarDate],
  );

  const cardSelectValue = newExamCardId || card?.id || CARD_PLACEHOLDER;

  function toggleExamSelected(examId: number) {
    const next = new Set(selectedExamIds);
    if (next.has(examId)) next.delete(examId); else next.add(examId);
    setSelectedExamIds(next);
  }

  /** 日历日期切换：清空勾选，避免此前日期的隐藏选中误入批量删除 */
  function handleCalendarDateChange(date: string) {
    setSelectedCalendarDate(date);
    setSelectedExamIds(new Set());
  }

  /** 列表/日历视图切换：清空勾选，避免列表选中的考试在日历视图不可见却仍计入批量删除 */
  function handleExamViewChange(next: ExamView) {
    setExamView(next);
    setSelectedExamIds(new Set());
  }

  /** 单科/大考模式切换：大考视图无勾选 UI，切回单科时不应复活此前的隐藏选中 */
  function handleManageModeChange(next: "single" | "group") {
    setExamManageMode(next);
    setSelectedExamIds(new Set());
    if (next === "group") loadExamGroups();
  }

  function handleCardPicked(selectedCardId: string) {
    if (selectedCardId === CARD_PLACEHOLDER) return;
    setNewExamCardId(selectedCardId);
    const selectedCard = cards.find((c) => c.id === selectedCardId);
    if (selectedCard) {
      if (!newExamName) setNewExamName(selectedCard.title);
      if (!newExamSubject) setNewExamSubject(selectedCard.subjectLabel || "");
    }
  }

  /** v41: 单场成绩公布（确认后调接口并刷新列表） */
  async function handlePublishExam(examId: number) {
    if (publishing) return;
    setPublishing(true);
    try {
      await fetchJson(`/api/exams/${examId}/publish`, { method: "POST" });
      setPublishTarget(null);
      setStatus("成绩已公布，学生可查看");
      await loadExams();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "公布失败");
    } finally {
      setPublishing(false);
    }
  }

  /** v41: 批量成绩公布 */
  async function handlePublishBatch() {
    if (publishing || selectedExamIds.size === 0) return;
    const count = selectedExamIds.size;
    setPublishing(true);
    try {
      await fetchJson("/api/exams/publish-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ examIds: Array.from(selectedExamIds) }),
      });
      setBatchPublishOpen(false);
      setSelectedExamIds(new Set());
      setStatus(`已批量公布 ${count} 场考试的成绩`);
      await loadExams();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "批量公布失败");
    } finally {
      setPublishing(false);
    }
  }

  /** v42: 撤回成绩公布（确认后调接口，写审计日志） */
  async function handleUnpublishExam(examId: number) {
    if (publishing) return;
    setPublishing(true);
    try {
      await fetchJson(`/api/exams/${examId}/unpublish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: unpublishReason.trim() || undefined }),
      });
      setUnpublishTarget(null);
      setUnpublishReason("");
      setStatus("成绩已撤回，学生不可再查看");
      await loadExams();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "撤回失败");
    } finally {
      setPublishing(false);
    }
  }

  async function handleCreateExam() {
    if (creating) return;
    const name = newExamName.trim();
    if (!name) { setStatus("请填写考试名称"); return; }
    // 评审 P1-2：创建考试必须确定应考范围（年级或班级至少其一）
    const gradeId = newExamGradeId && newExamGradeId !== CARD_PLACEHOLDER ? Number(newExamGradeId) : undefined;
    const classId = newExamClassId && newExamClassId !== CARD_PLACEHOLDER ? Number(newExamClassId) : undefined;
    if (!gradeId && !classId) {
      setStatus("【完整性校验】请选择应考范围（年级或班级至少其一）");
      return;
    }
    setCreating(true);
    try {
      let cardId = newExamCardId || card?.id;
      // 方案 B：如果没有选择答题卡，先自动创建一张最简答题卡
      if (!cardId) {
        const subjectPinyinMap: Record<string, string> = {
          "语文": "yuwen", "数学": "shuxue", "英语": "yingyu", "外语": "yingyu",
          "物理": "wuli", "化学": "huaxue", "生物": "shengwu",
          "政治": "zhengzhi", "历史": "lishi", "地理": "dili"
        };
        const subjectVal = newExamSubject.trim();
        const subjectPinyin = subjectPinyinMap[subjectVal] || subjectVal || "custom";
        const today = new Date().toISOString().split("T")[0];
        const cardRes = await fetchJson<any>("/api/cards", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            subject: subjectPinyin,
            title: name,
            subjectLabel: subjectVal || undefined,
            examDate: today,
            englishListening: false,
            chineseChoicePlacement: "front"
          })
        });
        cardId = cardRes.id;
      }
      const payload: Record<string, unknown> = {
        name,
        cardId,
        subject: newExamSubject.trim() || undefined,
        mode: newExamMode,
        gradeId,
        classId,
      };
      // 管理员显式指定策略时透传（"auto"=按类型自动分配，交给后端解析）
      if (userRole === "admin" && newExamRetentionPolicy !== "auto") {
        payload.retentionPolicyId = newExamRetentionPolicy === "none" ? null : Number(newExamRetentionPolicy);
      }
      await fetchJson("/api/exams", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      setNewExamName(""); setNewExamSubject(""); setNewExamMode("formal"); setNewExamRetentionPolicy("auto");
      setNewExamGradeId(CARD_PLACEHOLDER); setNewExamClassId(CARD_PLACEHOLDER); setShowCreateExam(false);
      loadExams();
    } catch (err) {
      setStatus(`创建失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setCreating(false);
    }
  }

  /** 考试列表渲染（移动端卡片 / 桌面表格），列表与日历视图共用 */
  function renderExamList(items: ExamRecord[], allItems: ExamRecord[]) {
    // 全选判定必须按考试 ID 逐一比对：仅比数量会让「两天各有相同场次」时的隐藏选中误判为全选
    const allSelected = allItems.length > 0 && allItems.every((exam) => selectedExamIds.has(exam.id));
    if (isMobile) {
      return (
        <div className="flex flex-col gap-3">
          {items.map((exam) => (
            <Card key={exam.id} className="p-4">
              <div className="flex items-start gap-3">
                <Checkbox
                  className="mt-1"
                  aria-label={`选择考试 ${exam.name}`}
                  checked={selectedExamIds.has(exam.id)}
                  onCheckedChange={() => toggleExamSelected(exam.id)}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-base font-medium text-foreground">{exam.name}</span>
                    <Badge tone={exam.exam_mode === "formal" ? "info" : "neutral"} className="shrink-0">
                      {EXAM_MODE_LABELS[exam.exam_mode === "formal" ? "formal" : "quiz"]}
                    </Badge>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {exam.subject || "—"} · 答题卡 {exam.card_id ?? "未关联"}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <ExamStatusBadge status={toExamStatus(exam.status)} label={examStatusLabel(exam.status)} />
                  <Badge tone={exam.score_published === 1 ? "success" : exam.score_published === 2 ? "danger" : "neutral"} className="shrink-0">
                    {exam.score_published === 1 ? "已公布" : exam.score_published === 2 ? "已撤回" : "未公布"}
                  </Badge>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap justify-end gap-2">
                <Button variant="ghost" size="sm" className="text-info-foreground" onClick={() => setSelectedExamId(exam.id)}>网阅</Button>
                <Button variant="ghost" size="sm" className="text-info-foreground" icon={<Users />} onClick={() => void openRosterModal(exam)}>应考名单</Button>
                <Button variant="ghost" size="sm" className="text-destructive-fg" onClick={() => setExamDeleteTarget({ exams: [exam], deleteLinkedCards: false })}>删除</Button>
                <Button variant="ghost" size="sm" className="text-success-foreground" onClick={() => setAssignedFormulaExamId(exam.id)}>赋分</Button>
                {exam.score_published === 1 ? (
                  <Button variant="ghost" size="sm" className="text-destructive-fg" onClick={() => { setUnpublishReason(""); setUnpublishTarget(exam); }}>撤回公布</Button>
                ) : (
                  <Button variant="ghost" size="sm" className="text-success-foreground" disabled={exam.status !== "closed"} onClick={() => setPublishTarget(exam)}>
                    {exam.score_published === 2 ? "重新公布" : "公布分数"}
                  </Button>
                )}
              </div>
            </Card>
          ))}
        </div>
      );
    }
    return (
      <TableWrap className="rounded-lg border border-border-subtle bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <Checkbox
                  aria-label="全选考试"
                  checked={allSelected}
                  onCheckedChange={(checked) => {
                    if (checked === true) setSelectedExamIds(new Set(allItems.map((ex) => ex.id)));
                    else setSelectedExamIds(new Set());
                  }}
                />
              </TableHead>
              <TableHead className="min-w-40">考试名称</TableHead>
              <TableHead className="w-20">科目</TableHead>
              <TableHead className="w-28">答题卡</TableHead>
              <TableHead className="w-20">状态</TableHead>
              <TableHead className="w-72 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((exam) => (
              <TableRow key={exam.id}>
                <TableCell>
                  <Checkbox
                    aria-label={`选择考试 ${exam.name}`}
                    checked={selectedExamIds.has(exam.id)}
                    onCheckedChange={() => toggleExamSelected(exam.id)}
                  />
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{exam.name}</span>
                    <Badge tone={exam.exam_mode === "formal" ? "info" : "neutral"} className="shrink-0">
                      {EXAM_MODE_LABELS[exam.exam_mode === "formal" ? "formal" : "quiz"]}
                    </Badge>
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground">{exam.subject || "—"}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{exam.card_id ?? "未关联"}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-1.5">
                    <ExamStatusBadge status={toExamStatus(exam.status)} label={examStatusLabel(exam.status)} />
                    <Badge tone={exam.score_published === 1 ? "success" : exam.score_published === 2 ? "danger" : "neutral"} className="shrink-0">
                      {exam.score_published === 1 ? "已公布" : exam.score_published === 2 ? "已撤回" : "未公布"}
                    </Badge>
                  </div>
                </TableCell>
                <TableCell className="text-right whitespace-nowrap">
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="sm" className="text-info-foreground" onClick={() => setSelectedExamId(exam.id)}>网阅</Button>
                    <Button variant="ghost" size="sm" className="text-info-foreground" icon={<Users />} onClick={() => void openRosterModal(exam)}>应考名单</Button>
                    <Button variant="ghost" size="sm" className="text-destructive-fg" onClick={() => setExamDeleteTarget({ exams: [exam], deleteLinkedCards: false })}>删除</Button>
                    <Button variant="ghost" size="sm" className="text-success-foreground" onClick={() => setAssignedFormulaExamId(exam.id)}>赋分</Button>
                    {exam.score_published === 1 ? (
                      <Button variant="ghost" size="sm" className="text-destructive-fg" onClick={() => { setUnpublishReason(""); setUnpublishTarget(exam); }}>撤回公布</Button>
                    ) : (
                      <Button variant="ghost" size="sm" className="text-success-foreground" disabled={exam.status !== "closed"} onClick={() => setPublishTarget(exam)}>
                        {exam.score_published === 2 ? "重新公布" : "公布分数"}
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableWrap>
    );
  }

  return (
    <div className={cn("min-h-full w-full overflow-auto bg-background", !active && "hidden")}>
      {selectedExamId ? (
        <section className="min-h-full w-full">
          <ExamDetailPage examId={selectedExamId} teacherId={teacherId} teacherRole={teacherRole} userRole={userRole} onBackToList={() => setSelectedExamId(null)} onBackHome={() => switchMode("home")} onStartReview={onStartReview} />
        </section>
      ) : (
        <section className="min-h-full w-full overflow-auto bg-background p-6">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            {examManageMode === "single" ? (
              <Button variant="primary" icon={<Plus />} onClick={() => setShowCreateExam(!showCreateExam)}>
                新建考试
              </Button>
            ) : (
              <Button variant="primary" icon={<Plus />} onClick={() => setShowCreateGroup(true)}>
                新建大考
              </Button>
            )}
            {examManageMode === "single" && selectedExamIds.size > 0 && (
              <Button
                variant="ghost"
                icon={<Megaphone />}
                className="text-success-foreground"
                onClick={() => setBatchPublishOpen(true)}
              >
                批量公布 ({selectedExamIds.size})
              </Button>
            )}
            {examManageMode === "single" && selectedExamIds.size > 0 && (
              <Button
                variant="ghost"
                icon={<Trash2 />}
                className="text-destructive-fg"
                onClick={() => setExamDeleteTarget({
                  exams: exams.filter((exam) => selectedExamIds.has(exam.id)),
                  deleteLinkedCards: false
                })}
              >
                删除选中 ({selectedExamIds.size})
              </Button>
            )}
            <span className="text-sm text-muted-foreground">
              共 <span className="tabular-nums">{examManageMode === "single" ? (examView === "calendar" ? exams.length : visibleExams.length) : examGroups.length}</span> {examManageMode === "single" ? "个考试" : "个大考"}
            </span>
            {examManageMode === "single" && examView === "list" && (
              <div className="order-last flex w-full flex-wrap items-center gap-3 lg:order-none lg:ml-4 lg:w-auto">
                <SegmentedControl
                  size="sm"
                  aria-label="考试状态筛选"
                  value={examStatusFilter}
                  onValueChange={setExamStatusFilter}
                  items={STATUS_FILTER_ITEMS}
                />
                <div className="relative">
                  <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                  <Input
                    className="w-56 pl-8"
                    value={examSearch}
                    onChange={(event) => setExamSearch(event.target.value)}
                    placeholder="搜索考试名称"
                    aria-label="搜索考试名称"
                  />
                </div>
              </div>
            )}
            {/* Single/Group toggle — right side */}
            <div className="ml-auto flex flex-wrap items-center gap-3">
              {examManageMode === "single" && (
                <SegmentedControl
                  size="sm"
                  aria-label="单科考试视图"
                  value={examView}
                  onValueChange={handleExamViewChange}
                  items={EXAM_VIEW_ITEMS}
                />
              )}
              <SegmentedControl
                aria-label="考试管理视图"
                value={examManageMode}
                onValueChange={handleManageModeChange}
                items={MANAGE_MODE_ITEMS}
              />
            </div>
          </div>

          {examManageMode === "single" && showCreateExam && (
            <Card className="mb-4 grid grid-cols-1 items-end gap-3 p-4 md:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_1fr_auto]">
              <Input
                value={newExamName}
                onChange={(e) => setNewExamName(e.target.value)}
                placeholder="考试名称"
                aria-label="考试名称"
              />
              <Input
                value={newExamSubject}
                onChange={(e) => setNewExamSubject(e.target.value)}
                placeholder="科目（自动从答题卡继承）"
                aria-label="考试科目"
              />
              <Select value={cardSelectValue} onValueChange={handleCardPicked}>
                <SelectTrigger aria-label="选择答题卡">
                  <SelectValue placeholder="选择答题卡" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={CARD_PLACEHOLDER} disabled>选择答题卡</SelectItem>
                  {cards.map((c) => (<SelectItem key={c.id} value={c.id}>{c.title}</SelectItem>))}
                </SelectContent>
              </Select>
              <Select value={newExamMode} onValueChange={(v) => setNewExamMode(v === "formal" ? "formal" : "quiz")}>
                <SelectTrigger aria-label="考试模式">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="quiz">{EXAM_MODE_LABELS.quiz}（教师全量可见）</SelectItem>
                  <SelectItem value="formal">{EXAM_MODE_LABELS.formal}（精细权限）</SelectItem>
                </SelectContent>
              </Select>
              {/* 评审 P1-2：应考范围（年级或班级至少其一）—— 发布完整性校验的必要条件 */}
              <Select value={newExamGradeId} onValueChange={(v) => { setNewExamGradeId(v); setNewExamClassId(CARD_PLACEHOLDER); }}>
                <SelectTrigger aria-label="应考年级（必选其一）">
                  <SelectValue placeholder="应考年级" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={CARD_PLACEHOLDER} disabled>应考年级（必选其一）</SelectItem>
                  {gradesList.map((g) => (<SelectItem key={g.id} value={String(g.id)}>{g.name}</SelectItem>))}
                </SelectContent>
              </Select>
              <Select value={newExamClassId} onValueChange={setNewExamClassId} disabled={classesList.length === 0}>
                <SelectTrigger aria-label="应考班级（可选）">
                  <SelectValue placeholder={classesList.length === 0 ? "先选年级" : "应考班级（可选）"} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={CARD_PLACEHOLDER} disabled>应考班级（可选，不选=整个年级）</SelectItem>
                  {classesList.map((c) => (<SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>))}
                </SelectContent>
              </Select>
              {userRole === "admin" && (
                <Select value={newExamRetentionPolicy} onValueChange={setNewExamRetentionPolicy}>
                  <SelectTrigger aria-label="数据保留策略">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">保留策略：按考试类型自动分配</SelectItem>
                    <SelectItem value="none">保留策略：不绑定</SelectItem>
                    {availablePolicies.map((p) => (
                      <SelectItem key={p.id} value={String(p.id)}>
                        保留策略：{p.name}（{p.retainDays === 0 ? "永久" : `${p.retainDays} 天`}）
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <div className="flex gap-2">
                <Button variant="primary" loading={creating} onClick={() => void handleCreateExam()}>确认创建</Button>
                <Button variant="ghost" onClick={() => setShowCreateExam(false)}>取消</Button>
              </div>
            </Card>
          )}

          {/* 日历视图：按日期筛选当天考试 */}
          {examManageMode === "single" && examView === "calendar" && (
            <>
              <Card className="mb-4 p-4">
                <Calendar value={selectedCalendarDate} onValueChange={handleCalendarDateChange} markedDates={examDateMarks} />
              </Card>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold text-foreground">
                  {formatExamDateLabel(selectedCalendarDate)}
                  <span className="text-muted-foreground">
                    ，共 <span className="tabular-nums">{examsOnDate.length}</span> 场考试
                  </span>
                </h3>
                {selectedCalendarDate !== todayDateString() && (
                  <Button variant="ghost" size="sm" onClick={() => handleCalendarDateChange(todayDateString())}>回到今天</Button>
                )}
              </div>
              {examsOnDate.length === 0 ? (
                <EmptyState
                  size="sm"
                  icon={<CalendarX2 />}
                  title="当天暂无考试"
                  description="点击日历中带角标的日期，查看当天对应考试。"
                />
              ) : (
                renderExamList(examsOnDate, examsOnDate)
              )}
            </>
          )}

          {examManageMode === "single" && examView === "list" && exams.length === 0 && !showCreateExam && (
            <EmptyState
              icon={<ClipboardList />}
              title="暂无考试"
              description="点击上方「新建考试」创建。"
            />
          )}

          {examManageMode === "single" && examView === "list" && exams.length > 0 && (
            renderExamList(visibleExams, exams)
          )}

          {/* Exam group list */}
          {examManageMode === "group" && examGroups.length === 0 && (
            <EmptyState
              icon={<Layers />}
              title="暂无大考"
              description="点击上方「新建大考」创建。"
            />
          )}
          {examManageMode === "group" && examGroups.length > 0 && (
            isMobile ? (
              <div className="flex flex-col gap-3">
                {examGroups.map((group: any) => (
                  <Card key={group.id} className="p-4">
                    <div className="flex items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-base font-medium text-foreground">{group.name}</div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {group.grade_name || "—"} · 含 <span className="tabular-nums">{group.member_count}</span> 场考试
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <Badge tone={group.tag ? "solid" : "neutral"}>{group.tag || "—"}</Badge>
                        <Badge tone={group.has_results ? "success" : "neutral"} dot>
                          {group.has_results ? "有成绩" : "无成绩"}
                        </Badge>
                      </div>
                    </div>
                    <div className="mt-3 flex justify-end">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive-fg"
                        onClick={() => setGroupDeleteTarget({
                          groupId: group.id,
                          groupName: group.name,
                          memberCount: group.member_count,
                          deleteExams: false
                        })}
                      >
                        删除
                      </Button>
                    </div>
                  </Card>
                ))}
              </div>
            ) : (
              <TableWrap className="rounded-lg border border-border-subtle bg-card">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="min-w-45">大考名称</TableHead>
                      <TableHead className="w-20">标签</TableHead>
                      <TableHead className="w-20">年级</TableHead>
                      <TableHead className="w-24" numeric>含考试数</TableHead>
                      <TableHead className="w-24">有无成绩</TableHead>
                      <TableHead className="w-24 text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {examGroups.map((group: any) => (
                      <TableRow key={group.id}>
                        <TableCell className="font-medium">{group.name}</TableCell>
                        <TableCell>
                          <Badge tone={group.tag ? "solid" : "neutral"}>{group.tag || "—"}</Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground">{group.grade_name || "—"}</TableCell>
                        <TableCell numeric className="font-medium">{group.member_count}</TableCell>
                        <TableCell>
                          <Badge tone={group.has_results ? "success" : "neutral"} dot>
                            {group.has_results ? "有成绩" : "无成绩"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right whitespace-nowrap">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive-fg"
                            onClick={() => setGroupDeleteTarget({
                              groupId: group.id,
                              groupName: group.name,
                              memberCount: group.member_count,
                              deleteExams: false
                            })}
                          >
                            删除
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableWrap>
            )
          )}
        </section>
      )}

      {/* v41: 单场成绩公布确认框 */}
      <Dialog open={publishTarget !== null} onOpenChange={(open: boolean) => { if (!open && !publishing) setPublishTarget(null); }}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>公布分数</DialogTitle>
            <DialogDescription>
              确认公布「{publishTarget?.name ?? ""}」的成绩？公布后学生可立即查看该场考试的分数与排名。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPublishTarget(null)} disabled={publishing}>取消</Button>
            <Button variant="primary" loading={publishing} onClick={() => publishTarget && void handlePublishExam(publishTarget.id)}>确认公布</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* v41: 批量成绩公布确认框 */}
      <Dialog open={batchPublishOpen} onOpenChange={(open: boolean) => { if (!open && !publishing) setBatchPublishOpen(false); }}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>批量公布成绩</DialogTitle>
            <DialogDescription>
              确认公布选中的 {selectedExamIds.size} 场考试的成绩？公布后学生可立即查看。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBatchPublishOpen(false)} disabled={publishing}>取消</Button>
            <Button variant="primary" loading={publishing} onClick={() => void handlePublishBatch()}>确认批量公布</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* v42: 撤回成绩公布确认框（含原因输入，写入审计日志） */}
      <Dialog open={unpublishTarget !== null} onOpenChange={(open: boolean) => { if (!open && !publishing) setUnpublishTarget(null); }}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>撤回成绩公布</DialogTitle>
            <DialogDescription>
              确认撤回「{unpublishTarget?.name ?? ""}」的成绩公布？撤回后学生将无法查看该场考试成绩，可在后续重新公布。
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-3">
            <Input
              value={unpublishReason}
              onChange={(event) => setUnpublishReason(event.target.value)}
              placeholder="撤回原因（选填，将记录在审计日志中）"
              maxLength={500}
              aria-label="撤回原因"
            />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUnpublishTarget(null)} disabled={publishing}>取消</Button>
            <Button variant="destructive" loading={publishing} onClick={() => unpublishTarget && void handleUnpublishExam(unpublishTarget.id)}>确认撤回</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 评审 P1-2: 应考名单管理（显式名单；无范围考试须设置后方可公布） */}
      <Dialog open={rosterExam !== null} onOpenChange={(open: boolean) => { if (!open && !rosterSaving) setRosterExam(null); }}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>应考名单 — {rosterExam?.name ?? ""}</DialogTitle>
            <DialogDescription>
              发布完整性将按此名单校验：应考学生必须全部有成绩，名单外学号不允许入库。
              来源：{rosterData?.source === "explicit" ? "管理员显式名单" : rosterData?.source === "roster" ? "年级/班级名册（自动）" : "未确定"}
              （共 {rosterData?.total ?? 0} 人）
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-4">
            {!rosterData?.known && (
              <div className="rounded border border-warning bg-warning/10 px-3 py-2 text-sm text-warning-fg">
                该考试未确定应考范围（无年级/班级且无显式名单），当前无法公布成绩。请从下方添加学生并保存显式名单。
              </div>
            )}

            {/* 添加区：按班级加载（年级 → 班级 → 学生） */}
            <div className="flex flex-wrap items-end gap-2">
              <Select value={rosterGradeId} onValueChange={(v) => void loadRosterClasses(v)}>
                <SelectTrigger aria-label="选择年级" className="w-40">
                  <SelectValue placeholder="选择年级" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={CARD_PLACEHOLDER} disabled>选择年级</SelectItem>
                  {gradesList.map((g) => (<SelectItem key={g.id} value={String(g.id)}>{g.name}</SelectItem>))}
                </SelectContent>
              </Select>
              <Select value={rosterClassId} onValueChange={(v) => void loadRosterClassStudents(v)} disabled={rosterClassOptions.length === 0}>
                <SelectTrigger aria-label="选择班级" className="w-40">
                  <SelectValue placeholder={rosterClassOptions.length === 0 ? "先选年级" : "选择班级"} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={CARD_PLACEHOLDER} disabled>选择班级</SelectItem>
                  {rosterClassOptions.map((c) => (<SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>))}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                icon={<UserRoundPlus />}
                disabled={rosterClassStudents.length === 0}
                onClick={() => {
                  const existing = new Set((rosterData?.students ?? []).map((s) => s.studentId));
                  const additions = rosterClassStudents.filter((s) => !existing.has(s.student_id)).map((s) => ({ studentId: s.student_id, studentNumber: s.student_number, name: s.name }));
                  if (additions.length === 0) return;
                  setRosterData((prev) => ({ ...(prev ?? { source: null, known: true, total: 0 }), known: true, source: "explicit", total: (prev?.students?.length ?? 0) + additions.length, students: [...(prev?.students ?? []), ...additions] }));
                }}
              >
                添加该班未选学生（{rosterClassStudents.filter((s) => !(rosterData?.students ?? []).some((x) => x.studentId === s.student_id)).length}）
              </Button>
            </div>

            {/* 添加区：搜索学号/姓名 */}
            <div className="flex flex-wrap items-end gap-2">
              <Input
                value={rosterKeyword}
                onChange={(e) => void searchRosterStudents(e.target.value)}
                placeholder="搜索学生（学号/姓名）"
                aria-label="搜索学生"
                className="w-64"
              />
              {rosterSearchResults.length > 0 && (
                <div className="max-h-40 w-full overflow-auto rounded border p-2">
                  {rosterSearchResults.map((u) => {
                    const added = (rosterData?.students ?? []).some((s) => s.studentId === u.id);
                    return (
                      <div key={u.id} className="flex items-center justify-between py-1">
                        <span className="text-sm">{u.name}（{u.student_number ?? u.studentNumber ?? u.id}）</span>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={added}
                          onClick={() => {
                            if (added) return;
                            setRosterData((prev) => ({ ...(prev ?? { source: null, known: true, total: 0 }), known: true, source: "explicit", total: (prev?.students?.length ?? 0) + 1, students: [...(prev?.students ?? []), { studentId: u.id, studentNumber: u.student_number ?? u.studentNumber ?? null, name: u.name }] }));
                          }}
                        >
                          {added ? "已在名单" : "添加"}
                        </Button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* 当前名单 */}
            <div className="max-h-64 overflow-auto rounded border p-2">
              {(rosterData?.students?.length ?? 0) === 0 ? (
                <div className="py-6 text-center text-sm text-muted-foreground">名单为空</div>
              ) : (
                (rosterData?.students ?? []).map((s) => (
                  <div key={s.studentId} className="flex items-center justify-between py-1">
                    <span className="text-sm">
                      {s.name}（{s.studentNumber ?? "无学号"}）
                      {s.source === "roster" && <span className="ml-2 text-xs text-muted-foreground">名册自动</span>}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive-fg"
                      onClick={() => setRosterData((prev) => {
                        const cur = prev?.students ?? [];
                        return { ...(prev ?? { source: null, known: true, total: 0 }), total: Math.max(0, cur.length - 1), students: cur.filter((x) => x.studentId !== s.studentId) };
                      })}
                    >
                      移除
                    </Button>
                  </div>
                ))
              )}
            </div>
          </DialogBody>
          <DialogFooter className="flex-wrap gap-2">
            <Button variant="outline" onClick={() => setRosterExam(null)} disabled={rosterSaving}>关闭</Button>
            <Button variant="ghost" className="text-destructive-fg" loading={rosterSaving} onClick={() => void handleClearRoster()}>清除显式名单</Button>
            <Button variant="primary" icon={<UserRoundPlus />} loading={rosterSaving} onClick={() => void handleSaveRoster()}>保存名单</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
