import { useCallback, useEffect, useState } from "react";
import { Download, Link, Plus, RefreshCw, Search, Unlink, Upload } from "lucide-react";
import { fetchJson } from "../auth/api";
import { getAuthToken } from "../auth/api";
import type { GradeRecord, ClassRecord, TeacherRecord, TeachersListResponse } from "../auth/types";
import { ImportModal } from "./ImportModal";

/** 9科固定科目列表 */
const SUBJECTS = ["语文", "数学", "英语", "物理", "化学", "生物", "历史", "地理", "政治"];

export function TeacherManagement() {
  const [teachers, setTeachers] = useState<TeacherRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [keyword, setKeyword] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // 详情编辑
  const [editName, setEditName] = useState("");
  const [editSubject, setEditSubject] = useState("");

  // 关联班级
  const [grades, setGrades] = useState<GradeRecord[]>([]);
  const [allClasses, setAllClasses] = useState<ClassRecord[]>([]);
  const [selectedGradeId, setSelectedGradeId] = useState<number | null>(null);
  const [selectedClassId, setSelectedClassId] = useState<number | null>(null);

  // 弹窗
  const [showImport, setShowImport] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newTeacherName, setNewTeacherName] = useState("");
  const [newTeacherSubject, setNewTeacherSubject] = useState("");

  const selected = teachers.find((t) => t.id === selectedId) ?? null;

  const loadTeachers = useCallback(async () => {
    setBusy(true);
    try {
      const qs = keyword ? `?keyword=${encodeURIComponent(keyword)}` : "";
      const data = await fetchJson<TeachersListResponse>(`/api/teachers${qs}`);
      setTeachers(data.teachers);
      setTotal(data.total);
      // 保持选中或默认第一个
      if (selectedId === null || !data.teachers.some((t) => t.id === selectedId)) {
        if (data.teachers.length > 0) setSelectedId(data.teachers[0].id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载教师失败");
    } finally {
      setBusy(false);
    }
  }, [keyword, selectedId]);

  const loadGrades = useCallback(async () => {
    try {
      const data = await fetchJson<GradeRecord[]>("/api/classes/grades");
      setGrades(data);
      if (data.length > 0 && selectedGradeId === null) setSelectedGradeId(data[0].id);
    } catch {}
  }, [selectedGradeId]);

  const loadClasses = useCallback(async (gradeId: number | null) => {
    if (!gradeId) { setAllClasses([]); return; }
    try {
      const data = await fetchJson<ClassRecord[]>(`/api/classes?gradeId=${gradeId}`);
      setAllClasses(data);
      setSelectedClassId(data.length > 0 ? data[0].id : null);
    } catch {}
  }, []);

  useEffect(() => { void loadTeachers(); }, [loadTeachers]);
  useEffect(() => { void loadGrades(); }, [loadGrades]);
  useEffect(() => { void loadClasses(selectedGradeId); }, [selectedGradeId, loadClasses]);

  useEffect(() => {
    if (selected) {
      setEditName(selected.name);
      setEditSubject(selected.subject ?? "");
    }
  }, [selected]);

  async function handleRefresh() {
    await loadTeachers();
    if (selected) {
      try {
        const detail = await fetchJson<TeacherRecord>(`/api/teachers/${selected.id}`);
        const idx = teachers.findIndex((t) => t.id === selected.id);
        if (idx >= 0) {
          const updated = [...teachers];
          updated[idx] = detail;
          setTeachers(updated);
        }
      } catch {}
    }
  }

  async function handleSave() {
    if (!selected || !editName.trim()) return;
    setBusy(true);
    setError("");
    try {
      await fetchJson(`/api/teachers/${selected.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: editName.trim(), subject: editSubject.trim() || null })
      });
      await handleRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function handleLinkClass() {
    if (!selected || !selectedClassId) return;
    setBusy(true);
    setError("");
    try {
      await fetchJson(`/api/teachers/${selected.id}/classes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ classIds: [selectedClassId], subject: editSubject.trim() || null })
      });
      await handleRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "关联失败");
    } finally {
      setBusy(false);
    }
  }

  async function handleUnlinkClass(classId: number) {
    if (!selected) return;
    setBusy(true);
    try {
      await fetchJson(`/api/teachers/${selected.id}/classes/${classId}`, { method: "DELETE" });
      await handleRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "解除失败");
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
    setShowImport(false);
    await loadTeachers();
  }

  function handleExport() {
    if (!confirm("导出文件将包含教师明文密码，请妥善保管！\n确定要下载吗？")) return;
    const token = getAuthToken();
    fetch("/api/export/teachers", { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then(async (res) => {
        if (!res.ok) throw new Error(await res.text());
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "teacher_accounts.xlsx";
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "导出失败"));
  }

  // ── 手动创建教师 ──────────────────────────────────────
  async function handleCreateTeacher() {
    if (!newTeacherName.trim() || !newTeacherSubject.trim()) return;
    setBusy(true);
    setError("");
    try {
      // 使用 csv 导入接口创建一个教师
      const csvText = `科目,姓名\n${newTeacherSubject.trim()},${newTeacherName.trim()}`;
      await fetchJson("/api/users/import-csv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csvText })
      });
      setShowCreateModal(false);
      setNewTeacherName("");
      setNewTeacherSubject("");
      await loadTeachers();
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="account-panel teacher-management">
      <div className="account-panel-header">
        <strong>教师管理</strong>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="ghost-button" type="button" onClick={handleRefresh} disabled={busy}>
            <RefreshCw size={14} /> 刷新
          </button>
          <button className="ghost-button" type="button" onClick={() => { setShowCreateModal(true); setNewTeacherName(""); setNewTeacherSubject(""); }} disabled={busy}>
            <Plus size={14} /> 新建教师
          </button>
          <button className="ghost-button" type="button" onClick={() => setShowImport(true)} disabled={busy}>
            <Download size={14} /> 导入教师
          </button>
          <button className="primary-button" type="button" onClick={handleExport}>
            <Upload size={14} /> 导出教师账密
          </button>
        </div>
      </div>

      {error && <p className="login-error">{error}</p>}

      <div className="class-layout" style={{ gridTemplateColumns: "220px 1fr" }}>
        {/* 左侧：教师列表 */}
        <section className="class-column">
          <div className="class-add-row">
            <input
              placeholder="搜索教师..."
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void loadTeachers()}
              disabled={busy}
            />
            <button className="ghost-button" type="button" onClick={() => void loadTeachers()} disabled={busy}>
              <Search size={14} />
            </button>
          </div>
          <div className="class-list" style={{ maxHeight: "calc(100vh - 260px)", overflow: "auto" }}>
            {teachers.map((t) => (
              <div key={t.id} className={`class-list-item ${selectedId === t.id ? "active" : ""}`}>
                <button type="button" onClick={() => setSelectedId(t.id)}>
                  {t.name}
                  <small>{t.subject || "未设科目"}</small>
                </button>
              </div>
            ))}
            {teachers.length === 0 && <p className="empty-text">{keyword ? "无匹配教师" : "暂无教师"}</p>}
          </div>
          <p className="hint" style={{ padding: "4px 8px", fontSize: 11 }}>
            共 {total} 名教师
          </p>
        </section>

        {/* 右侧：详情面板 */}
        <section className="class-column roster-column">
          {selected ? (
            <>
              <div className="class-column-title">教师详情</div>
              <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 12 }}>
                <label>
                  姓名
                  <input value={editName} onChange={(e) => setEditName(e.target.value)} disabled={busy} />
                </label>
                <label>
                  任教科目
                  <select
                    value={editSubject}
                    onChange={(e) => setEditSubject(e.target.value)}
                    disabled={busy}
                    style={{ width: "100%", padding: "6px 10px", borderRadius: 8, border: "1px solid var(--line-strong)", fontSize: 13 }}
                  >
                    <option value="">— 未设置 —</option>
                    {SUBJECTS.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </label>
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="primary-button" type="button" onClick={handleSave} disabled={busy}>
                    保存
                  </button>
                  <button className="ghost-button" type="button" onClick={() => { setEditName(selected.name); setEditSubject(selected.subject ?? ""); }} disabled={busy}>
                    重置
                  </button>
                </div>

                {/* 关联班级 */}
                <div className="class-column-title" style={{ paddingTop: 12 }}>关联班级</div>
                <div className="class-list" style={{ maxHeight: 200, overflow: "auto" }}>
                  {selected.classes && selected.classes.length > 0 ? (
                    selected.classes.map((c) => (
                      <div key={c.class_id} className="roster-item">
                        <span>{c.grade_name} · {c.class_name}</span>
                        <small>{c.subject || selected.subject || "任教"}</small>
                        <button type="button" className="icon-btn danger" title="解除关联" onClick={() => void handleUnlinkClass(c.class_id)} disabled={busy}>
                          <Unlink size={13} />
                        </button>
                      </div>
                    ))
                  ) : (
                    <p className="empty-text">暂无关联班级</p>
                  )}
                </div>

                {/* 添加关联 */}
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <select
                    value={selectedGradeId ?? ""}
                    onChange={(e) => setSelectedGradeId(e.target.value ? Number(e.target.value) : null)}
                    style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid var(--line-strong)", fontSize: 12 }}
                  >
                    <option value="">选年级</option>
                    {grades.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                  </select>
                  <select
                    value={selectedClassId ?? ""}
                    onChange={(e) => setSelectedClassId(e.target.value ? Number(e.target.value) : null)}
                    style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid var(--line-strong)", fontSize: 12 }}
                  >
                    <option value="">选班级</option>
                    {allClasses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                  <button className="ghost-button" type="button" onClick={handleLinkClass} disabled={busy || !selectedClassId}>
                    <Link size={14} /> 关联
                  </button>
                </div>
              </div>
            </>
          ) : (
            <p className="empty-text">请选择一名教师查看详情</p>
          )}
        </section>
      </div>

      {showImport && (
        <ImportModal
          title="批量导入教师"
          csvType="teacher"
          onImport={handleImport}
          onClose={() => setShowImport(false)}
        />
      )}

      {/* ── 新建教师弹窗 ────────────────────────────────── */}
      {showCreateModal && (
        <div className="modal-backdrop" onClick={() => setShowCreateModal(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ width: 400, maxWidth: "90vw" }}>
            <div className="modal-header">
              <h2>新建教师</h2>
              <button className="modal-close" onClick={() => setShowCreateModal(false)}>✕</button>
            </div>
            <div className="modal-body">
              <label>
                姓名
                <input value={newTeacherName} onChange={(e) => setNewTeacherName(e.target.value)} placeholder="教师姓名" disabled={busy} />
              </label>
              <label>
                任教科目
                <select
                  value={newTeacherSubject}
                  onChange={(e) => setNewTeacherSubject(e.target.value)}
                  disabled={busy}
                  style={{ width: "100%", padding: "6px 10px", borderRadius: 8, border: "1px solid var(--line-strong)", fontSize: 13 }}
                >
                  <option value="">— 请选择科目 —</option>
                  {SUBJECTS.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
              <p className="hint">账号将自动生成（T + 6位随机数），密码为6位随机数字。</p>
            </div>
            <div className="modal-footer">
              <button className="ghost-button" type="button" onClick={() => setShowCreateModal(false)}>取消</button>
              <button className="primary-button" type="button" onClick={handleCreateTeacher} disabled={busy || !newTeacherName.trim() || !newTeacherSubject.trim()}>
                创建教师
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
