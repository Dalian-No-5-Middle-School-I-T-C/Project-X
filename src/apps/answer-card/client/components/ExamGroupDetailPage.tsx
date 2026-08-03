import { useEffect, useMemo, useRef, useState } from "react";
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
  /** 文理分科（Issue #177）：all / arts / science */
  const [trackFilter, setTrackFilter] = useState<"all" | "arts" | "science">("all");
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
  }, [groupId, fullOnly, classId, trackFilter]);

  useEffect(() => {
    if (subTab === "question-analysis" && !questionAnalysis) loadQuestionAnalysis();
    if (subTab === "class-compare" && !classComparison) loadClassComparison();
  }, [subTab, trackFilter, groupId]);

  async function loadOverview() {
    setLoading(true);
    try {
      const data = await fetchJson<GroupOverview>(`/api/exam-groups/${groupId}/overview?track=${trackFilter}`);
      setOverview(data);
    } catch { setOverview(null); }
    finally { setLoading(false); }
  }
  async function loadMetrics() {
    try { setMetrics(await fetchJson<GroupMetrics>(`/api/exam-groups/${groupId}/metrics?track=${trackFilter}`)); }
    catch { setMetrics(null); }
  }
  async function loadRankings() {
    try {
      const params = new URLSearchParams();
      if (classId) params.set("classId", classId);
      if (fullOnly) params.set("fullOnly", "1");
      params.set("track", trackFilter);
      const data = await fetchJson<GroupRankingResponse>(`/api/exam-groups/${groupId}/rankings?${params.toString()}`);
      setRankings(data);
    } catch { setRankings(null); }
  }
  // 评审修复（PR #212）：逐题分析/班级对比携带 track 参数；
  // 用请求序号防止快速切换文理时旧响应覆盖新响应。
  const qaReqSeq = useRef(0);
  const ccReqSeq = useRef(0);
  async function loadQuestionAnalysis() {
    const seq = ++qaReqSeq.current;
    try {
      const data = await fetchJson<GroupQuestionAnalysisResponse>(`/api/exam-groups/${groupId}/question-analysis?track=${trackFilter}`);
      if (seq === qaReqSeq.current) setQuestionAnalysis(data);
    } catch {
      if (seq === qaReqSeq.current) setQuestionAnalysis(null);
    }
  }
  async function loadClassComparison() {
    const seq = ++ccReqSeq.current;
    try {
      const data = await fetchJson<GroupClassComparisonResponse>(`/api/exam-groups/${groupId}/class-comparison?track=${trackFilter}`);
      if (seq === ccReqSeq.current) setClassComparison(data);
    } catch {
      if (seq === ccReqSeq.current) setClassComparison(null);
    }
  }

  const subjectList = useMemo(() => (overview?.subjects ?? []).map((s) => s.subject), [overview]);

  function changeTrackFilter(track: "all" | "arts" | "science") {
    setTrackFilter(track);
    setQuestionAnalysis(null);
    setClassComparison(null);
  }
  const metricsByExam = useMemo(
    () => new Map((metrics?.subjects ?? []).map((s) => [s.examId, s])),
    [metrics]
  );
  const activeSubject = subjectFilter || subjectList[0] || "";

  if (loading) {
    return (
      <div style={{ padding: 24, textAlign: "center", color: "var(--muted)" }}>
        正在加载大考数据...
      </div>
    );
  }
  if (!overview) {
    return (
      <div style={{ padding: 24, textAlign: "center", color: "var(--muted)" }}>
        大考数据加载失败
        <br /><button onClick={onBack} style={{ marginTop: 12, ...linkStyle }}>返回</button>
      </div>
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
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", gap: 12,
        padding: "14px 20px", borderBottom: "1px solid var(--border)", flexShrink: 0
      }}>
        <button onClick={onBack} style={{
          background: "none", border: "none", cursor: "pointer",
          padding: 4, borderRadius: 6, color: "var(--muted)"
        }}><ArrowLeft size={18} /></button>
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{overview.groupName}</h2>
          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>
            {overview.subjects.length} 科 · {overview.totalParticipants} 人参加 · {overview.fullParticipants} 人全科
            {trackFilter !== "all" && ` · ${trackFilter === "arts" ? "文科" : "理科"}`}
          </div>
        </div>
        {isTeacher && onExport && (
          <button onClick={onExport} style={{
            background: "var(--primary)", color: "#fff", border: "none",
            borderRadius: 6, padding: "6px 14px", fontSize: 13, cursor: "pointer",
            display: "flex", alignItems: "center", gap: 6
          }}>
            <Download size={14} /> 导出大考
          </button>
        )}
      </div>

      {/* Tabs */}
      <div style={{
        display: "flex", gap: 0, padding: "0 20px",
        borderBottom: "1px solid var(--border)", flexShrink: 0, overflowX: "auto"
      }}>
        {tabs.map(({ key, label, icon: Icon }) => (
          <button key={key} onClick={() => setSubTab(key)} style={{
            background: "none", border: "none",
            borderBottom: subTab === key ? "2px solid var(--primary)" : "2px solid transparent",
            padding: "10px 14px", fontSize: 13, cursor: "pointer", whiteSpace: "nowrap",
            color: subTab === key ? "var(--primary)" : "var(--muted)",
            fontWeight: subTab === key ? 600 : 400,
            display: "flex", alignItems: "center", gap: 4
          }}>
            <Icon size={14} />{label}
          </button>
        ))}
      </div>

      {/* View-mode toggle (成绩/题目分析/班级对比 共用) + 文理分科筛选（Issue #177） */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 20px 0", flexShrink: 0, flexWrap: "wrap" }}>
        {showViewToggle && (
          <>
          <Layers size={14} style={{ color: "var(--muted)" }} />
          <span style={{ fontSize: 12, color: "var(--muted)" }}>显示</span>
          <ViewToggleButton active={viewMode === "combined"} onClick={() => setViewMode("combined")}>总分 + 每科</ViewToggleButton>
          <ViewToggleButton active={viewMode === "per-subject"} onClick={() => setViewMode("per-subject")}>逐科</ViewToggleButton>
          {viewMode === "per-subject" && subjectList.length > 0 && (
            <select value={activeSubject} onChange={(e) => setSubjectFilter(e.target.value)}
              style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid var(--border)", fontSize: 12, background: "var(--surface)" }}>
              {subjectList.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          )}
          </>
        )}
        <span style={{ fontSize: 12, color: "var(--muted)" }}>文理</span>
        <ViewToggleButton active={trackFilter === "all"} onClick={() => changeTrackFilter("all")}>全部</ViewToggleButton>
        <ViewToggleButton active={trackFilter === "arts"} onClick={() => changeTrackFilter("arts")}>文科</ViewToggleButton>
        <ViewToggleButton active={trackFilter === "science"} onClick={() => changeTrackFilter("science")}>理科</ViewToggleButton>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: "auto", padding: "16px 20px" }}>
        {subTab === "overview" && <OverviewTab overview={overview} metricsByExam={metricsByExam} overallMetrics={metrics} bands={bands ?? undefined} />}
        {subTab === "scores" && (
          <ScoresTab rankings={rankings} classes={classes} classId={classId} setClassId={setClassId}
            fullOnly={fullOnly} setFullOnly={setFullOnly}
            viewMode={viewMode} subjectFilter={activeSubject} />
        )}
        {subTab === "question-analysis" && (
          <GroupQuestionAnalysisTab qa={questionAnalysis} bands={bands ?? undefined} viewMode={viewMode}
            subjectFilter={activeSubject} onDrill={(examId, qn, ms) => setDrill({ examId, questionNumber: qn, maxScore: ms })} />
        )}
        {subTab === "class-compare" && (
          <GroupClassCompareTab cc={classComparison} viewMode={viewMode} subjectFilter={activeSubject} />
        )}
        {subTab === "overall" && <AnalysisOverall kind="group" groupId={groupId} track={trackFilter} bands={bands ?? undefined} />}
        {subTab === "ai" && <AnalysisAiPanel groupId={groupId} />}
      </div>

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

function ViewToggleButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{
      padding: "4px 12px", borderRadius: 16, fontSize: 12, cursor: "pointer", border: "1.5px solid",
      borderColor: active ? "var(--primary)" : "var(--border)",
      background: active ? "var(--bg-accent)" : "var(--surface)",
      color: active ? "var(--primary)" : "var(--muted)", fontWeight: active ? 600 : 400
    }}>{children}</button>
  );
}

// ── Overview Tab ──

function OverviewTab({
  overview, metricsByExam, overallMetrics, bands
}: {
  overview: GroupOverview;
  metricsByExam: Map<number, GroupSubjectSummary & { difficulty?: number; discrimination?: number }>;
  overallMetrics: GroupMetrics | null;
  bands?: { difficulty: import("../../../../shared/stats").ThresholdBand[]; discrimination: import("../../../../shared/stats").ThresholdBand[] };
}) {
  return (
    <div>
      {/* 整体难度/区分度 */}
      {overallMetrics && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 12, marginBottom: 20 }}>
          <div style={{ background: "var(--bg-secondary)", borderRadius: 10, padding: 14, border: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ fontSize: 12, color: "var(--muted)" }}>整体难度系数 P</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 20, fontWeight: 700 }}>{overallMetrics.difficulty.toFixed(3)}</span>
              <DifficultyBadge value={overallMetrics.difficulty} bands={bands?.difficulty} />
            </div>
          </div>
          <div style={{ background: "var(--bg-secondary)", borderRadius: 10, padding: 14, border: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ fontSize: 12, color: "var(--muted)" }}>整体区分度 D</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 20, fontWeight: 700 }}>{overallMetrics.discrimination.toFixed(3)}</span>
              <DiscriminationBadge value={overallMetrics.discrimination} bands={bands?.discrimination} sampleSize={overallMetrics.participantCount} />
            </div>
          </div>
          <div style={{ background: "var(--bg-secondary)", borderRadius: 10, padding: 14, border: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ fontSize: 12, color: "var(--muted)" }}>大考总分满分</div>
            <span style={{ fontSize: 20, fontWeight: 700 }}>{overallMetrics.totalFullScore}</span>
          </div>
          <div style={{ background: "var(--bg-secondary)", borderRadius: 10, padding: 14, border: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ fontSize: 12, color: "var(--muted)" }}>大考总均分</div>
            <span style={{ fontSize: 20, fontWeight: 700 }}>{overallMetrics.totalAvg}</span>
          </div>
        </div>
      )}

      <div style={{
        display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
        gap: 12, marginBottom: 20
      }}>
        {overview.subjects.map((sub) => (
          <div key={sub.examId} style={{
            background: "var(--bg-secondary)", borderRadius: 10,
            padding: 14, border: "1px solid var(--border)"
          }}>
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
              {sub.subject}
              {sub.trackType && sub.trackType !== "common" && (
                <span style={{
                  fontSize: 10, fontWeight: 500, color: "#fff",
                  background: sub.trackType === "arts" ? "#ec4899" : "#3b82f6",
                  borderRadius: 4, padding: "1px 5px"
                }}>
                  {sub.trackType === "arts" ? "文科" : "理科"}
                </span>
              )}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 12px", fontSize: 12 }}>
              <span style={{ color: "var(--muted)" }}>人数</span>
              <span style={{ fontWeight: 500, textAlign: "right" }}>{sub.gradedCount}</span>
              <span style={{ color: "var(--muted)" }}>满分</span>
              <span style={{ fontWeight: 500, textAlign: "right" }}>{sub.fullScore}</span>
              <span style={{ color: "var(--muted)" }}>均分</span>
              <span style={{ fontWeight: 600, textAlign: "right", color: "var(--primary)" }}>{sub.avgScore}</span>
              <span style={{ color: "var(--muted)" }}>最高</span>
              <span style={{ fontWeight: 500, textAlign: "right" }}>{sub.maxScore}</span>
              <span style={{ color: "var(--muted)" }}>最低</span>
              <span style={{ fontWeight: 500, textAlign: "right" }}>{sub.minScore}</span>
              <span style={{ color: "var(--muted)" }}>标准差</span>
              <span style={{ fontWeight: 500, textAlign: "right" }}>{sub.stdDev}</span>
              <span style={{ color: "var(--muted)" }}>及格率</span>
              <span style={{ fontWeight: 500, textAlign: "right" }}>{sub.passRate}%</span>
              <span style={{ color: "var(--muted)" }}>优秀率</span>
              <span style={{ fontWeight: 500, textAlign: "right" }}>{sub.excellentRate}%</span>
              <span style={{ color: "var(--muted)" }}>难度 P</span>
              <span style={{ fontWeight: 500, textAlign: "right" }}>
                {metricsByExam.get(sub.examId)?.difficulty != null
                  ? <DifficultyBadge value={metricsByExam.get(sub.examId)!.difficulty!} bands={bands?.difficulty} />
                  : "—"}
              </span>
              <span style={{ color: "var(--muted)" }}>区分度 D</span>
              <span style={{ fontWeight: 500, textAlign: "right" }}>
                {metricsByExam.get(sub.examId)?.discrimination != null
                  ? <DiscriminationBadge value={metricsByExam.get(sub.examId)!.discrimination!} bands={bands?.discrimination} sampleSize={metricsByExam.get(sub.examId)!.gradedCount} />
                  : "—"}
              </span>
            </div>
            {sub.hasAssignedScore && (
              <div style={{
                marginTop: 8, fontSize: 11, color: "#fff",
                background: "#f59e0b", borderRadius: 4, padding: "2px 6px",
                display: "inline-block"
              }}>含赋分</div>
            )}
          </div>
        ))}
      </div>

      {/* Summary table */}
      <div style={{ background: "var(--surface)", borderRadius: 10, border: "1px solid var(--border)", overflow: "hidden" }}>
        <div style={{ fontSize: 14, fontWeight: 600, padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
          各科参数总览
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "var(--bg-secondary)" }}>
                <th style={thStyle}>科目</th>
                <th style={thStyleR}>人数</th>
                <th style={thStyleR}>满分</th>
                <th style={thStyleR}>均分</th>
                <th style={thStyleR}>最高</th>
                <th style={thStyleR}>最低</th>
                <th style={thStyleR}>标准差</th>
                <th style={thStyleR}>及格率</th>
                <th style={thStyleR}>优秀率</th>
                <th style={thStyleR}>难度 P</th>
                <th style={thStyleR}>区分度 D</th>
              </tr>
            </thead>
            <tbody>
              {overview.subjects.map((sub) => {
                const m = metricsByExam.get(sub.examId);
                return (
                  <tr key={sub.examId}>
                    <td style={tdStyle}>
                      <strong>{sub.subject}</strong>
                      {sub.hasAssignedScore && <span style={{ fontSize: 10, color: "#f59e0b", marginLeft: 6 }}>赋分</span>}
                    </td>
                    <td style={tdStyleR}>{sub.gradedCount}</td>
                    <td style={tdStyleR}>{sub.fullScore}</td>
                    <td style={{ ...tdStyleR, fontWeight: 600, color: "var(--primary)" }}>{sub.avgScore}</td>
                    <td style={tdStyleR}>{sub.maxScore}</td>
                    <td style={tdStyleR}>{sub.minScore}</td>
                    <td style={tdStyleR}>{sub.stdDev}</td>
                    <td style={tdStyleR}>{sub.passRate}%</td>
                    <td style={tdStyleR}>{sub.excellentRate}%</td>
                    <td style={tdStyleR}>{m?.difficulty != null ? <DifficultyBadge value={m.difficulty} bands={bands?.difficulty} /> : "—"}</td>
                    <td style={tdStyleR}>{m?.discrimination != null ? <DiscriminationBadge value={m.discrimination} bands={bands?.discrimination} sampleSize={m.gradedCount} /> : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
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
      <div style={{ textAlign: "center", padding: 40, color: "var(--muted)" }}>
        <FileText size={36} style={{ opacity: 0.3, marginBottom: 8 }} />
        <p style={{ fontSize: 14 }}>暂无成绩数据</p>
      </div>
    );
  }

  const cols = viewMode === "per-subject" && subjectFilter
    ? rankings.displayColumns.filter((c) => c === subjectFilter)
    : rankings.displayColumns;

  return (
    <div>
      {/* Controls */}
      <div style={{ display: "flex", gap: 12, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 12, color: "var(--muted)" }}>班级</span>
          <select value={classId} onChange={(e) => setClassId(e.target.value)}
            style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid var(--border)", fontSize: 12, background: "var(--surface)" }}>
            <option value="">全年级</option>
            {classes.map((c) => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
          </select>
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer" }}>
          <input type="checkbox" checked={fullOnly} onChange={(e) => setFullOnly(e.target.checked)} />
          仅全科参加
        </label>
        <span style={{ fontSize: 12, color: "var(--muted)", marginLeft: "auto" }}>
          共 {rankings.totalStudents} 人
        </span>
      </div>

      {/* Table */}
      <div style={{ overflowX: "auto", border: "1px solid var(--border)", borderRadius: 10 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, whiteSpace: "nowrap" }}>
          <thead>
            <tr style={{ background: "var(--bg-secondary)" }}>
              <th style={thStyle}>年排</th>
              <th style={thStyle}>班排</th>
              <th style={thStyle}>班级</th>
              <th style={thStyle}>姓名</th>
              <th style={{ ...thStyle, background: "var(--bg-accent)" }}>总分</th>
              {cols.map((col) => [
                <th key={`${col}-raw`} style={thStyle}>{col}原始</th>,
                <th key={`${col}-rank-g`} style={{ ...thStyle, fontSize: 10 }}>{col}年排</th>,
                <th key={`${col}-rank-c`} style={{ ...thStyle, fontSize: 10 }}>{col}班排</th>
              ])}
            </tr>
          </thead>
          <tbody>
            {rankings.rows.map((row, idx) => (
              <tr key={row.studentId} style={{ background: idx % 2 === 0 ? undefined : "var(--bg-secondary)" }}>
                <td style={tdStyle}>{row.totalGradeRank}</td>
                <td style={tdStyle}>{row.totalClassRank}</td>
                <td style={tdStyle}>{row.className}</td>
                <td style={{ ...tdStyle, fontWeight: 500 }}>{row.studentName}</td>
                <td style={{ ...tdStyle, fontWeight: 600, color: "var(--primary)", background: "var(--bg-accent)" }}>
                  {row.totalRawScore}
                </td>
                {cols.map((col) => {
                  const sub = row.subjects.find((s) => s.subject === col);
                  if (!sub) {
                    return [
                      <td key={`${col}-raw`} style={{ ...tdStyle, color: "var(--muted)" }}>—</td>,
                      <td key={`${col}-rank-g`} style={{ ...tdStyle, color: "var(--muted)" }}>—</td>,
                      <td key={`${col}-rank-c`} style={{ ...tdStyle, color: "var(--muted)" }}>—</td>
                    ];
                  }
                  return [
                    <td key={`${col}-raw`} style={tdStyle}>
                      {sub.totalScore}
                      {sub.assignedScore != null && sub.assignedScore !== sub.totalScore && (
                        <span style={{ fontSize: 10, color: "#f59e0b", marginLeft: 3 }}>
                          →{sub.assignedScore}
                        </span>
                      )}
                    </td>,
                    <td key={`${col}-rank-g`} style={tdStyle}>{sub.gradeRank || "—"}</td>,
                    <td key={`${col}-rank-c`} style={tdStyle}>{sub.classRank || "—"}</td>
                  ];
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── 大考题目分析 Tab ──

function GroupQuestionAnalysisTab({
  qa, bands, viewMode, subjectFilter, onDrill
}: {
  qa: GroupQuestionAnalysisResponse | null;
  bands?: { difficulty: import("../../../../shared/stats").ThresholdBand[]; discrimination: import("../../../../shared/stats").ThresholdBand[] };
  viewMode: ViewMode; subjectFilter: string;
  onDrill: (examId: number, questionNumber: string, maxScore: number) => void;
}) {
  if (!qa) {
    return <div style={{ textAlign: "center", padding: 40, color: "var(--muted)" }}>加载中或暂无数据…</div>;
  }
  const subjects = viewMode === "per-subject" && subjectFilter
    ? qa.subjects.filter((s) => s.subject === subjectFilter)
    : qa.subjects;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div className="analysis-section">
        <div className="panel-title">大考整体难度 / 区分度</div>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <MetricLine label="难度系数 P" value={qa.overall.difficulty.toFixed(3)} />
          <DifficultyBadge value={qa.overall.difficulty} bands={bands?.difficulty} />
          <MetricLine label="区分度 D" value={qa.overall.discrimination.toFixed(3)} />
          <DiscriminationBadge value={qa.overall.discrimination} bands={bands?.discrimination} sampleSize={qa.overall.sampleSize} />
        </div>
      </div>

      {subjects.map((s) => (
        <div key={s.examId} className="analysis-section">
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <div className="panel-title" style={{ margin: 0 }}>{s.subject}（{s.examName}）</div>
            <span style={{ fontSize: 12, color: "var(--muted)" }}>满分 {s.fullScore} · 均分 {s.avgScore}</span>
            <DifficultyBadge value={s.difficulty} bands={bands?.difficulty} />
            <DiscriminationBadge value={s.discrimination} bands={bands?.discrimination} sampleSize={s.sampleSize} />
          </div>
          <div style={{ marginTop: 12 }}>
            <AnalysisQuestions
              questions={s.questions}
              bands={bands}
              onRowClick={(qn) => onDrill(s.examId, qn, s.fullScore)}
            />
          </div>
        </div>
      ))}
      {subjects.length === 0 && <div className="empty-text">该科目暂无题目数据。</div>}
    </div>
  );
}

function MetricLine({ label, value }: { label: string; value: string }) {
  return (
    <span style={{ fontSize: 13, color: "var(--muted)" }}>
      {label}：<strong style={{ color: "var(--text-primary)" }}>{value}</strong>
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
    return <div style={{ textAlign: "center", padding: 40, color: "var(--muted)" }}>加载中或暂无数据…</div>;
  }
  const subjects = viewMode === "per-subject" && subjectFilter
    ? cc.subjectClassSummaries.filter((x) => x.subject === subjectFilter)
    : cc.subjectClassSummaries;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* 班级统计总表 */}
      <div className="analysis-section" style={{ overflowX: "auto" }}>
        <div className="panel-title">班级统计</div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ background: "var(--bg-secondary)", borderBottom: "2px solid var(--border)" }}>
              <th style={thStyle}>班级</th><th style={thStyleR}>人数</th><th style={thStyleR}>均分</th>
              <th style={thStyleR}>中位</th><th style={thStyleR}>最高</th><th style={thStyleR}>最低</th>
              <th style={thStyleR}>标准差</th><th style={thStyleR}>及格率</th><th style={thStyleR}>优秀率</th>
            </tr>
          </thead>
          <tbody>
            {cc.classes.map((c) => (
              <tr key={c.classId} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={tdStyle}>{c.className}</td>
                <td style={tdStyleR}>{c.count}</td>
                <td style={{ ...tdStyleR, fontWeight: 600 }}>{c.avgScore}</td>
                <td style={tdStyleR}>{c.median}</td>
                <td style={tdStyleR}>{c.maxScore}</td>
                <td style={tdStyleR}>{c.minScore}</td>
                <td style={tdStyleR}>{c.stdDev}</td>
                <td style={tdStyleR}>{c.passRate}%</td>
                <td style={tdStyleR}>{c.excellentRate}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 逐科 × 班级 对比 */}
      {subjects.map((x) => (
        <div key={x.examId} className="analysis-section" style={{ overflowX: "auto" }}>
          <div className="panel-title">{x.subject} · 各班均分 / 得分率</div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ background: "var(--bg-secondary)", borderBottom: "2px solid var(--border)" }}>
                <th style={thStyle}>班级</th>
                <th style={thStyleR}>均分</th>
                <th style={thStyleR}>得分率</th>
              </tr>
            </thead>
            <tbody>
              {cc.classes.map((c) => {
                const bc = x.byClass.find((b) => b.classId === c.classId);
                return (
                  <tr key={c.classId} style={{ borderTop: "1px solid var(--border)" }}>
                    <td style={tdStyle}>{c.className}</td>
                    <td style={tdStyleR}>{bc ? bc.avgScore : "—"}</td>
                    <td style={tdStyleR}>{bc ? `${bc.scoreRate}%` : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}
      {subjects.length === 0 && <div className="empty-text">该科目暂无对比数据。</div>}
    </div>
  );
}

// Shared table styles
const thStyle: React.CSSProperties = {
  padding: "8px 10px", textAlign: "left", fontSize: 12, fontWeight: 600,
  color: "var(--muted)", borderBottom: "2px solid var(--border)"
};
const thStyleR: React.CSSProperties = { ...thStyle, textAlign: "right" };
const tdStyle: React.CSSProperties = { padding: "6px 10px", borderBottom: "1px solid var(--border)" };
const tdStyleR: React.CSSProperties = { ...tdStyle, textAlign: "right" };

const linkStyle: React.CSSProperties = {
  color: "var(--primary)", background: "none", border: "none",
  cursor: "pointer", fontSize: 13, textDecoration: "underline"
};
