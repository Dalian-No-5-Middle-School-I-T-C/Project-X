import React, { useState, useEffect, useCallback } from "react";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { fetchJson } from "../auth/api";

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
  const [railAutoExpand, setRailAutoExpand] = useState(true);

  useEffect(() => {
    try { setRailAutoExpand(localStorage.getItem("projectx-rail-auto-expand") !== "false"); } catch { /* ignore */ }
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

  if (loading) return <div style={{ padding: 24 }}>加载中...</div>;

  return (
    <div className="global-settings-page min-h-full w-full p-6">
      <div className="global-settings-card">
      <div className="mb-5 flex items-center gap-2 text-sm text-muted-foreground"><span className="font-semibold text-foreground">系统级配置</span><span className="rounded-sm bg-secondary px-2 py-0.5 text-xs">仅管理员</span></div>
      <div style={{ fontSize: 13, color: "var(--color-text-secondary)", marginBottom: 20 }}>
        以下为系统级策略，对所有考试与教师统一生效。网阅相关默认（0.5、分差阈值、取整、自动重分配、均衡阈值）请在各考试「网阅设置」中配置。
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, padding: "14px 16px", marginBottom: 12, background: "var(--color-background-secondary)", border: "1px solid var(--color-border-tertiary)", borderRadius: 10 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 500 }}>侧边栏自动展开</div>
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 2 }}>收起后鼠标移到侧边栏时自动展开；关闭后仍可点击圆形按钮展开并正常导航。</div>
        </div>
        <button type="button" role="switch" aria-checked={railAutoExpand} onClick={toggleRailAutoExpand} className={`settings-switch ${railAutoExpand ? "on" : ""}`}>
          <span />
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {FIELDS.map((f) => (
          <div key={f.key} style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "14px 16px",
            background: "var(--color-background-secondary)",
            borderRadius: 10,
            border: "0.5px solid var(--color-border-tertiary)",
            gap: 16,
          }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 500 }}>{f.label}</div>
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 2 }}>{f.desc}</div>
            </div>
            <div style={{ flexShrink: 0 }}>
              {f.type === "toggle" && (
                <button
                  onClick={() => setField(f.key, draft[f.key] === "1" ? "0" : "1")}
                  style={{
                    ...toggleStyle,
                    background: draft[f.key] === "1" ? "var(--px-accent-bg)" : "var(--px-border-strong)",
                  }}
                >
                  <span style={{
                    ...toggleKnob,
                    transform: draft[f.key] === "1" ? "translateX(18px)" : "translateX(0)",
                  }} />
                </button>
              )}
              {f.type === "number" && (
                <input
                  type="number"
                  value={draft[f.key] ?? ""}
                  onChange={(e) => setField(f.key, e.target.value)}
                  style={inputStyle}
                />
              )}
              {f.type === "select" && (
                <select value={draft[f.key] ?? ""} onChange={(e) => setField(f.key, e.target.value)} style={selectStyle}>
                  {f.options!.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* v1.9.4: AI 系统配置段 */}
      <div style={{ marginTop: 28, paddingTop: 20, borderTop: "1px solid var(--color-border-tertiary)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          <div style={{ fontSize: 15, fontWeight: 500 }}>AI 系统配置</div>
          <button onClick={() => openAiEditor()} style={{ ...smallBtnStyle, background: "var(--px-accent-bg)", color: "var(--px-fg-on-accent)" }}>＋ 新增系统服务商</button>
        </div>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 12 }}>
          由管理员统一维护的系统级 AI 服务商，所有教师均可在分析/原卷中选用。
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {aiProviders.length === 0 && (
            <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>尚未配置系统级 AI 服务商。</div>
          )}
          {aiProviders.map((p) => (
            <div key={p.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", background: "var(--color-background-secondary)", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)" }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 500 }}>{p.name} <span style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>（{p.providerType}{p.isActive ? "" : " · 已停用"}）</span></div>
                <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>{p.baseUrl || "—"}{p.models && p.models.length ? ` · ${p.models.length} 模型` : ""}</div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => openAiEditor(p)} style={smallBtnStyle}>编辑</button>
                <button onClick={() => void deleteAi(p.id)} style={{ ...smallBtnStyle, color: "var(--px-danger-fg)" }}>删除</button>
              </div>
            </div>
          ))}
        </div>

        {aiEditor.open && (
          <div style={{ marginTop: 12, padding: 14, background: "var(--color-background-secondary)", borderRadius: 10, border: "0.5px solid var(--color-border-tertiary)" }}>
            <div style={{ fontWeight: 500, marginBottom: 10 }}>{aiEditor.id ? "编辑系统服务商" : "新增系统服务商"}</div>
            <label style={{ display: "block", fontSize: 13, marginBottom: 8 }}>名称
              <input value={aiEditor.name} onChange={(e) => setAiEditor({ ...aiEditor, name: e.target.value })} style={selectStyle} />
            </label>
            <label style={{ display: "block", fontSize: 13, marginBottom: 8 }}>类型
              <select value={aiEditor.providerType} onChange={(e) => setAiEditor({ ...aiEditor, providerType: e.target.value })} style={selectStyle}>
                <option value="openai">OpenAI 兼容</option>
                <option value="deepseek">DeepSeek</option>
                <option value="gemini">Gemini</option>
              </select>
            </label>
            <label style={{ display: "block", fontSize: 13, marginBottom: 8 }}>Base URL{aiEditor.providerType === "gemini" ? "（Gemini 留空）" : ""}
              <input value={aiEditor.baseUrl} onChange={(e) => setAiEditor({ ...aiEditor, baseUrl: e.target.value })} style={selectStyle} />
            </label>
            <label style={{ display: "block", fontSize: 13, marginBottom: 8 }}>API Key{aiEditor.id ? "（留空则不修改）" : ""}
              <input type="password" value={aiEditor.apiKey} onChange={(e) => setAiEditor({ ...aiEditor, apiKey: e.target.value })} style={selectStyle} />
            </label>
            <label style={{ display: "block", fontSize: 13, marginBottom: 12 }}>模型（JSON 数组，如 ["gpt-4o"]）
              <input value={aiEditor.models} onChange={(e) => setAiEditor({ ...aiEditor, models: e.target.value })} style={selectStyle} />
            </label>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setAiEditor({ open: false, name: "", providerType: "openai", baseUrl: "", apiKey: "", models: "" })} style={smallBtnStyle}>取消</button>
              <button onClick={() => void saveAi()} style={{ ...smallBtnStyle, background: "var(--px-accent-bg)", color: "var(--px-fg-on-accent)" }}>保存</button>
            </div>
          </div>
        )}

        {aiMsg && (
          <div style={{ fontSize: 13, color: aiMsgTone === "success" ? "var(--px-success-fg)" : "var(--px-danger-fg)", margin: "12px 0", display: "flex", alignItems: "center", gap: 6 }}>{aiMsgTone === "success" ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}{aiMsg}</div>
        )}
      </div>

      {/* 难度/区分度档位设置 */}
      <div style={{ marginTop: 28, paddingTop: 20, borderTop: "1px solid var(--color-border-tertiary)" }}>
        <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 6 }}>难度 / 区分度档位</div>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 16 }}>
          设置成绩分析中难度系数 P 与区分度 D 的着色档位。各档按「上限阈值」升序判定，数值 ≤ 阈值即归入该档。未配置时使用内置默认。
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <BandEditor title="难度系数 P 档位" desc="P = 平均得分 / 满分（0–1）。" bands={diffBands} onChange={setDiffBands} />
          <BandEditor title="区分度 D 档位" desc="D = 高分组得分率 − 低分组得分率（0–1）。" bands={discBands} onChange={setDiscBands} />
        </div>
      </div>

      {message && (
        <div style={{
          fontSize: 13,
           color: messageTone === "success" ? "var(--px-success-fg)" : "var(--px-danger-fg)",
          margin: "16px 0",
          padding: "8px 12px",
           background: messageTone === "success" ? "var(--px-success-soft)" : "var(--px-danger-soft)",
          borderRadius: 8,
        }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>{messageTone === "success" ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}{message}</span>
        </div>
      )}

      <button
        onClick={handleSave}
        disabled={saving}
        style={{
          marginTop: 8,
          width: "100%",
          minHeight: 52,
          fontSize: 16,
          fontWeight: 500,
          borderRadius: 12,
          border: "none",
           background: "var(--px-accent-bg)",
           color: "var(--px-fg-on-accent)",
          cursor: saving ? "default" : "pointer",
          opacity: saving ? 0.7 : 1,
        }}
      >
        {saving ? "保存中..." : "保存全局设置"}
      </button>
      </div>
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
    <div>
      <div style={{ fontSize: 14, fontWeight: 500 }}>{title}</div>
      <div style={{ fontSize: 12, color: "var(--color-text-secondary)", margin: "4px 0 10px" }}>{desc}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {bands.map((b, i) => (
          <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input
              type="number" step="0.05" min="0" max="1"
              value={b.max}
              onChange={(e) => update(i, { max: Number(e.target.value) })}
              style={{ ...selectStyle, width: 84 }}
              title="上限阈值(0-1)：数值 ≤ 该阈值归入此档"
            />
            <input
              value={b.label}
              onChange={(e) => update(i, { label: e.target.value })}
              style={{ ...selectStyle, width: 120 }}
              placeholder="档位名"
            />
            <input
              type="color"
              value={toColorInput(b.color)}
              onChange={(e) => update(i, { color: e.target.value })}
              style={{ width: 36, height: 32, border: "none", background: "none", cursor: "pointer", padding: 0 }}
              title="徽章颜色"
            />
            <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>≤ {b.max} 显示「{b.label}」</span>
            <button onClick={() => remove(i)} style={{ ...smallBtnStyle, color: "var(--px-danger-fg)" }}>删除</button>
          </div>
        ))}
      </div>
      <button onClick={add} style={{ ...smallBtnStyle, marginTop: 8 }}>+ 添加档位</button>
    </div>
  );
}

function toColorInput(value: string): string {
  const semanticColors: Record<string, string> = {
    "var(--px-danger-bg)": "#C00F28",
    "var(--px-warning-bg)": "#D97706",
    "var(--px-amber-700)": "#B45309",
    "var(--px-success-bg)": "#16A34A",
  };
  return semanticColors[value] ?? (/^#[0-9a-f]{6}$/i.test(value) ? value : "#C00F28");
}

const smallBtnStyle: React.CSSProperties = {
  padding: "6px 14px",
  fontSize: 13,
  borderRadius: 6,
  border: "1px solid var(--px-border-default)",
  background: "var(--px-bg-surface)",
  cursor: "pointer",
};

const toggleStyle: React.CSSProperties = {
  width: 44,
  height: 26,
  borderRadius: 13,
  border: "none",
  position: "relative",
  cursor: "pointer",
  transition: "background 0.15s",
  padding: 0,
};

const toggleKnob: React.CSSProperties = {
  position: "absolute",
  top: 3,
  left: 3,
  width: 20,
  height: 20,
  borderRadius: "50%",
  background: "#fff",
  transition: "transform 0.15s",
};

const inputStyle: React.CSSProperties = {
  width: 80,
  padding: "8px",
  border: "1px solid var(--color-border-primary)",
  borderRadius: 6,
  fontSize: 14,
  textAlign: "center",
  background: "var(--color-background-primary)",
};

const selectStyle: React.CSSProperties = {
  padding: "8px 10px",
  border: "1px solid var(--color-border-primary)",
  borderRadius: 6,
  fontSize: 14,
  background: "var(--color-background-primary)",
};
