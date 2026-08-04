import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity, AlertTriangle, ArrowLeft, BarChart3, CheckCircle2, ClipboardList,
  Download, FileText, Settings, Star, TrendingDown, TrendingUp, Users, Wrench,
} from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { fetchJson } from "../auth/api";
import { cn } from "../lib/utils";
import { formatScore, formatPercent, formatChange } from "../util/format";
import type {
  ExamOverview, ExamMetrics, PreviousExamComparison, QuestionAnalysisItem,
  StudentRankingItem, ScoreDisplayMode, ScoreTableRow, AnalysisThresholds, KnowledgeWeaknessItem,
} from "../../../../shared/types";
import { AnalysisDistribution } from "./AnalysisDistribution";
import { AnalysisAiPanel } from "./AnalysisAiPanel";
import { AnalysisQuestions } from "./AnalysisQuestions";
import { AnalysisOverall } from "./AnalysisOverall";
import { QuestionStudentScoresModal } from "./QuestionStudentScoresModal";
import { ScoreTable } from "./ScoreTable";
import { ExportModal } from "./ExportModal";
import { ScoreFixPage } from "./ScoreFixPage";
import { StudentScoreDetail } from "./StudentScoreDetail";
import { AnalysisTrend } from "./AnalysisTrend";
import { DistributionBar, ClassDistributionBar } from "./AnalysisCharts";
import { useBands, DifficultyBadge, DiscriminationBadge } from "./MetricBadge";
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  Input,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
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
} from "./ui/v2";

/**
 * ScoreDetailPage —— T2 迁移（T03 主分析页 + 图表子树）
 *
 * 换肤范围（功能守恒：API 端点 / 路由参数 / 权限判定逐行保留）：
 *  · 内联 `StatCard`（.analysis-card + 6 段行内 style）→ v2 `StatCard` / `StatCardRow`
 *  · `ThresholdSettingsModal` 的旧遮罩／卡片／按钮工具类
 *    → v2 `Dialog`（Radix 接管 ESC / 遮罩点击 / 焦点陷阱 / z 层级）
 *  · 6 个子 Tab 的手写下划线按钮 → v2 `Tabs`（下划线式唯一形态）
 *  · 两处原生 `<select>`（含 optgroup）→ v2 `Select` + `SelectGroup`，空值走 `ALL_CLASSES` 哨兵
 *  · 班级对比 chips → v2 `Button` 语义变体；两张手写 `<table>` → v2 `Table` 原语
 *  · 逐题热力格的硬编码 rgba → `color-mix(... var(--color-chart-1) ...)` 数据驱动透明度
 *  · 知识点严重度的硬编码红／橙 → destructive / warning / success 语义 class
 *  · 「分数有问题？」按钮的硬编码橙色描边 → v2 `Button variant="outline"` + Wrench 图标
 */

interface ClassOption { id: number; name: string; grade_name?: string; }

interface Props { examId: number; examName: string; subject: string | null; onBack: () => void; }

type SubTab = "overview" | "scores" | "question-analysis" | "class-compare" | "overall" | "ai";

/** Radix Select 不接受空字符串值，用哨兵表示「全部班级」 */
const ALL_CLASSES = "__all__";

/** 环比方向：把 number|null 归一成 v2 StatCard 的 delta 契约 */
function toDelta(v: number | null | undefined): number | undefined {
  return typeof v === "number" ? v : undefined;
}

// ── Threshold settings dialog (admin only) ──────────────
interface ThresholdField {
  key: "passRate" | "excellentRate" | "segmentSize" | "errorTiers";
  label: string;
  hint: string;
}

const THRESHOLD_FIELDS: readonly ThresholdField[] = [
  { key: "passRate", label: "及格线比例", hint: "0-1" },
  { key: "excellentRate", label: "优秀线比例", hint: "0-1" },
  { key: "segmentSize", label: "分数段粒度", hint: "1-100 分" },
  { key: "errorTiers", label: "错误率档位", hint: "高,中,低 %" },
];

function ThresholdSettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [t, setT] = useState<AnalysisThresholds | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    if (!open) return;
    setMsg("");
    fetchJson<AnalysisThresholds>("/api/analysis/config/thresholds")
      .then(setT)
      .catch(() => setMsg("加载失败"));
  }, [open]);

  async function save() {
    if (!t) return;
    setSaving(true);
    try {
      const res = await fetchJson<{ ok?: boolean; data?: AnalysisThresholds; message?: string }>(
        "/api/analysis/config/thresholds",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            passRate: t.passRate,
            excellentRate: t.excellentRate,
            segmentSize: t.segmentSize,
            errorTiers: t.errorTiers.join(","),
          }),
        },
      );
      if (res.ok || res.data) {
        setMsg("已保存，刷新页面后生效");
        setTimeout(onClose, 1500);
      } else {
        setMsg(res.message ?? "保存失败");
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  function fieldValue(field: ThresholdField): string {
    if (!t) return "";
    return field.key === "errorTiers" ? t.errorTiers.join(",") : String(t[field.key]);
  }

  function updateField(field: ThresholdField, raw: string) {
    setT((prev) => {
      if (!prev) return prev;
      if (field.key === "errorTiers") {
        return { ...prev, errorTiers: raw.split(",").map(Number) as [number, number, number] };
      }
      return { ...prev, [field.key]: Number(raw) };
    });
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>成绩分析阈值设置</DialogTitle>
        </DialogHeader>
        <DialogBody>
          {!t ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{msg || "加载中..."}</p>
          ) : (
            <div className="flex flex-col gap-4">
              {THRESHOLD_FIELDS.map((field) => (
                <Field
                  key={field.key}
                  label={field.label}
                  hint={`范围：${field.hint}`}
                  htmlFor={`threshold-${field.key}`}
                >
                  <Input
                    id={`threshold-${field.key}`}
                    className="tabular-nums"
                    value={fieldValue(field)}
                    onChange={(e) => updateField(field, e.target.value)}
                  />
                </Field>
              ))}
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          {msg && t && <span className="mr-auto text-xs text-muted-foreground">{msg}</span>}
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={save} loading={saving} disabled={!t}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── 主组件 ──────────────────────────────────────────
export function ScoreDetailPage({ examId, examName, subject, onBack }: Props) {
  const { user, isAdmin } = useAuth();
  const isTeacher = user?.role_name === "teacher" || isAdmin;
  const bands = useBands();
  const [subTab, setSubTab] = useState<SubTab>("overview");
  const [showFixPage, setShowFixPage] = useState(false);
  const [selectedStudent, setSelectedStudent] = useState<{ id: number; name: string; number: string } | null>(null);
  const [classId, setClassId] = useState("");
  const [showExport, setShowExport] = useState(false);
  const [showThresholdSettings, setShowThresholdSettings] = useState(false);
  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [overview, setOverview] = useState<ExamOverview | null>(null);
  const [metrics, setMetrics] = useState<ExamMetrics | null>(null);
  const [ranking, setRanking] = useState<StudentRankingItem[]>([]);
  const [questions, setQuestions] = useState<QuestionAnalysisItem[]>([]);
  const [displayMode, setDisplayMode] = useState<ScoreDisplayMode>("zscore");
  const [scoreTableKey, setScoreTableKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [progressTop5, setProgressTop5] = useState<Array<{ studentName: string; studentNumber?: string; rankChange: number }>>([]);
  const [declineTop5, setDeclineTop5] = useState<Array<{ studentName: string; studentNumber?: string; rankChange: number }>>([]);
  const [previousComparison, setPreviousComparison] = useState<PreviousExamComparison | null>(null);
  const [drillQuestion, setDrillQuestion] = useState<string | null>(null);

  useEffect(() => {
    fetchJson<ClassOption[]>("/api/classes")
      .then((data) => setClasses(Array.isArray(data) ? data : []))
      .catch(() => setClasses([]));
    fetchJson<{ scoreDisplayMode: ScoreDisplayMode }>("/api/users/me/settings")
      .then((s) => { if (s) setDisplayMode(s.scoreDisplayMode || "zscore"); })
      .catch(() => {});
  }, []);

  useEffect(() => { loadOverview(); loadQuestions(); loadRanking(); loadProgressRankings(); loadPreviousComparison(); loadMetrics(); }, [examId, classId]);
  useEffect(() => { setScoreTableKey((k) => k + 1); }, [displayMode]);

  async function loadOverview() {
    try {
      const params = new URLSearchParams(); if (classId) params.set("classId", classId);
      const d = await fetchJson<ExamOverview>(`/api/analysis/exams/${examId}/overview?${params.toString()}`);
      setOverview(d);
    } catch { setOverview(null); } finally { setLoading(false); }
  }
  async function loadRanking() {
    try {
      const params = new URLSearchParams(); if (classId) params.set("classId", classId);
      setRanking(await fetchJson<StudentRankingItem[]>(`/api/analysis/exams/${examId}/students?${params.toString()}`));
    } catch { setRanking([]); }
  }
  async function loadProgressRankings() {
    try {
      const d = await fetchJson<{ rows: ScoreTableRow[] }>(`/api/analysis/exams/${examId}/score-table?displayMode=gradeRank`);
      const wc = d.rows.filter((r) => r.rankChange != null).sort((a, b) => (b.rankChange ?? 0) - (a.rankChange ?? 0));
      setProgressTop5(wc.slice(0, 5).map((r) => ({ studentName: r.studentName, studentNumber: r.studentNumber, rankChange: r.rankChange! })));
      setDeclineTop5(wc.slice(-5).reverse().map((r) => ({ studentName: r.studentName, studentNumber: r.studentNumber, rankChange: r.rankChange! })));
    } catch { setProgressTop5([]); setDeclineTop5([]); }
  }
  async function loadPreviousComparison() {
    try {
      const params = new URLSearchParams(); if (classId) params.set("classId", classId);
      setPreviousComparison(await fetchJson<PreviousExamComparison>(`/api/analysis/exams/${examId}/previous?${params.toString()}`));
    } catch { setPreviousComparison(null); }
  }
  async function loadQuestions() {
    try {
      const params = new URLSearchParams(); if (classId) params.set("classId", classId);
      setQuestions(await fetchJson<QuestionAnalysisItem[]>(`/api/analysis/exams/${examId}/questions?${params.toString()}`));
    } catch { setQuestions([]); }
  }
  async function loadMetrics() {
    try {
      const params = new URLSearchParams(); if (classId) params.set("classId", classId);
      setMetrics(await fetchJson<ExamMetrics>(`/api/analysis/exams/${examId}/metrics?${params.toString()}`));
    } catch { setMetrics(null); }
  }

  const subTabConfigs = useMemo(() => [
    { key: "overview" as SubTab, label: "概况", icon: FileText },
    { key: "scores" as SubTab, label: "成绩", icon: Users },
    { key: "question-analysis" as SubTab, label: "题目分析", icon: BarChart3 },
    { key: "class-compare" as SubTab, label: "班级对比", icon: BarChart3 },
    { key: "overall" as SubTab, label: "总体分析", icon: Activity },
    { key: "ai" as SubTab, label: "AI分析", icon: ClipboardList },
  ], []);

  /** 班级按年级分组（下拉与对比面板共用） */
  const classGroups = useMemo(() => {
    const m = new Map<string, ClassOption[]>();
    for (const c of classes) {
      const g = c.grade_name || "无年级";
      if (!m.has(g)) m.set(g, []);
      m.get(g)!.push(c);
    }
    return Array.from(m.entries());
  }, [classes]);

  const top5 = useMemo(() => ranking.slice(0, 5), [ranking]);
  const bottom5 = useMemo(() => ranking.slice(-5).reverse(), [ranking]);

  // ── 临界生数据 ──
  const criticalList = useMemo(() => {
    if (!overview || !overview.passScore || !overview.excellentScore || ranking.length === 0) return [];
    const passLine = overview.passScore, excLine = overview.excellentScore;
    const m = Math.max(1, Math.round(passLine * 0.05));
    return ranking
      .filter((r) => (Math.abs(r.totalScore - passLine) <= m || Math.abs(r.totalScore - excLine) <= m))
      .sort((a, b) => a.totalScore - b.totalScore);
  }, [overview, ranking]);

  // Overlay: fix page
  if (showFixPage) return <ScoreFixPage examId={examId} examName={examName} subject={subject} onBack={() => setShowFixPage(false)} />;

  // Overlay: student detail
  if (selectedStudent) return (
    <StudentScoreDetail examId={examId} studentId={selectedStudent.id} studentName={selectedStudent.name}
      studentNumber={selectedStudent.number} examName={examName} onBack={() => setSelectedStudent(null)} />
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* ── Header bar ── */}
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border-subtle bg-card px-6 py-3">
        <Button variant="ghost" size="sm" icon={<ArrowLeft />} onClick={onBack}>返回</Button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold text-foreground">{examName}</h2>
          {subject && <span className="text-xs text-muted-foreground">{subject}</span>}
        </div>

        <Select
          value={displayMode}
          onValueChange={(v) => {
            const m = v as ScoreDisplayMode;
            setDisplayMode(m);
            fetchJson("/api/users/me/settings", {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ scoreDisplayMode: m }),
            }).catch(() => {});
          }}
        >
          <SelectTrigger className="h-control-sm w-32 text-sm" aria-label="成绩指标显示">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="deviation">偏差值</SelectItem>
            <SelectItem value="zscore">Z值</SelectItem>
            <SelectItem value="percentile">百分位</SelectItem>
          </SelectContent>
        </Select>

        <label className="text-sm whitespace-nowrap text-muted-foreground" htmlFor="analysis-class-filter">班级</label>
        <Select
          value={classId === "" ? ALL_CLASSES : classId}
          onValueChange={(v) => setClassId(v === ALL_CLASSES ? "" : v)}
        >
          <SelectTrigger id="analysis-class-filter" className="h-control-sm w-36 text-sm">
            <SelectValue placeholder="全部班级" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_CLASSES}>全部班级</SelectItem>
            {classGroups.map(([grade, list]) => (
              <SelectGroup key={grade}>
                <SelectLabel>{grade}</SelectLabel>
                {list.map((c) => (
                  <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>

        <Button variant="primary" size="sm" icon={<Download />} onClick={() => setShowExport(true)}>导出</Button>
        {isAdmin && (
          <Button
            variant="ghost"
            size="icon-sm"
            title="分析阈值设置"
            aria-label="分析阈值设置"
            onClick={() => setShowThresholdSettings(true)}
          >
            <Settings />
          </Button>
        )}
      </header>

      <Tabs
        value={subTab}
        onValueChange={(v) => setSubTab(v as SubTab)}
        className="flex min-h-0 flex-1 flex-col"
      >
        {/* ── Sub-tab bar ── */}
        <div className="flex shrink-0 items-center gap-3 border-b border-border-subtle bg-card px-6">
          <TabsList className="flex-1 border-b-0">
            {subTabConfigs.map(({ key, label, icon: Icon }) => (
              <TabsTrigger key={key} value={key}>
                <Icon aria-hidden />
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
          {isTeacher && (
            <Button variant="outline" size="sm" icon={<Wrench />} onClick={() => setShowFixPage(true)}>
              分数有问题？
            </Button>
          )}
        </div>

        {/* ── Content area ── */}
        <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
          {/* ====== 概况 Tab ====== */}
          <TabsContent value="overview">
            {overview ? (
              <div className="flex flex-col gap-5 p-6">
                {/* KPI 指标卡 */}
                <StatCardRow>
                  <StatCard
                    label="均分"
                    value={formatScore(overview.avgScore)}
                    suffix="分"
                    hint={`满分：${overview.overallScoreSummary?.max ?? "—"} 分`}
                    delta={toDelta(previousComparison?.avgScoreChange)}
                    deltaLabel="较上届"
                  />
                  <StatCard
                    label="及格率"
                    value={formatPercent(overview.passRate)}
                    hint={`及格线 ${formatScore(overview.passScore)} 分`}
                    delta={toDelta(previousComparison?.passRateChange)}
                    deltaLabel="较上届"
                  />
                  <StatCard
                    label="优秀率"
                    value={formatPercent(overview.excellentRate)}
                    hint={`优秀线 ${formatScore(overview.excellentScore)} 分`}
                  />
                  <StatCard label="标准差" value={formatScore(overview.stdDev)} suffix="分" hint="越大越分散" />
                  <StatCard label="参考人数" value={String(overview.gradedCount)} />
                  {previousComparison?.prevExamName && (
                    <StatCard
                      label="较上届均分变化"
                      value={formatChange(previousComparison.avgScoreChange, " 分")}
                      hint={`上届：${previousComparison.prevExamName}`}
                    />
                  )}
                  {previousComparison?.prevExamName && (
                    <StatCard
                      label="较上届及格率变化"
                      value={formatChange(previousComparison.passRateChange, "%")}
                      hint={`上届：${previousComparison.prevExamName}`}
                    />
                  )}
                  <StatCard label="最高分" value={formatScore(overview.maxScore)} />
                  <StatCard label="最低分" value={formatScore(overview.minScore)} />
                </StatCardRow>

                {/* 难度系数 / 区分度 卡 */}
                {metrics && (
                  <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                    <div className="flex flex-col gap-1 rounded-lg border border-border-subtle bg-card px-5 py-4">
                      <span className="text-xs text-muted-foreground">难度系数 P（平均得分 / 满分）</span>
                      <div className="flex items-center gap-2">
                        <span className="text-2xl font-bold tabular-nums text-foreground">{metrics.difficulty.toFixed(3)}</span>
                        <DifficultyBadge value={metrics.difficulty} bands={bands?.difficulty} />
                      </div>
                    </div>
                    <div className="flex flex-col gap-1 rounded-lg border border-border-subtle bg-card px-5 py-4">
                      <span className="text-xs text-muted-foreground">区分度 D（高分组得分率 − 低分组得分率）</span>
                      <div className="flex items-center gap-2">
                        <span className="text-2xl font-bold tabular-nums text-foreground">{metrics.discrimination.toFixed(3)}</span>
                        <DiscriminationBadge value={metrics.discrimination} bands={bands?.discrimination} />
                      </div>
                    </div>
                  </div>
                )}

                {/* 分数段柱状图 + 班级箱线图 */}
                <div className="grid grid-cols-1 items-stretch gap-4 lg:grid-cols-2">
                  {overview.distribution.length > 0 && (
                    <section className="flex min-w-0 flex-col gap-2">
                      <h3 className="text-sm font-semibold text-foreground">分数段分布</h3>
                      <DistributionBar
                        data={{ labels: overview.distribution.map((d) => d.range), values: overview.distribution.map((d) => d.count) }}
                        height={220}
                      />
                    </section>
                  )}
                  {overview.scoreSummary && overview.overallScoreSummary && (
                    <section className="flex min-w-0 flex-col gap-2">
                      <h3 className="text-sm font-semibold text-foreground">班级箱线图</h3>
                      <AnalysisDistribution
                        summary={overview.scoreSummary}
                        overallSummary={overview.overallScoreSummary}
                        classSummaries={overview.classSummaries}
                        selectedClassId={classId}
                        onClassSelect={setClassId}
                        showTitle={false}
                      />
                    </section>
                  )}
                </div>

                {/* 前五 / 后五 / 进步Top5 / 退步Top5 */}
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                  <RankPanel title="年级前五" icon={<Star className="size-3.5 text-primary" aria-hidden />}>
                    {top5.map((r) => (
                      <div key={r.studentName} className="flex items-center gap-2 py-0.5 text-sm">
                        <span className="min-w-6 font-semibold tabular-nums text-primary">#{r.rank}</span>
                        <span className="truncate text-foreground">{r.studentName}</span>
                        <span className="truncate text-xs tabular-nums text-muted-foreground">{r.studentNumber}</span>
                        <span className="ml-auto font-medium tabular-nums text-foreground">{formatScore(r.totalScore)}</span>
                      </div>
                    ))}
                  </RankPanel>
                  <RankPanel title="年级后五" icon={<AlertTriangle className="size-3.5 text-destructive" aria-hidden />}>
                    {bottom5.map((r) => (
                      <div key={r.studentName} className="flex items-center gap-2 py-0.5 text-sm">
                        <span className="min-w-6 font-semibold tabular-nums text-destructive-fg">#{r.rank}</span>
                        <span className="truncate text-foreground">{r.studentName}</span>
                        <span className="ml-auto font-medium tabular-nums text-foreground">{formatScore(r.totalScore)}</span>
                      </div>
                    ))}
                  </RankPanel>
                  <RankPanel title="进步最大" icon={<TrendingUp className="size-3.5 text-success" aria-hidden />}>
                    {progressTop5.map((r, i) => (
                      <div key={`${r.studentName}-${i}`} className="flex items-center gap-2 py-0.5 text-sm">
                        <span className="inline-flex min-w-8 items-center gap-0.5 font-semibold tabular-nums text-success-foreground">
                          <TrendingUp className="size-3.5" aria-hidden />{r.rankChange}
                        </span>
                        <span className="truncate text-foreground">{r.studentName}</span>
                      </div>
                    ))}
                  </RankPanel>
                  <RankPanel title="退步最大" icon={<TrendingDown className="size-3.5 text-destructive" aria-hidden />}>
                    {declineTop5.map((r, i) => (
                      <div key={`${r.studentName}-${i}`} className="flex items-center gap-2 py-0.5 text-sm">
                        <span className="inline-flex min-w-8 items-center gap-0.5 font-semibold tabular-nums text-destructive-fg">
                          <TrendingDown className="size-3.5" aria-hidden />{Math.abs(r.rankChange)}
                        </span>
                        <span className="truncate text-foreground">{r.studentName}</span>
                      </div>
                    ))}
                  </RankPanel>
                </div>

                {/* 临界生名单 */}
                {criticalList.length > 0 && (
                  <RankPanel title={`临界生（及格/优秀线 ±${Math.round(overview.passScore * 0.05)} 分）`}>
                    {criticalList.map((r) => {
                      const excellent = r.totalScore >= overview.excellentScore;
                      const passed = r.totalScore >= overview.passScore;
                      return (
                        <div
                          key={r.studentName}
                          className={cn(
                            "flex items-center gap-2 py-0.5 text-sm",
                            passed ? "text-success-foreground" : "text-warning-foreground",
                          )}
                        >
                          <span className="min-w-6" aria-label={excellent ? "优秀" : passed ? "达标" : "待提升"}>
                            {excellent
                              ? <Star className="size-4" aria-hidden />
                              : passed
                                ? <CheckCircle2 className="size-4" aria-hidden />
                                : <AlertTriangle className="size-4" aria-hidden />}
                          </span>
                          <span className="truncate">{r.studentName}</span>
                          <span className="ml-auto font-medium tabular-nums">{formatScore(r.totalScore)}</span>
                        </div>
                      );
                    })}
                  </RankPanel>
                )}

                {/* 趋势图 */}
                {subject && (
                  <AnalysisTrend exams={[{ subject }]} initialSubject={subject} initialClassId={classId || undefined} />
                )}
              </div>
            ) : (
              <div className="p-10 text-center text-sm text-muted-foreground">
                {loading ? "正在加载..." : "暂无数据"}
              </div>
            )}
          </TabsContent>

          {/* ====== 成绩 Tab ====== */}
          <TabsContent value="scores" className="p-6">
            <ScoreTable
              key={scoreTableKey}
              examId={examId}
              classId={classId || undefined}
              displayMode={displayMode}
              onRowClick={(id, name, num) => setSelectedStudent({ id, name, number: num })}
            />
          </TabsContent>

          {/* ====== 题目分析 Tab ====== */}
          <TabsContent value="question-analysis" className="flex flex-col gap-5 p-6">
            <AnalysisQuestions
              questions={questions}
              bands={bands ?? undefined}
              onRowClick={(qn) => setDrillQuestion(qn)}
            />
            <KnowledgePanel examId={examId} classId={classId || undefined} />
          </TabsContent>

          {/* ====== 班级对比 Tab ====== */}
          <TabsContent value="class-compare">
            <ClassComparePanel examId={examId} classGroups={classGroups} />
          </TabsContent>

          {/* ====== 总体分析 Tab ====== */}
          <TabsContent value="overall">
            <AnalysisOverall kind="exam" examId={examId} bands={bands ?? undefined} />
          </TabsContent>

          {/* ====== AI分析 Tab ====== */}
          <TabsContent value="ai" className="p-6">
            <AnalysisAiPanel examId={examId} />
          </TabsContent>
        </div>
      </Tabs>

      {/* Modals */}
      {showExport && <ExportModal examId={examId} examName={examName} classId={classId || undefined} onClose={() => setShowExport(false)} />}
      <ThresholdSettingsDialog open={showThresholdSettings} onClose={() => setShowThresholdSettings(false)} />
      {drillQuestion && (
        <QuestionStudentScoresModal
          examId={examId}
          questionNumber={drillQuestion}
          questionMaxScore={questions.find((q) => q.questionNumber === drillQuestion)?.maxScore ?? 0}
          classId={classId || undefined}
          onClose={() => setDrillQuestion(null)}
        />
      )}
    </div>
  );
}

/** 概况页的小榜单卡片（原 .analysis-section + .panel-title） */
function RankPanel({ title, icon, children }: { title: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1 rounded-lg border border-border-subtle bg-card px-4 py-3">
      <h3 className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-foreground">
        {icon}{title}
      </h3>
      {children}
    </section>
  );
}

// ── 知识点分析面板（P0-4 轻量版 + 分层着色）─────
type KnowledgeSeverity = "common_weak" | "weak" | "ok";

const SEVERITY_DOT: Record<KnowledgeSeverity, string> = {
  common_weak: "bg-destructive",
  weak: "bg-warning",
  ok: "bg-success",
};

const SEVERITY_TEXT: Record<KnowledgeSeverity, string> = {
  common_weak: "text-destructive-fg",
  weak: "text-warning-foreground",
  ok: "text-success-foreground",
};

function severityKey(s: string): KnowledgeSeverity {
  return s === "common_weak" ? "common_weak" : s === "weak" ? "weak" : "ok";
}

function KnowledgePanel({ examId, classId }: { examId: number; classId: string | undefined }) {
  const [items, setItems] = useState<KnowledgeWeaknessItem[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (classId) params.set("classId", classId);
    fetchJson<KnowledgeWeaknessItem[]>(`/api/analysis/knowledge-points/${examId}?${params.toString()}`)
      .then((d) => setItems(Array.isArray(d) ? d : []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [examId, classId]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return <div className="py-4 text-center text-sm text-muted-foreground">加载知识点分析...</div>;
  }
  if (items.length === 0) {
    return (
      <EmptyState
        size="sm"
        title="暂无知识点数据"
        description="请先在答题卡设计页为题目标注知识点。"
        className="rounded-lg border border-dashed border-border-strong bg-secondary"
      />
    );
  }

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-foreground">知识点薄弱环节</h3>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 shrink-0 rounded-full bg-destructive" aria-hidden />
          共性薄弱（得分率低于及格线且覆盖人数广）
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 shrink-0 rounded-full bg-warning" aria-hidden />
          一般薄弱
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 shrink-0 rounded-full bg-success" aria-hidden />
          达标
        </span>
        <span>｜按严重度排序</span>
      </div>
      <ul className="flex flex-col rounded-lg border border-border-subtle bg-card">
        {items.map((kp, i) => {
          const sev = severityKey(kp.severity);
          return (
            <li
              key={`${kp.point_text}-${i}`}
              className="flex items-center gap-2 border-b border-border-subtle px-3 py-1.5 text-sm last:border-b-0"
            >
              <span className={cn("size-2 shrink-0 rounded-full", SEVERITY_DOT[sev])} aria-hidden />
              <span className="min-w-0 flex-1 truncate text-foreground">{kp.point_text}</span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">题{kp.question_numbers}</span>
              <span className={cn("min-w-11 shrink-0 text-right font-semibold tabular-nums", SEVERITY_TEXT[sev])}>
                {formatPercent(kp.avg_rate)}
              </span>
              <span className="min-w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                {kp.coverage_rate > 0 ? `${kp.coverage_rate}% 学生` : ""}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ── 班级对比面板 ──────────────────────────────────────
interface ClassComparisonClass {
  classId: number;
  className: string;
  count: number;
  avgScore: number;
  median: number;
  maxScore: number;
  minScore: number;
  stdDev: number;
  passRate: number;
  excellentRate: number;
  distribution?: Array<{ range: string; count: number }>;
}

interface ClassComparisonQuestion {
  questionNumber: string;
  byClass: Array<{ classId: number; scoreRate: number }>;
}

interface ClassComparisonResult {
  classes: ClassComparisonClass[];
  questionStats?: ClassComparisonQuestion[];
}

const MAX_COMPARE_CLASSES = 8;

function ClassComparePanel({ examId, classGroups }: { examId: number; classGroups: Array<[string, ClassOption[]]> }) {
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [comparison, setComparison] = useState<ClassComparisonResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  function toggleClass(id: number) {
    setSelectedIds((prev) =>
      prev.includes(id)
        ? prev.filter((x) => x !== id)
        : prev.length < MAX_COMPARE_CLASSES ? [...prev, id] : prev,
    );
  }

  const selectedKey = selectedIds.join(",");

  useEffect(() => {
    if (selectedIds.length < 2) { setComparison(null); setError(""); return; }
    setLoading(true); setError("");
    const params = new URLSearchParams();
    params.set("classIds", selectedKey);
    params.set("includeOptions", "1");
    fetchJson<ClassComparisonResult>(`/api/analysis/exams/${examId}/class-comparison?${params.toString()}`)
      .then((d) => setComparison(d))
      .catch((e) => setError(e instanceof Error ? e.message : "加载失败"))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey, examId]);

  return (
    <div className="flex flex-col gap-4 p-6">
      <h3 className="text-sm font-semibold text-foreground">勾选班级进行对比（2–{MAX_COMPARE_CLASSES} 个）</h3>
      {classGroups.map(([grade, list]) => (
        <div key={grade} className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold text-muted-foreground">{grade}</span>
          <div className="flex flex-wrap gap-2">
            {list.map((c) => {
              const active = selectedIds.includes(c.id);
              const atLimit = !active && selectedIds.length >= MAX_COMPARE_CLASSES;
              return (
                <label
                  key={c.id}
                  className={cn(
                    "inline-flex h-control-sm cursor-pointer items-center gap-2 rounded-full border px-3 text-xs",
                    "transition-colors duration-(--px-dur-1) ease-standard",
                    active
                      ? "border-accent-border bg-accent font-semibold text-accent-foreground"
                      : "border-border bg-card text-secondary-foreground hover:bg-secondary",
                    atLimit && "cursor-not-allowed opacity-50",
                  )}
                >
                  <Checkbox
                    checked={active}
                    disabled={atLimit}
                    onCheckedChange={() => toggleClass(c.id)}
                    aria-label={`对比 ${c.name}`}
                  />
                  {c.name}
                </label>
              );
            })}
          </div>
        </div>
      ))}

      {error && <p className="text-sm text-destructive-fg">{error}</p>}
      {loading && <p className="py-5 text-center text-sm text-muted-foreground">加载中...</p>}

      {comparison && (
        <>
          {/* ① 总分对比统计表 */}
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-foreground">总分统计</h3>
            <TableWrap>
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
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
                  {comparison.classes.map((c) => (
                    <TableRow key={c.classId}>
                      <TableCell>{c.className}</TableCell>
                      <TableCell numeric>{c.count}</TableCell>
                      <TableCell numeric className="font-semibold">{formatScore(c.avgScore)}</TableCell>
                      <TableCell numeric>{formatScore(c.median)}</TableCell>
                      <TableCell numeric>{formatScore(c.maxScore)}</TableCell>
                      <TableCell numeric>{formatScore(c.minScore)}</TableCell>
                      <TableCell numeric>{formatScore(c.stdDev)}</TableCell>
                      <TableCell numeric>{formatPercent(c.passRate)}</TableCell>
                      <TableCell numeric>{formatPercent(c.excellentRate)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableWrap>
          </section>

          {/* ② 分段分布对比柱状图 */}
          {comparison.classes.length > 0 && comparison.classes[0].distribution && (
            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold text-foreground">分数段分布对比</h3>
              <ClassDistributionBar
                labels={comparison.classes[0].distribution.map((d) => d.range)}
                classes={comparison.classes.map((c) => ({ className: c.className }))}
                matrix={comparison.classes[0].distribution.map((_, gi) =>
                  comparison.classes.map((c) => c.distribution?.[gi]?.count ?? 0),
                )}
                height={260}
              />
            </section>
          )}

          {/* ③ 逐题得分率热力表 */}
          {comparison.questionStats && comparison.questionStats.length > 0 && (
            <section className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold text-foreground">逐题得分率</h3>
                <Badge tone="neutral">底色越深 = 得分率越高</Badge>
              </div>
              <TableWrap>
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>题号</TableHead>
                      {comparison.classes.map((c) => (
                        <TableHead key={c.classId} numeric>{c.className}</TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {comparison.questionStats.map((q) => (
                      <TableRow key={q.questionNumber} className="hover:bg-transparent">
                        <TableCell className="tabular-nums">{q.questionNumber}</TableCell>
                        {comparison.classes.map((c) => {
                          const bc = q.byClass.find((b) => b.classId === c.classId);
                          const rate = bc?.scoreRate ?? 0;
                          return (
                            <TableCell
                              key={c.classId}
                              numeric
                              className="font-medium"
                              // 数据驱动热力强度：色相取 chart-1 语义 token，只有百分比是动态值
                              style={{ backgroundColor: `color-mix(in srgb, var(--color-chart-1) ${(rate * 0.3).toFixed(1)}%, transparent)` }}
                            >
                              {formatPercent(rate)}
                            </TableCell>
                          );
                        })}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableWrap>
            </section>
          )}
        </>
      )}
    </div>
  );
}
