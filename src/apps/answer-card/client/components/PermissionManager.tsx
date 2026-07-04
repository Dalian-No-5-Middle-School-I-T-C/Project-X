/**
 * Admin-only: manage teacher permissions (which grades/data they can see).
 * Accessible via the Account menu when logged in as admin.
 */
import { useEffect, useState } from "react";
import { fetchJson } from "../auth/api";
import { X, Save, Shield } from "lucide-react";

interface Permission {
  id: number;
  teacher_id: number;
  teacher_name: string;
  teacher_role: string;
  grade_id: number | null;
  grade_name: string | null;
  can_view_scores: number;
  can_view_charts: number;
  can_view_students: number;
}

interface Teacher {
  id: number;
  name: string;
  role_name: string;
  teacher_role: string | null;
}

interface Grade {
  id: number;
  name: string;
}

interface Props {
  onBack: () => void;
}

export function PermissionManager({ onBack }: Props) {
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [teachers, setTeachers] = useState<Teacher[]>([]);
  const [grades, setGrades] = useState<Grade[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // New/edit form state
  const [selectedTeacher, setSelectedTeacher] = useState<number>(0);
  const [selectedGrade, setSelectedGrade] = useState<number | null>(null);
  const [canScores, setCanScores] = useState(true);
  const [canCharts, setCanCharts] = useState(true);
  const [canStudents, setCanStudents] = useState(true);
  const [editingId, setEditingId] = useState<number | null>(null);

  async function loadData() {
    setLoading(true);
    setError("");
    try {
      const [perms, teacherList, gradeList] = await Promise.all([
        fetchJson<Permission[]>("/api/admin/permissions"),
        fetchJson<{ users: Teacher[] }>("/api/teachers").then((r) => r.users || []),
        fetchJson<Grade[]>("/api/classes/grades"),
      ]);
      setPermissions(perms);
      setTeachers(teacherList.filter((t) => t.role_name === "teacher"));
      setGrades(gradeList);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void loadData(); }, []);

  async function handleSave() {
    if (!selectedTeacher) return;
    try {
      await fetchJson("/api/admin/permissions", {
        method: "PUT",
        body: JSON.stringify({
          teacher_id: selectedTeacher,
          grade_id: selectedGrade,
          can_view_scores: canScores,
          can_view_charts: canCharts,
          can_view_students: canStudents,
        }),
      });
      // Reset form
      setSelectedTeacher(0);
      setSelectedGrade(null);
      setCanScores(true);
      setCanCharts(true);
      setCanStudents(true);
      setEditingId(null);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    }
  }

  async function handleDelete(id: number) {
    if (!confirm("确定删除此权限设置？")) return;
    try {
      await fetchJson(`/api/admin/permissions/${id}`, { method: "DELETE" });
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除失败");
    }
  }

  function editPermission(p: Permission) {
    setSelectedTeacher(p.teacher_id);
    setSelectedGrade(p.grade_id ?? null);
    setCanScores(p.can_view_scores === 1);
    setCanCharts(p.can_view_charts === 1);
    setCanStudents(p.can_view_students === 1);
    setEditingId(p.id);
  }

  return (
    <div style={{ padding: 24 }}>
      <div className="account-panel-header">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Shield size={20} />
          <strong>教师权限管理</strong>
        </div>
        <button className="ghost-button" type="button" onClick={onBack}>
          <X size={16} /> 返回
        </button>
      </div>

      {error && <div className="login-error" style={{ marginBottom: 12 }}>{error}</div>}

      {/* Permission editor */}
      <div className="overview-info-card" style={{ padding: 16, marginBottom: 16 }}>
        <div className="panel-title" style={{ marginBottom: 12 }}>
          {editingId ? "编辑权限" : "新增权限"}
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
            <span style={{ color: "var(--text-secondary)" }}>教师</span>
            <select
              value={selectedTeacher}
              onChange={(e) => setSelectedTeacher(Number(e.target.value))}
              style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--line-strong)", minWidth: 140 }}
            >
              <option value={0}>选择教师...</option>
              {teachers.map((t) => (
                <option key={t.id} value={t.id}>{t.name} ({t.teacher_role || "教师"})</option>
              ))}
            </select>
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
            <span style={{ color: "var(--text-secondary)" }}>年级 (空=全部)</span>
            <select
              value={selectedGrade ?? ""}
              onChange={(e) => setSelectedGrade(e.target.value ? Number(e.target.value) : null)}
              style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--line-strong)", minWidth: 120 }}
            >
              <option value="">全部年级</option>
              {grades.map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
            <input type="checkbox" checked={canScores} onChange={(e) => setCanScores(e.target.checked)} />
            查看成绩
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
            <input type="checkbox" checked={canCharts} onChange={(e) => setCanCharts(e.target.checked)} />
            查看图表
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
            <input type="checkbox" checked={canStudents} onChange={(e) => setCanStudents(e.target.checked)} />
            查看学生
          </label>
          <button className="primary-button" onClick={() => void handleSave()} disabled={!selectedTeacher}>
            <Save size={14} /> {editingId ? "更新" : "添加"}
          </button>
          {editingId && (
            <button className="ghost-button" onClick={() => { setEditingId(null); setSelectedTeacher(0); setSelectedGrade(null); }}>
              取消
            </button>
          )}
        </div>
      </div>

      {/* Permissions list */}
      {loading ? (
        <div className="empty-text" style={{ padding: 40, textAlign: "center" }}>加载中...</div>
      ) : permissions.length === 0 ? (
        <div className="empty-text" style={{ padding: 40, textAlign: "center" }}>暂无权限设置。默认教师可见所教班级的全部数据。</div>
      ) : (
        <div className="exam-list-table" style={{ borderRadius: 8, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "var(--surface-soft)", textAlign: "left" }}>
                <th style={{ padding: "8px 12px" }}>教师</th>
                <th style={{ padding: "8px 12px" }}>角色</th>
                <th style={{ padding: "8px 12px" }}>年级</th>
                <th style={{ padding: "8px 12px", textAlign: "center" }}>成绩</th>
                <th style={{ padding: "8px 12px", textAlign: "center" }}>图表</th>
                <th style={{ padding: "8px 12px", textAlign: "center" }}>学生</th>
                <th style={{ padding: "8px 12px" }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {permissions.map((p) => (
                <tr key={p.id} style={{ borderTop: "1px solid var(--line)" }}>
                  <td style={{ padding: "8px 12px", fontWeight: 500 }}>{p.teacher_name}</td>
                  <td style={{ padding: "8px 12px", color: "var(--text-secondary)" }}>{p.teacher_role || "教师"}</td>
                  <td style={{ padding: "8px 12px", color: "var(--text-secondary)" }}>{p.grade_name || "全部"}</td>
                  <td style={{ padding: "8px 12px", textAlign: "center", color: p.can_view_scores ? "#639922" : "#E24B4A" }}>
                    {p.can_view_scores ? "✓" : "✗"}
                  </td>
                  <td style={{ padding: "8px 12px", textAlign: "center", color: p.can_view_charts ? "#639922" : "#E24B4A" }}>
                    {p.can_view_charts ? "✓" : "✗"}
                  </td>
                  <td style={{ padding: "8px 12px", textAlign: "center", color: p.can_view_students ? "#639922" : "#E24B4A" }}>
                    {p.can_view_students ? "✓" : "✗"}
                  </td>
                  <td style={{ padding: "8px 12px" }}>
                    <button className="ghost-button" onClick={() => editPermission(p)} style={{ fontSize: 12, marginRight: 4 }}>编辑</button>
                    <button className="ghost-button" onClick={() => void handleDelete(p.id)} style={{ fontSize: 12, color: "#E24B4A" }}>删除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
