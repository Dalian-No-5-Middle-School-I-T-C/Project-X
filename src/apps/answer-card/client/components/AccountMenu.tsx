import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Download, Heart, KeyRound, LogOut, Plus, Settings, Trash2, Upload, User, X, BookOpen } from "lucide-react";
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
  const { user, logout, isAdmin } = useAuth();
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

  useEffect(() => {
    if (open && showSettings) {
      fetchJson<{ scoreDisplayMode: string; reviewConfidenceThreshold: number; backgroundOpacity: number }>("/api/users/me/settings")
        .then((s) => {
          setDisplayMode(s.scoreDisplayMode || "zscore");
          setReviewThreshold(s.reviewConfidenceThreshold ?? 0.12);
          setBgOpacity(s.backgroundOpacity ?? 0);
        })
        .catch(() => {});
      loadProviders();
    }
  }, [open, showSettings]);

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
    if (!name || !providerType || !baseUrl || !apiKey) {
      setSettingsMsg("请填写完整信息");
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
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560, width: "92vw", maxHeight: "90vh", overflowY: "auto" }}>
            <div className="modal-header">
              <h3 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>账号设置</h3>
              <button className="ghost-button" onClick={() => setShowSettings(false)}>
                <X size={18} />
              </button>
            </div>
            <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 14 }}>
              <div className="account-settings-group">
                <label className="account-settings-label">成绩指标显示</label>
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
              </div>
              <div className="account-settings-group">
                <label className="account-settings-label">复核置信度阈值: {reviewThreshold.toFixed(2)}</label>
                <input type="range" min="0" max="1" step="0.01" value={reviewThreshold} onChange={(e) => setReviewThreshold(Number(e.target.value))} style={{ width: "100%", marginTop: 4 }} />
                <span style={{ fontSize: 11, color: "var(--muted)" }}>低于此值的题目标记"需要复核"</span>
              </div>

              {/* 背景图透明度 */}
              <div className="account-settings-group">
                <label className="account-settings-label" style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>背景图透明度</span>
                  <span style={{ fontWeight: 400, color: "var(--muted)" }}>{Math.round(bgOpacity * 100)}%{bgOpacity === 0 ? " (关闭)" : ""}</span>
                </label>
                <input type="range" min="0" max="0.5" step="0.01" value={bgOpacity} onChange={(e) => { const v = Number(e.target.value); setBgOpacity(v); document.documentElement.style.setProperty("--bg-opacity", String(v)); if (v > 0) document.body.classList.add("has-bg-image"); else document.body.classList.remove("has-bg-image"); }} style={{ width: "100%", marginTop: 4 }} />
                <span style={{ fontSize: 11, color: "var(--muted)" }}>0% = 关闭，建议 5%~15%（浮层叠加，不影响阅读）</span>
                <div style={{ marginTop: 6, display: "flex", gap: 6, alignItems: "center" }}>
                  <button
                    className="ghost-button"
                    style={{ fontSize: 11 }}
                    onClick={() => bgFileRef.current?.click()}
                  >上传背景图</button>
                  <input
                    ref={bgFileRef}
                    type="file"
                    accept="image/*"
                    style={{ display: "none" }}
                    onChange={handleBgUpload}
                  />
                  {bgMsg && <span style={{ fontSize: 11, color: bgMsg.includes("失败") ? "var(--brand)" : "#2E7D32" }}>{bgMsg}</span>}
                </div>
              </div>

              {/* ── AI 服务商管理 ── */}
              <div className="account-settings-group">
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                  <label className="account-settings-label" style={{ margin: 0 }}>AI 服务商</label>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <button
                      onClick={() => setShowHelpCard(!showHelpCard)}
                      style={{ border: "none", background: "none", cursor: "pointer", fontSize: 12, color: "var(--brand)", padding: 0, textDecoration: "underline" }}
                    >
                      如何填写？
                    </button>
                    <button
                      className="ghost-button"
                      style={{ fontSize: 12, color: "var(--brand)", padding: "2px 8px" }}
                      onClick={() => { setShowAddProvider(true); setProviderEditor({ editing: false, name: "", providerType: "openai", baseUrl: "", apiKey: "", models: "" }); }}
                    >
                      <Plus size={14} /> 添加
                    </button>
                  </div>
                </div>

                {/* Provider list */}
                    {aiProviders.length > 0 && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {aiProviders.map((p) => (
                          <div key={p.id} style={{
                            display: "flex", alignItems: "center", gap: 8,
                            padding: "8px 10px", borderRadius: 8, background: "var(--surface-soft)",
                            border: "1px solid var(--line)", fontSize: 12
                          }}>
                            <div style={{ flex: 1, overflow: "hidden" }}>
                              <div style={{ fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</div>
                              <div style={{ color: "var(--muted)", fontSize: 11 }}>{p.providerType.toUpperCase()} · {p.baseUrl}</div>
                            </div>
                            <button className="ghost-button" style={{ fontSize: 11, padding: "2px 6px" }} onClick={() => {
                              setProviderEditor({
                                editing: true, id: p.id,
                                name: p.name, providerType: p.providerType,
                                baseUrl: p.baseUrl, apiKey: p.apiKey,
                                models: p.models ? p.models.join(",") : ""
                              });
                            }}>编辑</button>
                            <button className="ghost-button" style={{ fontSize: 11, color: "var(--brand)", padding: "2px 6px" }} onClick={() => void deleteProvider(p.id)}>
                              <Trash2 size={12} />
                            </button>
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
                        <div>
                          <input
                            type="text" placeholder="Base URL (如 https://api.openai.com/v1)"
                            value={providerEditor.baseUrl}
                            onChange={(e) => setProviderEditor({ ...providerEditor, baseUrl: e.target.value })}
                            style={{ padding: "5px 8px", borderRadius: 6, border: "1px solid var(--line-strong)", fontSize: 12, fontFamily: "monospace", width: "100%", boxSizing: "border-box" }}
                          />
                          <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 2 }}>
                            系统会自动补齐末尾的 /v1 路径
                          </div>
                        </div>
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
              </div>
              {settingsMsg && <p style={{ fontSize: 12, margin: "4px 0", color: settingsMsg.includes("失败") ? "var(--brand)" : "#2E7D32" }}>{settingsMsg}</p>}
              <button className="primary-button" type="button" onClick={() => void saveSettings()}>保存设置</button>
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
                <strong>Base URL</strong> 填 API 端点地址，<em>不是</em>网站首页。末尾无需 /v1 自动补齐。
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
                  <tr><td style={{ padding: "6px 8px", fontWeight: 500 }}>Gemini</td><td style={{ padding: "6px 8px", fontFamily: "monospace", fontSize: 12 }}>https://generativelanguage.googleapis.com</td></tr>
                  <tr><td style={{ padding: "6px 8px", fontWeight: 500 }}>Azure</td><td style={{ padding: "6px 8px", fontFamily: "monospace", fontSize: 12 }}>https://xxx.openai.azure.com/openai</td></tr>
                  <tr><td style={{ padding: "6px 8px", fontWeight: 500 }}>Ollama</td><td style={{ padding: "6px 8px", fontFamily: "monospace", fontSize: 12 }}>http://localhost:11434</td></tr>
                </tbody>
              </table>
              <div style={{ marginBottom: 8 }}>
                <strong>模型列表</strong> 填逗号分隔，如 <span style={{ fontFamily: "monospace" }}>gpt-5.4,gpt-5.4-mini</span>，留空自动获取。
              </div>
              <div style={{ marginBottom: 8 }}>
                <strong>类型说明</strong>：GPT / DeepSeek 走 OpenAI 兼容协议；Gemini 走 Google 原生 API。
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
