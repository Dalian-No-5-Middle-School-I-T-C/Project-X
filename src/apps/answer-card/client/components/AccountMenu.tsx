import { useRef, useState } from "react";
import {
  BookOpen,
  ChevronDown,
  Download,
  ExternalLink,
  Eye,
  Heart,
  KeyRound,
  LogOut,
  Shield,
  Upload,
  User,
} from "lucide-react";
import { useAuth, type AppPersona, type TeacherRoleOverride } from "../auth/AuthContext";
import { fetchJson, authFetch } from "../auth/api";
import { ROLE_LABELS, TEACHER_ROLE_LABELS } from "../auth/types";
import { PROMO_SITE_URL } from "../lib/external-links";
import { cn } from "../lib/utils";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  RadioGroup,
  RadioGroupItem,
} from "./ui/v2";

export function AccountMenu({
  onOpenSponsor,
  onOpenGuide,
  onOpenPermissions,
  compact = false,
}: {
  onOpenSponsor?: () => void;
  onOpenGuide?: () => void;
  onOpenPermissions?: () => void;
  compact?: boolean;
}) {
  const { user, logout, isAdmin, persona, setPersona, teacherRoleOverride, setTeacherRoleOverride, availablePersonas, canSwitchPersona } = useAuth();
  // v1.6.0: 非 Electron 环境（WEB 端）不显示扫描端选项和数据库设置
  const isElectron = typeof navigator !== "undefined" && navigator.userAgent.includes("Electron");
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
      const resp = await authFetch("/api/db/backup");
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
      const resp = await authFetch("/api/db/restore", {
        method: "POST",
        headers: { "Content-Type": "application/zip" },
        body: file
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

  const roleLabel = TEACHER_ROLE_LABELS[user.teacher_role ?? ""] ?? ROLE_LABELS[user.role_name] ?? user.role_name;
  const personaLabels: Record<string, string> = { "teacher-scanner": "扫描端（全功能）", teacher: "教师端", student: "学生端（预览）" };

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="账号菜单"
            className={cn(
              "inline-flex shrink-0 items-center gap-2 rounded-md text-base font-medium outline-none",
              "transition-colors duration-(--px-dur-1) ease-standard",
              "hover:bg-secondary focus-visible:shadow-focus",
              compact
                ? "h-control-md w-control-md justify-center p-0"
                : "h-9 min-w-0 flex-1 justify-start px-2",
            )}
          >
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-semibold text-accent-foreground">
              {user.name?.charAt(0) || <User size={14} />}
            </span>
            {!compact && (
              <>
                <span className="flex min-w-0 flex-1 flex-col items-start leading-tight">
                  <span className="w-full truncate text-sm font-medium text-foreground">{user.name}</span>
                  <small className="w-full truncate text-xs text-muted-foreground">{roleLabel}</small>
                </span>
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
              </>
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="max-h-[min(72vh,640px)] w-64 overflow-y-auto">
          {/* 账号信息 */}
          <div className="px-2.5 pt-2 pb-1.5">
            <div className="text-base font-semibold text-foreground">{user.name}</div>
            <div className="text-xs text-muted-foreground">@{user.username}</div>
            {user.student_number && <div className="text-xs text-muted-foreground">学号 {user.student_number}</div>}
          </div>
          <DropdownMenuSeparator />

          {/* 修改密码（就地展开表单，菜单不关闭） */}
          <DropdownMenuItem
            onSelect={(e) => e.preventDefault()}
            onClick={() => {
              setShowPassword(!showPassword);
              setMessage("");
              setOldPassword("");
              setNewPassword("");
              setConfirmPassword("");
            }}
          >
            <KeyRound size={15} /> 修改密码
          </DropdownMenuItem>
          {showPassword && (
            <div className="mx-1 mb-1 flex flex-col gap-2 rounded-md border border-border bg-card p-2">
              <Input
                type="password"
                placeholder="原密码"
                value={oldPassword}
                onChange={(e) => setOldPassword(e.target.value)}
                disabled={busy}
                className="h-8 text-sm"
              />
              <Input
                type="password"
                placeholder="新密码（至少 6 位）"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                disabled={busy}
                className="h-8 text-sm"
              />
              <Input
                type="password"
                placeholder="确认新密码"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                disabled={busy}
                className="h-8 text-sm"
              />
              {message && (
                <p className={cn("m-0 text-xs", message.includes("已修改") ? "text-success" : "text-destructive-fg")}>
                  {message}
                </p>
              )}
              <Button variant="primary" size="sm" block type="button" onClick={() => void handleChangePassword()} disabled={busy}>
                确认修改
              </Button>
            </div>
          )}

          {/* ── v1.6.0: 管理员身份切换 ── */}
          {canSwitchPersona && (
            <>
              <DropdownMenuSeparator />
              <div className="px-2.5 py-2">
                <div className="mb-1.5 flex items-center gap-1 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                  <Eye size={12} className="shrink-0" />
                  查看身份
                </div>
                <RadioGroup value={persona} onValueChange={(v) => setPersona(v as AppPersona)} className="gap-1">
                  {availablePersonas.filter((p) => isElectron || p !== "teacher-scanner").map((p) => (
                    <div key={p} className="flex items-center gap-1.5 text-sm">
                      <RadioGroupItem value={p} id={`persona-${p}`} />
                      <label htmlFor={`persona-${p}`} className="cursor-pointer text-secondary-foreground select-none">
                        {personaLabels[p] ?? p}
                      </label>
                    </div>
                  ))}
                </RadioGroup>
                {persona === "teacher" && (
                  <div className="mt-1 ml-6">
                    <select
                      value={teacherRoleOverride ?? ""}
                      onChange={(e) => setTeacherRoleOverride((e.target.value || null) as TeacherRoleOverride)}
                      className="rounded-sm border border-border bg-card px-1.5 py-0.5 text-xs text-foreground outline-none focus-visible:shadow-focus"
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

          {/* 数据库导入导出 — 仅管理员可见 */}
          {isAdmin && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => void handleExportDb()}>
                <Download size={15} /> 导出数据
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => fileInputRef.current?.click()} disabled={importBusy}>
                <Upload size={15} /> {importBusy ? "导入中..." : "导入数据"}
              </DropdownMenuItem>
              <input
                ref={fileInputRef}
                type="file"
                accept=".zip"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleImportDb(file);
                }}
              />
            </>
          )}

          {onOpenGuide && (
            <DropdownMenuItem onClick={() => onOpenGuide()}>
              <BookOpen size={15} /> 使用说明
            </DropdownMenuItem>
          )}
          {onOpenSponsor && (
            <DropdownMenuItem onClick={() => onOpenSponsor()}>
              <Heart size={15} /> 支持项目
            </DropdownMenuItem>
          )}
          {/* 宣传网站外链入口（小屏 PageHeader 隐藏宣传图标时，仍可从这里访问 GitHub Pages 宣传站） */}
          <DropdownMenuItem
            onSelect={(e) => e.preventDefault()}
            onClick={() => window.open(PROMO_SITE_URL, "_blank", "noopener,noreferrer")}
          >
            <ExternalLink size={15} /> 访问宣传网站
          </DropdownMenuItem>
          {onOpenPermissions && user.role_name === "admin" && (
            <DropdownMenuItem onClick={() => onOpenPermissions()}>
              <Shield size={15} /> 权限管理
            </DropdownMenuItem>
          )}

          <DropdownMenuSeparator />
          <DropdownMenuItem tone="danger" onClick={() => void logout()}>
            <LogOut size={15} /> 退出登录
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
