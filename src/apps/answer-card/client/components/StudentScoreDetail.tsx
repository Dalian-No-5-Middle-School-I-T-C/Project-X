import { useEffect, useState } from "react";
import { ArrowLeft, ChevronLeft, ChevronRight, X, ZoomIn, ZoomOut } from "lucide-react";
import { createPortal } from "react-dom";
import { fetchJson } from "../auth/api";
import type { AnswerBlockCrop } from "../../../../shared/types";

interface Props {
  examId: number;
  studentId: number;
  studentName: string;
  studentNumber: string;
  examName: string;
  onBack: () => void;
}

interface ClassQStat { avgScore: number; maxScore: number; count: number }

interface StudentScore {
  student: { id: number; name: string; studentNumber: string };
  totalScore: { objectiveScore: number; subjectiveScore: number; totalScore: number; manuallyModified: boolean } | null;
  questionScores: Array<{
    id: number; question_number: number; score_type: string;
    score: number; max_score: number;
    mode: string; optionCount: number; blockType: string;
    manually_modified: number;
  }>;
  classQuestionStats: Record<number, ClassQStat>;
  scans: Array<{ recordId: number; fileName: string; pageNum: number }>;
  answerBlocks: AnswerBlockCrop[];
  cardId: string;
}

export function StudentScoreDetail({ examId, studentId, studentName, studentNumber, examName, onBack }: Props) {
  const [data, setData] = useState<StudentScore | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [enlargeIdx, setEnlargeIdx] = useState(-1);
  const [zoom, setZoomState] = useState(1);
  const [activeImageId, setActiveImageId] = useState("");

  useEffect(() => {
    setLoading(true);
    fetchJson<StudentScore>(`/api/exams/${examId}/student/${studentId}/scores`)
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : "加载失败"))
      .finally(() => setLoading(false));
  }, [examId, studentId]);

  const objScores = data?.questionScores.filter((q) => q.score_type === "objective") ?? [];
  const subjScores = data?.questionScores.filter((q) => q.score_type === "subjective") ?? [];

  // Class-level aggregate rates
  const cs = data?.classQuestionStats ?? {};
  const classObjTotal = objScores.reduce((s, q) => s + (cs[q.question_number]?.avgScore ?? 0), 0);
  const classObjMax = objScores.reduce((s, q) => s + (cs[q.question_number]?.maxScore ?? q.max_score), 0);
  const classSubjTotal = subjScores.reduce((s, q) => s + (cs[q.question_number]?.avgScore ?? 0), 0);
  const classSubjMax = subjScores.reduce((s, q) => s + (cs[q.question_number]?.maxScore ?? q.max_score), 0);
  const classObjRate = classObjMax > 0 ? Math.round(classObjTotal / classObjMax * 100) : 0;
  const classSubjRate = classSubjMax > 0 ? Math.round(classSubjTotal / classSubjMax * 100) : 0;

  const zm = (d: number) => setZoomState((z) => Math.min(3, Math.max(0.5, z + d)));

  if (loading) return <div style={{ padding: 40, textAlign: "center", color: "var(--muted)" }}>加载中...</div>;
  if (error) return <div style={{ padding: 40, textAlign: "center", color: "var(--brand)" }}>{error}</div>;
  if (!data) return null;

  const answerBlocks = data.answerBlocks ?? [];
  const imageItems = answerBlocks.length > 0
    ? answerBlocks.map((block) => ({
        id: block.id,
        title: `${block.blockTitle || "大题"} · 第 ${block.pageNumber} 页`,
        subtitle: `题号 ${block.questionNumbers.join(", ")}${block.score != null && block.maxScore != null ? ` · ${block.score}/${block.maxScore}` : ""}`,
        imageUrl: block.imageUrl
      }))
    : data.scans.map((scan) => ({
        id: String(scan.recordId),
        title: `第 ${scan.pageNum} 页`,
        subtitle: "整页答题卡",
        imageUrl: `/api/scanner/grading-image/${data.cardId}/${encodeURIComponent(scan.fileName)}`
      }));

  function blockForQuestion(questionNumber: number): AnswerBlockCrop | undefined {
    return answerBlocks.find((block) => block.questionNumbers.some((item) => String(item) === String(questionNumber)));
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 24px", borderBottom: "1px solid var(--line)", background: "var(--surface)", flexShrink: 0 }}>
        <button onClick={onBack} style={backBtn}>
          <ArrowLeft size={16} /> 返回成绩表
        </button>
        <div style={{ flex: 1 }}>
          <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>{studentName} · {studentNumber}</h2>
          <span style={{ fontSize: 12, color: "var(--muted)" }}>{examName}</span>
        </div>
        {data.totalScore && (
          <div style={{ display: "flex", gap: 16, fontSize: 13 }}>
            <span>客观: <strong>{data.totalScore.objectiveScore}</strong></span>
            <span>主观: <strong>{data.totalScore.subjectiveScore}</strong></span>
            <span style={{ fontSize: 15, fontWeight: 700, color: "var(--brand)" }}>{data.totalScore.totalScore}</span>
          </div>
        )}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: "auto", padding: 24, display: "flex", gap: 20, minHeight: 0 }}>
        {/* Left: scores */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ border: "1px solid var(--line)", borderRadius: 10, background: "var(--surface)", overflow: "hidden", marginBottom: 16 }}>
            <div style={{ padding: "8px 14px", borderBottom: "1px solid var(--line)", fontSize: 13, fontWeight: 500 }}>逐题得分</div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--line)", textAlign: "left", fontSize: 12, color: "var(--text-secondary)" }}>
                    <th style={s_th}>题号</th><th style={s_th}>类型</th><th style={s_th}>得分/满分</th><th style={s_th}>班级得分率</th>
                  </tr>
                </thead>
                <tbody>
                  {data.questionScores.map((q, i) => {
                    const stat = cs[q.question_number];
                    const classRate = stat && stat.maxScore > 0 ? Math.round(stat.avgScore / stat.maxScore * 100) : 0;
                    const perfect = q.score >= q.max_score;
                    const zero = q.score === 0;
                    return (
                      <tr
                        key={i}
                        onClick={() => {
                          const block = blockForQuestion(q.question_number);
                          if (block) setActiveImageId(block.id);
                        }}
                        style={{
                          borderTop: "1px solid var(--line-light)",
                          background: q.manually_modified ? "var(--surface-tint)" : i % 2 === 0 ? "var(--surface)" : "var(--bg-soft)",
                          cursor: answerBlocks.length > 0 ? "pointer" : "default"
                        }}
                      >
                        <td style={s_td}>{q.question_number}</td>
                        <td style={{ ...s_td, fontSize: 11, color: "var(--muted)" }}>
                          {q.score_type === "objective" ? (q.mode === "multiple" ? "多选" : "单选") : "解答"}
                        </td>
                        <td style={s_td}>
                          <span style={{ fontWeight: 600, color: perfect ? "#2E7D32" : zero ? "var(--brand)" : "var(--text-primary)" }}>
                            {q.score}
                          </span>/{q.max_score}
                          {q.manually_modified ? <span style={{ fontSize: 10, color: "var(--brand)", marginLeft: 4 }}>改</span> : null}
                        </td>
                        <td style={s_td}>
                          {stat ? (
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <div style={{ flex: 1, height: 6, borderRadius: 3, background: "var(--line-light)", overflow: "hidden", maxWidth: 100 }}>
                                <div style={{ height: "100%", borderRadius: 3, background: classRate >= 80 ? "#2E7D32" : classRate >= 60 ? "#E65100" : "var(--brand)", width: `${classRate}%`, transition: "width 0.3s" }} />
                              </div>
                              <span style={{ fontSize: 11, minWidth: 40 }}>{stat.avgScore}/{stat.maxScore} ({classRate}%)</span>
                            </div>
                          ) : <span style={{ color: "var(--muted)" }}>—</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Class rate bars */}
          <div style={{ display: "flex", gap: 12 }}>
            <div style={{ flex: 1, padding: 12, border: "1px solid var(--line)", borderRadius: 10, background: "var(--surface)" }}>
              <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 6 }}>
                选择题 <strong>班级均分率 {classObjRate}%</strong> ({objScores.length}题)
              </div>
              <div style={{ height: 10, borderRadius: 5, background: "var(--line-light)", overflow: "hidden" }}>
                <div style={{ height: "100%", borderRadius: 5, background: classObjRate >= 80 ? "#2E7D32" : classObjRate >= 60 ? "#E65100" : "var(--brand)", width: `${classObjRate}%`, transition: "width 0.5s" }} />
              </div>
            </div>
            {subjScores.length > 0 && (
              <div style={{ flex: 1, padding: 12, border: "1px solid var(--line)", borderRadius: 10, background: "var(--surface)" }}>
                <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 6 }}>
                  解答题 <strong>班级均分率 {classSubjRate}%</strong> ({subjScores.length}题)
                </div>
                <div style={{ height: 10, borderRadius: 5, background: "var(--line-light)", overflow: "hidden" }}>
                  <div style={{ height: "100%", borderRadius: 5, background: classSubjRate >= 80 ? "#2E7D32" : classSubjRate >= 60 ? "#E65100" : "var(--brand)", width: `${classSubjRate}%`, transition: "width 0.5s" }} />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right: card images */}
        <div style={{ width: 340, flexShrink: 0, border: "1px solid var(--line)", borderRadius: 10, background: "var(--surface)", display: "flex", flexDirection: "column", maxHeight: "calc(100vh - 140px)" }}>
          <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--line)", fontSize: 12, fontWeight: 500, flexShrink: 0 }}>
            {answerBlocks.length > 0 ? "大题作答图片" : "答题卡"}
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            {imageItems.length > 0 ? (
              imageItems.map((item, idx) => (
                <button key={idx}
                  onClick={() => { setActiveImageId(item.id); setEnlargeIdx(idx); }}
                  style={{
                    display: "block", width: "100%", border: "none", background: "transparent",
                    cursor: "zoom-in", padding: 0, textAlign: "left", margin: 0
                  }}
                >
                  <div style={{ fontSize: 11, color: item.id === activeImageId ? "var(--brand)" : "var(--muted)", marginBottom: 4 }}>{item.title} · {item.subtitle}</div>
                  <img src={item.imageUrl} alt={item.title}
                    style={{ width: "100%", border: `1px solid ${item.id === activeImageId ? "var(--brand)" : "var(--line-light)"}`, borderRadius: 4, display: "block" }}
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
                </button>
              ))
            ) : (
              <div style={{ color: "var(--muted)", fontSize: 13, textAlign: "center", padding: 40 }}>暂无扫描</div>
            )}
          </div>
        </div>
      </div>

      {/* Enlarge modal */}
      {enlargeIdx >= 0 && (() => {
        const cur = imageItems[enlargeIdx];
        const hasPrev = enlargeIdx > 0;
        const hasNext = enlargeIdx < imageItems.length - 1;
        return createPortal(
          <div style={{ position: "fixed", inset: 0, zIndex: 999999, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setEnlargeIdx(-1)}>
            <div onClick={(e) => e.stopPropagation()} style={{ background: "#1a1a1a", borderRadius: 14, width: "94vw", maxHeight: "94vh", display: "flex", flexDirection: "column" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 16px", color: "#fff", flexShrink: 0 }}>
                <span style={{ fontSize: 14, fontWeight: 500 }}>{cur.title} / 共 {imageItems.length} 张</span>
                <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                  <button onClick={() => zm(-0.25)} style={zmBtn} title="缩小"><ZoomOut size={18} /></button>
                  <button onClick={() => zm(0.25)} style={zmBtn} title="放大"><ZoomIn size={18} /></button>
                  <span style={{ fontSize: 12, minWidth: 40, textAlign: "center" }}>{Math.round(zoom * 100)}%</span>
                  <button onClick={() => setEnlargeIdx(-1)} style={{ ...zmBtn, marginLeft: 4 }}><X size={18} /></button>
                </div>
              </div>
              <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", overflow: "auto", position: "relative", padding: "0 48px" }}>
                {hasPrev && <button onClick={() => { setEnlargeIdx(enlargeIdx - 1); setZoomState(1); }} style={arrowBtn("left")}><ChevronLeft size={28} /></button>}
                <img src={cur.imageUrl} alt="" style={{ maxWidth: "100%", maxHeight: "calc(94vh - 120px)", objectFit: "contain", transform: `scale(${zoom})`, transformOrigin: "center center", transition: "transform 0.2s" }} />
                {hasNext && <button onClick={() => { setEnlargeIdx(enlargeIdx + 1); setZoomState(1); }} style={arrowBtn("right")}><ChevronRight size={28} /></button>}
              </div>
              <div style={{ display: "flex", justifyContent: "center", gap: 6, padding: "8px 16px 12px", overflowX: "auto", flexShrink: 0 }}>
                {imageItems.map((item, idx) => (
                  <button key={idx} onClick={() => { setEnlargeIdx(idx); setZoomState(1); }}
                    style={{ padding: 0, border: idx === enlargeIdx ? "2px solid #fff" : "2px solid transparent", borderRadius: 4, cursor: "pointer", opacity: idx === enlargeIdx ? 1 : 0.5, background: "transparent" }}>
                    <img src={item.imageUrl} alt="" style={{ width: 40, height: 56, objectFit: "cover", borderRadius: 2 }} />
                  </button>
                ))}
              </div>
            </div>
          </div>,
          document.body
        );
      })()}
    </div>
  );
}

const backBtn: React.CSSProperties = { display: "flex", alignItems: "center", gap: 4, padding: "6px 12px", border: "1px solid var(--line)", borderRadius: 8, background: "var(--surface)", cursor: "pointer", fontSize: 13 };
const s_th: React.CSSProperties = { padding: "6px 10px", fontWeight: 600 };
const s_td: React.CSSProperties = { padding: "6px 10px" };
const zmBtn: React.CSSProperties = { border: "none", background: "rgba(255,255,255,0.1)", borderRadius: 6, width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "#fff" };
function arrowBtn(side: "left" | "right"): React.CSSProperties {
  return { position: "absolute", [side]: 4, top: "50%", transform: "translateY(-50%)", zIndex: 1, background: "rgba(255,255,255,0.12)", border: "none", borderRadius: "50%", width: 44, height: 44, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "#fff" };
}
