import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, AlertTriangle, ArrowLeft, BarChart3, CheckCircle2, ClipboardList, Download, FileText, Settings, Star, Trophy, TrendingUp, TrendingDown, Users } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { fetchJson } from "../auth/api";
import { formatScore, formatPercent, formatChange } from "../util/format";
import type { ExamOverview, ExamMetrics, PreviousExamComparison, QuestionAnalysisItem, StudentRankingItem, ScoreDisplayMode, ScoreTableRow, AnalysisThresholds, KnowledgeWeaknessItem } from "../../../../shared/types";
import { AnalysisOverview } from "./AnalysisOverview";
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

interface ClassOption { id: number; name: string; grade_name?: string; }

interface Props { examId: number; examName: string; subject: string | null; onBack: () => void; }

type SubTab = "overview" | "scores" | "question-analysis" | "class-compare" | "overall" | "ai";

// ── Inline KPI stat card ──────────────────────────────
function StatCard({ label, value, sub, trend, color, info }: {
  label: string; value: string; sub?: string; trend?: "up" | "down" | "flat"; color?: string; info?: string
}) {
  const trendIcon = trend === "up" ? <TrendingUp size={14} /> : trend === "down" ? <TrendingDown size={14} /> : null;
  const trendColor = trend === "up" ? "var(--success)" : trend === "down" ? "#A32D2D" : "var(--muted)";
  return (
    <div className="analysis-card" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <div style={{ fontSize: 12, color: "var(--muted)", display: "flex", alignItems: "center", gap: 4 }}>
        {label}
        {info && <span title={info} style={{ cursor: "help", fontSize: 11 }}>ⓘ</span>}
      </div>
      <div style={{ fontSize: 24, fontWeight: 700, color: color ?? "var(--text-primary)", lineHeight: 1.1 }}>
        {value}
        {sub && <span style={{ fontSize: 13, fontWeight: 400, color: "var(--muted)", marginLeft: 6 }}>{sub}</span>}
      </div>
      {trend && (
        <div style={{ fontSize: 12, color: trendColor, display: "flex", alignItems: "center", gap: 2, marginTop: 2 }}>
          {trendIcon} {trend === "flat" ? "—" : ""}
        </div>
      )}
    </div>
  );
}

// ── Threshold settings modal (admin only) ──────────────
function ThresholdSettingsModal({ onClose }: { onClose: () => void }) {
  const [t, setT] = useState<AnalysisThresholds | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    fetchJson<AnalysisThresholds>("/api/analysis/config/thresholds")
      .then(setT)
      .catch(() => setMsg("加载失败"));
  }, []);

  async function save() {
    if (!t) return;
    setSaving(true);
    try {
      const res = await (await fetchJson<{ ok?: boolean; data?: AnalysisThresholds; message?: string }>("/api/analysis/config/thresholds", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passRate: t.passRate, excellentRate: t.excellentRate, segmentSize: t.segmentSize, errorTiers: t.errorTiers.join(",") })
      }));
      if ((res as any).ok || (res as any).data) {
        setMsg("已保存，刷新页面后生效"); setTimeout(onClose, 1500);
      } else {
        setMsg((res as any).message ?? "保存失败");
      }
    } catch (e: any) { setMsg(e.message); }
    finally { setSaving(false); }
  }

  if (!t) return <div style={{ textAlign: "center", padding: 40 }}>加载中...</div>;
  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-card" style={{ maxWidth: 400 }}>
        <div className="modal-header"><h3>成绩分析阈值设置</h3><button onClick={onClose} className="ghost-button" style={{ padding: "4px 8px" }}>&#x2715;</button></div>
        {[
          ["passRate", "及格线比例", "0-1", t.passRate],
          ["excellentRate", "优秀线比例", "0-1", t.excellentRate],
          ["segmentSize", "分数段粒度", "1-100 分", t.segmentSize],
          ["errorTiers", "错误率档位", "高,中,低 %", t.errorTiers.join(",")],
        ].map(([key, label, hint, val]) => (
          <div key={key} style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 13, display: "block", marginBottom: 3 }}>{label} <span style={{ color: "var(--muted)", fontSize: 11 }}>({hint})</span></label>
            <input className="text-input" value={String(val)} onChange={(e) => {
              const v = e.target.value;
              setT((prev) => {
                if (!prev) return prev;
                if (key === "errorTiers") return { ...prev, errorTiers: v.split(",").map(Number) as [number, number, number] };
                return { ...prev, [key]: Number(v) } as AnalysisThresholds;
              });
            }} style={{ width: "100%", boxSizing: "border-box" }} />
          </div>
        ))}
        <button className="primary-button" onClick={save} disabled={saving} style={{ width: "100%" }}>
          {saving ? "保存中..." : "保存"}
        </button>
        {msg && <div style={{ fontSize: 12, marginTop: 8, color: "var(--muted)", textAlign: "center" }}>{msg}</div>}
      </div>
    </div>
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
  const [comparisonClassId, setComparisonClassId] = useState("");
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
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* ── Header bar ── */}
      <div className="analysis-header-bar" style={{
        display: "flex", alignItems: "center", gap: 12, padding: "12px 24px",
        borderBottom: "1px solid var(--line)", background: "var(--surface)", flexShrink: 0
      }}>
        <button onClick={onBack} className="ghost-button" style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <ArrowLeft size={16} /> 返回
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{examName}</h2>
          {subject && <span style={{ fontSize: 12, color: "var(--muted)" }}>{subject}</span>}
        </div>
        <select value={displayMode} onChange={(e) => { const m = e.target.value as ScoreDisplayMode; setDisplayMode(m); fetchJson("/api/users/me/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scoreDisplayMode: m }) }).catch(() => {}); }}
          style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid var(--line-strong)", fontSize: 13, background: "var(--surface)", height: 36, boxSizing: "border-box", cursor: "pointer" }} title="成绩指标显示">
          <option value="deviation">偏差值</option><option value="zscore">Z值</option><option value="percentile">百分位</option>
        </select>
        <label style={{ fontSize: 13, color: "var(--muted)", whiteSpace: "nowrap" }}>班级:</label>
        <select value={classId} onChange={(e) => setClassId(e.target.value)} style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid var(--line-strong)", background: "var(--surface)", minWidth: 130, height: 36, boxSizing: "border-box", cursor: "pointer" }}>
          <option value="">全部班级</option>
          {(() => { const bg = new Map<string, ClassOption[]>(); for (const c of classes) { const g = c.grade_name || "无年级"; if (!bg.has(g)) bg.set(g, []); bg.get(g)!.push(c); } return Array.from(bg.entries()).map(([g, cl]) => (
            <optgroup key={g} label={g}>{cl.map((c) => <option key={c.id} value={String(c.id)}>{c.name}</option>)}</optgroup>
          )); })()}
        </select>
        <button onClick={() => setShowExport(true)} className="primary-button" style={{ display: "flex", alignItems: "center", gap: 4, height: 36, boxSizing: "border-box" }}>
          <Download size={16} /> 导出
        </button>
        {isAdmin && (
          <button onClick={() => setShowThresholdSettings(true)} className="ghost-button" title="分析阈值设置" style={{ padding: 6, borderRadius: 8 }}>
            <Settings size={16} />
          </button>
        )}
      </div>

      {/* ── Sub-tab bar ── */}
      <div style={{ display: "flex", gap: 0, borderBottom: "1px solid var(--line)", padding: "0 24px", flexShrink: 0, background: "var(--surface)", alignItems: "center" }}>
        {subTabConfigs.map(({ key, label, icon: Icon }, idx) => (
          <button key={key} onClick={() => setSubTab(key)} style={{
            padding: "10px 0", marginRight: idx < subTabConfigs.length - 1 ? 20 : 0,
            border: "none", background: "none", cursor: "pointer", fontSize: 14,
            color: subTab === key ? "var(--brand)" : "var(--muted)",
            borderBottom: subTab === key ? "2px solid var(--brand)" : "2px solid transparent",
            fontWeight: subTab === key ? 600 : 400, display: "flex", alignItems: "center", gap: 4
          }}>
            <Icon size={15} />{label}
          </button>
        ))}
        {isTeacher && (
          <button onClick={() => setShowFixPage(true)} style={{
            marginLeft: "auto", padding: "4px 12px", border: "1px solid #E65100", borderRadius: 6,
            background: "transparent", color: "#E65100", fontSize: 12, cursor: "pointer", fontWeight: 500
          }}>分数有问题？</button>
        )}
      </div>

      {/* ── Content area ── */}
      <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden" }}>
        {/* ====== 概况 Tab ====== */}
        {subTab === "overview" && (overview ? (
          <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 20 }}>
            {/* KPI 指标卡 */}
            <div className="analysis-cards" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
              <StatCard label="均分" value={formatScore(overview.avgScore)}
                sub="分" info={`满分计算：${overview.overallScoreSummary?.max ?? "—"} 分`} />
              <StatCard label="及格率" value={formatPercent(overview.passRate)}
                info={`及格线 ${formatScore(overview.passScore)} 分`}
                trend={previousComparison?.passRateChange != null ? (previousComparison.passRateChange > 0 ? "up" : previousComparison.passRateChange < 0 ? "down" : "flat") : undefined}
                color="var(--success)" />
              <StatCard label="优秀率" value={formatPercent(overview.excellentRate)}
                info={`优秀线 ${formatScore(overview.excellentScore)} 分`} color="var(--brand)" />
              <StatCard label="标准差" value={formatScore(overview.stdDev)}
                sub="分" info="越大越分散" />
              {/* 参考人数 + 较上届变化 */}
              <StatCard label="参考人数" value={String(overview.gradedCount)} />
              {previousComparison?.prevExamName && (
                <StatCard label="较上届均分变化" value={formatChange(previousComparison.avgScoreChange, " 分")}
                  trend={previousComparison.avgScoreChange != null ? (previousComparison.avgScoreChange > 0 ? "up" : previousComparison.avgScoreChange < 0 ? "down" : "flat") : "flat"} />
              )}
              {previousComparison?.prevExamName && (
                <StatCard label="较上届及格率变化" value={formatChange(previousComparison.passRateChange, "%")}
                  trend={previousComparison.passRateChange != null ? (previousComparison.passRateChange > 0 ? "up" : previousComparison.passRateChange < 0 ? "down" : "flat") : "flat"} />
              )}
              {/* 最高/最低 */}
              <StatCard label="最高分" value={formatScore(overview.maxScore)} />
              <StatCard label="最低分" value={formatScore(overview.minScore)} />
            </div>

            {/* 难度系数 / 区分度 卡 */}
            {metrics && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12 }}>
                <div className="analysis-card" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <div style={{ fontSize: 12, color: "var(--muted)" }}>难度系数 P（平均得分 / 满分）</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 22, fontWeight: 700 }}>{metrics.difficulty.toFixed(3)}</span>
                    <DifficultyBadge value={metrics.difficulty} bands={bands?.difficulty} />
                  </div>
                </div>
                <div className="analysis-card" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <div style={{ fontSize: 12, color: "var(--muted)" }}>区分度 D（高分组得分率 − 低分组得分率）</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 22, fontWeight: 700 }}>{metrics.discrimination.toFixed(3)}</span>
                    <DiscriminationBadge value={metrics.discrimination} bands={bands?.discrimination} />
                  </div>
                </div>
              </div>
            )}

            {/* 分数段柱状图 + 班级箱线图 */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              {overview.distribution.length > 0 && (
                <div className="analysis-section">
                  <div className="panel-title">分数段分布</div>
                  <DistributionBar data={{ labels: overview.distribution.map((d) => d.range), values: overview.distribution.map((d) => d.count) }} height={220} />
                </div>
              )}
              {overview.scoreSummary && overview.overallScoreSummary && (
                <div className="analysis-section">
                  <div className="panel-title">班级箱线图</div>
                  <AnalysisDistribution summary={overview.scoreSummary} overallSummary={overview.overallScoreSummary}
                    classSummaries={overview.classSummaries} selectedClassId={classId} onClassSelect={setClassId} />
                </div>
              )}
            </div>

            {/* 前五 / 后五 / 进步Top5 / 退步Top5 */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              <div className="analysis-section">
                <div className="panel-title"><Trophy size={14} /> 年级前五</div>
                {top5.map((r) => (
                  <div key={r.studentName} style={{ display: "flex", gap: 8, padding: "3px 0", fontSize: 13 }}>
                    <span style={{ fontWeight: 600, color: "var(--brand)", minWidth: 24 }}>#{r.rank}</span>
                    <span>{r.studentName}</span>
                    <span style={{ color: "var(--muted)", fontSize: 12 }}>{r.studentNumber}</span>
                    <span style={{ marginLeft: "auto", fontWeight: 500 }}>{formatScore(r.totalScore)}</span>
                  </div>
                ))}
              </div>
              <div className="analysis-section">
                <div className="panel-title" style={{ color: "#A32D2D" }}>年级后五</div>
                {bottom5.map((r) => (
                  <div key={r.studentName} style={{ display: "flex", gap: 8, padding: "3px 0", fontSize: 13 }}>
                    <span style={{ fontWeight: 600, color: "#A32D2D", minWidth: 24 }}>#{r.rank}</span>
                    <span>{r.studentName}</span>
                    <span style={{ marginLeft: "auto", fontWeight: 500 }}>{formatScore(r.totalScore)}</span>
                  </div>
                ))}
              </div>
              <div className="analysis-section">
                <div className="panel-title"><TrendingUp size={14} color="var(--success)" /> 进步最大</div>
                {progressTop5.map((r, i) => (
                  <div key={i} style={{ display: "flex", gap: 8, padding: "3px 0", fontSize: 13 }}>
                    <span style={{ fontWeight: 600, color: "var(--success)", minWidth: 28 }}>↑{r.rankChange}</span>
                    <span>{r.studentName}</span>
                  </div>
                ))}
              </div>
              <div className="analysis-section">
                <div className="panel-title"><TrendingDown size={14} color="#A32D2D" /> 退步最大</div>
                {declineTop5.map((r, i) => (
                  <div key={i} style={{ display: "flex", gap: 8, padding: "3px 0", fontSize: 13 }}>
                    <span style={{ fontWeight: 600, color: "#A32D2D", minWidth: 28 }}>↓{Math.abs(r.rankChange)}</span>
                    <span>{r.studentName}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* 临界生名单 */}
            {criticalList.length > 0 && (
              <div className="analysis-section">
                <div className="panel-title">临界生（及格/优秀线 ±{Math.round(overview.passScore * 0.05)} 分）</div>
                {criticalList.map((r) => (
                  <div key={r.studentName} style={{ display: "flex", gap: 8, padding: "3px 0", fontSize: 13, color: r.totalScore >= overview.passScore ? "var(--success)" : "var(--warning)" }}>
                    <span style={{ minWidth: 24, fontWeight: 600 }} aria-label={r.totalScore >= overview.excellentScore ? "优秀" : r.totalScore >= overview.passScore ? "达标" : "待提升"}>
                      {r.totalScore >= overview.excellentScore ? <Star size={15} aria-hidden="true" /> : r.totalScore >= overview.passScore ? <CheckCircle2 size={15} aria-hidden="true" /> : <AlertTriangle size={15} aria-hidden="true" />}
                    </span>
                    <span>{r.studentName}</span>
                    <span style={{ marginLeft: "auto", fontWeight: 500 }}>{formatScore(r.totalScore)}</span>
                  </div>
                ))}
              </div>
            )}

            {/* 趋势图 */}
            {subject && (
              <AnalysisTrend exams={[{ subject }]} initialSubject={subject} initialClassId={classId || undefined} />
            )}
          </div>
        ) : (
          <div style={{ textAlign: "center", padding: 40, color: "var(--muted)" }}>{loading ? "正在加载..." : "暂无数据"}</div>
        ))}

        {/* ====== 成绩 Tab ====== */}
        {subTab === "scores" && (
          <div style={{ padding: 24 }}>
            <ScoreTable key={scoreTableKey} examId={examId} classId={classId || undefined} displayMode={displayMode}
              onRowClick={(id, name, num) => setSelectedStudent({ id, name, number: num })} />
          </div>
        )}

        {/* ====== 题目分析 Tab ====== */}
        {subTab === "question-analysis" && (
          <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 20 }}>
            {/* 题目得分率表 */}
            <div className="analysis-section">
              <div className="panel-title">逐题得分率</div>
              <AnalysisQuestions
                questions={questions}
                bands={bands ?? undefined}
                onRowClick={(qn) => setDrillQuestion(qn)}
              />
            </div>

            {/* 知识点弱点（接通后端） */}
            <KnowledgePanel examId={examId} classId={classId || undefined} />

          </div>
        )}

        {/* ====== 班级对比 Tab ====== */}
        {subTab === "class-compare" && (
          <ClassComparePanel examId={examId} classes={classes} />
        )}

        {/* ====== 总体分析 Tab ====== */}
        {subTab === "overall" && (
          <AnalysisOverall kind="exam" examId={examId} bands={bands ?? undefined} />
        )}

        {/* ====== AI分析 Tab ====== */}
        {subTab === "ai" && (
          <div style={{ padding: 24 }}>
            <AnalysisAiPanel examId={examId} />
          </div>
        )}
      </div>

      {/* Modals */}
      {showExport && <ExportModal examId={examId} examName={examName} classId={classId || undefined} onClose={() => setShowExport(false)} />}
      {showThresholdSettings && <ThresholdSettingsModal onClose={() => setShowThresholdSettings(false)} />}
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

// ── 知识点分析面板（P0-4 轻量版 + 分层着色）─────
function KnowledgePanel({ examId, classId }: { examId: number; classId: string | undefined }) {
  const [items, setItems] = useState<KnowledgeWeaknessItem[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (classId) params.set("classId", classId);
    fetchJson<KnowledgeWeaknessItem[]>(`/api/analysis/knowledge-points/${examId}?${params.toString()}`)
      .then((d) => setItems(Array.isArray(d) ? d : []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [examId, classId]);

  if (loading) return <div className="analysis-section" style={{ textAlign: "center", padding: 16, color: "var(--muted)" }}>加载知识点分析...</div>;
  if (items.length === 0) return <div className="analysis-section" style={{ textAlign: "center", padding: 16, color: "var(--muted)", border: "1px dashed var(--line-strong)", borderRadius: 10, background: "var(--bg-soft)" }}>暂无知识点数据 — 请先在答题卡设计页为题目标注知识点</div>;

  const severityColor = (s: string) => s === "common_weak" ? "#A32D2D" : s === "weak" ? "#E65100" : "var(--success)";

  return (
    <div className="analysis-section">
      <div className="panel-title">知识点薄弱环节</div>
      <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 8 }}>
        <span className="knowledge-legend"><span className="knowledge-legend-item"><span className="knowledge-legend-dot common" />共性薄弱（得分率低于及格线且覆盖人数广）</span><span className="knowledge-legend-item"><span className="knowledge-legend-dot weak" />一般薄弱</span><span className="knowledge-legend-item"><span className="knowledge-legend-dot ok" />达标</span><span>｜按严重度排序</span></span>
      </div>
      {items.map((kp, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderBottom: "1px solid var(--line-light)", fontSize: 13 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: severityColor(kp.severity), flexShrink: 0 }} />
          <span style={{ flex: 1, minWidth: 0 }}>{kp.point_text}</span>
          <span style={{ fontSize: 11, color: "var(--muted)" }}>题{kp.question_numbers}</span>
          <span style={{ fontWeight: 600, color: severityColor(kp.severity), minWidth: 42, textAlign: "right" }}>{formatPercent(kp.avg_rate)}</span>
          <span style={{ fontSize: 11, color: "var(--muted)", minWidth: 48, textAlign: "right" }}>
            {kp.coverage_rate > 0 ? `${kp.coverage_rate}% 学生` : ""}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── 班级对比面板 ──────────────────────────────────────
function ClassComparePanel({ examId, classes }: { examId: number; classes: ClassOption[] }) {
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [comparison, setComparison] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  function toggleClass(id: number) {
    setSelectedIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : prev.length < 8 ? [...prev, id] : prev);
  }

  useEffect(() => {
    if (selectedIds.length < 2) { setComparison(null); setError(""); return; }
    setLoading(true); setError("");
    const params = new URLSearchParams();
    params.set("classIds", selectedIds.join(","));
    params.set("includeOptions", "1");
    fetchJson<any>(`/api/analysis/exams/${examId}/class-comparison?${params.toString()}`)
      .then((d) => setComparison(d))
      .catch((e) => setError(e.message ?? "加载失败"))
      .finally(() => setLoading(false));
  }, [selectedIds.join(","), examId]);

  // Group classes by grade for chip display
  const grouped = useMemo(() => {
    const m = new Map<string, ClassOption[]>();
    for (const c of classes) { const g = c.grade_name || "无年级"; if (!m.has(g)) m.set(g, []); m.get(g)!.push(c); }
    return m;
  }, [classes]);

  return (
    <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="panel-title">勾选班级进行对比（2–8 个）</div>
      {Array.from(grouped.entries()).map(([grade, clsList]) => (
        <div key={grade}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)", marginBottom: 4 }}>{grade}</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {clsList.map((c) => {
              const active = selectedIds.includes(c.id);
              return (
                <button key={c.id} onClick={() => toggleClass(c.id)}
                  style={{
                    padding: "4px 12px", borderRadius: 16, fontSize: 12, cursor: "pointer", border: "1.5px solid",
                    borderColor: active ? "var(--brand)" : "var(--line-strong)",
                    background: active ? "var(--brand-soft)" : "var(--surface)",
                    color: active ? "var(--brand)" : "var(--text-secondary)", fontWeight: active ? 600 : 400,
                  }}>
                  {c.name}
                </button>
              );
            })}
          </div>
        </div>
      ))}

      {error && <div style={{ color: "#A32D2D", fontSize: 13 }}>{error}</div>}
      {loading && <div style={{ textAlign: "center", padding: 20, color: "var(--muted)" }}>加载中...</div>}

      {comparison && (
        <>
          {/* ① 总分对比统计表 */}
          <div className="analysis-section" style={{ overflowX: "auto" }}>
            <div className="panel-title">总分统计</div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ background: "var(--bg-soft)", borderBottom: "2px solid var(--line)" }}>
                  <th style={thCompact}>班级</th><th style={thCompact}>人数</th><th style={thCompact}>均分</th>
                  <th style={thCompact}>中位</th><th style={thCompact}>最高</th><th style={thCompact}>最低</th>
                  <th style={thCompact}>标准差</th><th style={thCompact}>及格率</th><th style={thCompact}>优秀率</th>
                </tr>
              </thead>
              <tbody>
                {comparison.classes.map((c: any, i: number) => (
                  <tr key={c.classId} style={{ background: i % 2 === 0 ? "var(--surface)" : "var(--bg-soft)" }}>
                    <td style={tdCompact}>{c.className}</td><td style={tdCompact}>{c.count}</td>
                    <td style={{ ...tdCompact, fontWeight: 600 }}>{formatScore(c.avgScore)}</td>
                    <td style={tdCompact}>{formatScore(c.median)}</td><td style={tdCompact}>{formatScore(c.maxScore)}</td>
                    <td style={tdCompact}>{formatScore(c.minScore)}</td><td style={tdCompact}>{formatScore(c.stdDev)}</td>
                    <td style={tdCompact}>{formatPercent(c.passRate)}</td><td style={tdCompact}>{formatPercent(c.excellentRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* ② 分段分布对比柱状图 */}
          {comparison.classes.length > 0 && comparison.classes[0].distribution && (
            <div className="analysis-section">
              <div className="panel-title">分数段分布对比</div>
              <ClassDistributionBar
                labels={comparison.classes[0].distribution.map((d: any) => d.range)}
                classes={comparison.classes.map((c: any) => ({ className: c.className }))}
                matrix={comparison.classes[0].distribution.map((_: any, gi: number) =>
                  comparison.classes.map((c: any) => c.distribution[gi]?.count ?? 0)
                )}
                height={260}
              />
            </div>
          )}

          {/* ③ 逐题得分率热力表 */}
          {comparison.questionStats && comparison.questionStats.length > 0 && (
            <div className="analysis-section" style={{ overflowX: "auto" }}>
              <div className="panel-title">逐题得分率</div>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                <thead>
                  <tr style={{ background: "var(--bg-soft)", borderBottom: "2px solid var(--line)" }}>
                    <th style={thCompact}>题号</th>
                    {comparison.classes.map((c: any) => (
                      <th key={c.classId} style={thCompact}>{c.className}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {comparison.questionStats.map((q: any) => (
                    <tr key={q.questionNumber}>
                      <td style={tdCompact}>{q.questionNumber}</td>
                      {comparison.classes.map((c: any) => {
                        const bc = q.byClass.find((b: any) => b.classId === c.classId);
                        const rate = bc?.scoreRate ?? 0;
                        const alpha = rate / 100;
                        return (
                          <td key={c.classId} style={{ ...tdCompact, textAlign: "center", background: `rgba(192,15,40,${alpha * 0.3})`, fontWeight: 500 }}>
                            {formatPercent(rate)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const thCompact: React.CSSProperties = { padding: "6px 8px", textAlign: "left", fontSize: 11, fontWeight: 600, color: "var(--text-secondary)", whiteSpace: "nowrap" };
const tdCompact: React.CSSProperties = { padding: "4px 8px", fontSize: 12, whiteSpace: "nowrap" };
