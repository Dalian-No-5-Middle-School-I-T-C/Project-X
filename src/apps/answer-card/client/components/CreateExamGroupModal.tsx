import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Plus, Search, Trash2, X } from "lucide-react";
import { authFetch, fetchJson } from "../auth/api";
import type { ExamFilterItem, ExamGroupMember } from "../../../../shared/types";

interface Props {
  onClose: () => void;
  onCreated?: (groupId: number) => void;
  /** Edit mode: pass existing group data */
  existingGroup?: {
    id: number; name: string; description?: string;
    grade_id?: number | null; tag?: string;
    is_official?: number;
    total_score_mode?: string; only_full_participants?: number;
  };
  existingMembers?: ExamGroupMember[];
}

export function CreateExamGroupModal({ onClose, onCreated, existingGroup, existingMembers }: Props) {
  const [name, setName] = useState(existingGroup?.name ?? "");
  const [description, setDescription] = useState(existingGroup?.description ?? "");
  const [gradeId, setGradeId] = useState(existingGroup?.grade_id ? String(existingGroup.grade_id) : "");
  const [tag, setTag] = useState(existingGroup?.tag ?? "");
  const [isOfficial, setIsOfficial] = useState(existingGroup?.is_official ?? 0);
  const [totalScoreMode, setTotalScoreMode] = useState<string>(existingGroup?.total_score_mode ?? "raw");

  const [selectedExams, setSelectedExams] = useState<Array<{ examId: number; examName: string; subject: string; date: string }>>(
    existingMembers?.map((m: any) => ({
      examId: m.examId ?? m.exam_id,
      examName: m.examName ?? m.exam_name,
      subject: m.subject ?? "",
      date: m.examDate ?? m.exam_date ?? ""
    })) ?? []
  );
  const [showPicker, setShowPicker] = useState(false);
  const [pickerExams, setPickerExams] = useState<ExamFilterItem[]>([]);
  const [pickerSearch, setPickerSearch] = useState("");
  const [pickerSubject, setPickerSubject] = useState("");
  const [pickerLoading, setPickerLoading] = useState(false);
  const [grades, setGrades] = useState<Array<{ id: number; name: string }>>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  const isEdit = !!existingGroup;

  useEffect(() => {
    fetchJson<Array<{ id: number; name: string }>>("/api/grades")
      .then(setGrades)
      .catch(() => setGrades([]));
  }, []);

  useEffect(() => {
    if (showPicker) {
      loadPickerExams();
    }
  }, [showPicker, pickerSubject]);

  async function loadPickerExams() {
    setPickerLoading(true);
    try {
      const params = new URLSearchParams({ selection: "1" });
      if (pickerSubject) params.set("subject", pickerSubject);
      const data = await fetchJson<ExamFilterItem[]>(`/api/exams?${params.toString()}`);
      setPickerExams(data);
    } catch { setPickerExams([]); }
    finally { setPickerLoading(false); }
  }

  async function handleSubmit() {
    if (!name.trim()) { setError("大考名称不能为空"); return; }
    if (selectedExams.length === 0) { setError("请至少关联一场考试"); return; }

    setCreating(true);
    setError("");
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        description: description.trim() || null,
        grade_id: gradeId ? Number(gradeId) : null,
        tag: tag || null,
        is_official: isOfficial,
        total_score_mode: totalScoreMode,
        examIds: selectedExams.map((e) => e.examId)
      };

      if (isEdit) {
        await authFetch(`/api/exam-groups/${existingGroup!.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        onCreated?.(existingGroup!.id);
      } else {
        const res = await authFetch("/api/exam-groups", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        const data = await res.json();
        onCreated?.(data.id);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setCreating(false);
    }
  }

  function addExamFromPicker(exam: ExamFilterItem) {
    if (selectedExams.some((e) => e.examId === exam.id)) return;
    setSelectedExams([...selectedExams, {
      examId: exam.id,
      examName: exam.name,
      subject: exam.subject || "",
      date: exam.exam_date || ""
    }]);
  }

  function removeExam(examId: number) {
    setSelectedExams(selectedExams.filter((e) => e.examId !== examId));
  }

  // Available tags
  const tags = ["", "月考", "期中", "期末", "模考", "统考"];

  const filteredPicker = pickerExams.filter((e) =>
    !pickerSearch || e.name.includes(pickerSearch) || (e.subject || "").includes(pickerSearch)
  );

  return createPortal(
    <div style={{
      position: "fixed", inset: 0, zIndex: 100000,
      display: "flex", alignItems: "center", justifyContent: "center",
      background: "rgba(0,0,0,0.45)"
    }} onClick={onClose}>
      <div style={{
        background: "var(--surface)", borderRadius: 12,
        width: 560, maxHeight: "80vh", overflow: "auto",
        boxShadow: "0 8px 32px rgba(0,0,0,0.18)", padding: 24
      }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>
            {isEdit ? "编辑大考" : "创建大考"}
          </h3>
          <button onClick={onClose} style={{
            background: "none", border: "none", cursor: "pointer",
            padding: 4, borderRadius: 6, color: "var(--muted)"
          }}><X size={18} /></button>
        </div>

        {/* Name & grade row */}
        <div style={{ display: "flex", gap: 12, marginBottom: 12 }}>
          <div style={{ flex: 1.5, display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ fontSize: 12, color: "var(--muted)" }}>大考名称 <span style={{ color: "red" }}>*</span></label>
            <input value={name} onChange={(e) => setName(e.target.value)}
              placeholder="如：2026高考摸底大考"
              style={inputStyle} />
          </div>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ fontSize: 12, color: "var(--muted)" }}>年级</label>
            <select value={gradeId} onChange={(e) => setGradeId(e.target.value)}
              style={selectStyle}>
              <option value="">不限</option>
              {grades.map((g) => <option key={g.id} value={String(g.id)}>{g.name}</option>)}
            </select>
          </div>
        </div>

        {/* Description & tag */}
        <div style={{ display: "flex", gap: 12, marginBottom: 12 }}>
          <div style={{ flex: 1.5, display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ fontSize: 12, color: "var(--muted)" }}>描述</label>
            <input value={description} onChange={(e) => setDescription(e.target.value)}
              placeholder="可选描述"
              style={inputStyle} />
          </div>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ fontSize: 12, color: "var(--muted)" }}>标签</label>
            <select value={tag} onChange={(e) => setTag(e.target.value)}
              style={selectStyle}>
              {tags.map((t) => <option key={t} value={t}>{t || "无标签"}</option>)}
            </select>
          </div>
        </div>

        {/* Options */}
        <div style={{ display: "flex", gap: 16, marginBottom: 16, fontSize: 13 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
            <input type="checkbox" checked={isOfficial === 1} onChange={(e) => setIsOfficial(e.target.checked ? 1 : 0)} />
            官方统考
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ color: "var(--muted)" }}>总分按：</span>
            <select value={totalScoreMode} onChange={(e) => setTotalScoreMode(e.target.value)}
              style={{ ...selectStyle, padding: "2px 6px", fontSize: 12 }}>
              <option value="raw">原始分</option>
              <option value="assigned">赋分</option>
            </select>
          </label>
        </div>

        {/* Associated exams */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <label style={{ fontSize: 13, fontWeight: 500 }}>关联考试 <span style={{ color: "red" }}>*</span></label>
            <button onClick={() => setShowPicker(!showPicker)} style={{
              background: "var(--primary)", color: "#fff", border: "none",
              borderRadius: 6, padding: "4px 12px", fontSize: 12, cursor: "pointer",
              display: "flex", alignItems: "center", gap: 4
            }}>
              <Plus size={14} /> {showPicker ? "收起" : "关联考试"}
            </button>
          </div>

          {/* Picker panel */}
          {showPicker && (
            <div style={{
              border: "1px solid var(--border)", borderRadius: 8,
              padding: 12, marginBottom: 8, background: "var(--bg-secondary)",
              maxHeight: 200, overflow: "auto"
            }}>
              <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                <div style={{ position: "relative", flex: 1 }}>
                  <Search size={14} style={{ position: "absolute", left: 8, top: 8, color: "var(--muted)" }} />
                  <input value={pickerSearch} onChange={(e) => setPickerSearch(e.target.value)}
                    placeholder="搜索考试..."
                    style={{ ...inputStyle, paddingLeft: 28, fontSize: 12 }} />
                </div>
                <select value={pickerSubject} onChange={(e) => setPickerSubject(e.target.value)}
                  style={{ ...selectStyle, width: 100, fontSize: 12 }}>
                  <option value="">全部科目</option>
                  {["语文","数学","英语","物理","化学","生物","政治","历史","地理"].map((s) =>
                    <option key={s} value={s}>{s}</option>
                  )}
                </select>
              </div>
              {pickerLoading ? (
                <div style={{ textAlign: "center", padding: 16, color: "var(--muted)", fontSize: 13 }}>
                  加载中...
                </div>
              ) : filteredPicker.length === 0 ? (
                <div style={{ textAlign: "center", padding: 16, color: "var(--muted)", fontSize: 13 }}>
                  暂无考试
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {filteredPicker.slice(0, 20).map((exam) => {
                    const alreadyAdded = selectedExams.some((e) => e.examId === exam.id);
                    return (
                      <div key={exam.id} style={{
                        display: "flex", justifyContent: "space-between", alignItems: "center",
                        padding: "6px 8px", borderRadius: 6,
                        background: alreadyAdded ? "var(--bg-accent)" : undefined,
                        opacity: alreadyAdded ? 0.5 : 1,
                        cursor: alreadyAdded ? "default" : "pointer",
                        fontSize: 13
                      }} onClick={() => !alreadyAdded && addExamFromPicker(exam)}>
                        <div style={{ display: "flex", gap: 8 }}>
                          <span style={{ fontWeight: 500 }}>{exam.name}</span>
                          <span style={{ color: "var(--muted)" }}>{exam.subject || "—"}</span>
                        </div>
                        <span style={{ fontSize: 11, color: "var(--muted)" }}>
                          {exam.graded_count > 0 ? `${exam.graded_count}人 均${exam.avg_score}` : "未阅卷"}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Selected exams list */}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {selectedExams.map((exam, idx) => (
              <div key={exam.examId} style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                padding: "8px 12px", borderRadius: 8,
                background: "var(--bg-secondary)", fontSize: 13
              }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span style={{
                    background: "var(--primary)", color: "#fff",
                    borderRadius: "50%", width: 22, height: 22,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 11, fontWeight: 600
                  }}>{idx + 1}</span>
                  <span style={{ fontWeight: 500 }}>{exam.examName}</span>
                  <span style={{ color: "var(--muted)", fontSize: 12 }}>{exam.subject}</span>
                  {exam.date && <span style={{ color: "var(--muted)", fontSize: 11 }}>{exam.date}</span>}
                </div>
                <button onClick={() => removeExam(exam.examId)} style={{
                  background: "none", border: "none", cursor: "pointer",
                  padding: 2, borderRadius: 4, color: "var(--muted)"
                }}><Trash2 size={14} /></button>
              </div>
            ))}
            {selectedExams.length === 0 && (
              <div style={{ textAlign: "center", padding: 16, color: "var(--muted)", fontSize: 13 }}>
                请在上方选择要关联的考试
              </div>
            )}
          </div>
        </div>

        {error && (
          <div style={{ color: "var(--danger)", fontSize: 13, marginBottom: 12 }}>{error}</div>
        )}

        {/* Actions */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} style={secondaryBtnStyle}>取消</button>
          <button onClick={handleSubmit} disabled={creating} style={primaryBtnStyle}>
            {creating ? "提交中..." : isEdit ? "保存修改" : "创建大考"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

// Shared styles
const inputStyle: React.CSSProperties = {
  padding: "8px 10px", borderRadius: 6, border: "1px solid var(--border)",
  fontSize: 13, background: "var(--surface)", color: "var(--text)",
  outline: "none", width: "100%", boxSizing: "border-box"
};

const selectStyle: React.CSSProperties = {
  padding: "8px 10px", borderRadius: 6, border: "1px solid var(--border)",
  fontSize: 13, background: "var(--surface)", color: "var(--text)",
  outline: "none", width: "100%", boxSizing: "border-box"
};

const primaryBtnStyle: React.CSSProperties = {
  background: "var(--primary)", color: "#fff", border: "none",
  borderRadius: 6, padding: "8px 20px", fontSize: 13, cursor: "pointer",
  fontWeight: 500
};

const secondaryBtnStyle: React.CSSProperties = {
  background: "var(--bg-secondary)", color: "var(--text)", border: "1px solid var(--border)",
  borderRadius: 6, padding: "8px 20px", fontSize: 13, cursor: "pointer"
};
