import React, { useState, useEffect, useCallback } from "react";
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

export function GlobalSettingsPage({ onBack }: Props) {
  const [settings, setSettings] = useState<Settings>({});
  const [draft, setDraft] = useState<Settings>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchJson<{ ok: boolean; data: Settings }>("/api/system-settings");
      if (res.ok) {
        setSettings(res.data ?? {});
        setDraft(res.data ?? {});
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
      const res = await fetchJson<{ ok: boolean; error?: string }>("/api/system-settings", {
        method: "PUT",
        body: JSON.stringify({ settings: draft }),
      });
      if (res.ok) {
        setSettings(draft);
        setMessage("✅ 已保存全局设置");
      } else {
        setMessage(`⚠ ${(res as any).error ?? "保存失败"}`);
      }
    } catch (err: any) {
      setMessage(`⚠ ${err.message}`);
    }
    setSaving(false);
  };

  // v1.9.4: AI 系统配置（管理员维护，所有用户可选用）
  const [aiProviders, setAiProviders] = useState<Array<{ id: number; name: string; providerType: string; baseUrl: string; apiKey: string; models: string[] | null; isActive: boolean }>>([]);
  const [aiEditor, setAiEditor] = useState<{ open: boolean; id?: number; name: string; providerType: string; baseUrl: string; apiKey: string; models: string }>({ open: false, name: "", providerType: "openai", baseUrl: "", apiKey: "", models: "" });
  const [aiMsg, setAiMsg] = useState<string | null>(null);

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
      setAiMsg("✅ 已保存 AI 系统服务商");
      loadAi();
    } catch (e: any) {
      setAiMsg(`⚠ ${e?.message || "保存失败"}`);
    }
  };

  const deleteAi = async (id: number) => {
    if (!confirm("确认删除该 AI 系统服务商？")) return;
    try {
      await fetchJson(`/api/ai/providers/system/${id}`, { method: "DELETE" });
      loadAi();
    } catch (e: any) {
      setAiMsg(`⚠ ${e?.message || "删除失败"}`);
    }
  };

  if (loading) return <div style={{ padding: 24 }}>加载中...</div>;

  return (
    <div style={{ padding: 24, maxWidth: 640 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
        <button onClick={onBack} style={backBtnStyle}>← 返回</button>
        <div style={{ fontSize: 15, fontWeight: 500 }}>全局设置（仅管理员）</div>
      </div>
      <div style={{ fontSize: 13, color: "var(--color-text-secondary)", marginBottom: 20 }}>
        以下为系统级策略，对所有考试与教师统一生效。网阅相关默认（0.5、分差阈值、取整、自动重分配、均衡阈值）请在各考试「网阅设置」中配置。
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
                    background: draft[f.key] === "1" ? "#3C3489" : "var(--color-border-primary)",
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
          <button onClick={() => openAiEditor()} style={{ ...smallBtnStyle, background: "#3C3489", color: "#fff" }}>＋ 新增系统服务商</button>
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
                <button onClick={() => void deleteAi(p.id)} style={{ ...smallBtnStyle, color: "#E24B4A" }}>删除</button>
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
              <button onClick={() => void saveAi()} style={{ ...smallBtnStyle, background: "#3C3489", color: "#fff" }}>保存</button>
            </div>
          </div>
        )}

        {aiMsg && (
          <div style={{ fontSize: 13, color: aiMsg.includes("✅") ? "var(--color-text-success, #22c55e)" : "#E24B4A", margin: "12px 0" }}>{aiMsg}</div>
        )}
      </div>

      {message && (
        <div style={{
          fontSize: 13,
          color: message.includes("✅") ? "var(--color-text-success, #22c55e)" : "#E24B4A",
          margin: "16px 0",
          padding: "8px 12px",
          background: message.includes("✅") ? "rgba(34,197,94,0.1)" : "rgba(226,75,74,0.1)",
          borderRadius: 8,
        }}>
          {message}
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
          background: "#3C3489",
          color: "#fff",
          cursor: saving ? "default" : "pointer",
          opacity: saving ? 0.7 : 1,
        }}
      >
        {saving ? "保存中..." : "保存全局设置"}
      </button>
    </div>
  );
}

const backBtnStyle: React.CSSProperties = {
  height: 44,
  padding: "0 18px",
  fontSize: 14,
  fontWeight: 500,
  border: "1px solid var(--color-border-primary)",
  borderRadius: 8,
  background: "var(--color-background-secondary)",
  cursor: "pointer",
};

const smallBtnStyle: React.CSSProperties = {
  padding: "6px 14px",
  fontSize: 13,
  borderRadius: 6,
  border: "0.5px solid var(--color-border-primary)",
  background: "var(--color-background-secondary)",
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
