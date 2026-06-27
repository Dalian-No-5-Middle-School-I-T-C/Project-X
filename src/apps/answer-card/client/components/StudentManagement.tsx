import { useCallback, useEffect, useState } from "react";
import { Download, Plus, RefreshCw, Trash2, Upload } from "lucide-react";
import { fetchJson } from "../auth/api";
import { getAuthToken } from "../auth/api";
import type { GradeRecord, ClassRecord, StudentWithClass } from "../auth/types";
import { ImportModal } from "./ImportModal";

export function StudentManagement() {
  const [grades, setGrades] = useState<GradeRecord[]>([]);
  const [classes, setClasses] = useState<ClassRecord[]>([]);
  const [students, setStudents] = useState<StudentWithClass[]>([]);
  const [selectedGradeId, setSelectedGradeId] = useState<number | null>(null);
  const [selectedClassId, setSelectedClassId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // 导入弹窗
  const [showImport, setShowImport] = useState(false);

  // 新建学生弹窗
  const [showNewStudent, setShowNewStudent] = useState(false);
  const [newStudentName, setNewStudentName] = useState("");
  const [newStudentNumber, setNewStudentNumber] = useState("");

  const loadGrades = useCallback(async () => {
    const data = await fetchJson<GradeRecord[]>("/api/classes/grades");
    setGrades(data);
    if (data.length > 0 && selectedGradeId === null) setSelectedGradeId(data[0].id);
  }, [selectedGradeId]);

  const loadClasses = useCallback(async (gradeId: number | null) => {
    if (!gradeId) { setClasses([]); setSelectedClassId(null); return; }
    const data = await fetchJson<ClassRecord[]>(`/api/classes?gradeId=${gradeId}`);
    setClasses(data);
    if (data.length > 0) {
      setSelectedClassId((prev) => {
        if (prev && data.some((c) => c.id === prev)) return prev;
        return data[0].id;
      });
    } else {
      setSelectedClassId(null);
    }
  }, []);

  const loadStudents = useCallback(async (classId: number | null) => {
    if (!classId) { setStudents([]); return; }
    try {
      const data = await fetchJson<StudentWithClass[]>(`/api/classes/${classId}/students`);
      // 补充 class/grade 信息
      const cls = classes.find((c) => c.id === classId);
      const grade = grades.find((g) => g.id === cls?.grade_id);
      const enriched = data.map((s) => ({
        ...s,
        class_id: classId,
        class_name: cls?.name ?? "",
        grade_id: cls?.grade_id ?? 0,
        grade_name: grade?.name ?? ""
      }));
      setStudents(enriched);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载学生失败");
    }
  }, [classes, grades]);

  useEffect(() => { void loadGrades(); }, [loadGrades]);
  useEffect(() => { void loadClasses(selectedGradeId); }, [selectedGradeId, loadClasses]);
  useEffect(() => { void loadStudents(selectedClassId); }, [selectedClassId, loadStudents]);

  async function handleRefresh() {
    setBusy(true);
    setError("");
    try {
      await loadGrades();
      await loadClasses(selectedGradeId);
      await loadStudents(selectedClassId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "刷新失败");
    } finally {
      setBusy(false);
    }
  }

  async function handleImport(csvText: string) {
    await fetchJson("/api/users/import-csv", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ csvText })
    });
    await handleRefresh();
  }

  function handleExport() {
    if (!confirm("导出文件将包含学生明文密码，请妥善保管！\n确定要下载吗？")) return;
    const token = getAuthToken();
    fetch("/api/export/students", { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then(async (res) => {
        if (!res.ok) throw new Error(await res.text());
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "student_accounts.xlsx";
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "导出失败"));
  }

  async function handleCreateStudent() {
    if (!newStudentName.trim() || !newStudentNumber.trim()) return;
    setBusy(true);
    setError("");
    try {
      await fetchJson("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: newStudentNumber.trim(),
          name: newStudentName.trim(),
          role: "student",
          student_number: newStudentNumber.trim()
        })
      });
      setShowNewStudent(false);
      setNewStudentName("");
      setNewStudentNumber("");
      await handleRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建学生失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="account-panel student-management">
      <div className="account-panel-header">
        <strong>学生管理</strong>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="ghost-button" type="button" onClick={handleRefresh} disabled={busy}>
            <RefreshCw size={14} /> 刷新
          </button>
          <button className="ghost-button" type="button" onClick={() => { setShowNewStudent(true); setNewStudentName(""); setNewStudentNumber(""); }} disabled={busy}>
            <Plus size={14} /> 新建学生
          </button>
          <button className="ghost-button" type="button" onClick={() => setShowImport(true)} disabled={busy}>
            <Download size={14} /> 导入学生
          </button>
          <button className="primary-button" type="button" onClick={handleExport}>
            <Upload size={14} /> 导出学生账密
          </button>
        </div>
      </div>

      {error && <p className="login-error">{error}</p>}

      <div className="class-layout">
        {/* 年级 */}
        <section className="class-column">
          <div className="class-column-title">年级</div>
          <div className="class-list">
            {grades.map((g) => (
              <div key={g.id} className={`class-list-item ${selectedGradeId === g.id ? "active" : ""}`}>
                <button type="button" onClick={() => setSelectedGradeId(g.id)}>{g.name}</button>
              </div>
            ))}
            {grades.length === 0 && <p className="empty-text">暂无年级</p>}
          </div>
        </section>

        {/* 班级 */}
        <section className="class-column">
          <div className="class-column-title">班级</div>
          <div className="class-list">
            {classes.map((c) => (
              <div key={c.id} className={`class-list-item ${selectedClassId === c.id ? "active" : ""}`}>
                <button type="button" onClick={() => setSelectedClassId(c.id)}>
                  {c.name}
                  <small>{c.student_count ?? 0} 人</small>
                </button>
              </div>
            ))}
            {classes.length === 0 && <p className="empty-text">该年级暂无班级</p>}
          </div>
        </section>

        {/* 花名册 */}
        <section className="class-column roster-column">
          <div className="class-column-title">花名册</div>
          {selectedClassId ? (
            <>
              <div className="account-table-wrap" style={{ overflow: "auto", flex: 1, minHeight: 0 }}>
                <table className="account-table">
                  <thead>
                    <tr>
                      <th>学号</th>
                      <th>姓名</th>
                      <th>账号</th>
                    </tr>
                  </thead>
                  <tbody>
                    {students.map((s) => (
                      <tr key={s.student_id}>
                        <td>{s.student_number}</td>
                        <td>{s.name}</td>
                        <td style={{ fontFamily: "monospace", fontSize: 12 }}>{s.username}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {students.length === 0 && <p className="empty-text">该班级暂无学生</p>}
              <p className="hint" style={{ padding: "4px 8px", fontSize: 11 }}>
                共 {students.length} 名学生
              </p>
            </>
          ) : (
            <p className="empty-text">请选择班级</p>
          )}
        </section>
      </div>

      {showImport && (
        <ImportModal
          title="批量导入学生"
          csvType="student"
          onImport={handleImport}
          onClose={() => setShowImport(false)}
        />
      )}

      {/* ── 新建学生弹窗 ────────────────────────────────── */}
      {showNewStudent && (
        <div className="modal-backdrop" onClick={() => setShowNewStudent(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ width: 400, maxWidth: "90vw" }}>
            <div className="modal-header">
              <h2>新建学生</h2>
              <button className="modal-close" onClick={() => setShowNewStudent(false)}>✕</button>
            </div>
            <div className="modal-body">
              <label>
                学号
                <input value={newStudentNumber} onChange={(e) => setNewStudentNumber(e.target.value)} placeholder="学号（默认作为用户名和初始密码）" disabled={busy} />
              </label>
              <label>
                姓名
                <input value={newStudentName} onChange={(e) => setNewStudentName(e.target.value)} placeholder="学生姓名" disabled={busy} />
              </label>
            </div>
            <div className="modal-footer">
              <button className="ghost-button" type="button" onClick={() => setShowNewStudent(false)}>取消</button>
              <button className="primary-button" type="button" onClick={() => void handleCreateStudent()} disabled={busy || !newStudentName.trim() || !newStudentNumber.trim()}>
                创建学生
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
