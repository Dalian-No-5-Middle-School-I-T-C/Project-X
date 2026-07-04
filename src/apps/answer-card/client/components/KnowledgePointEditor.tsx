/**
 * Knowledge Point Editor — upload original paper, AI analyze, tag questions.
 * Uses existing paper-routes.ts APIs (v1.8.0 beta).
 */
import { useEffect, useState } from "react";
import { FileUp, Brain, Plus, Trash2, Save, Eye } from "lucide-react";
import { fetchJson } from "../auth/api";
import { getChaptersForSubject } from "./chapterPresets";

interface KnowledgePoint {
  question_number: number;
  category: string;
  point_text: string;
}

interface PaperInfo {
  has_original_paper: boolean;
  paper_filename?: string;
  question_range?: string;
  knowledge_points_text?: string;
}

interface Props {
  cardId: string;
  subjectLabel?: string;
  onSaved?: () => void;
}

export function KnowledgePointEditor({ cardId, subjectLabel, onSaved }: Props) {
  const [points, setPoints] = useState<KnowledgePoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [paperInfo, setPaperInfo] = useState<PaperInfo>({ has_original_paper: false });
  const [aiResult, setAiResult] = useState<KnowledgePoint[] | null>(null);

  const [newQn, setNewQn] = useState("");
  const [newCat, setNewCat] = useState("");
  const [newPt, setNewPt] = useState("");

  async function load() {
    setLoading(true);
    try {
      // Use existing API: GET /api/cards/:cardId/paper/info
      const info = await fetchJson<PaperInfo>(`/api/cards/${cardId}/paper/info`);
      setPaperInfo(info);

      // Use existing API: GET /api/cards/:cardId/knowledge-points
      const kpData = await fetchJson<{ points: KnowledgePoint[] }>(`/api/cards/${cardId}/knowledge-points`);
      setPoints(kpData.points || []);
    } catch {
      // Paper may not be uploaded yet — that's OK
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
      const res = await fetch(`/api/cards/${cardId}/paper`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: form,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setPaperInfo({ has_original_paper: true, paper_filename: file.name });
      setMsg("原卷上传成功");
    } catch (e) {
      setError(e instanceof Error ? e.message : "上传失败");
    }
  }

  async function handleAiAnalyze() {
    setAnalyzing(true);
    setError("");
    try {
      // Use existing API: POST /api/cards/:cardId/knowledge-points/analyze
      const result = await fetchJson<{ points: KnowledgePoint[] }>(
        `/api/cards/${cardId}/knowledge-points/analyze`, { method: "POST" }
      );
      setAiResult(result.points || []);
      setMsg(`AI 分析完成，识别到 ${result.points?.length || 0} 个知识点。请审核后保存。`);
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
      // Use existing API: PUT /api/cards/:cardId/knowledge-points
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

      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <label className="ghost-button" style={{ cursor: "pointer", fontSize: 13 }}>
          <FileUp size={14} /> 上传原卷
          <input type="file" accept=".pdf,.png,.jpg,.jpeg" style={{ display: "none" }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUpload(f); }} />
        </label>
        {paperInfo.has_original_paper && (
          <>
            <button className="ghost-button" onClick={handleAiAnalyze} disabled={analyzing} style={{ fontSize: 13 }}>
              <Brain size={14} /> {analyzing ? "分析中..." : "AI 分析题目"}
            </button>
            <a className="ghost-button" href={`/api/cards/${cardId}/paper`} target="_blank" rel="noreferrer" style={{ fontSize: 13, textDecoration: "none" }}>
              <Eye size={14} /> 查看原卷
            </a>
          </>
        )}
        {paperInfo.paper_filename && !paperInfo.has_original_paper && (
          <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{paperInfo.paper_filename}</span>
        )}
      </div>

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

      <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <input placeholder="题号" value={newQn} onChange={(e) => setNewQn(e.target.value)} style={{ width: 60, padding: "4px 8px", borderRadius: 4, border: "1px solid var(--line-strong)", fontSize: 13 }} />
        <input placeholder="章节" value={newCat} onChange={(e) => setNewCat(e.target.value)} list="kp-chapter-list"
          style={{ width: 140, padding: "4px 8px", borderRadius: 4, border: "1px solid var(--line-strong)", fontSize: 13 }} />
        <datalist id="kp-chapter-list">
          {getChaptersForSubject(subjectLabel || "").map((ch) => <option key={ch} value={ch} />)}
        </datalist>
        <input placeholder="知识点" value={newPt} onChange={(e) => setNewPt(e.target.value)} style={{ width: 180, padding: "4px 8px", borderRadius: 4, border: "1px solid var(--line-strong)", fontSize: 13 }} />
        <button className="ghost-button" onClick={addPoint} style={{ fontSize: 13 }}><Plus size={14} /> 添加</button>
      </div>

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
                {sorted.map((p, i) => {
                  const origIdx = points.indexOf(p);
                  return (
                    <tr key={i} style={{ borderTop: "1px solid var(--line)" }}>
                      <td style={{ padding: "4px 10px", fontWeight: 600 }}>{p.question_number}</td>
                      <td style={{ padding: "4px 10px" }}>
                        <input value={p.category} onChange={(e) => updatePoint(origIdx, "category", e.target.value)}
                          style={{ width: "100%", padding: "2px 6px", border: "1px solid var(--line)", borderRadius: 3, fontSize: 12, background: "transparent", color: "var(--text)" }} />
                      </td>
                      <td style={{ padding: "4px 10px" }}>
                        <input value={p.point_text} onChange={(e) => updatePoint(origIdx, "point_text", e.target.value)}
                          style={{ width: "100%", padding: "2px 6px", border: "1px solid var(--line)", borderRadius: 3, fontSize: 12, background: "transparent", color: "var(--text)" }} />
                      </td>
                      <td style={{ padding: "4px 10px" }}>
                        <button className="ghost-button" onClick={() => removePoint(origIdx)} style={{ fontSize: 12, color: "#E24B4A" }}><Trash2 size={12} /></button>
                      </td>
                    </tr>
                  );
                })}
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
