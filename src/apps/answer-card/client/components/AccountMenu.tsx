import { useState } from "react";
import { ChevronDown, KeyRound, LogOut, User } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { fetchJson } from "../auth/api";
import { ROLE_LABELS } from "../auth/types";

export function AccountMenu() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

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

  return (
    <div className="account-menu">
      <button className="account-menu-trigger" type="button" onClick={() => setOpen(!open)}>
        <User size={16} />
        <span>{user.name}</span>
        <small>{ROLE_LABELS[user.role_name] ?? user.role_name}</small>
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
          <button type="button" className="account-menu-item danger" onClick={() => void logout()}>
            <LogOut size={15} /> 退出登录
          </button>
        </div>
      )}
      {open && <div className="account-menu-backdrop" onClick={() => setOpen(false)} />}
    </div>
  );
}
