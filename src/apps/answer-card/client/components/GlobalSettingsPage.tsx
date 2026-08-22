import { useState, useEffect, useCallback, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, FlaskConical, Terminal, Trash2 } from "lucide-react";
import { fetchJson } from "../auth/api";
import { cn } from "../lib/utils";
import { tokens } from "../theme";
import {
  Button,
  Input,
  Field,
  Switch,
  ControlRow,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Card,
} from "./ui/v2";

interface Props {
  onBack: () => void;
}

type Settings = {
  require_original_paper?: string;
  highlight_missing_paper?: string;
};

const FIELDS: Array<{ key: keyof Settings; label: string; desc: string; type: "toggle" | "number" | "select"; options?: Array<{ value: string; label: string }> }> = [
  { key: "require_original_paper", label: "强制要求上传原卷", desc: "创建答题卡后必须上传原卷才能导出（全平台统一）", type: "toggle" },
  { key: "highlight_missing_paper", label: "侧边栏高亮未上传原卷", desc: "左侧列表用颜色标记缺少原卷的考试（全平台统一）", type: "toggle" },
];

// 难度/区分度档位（与后端 analysisConfig 默认一致）
type Band = { max: number; label: string; color: string };
const BAND_KEY_DIFF = "analysis_difficulty_bands";
const BAND_KEY_DISC = "analysis_discrimination_bands";
const DEFAULT_DIFFICULTY_BANDS: Band[] = [
  { max: 0.3, label: "难", color: "var(--px-danger-bg)" },
  { max: 0.5, label: "较难", color: "var(--px-warning-bg)" },
  { max: 0.7, label: "中等", color: "var(--px-amber-700)" },
  { max: 1, label: "容易", color: "var(--px-success-bg)" },
];
const DEFAULT_DISCRIMINATION_BANDS: Band[] = [
  { max: 0.2, label: "差", color: "var(--px-danger-bg)" },
  { max: 0.3, label: "尚可", color: "var(--px-warning-bg)" },
  { max: 0.4, label: "良好", color: "var(--px-amber-700)" },
  { max: 1, label: "优秀", color: "var(--px-success-bg)" },
];

export function GlobalSettingsPage({ onBack }: Props) {
  const [settings, setSettings] = useState<Settings>({});
  const [draft, setDraft] = useState<Settings>({});
  const [diffBands, setDiffBands] = useState<Band[]>(DEFAULT_DIFFICULTY_BANDS);
  const [discBands, setDiscBands] = useState<Band[]>(DEFAULT_DISCRIMINATION_BANDS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageTone, setMessageTone] = useState<"success" | "error">("error");
  const [railAutoExpand, setRailAutoExpand] = useState(false);

  useEffect(() => {
    // v2.1.0: 自动展开默认关闭（与 App.tsx 默认值保持一致）
    try { setRailAutoExpand(localStorage.getItem("projectx-rail-auto-expand") === "true"); } catch { /* ignore */ }
  }, []);

  const toggleRailAutoExpand = () => {
    const next = !railAutoExpand;
    setRailAutoExpand(next);
    try { localStorage.setItem("projectx-rail-auto-expand", String(next)); } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent("projectx:rail-auto-expand", { detail: next }));
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchJson<{ ok: boolean; data: Settings }>("/api/system-settings");
      if (res.ok) {
        const data = (res.data ?? {}) as Record<string, string>;
        setSettings(data as Settings);
        setDraft(data as Settings);
        try { if (data[BAND_KEY_DIFF]) setDiffBands(JSON.parse(data[BAND_KEY_DIFF])); } catch { /* keep default */ }
        try { if (data[BAND_KEY_DISC]) setDiscBands(JSON.parse(data[BAND_KEY_DISC])); } catch { /* keep default */ }
      }
    } catch { /* silent */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const setField = (key: keyof Settings, value: string) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setMessage(null);
  };

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const payload: Record<string, string> = {
        ...(draft as Record<string, string>),
        [BAND_KEY_DIFF]: JSON.stringify([...diffBands].sort((a, b) => a.max - b.max)),
        [BAND_KEY_DISC]: JSON.stringify([...discBands].sort((a, b) => a.max - b.max)),
      };
      const res = await fetchJson<{ ok: boolean; error?: string }>("/api/system-settings", {
        method: "PUT",
        body: JSON.stringify({ settings: payload }),
      });
      if (res.ok) {
        setSettings(payload as Settings);
        setMessage("已保存全局设置");
        setMessageTone("success");
      } else {
        setMessage((res as any).error ?? "保存失败");
        setMessageTone("error");
      }
    } catch (err: any) {
      setMessage(err.message);
      setMessageTone("error");
    }
    setSaving(false);
  };

  // v1.9.4: AI 系统配置（管理员维护，所有用户可选用）
  const [aiProviders, setAiProviders] = useState<Array<{ id: number; name: string; providerType: string; baseUrl: string; apiKey: string; models: string[] | null; isActive: boolean }>>([]);
  const [aiEditor, setAiEditor] = useState<{ open: boolean; id?: number; name: string; providerType: string; baseUrl: string; apiKey: string; models: string }>({ open: false, name: "", providerType: "openai", baseUrl: "", apiKey: "", models: "" });
  const [aiMsg, setAiMsg] = useState<string | null>(null);
  const [aiMsgTone, setAiMsgTone] = useState<"success" | "error">("error");
  // v1.9.6+: 开发者工具段（演示数据导入/清除，即时执行，不参与底部"保存全局设置"）
  const [devBusy, setDevBusy] = useState(false);
  const [devMsg, setDevMsg] = useState<string | null>(null);
  const [devMsgTone, setDevMsgTone] = useState<"success" | "error">("error");

  async function handleImportDemo() {
    if (!confirm("将导入演示测试数据（9 场考试、16 名学生、2 个合集，含网阅演示），不会覆盖现有数据。继续？")) return;
    setDevMsg(null);
    setDevBusy(true);
    try {
      const result = await fetchJson<{ ok: boolean; message?: string }>("/api/db/import-demo", { method: "POST" });
      setDevMsg(result.message || "演示数据导入完成");
      setDevMsgTone("success");
    } catch (err: any) {
      setDevMsg(err?.message || "演示数据导入失败");
      setDevMsgTone("error");
    } finally {
      setDevBusy(false);
    }
  }

  async function handleClearDemo() {
    if (!confirm("将清除全部「演示-」前缀的演示数据（不影响真实数据）。继续？")) return;
    setDevMsg(null);
    setDevBusy(true);
    try {
      const result = await fetchJson<{ ok: boolean; message?: string }>("/api/db/clear-demo", { method: "POST" });
      setDevMsg(result.message || "演示数据已清除");
      setDevMsgTone("success");
    } catch (err: any) {
      setDevMsg(err?.message || "演示数据清除失败");
      setDevMsgTone("error");
    } finally {
      setDevBusy(false);
    }
  }

  const loadAi = useCallback(async () => {
    try {
      const res = await fetchJson<Array<{ id: number; name: string; providerType: string; baseUrl: string; apiKey: string; models: string[] | null; isActive: boolean }>>("/api/ai/providers/system");
      if (Array.isArray(res)) setAiProviders(res);
    } catch { /* silent */ }
  }, []);

  useEffect(() => { loadAi(); }, [loadAi]);

  const openAiEditor = (p?: any) =>
    setAiEditor({
      open: true,
      id: p?.id,
      name: p?.name ?? "",
      providerType: p?.providerType ?? "openai",
      baseUrl: p?.baseUrl ?? "",
      apiKey: p?.apiKey && !String(p.apiKey).includes("•") ? p.apiKey : "",
      models: p?.models ? JSON.stringify(p.models) : "",
    });

  const saveAi = async () => {
    setAiMsg(null);
    try {
      const body: any = {
        name: aiEditor.name,
        providerType: aiEditor.providerType,
        baseUrl: aiEditor.baseUrl,
        apiKey: aiEditor.apiKey,
        models: aiEditor.models ? JSON.parse(aiEditor.models) : null,
      };
      const url = aiEditor.id ? `/api/ai/providers/system/${aiEditor.id}` : "/api/ai/providers/system";
      const method = aiEditor.id ? "PUT" : "POST";
      await fetchJson(url, { method, body: JSON.stringify(body) });
      setAiEditor({ open: false, name: "", providerType: "openai", baseUrl: "", apiKey: "", models: "" });
      setAiMsg("已保存 AI 系统服务商");
      setAiMsgTone("success");
      loadAi();
    } catch (e: any) {
      setAiMsg(e?.message || "保存失败");
      setAiMsgTone("error");
    }
  };

  const deleteAi = async (id: number) => {
    if (!confirm("确认删除该 AI 系统服务商？")) return;
    try {
      await fetchJson(`/api/ai/providers/system/${id}`, { method: "DELETE" });
      loadAi();
    } catch (e: any) {
      setAiMsg(e?.message || "删除失败");
      setAiMsgTone("error");
    }
  };

  if (loading) return <div>加载中...</div>;

  return (
    <Card className="flex flex-col gap-5 p-6">
      <div>
        <div className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
          <span className="font-semibold text-foreground">系统级配置</span>
          <span className="rounded-sm bg-secondary px-2 py-0.5 text-xs">仅管理员</span>
        </div>
        <p className="text-xs text-muted-foreground">
          以下为系统级策略，对所有考试与教师统一生效。网阅相关默认（0.5、分差阈值、取整、自动重分配、均衡阈值）请在各考试「网阅设置」中配置。
        </p>
      </div>

      <ControlRow
        reverse
        control={<Switch checked={railAutoExpand} onCheckedChange={toggleRailAutoExpand} />}
        label="侧边栏自动展开"
        description="收起后鼠标移到侧边栏时自动展开；关闭后仍可点击圆形按钮展开并正常导航。"
      />

      <div className="flex flex-col gap-3 rounded-lg border border-border-subtle bg-secondary p-4">
        {FIELDS.map((f) => (
          <ControlRow
            key={f.key}
            reverse
            control={
              f.type === "toggle" ? (
                <Switch checked={draft[f.key] === "1"} onCheckedChange={(c) => setField(f.key, c ? "1" : "0")} />
              ) : f.type === "number" ? (
                <Input
                  type="number"
                  value={draft[f.key] ?? ""}
                  onChange={(e) => setField(f.key, e.target.value)}
                  className="w-20 text-center"
                />
              ) : (
                <Select value={draft[f.key] ?? ""} onValueChange={(v) => setField(f.key, v)}>
                  <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {f.options!.map((o) => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )
            }
            label={f.label}
            description={f.desc}
          />
        ))}
      </div>

      {/* v1.9.4: AI 系统配置段 */}
      <div className="flex flex-col gap-3 border-t border-border-subtle pt-5">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-foreground">AI 系统配置</div>
          <Button variant="primary" size="sm" onClick={() => openAiEditor()}>＋ 新增系统服务商</Button>
        </div>
        <p className="text-xs text-muted-foreground">
          由管理员统一维护的系统级 AI 服务商，所有教师均可在分析/原卷中选用。
        </p>

        <div className="flex flex-col gap-2">
          {aiProviders.length === 0 && (
            <p className="text-xs text-muted-foreground">尚未配置系统级 AI 服务商。</p>
          )}
          {aiProviders.map((p) => (
            <div key={p.id} className="flex items-center justify-between gap-3 rounded-md border border-border-subtle bg-secondary px-3.5 py-2.5">
              <div className="min-w-0">
                <div className="text-sm font-medium text-foreground">
                  {p.name} <span className="text-xs text-muted-foreground">（{p.providerType}{p.isActive ? "" : " · 已停用"}）</span>
                </div>
                <div className="text-xs text-muted-foreground">
                  {p.baseUrl || "—"}{p.models && p.models.length ? ` · ${p.models.length} 模型` : ""}
                </div>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button variant="ghost" size="sm" onClick={() => openAiEditor(p)}>编辑</Button>
                <Button variant="ghost" size="sm" onClick={() => void deleteAi(p.id)} className="text-destructive-fg">删除</Button>
              </div>
            </div>
          ))}
        </div>

        {aiEditor.open && (
          <div className="flex flex-col gap-3 rounded-md border border-border-subtle bg-secondary p-3.5">
            <div className="font-medium text-foreground">{aiEditor.id ? "编辑系统服务商" : "新增系统服务商"}</div>
            <Field label="名称">
              <Input value={aiEditor.name} onChange={(e) => setAiEditor({ ...aiEditor, name: e.target.value })} />
            </Field>
            <Field label="类型">
              <Select value={aiEditor.providerType} onValueChange={(v) => setAiEditor({ ...aiEditor, providerType: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai">OpenAI 兼容</SelectItem>
                  <SelectItem value="deepseek">DeepSeek</SelectItem>
                  <SelectItem value="gemini">Gemini</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label={<>Base URL{aiEditor.providerType === "gemini" ? "（Gemini 留空）" : ""}</>}>
              <Input value={aiEditor.baseUrl} onChange={(e) => setAiEditor({ ...aiEditor, baseUrl: e.target.value })} />
            </Field>
            <Field label={<>API Key{aiEditor.id ? "（留空则不修改）" : ""}</>}>
              <Input type="password" value={aiEditor.apiKey} onChange={(e) => setAiEditor({ ...aiEditor, apiKey: e.target.value })} />
            </Field>
            <Field label='模型（JSON 数组，如 ["gpt-4o"]）'>
              <Input value={aiEditor.models} onChange={(e) => setAiEditor({ ...aiEditor, models: e.target.value })} />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setAiEditor({ open: false, name: "", providerType: "openai", baseUrl: "", apiKey: "", models: "" })}>取消</Button>
              <Button variant="primary" onClick={() => void saveAi()}>保存</Button>
            </div>
          </div>
        )}

        {aiMsg && (
          <Banner tone={aiMsgTone}>{aiMsg}</Banner>
        )}
      </div>

      {/* v1.9.6+: 开发者工具（演示数据导入/清除）。即时执行，不参与底部保存。 */}
      <div className="flex flex-col gap-3 border-t border-border-subtle pt-5">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Terminal size={15} className="shrink-0" />
          开发者工具
        </div>
        <p className="text-xs text-muted-foreground">
          用于演示与调研场景的快速数据操作。即时执行，<strong className="font-semibold text-foreground">不会保存到全局设置中</strong>，也不影响已有的真实考试数据。
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            size="sm"
            icon={<FlaskConical />}
            loading={devBusy}
            onClick={() => void handleImportDemo()}
          >
            导入演示数据
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon={<Trash2 />}
            disabled={devBusy}
            onClick={() => void handleClearDemo()}
            className="text-destructive-fg"
          >
            清除演示数据
          </Button>
        </div>
        {devMsg && <Banner tone={devMsgTone}>{devMsg}</Banner>}
      </div>

      {/* 难度/区分度档位设置 */}
      <div className="flex flex-col gap-3 border-t border-border-subtle pt-5">
        <div className="text-sm font-semibold text-foreground">难度 / 区分度档位</div>
        <p className="text-xs text-muted-foreground">
          设置成绩分析中难度系数 P 与区分度 D 的着色档位。各档按「上限阈值」升序判定，数值 ≤ 阈值即归入该档。未配置时使用内置默认。
        </p>
        <div className="flex flex-col gap-6">
          <BandEditor title="难度系数 P 档位" desc="P = 平均得分 / 满分（0–1）。" bands={diffBands} onChange={setDiffBands} />
          <BandEditor title="区分度 D 档位" desc="D = 高分组得分率 − 低分组得分率（0–1）。" bands={discBands} onChange={setDiscBands} />
        </div>
      </div>

      {message && (
        <Banner tone={messageTone}>{message}</Banner>
      )}

      <Button variant="primary" size="lg" block onClick={handleSave} disabled={saving}>
        {saving ? "保存中..." : "保存全局设置"}
      </Button>
    </Card>
  );
}

function Banner({ tone, children }: { tone: "success" | "error"; children: ReactNode }) {
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm",
        tone === "success"
          ? "border-border bg-secondary text-foreground"
          : "border-destructive-border bg-secondary text-destructive-fg"
      )}
    >
      {tone === "success" ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
      {children}
    </div>
  );
}

function BandEditor({ title, desc, bands, onChange }: { title: string; desc: string; bands: Band[]; onChange: (b: Band[]) => void }) {
  function update(i: number, patch: Partial<Band>) {
    onChange(bands.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));
  }
  function remove(i: number) {
    onChange(bands.filter((_, idx) => idx !== i));
  }
  function add() {
    onChange([...bands, { max: 1, label: "新档位", color: "var(--px-success-bg)" }]);
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="text-sm font-medium text-foreground">{title}</div>
      <p className="mb-1 mt-1 text-xs text-muted-foreground">{desc}</p>
      <div className="flex flex-col gap-2">
        {bands.map((b, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <Input
              type="number"
              step="0.05"
              min={0}
              max={1}
              value={b.max}
              onChange={(e) => update(i, { max: Number(e.target.value) })}
              className="w-20 text-center"
              title="上限阈值(0-1)：数值 ≤ 该阈值归入此档"
            />
            <Input
              value={b.label}
              onChange={(e) => update(i, { label: e.target.value })}
              className="w-28"
              placeholder="档位名"
            />
            <input
              type="color"
              value={toColorInput(b.color)}
              onChange={(e) => update(i, { color: e.target.value })}
              className="h-9 w-10 cursor-pointer rounded-md border border-input bg-card p-0.5"
              title="徽章颜色"
            />
            <span className="text-xs text-muted-foreground">≤ {b.max} 显示「{b.label}」</span>
            <Button variant="ghost" size="sm" onClick={() => remove(i)} className="text-destructive-fg">删除</Button>
          </div>
        ))}
      </div>
      <Button variant="outline" size="sm" onClick={add} className="self-start">+ 添加档位</Button>
    </div>
  );
}

/** var(--px-xxx) 语义色 → color input 可用的 hex。
 *  运行时读 computed value（皮肤感知：paper-edge 下 success=亮蓝、warning=墨，而非 flat 基准旧色）；
 *  读不到时回退 tokens（明澈基准）。 */
function toColorInput(value: string): string {
  if (/^#[0-9a-f]{6}$/i.test(value)) return value;
  const m = /^var\((--[^)]+)\)$/.exec(value);
  const raw = m ? getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim() : "";
  const rgb = raw.match(/\d+(?:\.\d+)?/g)?.slice(0, 3).map(Number);
  if (rgb && rgb.length === 3 && rgb.every((n) => n >= 0 && n <= 255)) {
    return `#${rgb.map((n) => Math.round(n).toString(16).padStart(2, "0")).join("")}`;
  }
  return tokens.danger;
}
