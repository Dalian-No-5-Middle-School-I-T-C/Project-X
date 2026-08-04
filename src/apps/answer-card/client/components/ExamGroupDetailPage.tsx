import { useEffect, useMemo, useState } from "react";
import { Activity, ArrowLeft, BarChart3, ClipboardList, Download, FileText, Layers } from "lucide-react";
import { fetchJson } from "../auth/api";
import { useAuth } from "../auth/AuthContext";
import type {
  GroupOverview, GroupRankingResponse, GroupSubjectSummary,
  GroupMetrics, GroupQuestionAnalysisResponse, GroupClassComparisonResponse
} from "../../../../shared/types";
import { AnalysisQuestions } from "./AnalysisQuestions";
import { AnalysisOverall } from "./AnalysisOverall";
import { AnalysisAiPanel } from "./AnalysisAiPanel";
import { QuestionStudentScoresModal } from "./QuestionStudentScoresModal";
import { useBands, DifficultyBadge, DiscriminationBadge } from "./MetricBadge";
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  ErrorState,
  Panel,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  StatCard,
  StatCardRow,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableWrap,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  type SegmentedItem,
} from "./ui/v2";

/**
 * ExamGroupDetailPage —— T2 迁移（T02 入口与选择页子树，架构文档 §2.1）
 *
 * 换肤范围（功能守恒：API 端点 / 路由参数 / 权限判定逐行保留）：
 *  · 6 个手写下划线子 Tab → v2 `Tabs`（与 ScoreDetailPage 同形态）
 *  · `ViewToggleButton` 双按钮（总分+每科 / 逐科）→ v2 `SegmentedControl`
 *  · 旧分析区块容器工具类 → v2 `Panel`
 *  · 赋分标记的硬编码琥珀色 → `warning` 语义（Badge / text-warning-foreground）
 *  · 四组共享行内表格样式常量 → v2 `Table` 原语（numeric 列自带 tabular-nums）
 *  · 概览指标网格 → v2 `StatCard` / `StatCardRow`
 *  · 原生 `<select>` / `<input type="checkbox">` → v2 `Select` / `Checkbox`
 *
 * 说明：ScoresTab 的科目列是运行时动态展开（每科 3 子列），保留原生列结构而非
 * 换 DataTable，以免动态列语义走样；仅把样式换成 v2 `Table` 原语。
 */

interface ClassOption {
  id: number;
  name: string;
  grade_name?: string;
}

interface Props {
  groupId: number;
  onBack: () => void;
  onExport?: () => void;
}

type SubTab = "overview" | "scores" | "question-analysis" | "class-compare" | "overall" | "ai";
type ViewMode = "combined" | "per-subject";

/** 班级下拉的「全年级」哨兵值（v2 Select 不接受空字符串 value） */
const ALL_CLASSES = "__all__";

const VIEW_MODES: ReadonlyArray<SegmentedItem<ViewMode>> = [
  { value: "combined", label: "总分 + 每科" },
  { value: "per-subject", label: "逐科" },
];

type BandSet = {
  difficulty: import("../../../../shared/stats").ThresholdBand[];
  discrimination: import("../../../../shared/stats").ThresholdBand[];
};

export function ExamGroupDetailPage({ groupId, onBack, onExport }: Props) {
  const { user } = useAuth();
  const isTeacher = user?.role_name === "teacher" || user?.role_name === "管理员" || user?.role_name === "admin";
  const bands = useBands();
  const [subTab, setSubTab] = useState<SubTab>("overview");
  const [viewMode, setViewMode] = useState<ViewMode>("combined");
  const [subjectFilter, setSubjectFilter] = useState("");
  const [overview, setOverview] = useState<GroupOverview | null>(null);
  const [metrics, setMetrics] = useState<GroupMetrics | null>(null);
  const [rankings, setRankings] = useState<GroupRankingResponse | null>(null);
  const [questionAnalysis, setQuestionAnalysis] = useState<GroupQuestionAnalysisResponse | null>(null);
  const [classComparison, setClassComparison] = useState<GroupClassComparisonResponse | null>(null);
  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [classId, setClassId] = useState("");
  const [fullOnly, setFullOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [drill, setDrill] = useState<{ examId: number; questionNumber: string; maxScore: number } | null>(null);

  useEffect(() => {
    fetchJson<ClassOption[]>("/api/classes").then(setClasses).catch(() => setClasses([]));
  }, []);

  // ESC to go back
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onBack(); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onBack]);

  useEffect(() => {
    loadOverview();
    loadMetrics();
    loadRankings();
  }, [groupId, fullOnly, classId]);

  useEffect(() => {
    if (subTab === "question-analysis" && !questionAnalysis) loadQuestionAnalysis();
    if (subTab === "class-compare" && !classComparison) loadClassComparison();
  }, [subTab]);

  async function loadOverview() {
    setLoading(true);
    try {
      const data = await fetchJson<GroupOverview>(`/api/exam-groups/${groupId}/overview`);
      setOverview(data);
    } catch { setOverview(null); }
    finally { setLoading(false); }
  }
  async function loadMetrics() {
    try { setMetrics(await fetchJson<GroupMetrics>(`/api/exam-groups/${groupId}/metrics`)); }
    catch { setMetrics(null); }
  }
  async function loadRankings() {
    try {
      const params = new URLSearchParams();
      if (classId) params.set("classId", classId);
      if (fullOnly) params.set("fullOnly", "1");
      const data = await fetchJson<GroupRankingResponse>(`/api/exam-groups/${groupId}/rankings?${params.toString()}`);
      setRankings(data);
    } catch { setRankings(null); }
  }
  async function loadQuestionAnalysis() {
    try { setQuestionAnalysis(await fetchJson<GroupQuestionAnalysisResponse>(`/api/exam-groups/${groupId}/question-analysis`)); }
    catch { setQuestionAnalysis(null); }
  }
  async function loadClassComparison() {
    try { setClassComparison(await fetchJson<GroupClassComparisonResponse>(`/api/exam-groups/${groupId}/class-comparison`)); }
    catch { setClassComparison(null); }
  }

  const subjectList = useMemo(() => (overview?.subjects ?? []).map((s) => s.subject), [overview]);
  const metricsByExam = useMemo(
    () => new Map((metrics?.subjects ?? []).map((s) => [s.examId, s])),
    [metrics]
  );
  const activeSubject = subjectFilter || subjectList[0] || "";

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
        <Spinner />
        正在加载大考数据...
      </div>
    );
  }
  if (!overview) {
    return (
      <ErrorState
        title="大考数据加载失败"
        description="请检查网络或稍后重试。"
        onRetry={() => { loadOverview(); loadMetrics(); loadRankings(); }}
        className="m-6"
      />
    );
  }

  const tabs: Array<{ key: SubTab; label: string; icon: typeof FileText }> = [
    { key: "overview", label: "概览", icon: FileText },
    { key: "scores", label: "成绩", icon: BarChart3 },
    { key: "question-analysis", label: "题目分析", icon: BarChart3 },
    { key: "class-compare", label: "班级对比", icon: BarChart3 },
    { key: "overall", label: "总体分析", icon: Activity },
    { key: "ai", label: "AI分析", icon: ClipboardList },
  ];
  const showViewToggle = subTab === "scores" || subTab === "question-analysis" || subTab === "class-compare";

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <header className="flex shrink-0 items-center gap-3 border-b border-border-subtle px-5 py-3.5">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onBack}
          aria-label="返回"
        >
          <ArrowLeft />
        </Button>
        <div className="flex-1">
          <h2 className="text-base font-semibold">{overview.groupName}</h2>
          <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">
            {overview.subjects.length} 科 · {overview.totalParticipants} 人参加 · {overview.fullParticipants} 人全科
          </div>
        </div>
        {isTeacher && onExport && (
          <Button variant="primary" size="sm" icon={<Download />} onClick={onExport}>
            导出大考
          </Button>
        )}
      </header>

      <Tabs
        value={subTab}
        onValueChange={(v) => setSubTab(v as SubTab)}
        className="flex min-h-0 flex-1 flex-col"
      >
        {/* Tabs */}
        <div className="flex shrink-0 items-center gap-3 overflow-x-auto border-b border-border-subtle px-5">
          <TabsList className="flex-1 border-b-0">
            {tabs.map(({ key, label, icon: Icon }) => (
              <TabsTrigger key={key} value={key}>
                <Icon aria-hidden />
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        {/* View-mode toggle (成绩/题目分析/班级对比 共用) */}
        {showViewToggle && (
          <div className="flex shrink-0 flex-wrap items-center gap-2 px-5 pt-2.5">
            <Layers className="size-3.5 text-muted-foreground" aria-hidden />
            <span className="text-xs text-muted-foreground">显示</span>
            <SegmentedControl
              value={viewMode}
              onValueChange={setViewMode}
              items={VIEW_MODES}
              size="sm"
              aria-label="显示模式"
            />
            {viewMode === "per-subject" && subjectList.length > 0 && (
              <Select value={activeSubject} onValueChange={setSubjectFilter}>
                <SelectTrigger className="h-control-sm w-32 text-sm" aria-label="选择科目">
                  <SelectValue placeholder="选择科目" />
                </SelectTrigger>
                <SelectContent>
                  {subjectList.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
          </div>
        )}

        {/* Content */}
        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
          <TabsContent value="overview">
            <OverviewTab overview={overview} metricsByExam={metricsByExam} overallMetrics={metrics} bands={bands ?? undefined} />
          </TabsContent>
          <TabsContent value="scores">
            <ScoresTab rankings={rankings} classes={classes} classId={classId} setClassId={setClassId}
              fullOnly={fullOnly} setFullOnly={setFullOnly}
              viewMode={viewMode} subjectFilter={activeSubject} />
          </TabsContent>
          <TabsContent value="question-analysis">
            <GroupQuestionAnalysisTab qa={questionAnalysis} bands={bands ?? undefined} viewMode={viewMode}
              subjectFilter={activeSubject} onDrill={(examId, qn, ms) => setDrill({ examId, questionNumber: qn, maxScore: ms })} />
          </TabsContent>
          <TabsContent value="class-compare">
            <GroupClassCompareTab cc={classComparison} viewMode={viewMode} subjectFilter={activeSubject} />
          </TabsContent>
          <TabsContent value="overall">
            <AnalysisOverall kind="group" groupId={groupId} bands={bands ?? undefined} />
          </TabsContent>
          <TabsContent value="ai">
            <AnalysisAiPanel groupId={groupId} />
          </TabsContent>
        </div>
      </Tabs>

      {drill && (
        <QuestionStudentScoresModal
          examId={drill.examId}
          questionNumber={drill.questionNumber}
          questionMaxScore={drill.maxScore}
          onClose={() => setDrill(null)}
        />
      )}
    </div>
  );
}

// ── Overview Tab ──

function OverviewTab({
  overview, metricsByExam, overallMetrics, bands
}: {
  overview: GroupOverview;
  metricsByExam: Map<number, GroupSubjectSummary & { difficulty?: number; discrimination?: number }>;
  overallMetrics: GroupMetrics | null;
  bands?: BandSet;
}) {
  return (
    <div>
      {/* 整体难度/区分度 */}
      {overallMetrics && (
        <StatCardRow className="mb-5">
          <StatCard
            label="整体难度系数 P"
            value={overallMetrics.difficulty.toFixed(3)}
            hint={<DifficultyBadge value={overallMetrics.difficulty} bands={bands?.difficulty} />}
          />
          <StatCard
            label="整体区分度 D"
            value={overallMetrics.discrimination.toFixed(3)}
            hint={<DiscriminationBadge value={overallMetrics.discrimination} bands={bands?.discrimination} />}
          />
          <StatCard label="大考总分满分" value={overallMetrics.totalFullScore} />
          <StatCard label="大考总均分" value={overallMetrics.totalAvg} />
        </StatCardRow>
      )}

      <div className="mb-5 grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
        {overview.subjects.map((sub) => (
          <Panel key={sub.examId} className="p-3.5">
            <div className="mb-2 text-sm font-semibold">{sub.subject}</div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
              <span className="text-muted-foreground">人数</span>
              <span className="text-right font-medium tabular-nums">{sub.gradedCount}</span>
              <span className="text-muted-foreground">满分</span>
              <span className="text-right font-medium tabular-nums">{sub.fullScore}</span>
              <span className="text-muted-foreground">均分</span>
              <span className="text-right font-semibold text-primary tabular-nums">{sub.avgScore}</span>
              <span className="text-muted-foreground">最高</span>
              <span className="text-right font-medium tabular-nums">{sub.maxScore}</span>
              <span className="text-muted-foreground">最低</span>
              <span className="text-right font-medium tabular-nums">{sub.minScore}</span>
              <span className="text-muted-foreground">标准差</span>
              <span className="text-right font-medium tabular-nums">{sub.stdDev}</span>
              <span className="text-muted-foreground">及格率</span>
              <span className="text-right font-medium tabular-nums">{sub.passRate}%</span>
              <span className="text-muted-foreground">优秀率</span>
              <span className="text-right font-medium tabular-nums">{sub.excellentRate}%</span>
              <span className="text-muted-foreground">难度 P</span>
              <span className="text-right font-medium">
                {metricsByExam.get(sub.examId)?.difficulty != null
                  ? <DifficultyBadge value={metricsByExam.get(sub.examId)!.difficulty!} bands={bands?.difficulty} />
                  : "—"}
              </span>
              <span className="text-muted-foreground">区分度 D</span>
              <span className="text-right font-medium">
                {metricsByExam.get(sub.examId)?.discrimination != null
                  ? <DiscriminationBadge value={metricsByExam.get(sub.examId)!.discrimination!} bands={bands?.discrimination} />
                  : "—"}
              </span>
            </div>
            {sub.hasAssignedScore && (
              <Badge tone="warning" className="mt-2 self-start">含赋分</Badge>
            )}
          </Panel>
        ))}
      </div>

      {/* Summary table */}
      <Panel className="overflow-hidden">
        <div className="border-b border-border-subtle px-3.5 py-2.5 text-sm font-semibold">
          各科参数总览
        </div>
        <TableWrap className="rounded-none border-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>科目</TableHead>
                <TableHead numeric>人数</TableHead>
                <TableHead numeric>满分</TableHead>
                <TableHead numeric>均分</TableHead>
                <TableHead numeric>最高</TableHead>
                <TableHead numeric>最低</TableHead>
                <TableHead numeric>标准差</TableHead>
                <TableHead numeric>及格率</TableHead>
                <TableHead numeric>优秀率</TableHead>
                <TableHead numeric>难度 P</TableHead>
                <TableHead numeric>区分度 D</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {overview.subjects.map((sub) => {
                const m = metricsByExam.get(sub.examId);
                return (
                  <TableRow key={sub.examId}>
                    <TableCell>
                      <strong>{sub.subject}</strong>
                      {sub.hasAssignedScore && (
                        <span className="ml-1.5 text-[10px] text-warning-foreground">赋分</span>
                      )}
                    </TableCell>
                    <TableCell numeric>{sub.gradedCount}</TableCell>
                    <TableCell numeric>{sub.fullScore}</TableCell>
                    <TableCell numeric className="font-semibold text-primary">{sub.avgScore}</TableCell>
                    <TableCell numeric>{sub.maxScore}</TableCell>
                    <TableCell numeric>{sub.minScore}</TableCell>
                    <TableCell numeric>{sub.stdDev}</TableCell>
                    <TableCell numeric>{sub.passRate}%</TableCell>
                    <TableCell numeric>{sub.excellentRate}%</TableCell>
                    <TableCell numeric>{m?.difficulty != null ? <DifficultyBadge value={m.difficulty} bands={bands?.difficulty} /> : "—"}</TableCell>
                    <TableCell numeric>{m?.discrimination != null ? <DiscriminationBadge value={m.discrimination} bands={bands?.discrimination} /> : "—"}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableWrap>
      </Panel>
    </div>
  );
}

// ── Scores Tab ──

function ScoresTab({
  rankings, classes, classId, setClassId, fullOnly, setFullOnly, viewMode, subjectFilter
}: {
  rankings: GroupRankingResponse | null;
  classes: ClassOption[]; classId: string; setClassId: (v: string) => void;
  fullOnly: boolean; setFullOnly: (v: boolean) => void;
  viewMode: ViewMode; subjectFilter: string;
}) {
  if (!rankings || rankings.rows.length === 0) {
    return (
      <EmptyState
        icon={<FileText />}
        title="暂无成绩数据"
        description="该大考尚未录入或同步任何成绩。"
      />
    );
  }

  const cols = viewMode === "per-subject" && subjectFilter
    ? rankings.displayColumns.filter((c) => c === subjectFilter)
    : rankings.displayColumns;

  return (
    <div>
      {/* Controls */}
      <div className="mb-3.5 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground">班级</span>
          <Select
            value={classId || ALL_CLASSES}
            onValueChange={(v) => setClassId(v === ALL_CLASSES ? "" : v)}
          >
            <SelectTrigger className="h-control-sm w-32 text-sm" aria-label="班级筛选">
              <SelectValue placeholder="全年级" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_CLASSES}>全年级</SelectItem>
              {classes.map((c) => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <label className="flex cursor-pointer items-center gap-1.5 text-xs">
          <Checkbox checked={fullOnly} onCheckedChange={(v) => setFullOnly(v === true)} />
          仅全科参加
        </label>
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          共 {rankings.totalStudents} 人
        </span>
      </div>

      {/* Table */}
      <TableWrap>
        <Table className="whitespace-nowrap">
          <TableHeader>
            <TableRow>
              <TableHead>年排</TableHead>
              <TableHead>班排</TableHead>
              <TableHead>班级</TableHead>
              <TableHead>姓名</TableHead>
              <TableHead numeric className="bg-accent">总分</TableHead>
              {cols.map((col) => (
                <FragmentCols
                  key={col}
                  raw={<TableHead numeric>{col}原始</TableHead>}
                  gradeRank={<TableHead numeric className="text-[10px]">{col}年排</TableHead>}
                  classRank={<TableHead numeric className="text-[10px]">{col}班排</TableHead>}
                />
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rankings.rows.map((row) => (
              <TableRow key={row.studentId}>
                <TableCell numeric>{row.totalGradeRank}</TableCell>
                <TableCell numeric>{row.totalClassRank}</TableCell>
                <TableCell>{row.className}</TableCell>
                <TableCell className="font-medium">{row.studentName}</TableCell>
                <TableCell numeric className="bg-accent font-semibold text-primary">
                  {row.totalRawScore}
                </TableCell>
                {cols.map((col) => {
                  const sub = row.subjects.find((s) => s.subject === col);
                  if (!sub) {
                    return (
                      <FragmentCols
                        key={col}
                        raw={<TableCell numeric className="text-muted-foreground">—</TableCell>}
                        gradeRank={<TableCell numeric className="text-muted-foreground">—</TableCell>}
                        classRank={<TableCell numeric className="text-muted-foreground">—</TableCell>}
                      />
                    );
                  }
                  return (
                    <FragmentCols
                      key={col}
                      raw={
                        <TableCell numeric>
                          {sub.totalScore}
                          {sub.assignedScore != null && sub.assignedScore !== sub.totalScore && (
                            <span className="ml-1 text-[10px] text-warning-foreground">
                              →{sub.assignedScore}
                            </span>
                          )}
                        </TableCell>
                      }
                      gradeRank={<TableCell numeric>{sub.gradeRank || "—"}</TableCell>}
                      classRank={<TableCell numeric>{sub.classRank || "—"}</TableCell>}
                    />
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableWrap>
    </div>
  );
}

/**
 * 每个科目在表格里固定展开为「原始 / 年排 / 班排」三列。
 * 用一个显式片段组件承载，避免在 JSX 里直接返回数组导致 key 语义模糊。
 */
function FragmentCols({
  raw, gradeRank, classRank
}: {
  raw: React.ReactNode; gradeRank: React.ReactNode; classRank: React.ReactNode;
}) {
  return <>{raw}{gradeRank}{classRank}</>;
}

// ── 大考题目分析 Tab ──

function GroupQuestionAnalysisTab({
  qa, bands, viewMode, subjectFilter, onDrill
}: {
  qa: GroupQuestionAnalysisResponse | null;
  bands?: BandSet;
  viewMode: ViewMode; subjectFilter: string;
  onDrill: (examId: number, questionNumber: string, maxScore: number) => void;
}) {
  if (!qa) {
    return <EmptyState title="加载中或暂无数据" description="题目分析数据尚未就绪。" size="sm" />;
  }
  const subjects = viewMode === "per-subject" && subjectFilter
    ? qa.subjects.filter((s) => s.subject === subjectFilter)
    : qa.subjects;

  return (
    <div className="flex flex-col gap-5">
      <Panel className="p-4">
        <div className="mb-2 text-sm font-semibold">大考整体难度 / 区分度</div>
        <div className="flex flex-wrap items-center gap-3">
          <MetricLine label="难度系数 P" value={qa.overall.difficulty.toFixed(3)} />
          <DifficultyBadge value={qa.overall.difficulty} bands={bands?.difficulty} />
          <MetricLine label="区分度 D" value={qa.overall.discrimination.toFixed(3)} />
          <DiscriminationBadge value={qa.overall.discrimination} bands={bands?.discrimination} />
        </div>
      </Panel>

      {subjects.map((s) => (
        <Panel key={s.examId} className="p-4">
          <div className="flex flex-wrap items-center gap-2.5">
            <div className="text-sm font-semibold">{s.subject}（{s.examName}）</div>
            <span className="text-xs text-muted-foreground tabular-nums">满分 {s.fullScore} · 均分 {s.avgScore}</span>
            <DifficultyBadge value={s.difficulty} bands={bands?.difficulty} />
            <DiscriminationBadge value={s.discrimination} bands={bands?.discrimination} />
          </div>
          <div className="mt-3">
            <AnalysisQuestions
              questions={s.questions}
              bands={bands}
              onRowClick={(qn) => onDrill(s.examId, qn, s.fullScore)}
            />
          </div>
        </Panel>
      ))}
      {subjects.length === 0 && (
        <EmptyState title="该科目暂无题目数据" size="sm" />
      )}
    </div>
  );
}

function MetricLine({ label, value }: { label: string; value: string }) {
  return (
    <span className="text-sm text-muted-foreground">
      {label}：<strong className="text-foreground tabular-nums">{value}</strong>
    </span>
  );
}

// ── 大考班级对比 Tab ──

function GroupClassCompareTab({
  cc, viewMode, subjectFilter
}: {
  cc: GroupClassComparisonResponse | null;
  viewMode: ViewMode; subjectFilter: string;
}) {
  if (!cc) {
    return <EmptyState title="加载中或暂无数据" description="班级对比数据尚未就绪。" size="sm" />;
  }
  const subjects = viewMode === "per-subject" && subjectFilter
    ? cc.subjectClassSummaries.filter((x) => x.subject === subjectFilter)
    : cc.subjectClassSummaries;

  return (
    <div className="flex flex-col gap-4">
      {/* 班级统计总表 */}
      <Panel className="overflow-hidden">
        <div className="border-b border-border-subtle px-3.5 py-2.5 text-sm font-semibold">班级统计</div>
        <TableWrap className="rounded-none border-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>班级</TableHead>
                <TableHead numeric>人数</TableHead>
                <TableHead numeric>均分</TableHead>
                <TableHead numeric>中位</TableHead>
                <TableHead numeric>最高</TableHead>
                <TableHead numeric>最低</TableHead>
                <TableHead numeric>标准差</TableHead>
                <TableHead numeric>及格率</TableHead>
                <TableHead numeric>优秀率</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {cc.classes.map((c) => (
                <TableRow key={c.classId}>
                  <TableCell>{c.className}</TableCell>
                  <TableCell numeric>{c.count}</TableCell>
                  <TableCell numeric className="font-semibold">{c.avgScore}</TableCell>
                  <TableCell numeric>{c.median}</TableCell>
                  <TableCell numeric>{c.maxScore}</TableCell>
                  <TableCell numeric>{c.minScore}</TableCell>
                  <TableCell numeric>{c.stdDev}</TableCell>
                  <TableCell numeric>{c.passRate}%</TableCell>
                  <TableCell numeric>{c.excellentRate}%</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableWrap>
      </Panel>

      {/* 逐科 × 班级 对比 */}
      {subjects.map((x) => (
        <Panel key={x.examId} className="overflow-hidden">
          <div className="border-b border-border-subtle px-3.5 py-2.5 text-sm font-semibold">
            {x.subject} · 各班均分 / 得分率
          </div>
          <TableWrap className="rounded-none border-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>班级</TableHead>
                  <TableHead numeric>均分</TableHead>
                  <TableHead numeric>得分率</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {cc.classes.map((c) => {
                  const bc = x.byClass.find((b) => b.classId === c.classId);
                  return (
                    <TableRow key={c.classId}>
                      <TableCell>{c.className}</TableCell>
                      <TableCell numeric>{bc ? bc.avgScore : "—"}</TableCell>
                      <TableCell numeric>{bc ? `${bc.scoreRate}%` : "—"}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableWrap>
        </Panel>
      ))}
      {subjects.length === 0 && (
        <EmptyState title="该科目暂无对比数据" size="sm" />
      )}
    </div>
  );
}
