import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Database, Download, Eye, Heart, KeyRound, LogOut, Plus, Settings, Trash2, Upload, User, X, BookOpen, Gauge, Monitor, BrainCircuit } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { fetchJson, getAuthToken } from "../auth/api";
import { ROLE_LABELS, TEACHER_ROLE_LABELS } from "../auth/types";
import type { AiProviderConfig } from "../../../../shared/types";

export function AccountMenu({
  onOpenSponsor,
  onOpenGuide
}: {
  onOpenSponsor?: () => void;
  onOpenGuide?: () => void;
}) {
  const { user, logout, isAdmin, persona, setPersona, teacherRoleOverride, setTeacherRoleOverride, availablePersonas, canSwitchPersona } = useAuth();
  // v1.6.0: 非 Electron 环境（WEB 端）不显示扫描端选项和数据库设置
  const isElectron = typeof navigator !== "undefined" && navigator.userAgent.includes("Electron");
  const menuRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [importMsg, setImportMsg] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [displayMode, setDisplayMode] = useState("zscore");
  const [reviewThreshold, setReviewThreshold] = useState(0.12);
  const [bgOpacity, setBgOpacity] = useState(0);
  const [requireOriginalPaper, setRequireOriginalPaper] = useState(true);
  const [highlightMissingPaper, setHighlightMissingPaper] = useState(true);
  const bgFileRef = useRef<HTMLInputElement | null>(null);
  const [bgMsg, setBgMsg] = useState("");
  const [settingsMsg, setSettingsMsg] = useState("");

  // Multi-provider AI management
  const [aiProviders, setAiProviders] = useState<AiProviderConfig[]>([]);
  const [showAddProvider, setShowAddProvider] = useState(false);
  const [providerEditor, setProviderEditor] = useState<{ editing: boolean; id?: number; name: string; providerType: string; baseUrl: string; apiKey: string; models: string }>({
    editing: false, name: "", providerType: "openai", baseUrl: "", apiKey: "", models: ""
  });
  const [showHelpCard, setShowHelpCard] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"grading" | "client" | "ai" | "db">("grading");

  // ── 数据存储设置（管理员） ──────────────────────────
  const [dbMode, setDbMode] = useState<"local" | "remote">("local");
  const [dbHost, setDbHost] = useState("");
  const [dbPort, setDbPort] = useState(3306);
  const [dbDatabase, setDbDatabase] = useState("projectx");
  const [dbUser, setDbUser] = useState("");
  const [dbPassword, setDbPassword] = useState("");
  const [dbHasPassword, setDbHasPassword] = useState(false);
  const [dbMsg, setDbMsg] = useState("");
  const [dbLoading, setDbLoading] = useState(false);

  useEffect(() => {
    if (open && showSettings) {
      fetchJson<{ scoreDisplayMode: string; reviewConfidenceThreshold: number; backgroundOpacity: number; requireOriginalPaper?: number; highlightMissingPaper?: number }>("/api/users/me/settings")
        .then((s) => {
          if (!s || typeof s !== "object") return;
          setDisplayMode(s.scoreDisplayMode || "zscore");
          setReviewThreshold(s.reviewConfidenceThreshold ?? 0.12);
          setBgOpacity(s.backgroundOpacity ?? 0);
          setRequireOriginalPaper(s.requireOriginalPaper !== 0);
          setHighlightMissingPaper(s.highlightMissingPaper !== 0);
        })
        .catch(() => {});
      loadProviders();
      loadDbConfig();
    }
  }, [open, showSettings]);

  async function loadDbConfig() {
    if (!isAdmin) return;
    try {
      const c = await fetchJson<{ mode: string; remote: { host: string; port: number; database: string; user: string; hasPassword: boolean } | null }>("/api/app/db-config");
      setDbMode((c.mode as "local" | "remote") || "local");
      if (c.remote) {
        setDbHost(c.remote.host);
        setDbPort(c.remote.port);
        setDbDatabase(c.remote.database);
        setDbUser(c.remote.user);
        setDbHasPassword(c.remote.hasPassword);
      }
    } catch { /* non-admin or API not available */ }
  }

  async function saveDbConfig() {
    setDbMsg("");
    setDbLoading(true);
    try {
      const body: any = { mode: dbMode };
      if (dbMode === "remote") {
        body.remote = {
          host: dbHost, port: dbPort, database: dbDatabase,
          user: dbUser, password: dbPassword || undefined,
        };
      }
      const res = await fetchJson<{ ok: boolean; message: string }>("/api/app/db-config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setDbMsg(res.message || "已保存。请重启服务器生效。");
    } catch (err: any) {
      setDbMsg(err.message || "保存失败");
    } finally {
      setDbLoading(false);
    }
  }

  async function saveSettings() {
    setSettingsMsg("");
    try {
      await fetchJson("/api/users/me/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scoreDisplayMode: displayMode,
          reviewConfidenceThreshold: reviewThreshold,
          backgroundOpacity: bgOpacity,
          requireOriginalPaper: requireOriginalPaper,
          highlightMissingPaper: highlightMissingPaper,
        })
      });
      setSettingsMsg("已保存");
      setTimeout(() => setSettingsMsg(""), 1500);
    } catch (err) {
      setSettingsMsg(err instanceof Error ? err.message : "保存失败");
    }
  }

  async function handleBgUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBgMsg("");
    try {
      const form = new FormData();
      form.append("file", file);
      const token = getAuthToken();
      const res = await fetch("/api/users/me/background", {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: form
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "上传失败" }));
        throw new Error(err.error || "上传失败");
      }
      setBgMsg("上传成功，刷新后生效");
      setTimeout(() => setBgMsg(""), 3000);
    } catch (err) {
      setBgMsg(err instanceof Error ? err.message : "上传失败");
    }
    // Reset input so same file can be re-uploaded
    e.target.value = "";
  }

  // ── AI 服务商管理 ──────────────────────────────────
  async function loadProviders() {
    try {
      const data = await fetchJson<AiProviderConfig[]>("/api/ai/providers");
      setAiProviders(data);
    } catch {
      setAiProviders([]);
    }
  }

  async function saveProvider() {
    const { editing, id, name, providerType, baseUrl, apiKey, models } = providerEditor;
    if (!name || !providerType || !apiKey) {
      setSettingsMsg("请填写完整信息");
      return;
    }
    if (providerType !== "gemini" && !baseUrl) {
      setSettingsMsg("请填写 Base URL");
      return;
    }
    try {
      const body: any = {
        name, providerType, baseUrl, apiKey,
        models: models.trim() ? models.split(",").map((m) => m.trim()).filter(Boolean) : null
      };
      if (editing && id) {
        await fetchJson(`/api/ai/providers/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      } else {
        await fetchJson("/api/ai/providers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      }
      setProviderEditor({ editing: false, name: "", providerType: "openai", baseUrl: "", apiKey: "", models: "" });
      setShowAddProvider(false);
      setSettingsMsg("服务商已保存");
      setTimeout(() => setSettingsMsg(""), 1500);
      loadProviders();
    } catch (err) {
      setSettingsMsg(err instanceof Error ? err.message : "保存服务商失败");
    }
  }

  async function deleteProvider(id: number) {
    try {
      await fetchJson(`/api/ai/providers/${id}`, { method: "DELETE" });
      setSettingsMsg("已删除");
      setTimeout(() => setSettingsMsg(""), 1500);
      loadProviders();
    } catch (err) {
      setSettingsMsg(err instanceof Error ? err.message : "删除失败");
    }
  }

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent) {
      if (menuRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  if (!user) return null;

  async function handleChangePassword() {
    setMessage("");
    if (!newPassword || newPassword.length < 6) {
      setMessage("新密码至少 6 位");
      return;
    }
    if (newPassword !== confirmPassword) {
      setMessage("两次输入的新密码不一致");
      return;
    }
    setBusy(true);
    try {
      await fetchJson("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oldPassword, newPassword })
      });
      setMessage("密码已修改，请重新登录");
      setTimeout(() => void logout(), 1200);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "修改失败");
    } finally {
      setBusy(false);
    }
  }

  async function handleExportDb() {
    try {
      const token = getAuthToken();
      const resp = await fetch("/api/db/backup", {
        headers: token ? { Authorization: `Bearer ${token}` } : {}
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ message: resp.statusText }));
        throw new Error(err.message || "导出失败");
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `ProjectX_backup_${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setImportMsg(err instanceof Error ? err.message : "导出失败");
    }
  }

  async function handleImportDb(file: File) {
    setImportMsg("");
    setImportBusy(true);
    try {
      const token = getAuthToken();
      const headers: Record<string, string> = {
        "Content-Type": "application/zip"
      };
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const resp = await fetch("/api/db/restore", {
        method: "POST",
        headers,
        body: file  // 原始二进制上传，绕过 FormData/multipart 的 corrupt 风险
      });
      const result = await resp.json();
      if (!resp.ok) {
        throw new Error(result.message || "导入失败");
      }
      setImportMsg(result.message || "数据已恢复！请手动重启应用以生效。");
    } catch (err) {
      setImportMsg(err instanceof Error ? err.message : "导入失败");
    } finally {
      setImportBusy(false);
      // 重置 file input
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  return (
    <div className="account-menu" ref={menuRef}>
      <button className="account-menu-trigger" type="button" onClick={() => setOpen(!open)}>
        <User size={16} />
        <span>{user.name}</span>
        <small>{TEACHER_ROLE_LABELS[user.teacher_role ?? ""] ?? ROLE_LABELS[user.role_name] ?? user.role_name}</small>
        <ChevronDown size={14} className={open ? "rotated" : ""} />
      </button>
      {open && (
        <div className="account-menu-dropdown">
          <div className="account-menu-info">
            <strong>{user.name}</strong>
            <span>@{user.username}</span>
            {user.student_number && <span>学号 {user.student_number}</span>}
          </div>
          <button
            type="button"
            className="account-menu-item"
            onClick={() => {
              setShowPassword(!showPassword);
              setMessage("");
              setOldPassword("");
              setNewPassword("");
              setConfirmPassword("");
            }}
          >
            <KeyRound size={15} /> 修改密码
          </button>
          {showPassword && (
            <div className="account-password-form">
              <input
                type="password"
                placeholder="原密码"
                value={oldPassword}
                onChange={(e) => setOldPassword(e.target.value)}
                disabled={busy}
              />
              <input
                type="password"
                placeholder="新密码（至少 6 位）"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                disabled={busy}
              />
              <input
                type="password"
                placeholder="确认新密码"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                disabled={busy}
              />
              {message && <p className={message.includes("已修改") ? "login-success" : "login-error"}>{message}</p>}
              <button className="primary-button" type="button" onClick={() => void handleChangePassword()} disabled={busy}>
                确认修改
              </button>
            </div>
          )}
          {/* ── v1.6.0: 管理员身份切换 ── */}
          {canSwitchPersona && (
            <>
              <div className="account-menu-divider" />
              <div style={{ padding: "8px 12px 4px" }}>
                <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 6, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px" }}>
                  <Eye size={12} style={{ verticalAlign: -1, marginRight: 4 }} />
                  查看身份
                </div>
                {availablePersonas.filter(p => isElectron || p !== "teacher-scanner").map((p) => {
                  const labels: Record<string, string> = { "teacher-scanner": "扫描端（全功能）", "teacher": "教师端", "student": "学生端（预览）" };
                  return (
                    <label key={p} style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 0", cursor: "pointer", fontSize: 13 }}>
                      <input
                        type="radio"
                        name="persona"
                        value={p}
                        checked={persona === p}
                        onChange={() => setPersona(p)}
                      />
                      {labels[p] ?? p}
                    </label>
                  );
                })}
                {persona === "teacher" && (
                  <div style={{ marginLeft: 22, marginTop: 2 }}>
                    <select
                      value={teacherRoleOverride ?? ""}
                      onChange={(e) => setTeacherRoleOverride((e.target.value || null) as any)}
                      style={{ fontSize: 12, padding: "2px 4px", borderRadius: 4, border: "1px solid var(--line)", background: "var(--surface)", color: "var(--text)" }}
                    >
                      <option value="">教师角色（实际）</option>
                      <option value="subject_teacher">学科老师</option>
                      <option value="head_teacher">班主任</option>
                      <option value="grade_leader">学年主任</option>
                    </select>
                  </div>
                )}
              </div>
            </>
          )}
          <button
            type="button"
            className="account-menu-item"
            onClick={() => { setShowSettings(!showSettings); setSettingsMsg(""); }}
          >
            <Settings size={15} /> 账号设置
          </button>
          {/* 数据库导入导出 — 仅管理员可见 */}
          {isAdmin && (
            <>
              <div className="account-menu-divider" />
              <button type="button" className="account-menu-item" onClick={() => void handleExportDb()}>
                <Download size={15} /> 导出数据
              </button>
              <button
                type="button"
                className="account-menu-item"
                onClick={() => fileInputRef.current?.click()}
                disabled={importBusy}
              >
                <Upload size={15} /> {importBusy ? "导入中..." : "导入数据"}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".zip"
                style={{ display: "none" }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleImportDb(file);
                }}
              />
              {importMsg && (
                <div style={{ padding: "6px 12px", fontSize: 12, color: importMsg.includes("失败") ? "var(--brand)" : "#2E7D32" }}>
                  {importMsg}
                </div>
              )}
            </>
          )}
          {onOpenGuide && (
            <button
              type="button"
              className="account-menu-item"
              onClick={() => {
                setOpen(false);
                onOpenGuide();
              }}
            >
              <BookOpen size={15} /> 使用说明
            </button>
          )}
          {onOpenSponsor && (
            <button
              type="button"
              className="account-menu-item"
              onClick={() => {
                setOpen(false);
                onOpenSponsor();
              }}
            >
              <Heart size={15} /> 支持项目
            </button>
          )}
          <button type="button" className="account-menu-item danger" onClick={() => void logout()}>
            <LogOut size={15} /> 退出登录
          </button>
        </div>
      )}
      {open && <div className="account-menu-backdrop" onClick={() => setOpen(false)} />}

      {/* Settings modal — portal to body to escape backdrop-filter containing block */}
      {showSettings && createPortal(
        <div className="modal-overlay" onClick={() => setShowSettings(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 640, width: "92vw", maxHeight: "90vh", overflow: "hidden", display: "flex", flexDirection: "column" }}>
            <div className="modal-header">
              <h3 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>账号设置</h3>
              <button className="ghost-button" onClick={() => setShowSettings(false)}>
                <X size={18} />
              </button>
            </div>
            <div className="account-settings-layout">
              <div className="account-settings-nav">
                <button className={`account-settings-nav-item ${settingsTab === "grading" ? "active" : ""}`} onClick={() => setSettingsTab("grading")}>
                  <Gauge size={15} /> 阅卷设置
                </button>
                <button className={`account-settings-nav-item ${settingsTab === "client" ? "active" : ""}`} onClick={() => setSettingsTab("client")}>
                  <Monitor size={15} /> 客户端设置
                </button>
                <button className={`account-settings-nav-item ${settingsTab === "ai" ? "active" : ""}`} onClick={() => setSettingsTab("ai")}>
                  <BrainCircuit size={15} /> AI 设置
                </button>
                {isAdmin && isElectron && (
                  <button className={`account-settings-nav-item ${settingsTab === "db" ? "active" : ""}`} onClick={() => setSettingsTab("db")}>
                    <Database size={15} /> 数据存储
                  </button>
                )}
              </div>
              <div className="account-settings-content">
                {settingsTab === "grading" && (
                  <>
                    <h4>成绩指标显示</h4>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer" }}>
                        <input type="radio" name="displayMode" value="deviation" checked={displayMode === "deviation"} onChange={() => setDisplayMode("deviation")} />
                        标准偏差值 (50为基准)
                      </label>
                      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer" }}>
                        <input type="radio" name="displayMode" value="zscore" checked={displayMode === "zscore"} onChange={() => setDisplayMode("zscore")} />
                        Z值 (0为基准)
                      </label>
                      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer" }}>
                        <input type="radio" name="displayMode" value="percentile" checked={displayMode === "percentile"} onChange={() => setDisplayMode("percentile")} />
                        百分位排名 (0~100)
                      </label>
                    </div>
                    <h4 style={{ marginTop: 8 }}>复核置信度阈值: {reviewThreshold.toFixed(2)}</h4>
                    <input type="range" min="0" max="1" step="0.01" value={reviewThreshold} onChange={(e) => setReviewThreshold(Number(e.target.value))} style={{ width: "100%", marginTop: 2 }} />
                    <span style={{ fontSize: 11, color: "var(--muted)" }}>低于此值的题目标记"需要复核"</span>

                    {/* v1.7.0: 原卷设置 */}
                    <h4 style={{ marginTop: 16 }}>原卷上传设置</h4>
                    <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                      <input type="checkbox" checked={requireOriginalPaper} onChange={(e) => setRequireOriginalPaper(e.target.checked)} />
                      <span>强制要求上传原卷</span>
                    </label>
                    <span style={{ fontSize: 11, color: "var(--muted)", display: "block", marginLeft: 24, marginBottom: 8 }}>
                      创建答题卡后必须上传原卷才能导出
                    </span>
                    <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                      <input type="checkbox" checked={highlightMissingPaper} onChange={(e) => setHighlightMissingPaper(e.target.checked)} />
                      <span>侧边栏高亮未上传原卷</span>
                    </label>
                    <span style={{ fontSize: 11, color: "var(--muted)", display: "block", marginLeft: 24 }}>
                      左侧列表用颜色标记缺少原卷的考试
                    </span>

                    {settingsMsg && <p style={{ fontSize: 12, margin: "4px 0", color: settingsMsg.includes("失败") ? "var(--brand)" : "#2E7D32" }}>{settingsMsg}</p>}
                    <button className="primary-button" type="button" onClick={() => void saveSettings()} style={{ marginTop: 4 }}>保存设置</button>
                  </>
                )}

                {settingsTab === "client" && (
                  <>
                    <h4>背景图透明度</h4>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12 }}>
                      <span style={{ color: "var(--muted)" }}>{Math.round(bgOpacity * 100)}%{bgOpacity === 0 ? " (关闭)" : ""}</span>
                    </div>
                    <input type="range" min="0" max="0.5" step="0.01" value={bgOpacity} onChange={(e) => { const v = Number(e.target.value); setBgOpacity(v); document.documentElement.style.setProperty("--bg-opacity", String(v)); if (v > 0) document.body.classList.add("has-bg-image"); else document.body.classList.remove("has-bg-image"); }} style={{ width: "100%", marginTop: 4 }} />
                    <span style={{ fontSize: 11, color: "var(--muted)" }}>0% = 关闭，建议 5%~15%（浮层叠加，不影响阅读）</span>
                    <div style={{ marginTop: 8, display: "flex", gap: 6, alignItems: "center" }}>
                      <button className="ghost-button" style={{ fontSize: 11 }} onClick={() => bgFileRef.current?.click()}>上传背景图</button>
                      <input ref={bgFileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handleBgUpload} />
                      {bgMsg && <span style={{ fontSize: 11, color: bgMsg.includes("失败") ? "var(--brand)" : "#2E7D32" }}>{bgMsg}</span>}
                    </div>
                    {settingsMsg && <p style={{ fontSize: 12, margin: "4px 0", color: settingsMsg.includes("失败") ? "var(--brand)" : "#2E7D32" }}>{settingsMsg}</p>}
                    <button className="primary-button" type="button" onClick={() => void saveSettings()} style={{ marginTop: 4 }}>保存设置</button>
                  </>
                )}

                {settingsTab === "ai" && (
                  <>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                      <h4 style={{ margin: 0 }}>AI 服务商</h4>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <button onClick={() => setShowHelpCard(!showHelpCard)} style={{ border: "none", background: "none", cursor: "pointer", fontSize: 12, color: "var(--brand)", padding: 0, textDecoration: "underline" }}>
                          如何填写？
                        </button>
                        <button className="ghost-button" style={{ fontSize: 12, color: "var(--brand)", padding: "2px 8px" }} onClick={() => { setShowAddProvider(true); setProviderEditor({ editing: false, name: "", providerType: "openai", baseUrl: "", apiKey: "", models: "" }); }}>
                          <Plus size={14} /> 添加
                        </button>
                      </div>
                    </div>

                    {/* Provider list */}
                    {aiProviders.length > 0 && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {aiProviders.map((p) => (
                          <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 8, background: "var(--surface-soft)", border: "1px solid var(--line)", fontSize: 12 }}>
                            <div style={{ flex: 1, overflow: "hidden" }}>
                              <div style={{ fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</div>
                              <div style={{ color: "var(--muted)", fontSize: 11 }}>{p.providerType.toUpperCase()}{p.baseUrl ? ` · ${p.baseUrl}` : ""}</div>
                            </div>
                            <button className="ghost-button" style={{ fontSize: 11, padding: "2px 6px" }} onClick={() => { setProviderEditor({ editing: true, id: p.id, name: p.name, providerType: p.providerType, baseUrl: p.baseUrl, apiKey: p.apiKey, models: p.models ? p.models.join(",") : "" }); }}>编辑</button>
                            <button className="ghost-button" style={{ fontSize: 11, color: "var(--brand)", padding: "2px 6px" }} onClick={() => void deleteProvider(p.id)}><Trash2 size={12} /></button>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Provider add form */}
                    {showAddProvider && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8, padding: "10px 12px", borderRadius: 8, background: "var(--surface-tint)", border: "1px solid var(--brand-glow)" }}>
                        <input
                          type="text" placeholder="服务商名称 (如 我的GPT)"
                          value={providerEditor.name}
                          onChange={(e) => setProviderEditor({ ...providerEditor, name: e.target.value })}
                          style={{ padding: "5px 8px", borderRadius: 6, border: "1px solid var(--line-strong)", fontSize: 12 }}
                        />
                        <select
                          value={providerEditor.providerType}
                          onChange={(e) => setProviderEditor({ ...providerEditor, providerType: e.target.value })}
                          style={{ padding: "5px 8px", borderRadius: 6, border: "1px solid var(--line-strong)", fontSize: 12 }}
                        >
                      <option value="openai">GPT (OpenAI 兼容)</option>
                      <option value="deepseek">DeepSeek</option>
                      <option value="gemini">Gemini</option>
                        </select>
                        {providerEditor.providerType !== "gemini" && (
                        <div>
                          <input
                            type="text" placeholder="Base URL (如 https://api.openai.com)"
                            value={providerEditor.baseUrl}
                            onChange={(e) => setProviderEditor({ ...providerEditor, baseUrl: e.target.value })}
                            style={{ padding: "5px 8px", borderRadius: 6, border: "1px solid var(--line-strong)", fontSize: 12, fontFamily: "monospace", width: "100%", boxSizing: "border-box" }}
                          />
                          <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 2 }}>
                            系统会自动补齐末尾的 /v1 路径
                          </div>
                        </div>
                        )}
                        {providerEditor.providerType === "gemini" && (
                          <div style={{ fontSize: 11, color: "var(--muted)", padding: "4px 0" }}>
                            Gemini 使用 Google 原生 SDK，无需填写 Base URL
                          </div>
                        )}
                        <input
                          type="password" placeholder="API Key"
                          value={providerEditor.apiKey}
                          onChange={(e) => setProviderEditor({ ...providerEditor, apiKey: e.target.value })}
                          style={{ padding: "5px 8px", borderRadius: 6, border: "1px solid var(--line-strong)", fontSize: 12, fontFamily: "monospace" }}
                        />
                        <div>
                          <input
                            type="text" placeholder="模型列表 (逗号分隔，如 gpt-5.4,gpt-5.4-mini)"
                            value={providerEditor.models}
                            onChange={(e) => setProviderEditor({ ...providerEditor, models: e.target.value })}
                            style={{ padding: "5px 8px", borderRadius: 6, border: "1px solid var(--line-strong)", fontSize: 12, width: "100%", boxSizing: "border-box" }}
                          />
                          <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 2 }}>
                            不填则使用"自动获取"，需模型名与供应商一致
                          </div>
                        </div>
                        <div style={{ display: "flex", gap: 6 }}>
                          <button className="primary-button" style={{ fontSize: 12, padding: "4px 12px" }} onClick={() => void saveProvider()}>保存服务商</button>
                          <button className="ghost-button" style={{ fontSize: 12 }} onClick={() => { setShowAddProvider(false); setProviderEditor({ editing: false, name: "", providerType: "openai", baseUrl: "", apiKey: "", models: "" }); }}>取消</button>
                        </div>
                      </div>
                    )}

                    {/* Edit form */}
                    {providerEditor.editing && providerEditor.id !== undefined && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8, padding: "10px 12px", borderRadius: 8, background: "var(--surface-tint)", border: "1px solid var(--brand-glow)" }}>
                        <input
                          type="text" placeholder="服务商名称"
                          value={providerEditor.name}
                          onChange={(e) => setProviderEditor({ ...providerEditor, name: e.target.value })}
                          style={{ padding: "5px 8px", borderRadius: 6, border: "1px solid var(--line-strong)", fontSize: 12 }}
                        />
                        <select
                          value={providerEditor.providerType}
                          onChange={(e) => setProviderEditor({ ...providerEditor, providerType: e.target.value })}
                          style={{ padding: "5px 8px", borderRadius: 6, border: "1px solid var(--line-strong)", fontSize: 12 }}
                        >
                      <option value="openai">GPT (OpenAI 兼容)</option>
                      <option value="deepseek">DeepSeek</option>
                      <option value="gemini">Gemini</option>
                        </select>
                        {providerEditor.providerType !== "gemini" && (
                        <div>
                          <input
                            type="text" placeholder="Base URL"
                            value={providerEditor.baseUrl}
                            onChange={(e) => setProviderEditor({ ...providerEditor, baseUrl: e.target.value })}
                            style={{ padding: "5px 8px", borderRadius: 6, border: "1px solid var(--line-strong)", fontSize: 12, fontFamily: "monospace", width: "100%", boxSizing: "border-box" }}
                          />
                          <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 2 }}>
                            系统会自动补齐末尾的 /v1 路径
                          </div>
                        </div>
                        )}
                        {providerEditor.providerType === "gemini" && (
                          <div style={{ fontSize: 11, color: "var(--muted)", padding: "4px 0" }}>
                            Gemini 使用 Google 原生 SDK，无需填写 Base URL
                          </div>
                        )}
                        <input
                          type="password" placeholder="API Key"
                          value={providerEditor.apiKey}
                          onChange={(e) => setProviderEditor({ ...providerEditor, apiKey: e.target.value })}
                          style={{ padding: "5px 8px", borderRadius: 6, border: "1px solid var(--line-strong)", fontSize: 12, fontFamily: "monospace" }}
                        />
                        <div>
                          <input
                            type="text" placeholder="模型列表 (逗号分隔)"
                            value={providerEditor.models}
                            onChange={(e) => setProviderEditor({ ...providerEditor, models: e.target.value })}
                            style={{ padding: "5px 8px", borderRadius: 6, border: "1px solid var(--line-strong)", fontSize: 12, width: "100%", boxSizing: "border-box" }}
                          />
                          <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 2 }}>
                            不填则使用"自动获取"，需模型名与供应商一致
                          </div>
                        </div>
                        <div style={{ display: "flex", gap: 6 }}>
                          <button className="primary-button" style={{ fontSize: 12, padding: "4px 12px" }} onClick={() => void saveProvider()}>更新</button>
                          <button className="ghost-button" style={{ fontSize: 12 }} onClick={() => { setShowAddProvider(false); setProviderEditor({ editing: false, name: "", providerType: "openai", baseUrl: "", apiKey: "", models: "" }); }}>取消</button>
                        </div>
                      </div>
                    )}
                    {settingsMsg && settingsTab === "ai" && <p style={{ fontSize: 12, margin: "4px 0", color: settingsMsg.includes("失败") ? "var(--brand)" : "#2E7D32" }}>{settingsMsg}</p>}
                  </>
                )}

                {settingsTab === "db" && (
                  <>
                    <h4>数据存储设置</h4>
                    <p style={{ fontSize: 12, color: "var(--muted)", margin: "0 0 12px 0" }}>
                      本地模式使用 SQLite 单文件数据库，无需额外安装。远程模式连接 MariaDB 服务器。
                    </p>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
                        <input type="radio" name="dbMode" value="local" checked={dbMode === "local"}
                          onChange={() => setDbMode("local")} />
                        本地数据库（SQLite，当前设备）
                      </label>
                      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
                        <input type="radio" name="dbMode" value="remote" checked={dbMode === "remote"}
                          onChange={() => setDbMode("remote")} />
                        远程服务器（MariaDB）
                      </label>
                    </div>

                    {dbMode === "remote" && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8, padding: "8px 10px", borderRadius: 8, background: "var(--surface-tint)", border: "1px solid var(--brand-glow)" }}>
                        <label style={{ fontSize: 12 }}>
                          服务器地址
                          <input type="text" value={dbHost} onChange={(e) => setDbHost(e.target.value)}
                            placeholder="192.168.1.50" style={{ width: "100%", marginTop: 2, padding: "4px 6px", fontSize: 12, borderRadius: 4, border: "1px solid var(--line)" }} />
                        </label>
                        <div style={{ display: "flex", gap: 6 }}>
                          <label style={{ fontSize: 12, flex: 1 }}>
                            端口
                            <input type="number" value={dbPort} onChange={(e) => setDbPort(Number(e.target.value))}
                              style={{ width: "100%", marginTop: 2, padding: "4px 6px", fontSize: 12, borderRadius: 4, border: "1px solid var(--line)" }} />
                          </label>
                          <label style={{ fontSize: 12, flex: 1 }}>
                            数据库名
                            <input type="text" value={dbDatabase} onChange={(e) => setDbDatabase(e.target.value)}
                              style={{ width: "100%", marginTop: 2, padding: "4px 6px", fontSize: 12, borderRadius: 4, border: "1px solid var(--line)" }} />
                          </label>
                        </div>
                        <label style={{ fontSize: 12 }}>
                          用户名
                          <input type="text" value={dbUser} onChange={(e) => setDbUser(e.target.value)}
                            placeholder="projectx_app" style={{ width: "100%", marginTop: 2, padding: "4px 6px", fontSize: 12, borderRadius: 4, border: "1px solid var(--line)" }} />
                        </label>
                        <label style={{ fontSize: 12 }}>
                          密码 {dbHasPassword && <span style={{ color: "var(--muted)", fontSize: 11 }}>(已设置，留空不修改)</span>}
                          <input type="password" value={dbPassword} onChange={(e) => setDbPassword(e.target.value)}
                            placeholder={dbHasPassword ? "••••••" : "输入密码"} style={{ width: "100%", marginTop: 2, padding: "4px 6px", fontSize: 12, borderRadius: 4, border: "1px solid var(--line)" }} />
                        </label>
                      </div>
                    )}

                    {dbMode === "remote" && !dbHost.trim() && (
                      <p style={{ fontSize: 11, color: "var(--muted)", margin: "4px 0 0 0" }}>
                        ⚠ 远程服务器功能尚未完全启用。当前版本仅可在本地模式下使用。
                      </p>
                    )}

                    {dbMsg && <p style={{ fontSize: 12, margin: "8px 0 0", color: dbMsg.includes("失败") ? "var(--brand)" : "#2E7D32" }}>{dbMsg}</p>}
                    <button className="primary-button" type="button" onClick={() => { saveDbConfig(); }} disabled={dbLoading} style={{ marginTop: 8 }}>
                      {dbLoading ? "保存中..." : "保存数据存储设置"}
                    </button>
                    <p style={{ fontSize: 11, color: "var(--muted)", margin: "4px 0 0" }}>
                      修改数据存储模式后需重启服务器方可生效。
                    </p>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Help card modal — standalone overlay */}
      {showHelpCard && createPortal(
        <div className="modal-overlay" onClick={() => setShowHelpCard(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 500, width: "90vw", maxHeight: "85vh", overflowY: "auto" }}>
            <div className="modal-header">
              <h3 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>AI 服务商配置指南</h3>
              <button className="ghost-button" onClick={() => setShowHelpCard(false)}>
                <X size={18} />
              </button>
            </div>
            <div style={{ padding: "16px 20px", fontSize: 14, lineHeight: 1.8, color: "var(--text-secondary)" }}>
              <div style={{ marginBottom: 12 }}>
                <strong>Base URL</strong> 填 API 端点地址，<em>不是</em>网站首页。末尾无需 /v1 自动补齐。<strong>Gemini 无需填写 Base URL</strong>（使用 Google 原生 SDK，仅需 API Key）。
              </div>
              <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 12, fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--line)", textAlign: "left" }}>
                    <th style={{ padding: "6px 8px" }}>服务商</th>
                    <th style={{ padding: "6px 8px" }}>Base URL 示例</th>
                  </tr>
                </thead>
                <tbody>
                  <tr><td style={{ padding: "6px 8px", fontWeight: 500 }}>GPT</td><td style={{ padding: "6px 8px", fontFamily: "monospace", fontSize: 12 }}>https://api.openai.com</td></tr>
                  <tr><td style={{ padding: "6px 8px", fontWeight: 500 }}>DeepSeek</td><td style={{ padding: "6px 8px", fontFamily: "monospace", fontSize: 12 }}>https://api.deepseek.com</td></tr>
                  <tr><td style={{ padding: "6px 8px", fontWeight: 500 }}>Gemini</td><td style={{ padding: "6px 8px", fontSize: 12, color: "var(--muted)" }}>无需填写（Google 原生 SDK）</td></tr>
                  <tr><td style={{ padding: "6px 8px", fontWeight: 500 }}>Azure</td><td style={{ padding: "6px 8px", fontFamily: "monospace", fontSize: 12 }}>https://xxx.openai.azure.com/openai</td></tr>
                  <tr><td style={{ padding: "6px 8px", fontWeight: 500 }}>Ollama</td><td style={{ padding: "6px 8px", fontFamily: "monospace", fontSize: 12 }}>http://localhost:11434</td></tr>
                </tbody>
              </table>
              <div style={{ marginBottom: 8 }}>
                <strong>模型列表</strong> 填逗号分隔，如 <span style={{ fontFamily: "monospace" }}>gpt-5.4,gpt-5.4-mini</span>，留空自动获取。
              </div>
              <div style={{ marginBottom: 8 }}>
                <strong>类型说明</strong>：GPT / DeepSeek 走 OpenAI 兼容协议；<strong>Gemini 走 Google 原生 GenAI SDK</strong>（不兼容 OpenAI 协议，仅需 API Key）。
              </div>
              <div style={{ marginBottom: 8, padding: "8px 12px", borderRadius: 8, background: "var(--surface-tint)", border: "1px solid var(--line)" }}>
                <strong>Gemini API Key 获取</strong>：前往 <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer" style={{ color: "var(--brand)" }}>Google AI Studio</a> 创建 API Key，粘贴到上方 API Key 栏即可，<em>无需</em>填写 Base URL。
              </div>
              <div>
                <strong>使用前提</strong>：需要启动 Python llmclient 中转服务。<br />
                <span style={{ fontFamily: "monospace", fontSize: 13, background: "var(--surface-soft)", padding: "3px 8px", borderRadius: 4, display: "inline-block", marginTop: 4 }}>
                  py -m uvicorn llmclient.server:app --host 127.0.0.1 --port 8766
                </span>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
