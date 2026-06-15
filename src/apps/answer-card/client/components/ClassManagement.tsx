import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, RefreshCw, Trash2, UserMinus, UserPlus, Upload, X } from "lucide-react";
import { fetchJson } from "../auth/api";
import type { ClassRecord, ClassStudent, GradeRecord, UserListItem, UsersListResponse } from "../auth/types";

// ── CSV / 制表符解析工具 ───────────────────────────────────
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  for (const line of lines) {
    const sep = line.includes(",") ? "," : "\t";
    const cells: string[] = [];
    let cell = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
            cell += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          cell += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === sep) {
          cells.push(cell.trim());
          cell = "";
        } else {
          cell += ch;
        }
      }
    }
    cells.push(cell.trim());
    rows.push(cells);
  }
  return rows;
}

function extractStudents(rows: string[][]): Array<{ name: string; student_number: string; username: string }> {
  if (rows.length === 0) return [];
  const first = rows[0];
  const isHeader = first.some((c) => /姓名|name|学号|student_number|用户名|username/i.test(c));
  const dataRows = isHeader ? rows.slice(1) : rows;

  let nameIdx = -1,
    numberIdx = -1,
    usernameIdx = -1;
  if (isHeader) {
    for (let i = 0; i < first.length; i++) {
      const c = first[i].toLowerCase();
      if (/姓名|name/.test(c)) nameIdx = i;
      if (/学号|student_number|学号/.test(c)) numberIdx = i;
      if (/用户名|username/.test(c)) usernameIdx = i;
    }
  }
  if (nameIdx === -1) nameIdx = 0;
  if (numberIdx === -1) numberIdx = 1;
  if (usernameIdx === -1) usernameIdx = numberIdx;

  return dataRows
    .filter((r) => r[nameIdx]?.trim() && r[numberIdx]?.trim())
    .map((r) => ({
      name: r[nameIdx].trim(),
      student_number: r[numberIdx].trim(),
      username: r[usernameIdx]?.trim() || r[numberIdx].trim()
    }));
}

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

  // 导入弹窗状态
  const [showImportModal, setShowImportModal] = useState(false);
  const [importText, setImportText] = useState("");
  const [importPreview, setImportPreview] = useState<Array<{ name: string; student_number: string; username: string }>>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // 新建学生弹窗状态
  const [showNewStudentModal, setShowNewStudentModal] = useState(false);
  const [newStudentName, setNewStudentName] = useState("");
  const [newStudentNumber, setNewStudentNumber] = useState("");

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
    if (!newGradeName.trim()) {
      setError("请先填写年级名称");
      return;
    }
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
    if (!selectedGradeId) {
      setError("请先选择年级");
      return;
    }
    if (!newClassName.trim()) {
      setError("请先填写班级名称");
      return;
    }
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

  // ── 导入 ──────────────────────────────────────────────
  function previewImport(text: string) {
    const rows = parseCsv(text);
    const students = extractStudents(rows);
    setImportPreview(students);
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || "");
      setImportText(text);
      previewImport(text);
    };
    reader.readAsText(file);
  }

  async function handleImport() {
    if (!selectedClassId || importPreview.length === 0) return;
    setBusy(true);
    setError("");
    try {
      // 1) 批量创建学生
      const importResult = await fetchJson<{ created: number; skipped: number; errors: unknown[]; createdIds: number[] }>(
        "/api/users/import-students",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            students: importPreview.map((s) => ({
              username: s.username,
              name: s.name,
              student_number: s.student_number
            }))
          })
        }
      );

      // 2) 将创建成功的学生加入班级
      const ids = importResult.createdIds ?? [];
      if (ids.length > 0) {
        await fetchJson(`/api/classes/${selectedClassId}/students`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ studentIds: ids })
        });
      }

      // 3) 刷新
      await loadRoster(selectedClassId);
      if (selectedGradeId) await loadClasses(selectedGradeId);

      setShowImportModal(false);
      setImportText("");
      setImportPreview([]);
      setError(
        `导入完成：新创建 ${importResult.created} 人并加入班级，跳过 ${importResult.skipped} 人（已存在），错误 ${importResult.errors.length} 条。`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "导入失败");
    } finally {
      setBusy(false);
    }
  }

  // ── 新建学生 ───────────────────────────────────────────
  async function handleCreateStudent() {
    if (!selectedClassId || !newStudentName.trim() || !newStudentNumber.trim()) return;
    setBusy(true);
    setError("");
    try {
      const created = await fetchJson<{ id: number }>("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: newStudentNumber.trim(),
          name: newStudentName.trim(),
          role: "student",
          student_number: newStudentNumber.trim()
        })
      });

      await fetchJson(`/api/classes/${selectedClassId}/students`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentId: created.id })
      });

      await loadRoster(selectedClassId);
      if (selectedGradeId) await loadClasses(selectedGradeId);

      setShowNewStudentModal(false);
      setNewStudentName("");
      setNewStudentNumber("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建学生失败");
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
            <input placeholder="新年级名称" value={newGradeName} onChange={(e) => setNewGradeName(e.target.value)} />
            <button className="primary-button" type="button" onClick={() => void createGrade()}>
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
            <input placeholder="新班级名称" value={newClassName} onChange={(e) => setNewClassName(e.target.value)} disabled={!selectedGradeId} />
            <button className="primary-button" type="button" onClick={() => void createClass()} disabled={!selectedGradeId}>
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
                <button className="ghost-button" type="button" onClick={() => void searchStudents()} disabled={busy} title="搜索添加已有学生">
                  <UserPlus size={14} />
                </button>
                <button className="ghost-button" type="button" onClick={() => setShowNewStudentModal(true)} title="新建学生">
                  <UserPlus size={14} /> 新建
                </button>
                <button className="ghost-button" type="button" onClick={() => { setShowImportModal(true); setImportText(""); setImportPreview([]); }} title="批量导入">
                  <Upload size={14} /> 导入
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

      {/* ── 导入弹窗 ────────────────────────────────────── */}
      {showImportModal && (
        <div className="modal-backdrop" onClick={() => setShowImportModal(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ width: 480, maxWidth: "90vw" }}>
            <div className="modal-header">
              <h2>批量导入学生</h2>
              <button className="modal-close" onClick={() => setShowImportModal(false)}><X size={18} /></button>
            </div>
            <div className="modal-body">
              <p className="hint">
                支持从 Excel 复制粘贴或上传 CSV 文件。格式：每行「姓名, 学号」（可含表头）。
                <br />
                用户名与密码默认使用学号。
              </p>
              <input
                type="file"
                ref={fileInputRef}
                accept=".csv,.txt"
                style={{ display: "none" }}
                onChange={handleFileSelect}
              />
              <button className="upload-button" type="button" onClick={() => fileInputRef.current?.click()}>
                <Upload size={16} /> 选择 CSV / TXT 文件
              </button>
              <textarea
                rows={6}
                placeholder={`姓名,学号\n张三,2024001\n李四,2024002`}
                value={importText}
                onChange={(e) => {
                  setImportText(e.target.value);
                  previewImport(e.target.value);
                }}
                style={{ borderRadius: 10, padding: 10, border: "1px solid var(--line-strong)", fontSize: 13, fontFamily: "inherit" }}
              />
              {importPreview.length > 0 && (
                <div>
                  <p className="hint">共解析 {importPreview.length} 条记录：</p>
                  <div className="account-table-wrap" style={{ maxHeight: 200, overflow: "auto" }}>
                    <table className="account-table">
                      <thead>
                        <tr><th>姓名</th><th>学号</th></tr>
                      </thead>
                      <tbody>
                        {importPreview.slice(0, 50).map((s, i) => (
                          <tr key={i}><td>{s.name}</td><td>{s.student_number}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="ghost-button" type="button" onClick={() => setShowImportModal(false)}>取消</button>
              <button className="primary-button" type="button" onClick={() => void handleImport()} disabled={busy || importPreview.length === 0}>
                确认导入 {importPreview.length > 0 ? `(${importPreview.length})` : ""}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── 新建学生弹窗 ────────────────────────────────── */}
      {showNewStudentModal && (
        <div className="modal-backdrop" onClick={() => setShowNewStudentModal(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ width: 400, maxWidth: "90vw" }}>
            <div className="modal-header">
              <h2>新建学生</h2>
              <button className="modal-close" onClick={() => setShowNewStudentModal(false)}><X size={18} /></button>
            </div>
            <div className="modal-body">
              <label>
                姓名
                <input value={newStudentName} onChange={(e) => setNewStudentName(e.target.value)} placeholder="学生姓名" disabled={busy} />
              </label>
              <label>
                学号
                <input value={newStudentNumber} onChange={(e) => setNewStudentNumber(e.target.value)} placeholder="学号（默认作为用户名和初始密码）" disabled={busy} />
              </label>
            </div>
            <div className="modal-footer">
              <button className="ghost-button" type="button" onClick={() => setShowNewStudentModal(false)}>取消</button>
              <button className="primary-button" type="button" onClick={() => void handleCreateStudent()} disabled={busy || !newStudentName.trim() || !newStudentNumber.trim()}>
                创建并加入班级
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
