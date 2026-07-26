import { useState, type FormEvent } from "react";
import { KeyRound, ShieldCheck } from "lucide-react";
import { fetchJson } from "./api";

interface Props {
  username: string;
  onChanged: () => void;
}

export function ForcedPasswordChange({ username, onChanged }: Props) {
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (newPassword !== confirmPassword) {
      setError("两次输入的新密码不一致");
      return;
    }
    setBusy(true);
    try {
      await fetchJson("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oldPassword, newPassword })
      });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "修改密码失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-shell">
      <div className="login-card">
        <div className="login-brand">
          <div className="login-brand-icon"><ShieldCheck size={28} /></div>
          <div><strong>首次登录安全设置</strong><span>账号 {username} 必须先修改一次性密码</span></div>
        </div>
        <form className="login-form" onSubmit={(event) => void submit(event)}>
          <label>一次性密码<input type="password" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} autoComplete="current-password" disabled={busy} /></label>
          <label>新密码<input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" disabled={busy} /></label>
          <label>确认新密码<input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} autoComplete="new-password" disabled={busy} /></label>
          {error && <p className="login-error">{error}</p>}
          <button className="primary-button wide-button" type="submit" disabled={busy || !oldPassword || !newPassword || !confirmPassword}>
            <KeyRound size={17} /> {busy ? "保存中..." : "修改密码并重新登录"}
          </button>
        </form>
      </div>
    </div>
  );
}
