import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Download, X } from "lucide-react";
import { authFetch, fetchJson } from "../auth/api";
import type { ExamGroupDetail, ExamGroupMember } from "../../../../shared/types";

interface Props {
  groupId: number;
  onClose: () => void;
}

export function GroupExportModal({ groupId, onClose }: Props) {
  const [detail, setDetail] = useState<ExamGroupDetail | null>(null);
  const [includeOverview, setIncludeOverview] = useState(true);
  const [subjectExamIds, setSubjectExamIds] = useState<number[]>([]);
  const [selectAll, setSelectAll] = useState(true);
  const [includeObjSub, setIncludeObjSub] = useState(true);
  const [includeSubjSub, setIncludeSubjSub] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchJson<ExamGroupDetail>(`/api/exam-groups/${groupId}`)
      .then((data) => {
        setDetail(data);
        const allIds = data.members.map((m: ExamGroupMember) => m.examId);
        setSubjectExamIds(allIds);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [groupId]);

  // ESC to close
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  function toggleSubject(examId: number) {
    setSubjectExamIds((prev) =>
      prev.includes(examId) ? prev.filter((id) => id !== examId) : [...prev, examId]
    );
  }

  function handleSelectAll() {
    if (detail) {
      if (selectAll) {
        setSubjectExamIds([]);
      } else {
        setSubjectExamIds(detail.members.map((m) => m.examId));
      }
      setSelectAll(!selectAll);
    }
  }

  async function handleExport() {
    setExporting(true);
    try {
      const res = await authFetch(`/api/exam-groups/${groupId}/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          includeOverview,
          subjectExamIds,
          includeObjSub,
          includeSubjSub
        })
      });

      if (!res.ok) throw new Error("导出失败");

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${detail?.name ?? "大考"}_导出.zip`;
      a.click();
      URL.revokeObjectURL(url);
      onClose();
    } catch (err) {
      alert(err instanceof Error ? err.message : "导出失败");
    } finally {
      setExporting(false);
    }
  }

  return createPortal(
    <div style={{
      position: "fixed", inset: 0, zIndex: 100001,
      display: "flex", alignItems: "center", justifyContent: "center",
      background: "rgba(0,0,0,0.45)"
    }} onClick={onClose}>
      <div style={{
        background: "var(--surface)", borderRadius: 12,
        width: 480, maxHeight: "80vh", overflow: "auto",
        boxShadow: "0 8px 32px rgba(0,0,0,0.18)", padding: 24
      }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>
            导出大考：{detail?.name ?? ""}
          </h3>
          <button onClick={onClose} style={{
            background: "none", border: "none", cursor: "pointer",
            padding: 4, borderRadius: 6, color: "var(--muted)"
          }}><X size={18} /></button>
        </div>

        {loading ? (
          <div style={{ textAlign: "center", padding: 20, color: "var(--muted)" }}>加载中...</div>
        ) : !detail ? (
          <div style={{ textAlign: "center", padding: 20, color: "var(--muted)" }}>加载失败</div>
        ) : (
          <>
            {/* Overview section */}
            <div style={{ marginBottom: 16, padding: 12, borderRadius: 8, background: "var(--bg-secondary)", border: "1px solid var(--border)" }}>
              <label style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}>
                <input type="checkbox" checked={includeOverview} onChange={(e) => setIncludeOverview(e.target.checked)}
                  style={{ marginTop: 2 }} />
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>总览成绩表</div>
                  <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>
                    按总分排名的跨科成绩表，含各科校排/班排/原始分。有赋分的科目同列显示赋分。
                  </div>
                </div>
              </label>
            </div>

            {/* Per-subject section */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>各科详细小分</div>
                <button onClick={handleSelectAll} style={{
                  background: "none", border: "none", color: "var(--primary)",
                  cursor: "pointer", fontSize: 12
                }}>
                  {selectAll ? "取消全选" : "全选"}
                </button>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {detail.members.map((m) => (
                  <label key={m.examId} style={{
                    display: "flex", alignItems: "center", gap: 6,
                    padding: "6px 12px", borderRadius: 8,
                    border: subjectExamIds.includes(m.examId) ? "2px solid var(--primary)" : "1px solid var(--border)",
                    cursor: "pointer", fontSize: 13,
                    background: subjectExamIds.includes(m.examId) ? "var(--bg-accent)" : undefined,
                    fontWeight: subjectExamIds.includes(m.examId) ? 500 : 400
                  }}>
                    <input type="checkbox" checked={subjectExamIds.includes(m.examId)}
                      onChange={() => toggleSubject(m.examId)} style={{ display: "none" }} />
                    {m.subject || m.examName}
                  </label>
                ))}
              </div>
            </div>

            {/* Sub-score options */}
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>小分选项</div>
              <div style={{ display: "flex", gap: 16 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer" }}>
                  <input type="checkbox" checked={includeObjSub} onChange={(e) => setIncludeObjSub(e.target.checked)} />
                  客观题小分
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer" }}>
                  <input type="checkbox" checked={includeSubjSub} onChange={(e) => setIncludeSubjSub(e.target.checked)} />
                  主观题小分
                </label>
              </div>
            </div>

            {/* Info */}
            <div style={{
              fontSize: 12, color: "var(--muted)", marginBottom: 16,
              padding: "8px 12px", borderRadius: 6, background: "var(--bg-secondary)"
            }}>
              导出为 ZIP 压缩包，含{includeOverview ? "总览表 + " : ""}{subjectExamIds.length} 科详细小分
            </div>

            {/* Actions */}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button onClick={onClose} style={secondaryBtnStyle}>取消</button>
              <button onClick={handleExport} disabled={exporting || (!includeOverview && subjectExamIds.length === 0)}
                style={primaryBtnStyle}>
                {exporting ? "导出中..." : "导出 ZIP"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}

const primaryBtnStyle: React.CSSProperties = {
  background: "var(--brand)", color: "#fff", border: "none",
  borderRadius: 6, padding: "8px 20px", fontSize: 13, cursor: "pointer",
  fontWeight: 500, display: "flex", alignItems: "center", gap: 6
};

const secondaryBtnStyle: React.CSSProperties = {
  background: "var(--bg-secondary)", color: "var(--text)", border: "1px solid var(--border)",
  borderRadius: 6, padding: "8px 20px", fontSize: 13, cursor: "pointer"
};
