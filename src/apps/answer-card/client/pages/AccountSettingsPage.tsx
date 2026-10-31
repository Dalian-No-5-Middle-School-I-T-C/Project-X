import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  BrainCircuit,
  Database,
  Gauge,
  Monitor,
  Moon,
  Plus,
  Sun,
  Trash2,
} from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { PERMISSIONS } from "../auth/types";
import { useWorkspace } from "../WorkspaceContext";
import { fetchJson, authFetch } from "../auth/api";
import { backgroundWriteSession } from "../lib/backgroundOpacityWrites";
import { cn } from "../lib/utils";
import { SkinSwitcher, SKIN_OPTIONS } from "../components/SkinSwitcher";
import {
  Button,
  Checkbox,
  ConfirmDialog,
  ControlRow,
  Switch,
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  RadioGroup,
  RadioGroupItem,
  SegmentedControl,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../components/ui/v2";
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
    <div className="flex flex-col gap-2 rounded-md border border-accent-border bg-accent p-3">
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

/**
 * /account-settings 路由页：个人「账号设置」（阅卷/客户端/AI/数据存储）。
 * 由 AccountMenu 的设置 Dialog 迁移为独立页面（v2 UI 重构 P6）。
 *
 * #322: 「阅卷设置」页签只对持 grade:write 的账号渲染。学生账号不提供背景图透明度，
 * 也不能上传或移除背景图；网页端始终不挂背景浮层。后端（阅卷字段门、背景透明度门、
 * 上传门、背景 GET 404）是同一规则的强制层，这里只是不再把不可用的控件摆出来。
 * 学生清自己的历史文件走 DELETE 接口，批量清退在管理员的全局设置里。
 *
 * P6 重写：放弃 vertical Tabs 左栏列布局（v2 Tabs 对 vertical 支持不佳时内容列塌缩），
 * 改为 v2 Tabs 默认「横向顶部 Tab 条 + 内容区全宽自然排布」，页面容器放宽为 max-w-5xl。
 * 功能零丢失，仅重排布局与样式。
 */
export function AccountSettingsPage() {
  const { user, isAdmin, isStudent, hasPermission, refreshUser } = useAuth();
  // #322: 阅卷设置看 grade:write（canWriteGradingSelfSettings）。
  // 背景图显示、透明度与上传看学生身份，不看权限位。
  // 无身份的单机免登录模式保持可用，与后端「无用户时不收敛」的口径一致。
  const canEditGradingSettings = !user || hasPermission(PERMISSIONS.GRADE_WRITE);
  const canUploadBackground = !isStudent;
  // v2.1.0: 皮肤/明暗状态由 App 顶层持有（WorkspaceContext 下发），此处直接读改即时生效
  const { theme, setTheme, skin, setSkin, setShowBg } = useWorkspace();
  // v1.6.0: 非 Electron 环境（WEB 端）不显示扫描端选项和数据库设置
  const isElectron = typeof navigator !== "undefined" && navigator.userAgent.includes("Electron");

  const [displayMode, setDisplayMode] = useState("zscore");
  const [reviewThreshold, setReviewThreshold] = useState(0.12);
  const [bgOpacity, setBgOpacity] = useState(0);
  const [bgLimit, setBgLimit] = useState("");
  const bgFileRef = useRef<HTMLInputElement | null>(null);
  const bgSaveTimer = useRef<number | null>(null);
  const bgSessionKey = user ? `user:${user.id}` : "anonymous";
  const bgSession = useMemo(() => backgroundWriteSession(bgSessionKey), [bgSessionKey]);
  const [bgMsg, setBgMsg] = useState("");
  const [bgMsgTone, setBgMsgTone] = useState<"success" | "error">("success");
  const [removeBgOpen, setRemoveBgOpen] = useState(false);
  const [removeBgBusy, setRemoveBgBusy] = useState(false);
  const [bgBusy, setBgBusy] = useState(false);
  const [settingsMsg, setSettingsMsg] = useState("");

  // Multi-provider AI management
  const [aiProviders, setAiProviders] = useState<AiProviderConfig[]>([]);
  const [showAddProvider, setShowAddProvider] = useState(false);
  const [providerEditor, setProviderEditor] = useState<ProviderEditorState>({
    editing: false, name: "", providerType: "openai", baseUrl: "", apiKey: "", models: ""
  });
  const [showHelpCard, setShowHelpCard] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("grading");
  // #322: 没有「阅卷设置」页签时，默认落点回退到「客户端设置」，避免出现空白内容区。
  // 只在请求的正是被隐藏的 grading 时回退——其余页签（客户端 / AI 服务商 / 数据存储）
  // 本来就该保留：无脑回退会把学生的 AI 页签也锁死。
  const activeSettingsTab: SettingsTab =
    !canEditGradingSettings && settingsTab === "grading" ? "client" : settingsTab;
  // 五轮C1：侧边栏自动展开（客户端级 localStorage 设置，原误放系统级配置页，迁至此「外观/皮肤」区）
  const [railAutoExpand, setRailAutoExpand] = useState(() => {
    try { return localStorage.getItem("projectx-rail-auto-expand") === "true"; } catch { return false; }
  });
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
    fetchJson<{ scoreDisplayMode: string; reviewConfidenceThreshold: number; backgroundOpacity: number; showTabBar?: number; backgroundUploadLimit?: string }>("/api/users/me/settings")
      .then((s) => {
        if (!s || typeof s !== "object") return;
        setDisplayMode(s.scoreDisplayMode || "zscore");
        setReviewThreshold(s.reviewConfidenceThreshold ?? 0.12);
        setBgOpacity(s.backgroundOpacity ?? 0);
        setShowTabBar(s.showTabBar === 1);
        if (typeof s.backgroundUploadLimit === "string") setBgLimit(s.backgroundUploadLimit);
      })
      .catch(() => {});
    loadProviders();
    loadDbConfig();
  }, []);

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

  function clearPendingBgOpacity() {
    if (bgSaveTimer.current) window.clearTimeout(bgSaveTimer.current);
    bgSaveTimer.current = null;
  }

  async function saveSettings() {
    setSettingsMsg("");
    clearPendingBgOpacity();
    try {
      // 越权字段一出现，后端整单 403。学生不提交阅卷字段和背景透明度，
      // 否则「客户端设置」的保存会被连坐失败。
      const payload: Record<string, unknown> = { showTabBar };
      if (!isStudent) {
        payload.backgroundOpacity = bgOpacity;
      }
      if (canEditGradingSettings) {
        payload.scoreDisplayMode = displayMode;
        payload.reviewConfidenceThreshold = reviewThreshold;
      }
      // 跟滑块 PATCH、移除 DELETE 排进同一条会话队列，避免保存与在途透明度写交错。
      const executed = await bgSession.enqueue(() => fetchJson("/api/users/me/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }).then(() => undefined));
      if (!executed) { setSettingsMsg("账号已切换，本次设置未保存"); return; }
      setSettingsMsg("已保存");
      // v1.9.0: 刷新用户状态使 Tab 栏开关即时生效
      await refreshUser();
      setTimeout(() => setSettingsMsg(""), 1500);
    } catch (err) {
      setSettingsMsg(err instanceof Error ? err.message : "保存失败");
    }
  }

  // v1.9.5: 滑动背景图透明度时防抖持久化，避免刷新后被重置为 0。
  // 真正发出的请求进会话队列，移除背景时可以排在它后面把透明度归零。
  const persistBgOpacity = (v: number) => {
    if (isStudent) return;
    clearPendingBgOpacity();
    bgSaveTimer.current = window.setTimeout(() => {
      bgSaveTimer.current = null;
      void bgSession.enqueue(() => fetchJson("/api/users/me/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backgroundOpacity: v }),
      }).then(() => undefined)).catch(() => {});
    }, 400);
  };

  async function handleBgUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || isStudent || bgBusy || removeBgBusy) return;
    setBgBusy(true);
    setBgMsg("");
    try {
      const form = new FormData();
      form.append("file", file);
      // 上传也进同一条会话队列：与待发送的透明度 PATCH、移除 DELETE 串行，避免 rename 与删除交错。
      const executed = await bgSession.enqueue(async () => {
        const res = await authFetch("/api/users/me/background", {
          method: "POST",
          body: form
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({} as { error?: string; message?: string }));
          throw new Error(err.message || err.error || "上传失败");
        }
      });
      if (!executed) return;
      setBgMsgTone("success");
      setBgMsg("上传成功，刷新后生效");
      setTimeout(() => setBgMsg(""), 3000);
    } catch (err) {
      setBgMsgTone("error");
      setBgMsg(err instanceof Error ? err.message : "上传失败");
    } finally {
      setBgBusy(false);
      // Reset input so same file can be re-uploaded
      e.target.value = "";
    }
  }

  async function handleRemoveBackground() {
    if (bgBusy) return;
    const previousOpacity = bgOpacity;
    clearPendingBgOpacity();
    // 先把 Workspace 透明度拉回 0，并清掉滑块直接写过的浮层。
    // 进入本页时 showBg 已是 0 的话，setShowBg(0) 不会触发 App 的 effect。
    setBgOpacity(0);
    setShowBg(0);
    document.documentElement.style.setProperty("--bg-opacity", "0");
    document.body.classList.remove("has-bg-image");
    setRemoveBgBusy(true);
    setBgMsg("");
    try {
      const executed = await bgSession.enqueue(() => fetchJson("/api/users/me/background", { method: "DELETE" }).then(() => undefined));
      if (!executed) {
        if (previousOpacity > 0) {
          setBgOpacity(previousOpacity);
          setShowBg(previousOpacity);
          document.documentElement.style.setProperty("--bg-opacity", String(previousOpacity));
          document.body.classList.add("has-bg-image");
        }
        setBgMsgTone("error");
        setBgMsg("账号已切换，本次移除未执行");
        return;
      }
      setBgMsgTone("success");
      setBgMsg("已移除背景图");
      setRemoveBgOpen(false);
      setTimeout(() => setBgMsg(""), 3000);
    } catch (err) {
      // 服务端文件与透明度都还在；把本地预览恢复到移除前，避免界面谎报已关闭。
      if (previousOpacity > 0) {
        setBgOpacity(previousOpacity);
        setShowBg(previousOpacity);
        document.documentElement.style.setProperty("--bg-opacity", String(previousOpacity));
        document.body.classList.add("has-bg-image");
      }
      setBgMsgTone("error");
      setBgMsg(err instanceof Error ? err.message : "移除失败，背景设置未变");
    } finally {
      setRemoveBgBusy(false);
    }
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

  const resetProviderEditor = () =>
    setProviderEditor({ editing: false, name: "", providerType: "openai", baseUrl: "", apiKey: "", models: "" });

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6">
      <div className="flex flex-col overflow-hidden rounded-lg border border-border bg-card">
        {/* 页面头部 */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border-subtle px-5 py-4">
          <div className="min-w-0">
            <h1 className="mb-0 text-lg font-semibold text-foreground">账号设置</h1>
            <p className="m-0 mt-1.5 text-xs text-muted-foreground">
              {canEditGradingSettings ? "阅卷 · 客户端 · AI 服务商 · 数据存储" : "客户端 · AI 服务商"}
            </p>
          </div>
        </div>

        {/* v2 Tabs 默认横向：顶部 Tab 条 + 内容区全宽自然排布（绕开 vertical 列布局塌缩） */}
        <Tabs
          value={activeSettingsTab}
          onValueChange={(v) => setSettingsTab(v as SettingsTab)}
        >
          <TabsList className="px-5">
            {/* #322: 没有 grade:write 的账号不提供「阅卷设置」页签 */}
            {canEditGradingSettings && (
              <TabsTrigger value="grading">
                <Gauge size={15} /> 阅卷设置
              </TabsTrigger>
            )}
            <TabsTrigger value="client">
              <Monitor size={15} /> 客户端设置
            </TabsTrigger>
            <TabsTrigger value="ai">
              <BrainCircuit size={15} /> AI 设置
            </TabsTrigger>
            {isAdmin && isElectron && (
              <TabsTrigger value="db">
                <Database size={15} /> 数据存储
              </TabsTrigger>
            )}
          </TabsList>

          {/* #322: 阅卷设置整块对无 grade:write 的账号不渲染（后端同时按字段拒绝越权写入） */}
          {canEditGradingSettings && (
            <TabsContent value="grading" className="flex flex-col gap-4 px-5 py-5">
              <div className="flex max-w-xl flex-col gap-4">
                <section className="flex flex-col gap-2">
                  <h4 className="m-0 text-base font-semibold text-foreground">成绩指标显示</h4>
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
                </section>

                <section className="flex flex-col gap-2">
                  <h4 className="m-0 text-base font-semibold text-foreground">
                    复核置信度阈值: <span className="tabular-nums">{reviewThreshold.toFixed(2)}</span>
                  </h4>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={reviewThreshold}
                    onChange={(e) => setReviewThreshold(Number(e.target.value))}
                    className="w-full"
                  />
                  <span className="text-xs text-muted-foreground">低于此值的题目标记"需要复核"</span>
                </section>

                {/* v1.9.4: 原卷两开关已提升为纯全局，由管理员在「全局设置」统一控制，此处不再提供个人开关 */}
              </div>

              {settingsMsg && (
                <p className={cn("m-0 text-xs", settingsMsg.includes("失败") ? "text-primary" : "text-success")}>
                  {settingsMsg}
                </p>
              )}
              <Button variant="primary" type="button" onClick={() => void saveSettings()} className="self-start">
                保存设置
              </Button>
            </TabsContent>
          )}

          <TabsContent value="client" className="flex flex-col gap-4 px-5 py-5">
            <div className="flex max-w-xl flex-col gap-4">
              {/* v2.1.0: 外观 / 皮肤 — 皮肤=风格维度（随账号同步）；明暗为设备级偏好（仅存本地）；v2.3.0 当前皮肤名跟随注册表动态显示 */}
              <section className="flex flex-col gap-2">
                <h4 className="m-0 text-base font-semibold text-foreground">外观 / 皮肤</h4>
                <ControlRow
                  control={<SkinSwitcher skin={skin} onSkinChange={setSkin} theme={theme} onThemeChange={setTheme} size="sm" />}
                  label="皮肤风格"
                  description={`当前：${SKIN_OPTIONS.find((o) => o.id === skin)?.label ?? skin}`}
                />
                <ControlRow
                  control={
                    <SegmentedControl
                      value={theme}
                      onValueChange={(v) => setTheme(v as "light" | "dark")}
                      items={[
                        { value: "light", label: "亮色", icon: <Sun size={15} /> },
                        { value: "dark", label: "暗色", icon: <Moon size={15} /> },
                      ]}
                      size="sm"
                      aria-label="明暗模式"
                    />
                  }
                  label="明暗模式"
                  description="亮色/暗色即时生效，仅在本设备保存；界面皮肤会跟随账号。"
                />
                <ControlRow
                  reverse
                  control={
                    <Switch
                      checked={railAutoExpand}
                      onCheckedChange={(next) => {
                        setRailAutoExpand(next === true);
                        try { localStorage.setItem("projectx-rail-auto-expand", String(next === true)); } catch { /* ignore storage failures */ }
                        window.dispatchEvent(new CustomEvent("projectx:rail-auto-expand", { detail: next === true }));
                      }}
                    />
                  }
                  label="侧边栏自动展开"
                  description="收起后，鼠标移到侧边栏会自动展开；关闭后可用圆形按钮展开。仅在本机浏览器生效。"
                />
              </section>

              <section className="flex flex-col gap-2">
                <h4 className="m-0 text-base font-semibold text-foreground">底部导航栏</h4>
                <ControlRow
                  control={<Checkbox checked={showTabBar} onCheckedChange={(c) => setShowTabBar(c === true)} />}
                  label="显示底部 Tab 导航栏"
                  description="顶部导航栏「首页」可随时返回，建议保持开启"
                />
              </section>

              {!isStudent && (
              <section className="flex flex-col gap-2">
                <h4 className="m-0 text-base font-semibold text-foreground">背景图透明度</h4>
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
                    // 浮层由 Workspace 的 showBg 驱动，滑块只改这份状态。
                    setShowBg(v);
                    persistBgOpacity(v);
                  }}
                  className="w-full"
                />
                <span className="text-xs text-muted-foreground">
                  0% = 关闭，建议 5%~15%（浮层叠加，不影响阅读）
                  {bgLimit ? `。单张不超过 ${bgLimit}` : ""}
                </span>
                <div className="flex items-center gap-1.5">
                  {/* 学生整段背景区不渲染。上传仍按学生身份单独判断，不看 grade:write。 */}
                  {canUploadBackground && (
                    <>
                      <Button variant="ghost" size="sm" disabled={bgBusy || removeBgBusy} onClick={() => bgFileRef.current?.click()}>
                        上传背景图
                      </Button>
                      <Button variant="ghost" size="sm" disabled={bgBusy || removeBgBusy} onClick={() => setRemoveBgOpen(true)}>
                        移除背景图
                      </Button>
                      <input ref={bgFileRef} type="file" accept="image/*" className="hidden" disabled={bgBusy || removeBgBusy} onChange={handleBgUpload} />
                    </>
                  )}
                  {bgMsg && (
                    <span className={cn("text-xs", bgMsgTone === "error" ? "text-primary" : "text-success")}>{bgMsg}</span>
                  )}
                </div>
              </section>
              )}
            </div>

            {settingsMsg && (
              <p className={cn("m-0 text-xs", settingsMsg.includes("失败") ? "text-primary" : "text-success")}>
                {settingsMsg}
              </p>
            )}
            <Button variant="primary" type="button" onClick={() => void saveSettings()} className="self-start">
              保存设置
            </Button>
          </TabsContent>

          <TabsContent value="ai" className="flex flex-col gap-4 px-5 py-5">
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
              <div className="flex max-w-2xl flex-col gap-1.5">
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
            <div className="flex max-w-xl flex-col gap-4">
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
            </div>

            {settingsMsg && (
              <p className={cn("m-0 text-xs", settingsMsg.includes("失败") ? "text-primary" : "text-success")}>
                {settingsMsg}
              </p>
            )}
          </TabsContent>

          <TabsContent value="db" className="flex flex-col gap-4 px-5 py-5">
            <div className="flex max-w-xl flex-col gap-4">
              <section className="flex flex-col gap-2">
                <h4 className="m-0 text-base font-semibold text-foreground">数据存储设置</h4>
                <p className="m-0 text-xs text-muted-foreground">
                  本地模式使用 SQLite 单文件数据库，无需额外安装。远程模式连接 MariaDB 服务器。
                </p>
              </section>
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
                <div className="flex flex-col gap-2 rounded-md border border-accent-border bg-accent p-3">
                  <Field label="服务器地址">
                    <Input
                      type="text"
                      value={dbHost}
                      onChange={(e) => setDbHost(e.target.value)}
                      placeholder="192.168.1.50"
                      className="text-sm"
                    />
                  </Field>
                  <div className="flex gap-2">
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
                className="self-start"
              >
                {dbLoading ? "保存中..." : "保存数据存储设置"}
              </Button>
              <p className="m-0 text-xs text-muted-foreground">
                修改数据存储模式后需重启服务器方可生效。
              </p>
            </div>
          </TabsContent>
        </Tabs>
      </div>

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
      <ConfirmDialog
        open={removeBgOpen}
        onOpenChange={setRemoveBgOpen}
        title="移除背景图"
        description="将删除你上传的背景图，并把透明度调回关闭。此操作不能恢复。"
        confirmLabel="移除"
        tone="danger"
        loading={removeBgBusy}
        onConfirm={() => { void handleRemoveBackground(); }}
      />
    </div>
  );
}
