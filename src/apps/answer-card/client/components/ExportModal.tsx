import { useEffect, useRef, useState } from "react";
import { Download, GripVertical, Plus, Save, Trash2, X } from "lucide-react";
import { fetchJson, getAuthToken, authFetch } from "../auth/api";

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

// A4 portrait, Word default margins: ~63ch usable width
const A4_MAX_CHARS = 63;
// Column width estimates in chars
const COL_WIDTHS: Record<string, number> = {
  studentNumber: 14, grade: 8, className: 10, studentName: 10,
  totalScore: 8, assignedScore: 8, objectiveScore: 8, subjectiveScore: 8,
  gradeRank: 6, classRank: 6, rankChange: 10, displayValue: 12,
  needsReview: 8, confidence: 8
};
const SIDE_COL_WIDTHS = [6, 10, 8]; // 年排, 班级, 原始分

function computeTotalWidth(columns: string[], sideN: number, gap: number): number {
  const mainW = columns.reduce((sum, c) => sum + (COL_WIDTHS[c] ?? 10), 0);
  if (sideN > 0) {
    const sideW = SIDE_COL_WIDTHS.reduce((a, b) => a + b, 0);
    return mainW + gap + sideW;
  }
  return mainW;
}

export function ExportModal({ examId, examName, classId, onClose }: Props) {
  const [allColumns, setAllColumns] = useState<ColumnMeta[]>([]);
  const [selected, setSelected] = useState<string[]>(["className", "studentName", "totalScore", "gradeRank"]);
  const [sideN, setSideN] = useState(0);
  const [gapCols, setGapCols] = useState(3);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templateName, setTemplateName] = useState("");
  const [preview, setPreview] = useState<Record<string, string | number | null>[]>([]);
  const [exporting, setExporting] = useState(false);
  const dragItem = useRef<number | null>(null);
  const dragOverItem = useRef<number | null>(null);

  useEffect(() => {
    // Load column definitions
    fetchJson<{ columns: Record<string, ColumnMeta> }>("/api/export/columns")
      .then((data) => setAllColumns(Object.values(data.columns)))
      .catch(() => {});

    // Load templates
    fetchJson<Template[]>("/api/export/templates")
      .then(setTemplates)
      .catch(() => {});

    // Load preview (first 3 rows)
    const params = new URLSearchParams();
    if (classId) params.set("classId", classId);
    fetchJson<{ rows: Record<string, unknown>[] }>(
      `/api/analysis/exams/${examId}/score-table?${params.toString()}`
    )
      .then((data) => {
        // Map first 3 rows to preview columns
        const mapped: Record<string, string | number | null>[] = [];
        for (const row of data.rows.slice(0, 3)) {
          const m: Record<string, string | number | null> = {};
          for (const col of selected) {
            m[col] = mapPreviewValue(col, row);
          }
          mapped.push(m);
        }
        setPreview(mapped);
      })
      .catch(() => setPreview([]));
  }, [examId, classId]);

  const unselected = allColumns.filter((c) => !selected.includes(c.id));

  function addColumn(colId: string) {
    setSelected([...selected, colId]);
  }

  function removeColumn(index: number) {
    setSelected(selected.filter((_, i) => i !== index));
  }

  function handleDragStart(index: number) {
    dragItem.current = index;
  }

  function handleDragOver(e: React.DragEvent, index: number) {
    e.preventDefault();
    dragOverItem.current = index;
  }

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
    fetchJson(`/api/export/templates/${slot}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: templateName || `模板${slot}`,
        columns: selected,
        sideTableN: sideN,
        gapCols
      })
    }).then(() => {
      fetchJson<Template[]>("/api/export/templates")
        .then(setTemplates).catch(() => {});
    }).catch(() => {});
  }

  function loadTemplate(t: Template) {
    setSelected(t.columns);
    setSideN(t.side_table_n ?? 0);
    setGapCols(t.gap_cols ?? 3);
    setTemplateName(t.name);
  }

  function deleteTemplate(slot: number) {
    fetchJson(`/api/export/templates/${slot}`, { method: "DELETE" })
      .then(() => fetchJson<Template[]>("/api/export/templates").then(setTemplates).catch(() => {}))
      .catch(() => {});
  }

  async function doExport() {
    setExporting(true);
    try {
      const resp = await authFetch(`/api/export/exams/${examId}/scores`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          examId, classId: classId ? Number(classId) : undefined,
          columns: selected, sideTableN: sideN, gapCols
        })
      });
      if (!resp.ok) throw new Error("导出失败");
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${examName.replace(/[\/:*?"<>|]/g, "_")}_成绩表.xlsx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      alert(err instanceof Error ? err.message : "导出失败");
    } finally {
      setExporting(false);
    }
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
          {/* Quick export */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ fontSize: 13, fontWeight: 500 }}>快捷导出:</span>
            <button className="ghost-button" onClick={() => setSelected(["studentNumber", "studentName", "className", "totalScore", "gradeRank", "classRank"])} style={{ fontSize: 12 }}>基础表</button>
            <button className="ghost-button" onClick={() => setSelected(["studentNumber", "studentName", "className", "totalScore", "assignedScore", "gradeRank", "classRank", "objectiveScore", "subjectiveScore"])} style={{ fontSize: 12 }}>全列</button>
          </div>

          {/* Column capsules */}
          <div>
            <label style={{ fontSize: 13, fontWeight: 500, display: "block", marginBottom: 6 }}>列排列 (拖拽调整)</label>
            <div className="capsule-bar">
              {selected.map((colId, i) => {
                const meta = allColumns.find((c) => c.id === colId);
                return (
                  <div
                    key={colId}
                    className="capsule"
                    draggable
                    onDragStart={() => handleDragStart(i)}
                    onDragOver={(e) => handleDragOver(e, i)}
                    onDrop={handleDrop}
                  >
                    <GripVertical size={12} style={{ cursor: "grab", color: "var(--muted)" }} />
                    <span>{meta?.label ?? colId}</span>
                    <button onClick={(e) => { e.stopPropagation(); removeColumn(i); }} style={{ marginLeft: 2, cursor: "pointer", border: "none", background: "none", color: "var(--muted)", padding: 0, fontSize: 14 }}>×</button>
                  </div>
                );
              })}
              {selected.length === 0 && <span style={{ fontSize: 12, color: "var(--muted)" }}>点击下方列添加</span>}
            </div>
          </div>

          {/* Column pool */}
          {unselected.length > 0 && (
            <div>
              <label style={{ fontSize: 12, color: "var(--muted)", display: "block", marginBottom: 4 }}>可选列 (点击添加)</label>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {unselected.map((c) => (
                  <button key={c.id} className="capsule capsule-add" onClick={() => addColumn(c.id)}>
                    <Plus size={11} /> {c.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* A4 overflow warning */}
          {overA4 && (
            <div style={{ padding: "8px 12px", background: "#fef3c7", borderRadius: 8, fontSize: 12, color: "#92400e" }}>
              ⚠ 所选列总宽超出 1 页竖版A4 (Word默认边距)。当前 {totalWidth}ch / 建议 ≤{A4_MAX_CHARS}ch
            </div>
          )}

          {/* Preview */}
          {selected.length > 0 && preview.length > 0 && (
            <div>
              <label style={{ fontSize: 13, fontWeight: 500, display: "block", marginBottom: 4 }}>数据预览</label>
              <div style={{ overflowX: "auto", border: "1px solid var(--line)", borderRadius: 8, fontSize: 12 }}>
                <table style={{ width: "100%", borderCollapse: "collapse", whiteSpace: "nowrap" }}>
                  <thead>
                    <tr style={{ background: "var(--surface-tint)", borderBottom: "1px solid var(--line)" }}>
                      {selected.map((colId) => (
                        <th key={colId} style={{ padding: "4px 8px", textAlign: "left", fontWeight: 600 }}>
                          {allColumns.find((c) => c.id === colId)?.label ?? colId}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr style={{ color: "var(--muted)", fontStyle: "italic" }}>
                      {selected.map((colId) => (
                        <td key={colId} style={{ padding: "3px 8px" }}>...</td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Side table */}
          <div>
            <label style={{ fontSize: 13, fontWeight: 500, display: "flex", alignItems: "center", gap: 8 }}>
              <input type="checkbox" checked={sideN > 0} onChange={(e) => setSideN(e.target.checked ? 10 : 0)} />
              附加年级排名参照表
            </label>
            {sideN > 0 && (
              <div style={{ display: "flex", gap: 16, marginTop: 6 }}>
                <label style={{ fontSize: 12 }}>
                  前 <input type="number" value={sideN} onChange={(e) => setSideN(Math.max(1, Number(e.target.value)))} style={{ width: 50, padding: "2px 6px", borderRadius: 4, border: "1px solid var(--line-strong)", fontSize: 12 }} /> 名
                </label>
                <label style={{ fontSize: 12 }}>
                  间隙 <input type="number" value={gapCols} onChange={(e) => setGapCols(Math.max(1, Number(e.target.value)))} style={{ width: 40, padding: "2px 6px", borderRadius: 4, border: "1px solid var(--line-strong)", fontSize: 12 }} /> 列
                </label>
              </div>
            )}
          </div>

          {/* Templates */}
          <div style={{ borderTop: "1px solid var(--line)", paddingTop: 12 }}>
            <label style={{ fontSize: 13, fontWeight: 500, display: "block", marginBottom: 8 }}>自定义模板</label>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {[1, 2, 3, 4].map((slot) => {
                const t = templates.find((tp) => tp.slot === slot);
                return (
                  <div key={slot} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 12, color: "var(--muted)", width: 48 }}>模板{slot}</span>
                    <input
                      type="text"
                      value={t ? t.name : templateName || ""}
                      onChange={(e) => setTemplateName(e.target.value)}
                      placeholder="模板名称"
                      style={{ flex: 1, padding: "4px 8px", borderRadius: 6, border: "1px solid var(--line-strong)", fontSize: 12 }}
                    />
                    <button className="ghost-button" onClick={() => saveTemplate(slot)} style={{ fontSize: 11, padding: "3px 8px" }}>
                      <Save size={12} /> 保存
                    </button>
                    {t && (
                      <>
                        <button className="ghost-button" onClick={() => loadTemplate(t)} style={{ fontSize: 11, padding: "3px 8px" }}>使用</button>
                        <button className="ghost-button" onClick={() => deleteTemplate(slot)} style={{ fontSize: 11, color: "var(--brand)", padding: "3px 8px" }}>
                          <Trash2 size={12} />
                        </button>
                      </>
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

function mapPreviewValue(colId: string, row: Record<string, unknown>): string | number | null {
  const map: Record<string, string> = {
    studentNumber: "studentNumber",
    studentName: "studentName",
    className: "className",
    totalScore: "totalScore",
    gradeRank: "gradeRank",
    classRank: "classRank",
    objectiveScore: "objectiveScore",
    subjectiveScore: "subjectiveScore",
    displayValue: "displayValue",
    assignedScore: "assignedScore"
  };
  const key = map[colId];
  return key ? (row[key] as string | number | null) ?? "-" : "-";
}
