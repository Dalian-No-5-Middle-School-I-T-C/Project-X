import { useEffect, useState } from "react";
import { Calculator, X } from "lucide-react";
import { fetchJson } from "../auth/api";
import type { AssignedFormula, AssignedFormulaType } from "../../../../shared/types";

interface Props {
  examId: number;
  examName: string;
  subject: string | null;
  onClose: () => void;
  onSaved: () => void;
}

interface FormulaPreset {
  id: string;
  name: string;
  formula: AssignedFormula;
}

const FORMULA_LABELS: Record<AssignedFormulaType, string> = {
  proportional: "等比例转换",
  linear: "线性公式",
  custom: "自定义表达式"
};

export function AssignedFormulaModal({ examId, examName, subject, onClose, onSaved }: Props) {
  const [loading, setLoading] = useState(true);
  const [formula, setFormula] = useState<AssignedFormula | null>(null);
  const [presets, setPresets] = useState<FormulaPreset[]>([]);
  const [isAssignedSubject, setIsAssignedSubject] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchJson<{
      formula: AssignedFormula | null;
      isAssignedSubject: boolean;
      presets: FormulaPreset[];
    }>(`/api/exams/${examId}/assigned-formula`)
      .then((data) => {
        setFormula(data.formula);
        setPresets(data.presets);
      })
      .catch(() => setMessage("加载赋分配置失败"))
      .finally(() => setLoading(false));
  }, [examId]);

  async function handleSave(recalculate: boolean) {
    setBusy(true);
    setMessage("");
    try {
      const result = await fetchJson<{ ok: boolean; updated?: number }>(
        `/api/exams/${examId}/assigned-formula`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ formula, recalculate })
        }
      );
      setMessage(recalculate ? `已保存并重算 ${result.updated ?? 0} 条成绩` : "已保存");
      onSaved();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  function applyPreset(preset: FormulaPreset) {
    setFormula(structuredClone(preset.formula));
  }

  function updateType(type: AssignedFormulaType) {
    if (!formula) return;
    setFormula({
      ...formula,
      type,
      params: type === "proportional" ? { minIn: 0, maxIn: 100, minOut: 30, maxOut: 100 }
        : type === "linear" ? { a: 0.7, b: 30 }
        : { expression: "raw * 0.7 + 30" }
    });
  }

  if (loading) {
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal-card" onClick={(e) => e.stopPropagation()}>
          <div style={{ padding: 24, textAlign: "center" }}>加载中...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520, width: "90vw" }}>
        <div className="modal-header">
          <h3 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>
            <Calculator size={18} style={{ verticalAlign: "middle", marginRight: 6 }} />
            赋分配置 — {examName}
          </h3>
          <button className="ghost-button" onClick={onClose}><X size={18} /></button>
        </div>

        <div className="modal-body" style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 14 }}>
          {/* Presets */}
          <div>
            <label style={{ fontSize: 13, fontWeight: 500, marginBottom: 6, display: "block" }}>公式预设</label>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {presets.map((p) => (
                <button
                  key={p.id}
                  className="ghost-button"
                  onClick={() => applyPreset(p)}
                  style={{
                    padding: "6px 12px",
                    fontSize: 12,
                    border: `1px solid ${formula?.type === p.formula.type ? "var(--brand)" : "var(--line)"}`,
                    borderRadius: 8,
                    background: formula?.type === p.formula.type ? "var(--surface-tint)" : "var(--surface)"
                  }}
                >
                  {p.name}
                </button>
              ))}
            </div>
          </div>

          {/* Enable toggle */}
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={formula?.enabled ?? false}
              onChange={(e) => setFormula(f => f ? { ...f, enabled: e.target.checked } : null)}
            />
            启用赋分
          </label>

          {formula?.enabled && (
            <>

              {/* Proportional params */}
              {formula.type === "proportional" && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <div>
                    <label style={{ fontSize: 12, color: "var(--muted)", display: "block" }}>原始最低</label>
                    <input type="number" value={formula.params.minIn ?? 0} onChange={(e) => setFormula({ ...formula, params: { ...formula.params, minIn: Number(e.target.value) } })} style={{ width: "100%", padding: "4px 8px", borderRadius: 4, border: "1px solid var(--line-strong)", fontSize: 13 }} />
                  </div>
                  <div>
                    <label style={{ fontSize: 12, color: "var(--muted)", display: "block" }}>原始最高</label>
                    <input type="number" value={formula.params.maxIn ?? 100} onChange={(e) => setFormula({ ...formula, params: { ...formula.params, maxIn: Number(e.target.value) } })} style={{ width: "100%", padding: "4px 8px", borderRadius: 4, border: "1px solid var(--line-strong)", fontSize: 13 }} />
                  </div>
                  <div>
                    <label style={{ fontSize: 12, color: "var(--muted)", display: "block" }}>转换最低</label>
                    <input type="number" value={formula.params.minOut ?? 30} onChange={(e) => setFormula({ ...formula, params: { ...formula.params, minOut: Number(e.target.value) } })} style={{ width: "100%", padding: "4px 8px", borderRadius: 4, border: "1px solid var(--line-strong)", fontSize: 13 }} />
                  </div>
                  <div>
                    <label style={{ fontSize: 12, color: "var(--muted)", display: "block" }}>转换最高</label>
                    <input type="number" value={formula.params.maxOut ?? 100} onChange={(e) => setFormula({ ...formula, params: { ...formula.params, maxOut: Number(e.target.value) } })} style={{ width: "100%", padding: "4px 8px", borderRadius: 4, border: "1px solid var(--line-strong)", fontSize: 13 }} />
                  </div>
                </div>
              )}

              {/* Linear params */}
              {formula.type === "linear" && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <div>
                    <label style={{ fontSize: 12, color: "var(--muted)", display: "block" }}>系数 a (乘数)</label>
                    <input type="number" step="0.1" value={formula.params.a ?? 0.7} onChange={(e) => setFormula({ ...formula, params: { ...formula.params, a: Number(e.target.value) } })} style={{ width: "100%", padding: "4px 8px", borderRadius: 4, border: "1px solid var(--line-strong)", fontSize: 13 }} />
                  </div>
                  <div>
                    <label style={{ fontSize: 12, color: "var(--muted)", display: "block" }}>常数 b (偏移量)</label>
                    <input type="number" step="1" value={formula.params.b ?? 30} onChange={(e) => setFormula({ ...formula, params: { ...formula.params, b: Number(e.target.value) } })} style={{ width: "100%", padding: "4px 8px", borderRadius: 4, border: "1px solid var(--line-strong)", fontSize: 13 }} />
                  </div>
                </div>
              )}

              {/* Custom expression */}
              {formula.type === "custom" && (
                <div>
                  <label style={{ fontSize: 12, color: "var(--muted)", display: "block", marginBottom: 2 }}>自定义表达式</label>
                  <input
                    type="text"
                    value={formula.params.expression ?? ""}
                    onChange={(e) => setFormula({ ...formula, params: { ...formula.params, expression: e.target.value } })}
                    placeholder="raw * 0.7 + 30"
                    style={{ width: "100%", padding: "6px 10px", borderRadius: 6, border: "1px solid var(--line-strong)", fontSize: 13, fontFamily: "monospace" }}
                  />
                  <span style={{ fontSize: 11, color: "var(--muted)", display: "block", marginTop: 2 }}>
                    可用变量: raw (原始分), max (最高分), min (最低分), avg (平均分), std (标准差)
                  </span>
                </div>
              )}
            </>
          )}
        </div>

        <div className="modal-footer" style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "12px 20px", borderTop: "1px solid var(--line)" }}>
          {message && <span style={{ flex: 1, fontSize: 13, color: message.includes("失败") ? "var(--brand)" : "var(--success)", alignSelf: "center" }}>{message}</span>}
          <button className="ghost-button" onClick={onClose}>取消</button>
          {formula?.enabled && (
            <button className="ghost-button" onClick={() => handleSave(true)} disabled={busy}>
              保存并重算全部
            </button>
          )}
          <button className="primary-button" onClick={() => handleSave(false)} disabled={busy}>
            {busy ? "保存中..." : "仅保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
