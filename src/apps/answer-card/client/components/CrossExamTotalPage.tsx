import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, CalendarDays, Layers, Save, Search, Trash2 } from "lucide-react";
import { fetchJson } from "../auth/api";
import type {
  CrossExamAttendanceMode,
  CrossExamGroup,
  CrossExamTotalRequest,
  CrossExamTotalResponse,
  ExamFilterItem
} from "../../../../shared/types";

interface ClassOption {
  id: number;
  name: string;
  grade_name?: string;
}

interface FilterOptions {
  academicYears: string[];
  subjects: string[];
}

interface Props {
  onBack: () => void;
}

type Mode = "week" | "selected" | "group";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function formatScore(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function CrossExamTotalPage({ onBack }: Props) {
  const [mode, setMode] = useState<Mode>("week");
  const [filters, setFilters] = useState<FilterOptions>({ academicYears: [], subjects: [] });
  const [grades, setGrades] = useState<Array<{ id: number; name: string }>>([]);
  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [academicYear, setAcademicYear] = useState("");
  const [gradeId, setGradeId] = useState("");
  const [classId, setClassId] = useState("");
  const [subject, setSubject] = useState("");
  const [endDate, setEndDate] = useState(today());
  const [startDate, setStartDate] = useState(addDays(today(), -6));
  const [attendanceMode, setAttendanceMode] = useState<CrossExamAttendanceMode>("all");
  const [exams, setExams] = useState<ExamFilterItem[]>([]);
  const [groups, setGroups] = useState<CrossExamGroup[]>([]);
  const [selectedExamIds, setSelectedExamIds] = useState<Set<number>>(new Set());
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [groupName, setGroupName] = useState("");
  const [result, setResult] = useState<CrossExamTotalResponse | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [savingGroup, setSavingGroup] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    fetchJson<FilterOptions>("/api/exams/filters").then(setFilters).catch(() => {});
    fetchJson<Array<{ id: number; name: string }>>("/api/grades").then(setGrades).catch(() => setGrades([]));
    fetchJson<ClassOption[]>("/api/classes").then(setClasses).catch(() => setClasses([]));
    loadGroups();
  }, []);

  useEffect(() => {
    const params = new URLSearchParams({ selection: "1" });
    if (academicYear) params.set("academic_year", academicYear);
    if (gradeId) params.set("grade_id", gradeId);
    if (subject) params.set("subject", subject);
    fetchJson<ExamFilterItem[]>(`/api/exams?${params.toString()}`)
      .then(setExams)
      .catch(() => setExams([]));
  }, [academicYear, gradeId, subject]);

  async function loadGroups(preferredGroupId?: string) {
    try {
      const data = await fetchJson<CrossExamGroup[]>("/api/analysis/cross-exam/groups");
      setGroups(data);
      if (preferredGroupId) {
        setSelectedGroupId(preferredGroupId);
      } else if (!selectedGroupId && data.length > 0) {
        setSelectedGroupId(String(data[0].id));
      }
    } catch {
      setGroups([]);
    }
  }

  async function runTotal(request: CrossExamTotalRequest) {
    setLoading(true);
    setMessage("");
    try {
      const data = await fetchJson<CrossExamTotalResponse>("/api/analysis/cross-exam/total", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...request,
          gradeId: gradeId ? Number(gradeId) : undefined,
          classId: classId ? Number(classId) : undefined,
          subject: subject || undefined,
          attendanceMode
        })
      });
      setResult(data);
      if (data.exams.length === 0) setMessage("当前条件下没有可统计的考试。");
    } catch (err) {
      setResult(null);
      setMessage(err instanceof Error ? err.message : "统计失败");
    } finally {
      setLoading(false);
    }
  }

  async function saveGroup(source: "manual" | "week", examIds: number[], fallbackName: string) {
    const name = groupName.trim() || fallbackName;
    if (examIds.length === 0) {
      setMessage("没有可保存的考试。");
      return;
    }
    setSavingGroup(true);
    setMessage("正在保存考试组...");
    try {
      const group = await fetchJson<CrossExamGroup>("/api/analysis/cross-exam/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, examIds, source, startDate, endDate })
      });
      setGroupName("");
      setSelectedGroupId(String(group.id));
      setMode("group");
      await loadGroups(String(group.id));
      await runTotal({ mode: "group", groupId: group.id });
      setMessage(`已保存并统计考试组：${group.name}`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "保存考试组失败");
    } finally {
      setSavingGroup(false);
    }
  }

  async function deleteGroup() {
    if (!selectedGroupId) return;
    try {
      await fetchJson(`/api/analysis/cross-exam/groups/${selectedGroupId}`, { method: "DELETE" });
      setSelectedGroupId("");
      setResult(null);
      await loadGroups();
      setMessage("考试组已删除。");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "删除考试组失败");
    }
  }

  const selectedIds = useMemo(() => Array.from(selectedExamIds), [selectedExamIds]);
  const weekResultExamIds = result?.mode === "week" ? result.exams.map((exam) => exam.id) : [];
  const filteredRows = useMemo(() => {
    if (!result) return [];
    const q = search.trim().toLowerCase();
    if (!q) return result.rows;
    return result.rows.filter((row) =>
      row.studentName.toLowerCase().includes(q) ||
      row.studentNumber.toLowerCase().includes(q) ||
      row.className.toLowerCase().includes(q)
    );
  }, [result, search]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 24px", borderBottom: "1px solid var(--line)", background: "var(--surface)" }}>
        <button className="ghost-button" onClick={onBack}><ArrowLeft size={16} /> 返回</button>
        <div style={{ flex: 1 }}>
          <h2 style={{ fontSize: 16, margin: 0 }}>跨考试总成绩</h2>
          <p style={{ fontSize: 12, color: "var(--muted)", margin: "2px 0 0" }}>按一周考试包或考试组统计总分与排名</p>
        </div>
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: 24 }}>
        <div className="analysis-section" style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
            <ModeButton active={mode === "week"} onClick={() => setMode("week")} icon={<CalendarDays size={15} />} label="按日期打包一周" />
            <ModeButton active={mode === "selected"} onClick={() => setMode("selected")} icon={<Layers size={15} />} label="选定考试合并" />
            <ModeButton active={mode === "group"} onClick={() => setMode("group")} icon={<Save size={15} />} label="已保存考试组" />
          </div>

          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
            {mode === "selected" && (
              <FilterSelect label="学年" value={academicYear} onChange={setAcademicYear} options={filters.academicYears.map((item) => ({ value: item, label: item }))} emptyLabel="全部学年" />
            )}
            <FilterSelect label="年级" value={gradeId} onChange={setGradeId} options={grades.map((g) => ({ value: String(g.id), label: g.name }))} emptyLabel="全部年级" />
            <FilterSelect label="科目" value={subject} onChange={setSubject} options={filters.subjects.map((item) => ({ value: item, label: item }))} emptyLabel="全部科目" />
            <FilterSelect
              label="班级排名范围"
              value={classId}
              onChange={setClassId}
              options={[{ value: "0", label: "未分配班级" }, ...classes.map((c) => ({ value: String(c.id), label: c.grade_name ? `${c.grade_name} / ${c.name}` : c.name }))]}
              emptyLabel="全部班级"
            />
            <label style={labelStyle}>
              <span>出勤口径</span>
              <select value={attendanceMode} onChange={(e) => setAttendanceMode(e.target.value as CrossExamAttendanceMode)} className="exam-filter-select">
                <option value="all">缺考计 0</option>
                <option value="full">仅全勤学生</option>
              </select>
            </label>
          </div>

          {mode === "week" && (
            <div style={panelStyle}>
              <label style={labelStyle}><span>开始日期</span><input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="exam-filter-select" /></label>
              <label style={labelStyle}><span>结束日期</span><input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="exam-filter-select" /></label>
              <button className="primary-button" disabled={loading} onClick={() => runTotal({ mode: "week", startDate, endDate })}>统计这一周</button>
              <button className="ghost-button" disabled={!weekResultExamIds.length || savingGroup} onClick={() => saveGroup("week", weekResultExamIds, `${startDate}至${endDate}考试组`)}>{savingGroup ? "正在保存..." : "保存为考试组"}</button>
            </div>
          )}

          {mode === "selected" && (
            <div style={panelStyle}>
              <input
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                placeholder="考试组名称（可选）"
                style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid var(--line-strong)", background: "var(--surface)", minWidth: 220 }}
              />
              <button className="primary-button" disabled={selectedIds.length === 0 || savingGroup} onClick={() => saveGroup("manual", selectedIds, `手动考试组-${new Date().toISOString().slice(0, 10)}`)}>{savingGroup ? "正在保存..." : "合并为考试组并统计"}</button>
              <button className="ghost-button" disabled={loading || selectedIds.length === 0} onClick={() => runTotal({ mode: "selected", examIds: selectedIds })}>仅统计选中考试</button>
              <span style={{ color: "var(--muted)", fontSize: 13 }}>已选 {selectedIds.length} 场</span>
            </div>
          )}

          {mode === "group" && (
            <div style={panelStyle}>
              <select value={selectedGroupId} onChange={(e) => setSelectedGroupId(e.target.value)} className="exam-filter-select" style={{ minWidth: 240 }}>
                <option value="">请选择考试组</option>
                {groups.map((group) => <option key={group.id} value={String(group.id)}>{group.name}（{group.examIds.length}场）</option>)}
              </select>
              <button className="primary-button" disabled={loading || !selectedGroupId} onClick={() => runTotal({ mode: "group", groupId: Number(selectedGroupId) })}>统计考试组</button>
              <button className="ghost-button" disabled={!selectedGroupId} onClick={deleteGroup}><Trash2 size={15} /> 删除组</button>
            </div>
          )}
        </div>

        {mode === "selected" && (
          <div className="analysis-section" style={{ marginBottom: 16 }}>
            <div className="panel-title">选择考试</div>
            <div className="exam-list-table" style={{ maxHeight: 260, overflow: "auto" }}>
              <div className="exam-list-head">
                <span style={{ width: 36 }} />
                <span style={{ flex: 1, minWidth: 180 }}>考试名称</span>
                <span style={{ width: 80 }}>科目</span>
                <span style={{ width: 90 }}>年级</span>
                <span style={{ width: 100 }}>日期</span>
                <span style={{ width: 70, textAlign: "center" }}>已阅</span>
                <span style={{ width: 70, textAlign: "center" }}>均分</span>
              </div>
              {exams.map((exam) => (
                <label key={exam.id} className="exam-list-row" style={{ cursor: "pointer" }}>
                  <span style={{ width: 36 }}><input type="checkbox" checked={selectedExamIds.has(exam.id)} onChange={() => {
                    const next = new Set(selectedExamIds);
                    if (next.has(exam.id)) next.delete(exam.id); else next.add(exam.id);
                    setSelectedExamIds(next);
                  }} /></span>
                  <span style={{ flex: 1, minWidth: 180, fontWeight: 500 }}>{exam.name}</span>
                  <span style={{ width: 80, color: "var(--muted)" }}>{exam.subject || "—"}</span>
                  <span style={{ width: 90, color: "var(--muted)" }}>{exam.grade_name || "—"}</span>
                  <span style={{ width: 100, color: "var(--muted)" }}>{exam.exam_date || "—"}</span>
                  <span style={{ width: 70, textAlign: "center" }}>{exam.graded_count}</span>
                  <span style={{ width: 70, textAlign: "center" }}>{exam.graded_count > 0 ? exam.avg_score : "—"}</span>
                </label>
              ))}
            </div>
          </div>
        )}

        {message && <div className="empty-text" style={{ marginBottom: 12 }}>{message}</div>}
        {loading && <div className="empty-text">正在统计跨考试总成绩...</div>}
        {result && !loading && <ResultTable result={result} rows={filteredRows} search={search} setSearch={setSearch} />}
      </div>
    </div>
  );
}

function ModeButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center", gap: 6, padding: "7px 12px",
        border: `1px solid ${active ? "var(--brand)" : "var(--line-strong)"}`,
        background: active ? "var(--brand-soft)" : "var(--surface)",
        color: active ? "var(--brand)" : "var(--text-primary)",
        borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: active ? 600 : 400
      }}
    >
      {icon}{label}
    </button>
  );
}

function FilterSelect({ label, value, onChange, options, emptyLabel }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  emptyLabel: string;
}) {
  return (
    <label style={labelStyle}>
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="exam-filter-select">
        <option value="">{emptyLabel}</option>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}

function ResultTable({ result, rows, search, setSearch }: {
  result: CrossExamTotalResponse;
  rows: CrossExamTotalResponse["rows"];
  search: string;
  setSearch: (value: string) => void;
}) {
  return (
    <div>
      <div className="overview-info-grid" style={{ marginBottom: 16 }}>
        <InfoCard value={result.summary.examCount} label="考试数" />
        <InfoCard value={result.summary.studentCount} label="统计人数" />
        <InfoCard value={formatScore(result.summary.totalFullScore)} label="总满分" />
        <InfoCard value={formatScore(result.summary.avgTotalScore)} label="平均总分" />
        <InfoCard value={formatScore(result.summary.maxTotalScore)} label="最高总分" />
        <InfoCard value={result.summary.fullAttendanceCount} label="全勤人数" />
      </div>

      <div className="analysis-section" style={{ marginBottom: 16 }}>
        <div className="panel-title">考试包</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {result.exams.map((exam) => (
            <span key={exam.id} style={{ padding: "5px 9px", borderRadius: 999, background: "var(--surface-tint)", border: "1px solid var(--line)", fontSize: 12 }}>
              {exam.examDate || "无日期"} · {exam.name} · 满分{formatScore(exam.fullScore)}
            </span>
          ))}
        </div>
      </div>

      {result.classSummaries.length > 0 && (
        <div className="analysis-section" style={{ marginBottom: 16 }}>
          <div className="panel-title">班级汇总</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 8 }}>
            {result.classSummaries.map((item) => (
              <div key={`${item.classId ?? "unknown"}`} style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 10, background: "var(--bg-soft)", fontSize: 13 }}>
                <div style={{ fontWeight: 600 }}>{item.gradeName ? `${item.gradeName} / ${item.className}` : item.className}</div>
                <div style={{ color: "var(--muted)", marginTop: 4 }}>人数 {item.count} · 均分 {formatScore(item.avgScore)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="analysis-section">
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
          <div className="panel-title" style={{ margin: 0 }}>总成绩排名</div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, border: "1px solid var(--line)", borderRadius: 8, padding: "4px 10px", marginLeft: "auto" }}>
            <Search size={14} style={{ color: "var(--muted)" }} />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索姓名/学号/班级" style={{ border: "none", outline: "none", background: "transparent", fontSize: 13 }} />
          </div>
        </div>
        <div style={{ overflowX: "auto", border: "1px solid var(--line)", borderRadius: 10 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, background: "var(--surface)" }}>
            <thead>
              <tr style={{ background: "var(--surface-tint)", borderBottom: "2px solid var(--line)" }}>
                <th style={thStyle}>年排</th>
                <th style={thStyle}>班排</th>
                <th style={thStyle}>姓名</th>
                <th style={thStyle}>班级</th>
                <th style={thStyle}>总分</th>
                <th style={thStyle}>得分率</th>
                <th style={thStyle}>出勤</th>
                {result.exams.map((exam) => <th key={exam.id} style={thStyle}>{exam.name.length > 8 ? `${exam.name.slice(0, 8)}...` : exam.name}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={row.studentId} style={{ borderTop: "1px solid var(--line-light)", background: index % 2 === 0 ? "var(--surface)" : "var(--bg-soft)" }}>
                  <td style={tdStyle}>{row.gradeRank}</td>
                  <td style={tdStyle}>{row.classRank}</td>
                  <td style={tdStyle}><strong>{row.studentName}</strong><span style={{ display: "block", color: "var(--muted)", fontSize: 11 }}>{row.studentNumber}</span></td>
                  <td style={tdStyle}>{row.className}</td>
                  <td style={{ ...tdStyle, fontWeight: 600 }}>{formatScore(row.totalScore)} / {formatScore(row.totalFullScore)}</td>
                  <td style={tdStyle}>{row.scoreRate == null ? "—" : `${formatScore(row.scoreRate)}%`}</td>
                  <td style={tdStyle}>{row.attendedCount}/{result.exams.length}{row.absentCount > 0 ? <span style={{ color: "#A32D2D" }}> 缺{row.absentCount}</span> : null}</td>
                  {row.scores.map((cell) => <td key={cell.examId} style={tdStyle}>{cell.absent ? <span style={{ color: "var(--muted)" }}>缺考</span> : formatScore(cell.score ?? 0)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function InfoCard({ value, label }: { value: string | number; label: string }) {
  return (
    <div className="overview-info-card">
      <span className="overview-info-value">{value}</span>
      <span className="overview-info-label">{label}</span>
    </div>
  );
}

const labelStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--muted)" };
const panelStyle: React.CSSProperties = { display: "flex", alignItems: "flex-end", gap: 10, flexWrap: "wrap", marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--line)" };
const thStyle: React.CSSProperties = { padding: "9px 10px", textAlign: "left", fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", whiteSpace: "nowrap" };
const tdStyle: React.CSSProperties = { padding: "8px 10px", verticalAlign: "top", whiteSpace: "nowrap" };
