import { useEffect, useState } from "react";
import { ArrowLeft, Download, FileText } from "lucide-react";
import { fetchJson } from "../auth/api";
import { useAuth } from "../auth/AuthContext";
import type { GroupOverview, GroupRankingRow, GroupRankingResponse, GroupSubjectSummary } from "../../../../shared/types";

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

type SubTab = "overview" | "scores";

export function ExamGroupDetailPage({ groupId, onBack, onExport }: Props) {
  const { user } = useAuth();
  const isTeacher = user?.role_name === "teacher" || user?.role_name === "管理员" || user?.role_name === "admin";
  const [subTab, setSubTab] = useState<SubTab>("overview");
  const [overview, setOverview] = useState<GroupOverview | null>(null);
  const [rankings, setRankings] = useState<GroupRankingResponse | null>(null);
  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [classId, setClassId] = useState("");
  const [fullOnly, setFullOnly] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchJson<ClassOption[]>("/api/classes")
      .then(setClasses)
      .catch(() => setClasses([]));
  }, []);

  useEffect(() => {
    loadOverview();
    loadRankings();
  }, [groupId, fullOnly, classId]);

  async function loadOverview() {
    setLoading(true);
    try {
      const data = await fetchJson<GroupOverview>(`/api/exam-groups/${groupId}/overview`);
      setOverview(data);
    } catch { setOverview(null); }
    finally { setLoading(false); }
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

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", gap: 12,
        padding: "14px 20px", borderBottom: "1px solid var(--border)",
        flexShrink: 0
      }}>
        <button onClick={onBack} style={{
          background: "none", border: "none", cursor: "pointer",
          padding: 4, borderRadius: 6, color: "var(--muted)"
        }}><ArrowLeft size={18} /></button>
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{overview.groupName}</h2>
          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>
            {overview.subjects.length} 科 · {overview.totalParticipants} 人参加 · {overview.fullParticipants} 人全科
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
        borderBottom: "1px solid var(--border)", flexShrink: 0
      }}>
        {(["overview", "scores"] as SubTab[]).map((tab) => (
          <button key={tab} onClick={() => setSubTab(tab)} style={{
            background: "none", border: "none",
            borderBottom: subTab === tab ? "2px solid var(--primary)" : "2px solid transparent",
            padding: "10px 16px", fontSize: 13, cursor: "pointer",
            color: subTab === tab ? "var(--primary)" : "var(--muted)",
            fontWeight: subTab === tab ? 600 : 400
          }}>
            {tab === "overview" ? "概览" : "成绩"}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: "auto", padding: "16px 20px" }}>
        {subTab === "overview" && <OverviewTab overview={overview} />}
        {subTab === "scores" && <ScoresTab rankings={rankings} classes={classes} classId={classId} setClassId={setClassId} fullOnly={fullOnly} setFullOnly={setFullOnly} />}
      </div>
    </div>
  );
}

// ── Overview Tab ──

function OverviewTab({ overview }: { overview: GroupOverview }) {
  return (
    <div>
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
        gap: 12, marginBottom: 20
      }}>
        {overview.subjects.map((sub) => (
          <div key={sub.examId} style={{
            background: "var(--bg-secondary)", borderRadius: 10,
            padding: 14, border: "1px solid var(--border)"
          }}>
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>{sub.subject}</div>
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
              </tr>
            </thead>
            <tbody>
              {overview.subjects.map((sub) => (
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── Scores Tab ──

function ScoresTab({
  rankings, classes, classId, setClassId, fullOnly, setFullOnly
}: {
  rankings: GroupRankingResponse | null;
  classes: ClassOption[]; classId: string; setClassId: (v: string) => void;
  fullOnly: boolean; setFullOnly: (v: boolean) => void;
}) {
  if (!rankings || rankings.rows.length === 0) {
    return (
      <div style={{ textAlign: "center", padding: 40, color: "var(--muted)" }}>
        <FileText size={36} style={{ opacity: 0.3, marginBottom: 8 }} />
        <p style={{ fontSize: 14 }}>暂无成绩数据</p>
      </div>
    );
  }

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
              {rankings.displayColumns.map((col) => [
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
                {rankings.displayColumns.map((col) => {
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

// Shared table styles
const thStyle: React.CSSProperties = {
  padding: "8px 10px", textAlign: "left", fontSize: 12, fontWeight: 600,
  color: "var(--muted)", borderBottom: "2px solid var(--border)"
};

const thStyleR: React.CSSProperties = {
  ...thStyle, textAlign: "right"
};

const tdStyle: React.CSSProperties = {
  padding: "6px 10px", borderBottom: "1px solid var(--border)"
};

const tdStyleR: React.CSSProperties = {
  ...tdStyle, textAlign: "right"
};

const linkStyle: React.CSSProperties = {
  color: "var(--primary)", background: "none", border: "none",
  cursor: "pointer", fontSize: 13, textDecoration: "underline"
};
