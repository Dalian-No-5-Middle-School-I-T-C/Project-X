import { useEffect, useMemo, useState } from "react";
import { Search, ChevronRight } from "lucide-react";
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

  const hasActiveFilters = academicYear || gradeId || subject;

  return (
    <div style={{ padding: "24px 32px", overflowY: "auto", flex: 1 }}>
      <div style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0, marginBottom: 4 }}>考试选择</h2>
        <p style={{ fontSize: 13, color: "var(--muted)", margin: 0 }}>选择学年、年级和学科后查看考试</p>
      </div>

      {/* Filter row */}
      <div style={{
        display: "flex", gap: 12, marginBottom: 28,
        flexWrap: "wrap", alignItems: "center"
      }}>
        <div className="exam-filter-group">
          <label style={{ fontSize: 12, color: "var(--muted)", display: "block", marginBottom: 4 }}>学年</label>
          <select
            value={academicYear}
            onChange={(e) => setAcademicYear(e.target.value)}
            style={{
              padding: "10px 14px", borderRadius: 10, border: "1px solid var(--line-strong)",
              fontSize: 14, minWidth: 160, background: "#fff", cursor: "pointer"
            }}
          >
            <option value="">全部学年</option>
            {filters.academicYears.map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </div>

        <div className="exam-filter-group">
          <label style={{ fontSize: 12, color: "var(--muted)", display: "block", marginBottom: 4 }}>年级</label>
          <select
            value={gradeId}
            onChange={(e) => setGradeId(e.target.value)}
            style={{
              padding: "10px 14px", borderRadius: 10, border: "1px solid var(--line-strong)",
              fontSize: 14, minWidth: 130, background: "#fff", cursor: "pointer"
            }}
          >
            <option value="">全部年级</option>
            {grades.map((g) => (
              <option key={g.id} value={String(g.id)}>{g.name}</option>
            ))}
          </select>
        </div>

        <div className="exam-filter-group">
          <label style={{ fontSize: 12, color: "var(--muted)", display: "block", marginBottom: 4 }}>学科</label>
          <select
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            style={{
              padding: "10px 14px", borderRadius: 10, border: "1px solid var(--line-strong)",
              fontSize: 14, minWidth: 130, background: "#fff", cursor: "pointer"
            }}
          >
            <option value="">全部学科</option>
            {filters.subjects.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>

        {exams.length > 0 && (
          <span style={{ marginLeft: 8, fontSize: 13, color: "var(--muted)", alignSelf: "flex-end", paddingBottom: 10 }}>
            共 {exams.length} 场考试
          </span>
        )}
      </div>

      {/* Loading */}
      {loading && (
        <div style={{ textAlign: "center", padding: 60, color: "var(--muted)", fontSize: 14 }}>
          正在加载考试列表...
        </div>
      )}

      {/* Empty state */}
      {!loading && exams.length === 0 && (
        <div style={{ textAlign: "center", padding: 60 }}>
          <div style={{ fontSize: 48, marginBottom: 12, opacity: 0.3 }}>
            <Search size={48} />
          </div>
          <p style={{ fontSize: 15, color: "var(--muted)", margin: 0 }}>
            {hasActiveFilters ? "当前筛选条件下暂无考试" : "暂无考试，请在「考试管理」中创建"}
          </p>
        </div>
      )}

      {/* Exam card grid */}
      {!loading && exams.length > 0 && (
        <div className="exam-select-grid">
          {exams.map((exam) => (
            <div
              key={exam.id}
              className="exam-select-card"
              onClick={() => onSelectExam(exam.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === "Enter") onSelectExam(exam.id); }}
            >
              <div className="exam-select-card-header">
                <span className="exam-select-card-subject">
                  {exam.subject || "综合"}
                </span>
                {exam.exam_date && (
                  <span className="exam-select-card-date">{exam.exam_date}</span>
                )}
              </div>
              <div className="exam-select-card-title">{exam.name}</div>
              {exam.grade_name && (
                <div className="exam-select-card-grade">{exam.grade_name}</div>
              )}
              <div className="exam-select-card-stats">
                <div className="exam-select-stat">
                  <span className="exam-select-stat-value">{exam.graded_count}</span>
                  <span className="exam-select-stat-label">已阅人数</span>
                </div>
                <div className="exam-select-stat">
                  <span className="exam-select-stat-value">
                    {exam.graded_count > 0 ? exam.avg_score : "—"}
                  </span>
                  <span className="exam-select-stat-label">平均分</span>
                </div>
                <div className="exam-select-stat">
                  <span className="exam-select-stat-value" style={{
                    padding: "1px 8px", borderRadius: 10, fontSize: 11,
                    background: exam.status === "closed" ? "#dcfce7" : exam.status === "grading" ? "#fef3c7" : "#f3f4f6",
                    color: exam.status === "closed" ? "#166534" : exam.status === "grading" ? "#92400e" : "#6b7280"
                  }}>
                    {exam.status === "closed" ? "已完成" : exam.status === "grading" ? "阅卷中" : exam.status === "draft" ? "草稿" : exam.status}
                  </span>
                  <span className="exam-select-stat-label">状态</span>
                </div>
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", marginTop: 8, color: "var(--brand)", fontSize: 13, fontWeight: 500 }}>
                查看详情 <ChevronRight size={16} style={{ marginLeft: 2 }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
