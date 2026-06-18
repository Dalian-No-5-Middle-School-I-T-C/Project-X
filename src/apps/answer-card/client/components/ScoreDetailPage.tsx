import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, BarChart3, ClipboardList, Download, FileText, ListChecks } from "lucide-react";
import { fetchJson } from "../auth/api";
import type { ExamOverview, QuestionAnalysisItem, StudentRankingItem } from "../../../../shared/types";
import { AnalysisOverview } from "./AnalysisOverview";
import { AnalysisDistribution } from "./AnalysisDistribution";
import { AnalysisAiPanel } from "./AnalysisAiPanel";
import { AnalysisRanking } from "./AnalysisRanking";
import { AnalysisQuestions } from "./AnalysisQuestions";
import { ScoreTable } from "./ScoreTable";
import { ExportModal } from "./ExportModal";

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

type SubTab = "overview" | "scores" | "exam-analysis" | "ai" | "questions";

export function ScoreDetailPage({ examId, examName, subject, onBack }: Props) {
  const [subTab, setSubTab] = useState<SubTab>("overview");
  const [classId, setClassId] = useState("");
  const [showExport, setShowExport] = useState(false);
  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [overview, setOverview] = useState<ExamOverview | null>(null);
  const [ranking, setRanking] = useState<StudentRankingItem[]>([]);
  const [questions, setQuestions] = useState<QuestionAnalysisItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchJson<ClassOption[]>("/api/classes")
      .then(setClasses)
      .catch(() => setClasses([]));
  }, []);

  useEffect(() => {
    loadOverview();
    loadRanking();
    loadQuestions();
  }, [examId, classId]);

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
    } finally {
      setLoading(false);
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

  const subTabConfigs = useMemo(() => [
    { key: "overview" as SubTab, label: "概况", icon: FileText },
    { key: "scores" as SubTab, label: "成绩", icon: ListChecks },
    { key: "exam-analysis" as SubTab, label: "考试分析", icon: BarChart3 },
    { key: "ai" as SubTab, label: "AI分析", icon: ClipboardList },
    { key: "questions" as SubTab, label: "得分率", icon: ListChecks },
  ], []);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Header bar */}
      <div style={{
        display: "flex", alignItems: "center", gap: 12,
        padding: "12px 24px", borderBottom: "1px solid var(--line)",
        background: "#fff", flexShrink: 0
      }}>
        <button
          onClick={onBack}
          style={{
            display: "flex", alignItems: "center", gap: 4,
            padding: "6px 12px", border: "1px solid var(--line)", borderRadius: 8,
            background: "#fff", cursor: "pointer", fontSize: 13, color: "var(--text-primary)"
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

        {/* Class selector */}
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <label style={{ fontSize: 13, color: "var(--muted)", whiteSpace: "nowrap" }}>班级:</label>
          <select
            value={classId}
            onChange={(e) => { setClassId(e.target.value); setLoading(true); }}
            style={{
              padding: "6px 12px", borderRadius: 8, border: "1px solid var(--line-strong)",
              fontSize: 13, background: "#fff", cursor: "pointer", minWidth: 130
            }}
          >
            <option value="">全年级</option>
            {classes.map((c) => (
              <option key={c.id} value={String(c.id)}>
                {c.grade_name ? `${c.grade_name} / ${c.name}` : c.name}
              </option>
            ))}
            <option value="0">未知班级</option>
          </select>
        </div>

        <button
          onClick={() => setShowExport(true)}
          style={{
            display: "flex", alignItems: "center", gap: 4,
            padding: "6px 14px", border: "1px solid var(--brand)", borderRadius: 8,
            background: "var(--brand)", color: "#fff", cursor: "pointer",
            fontSize: 13, fontWeight: 500
          }}
        >
          <Download size={16} /> 导出
        </button>
      </div>

      {/* Sub-tab bar */}
      <div style={{
        display: "flex", gap: 0, borderBottom: "1px solid var(--line)",
        padding: "0 24px", flexShrink: 0, background: "#fff"
      }}>
        {subTabConfigs.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setSubTab(key)}
            style={{
              padding: "10px 20px", border: "none", background: "none", cursor: "pointer",
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
      </div>

      {/* Content area */}
      <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden" }}>
        {/* 概况 Tab */}
        {subTab === "overview" && (
          <div style={{ padding: 24 }}>
            {overview ? (
              <AnalysisOverview overview={overview} />
            ) : (
              <div style={{ textAlign: "center", padding: 40, color: "var(--muted)" }}>
                {loading ? "正在加载..." : "暂无数据"}
              </div>
            )}
          </div>
        )}

        {/* 成绩 Tab */}
        {subTab === "scores" && (
          <div style={{ padding: 24 }}>
            <ScoreTable examId={examId} classId={classId || undefined} />
          </div>
        )}

        {/* 考试分析 Tab */}
        {subTab === "exam-analysis" && (
          <div style={{ padding: 24 }}>
            {overview?.scoreSummary && overview?.overallScoreSummary && (
              <AnalysisDistribution
                summary={overview.scoreSummary}
                overallSummary={overview.overallScoreSummary}
                classSummaries={overview.classSummaries}
              />
            )}
          </div>
        )}

        {/* AI分析 Tab */}
        {subTab === "ai" && (
          <div style={{ padding: 24 }}>
            <AnalysisAiPanel examId={examId} />
          </div>
        )}

        {/* 得分率 Tab */}
        {subTab === "questions" && (
          <div style={{ padding: 24 }}>
            <AnalysisQuestions questions={questions} />
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
