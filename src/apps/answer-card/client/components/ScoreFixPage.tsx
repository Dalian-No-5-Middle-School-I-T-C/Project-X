import { useEffect, useMemo, useState, useRef } from "react";
import { ArrowLeft, Pencil, Save, Search, X } from "lucide-react";
import { fetchJson } from "../auth/api";
import type { ScoreDisplayMode } from "../../../../shared/types";

interface Props {
  examId: number;
  examName: string;
  subject: string | null;
  onBack: () => void;
}

type FixMode = "score" | "answer";

interface StudentScore {
  student: { id: number; name: string; studentNumber: string };
  totalScore: { objectiveScore: number; subjectiveScore: number; totalScore: number; assignedScore: number | null; manuallyModified: boolean } | null;
  questionScores: Array<{
    id: number; question_number: number; score_type: string; score: number; max_score: number;
    mode: string; optionCount: number; answerKey: string[]; scoringRule: any; step: number; blockType: string;
    manually_modified: number; modified_at: string | null;
  }>;
  recognition: Record<number, { selectedOptions: string[]; confidence: number }>;
  scans: Array<{ recordId: number; pageNum: number }>;
  cardId: string;
}

interface CardAnswer {
  questionNumber: number;
  questionType: string;
  mode?: string;
  optionCount?: number;
  score: number;
  answerKey?: string[];
  scoringRule?: any;
}

const OPTION_LABELS = ["A","B","C","D","E","F","G","H","I","J"];

export function ScoreFixPage({ examId, examName, onBack }: Props) {
  const [mode, setMode] = useState<FixMode>("score");
  const [search, setSearch] = useState("");
  const [student, setStudent] = useState<StudentScore | null>(null);
  const [loadingStudent, setLoadingStudent] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");

  // Individual score edits: question_number -> new score
  const [scoreEdits, setScoreEdits] = useState<Record<string, number>>({});

  // Answer mode
  const [cardAnswers, setCardAnswers] = useState<CardAnswer[]>([]);
  const [answerEdits, setAnswerEdits] = useState<Record<string, string[]>>({});
  const [loadingAnswers, setLoadingAnswers] = useState(false);
  const [showCardPreview, setShowCardPreview] = useState(false);
  const [previewScans, setPreviewScans] = useState<Array<{ recordId: number; pageNum: number }>>([]);

  // Load answer config when switching to answer mode
  useEffect(() => {
    if (mode === "answer" && cardAnswers.length === 0) {
      setLoadingAnswers(true);
      fetchJson<{ questions: CardAnswer[]; cardId: string }>(`/api/exams/${examId}/answers`)
        .then((data) => {
          setCardAnswers(data.questions);
          // Clear previous answer edits
          setAnswerEdits({});
        })
        .catch((err) => setError(err instanceof Error ? err.message : "加载答案失败"))
        .finally(() => setLoadingAnswers(false));
    }
  }, [mode, examId]);

  async function searchStudent() {
    if (!search.trim()) return;
    setLoadingStudent(true);
    setError("");
    setStudent(null);
    setScoreEdits({});

    try {
      // First find student by name or number
      const classesResp = await fetchJson<any[]>("/api/classes");
      // Look through all classes for the student
      let studentId: number | null = null;
      let foundName = "";
      let foundNumber = "";

      for (const cls of classesResp) {
        try {
          const roster = await fetchJson<any[]>(`/api/classes/${cls.id}/students`);
          const match = roster.find((s: any) =>
            s.student_number === search.trim() ||
            s.name?.toLowerCase().includes(search.trim().toLowerCase())
          );
          if (match) {
            studentId = match.id;
            foundName = match.name;
            foundNumber = match.student_number ?? "";
            break;
          }
        } catch {}
      }

      // Also try by users search
      if (!studentId) {
        try {
          // Try to find by student_number directly
          const usersResp = await fetchJson<any[]>(`/api/users/students?search=${encodeURIComponent(search.trim())}`);
          if (usersResp.length > 0) {
            studentId = usersResp[0].id;
            foundName = usersResp[0].name;
            foundNumber = usersResp[0].student_number ?? "";
          }
        } catch {}
      }

      if (!studentId) {
        setError("未找到该学生，请检查考号或姓名");
        setLoadingStudent(false);
        return;
      }

      // Get student scores
      const data = await fetchJson<StudentScore>(`/api/exams/${examId}/student/${studentId}/scores`);
      setStudent(data);
      setPreviewScans(data.scans);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoadingStudent(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") searchStudent();
  }

  function setScoreEdit(qNum: number, scoreType: string, val: number) {
    const key = `${qNum}_${scoreType}`;
    setScoreEdits((prev) => ({ ...prev, [key]: val }));
  }

  function getScoreEdit(qNum: number, scoreType: string, defaultScore: number): number {
    const key = `${qNum}_${scoreType}`;
    return key in scoreEdits ? scoreEdits[key] : defaultScore;
  }

  async function saveScoreEdits() {
    if (!student) return;
    const updates = Object.entries(scoreEdits).map(([key, score]) => {
      const [qNum, scoreType] = key.split("_");
      return { questionNumber: Number(qNum), scoreType, score };
    });
    if (updates.length === 0) { setSaveMsg("没有修改"); return; }

    setSaving(true);
    setSaveMsg("");
    try {
      await fetchJson(`/api/exams/${examId}/student/${student.student.id}/scores`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scores: updates })
      });
      setSaveMsg("保存成功！");
      setScoreEdits({});
      // Reload student data
      searchStudent();
    } catch (err) {
      setSaveMsg(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  function toggleOption(qNum: number, opt: string, isMulti: boolean) {
    setAnswerEdits((prev) => {
      const key = String(qNum);
      const current = [...(prev[key] ?? [])];
      if (!isMulti) {
        return { ...prev, [key]: [opt] };
      }
      const idx = current.indexOf(opt);
      if (idx >= 0) current.splice(idx, 1);
      else current.push(opt);
      return { ...prev, [key]: current };
    });
  }

  function getAnswerEdit(qNum: number, defaultKey: string[]): string[] {
    return answerEdits[String(qNum)] ?? defaultKey;
  }

  function initAnswerFromCard(qNum: number, answerKey: string[]) {
    if (String(qNum) in answerEdits) return;
    setAnswerEdits((prev) => ({ ...prev, [String(qNum)]: [...answerKey] }));
  }

  async function saveAnswerEdits() {
    if (Object.keys(answerEdits).length === 0) { setSaveMsg("没有修改答案"); return; }
    setSaving(true);
    setSaveMsg("");
    try {
      const resp = await fetchJson<{ ok: boolean; updatedCount: number }>(`/api/exams/${examId}/answers`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers: answerEdits })
      });
      setSaveMsg(`已重算 ${resp.updatedCount} 名学生的成绩！`);
      setAnswerEdits({});
    } catch (err) {
      setSaveMsg(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  // ── Render ────────────────────────────────────
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Header bar */}
      <div style={{
        display: "flex", alignItems: "center", gap: 12,
        padding: "12px 24px", borderBottom: "1px solid var(--line)",
        background: "#fff", flexShrink: 0
      }}>
        <button onClick={onBack} style={headerBtnStyle}>
          <ArrowLeft size={16} /> 返回成绩
        </button>
        <div style={{ flex: 1 }}>
          <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>
            成绩修改 — {examName}
          </h2>
        </div>

        {/* Mode toggle */}
        <div style={{ display: "flex", borderRadius: 8, border: "1px solid var(--line)", overflow: "hidden" }}>
          <button
            onClick={() => setMode("score")}
            style={{
              ...modeToggleStyle,
              background: mode === "score" ? "var(--brand)" : "#fff",
              color: mode === "score" ? "#fff" : "var(--text-primary)"
            }}
          >个别改分</button>
          <button
            onClick={() => setMode("answer")}
            style={{
              ...modeToggleStyle,
              background: mode === "answer" ? "var(--brand)" : "#fff",
              color: mode === "answer" ? "#fff" : "var(--text-primary)"
            }}
          >修改答案</button>
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: "auto", padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
        {mode === "score" && (
          <>
            {/* Search bar */}
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, background: "#fff", border: "1px solid var(--line)", borderRadius: 8, padding: "6px 12px", flex: 1, maxWidth: 360 }}>
                <Search size={14} style={{ color: "var(--muted)", flexShrink: 0 }} />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="输入考号或姓名搜索..."
                  style={{ border: "none", outline: "none", fontSize: 13, width: "100%", background: "transparent" }}
                />
              </div>
              <button className="primary-button" style={{ fontSize: 13 }} onClick={searchStudent} disabled={loadingStudent}>
                <Search size={14} /> {loadingStudent ? "搜索中..." : "搜索"}
              </button>
            </div>

            {error && <div style={{ color: "var(--brand)", fontSize: 13 }}>{error}</div>}

            {student ? (
              <div style={{ display: "flex", gap: 20, flex: 1, minHeight: 0 }}>
                {/* Left: answer card preview */}
                <div style={{
                  width: 340, flexShrink: 0, border: "1px solid var(--line)", borderRadius: 10,
                  background: "#fff", display: "flex", flexDirection: "column", overflow: "hidden"
                }}>
                  <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--line)", fontSize: 12, fontWeight: 500 }}>
                    答题卡 — {student.student.name}
                  </div>
                  <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 8, padding: 20 }}>
                    {previewScans.length > 0 ? (
                      <>
                        <div style={{ fontSize: 13 }}>{previewScans.length} 页扫描</div>
                        <button className="primary-button" style={{ fontSize: 12 }} onClick={() => setShowCardPreview(true)}>
                          查看答题卡
                        </button>
                      </>
                    ) : (
                      <div style={{ color: "var(--muted)", fontSize: 13 }}>暂无扫描图片</div>
                    )}
                  </div>
                </div>

                {/* Right: score editing panel */}
                <div style={{ flex: 1, overflowY: "auto", border: "1px solid var(--line)", borderRadius: 10, background: "#fff" }}>
                  <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--line)", fontSize: 12, fontWeight: 500, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span>
                      {student.student.name} · {student.student.studentNumber}
                      {student.totalScore?.manuallyModified && (
                        <span style={{ color: "var(--brand)", fontSize: 11, marginLeft: 8 }}>(已手动修改)</span>
                      )}
                    </span>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      {saveMsg && <span style={{ fontSize: 11, color: saveMsg.includes("成功") ? "#2E7D32" : "var(--brand)" }}>{saveMsg}</span>}
                      <button className="primary-button" style={{ fontSize: 12 }} onClick={saveScoreEdits} disabled={saving || Object.keys(scoreEdits).length === 0}>
                        <Save size={12} /> {saving ? "保存中..." : "保存修改"}
                      </button>
                    </div>
                  </div>
                  <div style={{ padding: 12 }}>
                    {student.totalScore && (
                      <div style={{ display: "flex", gap: 16, marginBottom: 12, fontSize: 13 }}>
                        <span>客观题: <strong>{student.totalScore.objectiveScore}</strong></span>
                        <span>主观题: <strong>{student.totalScore.subjectiveScore}</strong></span>
                        <span>总分: <strong>{student.totalScore.totalScore}</strong></span>
                        {student.totalScore.assignedScore != null && (
                          <span>赋分: <strong>{student.totalScore.assignedScore}</strong></span>
                        )}
                      </div>
                    )}
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                      <thead>
                        <tr style={{ borderBottom: "2px solid var(--line)", textAlign: "left", fontSize: 12, color: "var(--text-secondary)" }}>
                          <th style={{ padding: "6px 8px" }}>题号</th>
                          <th style={{ padding: "6px 8px" }}>类型</th>
                          <th style={{ padding: "6px 8px" }}>得分/满分</th>
                          <th style={{ padding: "6px 8px" }}>识别结果</th>
                          <th style={{ padding: "6px 8px" }}>修改分数</th>
                        </tr>
                      </thead>
                      <tbody>
                        {student.questionScores.map((qs, i) => {
                          const isObj = qs.score_type === "objective";
                          const rec = student.recognition[qs.question_number];
                          const currentScore = getScoreEdit(qs.question_number, qs.score_type, qs.score);
                          const isModified = String(qs.question_number) + "_" + qs.score_type in scoreEdits;

                          return (
                            <tr key={i} style={{
                              borderTop: "1px solid var(--line-light)",
                              background: isModified ? "var(--surface-tint)" : (i % 2 === 0 ? "#fff" : "var(--bg-soft)")
                            }}>
                              <td style={{ padding: "6px 8px", fontWeight: 500 }}>{qs.question_number}</td>
                              <td style={{ padding: "6px 8px", fontSize: 11, color: "var(--muted)" }}>
                                {isObj ? (qs.mode === "multiple" ? "多选" : qs.mode === "indeterminate" ? "不定项" : "单选") : "解答"}
                              </td>
                              <td style={{ padding: "6px 8px" }}>
                                <span style={{ fontWeight: qs.manually_modified ? 600 : undefined, color: isModified ? "var(--brand)" : undefined }}>
                                  {currentScore}
                                </span>
                                /{qs.max_score}
                              </td>
                              <td style={{ padding: "6px 8px", fontSize: 11, color: "var(--muted)" }}>
                                {rec ? `选: ${rec.selectedOptions.join(",")}` : "—"}
                              </td>
                              <td style={{ padding: "6px 8px" }}>
                                {isObj ? (
                                  // Objective: dropdown or button grid
                                  (() => {
                                    const step = qs.step || qs.max_score;
                                    const options: number[] = [];
                                    if (qs.mode === "single" || !qs.mode) {
                                      options.push(0, qs.max_score);
                                    } else {
                                      const steps = Math.round(qs.max_score / step);
                                      for (let s = 0; s <= steps; s++) {
                                        options.push(Math.round(s * step * 10) / 10);
                                      }
                                    }
                                    return (
                                      <select
                                        value={currentScore}
                                        onChange={(e) => setScoreEdit(qs.question_number, qs.score_type, Number(e.target.value))}
                                        style={{ fontSize: 12, padding: "2px 6px", borderRadius: 4, border: `1px solid var(--${isModified ? "brand" : "line"}-strong)` }}
                                      >
                                        {options.map((v) => (
                                          <option key={v} value={v}>{v}</option>
                                        ))}
                                      </select>
                                    );
                                  })()
                                ) : (
                                  // Subjective: number input
                                  <input
                                    type="number"
                                    min={0}
                                    max={qs.max_score}
                                    step={0.5}
                                    value={currentScore}
                                    onChange={(e) => setScoreEdit(qs.question_number, qs.score_type, Number(e.target.value))}
                                    style={{ width: 60, fontSize: 12, padding: "2px 6px", borderRadius: 4, border: `1px solid var(--${isModified ? "brand" : "line"}-strong)` }}
                                  />
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            ) : (
              <div style={{ textAlign: "center", color: "var(--muted)", padding: 40 }}>
                请搜索学生考号或姓名后开始修改分数
              </div>
            )}
          </>
        )}

        {/* Answer modification mode */}
        {mode === "answer" && (
          <div style={{ display: "flex", gap: 20, flex: 1, minHeight: 0 }}>
            {/* Left: card preview placeholder */}
            <div style={{
              width: 300, flexShrink: 0, border: "1px solid var(--line)", borderRadius: 10,
              background: "#fff", display: "flex", flexDirection: "column", overflow: "hidden"
            }}>
              <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--line)", fontSize: 12, fontWeight: 500 }}>
                答题卡预览
              </div>
              <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, color: "var(--muted)" }}>
                请在下表中修改答案
              </div>
            </div>

            {/* Right: answer editor */}
            <div style={{ flex: 1, overflowY: "auto", border: "1px solid var(--line)", borderRadius: 10, background: "#fff" }}>
              <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--line)", fontSize: 12, fontWeight: 500, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>标准答案编辑</span>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  {saveMsg && <span style={{ fontSize: 11, color: saveMsg.includes("成功") ? "#2E7D32" : "var(--brand)" }}>{saveMsg}</span>}
                  <button className="primary-button" style={{ fontSize: 12 }} onClick={saveAnswerEdits} disabled={saving || Object.keys(answerEdits).length === 0}>
                    <Save size={12} /> {saving ? "保存并重算..." : "保存并重算全部分数"}
                  </button>
                </div>
              </div>
              <div style={{ padding: 12 }}>
                {loadingAnswers ? (
                  <div style={{ textAlign: "center", padding: 40, color: "var(--muted)" }}>加载答案配置...</div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    {cardAnswers.filter((q) => q.questionType === "objective").map((q) => {
                      const currentKey = getAnswerEdit(q.questionNumber, q.answerKey ?? []);
                      const isMulti = q.mode === "multiple" || q.mode === "indeterminate";
                      return (
                        <div key={q.questionNumber} style={{
                          display: "flex", alignItems: "center", gap: 12,
                          padding: "10px 12px", borderRadius: 8,
                          background: "var(--bg-soft)", border: "1px solid var(--line)"
                        }}>
                          <div style={{ fontWeight: 500, fontSize: 14, minWidth: 40 }}>
                            第{q.questionNumber}题
                          </div>
                          <div style={{ fontSize: 11, color: "var(--muted)", minWidth: 50 }}>
                            {isMulti ? "多选" : "单选"} · {q.optionCount}选项 · {q.score}分
                          </div>
                          <div style={{ display: "flex", gap: 4, flex: 1 }}>
                            {OPTION_LABELS.slice(0, q.optionCount ?? 4).map((opt) => {
                              const selected = currentKey.includes(opt);
                              return (
                                <button
                                  key={opt}
                                  onClick={() => {
                                    if (!answerEdits[String(q.questionNumber)]) initAnswerFromCard(q.questionNumber, q.answerKey ?? []);
                                    toggleOption(q.questionNumber, opt, isMulti);
                                  }}
                                  style={{
                                    width: 36, height: 36, borderRadius: 6,
                                    border: `2px solid ${selected ? "var(--brand)" : "var(--line)"}`,
                                    background: selected ? "var(--brand)" : "#fff",
                                    color: selected ? "#fff" : "var(--text-primary)",
                                    fontWeight: 600, cursor: "pointer", fontSize: 14,
                                    transition: "all 0.15s"
                                  }}
                                >
                                  {opt}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                    {cardAnswers.filter((q) => q.questionType === "subjective").length > 0 && (
                      <div style={{ color: "var(--muted)", fontSize: 12, padding: "8px 0" }}>
                        主观题答案需在「个别改分」模式中手动输入。
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Card preview modal */}
      {showCardPreview && student && (
        <div
          className="pdf-modal-backdrop"
          style={{ position: "fixed", inset: 0, zIndex: 99999, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={() => setShowCardPreview(false)}
        >
          <div
            className="pdf-modal-card"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: "90vw", maxHeight: "90vh", overflowY: "auto", background: "#fff", borderRadius: 12, padding: 16 }}
          >
            <div className="pdf-modal-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <div>
                <h3 style={{ margin: 0, fontSize: 16 }}>答题卡 — {student.student.name}</h3>
                <span style={{ fontSize: 12, color: "var(--muted)" }}>{previewScans.length} 页</span>
              </div>
              <button onClick={() => setShowCardPreview(false)} style={{ border: "none", background: "none", cursor: "pointer" }}>
                <X size={20} />
              </button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 16, alignItems: "center" }}>
              {previewScans.map((s, idx) => (
                <div key={idx}>
                  <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 4 }}>第 {s.pageNum} 页</div>
                  <img
                    src={`/api/scanner/scan-image/${s.recordId}`}
                    alt={`第 ${s.pageNum} 页`}
                    style={{ maxWidth: "100%", maxHeight: "70vh", border: "1px solid var(--line)", borderRadius: 4 }}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const headerBtnStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 4,
  padding: "6px 12px", border: "1px solid var(--line)", borderRadius: 8,
  background: "#fff", cursor: "pointer", fontSize: 13, color: "var(--text-primary)"
};

const modeToggleStyle: React.CSSProperties = {
  padding: "6px 14px", border: "none", cursor: "pointer", fontSize: 12, fontWeight: 500
};
