import { useState, type FormEvent } from "react";
import { BookOpen, Globe, LogIn, Shield, X } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { BeianFooter } from "./BeianFooter";
import { UserGuideModal } from "./UserGuideModal";

// v1.6.0: 远端服务器配置
const SERVER_URL_STORAGE = "projectx_server_url";
const API_KEY_STORAGE = "projectx_api_key";

function loadServerUrl(): string {
  try { return localStorage.getItem(SERVER_URL_STORAGE) ?? ""; } catch { return ""; }
}
function saveServerUrl(url: string): void {
  try { localStorage.setItem(SERVER_URL_STORAGE, url); } catch { /* ignore */ }
}
function loadApiKey(): string {
  try { return localStorage.getItem(API_KEY_STORAGE) ?? ""; } catch { return ""; }
}
function saveApiKey(key: string): void {
  try { localStorage.setItem(API_KEY_STORAGE, key); } catch { /* ignore */ }
}

export function LoginPage() {
  const { login } = useAuth();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showGuide, setShowGuide] = useState(false);

  // v1.6.0: 远端连接配置
  const [showRemote, setShowRemote] = useState(!!loadServerUrl());
  const [serverUrl, setServerUrl] = useState(loadServerUrl());
  const [apiKey, setApiKey] = useState(loadApiKey());
  const [testStatus, setTestStatus] = useState<"" | "testing" | "ok" | "fail">("");

  async function handleTestConnection() {
    if (!serverUrl.trim()) return;
    setTestStatus("testing");
    try {
      const url = serverUrl.replace(/\/+$/, "") + "/api/app/health";
      const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        setTestStatus("ok");
        setTimeout(() => setTestStatus(""), 3000);
      } else {
        setTestStatus("fail");
      }
    } catch {
      setTestStatus("fail");
    }
  }

  function handleSaveRemoteConfig() {
    const url = serverUrl.trim().replace(/\/+$/, "");
    saveServerUrl(url);
    saveApiKey(apiKey.trim());
    setShowRemote(false);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (!identifier.trim() || !password) {
      setError("请输入用户名和密码");
      return;
    }
    // 每次提交前同步服务器URL到localStorage
    const url = serverUrl.trim().replace(/\/+$/, "");
    if (url) saveServerUrl(url);

    setBusy(true);
    try {
      await login(identifier.trim(), password, rememberMe);
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-shell">
      <div className="login-card">
        <div className="login-brand">
          <div className="login-brand-icon">
            <Shield size={28} />
          </div>
          <div>
            <strong>答题卡设计阅卷系统</strong>
            <span>Project-X · 账号登录</span>
          </div>
        </div>
        <form className="login-form" onSubmit={(e) => void handleSubmit(e)}>
          {/* ── v1.6.0: 远端服务器配置 ── */}
          <div style={{ marginBottom: 12 }}>
            <button
              type="button"
              className="ghost-button"
              style={{ width: "100%", justifyContent: "space-between", fontSize: 13, padding: "6px 10px" }}
              onClick={() => setShowRemote(!showRemote)}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <Globe size={14} />
                服务器连接（可选）
              </span>
              <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                {serverUrl ? `已配置: ${new URL(serverUrl).hostname}` : showRemote ? "收起" : "展开"}
              </span>
            </button>
            {showRemote && (
              <div style={{ marginTop: 8, padding: "10px 12px", background: "var(--surface-soft)", borderRadius: 6, fontSize: 12 }}>
                <div style={{ marginBottom: 8, color: "var(--text-secondary)" }}>
                  留空 = 纯本地模式（所有数据存本地SQLite）。填入服务器地址可在教师/学生端使用远程API。
                </div>
                <label style={{ display: "flex", flexDirection: "column", gap: 3, marginBottom: 6 }}>
                  <span style={{ fontWeight: 500 }}>服务器地址</span>
                  <input
                    type="text"
                    value={serverUrl}
                    onChange={(e) => {
                      setServerUrl(e.target.value);
                      setTestStatus("");
                    }}
                    placeholder="http://192.168.1.100:5174"
                    autoComplete="off"
                    style={{ fontSize: 13, padding: "4px 6px", borderRadius: 4, border: "1px solid var(--line)" }}
                  />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 3, marginBottom: 8 }}>
                  <span style={{ fontWeight: 500 }}>API Key（扫描端专用）</span>
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="sk-xxx..."
                    autoComplete="off"
                    style={{ fontSize: 13, padding: "4px 6px", borderRadius: 4, border: "1px solid var(--line)" }}
                  />
                </label>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <button
                    type="button"
                    className="ghost-button"
                    style={{ fontSize: 12, padding: "3px 10px" }}
                    onClick={() => void handleTestConnection()}
                    disabled={!serverUrl.trim() || testStatus === "testing"}
                  >
                    {testStatus === "testing" ? "测试中..." : "测试连接"}
                  </button>
                  {testStatus === "ok" && <span style={{ color: "#2E7D32", fontSize: 12 }}>服务器可达</span>}
                  {testStatus === "fail" && <span style={{ color: "var(--brand)", fontSize: 12 }}>连接失败</span>}
                  <button
                    type="button"
                    className="ghost-button"
                    style={{ fontSize: 12, padding: "3px 10px", marginLeft: "auto" }}
                    onClick={handleSaveRemoteConfig}
                  >
                    保存配置
                  </button>
                </div>
              </div>
            )}
          </div>

          <label>
            用户名 / 学号 / 职工号
            <input
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              placeholder="请输入用户名 / 学号"
              autoComplete="username"
              disabled={busy}
            />
          </label>
          <label>
            密码
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="请输入密码"
              autoComplete="current-password"
              disabled={busy}
            />
          </label>
          <label className="login-remember">
            <input
              type="checkbox"
              checked={rememberMe}
              onChange={(e) => setRememberMe(e.target.checked)}
              disabled={busy}
            />
            <span>记住密码（6个月内免登录）</span>
          </label>
          {error && <p className="login-error">{error}</p>}
          <button className="primary-button wide-button" type="submit" disabled={busy}>
            <LogIn size={17} /> {busy ? "登录中..." : "登录"}
          </button>
          <button
            className="ghost-button wide-button login-guide-button"
            type="button"
            onClick={() => setShowGuide(true)}
            disabled={busy}
          >
            <BookOpen size={16} /> 使用说明
          </button>
        </form>
      </div>
      <BeianFooter className="login-beian-footer" />
      <UserGuideModal open={showGuide} onClose={() => setShowGuide(false)} />
    </div>
  );
}
