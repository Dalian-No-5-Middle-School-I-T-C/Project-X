import { useCallback, useEffect, useState } from "react";
import { Download, Plus, RefreshCw, Search, Trash2, UserCheck, UserX } from "lucide-react";
import { fetchJson } from "../auth/api";
import { ROLE_LABELS, TEACHER_ROLE_LABELS, roleCount, type UserListItem, type UsersListResponse } from "../auth/types";

const ROLE_OPTIONS = [
  { value: "", label: "全部角色" },
  { value: "admin", label: "管理员" },
  { value: "teacher", label: "教师" },
  { value: "student", label: "学生" }
];

export function UserManagement() {
  const [data, setData] = useState<UsersListResponse | null>(null);
  const [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState("");
  const [form, setForm] = useState({
    username: "",
    password: "",
    name: "",
    role: "teacher",
    teacher_role: "",
    student_number: "",
    email: "",
    phone: ""
  });

  const loadUsers = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: "20" });
      if (keyword) params.set("keyword", keyword);
      if (roleFilter) params.set("role", roleFilter);
      if (includeInactive) params.set("includeInactive", "1");
      const result = await fetchJson<UsersListResponse>(`/api/users?${params}`);
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setBusy(false);
    }
  }, [page, keyword, roleFilter, includeInactive]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  async function createUser() {
    if (!form.username.trim() || !form.name.trim()) {
      setError("请填写用户名和姓名");
      return;
    }
    if (form.role === "student" && !form.student_number.trim()) {
      setError("学生账号必须填写学号");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await fetchJson("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: form.username.trim(),
          password: form.password || undefined,
          name: form.name.trim(),
          role: form.role,
          teacher_role: form.role === "teacher" ? (form.teacher_role || undefined) : undefined,
          student_number: form.student_number.trim() || undefined,
          email: form.email.trim() || undefined,
          phone: form.phone.trim() || undefined
        })
      });
      setShowCreate(false);
      setForm({ username: "", password: "", name: "", role: "teacher", teacher_role: "", student_number: "", email: "", phone: "" });
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建失败");
    } finally {
      setBusy(false);
    }
  }

  async function importStudents() {
    const lines = importText
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      setError("请粘贴学生数据，每行：学号,姓名");
      return;
    }
    const students = lines.map((line) => {
      const [student_number, name, username] = line.split(/[,，\t]/).map((s) => s.trim());
      return { student_number, name, username: username || student_number };
    });
    setBusy(true);
    setError("");
    try {
      const result = await fetchJson<{ created: number; skipped: number; errors: unknown[] }>(
        "/api/users/import-students",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ students })
        }
      );
      setShowImport(false);
      setImportText("");
      setError(`导入完成：成功 ${result.created} 人${result.skipped ? `，跳过 ${result.skipped} 人` : ""}`);
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : "导入失败");
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(user: UserListItem) {
    if (!confirm(user.is_active ? `禁用「${user.name}」？` : `重新启用「${user.name}」？`)) return;
    setBusy(true);
    try {
      if (user.is_active) {
        await fetchJson(`/api/users/${user.id}`, { method: "DELETE" });
      } else {
        await fetchJson(`/api/users/${user.id}/reactivate`, { method: "POST" });
      }
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword(user: UserListItem) {
    const hint = user.student_number ? `（默认重置为学号 ${user.student_number}）` : "";
    if (!confirm(`重置「${user.name}」的密码？${hint}`)) return;
    setBusy(true);
    try {
      await fetchJson(`/api/users/${user.id}/reset-password`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      setError(`已重置 ${user.name} 的密码`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "重置失败");
    } finally {
      setBusy(false);
    }
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="account-panel">
      <div className="account-panel-header">
        <div>
          <strong>用户管理</strong>
          {data?.roleSummary && (
            <span className="account-summary">
              管理员 {roleCount(data.roleSummary, "admin")} · 教师 {roleCount(data.roleSummary, "teacher")} · 学生 {roleCount(data.roleSummary, "student")}
            </span>
          )}
        </div>
        <div className="account-panel-actions">
          <button className="primary-button" type="button" onClick={() => setShowCreate((open) => !open)}>
            <Plus size={16} /> 新建用户
          </button>
          <button className="ghost-button" type="button" onClick={() => setShowImport((open) => !open)}>
            <Download size={16} /> 批量导入学生
          </button>
          <button className="ghost-button" type="button" onClick={() => void loadUsers()} disabled={busy}>
            <RefreshCw size={16} /> 刷新
          </button>
        </div>
      </div>

      <div className="account-filters">
        <div className="account-search">
          <Search size={15} />
          <input
            placeholder="搜索用户名、姓名、学号..."
            value={keyword}
            onChange={(e) => { setKeyword(e.target.value); setPage(1); }}
            onKeyDown={(e) => e.key === "Enter" && void loadUsers()}
          />
        </div>
        <select value={roleFilter} onChange={(e) => { setRoleFilter(e.target.value); setPage(1); }}>
          {ROLE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <label className="check-row">
          <input type="checkbox" checked={includeInactive} onChange={(e) => { setIncludeInactive(e.target.checked); setPage(1); }} />
          含已禁用
        </label>
      </div>

      {error && <p className={error.includes("完成") || error.includes("已重置") ? "login-success" : "login-error"}>{error}</p>}

      {showCreate && (
        <div className="account-form-grid">
          <input placeholder="用户名" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
          <input placeholder="姓名" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value, teacher_role: "" })}>
            <option value="teacher">教师</option>
            <option value="student">学生</option>
            <option value="admin">管理员</option>
          </select>
          {form.role === "teacher" && (
            <select value={form.teacher_role} onChange={(e) => setForm({ ...form, teacher_role: e.target.value })}>
              <option value="">普通教师（全权限）</option>
              <option value="subject_teacher">学科老师</option>
              <option value="head_teacher">班主任</option>
              <option value="grade_leader">学年主任</option>
            </select>
          )}
          <input placeholder="学号（学生必填）" value={form.student_number} onChange={(e) => setForm({ ...form, student_number: e.target.value })} />
          <input placeholder="初始密码（学生默认学号）" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          <input placeholder="邮箱（可选）" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <div className="account-form-actions">
            <button className="primary-button" type="button" onClick={() => void createUser()} disabled={busy}>确认创建</button>
            <button className="ghost-button" type="button" onClick={() => setShowCreate(false)}>取消</button>
          </div>
        </div>
      )}

      {showImport && (
        <div className="account-import-box">
          <p className="hint">每行格式：学号,姓名 或 学号,姓名,用户名</p>
          <textarea
            rows={6}
            placeholder={"2024001,张三\n2024002,李四"}
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
          />
          <div className="account-form-actions">
            <button className="primary-button" type="button" onClick={() => void importStudents()} disabled={busy}>开始导入</button>
            <button className="ghost-button" type="button" onClick={() => setShowImport(false)}>取消</button>
          </div>
        </div>
      )}

      <div className="account-table-wrap table-cards">
        <table className="account-table">
          <thead>
            <tr>
              <th>用户名</th>
              <th>姓名</th>
              <th>角色</th>
              <th>教师细分</th>
              <th>学号</th>
              <th>状态</th>
              <th>最后登录</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {data?.users.map((user) => (
              <tr key={user.id} className={user.is_active ? "" : "inactive-row"}>
                <td data-label="用户名">{user.username}</td>
                <td data-label="姓名">{user.name}</td>
                <td data-label="角色">{ROLE_LABELS[user.role_name ?? ""] ?? user.role_display_name ?? user.role_id}</td>
                <td data-label="教师细分">{user.role_name === "teacher" ? (TEACHER_ROLE_LABELS[user.teacher_role ?? ""] ?? "普通") : "—"}</td>
                <td data-label="学号">{user.student_number ?? "—"}</td>
                <td data-label="状态">
                  <span className={`status-badge ${user.is_active ? "active" : "inactive"}`}>
                    {user.is_active ? "正常" : "已禁用"}
                  </span>
                </td>
                <td data-label="最后登录">{user.last_login_at ? new Date(user.last_login_at).toLocaleString() : "—"}</td>
                <td data-label="操作" className="account-row-actions">
                  <button className="ghost-button" type="button" title="重置密码" onClick={() => void resetPassword(user)} disabled={busy}>
                    <KeyIcon />
                  </button>
                  <button
                    className="ghost-button"
                    type="button"
                    title={user.is_active ? "禁用" : "启用"}
                    onClick={() => void toggleActive(user)}
                    disabled={busy}
                  >
                    {user.is_active ? <UserX size={14} /> : <UserCheck size={14} />}
                  </button>
                </td>
              </tr>
            ))}
            {!busy && data?.users.length === 0 && (
              <tr><td colSpan={8} className="empty-text" style={{ textAlign: "center", padding: 40 }}>暂无用户</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {data && data.total > data.pageSize && (
        <div className="account-pagination">
          <button className="ghost-button" type="button" disabled={page <= 1 || busy} onClick={() => setPage(page - 1)}>上一页</button>
          <span>第 {page} / {totalPages} 页（共 {data.total} 人）</span>
          <button className="ghost-button" type="button" disabled={page >= totalPages || busy} onClick={() => setPage(page + 1)}>下一页</button>
        </div>
      )}
    </div>
  );
}

function KeyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
    </svg>
  );
}
