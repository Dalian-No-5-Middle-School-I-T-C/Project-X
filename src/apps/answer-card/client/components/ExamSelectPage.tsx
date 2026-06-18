import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { fetchJson } from "../auth/api";
import type { ExamFilterItem } from "../../../../shared/types";

interface Props {
  onSelectExam: (examId: number) => void;
}

interface FilterOptions {
  academicYears: string[];
  subjects: string[];
}

export function ExamSelectPage({ onSelectExam }: Props) {
  const [filters, setFilters] = useState<FilterOptions>({ academicYears: [], subjects: [] });
  const [academicYear, setAcademicYear] = useState("");
  const [gradeId, setGradeId] = useState("");
  const [subject, setSubject] = useState("");
  const [exams, setExams] = useState<ExamFilterItem[]>([]);
  const [grades, setGrades] = useState<Array<{ id: number; name: string }>>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchJson<FilterOptions>("/api/exams/filters")
      .then(setFilters)
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchJson<Array<{ id: number; name: string }>>("/api/grades")
      .then(setGrades)
      .catch(() => setGrades([]));
  }, []);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ selection: "1" });
    if (academicYear) params.set("academic_year", academicYear);
    if (gradeId) params.set("grade_id", gradeId);
    if (subject) params.set("subject", subject);

    fetchJson<ExamFilterItem[]>(`/api/exams?${params.toString()}`)
      .then(setExams)
      .catch(() => setExams([]))
      .finally(() => setLoading(false));
  }, [academicYear, gradeId, subject]);

  return (
    <div style={{ padding: "24px 32px", overflowY: "auto", flex: 1 }}>
      <div style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0, marginBottom: 4 }}>考试选择</h2>
        <p style={{ fontSize: 13, color: "var(--muted)", margin: 0 }}>选择学年、年级和学科后查看考试</p>
      </div>

      {/* Filter row - larger selects with proper alignment */}
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

        {exams.length > 0 && (
          <span style={{ fontSize: 13, color: "var(--muted)", paddingBottom: 10, alignSelf: "flex-end" }}>
            共 {exams.length} 场考试
          </span>
        )}
      </div>

      {loading && (
        <div style={{ textAlign: "center", padding: 60, color: "var(--muted)", fontSize: 14 }}>
          正在加载考试列表...
        </div>
      )}

      {!loading && exams.length === 0 && (
        <div style={{ textAlign: "center", padding: 60 }}>
          <Search size={48} style={{ opacity: 0.3, marginBottom: 12 }} />
          <p style={{ fontSize: 15, color: "var(--muted)", margin: 0 }}>
            暂无考试，请在「考试管理」中创建
          </p>
        </div>
      )}

      {/* Horizontal list rows (table style) */}
      {!loading && exams.length > 0 && (
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
    </div>
  );
}
