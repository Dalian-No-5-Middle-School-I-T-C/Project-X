import React, { useState, useEffect, useCallback } from "react";
import { fetchJson } from "../auth/api";

interface Props {
  onBack: () => void;
}

type Settings = {
  allow_half_point?: string;
  default_dispute_threshold?: string;
  default_rounding?: string;
  auto_reassign_policy?: string;
  workload_balance_threshold?: string;
};

const FIELDS: Array<{ key: keyof Settings; label: string; desc: string; type: "toggle" | "number" | "select"; options?: Array<{ value: string; label: string }> }> = [
  { key: "allow_half_point", label: "允许 0.5 小数评分", desc: "系统级总开关；教师仍可按题块关闭", type: "toggle" },
  { key: "default_dispute_threshold", label: "默认分差阈值", desc: "新考试默认评分分差阈值（分）", type: "number" },
  { key: "default_rounding", label: "默认取整方式", desc: "新考试默认合分取整", type: "select", options: [
    { value: "ceil", label: "向上取整" },
    { value: "floor", label: "向下取整" },
    { value: "round", label: "四舍五入" },
    { value: "half", label: "保留 0.5" },
    { value: "none", label: "保留小数" },
  ] },
  { key: "auto_reassign_policy", label: "无仲裁人自动重分配", desc: "争议/剩余卷自动派发给已分配教师", type: "toggle" },
  { key: "workload_balance_threshold", label: "工作量均衡阈值", desc: "未设仲裁人时，教师间份数差上限（份）", type: "number" },
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

  if (loading) return <div style={{ padding: 24 }}>加载中...</div>;

  return (
    <div style={{ padding: 24, maxWidth: 640 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
        <button onClick={onBack} style={backBtnStyle}>← 返回</button>
        <div style={{ fontSize: 15, fontWeight: 500 }}>全局设置（仅管理员）</div>
      </div>
      <div style={{ fontSize: 13, color: "var(--color-text-secondary)", marginBottom: 20 }}>
        以下设置为系统级默认值，对所有考试生效；题块级设置（如 0.5、仲裁人）仍由各考试网阅设置控制。
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
