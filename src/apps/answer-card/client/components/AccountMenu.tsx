import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  BookOpen,
  BrainCircuit,
  ChevronDown,
  Database,
  Download,
  Eye,
  FlaskConical,
  Gauge,
  Heart,
  KeyRound,
  LogOut,
  Monitor,
  Plus,
  Settings,
  Shield,
  Terminal,
  Trash2,
  Upload,
  User,
} from "lucide-react";
import { useAuth, type AppPersona, type TeacherRoleOverride } from "../auth/AuthContext";
import { fetchJson, authFetch } from "../auth/api";
import { ROLE_LABELS, TEACHER_ROLE_LABELS } from "../auth/types";
import { cn } from "../lib/utils";
import {
  Button,
  Checkbox,
  ControlRow,
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Field,
  Input,
  RadioGroup,
  RadioGroupItem,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "./ui/v2";
import type { AiProviderConfig } from "../../../../shared/types";

/** 判断是否为服务端脱敏后的 API Key（编辑时不应回传写库） */
function isMaskedApiKey(key: string): boolean {
  if (!key) return false;
  if (key === "••••") return true;
  return key.startsWith("••••••••") && key.length === 12;
}

type SettingsTab = "grading" | "client" | "ai" | "db";

interface ProviderEditorState {
  editing: boolean;
  id?: number;
  name: string;
  providerType: string;
  baseUrl: string;
  apiKey: string;
  models: string;
}

/** AI 服务商新增/编辑共用的表单（受控于父级 providerEditor 状态） */
function AiProviderForm({
  editor,
  onChange,
  onSave,
  onCancel,
  saveLabel,
}: {
  editor: ProviderEditorState;
  onChange: (patch: Partial<ProviderEditorState>) => void;
  onSave: () => void;
  onCancel: () => void;
  saveLabel: string;
}) {
  const { providerType } = editor;
  return (
    <div className="mt-2 flex flex-col gap-2 rounded-md border border-accent-border bg-accent p-2.5">
      <Input
        type="text"
        placeholder={editor.editing ? "服务商名称" : "服务商名称 (如 我的GPT)"}
        value={editor.name}
        onChange={(e) => onChange({ name: e.target.value })}
        className="text-sm"
      />
      <select
        value={providerType}
        onChange={(e) => onChange({ providerType: e.target.value })}
        className="h-control-md w-full rounded-md border border-input bg-card px-3 text-base text-foreground outline-none transition-[border-color,box-shadow] duration-(--px-dur-1) hover:border-input-hover focus-visible:shadow-focus focus-visible:border-primary"
      >
        <option value="openai">GPT (OpenAI 兼容)</option>
        <option value="deepseek">DeepSeek</option>
        <option value="gemini">Gemini</option>
      </select>
      {providerType !== "gemini" && (
        <div>
          <Input
            type="text"
            placeholder={editor.editing ? "Base URL" : "Base URL (如 https://api.openai.com)"}
            value={editor.baseUrl}
            onChange={(e) => onChange({ baseUrl: e.target.value })}
            className="w-full font-mono text-sm"
          />
          <div className="mt-0.5 text-xs text-muted-foreground">系统会自动补齐末尾的 /v1 路径</div>
        </div>
      )}
      {providerType === "gemini" && (
        <div className="py-1 text-xs text-muted-foreground">Gemini 使用 Google 原生 SDK，无需填写 Base URL</div>
      )}
      <Input
        type="password"
        placeholder="API Key"
        value={editor.apiKey}
        onChange={(e) => onChange({ apiKey: e.target.value })}
        className="font-mono text-sm"
      />
      <div>
        <Input
          type="text"
          placeholder={editor.editing ? "模型列表 (逗号分隔)" : "模型列表 (逗号分隔，如 gpt-5.4,gpt-5.4-mini)"}
          value={editor.models}
          onChange={(e) => onChange({ models: e.target.value })}
          className="w-full text-sm"
        />
        <div className="mt-0.5 text-xs text-muted-foreground">不填则使用"自动获取"，需模型名与供应商一致</div>
      </div>
      <div className="flex gap-1.5">
        <Button variant="primary" size="sm" onClick={onSave}>
          {saveLabel}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          取消
        </Button>
      </div>
    </div>
  );
}

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
  const { user, logout, isAdmin, persona, setPersona, teacherRoleOverride, setTeacherRoleOverride, availablePersonas, canSwitchPersona, refreshUser } = useAuth();
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
  const [demoBusy, setDemoBusy] = useState(false);
  const [showDevMode, setShowDevMode] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [displayMode, setDisplayMode] = useState("zscore");
  const [reviewThreshold, setReviewThreshold] = useState(0.12);
  const [bgOpacity, setBgOpacity] = useState(0);
  const bgFileRef = useRef<HTMLInputElement | null>(null);
  const bgSaveTimer = useRef<number | null>(null);
  const [bgMsg, setBgMsg] = useState("");
  const [settingsMsg, setSettingsMsg] = useState("");

  // Multi-provider AI management
  const [aiProviders, setAiProviders] = useState<AiProviderConfig[]>([]);
  const [showAddProvider, setShowAddProvider] = useState(false);
  const [providerEditor, setProviderEditor] = useState<ProviderEditorState>({
    editing: false, name: "", providerType: "openai", baseUrl: "", apiKey: "", models: ""
  });
  const [showHelpCard, setShowHelpCard] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("grading");
  // v1.9.0: Tab 栏开关
  const [showTabBar, setShowTabBar] = useState(false);

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
    if (showSettings) {
      fetchJson<{ scoreDisplayMode: string; reviewConfidenceThreshold: number; backgroundOpacity: number; showTabBar?: number }>("/api/users/me/settings")
        .then((s) => {
          if (!s || typeof s !== "object") return;
          setDisplayMode(s.scoreDisplayMode || "zscore");
          setReviewThreshold(s.reviewConfidenceThreshold ?? 0.12);
          setBgOpacity(s.backgroundOpacity ?? 0);
          setShowTabBar(s.showTabBar === 1);
        })
        .catch(() => {});
      loadProviders();
      loadDbConfig();
    }
  }, [showSettings]);

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
          showTabBar: showTabBar,
        })
      });
      setSettingsMsg("已保存");
      // v1.9.0: 刷新用户状态使 Tab 栏开关即时生效
      await refreshUser();
      setTimeout(() => setSettingsMsg(""), 1500);
    } catch (err) {
      setSettingsMsg(err instanceof Error ? err.message : "保存失败");
    }
  }

  // v1.9.5: 滑动背景图透明度时防抖持久化，避免刷新后被重置为 0
  const persistBgOpacity = (v: number) => {
    if (bgSaveTimer.current) window.clearTimeout(bgSaveTimer.current);
    bgSaveTimer.current = window.setTimeout(() => {
      fetchJson("/api/users/me/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backgroundOpacity: v }),
      }).catch(() => {});
    }, 400);
  };

  async function handleBgUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBgMsg("");
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await authFetch("/api/users/me/background", {
        method: "POST",
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
    const masked = isMaskedApiKey(apiKey);
    if (!name || !providerType || (!editing && !apiKey)) {
      setSettingsMsg("请填写完整信息");
      return;
    }
    if (providerType !== "gemini" && !baseUrl) {
      setSettingsMsg("请填写 Base URL");
      return;
    }
    try {
      const body: Record<string, unknown> = {
        name, providerType, baseUrl,
        models: models.trim() ? models.split(",").map((m) => m.trim()).filter(Boolean) : null
      };
      // 编辑时若 Key 未改动（仍为脱敏占位符），不传 apiKey 以免覆盖真实值
      if (!editing || !masked) {
        body.apiKey = apiKey;
      }
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

  // v1.9.5: 组件卸载时清理防抖定时器，避免对已卸载组件触发 PATCH
  useEffect(() => {
    return () => {
      if (bgSaveTimer.current) {
        window.clearTimeout(bgSaveTimer.current);
        bgSaveTimer.current = null;
      }
    };
  }, []);

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

  async function handleImportDemo() {
    if (!confirm("将导入演示测试数据（9 场考试、16 名学生、2 个合集，含网阅演示），不会覆盖现有数据。继续？")) return;
    setImportMsg("");
    setDemoBusy(true);
    try {
      const result = await fetchJson<{ ok: boolean; message?: string }>("/api/db/import-demo", { method: "POST" });
      setImportMsg(result.message || "演示数据导入完成");
    } catch (err) {
      setImportMsg(err instanceof Error ? err.message : "演示数据导入失败");
    } finally {
      setDemoBusy(false);
    }
  }

  async function handleClearDemo() {
    if (!confirm("将清除全部「演示-」前缀的演示数据（不影响真实数据）。继续？")) return;
    setImportMsg("");
    setDemoBusy(true);
    try {
      const result = await fetchJson<{ ok: boolean; message?: string }>("/api/db/clear-demo", { method: "POST" });
      setImportMsg(result.message || "演示数据已清除");
    } catch (err) {
      setImportMsg(err instanceof Error ? err.message : "演示数据清除失败");
    } finally {
      setDemoBusy(false);
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
  const resetProviderEditor = () =>
    setProviderEditor({ editing: false, name: "", providerType: "openai", baseUrl: "", apiKey: "", models: "" });

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

          <DropdownMenuItem onClick={() => { setShowSettings(true); setSettingsMsg(""); }}>
            <Settings size={15} /> 账号设置
          </DropdownMenuItem>

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
              {/* ── v1.9.6: 开发者模式子菜单（演示数据等高危功能，调研/导入演示用） ── */}
              <DropdownMenuItem
                onSelect={(e) => e.preventDefault()}
                onClick={() => { setShowDevMode(!showDevMode); setImportMsg(""); }}
                aria-expanded={showDevMode}
              >
                <Terminal size={15} /> 开发者模式
                <ChevronDown
                  size={14}
                  className={cn("ml-auto transition-transform duration-(--px-dur-1)", showDevMode && "rotate-180")}
                />
              </DropdownMenuItem>
              {showDevMode && (
                <div className="mx-1 mb-1 flex flex-col gap-0.5 rounded-sm border-l-2 border-border-subtle bg-secondary px-1 py-1">
                  <div className="px-2 py-0.5 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                    演示数据
                  </div>
                  <DropdownMenuItem
                    onClick={() => void handleImportDemo()}
                    disabled={demoBusy}
                    className="h-7 pl-4 text-sm"
                  >
                    <FlaskConical size={14} /> {demoBusy ? "处理中..." : "导入演示数据"}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => void handleClearDemo()}
                    disabled={demoBusy}
                    className="h-7 pl-4 text-sm"
                  >
                    <Trash2 size={14} /> 清除演示数据
                  </DropdownMenuItem>
                  {importMsg && (
                    <div className={cn("px-2 py-0.5 text-xs", importMsg.includes("失败") ? "text-primary" : "text-success")}>
                      {importMsg}
                    </div>
                  )}
                </div>
              )}
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

      {/* Settings dialog — v2 Dialog（Radix，自带 role/dialog + data-state） */}
      <Dialog open={showSettings} onOpenChange={setShowSettings}>
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>账号设置</DialogTitle>
          </DialogHeader>
          <Tabs
            orientation="vertical"
            value={settingsTab}
            onValueChange={(v) => setSettingsTab(v as SettingsTab)}
            className="flex min-h-0 flex-1"
          >
            <TabsList className="w-36 shrink-0 flex-col items-stretch gap-0.5 overflow-y-auto border-r border-border-subtle border-b-0 p-2">
              <TabsTrigger
                value="grading"
                className="h-auto justify-start gap-2 border-l-[3px] border-l-transparent px-3 py-2.5 text-sm font-medium text-muted-foreground data-[state=active]:border-l-primary data-[state=active]:bg-accent data-[state=active]:text-accent-foreground [&::after]:hidden"
              >
                <Gauge size={15} className="shrink-0" /> 阅卷设置
              </TabsTrigger>
              <TabsTrigger
                value="client"
                className="h-auto justify-start gap-2 border-l-[3px] border-l-transparent px-3 py-2.5 text-sm font-medium text-muted-foreground data-[state=active]:border-l-primary data-[state=active]:bg-accent data-[state=active]:text-accent-foreground [&::after]:hidden"
              >
                <Monitor size={15} className="shrink-0" /> 客户端设置
              </TabsTrigger>
              <TabsTrigger
                value="ai"
                className="h-auto justify-start gap-2 border-l-[3px] border-l-transparent px-3 py-2.5 text-sm font-medium text-muted-foreground data-[state=active]:border-l-primary data-[state=active]:bg-accent data-[state=active]:text-accent-foreground [&::after]:hidden"
              >
                <BrainCircuit size={15} className="shrink-0" /> AI 设置
              </TabsTrigger>
              {isAdmin && isElectron && (
                <TabsTrigger
                  value="db"
                  className="h-auto justify-start gap-2 border-l-[3px] border-l-transparent px-3 py-2.5 text-sm font-medium text-muted-foreground data-[state=active]:border-l-primary data-[state=active]:bg-accent data-[state=active]:text-accent-foreground [&::after]:hidden"
                >
                  <Database size={15} className="shrink-0" /> 数据存储
                </TabsTrigger>
              )}
            </TabsList>

            <TabsContent value="grading" className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-4">
              <h4 className="mb-1 mt-0 text-base font-semibold text-foreground">成绩指标显示</h4>
              <RadioGroup value={displayMode} onValueChange={setDisplayMode} className="gap-1.5">
                <div className="flex items-center gap-1.5 text-sm">
                  <RadioGroupItem value="deviation" id="dm-deviation" />
                  <label htmlFor="dm-deviation" className="cursor-pointer text-secondary-foreground select-none">
                    标准偏差值 (50为基准)
                  </label>
                </div>
                <div className="flex items-center gap-1.5 text-sm">
                  <RadioGroupItem value="zscore" id="dm-zscore" />
                  <label htmlFor="dm-zscore" className="cursor-pointer text-secondary-foreground select-none">
                    Z值 (0为基准)
                  </label>
                </div>
                <div className="flex items-center gap-1.5 text-sm">
                  <RadioGroupItem value="percentile" id="dm-percentile" />
                  <label htmlFor="dm-percentile" className="cursor-pointer text-secondary-foreground select-none">
                    百分位排名 (0~100)
                  </label>
                </div>
              </RadioGroup>
              <h4 className="mt-2 mb-1 text-base font-semibold text-foreground">
                复核置信度阈值: {reviewThreshold.toFixed(2)}
              </h4>
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={reviewThreshold}
                onChange={(e) => setReviewThreshold(Number(e.target.value))}
                className="mt-0.5 w-full"
              />
              <span className="text-xs text-muted-foreground">低于此值的题目标记"需要复核"</span>

              {/* v1.9.4: 原卷两开关已提升为纯全局，由管理员在「全局设置」统一控制，此处不再提供个人开关 */}

              {settingsMsg && (
                <p className={cn("m-0 text-xs", settingsMsg.includes("失败") ? "text-primary" : "text-success")}>
                  {settingsMsg}
                </p>
              )}
              <Button variant="primary" type="button" onClick={() => void saveSettings()} className="mt-1 self-start">
                保存设置
              </Button>
            </TabsContent>

            <TabsContent value="client" className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-4">
              <h4 className="mb-1 mt-0 text-base font-semibold text-foreground">底部导航栏</h4>
              <ControlRow
                control={<Checkbox checked={showTabBar} onCheckedChange={(c) => setShowTabBar(c === true)} />}
                label="显示底部 Tab 导航栏"
                description="顶部导航栏「首页」可随时返回，建议保持开启"
              />

              <h4 className="mt-4 mb-1 text-base font-semibold text-foreground">背景图透明度</h4>
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">
                  {Math.round(bgOpacity * 100)}%{bgOpacity === 0 ? " (关闭)" : ""}
                </span>
              </div>
              <input
                type="range"
                min="0"
                max="0.5"
                step="0.01"
                value={bgOpacity}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setBgOpacity(v);
                  document.documentElement.style.setProperty("--bg-opacity", String(v));
                  if (v > 0) document.body.classList.add("has-bg-image");
                  else document.body.classList.remove("has-bg-image");
                  persistBgOpacity(v);
                }}
                className="mt-1 w-full"
              />
              <span className="text-xs text-muted-foreground">0% = 关闭，建议 5%~15%（浮层叠加，不影响阅读）</span>
              <div className="mt-2 flex items-center gap-1.5">
                <Button variant="ghost" size="sm" onClick={() => bgFileRef.current?.click()}>
                  上传背景图
                </Button>
                <input ref={bgFileRef} type="file" accept="image/*" className="hidden" onChange={handleBgUpload} />
                {bgMsg && (
                  <span className={cn("text-xs", bgMsg.includes("失败") ? "text-primary" : "text-success")}>{bgMsg}</span>
                )}
              </div>
              {settingsMsg && (
                <p className={cn("m-0 text-xs", settingsMsg.includes("失败") ? "text-primary" : "text-success")}>
                  {settingsMsg}
                </p>
              )}
              <Button variant="primary" type="button" onClick={() => void saveSettings()} className="mt-1 self-start">
                保存设置
              </Button>
            </TabsContent>

            <TabsContent value="ai" className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-4">
              <div className="flex items-center justify-between">
                <h4 className="m-0 text-base font-semibold text-foreground">AI 服务商</h4>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setShowHelpCard(!showHelpCard)}
                    className="cursor-pointer border-0 bg-transparent p-0 text-xs text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
                  >
                    如何填写？
                  </button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs text-primary"
                    onClick={() => { setShowAddProvider(true); resetProviderEditor(); }}
                  >
                    <Plus size={14} /> 添加
                  </Button>
                </div>
              </div>

              {/* Provider list */}
              {aiProviders.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  {aiProviders.map((p) => (
                    <div
                      key={p.id}
                      className="flex items-center gap-2 rounded-md border border-border-subtle bg-secondary px-2.5 py-2 text-xs"
                    >
                      <div className="min-w-0 flex-1 overflow-hidden">
                        <div className="truncate font-medium text-foreground">{p.name}</div>
                        <div className="truncate text-xs text-muted-foreground">
                          {p.providerType.toUpperCase()}
                          {p.baseUrl ? ` · ${p.baseUrl}` : ""}
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-xs"
                        onClick={() => {
                          setProviderEditor({
                            editing: true,
                            id: p.id,
                            name: p.name,
                            providerType: p.providerType,
                            baseUrl: p.baseUrl,
                            apiKey: p.apiKey,
                            models: p.models ? p.models.join(",") : "",
                          });
                        }}
                      >
                        编辑
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-xs text-primary"
                        onClick={() => void deleteProvider(p.id)}
                      >
                        <Trash2 size={12} />
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              {/* Provider add form */}
              {showAddProvider && (
                <AiProviderForm
                  editor={providerEditor}
                  onChange={(patch) => setProviderEditor({ ...providerEditor, ...patch })}
                  onSave={() => void saveProvider()}
                  onCancel={() => { setShowAddProvider(false); resetProviderEditor(); }}
                  saveLabel="保存服务商"
                />
              )}

              {/* Edit form */}
              {providerEditor.editing && providerEditor.id !== undefined && (
                <AiProviderForm
                  editor={providerEditor}
                  onChange={(patch) => setProviderEditor({ ...providerEditor, ...patch })}
                  onSave={() => void saveProvider()}
                  onCancel={resetProviderEditor}
                  saveLabel="更新"
                />
              )}

              {settingsMsg && (
                <p className={cn("m-0 text-xs", settingsMsg.includes("失败") ? "text-primary" : "text-success")}>
                  {settingsMsg}
                </p>
              )}
            </TabsContent>

            <TabsContent value="db" className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-4">
              <h4 className="mb-1 mt-0 text-base font-semibold text-foreground">数据存储设置</h4>
              <p className="m-0 mb-3 text-xs text-muted-foreground">
                本地模式使用 SQLite 单文件数据库，无需额外安装。远程模式连接 MariaDB 服务器。
              </p>
              <RadioGroup
                value={dbMode}
                onValueChange={(v) => setDbMode(v as "local" | "remote")}
                className="gap-2"
              >
                <div className="flex items-center gap-2 text-sm">
                  <RadioGroupItem value="local" id="db-local" />
                  <label htmlFor="db-local" className="cursor-pointer text-secondary-foreground select-none">
                    本地数据库（SQLite，当前设备）
                  </label>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <RadioGroupItem value="remote" id="db-remote" />
                  <label htmlFor="db-remote" className="cursor-pointer text-secondary-foreground select-none">
                    远程服务器（MariaDB）
                  </label>
                </div>
              </RadioGroup>

              {dbMode === "remote" && (
                <div className="mt-2 flex flex-col gap-1.5 rounded-md border border-accent-border bg-accent p-2.5">
                  <Field label="服务器地址">
                    <Input
                      type="text"
                      value={dbHost}
                      onChange={(e) => setDbHost(e.target.value)}
                      placeholder="192.168.1.50"
                      className="text-sm"
                    />
                  </Field>
                  <div className="flex gap-1.5">
                    <Field label="端口" className="flex-1">
                      <Input
                        type="number"
                        value={dbPort}
                        onChange={(e) => setDbPort(Number(e.target.value))}
                        className="text-sm"
                      />
                    </Field>
                    <Field label="数据库名" className="flex-1">
                      <Input
                        type="text"
                        value={dbDatabase}
                        onChange={(e) => setDbDatabase(e.target.value)}
                        className="text-sm"
                      />
                    </Field>
                  </div>
                  <Field label="用户名">
                    <Input
                      type="text"
                      value={dbUser}
                      onChange={(e) => setDbUser(e.target.value)}
                      placeholder="projectx_app"
                      className="text-sm"
                    />
                  </Field>
                  <Field
                    label={
                      <>密码 {dbHasPassword && <span className="text-xs text-muted-foreground">(已设置，留空不修改)</span>}</>
                    }
                  >
                    <Input
                      type="password"
                      value={dbPassword}
                      onChange={(e) => setDbPassword(e.target.value)}
                      placeholder={dbHasPassword ? "••••••" : "输入密码"}
                      className="text-sm"
                    />
                  </Field>
                </div>
              )}

              {dbMode === "remote" && !dbHost.trim() && (
                <p className="m-0 text-xs text-muted-foreground">
                  <AlertTriangle size={15} aria-hidden="true" className="inline" />
                  远程服务器功能尚未完全启用。当前版本仅可在本地模式下使用。
                </p>
              )}

              {dbMsg && (
                <p className={cn("m-0 text-xs", dbMsg.includes("失败") ? "text-primary" : "text-success")}>{dbMsg}</p>
              )}
              <Button
                variant="primary"
                type="button"
                onClick={() => { saveDbConfig(); }}
                disabled={dbLoading}
                className="mt-2 self-start"
              >
                {dbLoading ? "保存中..." : "保存数据存储设置"}
              </Button>
              <p className="m-0 text-xs text-muted-foreground">
                修改数据存储模式后需重启服务器方可生效。
              </p>
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>

      {/* Help card dialog — v2 Dialog（Radix 独立覆盖层） */}
      <Dialog open={showHelpCard} onOpenChange={setShowHelpCard}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>AI 服务商配置指南</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <div className="space-y-3 text-base leading-relaxed text-secondary-foreground">
              <div>
                <strong>Base URL</strong> 填 API 端点地址，<em>不是</em>网站首页。末尾无需 /v1 自动补齐。
                <strong>Gemini 无需填写 Base URL</strong>（使用 Google 原生 SDK，仅需 API Key）。
              </div>
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border text-left">
                    <th className="px-2 py-1.5 font-medium text-foreground">服务商</th>
                    <th className="px-2 py-1.5 font-medium text-foreground">Base URL 示例</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="px-2 py-1.5 font-medium">GPT</td>
                    <td className="px-2 py-1.5 font-mono text-xs">https://api.openai.com</td>
                  </tr>
                  <tr>
                    <td className="px-2 py-1.5 font-medium">DeepSeek</td>
                    <td className="px-2 py-1.5 font-mono text-xs">https://api.deepseek.com</td>
                  </tr>
                  <tr>
                    <td className="px-2 py-1.5 font-medium">Gemini</td>
                    <td className="px-2 py-1.5 text-xs text-muted-foreground">无需填写（Google 原生 SDK）</td>
                  </tr>
                  <tr>
                    <td className="px-2 py-1.5 font-medium">Azure</td>
                    <td className="px-2 py-1.5 font-mono text-xs">https://xxx.openai.azure.com/openai</td>
                  </tr>
                  <tr>
                    <td className="px-2 py-1.5 font-medium">Ollama</td>
                    <td className="px-2 py-1.5 font-mono text-xs">http://localhost:11434</td>
                  </tr>
                </tbody>
              </table>
              <div>
                <strong>模型列表</strong> 填逗号分隔，如 <span className="font-mono">gpt-5.4,gpt-5.4-mini</span>，留空自动获取。
              </div>
              <div>
                <strong>类型说明</strong>：GPT / DeepSeek 走 OpenAI 兼容协议；
                <strong>Gemini 走 Google 原生 GenAI SDK</strong>（不兼容 OpenAI 协议，仅需 API Key）。
              </div>
              <div className="rounded-md border border-border bg-accent p-3">
                <strong>Gemini API Key 获取</strong>：前往{" "}
                <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer" className="text-primary">
                  Google AI Studio
                </a>{" "}
                创建 API Key，粘贴到上方 API Key 栏即可，<em>无需</em>填写 Base URL。
              </div>
              <div>
                <strong>使用前提</strong>：需要启动 Python llmclient 中转服务。
                <br />
                <span className="mt-1 inline-block rounded-sm bg-secondary px-2 py-1 font-mono text-sm">
                  py -m uvicorn llmclient.server:app --host 127.0.0.1 --port 8766
                </span>
              </div>
            </div>
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}
