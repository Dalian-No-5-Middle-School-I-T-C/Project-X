import { useEffect, useRef, useState } from "react";
import { Download, GripVertical, Plus, Save, Trash2, X } from "lucide-react";
import { fetchJson, authFetch } from "../auth/api";

interface Props {
  examId: number;
  examName: string;
  classId?: string;
  onClose: () => void;
}

interface ColumnMeta {
  id: string;
  label: string;
  category: string;
}

interface Template {
  id?: number;
  slot: number;
  name: string;
  columns: string[];
  side_table_n: number;
  gap_cols: number;
}

const A4_MAX_CHARS = 63;
const COL_WIDTHS: Record<string, number> = {
  studentNumber: 14, grade: 8, className: 8, studentName: 8,
  totalScore: 7, assignedScore: 7, objectiveScore: 7, subjectiveScore: 7,
  gradeRank: 5, classRank: 5, rankChange: 10, displayValue: 10,
  needsReview: 6, confidence: 7
};
const SIDE_COL_WIDTHS = [5, 8, 7]; // 年排, 班级, 分数

// Default: classRank(5)+name(8)+totalScore(7)+assignedScore(7)+gradeRank(5)+obj(7)+subj(7) = 46 + gap(3) + side(5+8+7=20) = 69 → slightly over. Let's tighten.
// Adjusted: classRank(5)+name(8)+totalScore(6)+assignedScore(6)+gradeRank(4)+obj(6)+subj(6)=41, +gap(3)+side(4+7+6=17)=61 ✓

const DEFAULT_COLUMNS = ["classRank", "studentName", "totalScore", "assignedScore", "gradeRank", "objectiveScore", "subjectiveScore"];

function computeTotalWidth(columns: string[], sideN: number, gap: number): number {
  const mainW = columns.reduce((sum, c) => sum + (COL_WIDTHS[c] ?? 8), 0);
  if (sideN > 0) {
    const sideW = SIDE_COL_WIDTHS.reduce((a, b) => a + b, 0);
    return mainW + gap + sideW;
  }
  return mainW;
}

export function ExportModal({ examId, examName, classId, onClose }: Props) {
  const [allColumns, setAllColumns] = useState<ColumnMeta[]>([]);
  const [selected, setSelected] = useState<string[]>(DEFAULT_COLUMNS);
  const [sideN, setSideN] = useState(10);
  const [gapCols, setGapCols] = useState(1);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templateNames, setTemplateNames] = useState<Record<number, string>>({});
  const [activeTemplate, setActiveTemplate] = useState<number | null>(null);
  const [previewRows, setPreviewRows] = useState<Record<string, unknown>[]>([]);
  const [exporting, setExporting] = useState(false);
  const [hasAssignedScore, setHasAssignedScore] = useState(false);
  const dragItem = useRef<number | null>(null);
  const dragOverItem = useRef<number | null>(null);

  // Hardcoded Chinese column definitions (no API needed)
  const COLUMN_DEFS: ColumnMeta[] = [
    { id: "studentNumber", label: "考号", category: "basic" },
    { id: "studentName", label: "姓名", category: "basic" },
    { id: "className", label: "班级", category: "basic" },
    { id: "totalScore", label: "成绩", category: "score" },
    { id: "assignedScore", label: "赋分", category: "score" },
    { id: "objectiveScore", label: "客观分", category: "score" },
    { id: "subjectiveScore", label: "主观分", category: "score" },
    { id: "gradeRank", label: "年排", category: "ranking" },
    { id: "classRank", label: "班排", category: "ranking" },
    { id: "rankChange", label: "名次变化", category: "ranking" },
    { id: "displayValue", label: "偏差值/Z值", category: "other" },
    { id: "needsReview", label: "需要复核", category: "other" },
  ];

  useEffect(() => {
    setAllColumns(COLUMN_DEFS);
    fetchJson<Template[]>("/api/export/templates").then(setTemplates).catch(() => {});
    const params = new URLSearchParams();
    if (classId) params.set("classId", classId);
    fetchJson<{ rows: Record<string, unknown>[]; hasAssignedScore: boolean }>(`/api/analysis/exams/${examId}/score-table?${params.toString()}`)
      .then((data) => { setPreviewRows(data.rows.slice(0, 3)); setHasAssignedScore(data.hasAssignedScore); })
      .catch(() => setPreviewRows([]));
  }, [examId, classId]);

  const unselected = allColumns.filter((c) => !selected.includes(c.id));

  function addColumn(colId: string) {
    if (!selected.includes(colId)) setSelected([...selected, colId]);
  }

  function removeColumn(index: number) {
    setSelected(selected.filter((_, i) => i !== index));
  }

  function handleDragStart(index: number) { dragItem.current = index; }
  function handleDragOver(e: React.DragEvent, index: number) { e.preventDefault(); dragOverItem.current = index; }
  function handleDrop() {
    if (dragItem.current == null || dragOverItem.current == null) return;
    const copy = [...selected];
    const [item] = copy.splice(dragItem.current, 1);
    copy.splice(dragOverItem.current, 0, item);
    setSelected(copy);
    dragItem.current = null;
    dragOverItem.current = null;
  }

  function saveTemplate(slot: number) {
    const name = templateNames[slot] || `模板${slot}`;
    fetchJson(`/api/export/templates/${slot}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, columns: selected, sideTableN: sideN, gapCols })
    }).then(() => {
      fetchJson<Template[]>("/api/export/templates").then(setTemplates).catch(() => {});
    }).catch(() => {});
  }

  function loadTemplate(t: Template) {
    setSelected(t.columns);
    setSideN(t.side_table_n ?? 10);
    setGapCols(t.gap_cols ?? 1);
    setActiveTemplate(t.slot);
    setTemplateNames({ ...templateNames, [t.slot]: t.name });
  }

  function deleteTemplate(slot: number) {
    fetchJson(`/api/export/templates/${slot}`, { method: "DELETE" })
      .then(() => { fetchJson<Template[]>("/api/export/templates").then(setTemplates).catch(() => {}); })
      .catch(() => {});
    if (activeTemplate === slot) setActiveTemplate(null);
  }

  async function doExport() {
    setExporting(true);
    try {
      const resp = await authFetch(`/api/export/exams/${examId}/scores`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ examId, classId: classId ? Number(classId) : undefined, columns: selected, sideTableN: sideN, gapCols })
      });
      if (!resp.ok) throw new Error("导出失败");
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${examName.replace(/[\/:*?"<>|]/g, "_")}_成绩表.xlsx`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      alert(err instanceof Error ? err.message : "导出失败");
    } finally { setExporting(false); }
  }

  function colLabel(id: string) { return COLUMN_DEFS.find((c) => c.id === id)?.label ?? id; }
  function colValue(colId: string, row: Record<string, unknown>): string | number {
    const map: Record<string, string> = { studentNumber: "studentNumber", studentName: "studentName", className: "className", totalScore: "totalScore", assignedScore: "assignedScore", objectiveScore: "objectiveScore", subjectiveScore: "subjectiveScore", gradeRank: "gradeRank", classRank: "classRank", displayValue: "displayValue" };
    const key = map[colId];
    if (!key) return "—";
    const v = row[key];
    return v != null ? String(v) : "—";
  }

  const totalWidth = computeTotalWidth(selected, sideN, gapCols);
  const overA4 = totalWidth > A4_MAX_CHARS;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 640, width: "94vw", maxHeight: "90vh" }}>
        <div className="modal-header">
          <h3 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>导出成绩 — {examName}</h3>
          <button className="ghost-button" onClick={onClose}><X size={18} /></button>
        </div>

        <div className="modal-body" style={{ padding: "16px 20px", overflowY: "auto", display: "flex", flexDirection: "column", gap: 14 }}>
          {/* Quick presets */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ fontSize: 13, fontWeight: 500 }}>快捷:</span>
            <button className="ghost-button" onClick={() => { setSelected(DEFAULT_COLUMNS); setSideN(10); setActiveTemplate(null); }} style={{ fontSize: 12 }}>基础表</button>
            <button className="ghost-button" onClick={() => setSelected(["studentNumber","studentName","className","totalScore","assignedScore","gradeRank","classRank","objectiveScore","subjectiveScore","rankChange","displayValue"])} style={{ fontSize: 12 }}>全列</button>
          </div>

          {/* Column capsules */}
          <div>
            <label style={{ fontSize: 13, fontWeight: 500, display: "block", marginBottom: 6 }}>列排列 (拖拽调整)</label>
            <div className="capsule-bar">
              {selected.map((colId, i) => (
                <div
                  key={colId}
                  className={`capsule${dragItem.current === i ? " capsule-dragging" : ""}`}
                  draggable
                  onDragStart={() => handleDragStart(i)}
                  onDragOver={(e) => handleDragOver(e, i)}
                  onDrop={handleDrop}
                  onDragEnd={() => { dragItem.current = null; dragOverItem.current = null; }}
                >
                  <GripVertical size={12} style={{ cursor: "grab", color: "var(--muted)" }} />
                  <span>{colLabel(colId)}</span>
                  <button onClick={(e) => { e.stopPropagation(); removeColumn(i); }} style={{ marginLeft: 2, cursor: "pointer", border: "none", background: "none", color: "var(--muted)", padding: 0, fontSize: 14 }}>×</button>
                </div>
              ))}
              {selected.length === 0 && <span style={{ fontSize: 12, color: "var(--muted)" }}>点击下方列添加</span>}
            </div>
          </div>

          {/* Column pool */}
          <div>
            <label style={{ fontSize: 12, color: "var(--muted)", display: "block", marginBottom: 4 }}>可选列</label>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {unselected.map((c) => (
                <button key={c.id} className="capsule capsule-add" onClick={() => addColumn(c.id)}>
                  <Plus size={11} /> {c.label}
                </button>
              ))}
              {unselected.length === 0 && <span style={{ fontSize: 12, color: "var(--muted)" }}>已选择全部列</span>}
            </div>
          </div>

          {/* A4 warning */}
          {overA4 && (
            <div style={{ padding: "8px 12px", background: "#fef3c7", borderRadius: 8, fontSize: 12, color: "#92400e" }}>
              ⚠ 所选列总宽可能超出 1 页竖版A4 (Word默认页边距)。当前约 {totalWidth}ch / 建议 ≤{A4_MAX_CHARS}ch。请减少列或调整侧表。
            </div>
          )}

          {/* Preview with real data */}
          <div>
            <label style={{ fontSize: 13, fontWeight: 500, display: "block", marginBottom: 4 }}>数据预览</label>
            <div style={{ overflowX: "auto", border: "1px solid var(--line)", borderRadius: 8, fontSize: 12, background: "#fff" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", whiteSpace: "nowrap" }}>
                <thead>
                  <tr style={{ background: "var(--surface-tint)", borderBottom: "1px solid var(--line)" }}>
                    {selected.map((colId) => (
                      <th key={colId} style={{ padding: "5px 8px", textAlign: "left", fontWeight: 600, fontSize: 12 }}>
                        {colLabel(colId)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {previewRows.length > 0 ? previewRows.map((row, ri) => (
                    <tr key={ri} style={{ borderTop: "1px solid var(--line-light)" }}>
                      {selected.map((colId) => (
                        <td key={colId} style={{ padding: "4px 8px", fontSize: 12 }}>{colValue(colId, row)}</td>
                      ))}
                    </tr>
                  )) : (
                    <tr><td colSpan={selected.length || 1} style={{ padding: "8px", color: "var(--muted)", textAlign: "center", fontSize: 12 }}>加载预览数据中...</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Side table */}
          <div>
            <label style={{ fontSize: 13, fontWeight: 500, display: "flex", alignItems: "center", gap: 8 }}>
              <input type="checkbox" checked={sideN > 0} onChange={(e) => setSideN(e.target.checked ? 10 : 0)} />
              附加年级排名参照表 (同Sheet右侧)
            </label>
            {sideN > 0 && (
              <div style={{ display: "flex", gap: 16, marginTop: 6 }}>
                <label style={{ fontSize: 12 }}>前 <input type="number" value={sideN} onChange={(e) => setSideN(Math.max(1, Number(e.target.value)))} style={{ width: 48, padding: "2px 6px", borderRadius: 4, border: "1px solid var(--line-strong)", fontSize: 12 }} /> 名</label>
                <label style={{ fontSize: 12 }}>间隙 <input type="number" value={gapCols} onChange={(e) => setGapCols(Math.max(1, Number(e.target.value)))} style={{ width: 40, padding: "2px 6px", borderRadius: 4, border: "1px solid var(--line-strong)", fontSize: 12 }} /> 列</label>
              </div>
            )}
          </div>

          {/* Templates */}
          <div style={{ borderTop: "1px solid var(--line)", paddingTop: 12 }}>
            <label style={{ fontSize: 13, fontWeight: 500, display: "block", marginBottom: 8 }}>自定义模板</label>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {[1, 2, 3, 4].map((slot) => {
                const t = templates.find((tp) => tp.slot === slot);
                const isActive = activeTemplate === slot;
                return (
                  <div
                    key={slot}
                    onClick={() => t && loadTemplate(t)}
                    style={{
                      display: "flex", alignItems: "center", gap: 8, cursor: t ? "pointer" : "default",
                      padding: "6px 10px", borderRadius: 8,
                      border: isActive ? "2px solid var(--brand)" : "1px solid var(--line)",
                      background: isActive ? "var(--surface-tint)" : "#fff",
                      transition: "border 0.15s"
                    }}
                  >
                    <span style={{ fontSize: 12, color: "var(--muted)", width: 48, fontWeight: isActive ? 600 : 400 }}>
                      {isActive && "● "}模板{slot}
                    </span>
                    <input
                      type="text"
                      value={t ? templateNames[slot] ?? t.name : templateNames[slot] ?? ""}
                      onChange={(e) => { e.stopPropagation(); setTemplateNames({ ...templateNames, [slot]: e.target.value }); }}
                      onClick={(e) => e.stopPropagation()}
                      placeholder="模板名称"
                      style={{ flex: 1, padding: "4px 8px", borderRadius: 6, border: "1px solid var(--line-strong)", fontSize: 12 }}
                    />
                    <button className="ghost-button" onClick={(e) => { e.stopPropagation(); saveTemplate(slot); }} style={{ fontSize: 11, padding: "3px 8px" }}>
                      <Save size={12} /> 保存
                    </button>
                    {t && (
                      <button className="ghost-button" onClick={(e) => { e.stopPropagation(); deleteTemplate(slot); }} style={{ fontSize: 11, color: "var(--brand)", padding: "3px 8px" }}>
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="modal-footer" style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "12px 20px", borderTop: "1px solid var(--line)" }}>
          <button className="ghost-button" onClick={onClose}>取消</button>
          <button className="primary-button" onClick={doExport} disabled={exporting || selected.length === 0}>
            <Download size={16} /> {exporting ? "导出中..." : "导出 Excel"}
          </button>
        </div>
      </div>
    </div>
  );
}
