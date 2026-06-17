import { useEffect, useRef, useState } from "react";
import { ChevronDown, Download, Heart, KeyRound, LogOut, Upload, User } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { fetchJson, getAuthToken } from "../auth/api";
import { ROLE_LABELS } from "../auth/types";

export function AccountMenu({ onOpenSponsor }: { onOpenSponsor?: () => void }) {
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
    </div>
  );
}
