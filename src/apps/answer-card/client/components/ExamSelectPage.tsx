import { useEffect, useState } from "react";
import { Layers, Search } from "lucide-react";
import { fetchJson } from "../auth/api";
import type { ExamFilterItem, ExamGroupFilterItem } from "../../../../shared/types";

interface Props {
  onSelectExam: (examId: number) => void;
  onSelectGroup?: (groupId: number) => void;
}

interface FilterOptions {
  academicYears: string[];
  subjects: string[];
}

type ViewMode = "single" | "group";

export function ExamSelectPage({ onSelectExam, onSelectGroup }: Props) {
  const [mode, setMode] = useState<ViewMode>("single");
  const [filters, setFilters] = useState<FilterOptions>({ academicYears: [], subjects: [] });
  const [academicYear, setAcademicYear] = useState("");
  const [gradeId, setGradeId] = useState("");
  const [subject, setSubject] = useState("");
  const [exams, setExams] = useState<ExamFilterItem[]>([]);
  const [groupExams, setGroupExams] = useState<ExamGroupFilterItem[]>([]);
  const [grades, setGrades] = useState<Array<{ id: number; name: string }>>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchJson<FilterOptions>("/api/exams/filters")
      .then(setFilters)
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchJson<Array<{ id: number; name: string }>>("/api/classes/grades")
      .then(setGrades)
      .catch(() => setGrades([]));
  }, []);

  // Load single exams
  useEffect(() => {
    if (mode !== "single") return;
    setLoading(true);
    const params = new URLSearchParams({ selection: "1" });
    if (academicYear) params.set("academic_year", academicYear);
    if (gradeId) params.set("grade_id", gradeId);
    if (subject) params.set("subject", subject);

    fetchJson<ExamFilterItem[]>(`/api/exams?${params.toString()}`)
      .then(setExams)
      .catch(() => setExams([]))
      .finally(() => setLoading(false));
  }, [mode, academicYear, gradeId, subject]);

  // Load exam groups
  useEffect(() => {
    if (mode !== "group") return;
    setLoading(true);
    const params = new URLSearchParams();
    if (gradeId) params.set("grade_id", gradeId);

    fetchJson<ExamGroupFilterItem[]>(`/api/exam-groups?${params.toString()}`)
      .then(setGroupExams)
      .catch(() => setGroupExams([]))
      .finally(() => setLoading(false));
  }, [mode, gradeId]);

  return (
    <div style={{ padding: "24px 32px", overflowY: "auto", flex: 1 }}>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0, marginBottom: 4 }}>考试选择</h2>
          <p style={{ fontSize: 13, color: "var(--muted)", margin: 0 }}>选择单科考试或大考合集查看成绩</p>
        </div>

        {/* Mode toggle — right side, same height as title */}
        <div style={{ display: "flex", gap: 0, border: "1.5px solid var(--brand)", borderRadius: 6, overflow: "hidden", flexShrink: 0 }}>
          <button onClick={() => setMode("single")} style={{
            padding: "5px 14px", border: "none", background: mode === "single" ? "var(--brand)" : "var(--surface)",
            color: mode === "single" ? "#fff" : "var(--text)", fontSize: 12, cursor: "pointer", fontWeight: mode === "single" ? 600 : 400
          }}>单科考试</button>
          <button onClick={() => setMode("group")} style={{
            padding: "5px 14px", border: "none", background: mode === "group" ? "var(--brand)" : "var(--surface)",
            color: mode === "group" ? "#fff" : "var(--text)", fontSize: 12, cursor: "pointer", fontWeight: mode === "group" ? 600 : 400,
            display: "flex", alignItems: "center", gap: 4
          }}><Layers size={13} /> 大考</button>
        </div>
      </div>

      {/* Filter row */}
      <div style={{
        display: "flex", gap: 12, marginBottom: 24,
        flexWrap: "wrap", alignItems: "flex-end"
      }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1 }}>学年</label>
          <select
            value={academicYear}
            onChange={(e) => setAcademicYear(e.target.value)}
            className="exam-filter-select"
          >
            <option value="">全部学年</option>
            {filters.academicYears.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1 }}>年级</label>
          <select
            value={gradeId}
            onChange={(e) => setGradeId(e.target.value)}
            className="exam-filter-select"
          >
            <option value="">全部年级</option>
            {grades.map((g) => <option key={g.id} value={String(g.id)}>{g.name}</option>)}
          </select>
        </div>

        {mode === "single" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1 }}>学科</label>
            <select
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="exam-filter-select"
            >
              <option value="">全部学科</option>
              {filters.subjects.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        )}

        {((mode === "single" && exams.length > 0) || (mode === "group" && groupExams.length > 0)) && (
          <span style={{ fontSize: 13, color: "var(--muted)", paddingBottom: 10, alignSelf: "flex-end" }}>
            共 {mode === "single" ? exams.length : groupExams.length} {mode === "single" ? "场考试" : "个大考"}
          </span>
        )}
      </div>

      {loading && (
        <div style={{ textAlign: "center", padding: 60, color: "var(--muted)", fontSize: 14 }}>
          正在加载...
        </div>
      )}

      {/* Single exam list */}
      {mode === "single" && !loading && exams.length === 0 && (
        <div style={{ textAlign: "center", padding: 60 }}>
          <Search size={48} style={{ opacity: 0.3, marginBottom: 12 }} />
          <p style={{ fontSize: 15, color: "var(--muted)", margin: 0 }}>
            暂无考试，请在「考试管理」中创建
          </p>
        </div>
      )}

      {mode === "single" && !loading && exams.length > 0 && (
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
            <div
              key={exam.id}
              className="exam-list-row"
              onClick={() => onSelectExam(exam.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === "Enter") onSelectExam(exam.id); }}
            >
              <span style={{ flex: 1, minWidth: 200, fontWeight: 500 }}>{exam.name}</span>
              <span style={{ width: 80, color: "var(--muted)" }}>{exam.subject || "—"}</span>
              <span style={{ width: 80, color: "var(--muted)" }}>{exam.grade_name || "—"}</span>
              <span style={{ width: 100, color: "var(--muted)", fontSize: 12 }}>{exam.exam_date || "—"}</span>
              <span style={{ width: 70, textAlign: "center", fontWeight: 500 }}>{exam.graded_count}</span>
              <span style={{ width: 70, textAlign: "center", fontWeight: 500 }}>
                {exam.graded_count > 0 ? exam.avg_score : "—"}
              </span>
              <span style={{ width: 80, textAlign: "center" }}>
                <span className={`exam-list-badge exam-list-badge-${exam.status}`}>
                  {exam.status === "closed" ? "已完成" : exam.status === "grading" ? "阅卷中" : exam.status === "draft" ? "草稿" : exam.status}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Exam group list */}
      {mode === "group" && !loading && groupExams.length === 0 && (
        <div style={{ textAlign: "center", padding: 60 }}>
          <Layers size={48} style={{ opacity: 0.3, marginBottom: 12 }} />
          <p style={{ fontSize: 15, color: "var(--muted)", margin: 0 }}>
            暂无大考，请在「考试管理」中创建大考
          </p>
        </div>
      )}

      {mode === "group" && !loading && groupExams.length > 0 && (
        <div className="exam-list-table">
          <div className="exam-list-head">
            <span style={{ flex: 1, minWidth: 200 }}>大考名称</span>
            <span style={{ width: 80 }}>标签</span>
            <span style={{ width: 80 }}>年级</span>
            <span style={{ width: 60, textAlign: "center" }}>含考试数</span>
            <span style={{ width: 80, textAlign: "center" }}>有无成绩</span>
            <span style={{ width: 100 }}>创建日期</span>
          </div>
          {groupExams.map((group) => (
            <div
              key={group.id}
              className="exam-list-row"
              onClick={() => onSelectGroup?.(group.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === "Enter") onSelectGroup?.(group.id); }}
              style={{ cursor: "pointer" }}
            >
              <span style={{ flex: 1, minWidth: 200, fontWeight: 500 }}>{group.name}</span>
              <span style={{ width: 80 }}>
                <span style={{
                  display: "inline-block", padding: "2px 8px", borderRadius: 10,
                  fontSize: 11, background: group.tag ? "var(--primary)" : "var(--bg-secondary)",
                  color: group.tag ? "#fff" : "var(--muted)"
                }}>
                  {group.tag || "—"}
                </span>
              </span>
              <span style={{ width: 80, color: "var(--muted)" }}>{group.grade_name || "—"}</span>
              <span style={{ width: 60, textAlign: "center", fontWeight: 500 }}>{group.member_count}</span>
              <span style={{ width: 80, textAlign: "center" }}>
                <span className={`exam-list-badge ${group.has_results ? "exam-list-badge-closed" : "exam-list-badge-draft"}`}>
                  {group.has_results ? "有成绩" : "无成绩"}
                </span>
              </span>
              <span style={{ width: 100, color: "var(--muted)", fontSize: 12 }}>
                {group.created_at ? group.created_at.slice(0, 10) : "—"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
