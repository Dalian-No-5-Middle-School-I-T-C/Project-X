import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Minus, Search } from "lucide-react";
import { fetchJson } from "../auth/api";
import type { ScoreTableRow, ScoreDisplayMode } from "../../../../shared/types";

interface Props {
  examId: number;
  classId?: string;
}

type SortKey = "totalScore" | "gradeRank" | "classRank" | "displayValue" | "rankChange";

function formatScore(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

export function ScoreTable({ examId, classId }: Props) {
  const [rows, setRows] = useState<ScoreTableRow[]>([]);
  const [examName, setExamName] = useState("");
  const [subject, setSubject] = useState<string | null>(null);
  const [hasAssigned, setHasAssigned] = useState(false);
  const [totalCount, setTotalCount] = useState(0);
  const [displayMode, setDisplayMode] = useState<ScoreDisplayMode>("deviation");
  const [displayLabel, setDisplayLabel] = useState("偏差值");
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("gradeRank");
  const [sortAsc, setSortAsc] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    // Load user display preference
    fetchJson<{ scoreDisplayMode: ScoreDisplayMode }>("/api/users/me/settings")
      .then((s) => {
        const mode = s.scoreDisplayMode || "deviation";
        setDisplayMode(mode);
        setDisplayLabel(mode === "deviation" ? "偏差值" : mode === "zscore" ? "Z值" : "百分位");
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    setError("");
    const params = new URLSearchParams();
    if (classId) params.set("classId", classId);
    params.set("displayMode", displayMode);

    fetchJson<{
      examName: string; subject: string | null; hasAssignedScore: boolean;
      rows: ScoreTableRow[]; totalCount: number;
    }>(`/api/analysis/exams/${examId}/score-table?${params.toString()}`)
      .then((data) => {
        setExamName(data.examName);
        setSubject(data.subject);
        setHasAssigned(data.hasAssignedScore);
        setRows(data.rows);
        setTotalCount(data.totalCount);
        setSortKey(classId ? "classRank" : "gradeRank");
      })
      .catch((err) => setError(err instanceof Error ? err.message : "加载失败"))
      .finally(() => setLoading(false));
  }, [examId, classId, displayMode]);

  const filtered = useMemo(() => {
    if (!search.trim()) return rows;
    const q = search.trim().toLowerCase();
    return rows.filter((r) =>
      r.studentName.toLowerCase().includes(q) ||
      r.studentNumber.toLowerCase().includes(q) ||
      r.className.toLowerCase().includes(q)
    );
  }, [rows, search]);

  const sorted = useMemo(() => {
    const data = [...filtered];
    data.sort((a, b) => {
      const va = a[sortKey] ?? 0;
      const vb = b[sortKey] ?? 0;
      return sortAsc ? Number(va) - Number(vb) : Number(vb) - Number(va);
    });
    return data;
  }, [filtered, sortKey, sortAsc]);

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortAsc(!sortAsc);
    } else {
      setSortKey(key);
      setSortAsc(true);
    }
  }

  function renderSortArrow(key: SortKey) {
    if (sortKey !== key) return <span style={{ color: "var(--line-strong)", fontSize: 10, marginLeft: 2 }}>↕</span>;
    return sortAsc
      ? <ArrowUp size={10} style={{ marginLeft: 2 }} />
      : <ArrowDown size={10} style={{ marginLeft: 2 }} />;
  }

  function renderChange(change: number | null | undefined) {
    if (change == null) return <span style={{ color: "var(--muted)" }}>—</span>;
    if (change > 0) return <span style={{ color: "#3B6D11", fontWeight: 500 }}>↑ +{change}</span>;
    if (change < 0) return <span style={{ color: "#A32D2D", fontWeight: 500 }}>↓ {change}</span>;
    return <span style={{ color: "var(--muted)" }}><Minus size={12} style={{ verticalAlign: "middle" }} /> 0</span>;
  }

  if (loading) return <div className="empty-text" style={{ padding: 40, textAlign: "center" }}>加载成绩数据...</div>;
  if (error) return <div className="empty-text" style={{ padding: 40, textAlign: "center", color: "var(--brand)" }}>{error}</div>;
  if (rows.length === 0) return <div className="empty-text" style={{ padding: 40, textAlign: "center" }}>此考试暂无成绩数据。</div>;

  return (
    <div>
      {/* Toolbar */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, background: "#fff", border: "1px solid var(--line)", borderRadius: 8, padding: "4px 10px", flex: 1, minWidth: 200, maxWidth: 320 }}>
          <Search size={14} style={{ color: "var(--muted)", flexShrink: 0 }} />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索姓名/学号/班级..."
            style={{ border: "none", outline: "none", fontSize: 13, width: "100%", background: "transparent" }}
          />
        </div>
        <span style={{ fontSize: 13, color: "var(--muted)", marginLeft: "auto" }}>
          共 {filtered.length}/{totalCount} 人
        </span>
      </div>

      {/* Table */}
      <div style={{ overflowX: "auto", border: "1px solid var(--line)", borderRadius: 10, background: "#fff" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "var(--surface-tint)", borderBottom: "2px solid var(--line)" }}>
              <th style={thStyle}>#</th>
              <th style={thStyle}>姓名</th>
              <th style={thStyle}>班级</th>
              <th style={thStyle}>
                <button onClick={() => handleSort("totalScore")} style={thBtnStyle}>
                  原始分 {renderSortArrow("totalScore")}
                </button>
              </th>
              {hasAssigned && (
                <th style={thStyle}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>赋分</span>
                </th>
              )}
              <th style={thStyle}>
                <button onClick={() => handleSort("gradeRank")} style={thBtnStyle}>
                  年排 {renderSortArrow("gradeRank")}
                </button>
              </th>
              <th style={thStyle}>
                <button onClick={() => handleSort("classRank")} style={thBtnStyle}>
                  班排 {renderSortArrow("classRank")}
                </button>
              </th>
              <th style={thStyle}>
                <button onClick={() => handleSort("rankChange")} style={thBtnStyle}>
                  名次变化 {renderSortArrow("rankChange")}
                </button>
              </th>
              <th style={thStyle}>
                <button onClick={() => handleSort("displayValue")} style={thBtnStyle}>
                  {displayLabel} {renderSortArrow("displayValue")}
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row, i) => (
              <tr key={row.studentId} style={{ borderTop: "1px solid var(--line-light)", background: i % 2 === 0 ? "#fff" : "var(--bg-soft)" }}>
                <td style={tdStyle}>{i + 1}</td>
                <td style={tdStyle}>
                  <span style={{ fontWeight: 500 }}>{row.studentName}</span>
                  <span style={{ fontSize: 11, color: "var(--muted)", display: "block" }}>{row.studentNumber}</span>
                </td>
                <td style={tdStyle}>{row.className}</td>
                <td style={{ ...tdStyle, fontWeight: 600 }}>{formatScore(row.totalScore)}</td>
                {hasAssigned && (
                  <td style={{ ...tdStyle, fontWeight: 500, color: row.assignedScore != null ? "var(--brand)" : "var(--muted)" }}>
                    {row.assignedScore != null ? formatScore(row.assignedScore) : "—"}
                  </td>
                )}
                <td style={tdStyle}>{row.gradeRank}</td>
                <td style={tdStyle}>{row.classRank}</td>
                <td style={tdStyle}>{renderChange(row.rankChange)}</td>
                <td style={{ ...tdStyle, fontWeight: 500 }}>
                  {row.displayValue != null ? formatScore(row.displayValue) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const thStyle: React.CSSProperties = {
  padding: "10px 10px", textAlign: "left", fontSize: 12, fontWeight: 600,
  color: "var(--text-secondary)", whiteSpace: "nowrap"
};

const thBtnStyle: React.CSSProperties = {
  background: "none", border: "none", cursor: "pointer",
  fontSize: 12, fontWeight: 600, color: "var(--text-secondary)",
  display: "flex", alignItems: "center", gap: 2, padding: 0
};

const tdStyle: React.CSSProperties = {
  padding: "8px 10px", fontSize: 13, verticalAlign: "top"
};
