import { useEffect, useMemo, useState } from "react";
import { CalendarDays, Layers, Save, Search, Trash2 } from "lucide-react";
import { fetchJson } from "../auth/api";
import { useIsMobile } from "../hooks/useMediaQuery";
import { DataCard } from "./ui/DataCard";
import { formatScore } from "../util/format";
import type {
  CrossExamAttendanceMode,
  CrossExamGroup,
  CrossExamTotalRequest,
  CrossExamTotalResponse,
  ExamFilterItem,
  ExamGroupFilterItem
} from "../../../../shared/types";

interface ClassOption { id: number; name: string; grade_name?: string; }
interface FilterOptions { academicYears: string[]; subjects: string[]; }

interface Props {
  onSelectExam: (examId: number) => void;
  onSelectGroup?: (groupId: number) => void;
  refreshKey?: number;
}

type MainMode = "single" | "group" | "cross";
type CrossMode = "week" | "selected" | "group";

function today(): string { return new Date().toISOString().slice(0, 10); }
function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function ExamSelectPage({ onSelectExam, onSelectGroup, refreshKey = 0 }: Props) {
  const isMobile = useIsMobile();
  const [mainMode, setMainMode] = useState<MainMode>("single");
  const [crossMode, setCrossMode] = useState<CrossMode>("week");
  const [filters, setFilters] = useState<FilterOptions>({ academicYears: [], subjects: [] });
  const [academicYear, setAcademicYear] = useState("");
  const [gradeId, setGradeId] = useState("");
  const [subject, setSubject] = useState("");
  const [exams, setExams] = useState<ExamFilterItem[]>([]);
  const [groupExams, setGroupExams] = useState<ExamGroupFilterItem[]>([]);
  const [grades, setGrades] = useState<Array<{ id: number; name: string }>>([]);
  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [loading, setLoading] = useState(true);

  // ── Cross-exam states ──
  const [endDate, setEndDate] = useState(today());
  const [startDate, setStartDate] = useState(addDays(today(), -6));
  const [attendanceMode, setAttendanceMode] = useState<CrossExamAttendanceMode>("all");
  const [classId, setClassId] = useState("");
  const [crossGroups, setCrossGroups] = useState<CrossExamGroup[]>([]);
  const [selectedExamIds, setSelectedExamIds] = useState<Set<number>>(new Set());
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [groupName, setGroupName] = useState("");
  const [crossResult, setCrossResult] = useState<CrossExamTotalResponse | null>(null);
  const [crossSearch, setCrossSearch] = useState("");
  const [crossLoading, setCrossLoading] = useState(false);
  const [crossMessage, setCrossMessage] = useState("");
  const [savingGroup, setSavingGroup] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteCount, setDeleteCount] = useState(0);
  const [deleteGroupName, setDeleteGroupName] = useState("");
  // Week preview: exams within date range
  const weekPreviewExams = useMemo(() =>
    exams.filter((e) => e.exam_date && e.exam_date >= startDate && e.exam_date <= endDate),
    [exams, startDate, endDate]
  );

  useEffect(() => {
    fetchJson<FilterOptions>("/api/exams/filters").then(setFilters).catch(() => {});
  }, []);

  useEffect(() => {
    fetchJson<Array<{ id: number; name: string }>>("/api/classes/grades")
      .then(setGrades).catch(() => setGrades([]));
    fetchJson<ClassOption[]>("/api/classes")
      .then(setClasses).catch(() => setClasses([]));
    loadCrossGroups();
  }, []);

  // Load single/group exams
  useEffect(() => {
    if (mainMode === "cross") return;
    setLoading(true);
    const params = new URLSearchParams({ selection: "1" });
    if (academicYear) params.set("academic_year", academicYear);
    if (gradeId) params.set("grade_id", gradeId);
    if (subject) params.set("subject", subject);

    if (mainMode === "single") {
      fetchJson<ExamFilterItem[]>(`/api/exams?${params.toString()}`)
        .then(setExams).catch(() => setExams([]))
        .finally(() => setLoading(false));
    } else {
      const gParams = new URLSearchParams();
      if (gradeId) gParams.set("grade_id", gradeId);
      fetchJson<ExamGroupFilterItem[]>(`/api/exam-groups?${gParams.toString()}`)
        .then(setGroupExams).catch(() => setGroupExams([]))
        .finally(() => setLoading(false));
    }
  }, [mainMode, academicYear, gradeId, subject, refreshKey]);

  // Load exams for cross-exam picker / week preview
  useEffect(() => {
    if (mainMode !== "cross") return;
    setLoading(true);
    const params = new URLSearchParams({ selection: "1" });
    if (gradeId) params.set("grade_id", gradeId);
    if (subject && crossMode === "selected") params.set("subject", subject);
    fetchJson<ExamFilterItem[]>(`/api/exams?${params.toString()}`)
      .then(setExams).catch(() => setExams([]))
      .finally(() => setLoading(false));
  }, [mainMode, gradeId, subject, crossMode, refreshKey]);

  // ── Cross-exam functions ──
  async function loadCrossGroups(preferredGroupId?: string) {
    try {
      const data = await fetchJson<CrossExamGroup[]>("/api/analysis/cross-exam/groups");
      setCrossGroups(data);
      if (preferredGroupId) setSelectedGroupId(preferredGroupId);
      else if (!selectedGroupId && data.length > 0) setSelectedGroupId(String(data[0].id));
    } catch { setCrossGroups([]); }
  }

  async function runCrossTotal(request: CrossExamTotalRequest) {
    setCrossLoading(true);
    setCrossMessage("");
    try {
      const data = await fetchJson<CrossExamTotalResponse>("/api/analysis/cross-exam/total", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...request,
          gradeId: gradeId ? Number(gradeId) : undefined,
          classId: classId ? Number(classId) : undefined,
          subject: crossMode === "selected" ? subject || undefined : undefined,
          attendanceMode
        })
      });
      setCrossResult(data);
      if (data.exams.length === 0) setCrossMessage("当前条件下没有可统计的考试。");
    } catch (err) {
      setCrossResult(null);
      setCrossMessage(err instanceof Error ? err.message : "统计失败");
    } finally { setCrossLoading(false); }
  }

  async function saveCrossGroup(source: "cross-manual" | "week", examIds: number[], fallbackName: string) {
    const name = groupName.trim() || fallbackName;
    if (examIds.length === 0) { setCrossMessage("没有可保存的考试。"); return; }
    setSavingGroup(true);
    setCrossMessage("正在保存考试组...");
    try {
      const group = await fetchJson<CrossExamGroup>("/api/analysis/cross-exam/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, examIds, source, startDate, endDate })
      });
      setGroupName("");
      setSelectedGroupId(String(group.id));
      setCrossMode("group");
      await loadCrossGroups(String(group.id));
      await runCrossTotal({ mode: "group", groupId: group.id });
      setCrossMessage(`已保存并统计：${group.name}`);
    } catch (err) {
      setCrossMessage(err instanceof Error ? err.message : "保存失败");
    } finally { setSavingGroup(false); }
  }

  async function deleteCrossGroup() {
    if (!selectedGroupId) return;
    try {
      await fetchJson(`/api/analysis/cross-exam/groups/${selectedGroupId}`, { method: "DELETE" });
      setSelectedGroupId("");
      setCrossResult(null);
      await loadCrossGroups();
      setShowDeleteConfirm(false);
      setCrossMessage("考试组已删除。");
    } catch (err) { setCrossMessage(err instanceof Error ? err.message : "删除失败"); }
  }

  function confirmDeleteCrossGroup() {
    if (!selectedGroupId) return;
    const group = crossGroups.find((g) => String(g.id) === selectedGroupId);
    setDeleteGroupName(group?.name ?? "");
    setDeleteCount(group?.examIds.length ?? 0);
    setShowDeleteConfirm(true);
  }

  const selectedIds = useMemo(() => Array.from(selectedExamIds), [selectedExamIds]);
  const weekResultExamIds = crossResult?.mode === "week" ? crossResult.exams.map((e) => e.id) : [];
  const crossFilteredRows = useMemo(() => {
    if (!crossResult) return [];
    const q = crossSearch.trim().toLowerCase();
    if (!q) return crossResult.rows;
    return crossResult.rows.filter((row) =>
      row.studentName.toLowerCase().includes(q) || row.studentNumber.toLowerCase().includes(q) || row.className.toLowerCase().includes(q)
    );
  }, [crossResult, crossSearch]);

  // ── Render ──

  const showSingleGroup = mainMode !== "cross";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={{ padding: "24px 32px 0", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginBottom: 20 }}>
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0, marginBottom: 4 }}>考试选择</h2>
            <p style={{ fontSize: 13, color: "var(--muted)", margin: 0 }}>
              {mainMode === "cross" ? "按日期打包或手动选择考试计算总分排名" : "选择单科考试或大考合集查看成绩"}
            </p>
          </div>
          <div style={{ display: "flex", gap: 0, border: "1.5px solid var(--brand)", borderRadius: 6, overflow: "hidden", flexShrink: 0 }}>
            <button onClick={() => setMainMode("single")} style={toggleBtn(mainMode === "single")}>单科</button>
            <button onClick={() => setMainMode("group")} style={toggleBtn(mainMode === "group")}>大考</button>
            <button onClick={() => setMainMode("cross")} style={{ ...toggleBtn(mainMode === "cross"), color: mainMode === "cross" ? "#fff" : "var(--muted)" }}>
              <Layers size={12} /> 跨考
            </button>
          </div>
        </div>

        {/* Filter row — shared for single/group */}
        {showSingleGroup && (
          <div style={{ display: "flex", gap: 12, marginBottom: 24, flexWrap: "wrap", alignItems: "flex-end" }}>
            <FilterCol label="学年">
              <select value={academicYear} onChange={(e) => setAcademicYear(e.target.value)} className="exam-filter-select">
                <option value="">全部学年</option>
                {filters.academicYears.map((y) => <option key={y} value={y}>{y}</option>)}
              </select>
            </FilterCol>
            <FilterCol label="年级">
              <select value={gradeId} onChange={(e) => setGradeId(e.target.value)} className="exam-filter-select">
                <option value="">全部年级</option>
                {grades.map((g) => <option key={g.id} value={String(g.id)}>{g.name}</option>)}
              </select>
            </FilterCol>
            {mainMode === "single" && (
              <FilterCol label="学科">
                <select value={subject} onChange={(e) => setSubject(e.target.value)} className="exam-filter-select">
                  <option value="">全部学科</option>
                  {filters.subjects.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </FilterCol>
            )}
            {((mainMode === "single" && exams.length > 0) || (mainMode === "group" && groupExams.length > 0)) && (
              <span style={{ fontSize: 13, color: "var(--muted)", paddingBottom: 10 }}>
                共 {mainMode === "single" ? exams.length : groupExams.length} {mainMode === "single" ? "场考试" : "个大考"}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Scrollable content area */}
      <div style={{ flex: 1, overflow: "auto", padding: "0 32px 24px" }}>
        {/* ── Single exam list ── */}
        {mainMode === "single" && !loading && exams.length === 0 && (
          <div style={{ textAlign: "center", padding: 60 }}><Search size={48} style={{ opacity: 0.3, marginBottom: 12 }} /><p style={{ fontSize: 15, color: "var(--muted)", margin: 0 }}>暂无考试，请在「考试管理」中创建</p></div>
        )}
        {mainMode === "single" && !loading && exams.length > 0 && <ExamListTable exams={exams} onSelect={onSelectExam} />}

        {/* ── Exam group list ── */}
        {mainMode === "group" && !loading && groupExams.length === 0 && (
          <div style={{ textAlign: "center", padding: 60 }}><Layers size={48} style={{ opacity: 0.3, marginBottom: 12 }} /><p style={{ fontSize: 15, color: "var(--muted)", margin: 0 }}>暂无大考，请在「考试管理」中创建大考</p></div>
        )}
        {mainMode === "group" && !loading && groupExams.length > 0 && <GroupListTable groups={groupExams} onSelect={onSelectGroup} />}

        {loading && showSingleGroup && <div style={{ textAlign: "center", padding: 60, color: "var(--muted)", fontSize: 14 }}>正在加载...</div>}

        {/* ── Cross-exam analysis ── */}
        {mainMode === "cross" && (
          <div>
            {/* Cross mode tabs + filters */}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16, alignItems: "flex-end" }}>
              <CrossModeBtn active={crossMode === "week"} onClick={() => setCrossMode("week")} icon={<CalendarDays size={15} />} label="按日期打包" />
              <CrossModeBtn active={crossMode === "selected"} onClick={() => setCrossMode("selected")} icon={<Layers size={15} />} label="选定考试" />
              <CrossModeBtn active={crossMode === "group"} onClick={() => setCrossMode("group")} icon={<Save size={15} />} label="已存组" />

              <FilterCol label="年级">
                <select value={gradeId} onChange={(e) => setGradeId(e.target.value)} className="exam-filter-select">
                  <option value="">全部</option>
                  {grades.map((g) => <option key={g.id} value={String(g.id)}>{g.name}</option>)}
                </select>
              </FilterCol>
              {crossMode === "selected" && (
                <FilterCol label="科目">
                  <select value={subject} onChange={(e) => setSubject(e.target.value)} className="exam-filter-select">
                    <option value="">全部</option>
                    {filters.subjects.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </FilterCol>
              )}
              <FilterCol label="班级">
                <select value={classId} onChange={(e) => setClassId(e.target.value)} className="exam-filter-select">
                  <option value="">全部班级</option>
                  {classes.map((c) => <option key={c.id} value={String(c.id)}>{c.grade_name ? `${c.grade_name}/${c.name}` : c.name}</option>)}
                </select>
              </FilterCol>
              <FilterCol label="出勤">
                <select value={attendanceMode} onChange={(e) => setAttendanceMode(e.target.value as CrossExamAttendanceMode)} className="exam-filter-select">
                  <option value="all">缺考计0</option>
                  <option value="full">仅全勤</option>
                </select>
              </FilterCol>
            </div>

            {/* Week mode — date row + preview */}
            {crossMode === "week" && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ display: "flex", alignItems: "flex-end", gap: 10, flexWrap: "wrap" }}>
                  <FilterCol label="开始日期"><input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="exam-filter-select" style={{ width: 140 }} /></FilterCol>
                  <FilterCol label="结束日期"><input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="exam-filter-select" style={{ width: 140 }} /></FilterCol>
                  <button className="primary-button" disabled={crossLoading} onClick={() => runCrossTotal({ mode: "week", startDate, endDate })} style={{ height: 34 }}>统计这一周</button>
                  <button className="ghost-button" disabled={!weekResultExamIds.length || savingGroup} onClick={() => saveCrossGroup("week", weekResultExamIds, `${startDate}至${endDate}考试组`)}>{savingGroup ? "保存中..." : "保存为组"}</button>
                </div>
                {/* Week preview */}
                <div style={{ marginTop: 10 }}>
                  <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 4 }}>
                    本周预览（{weekPreviewExams.length} 场考试）：
                  </div>
                  {weekPreviewExams.length === 0 ? (
                    <div style={{ fontSize: 12, color: "var(--muted)", padding: "8px 0" }}>该日期范围内暂无考试</div>
                  ) : isMobile ? (
                    <div className="data-card-list" style={{ maxHeight: 200, overflow: "auto" }}>
                      {weekPreviewExams.map((exam) => (
                        <DataCard
                          key={exam.id}
                          rows={[
                            { label: "考试名称", value: exam.name, strong: true },
                            { label: "科目", value: exam.subject || "—" },
                            { label: "年级", value: exam.grade_name || "—" },
                            { label: "日期", value: exam.exam_date || "—" },
                            { label: "已阅", value: exam.graded_count },
                            { label: "均分", value: exam.graded_count > 0 ? exam.avg_score : "—" },
                          ]}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="exam-list-table" style={{ maxHeight: 200, overflow: "auto" }}>
                      <div className="exam-list-head">
                        <span style={{ flex: 1, minWidth: 180 }}>考试名称</span>
                        <span style={{ width: 80 }}>科目</span>
                        <span style={{ width: 90 }}>年级</span>
                        <span style={{ width: 100 }}>日期</span>
                        <span style={{ width: 70, textAlign: "center" }}>已阅</span>
                        <span style={{ width: 70, textAlign: "center" }}>均分</span>
                      </div>
                      {weekPreviewExams.map((exam) => (
                        <div key={exam.id} className="exam-list-row">
                          <span style={{ flex: 1, minWidth: 180, fontWeight: 500 }}>{exam.name}</span>
                          <span style={{ width: 80, color: "var(--muted)" }}>{exam.subject || "—"}</span>
                          <span style={{ width: 90, color: "var(--muted)" }}>{exam.grade_name || "—"}</span>
                          <span style={{ width: 100, color: "var(--muted)", fontSize: 12 }}>{exam.exam_date || "—"}</span>
                          <span style={{ width: 70, textAlign: "center" }}>{exam.graded_count}</span>
                          <span style={{ width: 70, textAlign: "center" }}>{exam.graded_count > 0 ? exam.avg_score : "—"}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Selected mode */}
            {crossMode === "selected" && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ display: "flex", alignItems: "flex-end", gap: 10, flexWrap: "wrap" }}>
                  <input value={groupName} onChange={(e) => setGroupName(e.target.value)} placeholder="考试组名称（可选）" style={inputStyle} />
                  <button className="primary-button" disabled={selectedIds.length === 0 || savingGroup} onClick={() => saveCrossGroup("cross-manual", selectedIds, `手动组-${today()}`)} style={{ height: 34 }}>{savingGroup ? "保存中..." : "合并保存并统计"}</button>
                  <button className="ghost-button" disabled={crossLoading || selectedIds.length === 0} onClick={() => runCrossTotal({ mode: "selected", examIds: selectedIds })}>仅统计</button>
                  <span style={{ color: "var(--muted)", fontSize: 13, paddingBottom: 6 }}>已选 {selectedIds.length} 场</span>
                </div>
                {/* Exam picker list */}
                {isMobile ? (
                  <div className="data-card-list" style={{ maxHeight: 260, overflow: "auto", marginTop: 12 }}>
                    {exams.map((exam) => (
                      <DataCard
                        key={exam.id}
                        rows={[
                          { label: "考试名称", value: exam.name, strong: true },
                          { label: "科目", value: exam.subject || "—" },
                          { label: "年级", value: exam.grade_name || "—" },
                          { label: "日期", value: exam.exam_date || "—" },
                          { label: "已阅", value: exam.graded_count },
                          { label: "均分", value: exam.graded_count > 0 ? exam.avg_score : "—" },
                        ]}
                        actions={
                          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, width: "100%", minHeight: "var(--touch-target-min)" }}>
                            <input type="checkbox" checked={selectedExamIds.has(exam.id)} onChange={() => {
                              const next = new Set(selectedExamIds);
                              if (next.has(exam.id)) next.delete(exam.id); else next.add(exam.id);
                              setSelectedExamIds(next);
                            }} />
                            选择此考试
                          </label>
                        }
                      />
                    ))}
                    {exams.length === 0 && <div style={{ padding: 16, color: "var(--muted)", fontSize: 13, textAlign: "center" }}>暂无匹配考试</div>}
                  </div>
                ) : (
                <div className="exam-list-table" style={{ maxHeight: 260, overflow: "auto", marginTop: 12 }}>
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
                  {exams.length === 0 && <div className="exam-list-row"><span style={{ padding: 16, color: "var(--muted)", fontSize: 13 }}>暂无匹配考试</span></div>}
                </div>
                )}
              </div>
            )}

            {/* Group mode */}
            {crossMode === "group" && (
              <div style={{ marginBottom: 16, display: "flex", alignItems: "flex-end", gap: 10, flexWrap: "wrap" }}>
                <FilterCol label="考试组">
                  <select value={selectedGroupId} onChange={(e) => setSelectedGroupId(e.target.value)} className="exam-filter-select" style={{ minWidth: 240 }}>
                    <option value="">请选择...</option>
                    {crossGroups.map((g) => <option key={g.id} value={String(g.id)}>{g.name}（{g.examIds.length}场）</option>)}
                  </select>
                </FilterCol>
                <button className="primary-button" disabled={crossLoading || !selectedGroupId} onClick={() => runCrossTotal({ mode: "group", groupId: Number(selectedGroupId) })} style={{ height: 34 }}>统计</button>
                <button className="ghost-button" disabled={!selectedGroupId} onClick={confirmDeleteCrossGroup}><Trash2 size={15} /> 删除</button>
              </div>
            )}

            {/* Delete confirm modal */}
            {showDeleteConfirm && (
              <div style={{
                position: "fixed", inset: 0, zIndex: 100001,
                display: "flex", alignItems: "center", justifyContent: "center",
                background: "rgba(0,0,0,0.45)"
              }} onClick={() => setShowDeleteConfirm(false)}>
                <div style={{
                  background: "var(--surface, #fff)", borderRadius: 12, width: 420, maxWidth: "94vw",
                  boxShadow: "0 8px 32px rgba(0,0,0,0.18)", padding: 24, color: "var(--text, #333)"
                }} onClick={(e) => e.stopPropagation()}>
                  <h3 style={{ margin: "0 0 12px", fontSize: 17 }}>确认删除考试组</h3>
                  <p style={{ margin: 0, fontSize: 14 }}>
                    将删除「<strong>{deleteGroupName}</strong>」。
                    该组关联了 <strong>{deleteCount}</strong> 场考试（考试本身不受影响）。
                  </p>
                  <p style={{ fontSize: 12, color: "var(--muted, #999)", margin: "12px 0 0" }}>
                    关联的考试仍可用于其他大考合集。
                  </p>
                  <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}>
                    <button onClick={() => setShowDeleteConfirm(false)} style={{
                      background: "var(--bg-secondary, #f3f4f6)", color: "var(--text, #333)", border: "1px solid var(--border, #d1d5db)",
                      borderRadius: 6, padding: "8px 20px", fontSize: 13, cursor: "pointer"
                    }}>取消</button>
                    <button onClick={deleteCrossGroup} style={{
                      background: "#dc2626", color: "#fff", border: "none",
                      borderRadius: 6, padding: "8px 20px", fontSize: 13, cursor: "pointer", fontWeight: 500
                    }}>确认删除</button>
                  </div>
                </div>
              </div>
            )}

            {/* Results */}
            {crossMessage && <div style={{ padding: 12, color: "var(--muted)", fontSize: 13, textAlign: "center", marginBottom: 12 }}>{crossMessage}</div>}
            {crossLoading && <div style={{ padding: 40, color: "var(--muted)", fontSize: 14, textAlign: "center" }}>正在统计跨考试总成绩...</div>}
            {crossResult && !crossLoading && <CrossResultTable result={crossResult} rows={crossFilteredRows} search={crossSearch} setSearch={setCrossSearch} />}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Sub-components ──

function FilterCol({ label, children }: { label: string; children: React.ReactNode }) {
  return <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}><span style={{ color: "var(--muted)" }}>{label}</span>{children}</div>;
}

function toggleBtn(active: boolean): React.CSSProperties {
  return {
    padding: "5px 12px", border: "none", background: active ? "var(--brand)" : "var(--surface)",
    color: active ? "#fff" : "var(--text)", fontSize: 12, cursor: "pointer", fontWeight: active ? 600 : 400,
    display: "flex", alignItems: "center", gap: 4
  };
}

function CrossModeBtn({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button onClick={onClick} style={{
      display: "flex", alignItems: "center", gap: 6, padding: "6px 12px",
      border: `1px solid ${active ? "var(--brand)" : "var(--border)"}`,
      background: active ? "var(--bg-accent)" : "var(--surface)",
      color: active ? "var(--brand)" : "var(--text)", borderRadius: 8,
      cursor: "pointer", fontSize: 13, fontWeight: active ? 600 : 400, height: 34
    }}>{icon}{label}</button>
  );
}

function ExamListTable({ exams, onSelect }: { exams: ExamFilterItem[]; onSelect: (id: number) => void }) {
  return (
    <div className="exam-list-table">
      <div className="exam-list-head">
        <span style={{ flex: 1, minWidth: 200 }}>考试名称</span>
        <span style={{ width: 80 }}>科目</span>
        <span style={{ width: 80 }}>年级</span>
        <span style={{ width: 100 }}>日期</span>
        <span style={{ width: 70, textAlign: "center" }}>已阅</span>
        <span style={{ width: 70, textAlign: "center" }}>均分</span>
        <span style={{ width: 80, textAlign: "center" }}>状态</span>
      </div>
      {exams.map((exam) => (
        <div key={exam.id} className="exam-list-row" onClick={() => onSelect(exam.id)} role="button" tabIndex={0}
          onKeyDown={(e) => { if (e.key === "Enter") onSelect(exam.id); }}>
          <span style={{ flex: 1, minWidth: 200, fontWeight: 500 }}>{exam.name}</span>
          <span style={{ width: 80, color: "var(--muted)" }}>{exam.subject || "—"}</span>
          <span style={{ width: 80, color: "var(--muted)" }}>{exam.grade_name || "—"}</span>
          <span style={{ width: 100, color: "var(--muted)", fontSize: 12 }}>{exam.exam_date || "—"}</span>
          <span style={{ width: 70, textAlign: "center", fontWeight: 500 }}>{exam.graded_count}</span>
          <span style={{ width: 70, textAlign: "center", fontWeight: 500 }}>{exam.graded_count > 0 ? exam.avg_score : "—"}</span>
          <span style={{ width: 80, textAlign: "center" }}>
            <span className={`exam-list-badge exam-list-badge-${exam.status}`}>
              {exam.status === "closed" ? "已完成" : exam.status === "grading" ? "阅卷中" : exam.status === "draft" ? "草稿" : exam.status}
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

function GroupListTable({ groups, onSelect }: { groups: ExamGroupFilterItem[]; onSelect?: (id: number) => void }) {
  return (
    <div className="exam-list-table">
      <div className="exam-list-head">
        <span style={{ flex: 1, minWidth: 180 }}>大考名称</span>
        <span style={{ width: 80 }}>标签</span>
        <span style={{ width: 80 }}>年级</span>
        <span style={{ width: 60, textAlign: "center" }}>含考试数</span>
        <span style={{ width: 80, textAlign: "center" }}>有无成绩</span>
        <span style={{ width: 100 }}>创建日期</span>
      </div>
      {groups.map((g: any) => (
        <div key={g.id} className="exam-list-row" onClick={() => onSelect?.(g.id)} role="button" tabIndex={0}
          onKeyDown={(e) => { if (e.key === "Enter") onSelect?.(g.id); }} style={{ cursor: "pointer" }}>
          <span style={{ flex: 1, minWidth: 180, fontWeight: 500 }}>{g.name}</span>
          <span style={{ width: 80 }}>
            <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 10, fontSize: 11, background: g.tag ? "var(--primary)" : "var(--bg-secondary)", color: g.tag ? "#fff" : "var(--muted)" }}>{g.tag || "—"}</span>
          </span>
          <span style={{ width: 80, color: "var(--muted)" }}>{g.grade_name || "—"}</span>
          <span style={{ width: 60, textAlign: "center", fontWeight: 500 }}>{g.member_count}</span>
          <span style={{ width: 80, textAlign: "center" }}>
            <span className={`exam-list-badge ${g.has_results ? "exam-list-badge-closed" : "exam-list-badge-draft"}`}>{g.has_results ? "有成绩" : "无成绩"}</span>
          </span>
          <span style={{ width: 100, color: "var(--muted)", fontSize: 12 }}>{g.created_at ? g.created_at.slice(0, 10) : "—"}</span>
        </div>
      ))}
    </div>
  );
}

function CrossResultTable({ result, rows, search, setSearch }: {
  result: CrossExamTotalResponse; rows: CrossExamTotalResponse["rows"]; search: string; setSearch: (v: string) => void;
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
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索姓名/学号/班级" style={{ border: "none", outline: "none", background: "transparent" }} />
          </div>
        </div>
        <div style={{ overflowX: "auto", border: "1px solid var(--line)", borderRadius: 10 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, background: "var(--surface)" }}>
            <thead>
              <tr style={{ background: "var(--surface-tint)", borderBottom: "2px solid var(--line)" }}>
                <th style={thStyle}>年排</th><th style={thStyle}>班排</th><th style={thStyle}>姓名</th><th style={thStyle}>班级</th>
                <th style={thStyle}>总分</th><th style={thStyle}>得分率</th><th style={thStyle}>出勤</th>
                {result.exams.map((exam) => <th key={exam.id} style={thStyle}>{exam.name.length > 8 ? exam.name.slice(0, 8) + "..." : exam.name}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={row.studentId} style={{ borderTop: "1px solid var(--line-light)", background: index % 2 === 0 ? "var(--surface)" : "var(--bg-soft)" }}>
                  <td style={tdStyle}>{row.gradeRank}</td><td style={tdStyle}>{row.classRank}</td>
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
  return <div className="overview-info-card"><span className="overview-info-value">{value}</span><span className="overview-info-label">{label}</span></div>;
}

const thStyle: React.CSSProperties = { padding: "9px 10px", textAlign: "left", fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", whiteSpace: "nowrap" };
const tdStyle: React.CSSProperties = { padding: "8px 10px", verticalAlign: "top", whiteSpace: "nowrap" };
const inputStyle: React.CSSProperties = { padding: "8px 10px", borderRadius: 6, border: "1px solid var(--line-strong)", fontSize: 13, background: "var(--surface)", minWidth: 200 };
