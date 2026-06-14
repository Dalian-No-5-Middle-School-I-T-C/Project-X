import { useState, type FormEvent } from "react";
import { LogIn, Shield } from "lucide-react";
import { useAuth } from "../auth/AuthContext";

export function LoginPage() {
  const { login } = useAuth();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (!identifier.trim() || !password) {
      setError("请输入用户名和密码");
      return;
    }
    setBusy(true);
    try {
      await login(identifier.trim(), password);
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
            <strong>答题卡设计系统</strong>
            <span>Project-X · 账号登录</span>
          </div>
        </div>
        <form className="login-form" onSubmit={(e) => void handleSubmit(e)}>
          <label>
            用户名 / 学号 / 职工号
            <input
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              placeholder="admin 或学号"
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
          {error && <p className="login-error">{error}</p>}
          <button className="primary-button wide-button" type="submit" disabled={busy}>
            <LogIn size={17} /> {busy ? "登录中..." : "登录"}
          </button>
        </form>
        <p className="login-hint">首次使用默认管理员：admin / admin123，登录后请立即修改密码。</p>
      </div>
    </div>
  );
}
