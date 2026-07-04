/**
 * Knowledge Point Editor — upload original paper, AI analyze, tag questions.
 * Can be embedded in card designer (design mode) or analysis page.
 */
import { useEffect, useState } from "react";
import { FileUp, Brain, Plus, Trash2, Save, RefreshCw, X, Download, Eye } from "lucide-react";
import { fetchJson } from "../auth/api";

interface KnowledgePoint {
  id?: number;
  card_id?: string;
  question_number: number;
  category: string;
  point_text: string;
}

interface Props {
  cardId: string;
  onSaved?: () => void;
}

export function KnowledgePointEditor({ cardId, onSaved }: Props) {
  const [points, setPoints] = useState<KnowledgePoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [hasPaper, setHasPaper] = useState(false);
  const [paperFilename, setPaperFilename] = useState("");
  const [aiResult, setAiResult] = useState<KnowledgePoint[] | null>(null);

  // New point form
  const [newQn, setNewQn] = useState("");
  const [newCat, setNewCat] = useState("");
  const [newPt, setNewPt] = useState("");

  async function load() {
    setLoading(true);
    try {
      const rows = await fetchJson<any[]>(`/api/cards/${cardId}/knowledge-points`);
      setPoints(rows.map((r) => ({ question_number: r.question_number, category: r.category || "", point_text: r.point_text, id: r.id })));
      // Check if paper exists
      const card = await fetchJson<any>(`/api/cards/${cardId}`);
      setHasPaper(card.has_original_paper === 1);
      setPaperFilename(card.original_paper_filename || "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [cardId]);

  async function handleUpload(file: File) {
    setError("");
    const form = new FormData();
    form.append("file", file);
    try {
      const token = localStorage.getItem("px_token") || "";
      const res = await fetch(`/api/cards/${cardId}/original-paper`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: form,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setHasPaper(true);
      setPaperFilename(file.name);
      setMsg("原卷上传成功");
    } catch (e) {
      setError(e instanceof Error ? e.message : "上传失败");
    }
  }

  async function handleAiAnalyze() {
    setAnalyzing(true);
    setError("");
    try {
      const result = await fetchJson<KnowledgePoint[]>(`/api/cards/${cardId}/ai-analyze-questions`, { method: "POST" });
      setAiResult(result);
      setMsg(`AI 分析完成，识别到 ${result.length} 个知识点。请审核后保存。`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "AI 分析失败");
    } finally {
      setAnalyzing(false);
    }
  }

  function acceptAiResults() {
    if (!aiResult) return;
    setPoints(aiResult);
    setAiResult(null);
  }

  function addPoint() {
    const qn = Number(newQn);
    if (!qn || !newPt.trim()) return;
    setPoints([...points, { question_number: qn, category: newCat.trim(), point_text: newPt.trim() }]);
    setNewQn(""); setNewCat(""); setNewPt("");
  }

  function removePoint(idx: number) {
    setPoints(points.filter((_, i) => i !== idx));
  }

  function updatePoint(idx: number, field: keyof KnowledgePoint, value: string) {
    const updated = [...points];
    (updated[idx] as any)[field] = value;
    setPoints(updated);
  }

  async function handleSave() {
    setSaving(true);
    setError("");
    try {
      await fetchJson(`/api/cards/${cardId}/knowledge-points`, {
        method: "PUT",
        body: JSON.stringify({ points }),
      });
      setMsg("知识点已保存");
      onSaved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  const sorted = [...points].sort((a, b) => a.question_number - b.question_number);

  return (
    <div className="knowledge-editor" style={{ padding: 16 }}>
      <div className="panel-title" style={{ marginBottom: 12 }}>
        <Brain size={18} /> 知识点标注
      </div>

      {msg && <div className="login-success" style={{ marginBottom: 8, fontSize: 13 }}>{msg}</div>}
      {error && <div className="login-error" style={{ marginBottom: 8, fontSize: 13 }}>{error}</div>}

      {/* Upload + AI bar */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <label className="ghost-button" style={{ cursor: "pointer", fontSize: 13 }}>
          <FileUp size={14} /> 上传原卷
          <input type="file" accept=".pdf,.png,.jpg,.jpeg" style={{ display: "none" }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUpload(f); }} />
        </label>
        {hasPaper && (
          <>
            <button className="ghost-button" onClick={handleAiAnalyze} disabled={analyzing} style={{ fontSize: 13 }}>
              <Brain size={14} /> {analyzing ? "分析中..." : "AI 分析题目"}
            </button>
            <a className="ghost-button" href={`/api/cards/${cardId}/original-paper/view`} target="_blank" rel="noreferrer" style={{ fontSize: 13, textDecoration: "none" }}>
              <Eye size={14} /> 查看原卷
            </a>
          </>
        )}
        {paperFilename && <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{paperFilename}</span>}
      </div>

      {/* AI results review */}
      {aiResult && (
        <div className="ai-review-banner" style={{ background: "var(--brand-tint)", padding: 12, borderRadius: 8, marginBottom: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>AI 分析结果 — 请审核</div>
          <div style={{ maxHeight: 200, overflowY: "auto", fontSize: 12 }}>
            {aiResult.map((p, i) => (
              <div key={i} style={{ padding: "2px 0" }}>
                <strong>第{p.question_number}题</strong>: {p.category || "—"} → {p.point_text}
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button className="primary-button" onClick={acceptAiResults} style={{ fontSize: 12 }}>✓ 全部采纳</button>
            <button className="ghost-button" onClick={() => setAiResult(null)} style={{ fontSize: 12 }}>✗ 忽略</button>
          </div>
        </div>
      )}

      {/* Manual add */}
      <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <input placeholder="题号" value={newQn} onChange={(e) => setNewQn(e.target.value)} style={{ width: 60, padding: "4px 8px", borderRadius: 4, border: "1px solid var(--line-strong)", fontSize: 13 }} />
        <input placeholder="章节" value={newCat} onChange={(e) => setNewCat(e.target.value)} style={{ width: 120, padding: "4px 8px", borderRadius: 4, border: "1px solid var(--line-strong)", fontSize: 13 }} />
        <input placeholder="知识点" value={newPt} onChange={(e) => setNewPt(e.target.value)} style={{ width: 180, padding: "4px 8px", borderRadius: 4, border: "1px solid var(--line-strong)", fontSize: 13 }} />
        <button className="ghost-button" onClick={addPoint} style={{ fontSize: 13 }}><Plus size={14} /> 添加</button>
      </div>

      {/* Points table */}
      {loading ? (
        <div className="empty-text" style={{ padding: 20, textAlign: "center" }}>加载中...</div>
      ) : sorted.length === 0 ? (
        <div className="empty-text" style={{ padding: 20, textAlign: "center" }}>暂无知识点标注。上传原卷后使用 AI 分析，或手动添加。</div>
      ) : (
        <>
          <div className="exam-list-table" style={{ borderRadius: 8, overflow: "hidden", marginBottom: 12 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: "var(--surface-soft)", textAlign: "left" }}>
                  <th style={{ padding: "6px 10px", width: 50 }}>题号</th>
                  <th style={{ padding: "6px 10px", width: 140 }}>章节</th>
                  <th style={{ padding: "6px 10px" }}>知识点</th>
                  <th style={{ padding: "6px 10px", width: 40 }}></th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((p, i) => (
                  <tr key={i} style={{ borderTop: "1px solid var(--line)" }}>
                    <td style={{ padding: "4px 10px", fontWeight: 600 }}>{p.question_number}</td>
                    <td style={{ padding: "4px 10px" }}>
                      <input value={p.category} onChange={(e) => updatePoint(i, "category", e.target.value)}
                        style={{ width: "100%", padding: "2px 6px", border: "1px solid var(--line)", borderRadius: 3, fontSize: 12, background: "transparent", color: "var(--text)" }} />
                    </td>
                    <td style={{ padding: "4px 10px" }}>
                      <input value={p.point_text} onChange={(e) => updatePoint(i, "point_text", e.target.value)}
                        style={{ width: "100%", padding: "2px 6px", border: "1px solid var(--line)", borderRadius: 3, fontSize: 12, background: "transparent", color: "var(--text)" }} />
                    </td>
                    <td style={{ padding: "4px 10px" }}>
                      <button className="ghost-button" onClick={() => removePoint(i)} style={{ fontSize: 12, color: "#E24B4A" }}><Trash2 size={12} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button className="primary-button" onClick={handleSave} disabled={saving} style={{ fontSize: 13 }}>
            <Save size={14} /> {saving ? "保存中..." : "保存知识点"}
          </button>
        </>
      )}
    </div>
  );
}
