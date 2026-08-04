import { useEffect, useMemo, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { fetchJson } from "../auth/api";
import type { QuestionStudentScore } from "../../../../shared/types";
import { formatScore, formatPercent } from "../util/format";

interface Props {
  examId: number;
  questionNumber: string;
  questionMaxScore: number;
  classId?: string;
  onClose: () => void;
}

type SortKey = "studentNumber" | "name" | "className" | "score" | "scoreRate" | "isFull";

export function QuestionStudentScoresModal({ examId, questionNumber, questionMaxScore, classId, onClose }: Props) {
  const [students, setStudents] = useState<QuestionStudentScore[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("score");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [filterClass, setFilterClass] = useState("");

  useEffect(() => {
    setLoading(true); setError("");
    const params = new URLSearchParams();
    params.set("questionNumber", questionNumber);
    if (classId) params.set("classId", classId);
    fetchJson<QuestionStudentScore[]>(`/api/analysis/exams/${examId}/question-students?${params.toString()}`)
      .then((d) => setStudents(Array.isArray(d) ? d : []))
      .catch((e) => setError(e.message ?? "加载失败"))
      .finally(() => setLoading(false));
  }, [examId, questionNumber, classId]);

  const classOptions = useMemo(() => {
    const set = new Set<string>();
    students.forEach((s) => { if (s.className) set.add(s.className); });
    return Array.from(set).sort();
  }, [students]);

  const display = useMemo(() => {
    let arr = filterClass ? students.filter((s) => s.className === filterClass) : students;
    arr = [...arr].sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "studentNumber": cmp = a.studentNumber.localeCompare(b.studentNumber, "zh", { numeric: true }); break;
        case "name": cmp = a.name.localeCompare(b.name, "zh"); break;
        case "className": cmp = (a.className ?? "").localeCompare(b.className ?? "", "zh"); break;
        case "score": cmp = a.score - b.score; break;
        case "scoreRate": cmp = a.scoreRate - b.scoreRate; break;
        case "isFull": cmp = (a.isFull === b.isFull) ? 0 : a.isFull ? -1 : 1; break;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [students, filterClass, sortKey, sortDir]);

  const knowledgePoint = students.find((s) => s.knowledgePoint)?.knowledgePoint ?? null;
  const avg = display.length ? display.reduce((s, x) => s + x.score, 0) / display.length : 0;
  const fullCount = display.filter((s) => s.isFull).length;

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir(key === "score" || key === "scoreRate" ? "desc" : "asc"); }
  }
  function sortIndicator(key: SortKey) {
    if (sortKey !== key) return <span style={{ opacity: 0.35, fontSize: 10 }}>⇅</span>;
    return <span style={{ fontSize: 10, color: "var(--brand)" }}>{sortDir === "asc" ? "▲" : "▼"}</span>;
  }

  const thStyle: React.CSSProperties = { padding: "7px 10px", textAlign: "left", fontWeight: 600, cursor: "pointer", userSelect: "none", whiteSpace: "nowrap", fontSize: 12 };
  const thRight: React.CSSProperties = { ...thStyle, textAlign: "right" };

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-card" style={{ maxWidth: 760, width: "92%" }}>
        <div className="modal-header">
          <h3>第 {questionNumber} 题 · 全班得分{questionMaxScore ? `（满分 ${questionMaxScore}）` : ""}</h3>
          <button onClick={onClose} className="ghost-button" style={{ padding: "4px 8px" }}>&#x2715;</button>
        </div>

        <div style={{ display: "flex", gap: 12, alignItems: "center", padding: "0 4px 12px", flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, color: "var(--muted)" }}>共 {display.length} 人 · 平均 {formatScore(avg)} · 满分 {fullCount} 人</span>
          {knowledgePoint && (
            <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 999, background: "var(--brand-soft)", color: "var(--brand)" }}>
              知识点：{knowledgePoint}
            </span>
          )}
          {classOptions.length > 1 && (
            <label style={{ marginLeft: "auto", fontSize: 12, color: "var(--muted)" }}>
              班级筛选：
              <select value={filterClass} onChange={(e) => setFilterClass(e.target.value)} style={{ marginLeft: 4, padding: "3px 8px", borderRadius: 6, border: "1px solid var(--line-strong)" }}>
                <option value="">全部</option>
                {classOptions.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
          )}
        </div>

        {error && <div style={{ color: "#A32D2D", fontSize: 13, padding: 8 }}>{error}</div>}
        {loading ? (
          <div style={{ textAlign: "center", padding: 30, color: "var(--muted)" }}>加载中...</div>
        ) : (
          <div style={{ maxHeight: "60vh", overflow: "auto", border: "1px solid var(--line)", borderRadius: 8 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: "var(--surface-tint)", color: "var(--brand)", fontSize: 12, position: "sticky", top: 0 }}>
                  <th style={thStyle} onClick={() => toggleSort("studentNumber")}>学号 {sortIndicator("studentNumber")}</th>
                  <th style={thStyle} onClick={() => toggleSort("name")}>姓名 {sortIndicator("name")}</th>
                  <th style={thStyle} onClick={() => toggleSort("className")}>班级 {sortIndicator("className")}</th>
                  <th style={thRight} onClick={() => toggleSort("score")}>得分 {sortIndicator("score")}</th>
                  <th style={thRight} onClick={() => toggleSort("scoreRate")}>得分率 {sortIndicator("scoreRate")}</th>
                  <th style={thRight} onClick={() => toggleSort("isFull")}>满分 {sortIndicator("isFull")}</th>
                  <th style={thRight}>知识点</th>
                </tr>
              </thead>
              <tbody>
                {display.map((s) => (
                  <tr key={s.studentId} style={{ borderTop: "1px solid var(--line)" }}>
                    <td style={{ padding: "7px 10px", color: "var(--muted)" }}>{s.studentNumber}</td>
                    <td style={{ padding: "7px 10px" }}>{s.name}</td>
                    <td style={{ padding: "7px 10px", color: "var(--muted)" }}>{s.className ?? "—"}</td>
                    <td style={{ padding: "7px 10px", textAlign: "right", fontWeight: 600 }}>{formatScore(s.score)}</td>
                    <td style={{ padding: "7px 10px", textAlign: "right" }}>{formatPercent(s.scoreRate)}</td>
                    <td style={{ padding: "7px 10px", textAlign: "right" }}>{s.isFull ? <CheckCircle2 size={15} aria-label="满分" /> : null}</td>
                    <td style={{ padding: "7px 10px", textAlign: "right", fontSize: 12, color: "var(--brand)" }}>{s.knowledgePoint ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
