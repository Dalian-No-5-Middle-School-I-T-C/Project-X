import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowLeft, BarChart3, ClipboardCheck, ClipboardList, Download, FileText } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { fetchJson } from "../auth/api";
import type { ExamOverview, PreviousExamComparison, QuestionAnalysisItem, StudentRankingItem, ScoreDisplayMode, ScoreTableRow } from "../../../../shared/types";
import { AnalysisOverview } from "./AnalysisOverview";
import { AnalysisDistribution } from "./AnalysisDistribution";
import { AnalysisAiPanel } from "./AnalysisAiPanel";
import { AnalysisQuestions } from "./AnalysisQuestions";
import { ScoreTable } from "./ScoreTable";
import { ExportModal } from "./ExportModal";
import { ScoreFixPage } from "./ScoreFixPage";
import { StudentScoreDetail } from "./StudentScoreDetail";
import { OnlineReviewPanel } from "./OnlineReviewPanel";
import { AnalysisTrend } from "./AnalysisTrend";

interface ClassOption {
  id: number;
  name: string;
  grade_name?: string;
}

interface Props {
  examId: number;
  examName: string;
  subject: string | null;
  onBack: () => void;
}

type SubTab = "overview" | "scores" | "exam-analysis" | "review" | "ai";

export function ScoreDetailPage({ examId, examName, subject, onBack }: Props) {
  const { user, isAdmin } = useAuth();
  const isTeacher = user?.role_name === "teacher" || isAdmin;
  const [subTab, setSubTab] = useState<SubTab>("overview");
  const [showFixPage, setShowFixPage] = useState(false);
  const [selectedStudent, setSelectedStudent] = useState<{ id: number; name: string; number: string } | null>(null);
  const [classId, setClassId] = useState("");
  const [showExport, setShowExport] = useState(false);
  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [overview, setOverview] = useState<ExamOverview | null>(null);
  const [ranking, setRanking] = useState<StudentRankingItem[]>([]);
  const [questions, setQuestions] = useState<QuestionAnalysisItem[]>([]);
  const [displayMode, setDisplayMode] = useState<ScoreDisplayMode>("zscore");
  const [scoreTableKey, setScoreTableKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [progressTop5, setProgressTop5] = useState<Array<{ studentName: string; studentNumber?: string; rankChange: number }>>([]);
  const [declineTop5, setDeclineTop5] = useState<Array<{ studentName: string; studentNumber?: string; rankChange: number }>>([]);
  const [previousComparison, setPreviousComparison] = useState<PreviousExamComparison | null>(null);
  const [comparisonClassId, setComparisonClassId] = useState("");

  useEffect(() => {
    fetchJson<ClassOption[]>("/api/classes")
      .then(setClasses)
      .catch(() => setClasses([]));

    fetchJson<{ scoreDisplayMode: ScoreDisplayMode }>("/api/users/me/settings")
      .then((s) => { if (s) setDisplayMode(s.scoreDisplayMode || "deviation"); })
      .catch(() => {});
  }, []);

  const refreshData = useCallback(() => {
    loadOverview();
    loadQuestions();
    loadRanking();
  }, [examId, classId]);

  useEffect(() => {
    loadOverview();
    loadQuestions();
    loadRanking();
    loadProgressRankings();
    loadPreviousComparison();
  }, [examId, classId]);

  // Refresh score table when display mode changes
  useEffect(() => {
    setScoreTableKey((k) => k + 1);
  }, [displayMode]);

  async function loadOverview() {
    try {
      const params = new URLSearchParams();
      if (classId) params.set("classId", classId);
      const data = await fetchJson<ExamOverview>(
        `/api/analysis/exams/${examId}/overview?${params.toString()}`
      );
      setOverview(data);
    } catch {
      setOverview(null);
    } finally {
      setLoading(false);
    }
  }

  async function loadRanking() {
    try {
      const params = new URLSearchParams();
      if (classId) params.set("classId", classId);
      const data = await fetchJson<StudentRankingItem[]>(
        `/api/analysis/exams/${examId}/students?${params.toString()}`
      );
      setRanking(data);
    } catch {
      setRanking([]);
    }
  }

  async function loadProgressRankings() {
    try {
      const params = new URLSearchParams();
      // Always fetch grade-level for progress comparison
      params.set("displayMode", "gradeRank");
      const data = await fetchJson<{ rows: ScoreTableRow[] }>(
        `/api/analysis/exams/${examId}/score-table?${params.toString()}`
      );
      const withChange = data.rows
        .filter((r) => r.rankChange != null)
        .sort((a, b) => (b.rankChange ?? 0) - (a.rankChange ?? 0));
      setProgressTop5(
        withChange.slice(0, 5).map((r) => ({
          studentName: r.studentName,
          studentNumber: r.studentNumber,
          rankChange: r.rankChange!
        }))
      );
      setDeclineTop5(
        withChange.slice(-5).reverse().map((r) => ({
          studentName: r.studentName,
          studentNumber: r.studentNumber,
          rankChange: r.rankChange!
        }))
      );
    } catch {
      setProgressTop5([]);
      setDeclineTop5([]);
    }
  }

  async function loadPreviousComparison() {
    try {
      const params = new URLSearchParams();
      if (classId) params.set("classId", classId);
      const data = await fetchJson<PreviousExamComparison>(
        `/api/analysis/exams/${examId}/previous?${params.toString()}`
      );
      setPreviousComparison(data);
    } catch {
      setPreviousComparison(null);
    }
  }

  async function loadQuestions() {
    try {
      const params = new URLSearchParams();
      if (classId) params.set("classId", classId);
      const data = await fetchJson<QuestionAnalysisItem[]>(
        `/api/analysis/exams/${examId}/questions?${params.toString()}`
      );
      setQuestions(data);
    } catch {
      setQuestions([]);
    }
  }

  const subTabConfigs = useMemo(() => {
    const tabs = [
      { key: "overview" as SubTab, label: "概况", icon: FileText },
      { key: "scores" as SubTab, label: "成绩", icon: FileText },
      { key: "exam-analysis" as SubTab, label: "考试分析", icon: BarChart3 },
    ];
    if (isTeacher) {
      tabs.push({ key: "review" as SubTab, label: "网上阅卷", icon: ClipboardCheck });
    }
    tabs.push({ key: "ai" as SubTab, label: "AI分析", icon: ClipboardList });
    return tabs;
  }, [isTeacher]);

  // Top/bottom 5 from ranking
  const top5 = useMemo(() => ranking.slice(0, 5), [ranking]);
  const bottom5 = useMemo(() => ranking.slice(-5).reverse(), [ranking]);

  // Render fix page overlay
  if (showFixPage) {
    return (
      <ScoreFixPage
        examId={examId}
        examName={examName}
        subject={subject}
        onBack={() => setShowFixPage(false)}
      />
    );
  }

  // Render student detail overlay
  if (selectedStudent) {
    return (
      <StudentScoreDetail
        examId={examId}
        studentId={selectedStudent.id}
        studentName={selectedStudent.name}
        studentNumber={selectedStudent.number}
        examName={examName}
        onBack={() => setSelectedStudent(null)}
      />
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Header bar */}
      <div style={{
        display: "flex", alignItems: "center", gap: 12,
        padding: "12px 24px", borderBottom: "1px solid var(--line)",
        background: "var(--surface)", flexShrink: 0
      }}>
        <button
          onClick={onBack}
          style={{
            display: "flex", alignItems: "center", gap: 4,
            padding: "6px 12px", border: "1px solid var(--line)", borderRadius: 8,
            background: "var(--surface)", cursor: "pointer", fontSize: 13, color: "var(--text-primary)"
          }}
        >
          <ArrowLeft size={16} /> 返回
        </button>

        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {examName}
          </h2>
          {subject && <span style={{ fontSize: 12, color: "var(--muted)" }}>{subject}</span>}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <select
            value={displayMode}
            onChange={(e) => {
              const mode = e.target.value as ScoreDisplayMode;
              setDisplayMode(mode);
              fetchJson("/api/users/me/settings", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ scoreDisplayMode: mode })
              }).catch(() => {});
            }}
            style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid var(--line-strong)", fontSize: 13, background: "var(--surface)", cursor: "pointer", height: 36, boxSizing: "border-box" }}
            title="成绩指标显示"
          >
            <option value="deviation">偏差值</option>
            <option value="zscore">Z值</option>
            <option value="percentile">百分位</option>
          </select>

          <label style={{ fontSize: 13, color: "var(--muted)", whiteSpace: "nowrap", lineHeight: "36px", display: "inline", margin: 0, fontWeight: 400 }}>班级:</label>
          <select
            value={classId}
            onChange={(e) => { setClassId(e.target.value); }}
            style={{
              padding: "6px 12px", borderRadius: 8, border: "1px solid var(--line-strong)",
              fontSize: 13, background: "var(--surface)", cursor: "pointer", minWidth: 130, height: 36, boxSizing: "border-box"
            }}
          >
            <option value="">全部班级</option>
            {/* Group classes by grade */}
            {(() => {
              const byGrade = new Map<string, ClassOption[]>();
              for (const c of classes) {
                const grade = c.grade_name || "无年级";
                if (!byGrade.has(grade)) byGrade.set(grade, []);
                byGrade.get(grade)!.push(c);
              }
              return Array.from(byGrade.entries()).map(([grade, clsList]) => (
                <optgroup key={grade} label={grade}>
                  {clsList.map((c) => (
                    <option key={c.id} value={String(c.id)}>{c.name}</option>
                  ))}
                </optgroup>
              ));
            })()}
          </select>

          <button
            onClick={() => setShowExport(true)}
            style={{
              display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap",
              padding: "6px 14px", border: "1px solid var(--brand)", borderRadius: 8,
              background: "var(--brand)", color: "#fff", cursor: "pointer",
              fontSize: 13, fontWeight: 500, height: 36, boxSizing: "border-box"
            }}
          >
            <Download size={16} /> 导出
          </button>
        </div>
      </div>

      {/* Sub-tab bar */}
      <div style={{
        display: "flex", gap: 0, borderBottom: "1px solid var(--line)",
        padding: "0 24px", flexShrink: 0, background: "var(--surface)", alignItems: "center"
      }}>
        {subTabConfigs.map(({ key, label, icon: Icon }, idx) => (
          <button
            key={key}
            onClick={() => setSubTab(key)}
            style={{
              padding: "10px 0", marginRight: idx < subTabConfigs.length - 1 ? 28 : 0,
              border: "none", background: "none", cursor: "pointer",
              fontSize: 14, color: subTab === key ? "var(--brand)" : "var(--muted)",
              borderBottom: subTab === key ? "2px solid var(--brand)" : "2px solid transparent",
              fontWeight: subTab === key ? 600 : 400,
              display: "flex", alignItems: "center", gap: 4
            }}
          >
            <Icon size={15} />
            {label}
          </button>
        ))}
        {isTeacher && (
          <button
            style={{
              marginLeft: "auto", padding: "4px 12px", border: "1px solid #E65100", borderRadius: 6,
              background: "transparent", color: "#E65100", fontSize: 12, cursor: "pointer",
              fontWeight: 500, display: "flex", alignItems: "center", gap: 4
            }}
            onClick={() => setShowFixPage(true)}
          >
            <AlertTriangle size={14} /> 分数有问题？
          </button>
        )}
      </div>

      {/* Content area */}
      <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden" }}>
        {/* 概况 Tab */}
        {subTab === "overview" && (
          <div style={{ padding: 24 }}>
            {overview ? (
              <AnalysisOverview
                overview={overview}
                ranking={ranking}
                selectedClassId={classId}
                onClassSelect={setClassId}
                previousComparison={previousComparison ?? undefined}
                progressTop5={progressTop5}
                declineTop5={declineTop5}
              />
            ) : (
              <div style={{ textAlign: "center", padding: 40, color: "var(--muted)" }}>
                {loading ? "正在加载..." : "暂无数据"}
              </div>
            )}
            {overview && subject && (
              <div style={{ marginTop: 24 }}>
                <AnalysisTrend exams={[{ subject }]} initialSubject={subject} initialClassId={classId || undefined} />
              </div>
            )}
          </div>
        )}

        {/* 成绩 Tab */}
        {subTab === "scores" && (
          <div style={{ padding: 24 }}>
            <ScoreTable key={scoreTableKey} examId={examId} classId={classId || undefined} displayMode={displayMode}
              onRowClick={(id, name, num) => setSelectedStudent({ id, name, number: num })} />
          </div>
        )}

        {/* 考试分析 Tab */}
        {subTab === "exam-analysis" && (
          <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 24 }}>
            {/* 成绩分布 */}
            {overview?.scoreSummary && overview?.overallScoreSummary && (
              <AnalysisDistribution
                summary={overview.scoreSummary}
                overallSummary={overview.overallScoreSummary}
                classSummaries={overview.classSummaries}
                selectedClassId={classId}
                onClassSelect={setClassId}
              />
            )}

            {/* 班级对比 */}
            {overview?.classSummaries && overview.classSummaries.length > 0 && (
              <div className="analysis-section">
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                  <div className="panel-title" style={{ margin: 0 }}>班级对比</div>
                  <select
                    value={comparisonClassId}
                    onChange={(e) => setComparisonClassId(e.target.value)}
                    style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid var(--line-strong)", fontSize: 12, background: "var(--surface)", cursor: "pointer" }}
                  >
                    <option value="">全部班级</option>
                    {(() => {
                      const allFlattened: Array<{ gradeName: string; className: string; classId: number }> = [];
                      for (const cs of overview.classSummaries) {
                        allFlattened.push({ gradeName: cs.gradeName || "无年级", className: cs.className, classId: cs.classId });
                      }
                      return allFlattened.map((c) => (
                        <option key={c.classId} value={String(c.classId)}>
                          {c.gradeName} — {c.className}
                        </option>
                      ));
                    })()}
                  </select>
                </div>
                {(() => {
                  // Group class summaries by grade
                  const byGrade = new Map<string, typeof overview.classSummaries>();
                  for (const cs of overview.classSummaries) {
                    const grade = cs.gradeName || "无年级";
                    if (!byGrade.has(grade)) byGrade.set(grade, []);
                    byGrade.get(grade)!.push(cs);
                  }

                  // Compute baseline stats for comparison
                  const compId = comparisonClassId ? Number(comparisonClassId) : 0;
                  const baseline = compId > 0 ? overview.classSummaries.find((cs) => cs.classId === compId) : null;

                  return Array.from(byGrade.entries()).map(([grade, classList]) => (
                    <div key={grade} style={{ marginBottom: 12 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--brand)", marginBottom: 6, padding: "0 4px" }}>{grade}</div>
                      <div style={{ overflowX: "auto" }}>
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, border: "1px solid var(--line)", borderRadius: 8, background: "var(--surface)" }}>
                          <thead>
                            <tr style={{ background: "var(--surface-tint)", borderBottom: "2px solid var(--line)" }}>
                              <th style={thS}>班级</th>
                              <th style={thS}>人数</th>
                              <th style={thS}>均分</th>
                              {baseline && <th style={thS}>vs {baseline.className}</th>}
                              <th style={thS}>最高</th>
                              <th style={thS}>最低</th>
                              <th style={thS}>中位</th>
                            </tr>
                          </thead>
                          <tbody>
                            {classList.map((cs, i) => {
                              const isBaseline = baseline && cs.classId === baseline.classId;
                              const avgDiff = baseline ? Math.round((cs.summary.avg - baseline.summary.avg) * 10) / 10 : null;
                              return (
                                <tr
                                  key={cs.classId}
                                  style={{
                                    borderTop: i > 0 ? "1px solid var(--line-light)" : "none",
                                    background: isBaseline ? "var(--brand-soft)" : i % 2 === 0 ? "var(--surface)" : "var(--bg-soft)"
                                  }}
                                >
                                  <td style={{ ...tdS, fontWeight: isBaseline ? 600 : 400 }}>{cs.className}{isBaseline ? " ·基准" : ""}</td>
                                  <td style={tdS}>{cs.summary.count}</td>
                                  <td style={{ ...tdS, fontWeight: isBaseline ? 600 : 400 }}>{cs.summary.avg}</td>
                                  {baseline && (
                                    <td style={{
                                      ...tdS,
                                      fontWeight: 500,
                                      color: avgDiff == null || avgDiff === 0 ? "var(--muted)" : avgDiff > 0 ? "#3B6D11" : "#A32D2D"
                                    }}>
                                      {isBaseline ? "—" : avgDiff != null ? (avgDiff > 0 ? `↑+${avgDiff}` : `↓${avgDiff}`) : "—"}
                                    </td>
                                  )}
                                  <td style={tdS}>{cs.summary.max}</td>
                                  <td style={tdS}>{cs.summary.min}</td>
                                  <td style={tdS}>{cs.summary.median}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ));
                })()}
              </div>
            )}

            {/* 前五 / 后五 */}
            {ranking.length > 0 && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                <div className="analysis-section">
                  <div className="panel-title">年级前五</div>
                  {top5.map((r, i) => (
                    <div key={r.studentName} style={{ display: "flex", gap: 12, padding: "4px 0", fontSize: 13 }}>
                      <span style={{ fontWeight: 600, color: "var(--brand)", minWidth: 24 }}>#{r.rank}</span>
                      <span>{r.studentName}</span>
                      <span style={{ color: "var(--muted)", fontSize: 12 }}>{r.studentNumber}</span>
                      <span style={{ marginLeft: "auto", fontWeight: 500 }}>{r.totalScore}</span>
                    </div>
                  ))}
                </div>
                <div className="analysis-section">
                  <div className="panel-title">年级后五</div>
                  {bottom5.map((r, i) => (
                    <div key={r.studentName} style={{ display: "flex", gap: 12, padding: "4px 0", fontSize: 13 }}>
                      <span style={{ fontWeight: 600, color: "#A32D2D", minWidth: 24 }}>#{r.rank}</span>
                      <span>{r.studentName}</span>
                      <span style={{ color: "var(--muted)", fontSize: 12 }}>{r.studentNumber}</span>
                      <span style={{ marginLeft: "auto", fontWeight: 500 }}>{r.totalScore}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 题目得分率 */}
            <div className="analysis-section">
              <div className="panel-title">题目得分率</div>
              <AnalysisQuestions questions={questions} />
            </div>

            {/* 预留：知识点分析 */}
            <div className="analysis-section" style={{ padding: 24, textAlign: "center", color: "var(--muted)", background: "var(--bg-soft)", borderRadius: 10, border: "1px dashed var(--line-strong)", fontSize: 13 }}>
              知识点分析模块预留 — 未来将展示每道题对应的知识点、得分率与薄弱环节
            </div>
          </div>
        )}

        {/* 网上阅卷 Tab */}
        {subTab === "review" && isTeacher && (
          <div style={{ padding: 24, height: "100%" }}>
            <OnlineReviewPanel examId={examId} examName={examName} classId={classId || undefined} />
          </div>
        )}

        {/* AI分析 Tab */}
        {subTab === "ai" && (
          <div style={{ padding: 24 }}>
            <AnalysisAiPanel examId={examId} />
          </div>
        )}
      </div>

      {showExport && (
        <ExportModal
          examId={examId}
          examName={examName}
          classId={classId || undefined}
          onClose={() => setShowExport(false)}
        />
      )}
    </div>
  );
}

const thS: React.CSSProperties = { padding: "8px 12px", textAlign: "left", fontSize: 12, fontWeight: 600, color: "var(--text-secondary)" };
const tdS: React.CSSProperties = { padding: "6px 12px", fontSize: 13 };
