import { useCallback, useEffect, useState } from "react";
import { BarChart3, BrainCircuit, CalendarRange, ChevronDown, LineChart, Radar, RefreshCw, Shield, Sparkles, TrendingUp } from "lucide-react";
import { fetchJson } from "../auth/api";
import type { StudentExamScore, StudentQuestionScore } from "../auth/types";
import type { StudentTrendPoint, AiAnalysisResponse } from "../../../../shared/types";
import { StudentTrendChart } from "./StudentTrendChart";
import { StudentSubjectRadar } from "./StudentSubjectRadar";
import { StudentAiPanel } from "./StudentAiPanel";
import { StudentSemesterComparison } from "./StudentSemesterComparison";
import { Button, Badge, Card, CardContent, CardHeader, CardTitle, EmptyState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/v2";

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

export function StudentScores() {
  const [activeTab, setActiveTab] = useState<TabId>("list");
  const [data, setData] = useState<ScoresResponse | null>(null);
  const [expandedExamId, setExpandedExamId] = useState<number | null>(null);
  const [examDetails, setExamDetails] = useState<Record<number, StudentQuestionScore[]>>({});
  const [trends, setTrends] = useState<StudentTrendPoint[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [trendError, setTrendError] = useState("");

  const loadScores = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const scoreResult = await fetchJson<ScoresResponse>("/api/scores/me");
      setData(scoreResult);
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

  // ── 整体概览卡片 ──
  function renderOverview() {
    if (!data || !data.scores.length) return null;
    const latest = data.scores[0];
    const previous = data.scores[1];
    const maxScore = latest.objective_score + latest.subjective_score > 0
      ? Math.max(latest.objective_score + latest.subjective_score, 100)
      : 100;
    const delta = previous ? Math.round((latest.total_score - previous.total_score) * 10) / 10 : null;

    return (
      <div className="grid gap-4 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <div className="rounded-lg border border-border-subtle bg-card p-5">
          <p className="m-0 text-xs text-muted-foreground">最近考试总分</p>
          <div className="mt-2 flex items-baseline gap-1">
            <strong className="text-3xl font-bold tabular-nums text-foreground">{latest.total_score}</strong>
            <span className="text-sm text-muted-foreground">/ {maxScore}</span>
          </div>
          {delta != null && <p className={`mt-2 m-0 text-xs tabular-nums ${delta >= 0 ? "text-success-foreground" : "text-destructive-fg"}`}>{delta >= 0 ? "▲" : "▼"} {Math.abs(delta)} 分 · 较上一场考试</p>}
        </div>
        <div className="rounded-lg border border-border-subtle bg-card p-5 md:col-span-2">
          <div className="flex items-center justify-between">
            <div><p className="m-0 text-xs text-muted-foreground">近 5 场总分趋势</p><p className="m-0 mt-1 text-sm font-semibold text-foreground">个人成绩变化</p></div>
            <LineChart size={18} className="text-muted-foreground" />
          </div>
          <div className="mt-4 h-24"><StudentTrendChart trends={trends.slice(0, 5)} compact /></div>
        </div>
      </div>
    );
  }

  // ── Tab: 成绩列表 ──
  function renderScoreList() {
    const latest = data?.scores[0];
    if (!latest && !busy && !error) {
      return <EmptyState icon={<BarChart3 />} title="暂无成绩记录" description="考试阅卷落库后，可在此查看各场考试得分与逐题明细。" />;
    }
    if (!latest) return null;
    const scoreRate = latest.total_score / Math.max(latest.objective_score + latest.subjective_score, 100);
    return (
      <Card>
        <CardHeader>
          <div><CardTitle>{latest.exam_name} · 逐科成绩</CardTitle><p className="mt-1 text-sm text-muted-foreground">点击查看逐题明细</p></div>
          <Badge tone="neutral" dot>仅本人</Badge>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader><TableRow><TableHead>科目</TableHead><TableHead numeric>得分</TableHead><TableHead numeric>满分</TableHead><TableHead numeric>得分率</TableHead><TableHead>评价</TableHead><TableHead numeric>明细</TableHead></TableRow></TableHeader>
            <TableBody>
              <TableRow clickable onClick={() => void toggleExamDetail(latest.exam_id)}>
                <TableCell>{latest.subject || "综合"}</TableCell>
                <TableCell numeric><span className="tabular-nums">{latest.total_score}</span></TableCell>
                <TableCell numeric><span className="tabular-nums">{Math.max(latest.objective_score + latest.subjective_score, 100)}</span></TableCell>
                <TableCell numeric><span className="tabular-nums">{Math.round(scoreRate * 100)}%</span></TableCell>
                <TableCell><Badge tone={scoreRate >= 0.85 ? "success" : scoreRate >= 0.6 ? "neutral" : "danger"} dot>{scoreRate >= 0.85 ? "优势" : scoreRate >= 0.6 ? "稳定" : "待提升"}</Badge></TableCell>
                <TableCell numeric><ChevronDown size={16} className={expandedExamId === latest.exam_id ? "rotate-180" : ""} /></TableCell>
              </TableRow>
            </TableBody>
          </Table>
          {expandedExamId === latest.exam_id && examDetails[latest.exam_id] && (
            <div className="mt-4 rounded-md border border-border-subtle bg-secondary p-3">
              <Table>
                <TableHeader><TableRow><TableHead>题号</TableHead><TableHead numeric>得分</TableHead><TableHead numeric>满分</TableHead><TableHead>类型</TableHead></TableRow></TableHeader>
                <TableBody>{examDetails[latest.exam_id].map((q, i) => <TableRow key={`${q.question_id ?? q.question_number}_${i}`}><TableCell>{q.question_number ?? q.question_id ?? "—"}</TableCell><TableCell numeric>{q.score}</TableCell><TableCell numeric>{q.max_score}</TableCell><TableCell>{q.score_type}</TableCell></TableRow>)}</TableBody>
              </Table>
              <div className="mt-3"><AiAnalysisForExam examId={latest.exam_id} examName={latest.exam_name} /></div>
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
      {renderOverview()}
      {data && data.scores.length > 0 && (
        <>
          {renderScoreList()}
          <Card>
            <CardHeader><CardTitle>AI 学习建议</CardTitle><p className="m-0 text-xs text-muted-foreground">由 LLM 生成</p></CardHeader>
            <CardContent><StudentAiPanel /></CardContent>
          </Card>
        </>
      )}
      <div className="flex flex-wrap items-center gap-1 border-b border-border-subtle">
        {TABS.slice(1).map((tab) => <button key={tab.id} type="button" className={`inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm ${activeTab === tab.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`} onClick={() => setActiveTab(tab.id)}>{tab.icon}{tab.label}</button>)}
      </div>
      {activeTab === "trend" && <StudentTrendChart trends={trends} />}
      {activeTab === "subjects" && <StudentSubjectRadar />}
      {activeTab === "semester" && <StudentSemesterComparison />}
      {activeTab === "ai" && data?.scores.length === 0 && <Card><CardContent><StudentAiPanel /></CardContent></Card>}
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
    <div className="ai-exam-inline">
      <button className="ghost-button" type="button" onClick={() => void generate()} disabled={generating}>
        <BrainCircuit size={14} /> {generating ? "分析中..." : result ? "AI 分析结果" : "AI 分析"}
      </button>
      {error && <span className="ai-inline-error">{error}</span>}
      {expanded && result && (
        <div className="ai-exam-inline-result">
          <p><strong>{result.report.overallJudgement}</strong></p>
          {result.report.weakPoints.length > 0 && (
            <div className="ai-exam-weak">
              <span>薄弱点：</span>
              {result.report.weakPoints.join("；")}
            </div>
          )}
          {result.report.teachingSuggestions.length > 0 && (
            <div className="ai-exam-suggest">
              <span>建议：</span>
              {result.report.teachingSuggestions.join("；")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
