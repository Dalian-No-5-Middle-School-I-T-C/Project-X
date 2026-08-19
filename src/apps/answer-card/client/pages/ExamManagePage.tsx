// ExamManagePage — 从 App.tsx 抽出的「考试管理」页面（B2：改由 useWorkspace 消费共享状态）。
// P4/T5：整页迁移到 v2 视觉体系（Button / SegmentedControl / Table / ExamStatusBadge / EmptyState）。
// 行为与迁移前完全一致：API 端点、请求体、路由与权限判断零改动。
import { CalendarDays, CalendarX2, ClipboardList, Layers, Plus, Search, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
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

  async function handleCreateExam() {
    if (creating) return;
    const name = newExamName.trim();
    if (!name) { setStatus("请填写考试名称"); return; }
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
      await fetchJson("/api/exams", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, cardId, subject: newExamSubject.trim() || undefined, mode: newExamMode }) });
      setNewExamName(""); setNewExamSubject(""); setNewExamMode("formal"); setShowCreateExam(false);
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
                <ExamStatusBadge status={toExamStatus(exam.status)} label={examStatusLabel(exam.status)} />
              </div>
              <div className="mt-3 flex flex-wrap justify-end gap-2">
                <Button variant="ghost" size="sm" className="text-info-foreground" onClick={() => setSelectedExamId(exam.id)}>网阅</Button>
                <Button variant="ghost" size="sm" className="text-destructive-fg" onClick={() => setExamDeleteTarget({ exams: [exam], deleteLinkedCards: false })}>删除</Button>
                <Button variant="ghost" size="sm" className="text-success-foreground" onClick={() => setAssignedFormulaExamId(exam.id)}>赋分</Button>
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
              <TableHead className="w-52 text-right">操作</TableHead>
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
                  <ExamStatusBadge status={toExamStatus(exam.status)} label={examStatusLabel(exam.status)} />
                </TableCell>
                <TableCell className="text-right whitespace-nowrap">
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="sm" className="text-info-foreground" onClick={() => setSelectedExamId(exam.id)}>网阅</Button>
                    <Button variant="ghost" size="sm" className="text-destructive-fg" onClick={() => setExamDeleteTarget({ exams: [exam], deleteLinkedCards: false })}>删除</Button>
                    <Button variant="ghost" size="sm" className="text-success-foreground" onClick={() => setAssignedFormulaExamId(exam.id)}>赋分</Button>
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
    </div>
  );
}
