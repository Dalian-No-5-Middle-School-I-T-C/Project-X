import { useCallback, useEffect, useState } from "react";
import { Plus, RefreshCw, Trash2, UserMinus, UserPlus } from "lucide-react";
import { fetchJson } from "../auth/api";
import type { ClassRecord, ClassStudent, GradeRecord, UserListItem, UsersListResponse } from "../auth/types";

export function ClassManagement() {
  const [grades, setGrades] = useState<GradeRecord[]>([]);
  const [classes, setClasses] = useState<ClassRecord[]>([]);
  const [selectedGradeId, setSelectedGradeId] = useState<number | null>(null);
  const [selectedClassId, setSelectedClassId] = useState<number | null>(null);
  const [roster, setRoster] = useState<ClassStudent[]>([]);
  const [newGradeName, setNewGradeName] = useState("");
  const [newClassName, setNewClassName] = useState("");
  const [studentSearch, setStudentSearch] = useState("");
  const [studentResults, setStudentResults] = useState<UserListItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const loadGrades = useCallback(async () => {
    const data = await fetchJson<GradeRecord[]>("/api/classes/grades");
    setGrades(data);
    setSelectedGradeId((current) => (current === null && data.length > 0 ? data[0].id : current));
  }, []);

  const loadClasses = useCallback(async (gradeId: number | null) => {
    const url = gradeId ? `/api/classes?gradeId=${gradeId}` : "/api/classes";
    const data = await fetchJson<ClassRecord[]>(url);
    setClasses(data);
    setSelectedClassId((current) => {
      if (data.length === 0) return null;
      if (current !== null && data.some((c) => c.id === current)) return current;
      return data[0].id;
    });
    if (data.length === 0) setRoster([]);
  }, []);

  const loadRoster = useCallback(async (classId: number) => {
    const data = await fetchJson<ClassStudent[]>(`/api/classes/${classId}/students`);
    setRoster(data);
  }, []);

  useEffect(() => {
    void (async () => {
      setBusy(true);
      try {
        await loadGrades();
      } catch (err) {
        setError(err instanceof Error ? err.message : "加载年级失败");
      } finally {
        setBusy(false);
      }
    })();
  }, [loadGrades]);

  useEffect(() => {
    if (selectedGradeId === null) return;
    void (async () => {
      setBusy(true);
      try {
        await loadClasses(selectedGradeId);
      } catch (err) {
        setError(err instanceof Error ? err.message : "加载班级失败");
      } finally {
        setBusy(false);
      }
    })();
  }, [selectedGradeId, loadClasses]);

  useEffect(() => {
    if (selectedClassId === null) return;
    void (async () => {
      try {
        await loadRoster(selectedClassId);
      } catch (err) {
        setError(err instanceof Error ? err.message : "加载花名册失败");
      }
    })();
  }, [selectedClassId, loadRoster]);

  async function createGrade() {
    if (!newGradeName.trim()) return;
    setBusy(true);
    setError("");
    try {
      await fetchJson("/api/classes/grades", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newGradeName.trim() })
      });
      setNewGradeName("");
      await loadGrades();
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建年级失败");
    } finally {
      setBusy(false);
    }
  }

  async function deleteGrade(id: number, name: string) {
    if (!confirm(`删除年级「${name}」及其下所有班级？`)) return;
    setBusy(true);
    try {
      await fetchJson(`/api/classes/grades/${id}`, { method: "DELETE" });
      if (selectedGradeId === id) setSelectedGradeId(null);
      await loadGrades();
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除失败");
    } finally {
      setBusy(false);
    }
  }

  async function createClass() {
    if (!selectedGradeId || !newClassName.trim()) return;
    setBusy(true);
    setError("");
    try {
      await fetchJson("/api/classes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gradeId: selectedGradeId, name: newClassName.trim() })
      });
      setNewClassName("");
      await loadClasses(selectedGradeId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建班级失败");
    } finally {
      setBusy(false);
    }
  }

  async function deleteClass(id: number, name: string) {
    if (!confirm(`删除班级「${name}」？`)) return;
    setBusy(true);
    try {
      await fetchJson(`/api/classes/${id}`, { method: "DELETE" });
      if (selectedClassId === id) setSelectedClassId(null);
      if (selectedGradeId) await loadClasses(selectedGradeId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除失败");
    } finally {
      setBusy(false);
    }
  }

  async function searchStudents() {
    if (!studentSearch.trim()) return;
    try {
      const result = await fetchJson<UsersListResponse>(
        `/api/users?role=student&keyword=${encodeURIComponent(studentSearch.trim())}&pageSize=10`
      );
      setStudentResults(result.users);
    } catch (err) {
      setError(err instanceof Error ? err.message : "搜索失败");
    }
  }

  async function addStudent(studentId: number) {
    if (!selectedClassId) return;
    setBusy(true);
    try {
      await fetchJson(`/api/classes/${selectedClassId}/students`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentId })
      });
      await loadRoster(selectedClassId);
      if (selectedGradeId) await loadClasses(selectedGradeId);
      setStudentResults([]);
      setStudentSearch("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "添加失败");
    } finally {
      setBusy(false);
    }
  }

  async function removeStudent(studentId: number, name: string) {
    if (!selectedClassId || !confirm(`将「${name}」移出班级？`)) return;
    setBusy(true);
    try {
      await fetchJson(`/api/classes/${selectedClassId}/students/${studentId}`, { method: "DELETE" });
      await loadRoster(selectedClassId);
      if (selectedGradeId) await loadClasses(selectedGradeId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "移除失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="account-panel class-management">
      <div className="account-panel-header">
        <strong>班级管理</strong>
        <button className="ghost-button" type="button" onClick={() => void loadGrades()} disabled={busy}>
          <RefreshCw size={16} /> 刷新
        </button>
      </div>

      {error && <p className="login-error">{error}</p>}

      <div className="class-layout">
        <section className="class-column">
          <div className="class-column-title">年级</div>
          <div className="class-add-row">
            <input placeholder="新年级名称" value={newGradeName} onChange={(e) => setNewGradeName(e.target.value)} disabled={busy} />
            <button className="primary-button" type="button" onClick={() => void createGrade()} disabled={busy}>
              <Plus size={14} />
            </button>
          </div>
          <div className="class-list">
            {grades.map((g) => (
              <div key={g.id} className={`class-list-item ${selectedGradeId === g.id ? "active" : ""}`}>
                <button type="button" onClick={() => setSelectedGradeId(g.id)}>{g.name}</button>
                <button type="button" className="icon-btn danger" title="删除年级" onClick={() => void deleteGrade(g.id, g.name)} disabled={busy}>
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
            {grades.length === 0 && <p className="empty-text">暂无年级</p>}
          </div>
        </section>

        <section className="class-column">
          <div className="class-column-title">班级</div>
          <div className="class-add-row">
            <input placeholder="新班级名称" value={newClassName} onChange={(e) => setNewClassName(e.target.value)} disabled={busy || !selectedGradeId} />
            <button className="primary-button" type="button" onClick={() => void createClass()} disabled={busy || !selectedGradeId}>
              <Plus size={14} />
            </button>
          </div>
          <div className="class-list">
            {classes.map((c) => (
              <div key={c.id} className={`class-list-item ${selectedClassId === c.id ? "active" : ""}`}>
                <button type="button" onClick={() => setSelectedClassId(c.id)}>
                  {c.name}
                  <small>{c.student_count ?? 0} 人</small>
                </button>
                <button type="button" className="icon-btn danger" title="删除班级" onClick={() => void deleteClass(c.id, c.name)} disabled={busy}>
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
            {classes.length === 0 && <p className="empty-text">该年级暂无班级</p>}
          </div>
        </section>

        <section className="class-column roster-column">
          <div className="class-column-title">花名册</div>
          {selectedClassId ? (
            <>
              <div className="class-add-row">
                <input
                  placeholder="搜索学生学号/姓名"
                  value={studentSearch}
                  onChange={(e) => setStudentSearch(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void searchStudents()}
                  disabled={busy}
                />
                <button className="ghost-button" type="button" onClick={() => void searchStudents()} disabled={busy}>
                  <UserPlus size={14} />
                </button>
              </div>
              {studentResults.length > 0 && (
                <div className="student-search-results">
                  {studentResults.map((s) => (
                    <button key={s.id} type="button" className="student-search-item" onClick={() => void addStudent(s.id)} disabled={busy}>
                      {s.name} ({s.student_number ?? s.username})
                    </button>
                  ))}
                </div>
              )}
              <div className="roster-list">
                {roster.map((s) => (
                  <div key={s.student_id} className="roster-item">
                    <span>{s.name}</span>
                    <small>{s.student_number ?? s.username}</small>
                    <button type="button" className="icon-btn danger" title="移出班级" onClick={() => void removeStudent(s.student_id, s.name)} disabled={busy}>
                      <UserMinus size={13} />
                    </button>
                  </div>
                ))}
                {roster.length === 0 && <p className="empty-text">班级暂无学生</p>}
              </div>
            </>
          ) : (
            <p className="empty-text">请先选择班级</p>
          )}
        </section>
      </div>
    </div>
  );
}
