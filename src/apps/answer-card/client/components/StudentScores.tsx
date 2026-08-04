import { useCallback, useEffect, useState } from "react";
import { BarChart3, BrainCircuit, CalendarRange, ChevronDown, LineChart, Radar, RefreshCw, Shield, Sparkles } from "lucide-react";
import { fetchJson } from "../auth/api";
import type { StudentExamScore, StudentQuestionScore } from "../auth/types";
import type { StudentTrendPoint, AiAnalysisResponse } from "../../../../shared/types";
import { StudentTrendChart } from "./StudentTrendChart";
import { StudentSubjectRadar } from "./StudentSubjectRadar";
import { StudentAiPanel } from "./StudentAiPanel";
import { StudentSemesterComparison } from "./StudentSemesterComparison";
import { Button, Badge, Card, CardContent, CardHeader, CardTitle, EmptyState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Tabs, TabsContent, TabsList, TabsTrigger, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/v2";

interface ScoresResponse {
  studentId: number;
  name: string;
  scores: StudentExamScore[];
}

interface ExamDetailResponse {
  examId: number;
  questions: StudentQuestionScore[];
}

type TabId = "list" | "trend" | "subjects" | "semester" | "ai";

const TABS: { id: TabId; label: string; icon: React.ReactNode }[] = [
  { id: "list", label: "成绩列表", icon: <BarChart3 size={16} /> },
  { id: "trend", label: "趋势分析", icon: <LineChart size={16} /> },
  { id: "subjects", label: "学科对比", icon: <Radar size={16} /> },
  { id: "semester", label: "学期对比", icon: <CalendarRange size={16} /> },
  { id: "ai", label: "AI 分析", icon: <Sparkles size={16} /> },
];

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("zh-CN");
  } catch {
    return iso;
  }
}

export function StudentScores() {
  const [activeTab, setActiveTab] = useState<TabId>("list");
  const [data, setData] = useState<ScoresResponse | null>(null);
  const [expandedExamId, setExpandedExamId] = useState<number | null>(null);
  const [selectedExamId, setSelectedExamId] = useState<number | null>(null);
  const [examDetails, setExamDetails] = useState<Record<number, StudentQuestionScore[]>>({});
  const [trends, setTrends] = useState<StudentTrendPoint[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [trendError, setTrendError] = useState("");
  const sortedExams = data
    ? [...data.scores].sort((a, b) => String(b.graded_at).localeCompare(String(a.graded_at)))
    : [];

  const loadScores = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const scoreResult = await fetchJson<ScoresResponse>("/api/scores/me");
      setData(scoreResult);
      setSelectedExamId(null);
      setExamDetails({});
      setExpandedExamId(null);
      try {
        const trendResult = await fetchJson<StudentTrendPoint[]>("/api/scores/me/trends");
        setTrends(Array.isArray(trendResult) ? trendResult : []);
        setTrendError("");
      } catch (err) {
        setTrends([]);
        setTrendError(err instanceof Error ? err.message : "趋势数据加载失败");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载成绩失败");
      setData(null);
      setSelectedExamId(null);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void loadScores();
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void loadScores();
    };
    const refreshOnFocus = () => void loadScores();
    document.addEventListener("visibilitychange", refreshWhenVisible);
    window.addEventListener("focus", refreshOnFocus);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadScores();
    }, 30_000);
    return () => {
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.removeEventListener("focus", refreshOnFocus);
      window.clearInterval(timer);
    };
  }, [loadScores]);

  async function toggleExamDetail(examId: number) {
    if (expandedExamId === examId) {
      setExpandedExamId(null);
      return;
    }
    setExpandedExamId(examId);
    if (examDetails[examId]) return;
    try {
      const detail = await fetchJson<ExamDetailResponse>(`/api/scores/me/exams/${examId}`);
      setExamDetails((prev) => ({ ...prev, [examId]: detail.questions }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载明细失败");
    }
  }

  // （整体概览已移除：改为「先选考试再看分」的两级流程）

  // ── 第二级：选定考试的逐科成绩与逐题明细 ──
  function renderScoreList() {
    if (!data) return null;
    const selectedExam = data.scores.find((s) => s.exam_id === selectedExamId);
    if (!selectedExam) return null;
    const scoreRate = selectedExam.total_score / Math.max(selectedExam.objective_score + selectedExam.subjective_score, 100);
    return (
      <Card>
        <CardHeader>
          <div><CardTitle>{selectedExam.exam_name} · 逐科成绩</CardTitle><p className="mt-1 text-sm text-muted-foreground">第二步 · 查看该场考试的得分与逐题明细</p></div>
          <Badge tone="neutral" dot>仅本人</Badge>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader><TableRow><TableHead>科目</TableHead><TableHead numeric>得分</TableHead><TableHead numeric>满分</TableHead><TableHead numeric>得分率</TableHead><TableHead>评价</TableHead><TableHead numeric>明细</TableHead></TableRow></TableHeader>
            <TableBody>
              <TableRow clickable onClick={() => void toggleExamDetail(selectedExam.exam_id)}>
                <TableCell>{selectedExam.subject || "综合"}</TableCell>
                <TableCell numeric><span className="tabular-nums">{selectedExam.total_score}</span></TableCell>
                <TableCell numeric><span className="tabular-nums">{Math.max(selectedExam.objective_score + selectedExam.subjective_score, 100)}</span></TableCell>
                <TableCell numeric><span className="tabular-nums">{Math.round(scoreRate * 100)}%</span></TableCell>
                <TableCell><Badge tone={scoreRate >= 0.85 ? "success" : scoreRate >= 0.6 ? "neutral" : "danger"} dot>{scoreRate >= 0.85 ? "优势" : scoreRate >= 0.6 ? "稳定" : "待提升"}</Badge></TableCell>
                <TableCell numeric><ChevronDown size={16} className={expandedExamId === selectedExam.exam_id ? "rotate-180" : ""} /></TableCell>
              </TableRow>
            </TableBody>
          </Table>
          {expandedExamId === selectedExam.exam_id && examDetails[selectedExam.exam_id] && (
            <div className="mt-4 rounded-md border border-border-subtle bg-secondary p-3">
              <Table>
                <TableHeader><TableRow><TableHead>题号</TableHead><TableHead numeric>得分</TableHead><TableHead numeric>满分</TableHead><TableHead>类型</TableHead></TableRow></TableHeader>
                <TableBody>{examDetails[selectedExam.exam_id].map((q, i) => <TableRow key={`${q.question_id ?? q.question_number}_${i}`}><TableCell>{q.question_number ?? q.question_id ?? "—"}</TableCell><TableCell numeric>{q.score}</TableCell><TableCell numeric>{q.max_score}</TableCell><TableCell>{q.score_type}</TableCell></TableRow>)}</TableBody>
              </Table>
              <div className="mt-3"><AiAnalysisForExam examId={selectedExam.exam_id} examName={selectedExam.exam_name} /></div>
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between rounded-lg border border-border-subtle bg-card px-4 py-3 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-2"><Shield size={14} />仅展示本人成绩 · 只读</span>
        <Button variant="ghost" size="sm" onClick={() => void loadScores()} disabled={busy}><RefreshCw size={16} />刷新</Button>
      </div>
      {error && <div className="rounded-md border border-destructive-border bg-destructive-soft px-3 py-2 text-sm text-destructive-fg">{error}</div>}
      {trendError && <div className="rounded-md border border-warning-border bg-warning-soft px-3 py-2 text-sm text-warning-foreground">趋势数据暂时不可用：{trendError}</div>}

      {data && data.scores.length > 0 ? (
        <>
          {/* 第一级 · 选择考试 */}
          <Card>
            <CardHeader>
              <div><CardTitle className="inline-flex items-center gap-2"><CalendarRange size={18} />第一步 · 选择考试</CardTitle><p className="m-0 mt-1 text-xs text-muted-foreground">先选定要查看的考试，再展开成绩明细</p></div>
            </CardHeader>
            <CardContent>
              <Select
                value={selectedExamId != null ? String(selectedExamId) : ""}
                onValueChange={(v) => {
                  const id = Number(v);
                  setSelectedExamId(id);
                  setExpandedExamId(null);
                }}
              >
                <SelectTrigger className="w-full max-w-[440px]">
                  <SelectValue placeholder="选择一场考试" />
                </SelectTrigger>
                <SelectContent>
                  {sortedExams.map((exam) => (
                    <SelectItem key={exam.exam_id} value={String(exam.exam_id)}>
                      {exam.exam_name} · {exam.subject ?? "综合"} · {fmtDate(exam.graded_at)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </CardContent>
          </Card>

          {/* 第二级 · 成绩明细（选了考试再看分） */}
          {selectedExamId == null ? (
            <EmptyState icon={<BarChart3 />} title="请先选择一场考试" description="在上方“第一步 · 选择考试”中选定考试后，这里会展示该场考试的得分与逐题明细。" />
          ) : (
            renderScoreList()
          )}

          <Card>
            <CardHeader><CardTitle>AI 学习建议</CardTitle><p className="m-0 text-xs text-muted-foreground">由 LLM 生成</p></CardHeader>
            <CardContent><StudentAiPanel /></CardContent>
          </Card>
        </>
      ) : (
        !busy && !error && (
          <EmptyState icon={<BarChart3 />} title="暂无成绩记录" description="考试阅卷落库后，可在此查看各场考试得分与逐题明细。" />
        )
      )}

      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as TabId)} className="flex flex-col gap-4">
        <TabsList>
          {TABS.slice(1).map((tab) => (
            <TabsTrigger key={tab.id} value={tab.id}>{tab.icon}{tab.label}</TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="trend"><StudentTrendChart trends={trends} /></TabsContent>
        <TabsContent value="subjects"><StudentSubjectRadar /></TabsContent>
        <TabsContent value="semester"><StudentSemesterComparison /></TabsContent>
        <TabsContent value="ai">
          {data?.scores.length === 0 && <Card><CardContent><StudentAiPanel /></CardContent></Card>}
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** 内联的按考试 AI 分析组件 */
function AiAnalysisForExam({ examId, examName }: { examId: number; examName: string }) {
  const [result, setResult] = useState<AiAnalysisResponse | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);

  async function generate() {
    if (result && !expanded) {
      setExpanded(true);
      return;
    }
    if (generating) return;
    setGenerating(true);
    setError("");
    try {
      const res = await fetchJson<AiAnalysisResponse>(`/api/scores/me/exams/${examId}/ai-analysis`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      setResult(res);
      setExpanded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <Button
        variant="ghost"
        size="sm"
        type="button"
        onClick={() => void generate()}
        disabled={generating}
        loading={generating}
        icon={<BrainCircuit className="size-4" />}
        className="self-start"
      >
        {generating ? "分析中..." : result ? "AI 分析结果" : "AI 分析"}
      </Button>
      {error && <span className="text-xs text-destructive-fg">{error}</span>}
      {expanded && result && (
        <div className="flex flex-col gap-1 rounded-md border border-accent-border bg-accent px-3.5 py-2.5 text-xs leading-relaxed text-secondary-foreground">
          <p className="m-0"><strong className="font-semibold text-foreground">{result.report.overallJudgement}</strong></p>
          {result.report.weakPoints.length > 0 && (
            <div>
              <span className="font-medium text-foreground">薄弱点：</span>
              {result.report.weakPoints.join("；")}
            </div>
          )}
          {result.report.teachingSuggestions.length > 0 && (
            <div>
              <span className="font-medium text-foreground">建议：</span>
              {result.report.teachingSuggestions.join("；")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
