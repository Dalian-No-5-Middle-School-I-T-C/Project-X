import { useEffect, useState } from "react";
import { ArrowLeft, ChevronLeft, ChevronRight, Pencil, Save, Search, X, ZoomIn, ZoomOut } from "lucide-react";
import { fetchJson } from "../auth/api";

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
  scans: Array<{ recordId: number; fileName: string; pageNum: number }>;
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

interface StudentHit {
  id: number;
  name: string;
  studentNumber: string;
}

const OPTION_LABELS = ["A","B","C","D","E","F","G","H","I","J"];

export function ScoreFixPage({ examId, examName, onBack }: Props) {
  // Mode selection first
  const [fixMode, setFixMode] = useState<FixMode | null>(null);

  // Score mode
  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<StudentHit[]>([]);
  const [searchMsg, setSearchMsg] = useState("");
  const [student, setStudent] = useState<StudentScore | null>(null);
  const [loadingStudent, setLoadingStudent] = useState(false);
  const [scoreEdits, setScoreEdits] = useState<Record<string, number>>({});
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");

  // Answer mode
  const [cardAnswers, setCardAnswers] = useState<CardAnswer[]>([]);
  const [answerEdits, setAnswerEdits] = useState<Record<string, string[]>>({});
  const [loadingAnswers, setLoadingAnswers] = useState(false);

  // Preview
  const [previewPages, setPreviewPages] = useState<Array<{ recordId: number; fileName: string; pageNum: number }>>([]);
  const [enlargeIdx, setEnlargeIdx] = useState(-1); // -1 = closed, >=0 = active page index
  const [zoom, setZoomState] = useState(1);

  // Load answers when entering answer mode
  useEffect(() => {
    if (fixMode === "answer" && cardAnswers.length === 0) {
      setLoadingAnswers(true);
      setSaveMsg("");
      fetchJson<{ questions: CardAnswer[]; cardId: string }>(`/api/exams/${examId}/answers`)
        .then((data) => {
          setCardAnswers(data.questions);
          setAnswerEdits({});
        })
        .catch((err) => setSaveMsg(err instanceof Error ? err.message : "加载答案失败"))
        .finally(() => setLoadingAnswers(false));
    }
  }, [fixMode, examId]);

  async function searchStudent() {
    if (!search.trim()) return;
    setSearchMsg("");
    setHits([]);
    setStudent(null);

    try {
      const data = await fetchJson<StudentHit[]>(
        `/api/exams/${examId}/students/search?q=${encodeURIComponent(search.trim())}`
      );
      setHits(data);
      if (data.length === 0) setSearchMsg("未找到该学生，请检查考号或姓名");
    } catch (err) {
      setSearchMsg(err instanceof Error ? err.message : "搜索失败");
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") searchStudent();
  }

  async function loadStudent(sid: number, sname: string, snum: string) {
    setLoadingStudent(true);
    setSearchMsg("");
    setScoreEdits({});
    try {
      const data = await fetchJson<StudentScore>(`/api/exams/${examId}/student/${sid}/scores`);
      // Ensure student info matches the hit
      data.student = { id: sid, name: sname, studentNumber: snum };
      setStudent(data);
      setPreviewPages(data.scans);
    } catch (err) {
      setSearchMsg(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoadingStudent(false);
    }
  }

  function setScoreEdit(qNum: number, scoreType: string, val: number) {
    setScoreEdits((prev) => ({ ...prev, [`${qNum}_${scoreType}`]: val }));
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
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scores: updates })
      });
      setSaveMsg("保存成功！已自动更新排名");
      setScoreEdits({});
      const data = await fetchJson<StudentScore>(`/api/exams/${examId}/student/${student.student.id}/scores`);
      data.student = student.student;
      setStudent(data);
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
      if (!isMulti) return { ...prev, [key]: [opt] };
      const idx = current.indexOf(opt);
      if (idx >= 0) current.splice(idx, 1);
      else current.push(opt);
      return { ...prev, [key]: current };
    });
  }

  function getAnswerEdit(qNum: number, defaultKey: string[]): string[] {
    return answerEdits[String(qNum)] ?? defaultKey;
  }

  function initFromCard(qNum: number, answerKey: string[]) {
    if (String(qNum) in answerEdits) return;
    setAnswerEdits((prev) => ({ ...prev, [String(qNum)]: [...answerKey] }));
  }

  async function saveAnswerEdits() {
    if (Object.keys(answerEdits).length === 0) { setSaveMsg("没有修改答案"); return; }
    setSaving(true);
    setSaveMsg("");
    try {
      const resp = await fetchJson<{ ok: boolean; updatedCount: number }>(`/api/exams/${examId}/answers`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
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

  // ======== RENDER ========

  // Mode selection screen
  if (!fixMode) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 24px", borderBottom: "1px solid var(--line)", background: "#fff", flexShrink: 0 }}>
          <button onClick={onBack} style={headerBtnStyle}><ArrowLeft size={16} /> 返回成绩</button>
          <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>成绩修改 — {examName}</h2>
        </div>
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 24 }}>
          <button
            onClick={() => setFixMode("score")}
            style={{
              width: 240, height: 160, borderRadius: 16, border: "2px solid var(--line)",
              background: "#fff", cursor: "pointer",
              display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12,
              transition: "border-color 0.2s, box-shadow 0.2s"
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--brand)"; (e.currentTarget as HTMLElement).style.boxShadow = "0 0 0 3px var(--brand-glow)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--line)"; (e.currentTarget as HTMLElement).style.boxShadow = "none"; }}
          >
            <Pencil size={36} color="var(--brand)" />
            <div style={{ fontSize: 15, fontWeight: 600 }}>个别改分</div>
            <div style={{ fontSize: 12, color: "var(--muted)", textAlign: "center", padding: "0 12px" }}>
              搜索学生 → 逐题修改分数
            </div>
          </button>
          <button
            onClick={() => setFixMode("answer")}
            style={{
              width: 240, height: 160, borderRadius: 16, border: "2px solid var(--line)",
              background: "#fff", cursor: "pointer",
              display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12,
              transition: "border-color 0.2s, box-shadow 0.2s"
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--brand)"; (e.currentTarget as HTMLElement).style.boxShadow = "0 0 0 3px var(--brand-glow)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--line)"; (e.currentTarget as HTMLElement).style.boxShadow = "none"; }}
          >
            <Save size={36} color="var(--brand)" />
            <div style={{ fontSize: 15, fontWeight: 600 }}>修改答案</div>
            <div style={{ fontSize: 12, color: "var(--muted)", textAlign: "center", padding: "0 12px" }}>
              修改正确答案 → 自动重算全部分数
            </div>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 24px", borderBottom: "1px solid var(--line)", background: "#fff", flexShrink: 0 }}>
        <button onClick={() => { if (student) { setStudent(null); setHits([]); setSearch(""); setSearchMsg(""); setScoreEdits({}); } else if (fixMode === "answer") { setFixMode(null); } else { setFixMode(null); } }} style={headerBtnStyle}><ArrowLeft size={16} /></button>
        <div style={{ flex: 1 }}>
          <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>成绩修改 — {examName}</h2>
        </div>
        <div style={{ display: "flex", borderRadius: 8, border: "1px solid var(--line)", overflow: "hidden" }}>
          <button onClick={() => { setFixMode("score"); setStudent(null); setHits([]); setSearch(""); }} style={{ ...modeToggleStyle, background: fixMode === "score" ? "var(--brand)" : "#fff", color: fixMode === "score" ? "#fff" : "var(--text-primary)" }}>个别改分</button>
          <button onClick={() => setFixMode("answer")} style={{ ...modeToggleStyle, background: fixMode === "answer" ? "var(--brand)" : "#fff", color: fixMode === "answer" ? "#fff" : "var(--text-primary)" }}>修改答案</button>
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: "auto", padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
        {/* ============== SCORE MODE ============== */}
        {fixMode === "score" && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, background: "#fff", border: "1px solid var(--line)", borderRadius: 8, padding: "6px 12px", flex: 1, maxWidth: 360 }}>
                <Search size={14} style={{ color: "var(--muted)", flexShrink: 0 }} />
                <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={handleKeyDown}
                  placeholder="输入考号或姓名搜索..."
                  style={{ border: "none", outline: "none", fontSize: 13, width: "100%", background: "transparent" }} />
              </div>
              <button className="primary-button" style={{ fontSize: 13 }} onClick={searchStudent} disabled={loadingStudent}>
                <Search size={14} /> 搜索
              </button>
            </div>

            {searchMsg && <div style={{ color: searchMsg.includes("未找到") ? "var(--muted)" : "var(--brand)", fontSize: 13 }}>{searchMsg}</div>}

            {/* Search results */}
            {hits.length > 0 && !student && (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {hits.map((h) => (
                  <button key={h.id}
                    onClick={() => loadStudent(h.id, h.name, h.studentNumber)}
                    style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 14px", borderRadius: 8, border: "1px solid var(--line)", background: "#fff", cursor: "pointer", textAlign: "left", fontSize: 13 }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--surface-tint)"; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "#fff"; }}
                  >
                    <span style={{ fontWeight: 500 }}>{h.name}</span>
                    <span style={{ color: "var(--muted)", fontSize: 12 }}>考号 {h.studentNumber}</span>
                  </button>
                ))}
              </div>
            )}

            {loadingStudent && <div style={{ textAlign: "center", color: "var(--muted)", padding: 40 }}>加载学生数据...</div>}

            {student && (
              <div style={{ display: "flex", gap: 20, flex: 1, minHeight: 0 }}>
                {/* Left: card image — scrolls vertically */}
                <div style={{ width: 360, flexShrink: 0, border: "1px solid var(--line)", borderRadius: 10, background: "#fff", display: "flex", flexDirection: "column", overflow: "hidden" }}>
                  <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--line)", fontSize: 12, fontWeight: 500, flexShrink: 0 }}>答题卡 — {student.student.name}</div>
                  <div style={{ flex: 1, overflowY: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                    {previewPages.length > 0 ? (
                      previewPages.map((s, idx) => (
                        <div key={idx} style={{ cursor: "zoom-in" }} onClick={() => setEnlargeIdx(idx)}>
                          <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 4 }}>
                            第 {s.pageNum} 页
                          </div>
                          <img
                            src={`/api/scanner/grading-image/${student.cardId}/${encodeURIComponent(s.fileName)}`}
                            alt={`第${s.pageNum}页`}
                            style={{ width: "100%", border: "1px solid var(--line-light)", borderRadius: 4 }}
                            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                          />
                        </div>
                      ))
                    ) : (
                      <div style={{ color: "var(--muted)", fontSize: 13, textAlign: "center", padding: 40 }}>暂无扫描图片</div>
                    )}
                  </div>
                </div>

                {/* Right: scores */}
                <div style={{ flex: 1, overflowY: "auto", border: "1px solid var(--line)", borderRadius: 10, background: "#fff" }}>
                  <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--line)", fontSize: 12, fontWeight: 500, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span>{student.student.name} · {student.student.studentNumber}
                      {student.totalScore?.manuallyModified && <span style={{ color: "var(--brand)", fontSize: 11, marginLeft: 8 }}>(已手动修改)</span>}
                    </span>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      {saveMsg && <span style={{ fontSize: 11, color: saveMsg.includes("成功") ? "#2E7D32" : "var(--brand)" }}>{saveMsg}</span>}
                      <button className="primary-button" style={{ fontSize: 12 }} onClick={saveScoreEdits} disabled={saving || Object.keys(scoreEdits).length === 0}>
                        <Save size={12} /> {saving ? "保存..." : "保存修改"}
                      </button>
                    </div>
                  </div>
                  <div style={{ padding: 12 }}>
                    {student.totalScore && (
                      <div style={{ display: "flex", gap: 16, marginBottom: 12, fontSize: 13 }}>
                        <span>客观题: <strong>{student.totalScore.objectiveScore}</strong></span>
                        <span>主观题: <strong>{student.totalScore.subjectiveScore}</strong></span>
                        <span>总分: <strong>{student.totalScore.totalScore}</strong></span>
                        {student.totalScore.assignedScore != null && <span>赋分: <strong>{student.totalScore.assignedScore}</strong></span>}
                      </div>
                    )}
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                      <thead>
                        <tr style={{ borderBottom: "2px solid var(--line)", textAlign: "left", fontSize: 12, color: "var(--text-secondary)" }}>
                          <th style={{ padding: "6px 8px" }}>题号</th><th style={{ padding: "6px 8px" }}>类型</th><th style={{ padding: "6px 8px" }}>得分/满分</th><th style={{ padding: "6px 8px" }}>识别</th><th style={{ padding: "6px 8px" }}>修改</th>
                        </tr>
                      </thead>
                      <tbody>
                        {student.questionScores.map((qs, i) => {
                          const isObj = qs.score_type === "objective";
                          const rec = student.recognition[qs.question_number];
                          const cur = getScoreEdit(qs.question_number, qs.score_type, qs.score);
                          const modified = `${qs.question_number}_${qs.score_type}` in scoreEdits;
                          return (
                            <tr key={i} style={{ borderTop: "1px solid var(--line-light)", background: modified ? "var(--surface-tint)" : (i % 2 === 0 ? "#fff" : "var(--bg-soft)") }}>
                              <td style={{ padding: "6px 8px", fontWeight: 500 }}>{qs.question_number}</td>
                              <td style={{ padding: "6px 8px", fontSize: 11, color: "var(--muted)" }}>{isObj ? (qs.mode === "multiple" ? "多选" : qs.mode === "indeterminate" ? "不定" : "单选") : "解答"}</td>
                              <td style={{ padding: "6px 8px" }}><span style={{ fontWeight: qs.manually_modified ? 600 : undefined, color: modified ? "var(--brand)" : undefined }}>{cur}</span>/{qs.max_score}</td>
                              <td style={{ padding: "6px 8px", fontSize: 11, color: "var(--muted)" }}>{rec ? rec.selectedOptions.join(",") : "—"}</td>
                              <td style={{ padding: "6px 8px" }}>
                                {isObj ? (() => {
                                  const step = qs.step || qs.max_score;
                                  const options: number[] = qs.mode === "single" || !qs.mode ? [0, qs.max_score] : [];
                                  if (qs.mode !== "single" && qs.mode) {
                                    const steps = Math.round(qs.max_score / step);
                                    for (let s = 0; s <= steps; s++) options.push(Math.round(s * step * 10) / 10);
                                  }
                                  return <select value={cur} onChange={(e) => setScoreEdit(qs.question_number, qs.score_type, Number(e.target.value))} style={{ fontSize: 12, padding: "2px 6px", borderRadius: 4, border: `1px solid var(--line-strong)` }}>
                                    {options.map((v) => <option key={v} value={v}>{v}</option>)}
                                  </select>;
                                })() : (
                                  <input type="number" min={0} max={qs.max_score} step={0.5} value={cur} onChange={(e) => setScoreEdit(qs.question_number, qs.score_type, Number(e.target.value))} style={{ width: 60, fontSize: 12, padding: "2px 6px", borderRadius: 4, border: "1px solid var(--line-strong)" }} />
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
            )}
          </>
        )}

        {/* ============== ANSWER MODE ============== */}
        {fixMode === "answer" && (
          <div style={{ flex: 1, overflowY: "auto", border: "1px solid var(--line)", borderRadius: 10, background: "#fff" }}>
            <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--line)", fontSize: 12, fontWeight: 500, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>标准答案编辑</span>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {saveMsg && <span style={{ fontSize: 11, color: saveMsg.includes("成功") ? "#2E7D32" : "var(--brand)" }}>{saveMsg}</span>}
                <button className="primary-button" style={{ fontSize: 12 }} onClick={saveAnswerEdits} disabled={saving || Object.keys(answerEdits).length === 0}>
                  <Save size={12} /> {saving ? "重算中..." : "保存并重算"}
                </button>
              </div>
            </div>
            <div style={{ padding: 12 }}>
              {loadingAnswers ? (
                <div style={{ textAlign: "center", padding: 40, color: "var(--muted)" }}>加载答案...</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {cardAnswers.filter((q) => q.questionType === "objective").map((q) => {
                    const cur = getAnswerEdit(q.questionNumber, q.answerKey ?? []);
                    const isMulti = q.mode === "multiple" || q.mode === "indeterminate";
                    const changed = String(q.questionNumber) in answerEdits;
                    return (
                      <div key={q.questionNumber} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", borderRadius: 8, background: changed ? "var(--surface-tint)" : "var(--bg-soft)", border: `1px solid ${changed ? "var(--brand-glow)" : "var(--line)"}` }}>
                          <div style={{ fontWeight: 500, fontSize: 14, minWidth: 48 }}>第{q.questionNumber}题</div>
                          <div style={{ fontSize: 11, color: "var(--muted)", minWidth: 60 }}>{isMulti ? "多选" : "单选"} · {q.optionCount}选项 · {q.score}分</div>
                          <div style={{ display: "flex", gap: 4, flex: 1 }}>
                            {OPTION_LABELS.slice(0, q.optionCount ?? 4).map((opt) => {
                              const sel = cur.includes(opt);
                              return (
                                <button key={opt} onClick={() => { if (!(String(q.questionNumber) in answerEdits)) initFromCard(q.questionNumber, q.answerKey ?? []); toggleOption(q.questionNumber, opt, isMulti); }}
                                  style={{ width: 36, height: 36, borderRadius: 6, border: `2px solid ${sel ? "var(--brand)" : "var(--line)"}`, background: sel ? "var(--brand)" : "#fff", color: sel ? "#fff" : "var(--text-primary)", fontWeight: 600, cursor: "pointer", fontSize: 14 }}>{opt}</button>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                    {cardAnswers.filter((q) => q.questionType === "subjective").length > 0 && (
                      <div style={{ color: "var(--muted)", fontSize: 12, padding: 8 }}>主观题答案请在「个别改分」模式手动输入。</div>
                    )}
                  </div>
                )}
              </div>
            </div>
        )}
      </div>

      {/* Enlarge image modal — inline fixed to avoid parent overflow:hidden clipping */}
      {enlargeIdx >= 0 && (() => {
        const cur = previewPages[enlargeIdx];
        const hasPrev = enlargeIdx > 0;
        const hasNext = enlargeIdx < previewPages.length - 1;
        const zm = (delta: number) => setZoomState((z) => Math.min(3, Math.max(0.5, z + delta)));
        return (
          <div style={{ position: "fixed", inset: 0, zIndex: 999999, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setEnlargeIdx(-1)}>
            <div onClick={(e) => e.stopPropagation()} style={{ background: "#1a1a1a", borderRadius: 14, width: "94vw", maxHeight: "94vh", display: "flex", flexDirection: "column" }}>
              {/* Header */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 16px", color: "#fff", flexShrink: 0 }}>
                <span style={{ fontSize: 14, fontWeight: 500 }}>第 {cur.pageNum} 页 / 共 {previewPages.length} 页</span>
                <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                  <button onClick={() => zm(-0.25)} style={zmBtnStyle} title="缩小"><ZoomOut size={18} /></button>
                  <button onClick={() => zm(0.25)} style={zmBtnStyle} title="放大"><ZoomIn size={18} /></button>
                  <span style={{ fontSize: 12, minWidth: 40, textAlign: "center" }}>{Math.round(zoom * 100)}%</span>
                  <button onClick={() => setEnlargeIdx(-1)} style={{ ...zmBtnStyle, marginLeft: 4 }}><X size={18} /></button>
                </div>
              </div>
              {/* Image */}
              <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", overflow: "auto", position: "relative", padding: "0 48px" }}>
                {hasPrev && (
                  <button onClick={() => { setEnlargeIdx(enlargeIdx - 1); setZoomState(1); }} style={arrowBtnStyle("left")}>
                    <ChevronLeft size={28} />
                  </button>
                )}
                <img
                  src={`/api/scanner/grading-image/${student!.cardId}/${encodeURIComponent(cur.fileName)}`}
                  alt={`第${cur.pageNum}页`}
                  style={{ maxWidth: `${zoom * 100}%`, maxHeight: `calc(94vh - 120px)`, objectFit: "contain", transition: "max-width 0.2s", transform: `scale(${zoom})`, transformOrigin: "center center" }}
                />
                {hasNext && (
                  <button onClick={() => { setEnlargeIdx(enlargeIdx + 1); setZoomState(1); }} style={arrowBtnStyle("right")}>
                    <ChevronRight size={28} />
                  </button>
                )}
              </div>
              {/* Thumbnails */}
              <div style={{ display: "flex", justifyContent: "center", gap: 6, padding: "8px 16px 12px", overflowX: "auto", flexShrink: 0 }}>
                {previewPages.map((s, idx) => (
                  <button key={idx}
                    onClick={() => { setEnlargeIdx(idx); setZoomState(1); }}
                    style={{ padding: 0, border: idx === enlargeIdx ? "2px solid #fff" : "2px solid transparent", borderRadius: 4, cursor: "pointer", opacity: idx === enlargeIdx ? 1 : 0.5, background: "transparent" }}
                  >
                    <img src={`/api/scanner/grading-image/${student!.cardId}/${encodeURIComponent(s.fileName)}`} alt="" style={{ width: 40, height: 56, objectFit: "cover", borderRadius: 2 }} />
                  </button>
                ))}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

const headerBtnStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 4, padding: "6px 12px", border: "1px solid var(--line)", borderRadius: 8, background: "#fff", cursor: "pointer", fontSize: 13 };
const modeToggleStyle: React.CSSProperties = { padding: "6px 14px", border: "none", cursor: "pointer", fontSize: 12, fontWeight: 500 };
const zmBtnStyle: React.CSSProperties = { border: "none", background: "rgba(255,255,255,0.1)", borderRadius: 6, width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "#fff" };
function arrowBtnStyle(side: "left" | "right"): React.CSSProperties {
  return { position: "absolute", [side]: 4, top: "50%", transform: "translateY(-50%)", zIndex: 1, background: "rgba(255,255,255,0.12)", border: "none", borderRadius: "50%", width: 44, height: 44, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "#fff" };
}
