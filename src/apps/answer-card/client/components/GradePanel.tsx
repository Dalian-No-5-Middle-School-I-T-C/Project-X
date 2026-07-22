import React, { useState, useEffect, useCallback, useRef } from "react";
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut, RotateCw, RotateCcw, PenLine, Save } from "lucide-react";
import { fetchJson, mediaUrl } from "../auth/api";
import { ScorePad } from "./ScorePad";
import { AnnotationOverlay } from "./AnnotationOverlay";
import type { ReviewBlockCropItem, ReviewAnnotation, ReviewSubmitResult } from "../../../../shared/types";

interface Props {
  examId: number;
  blockId: string;
  teacherId: number;
  onBack: () => void;
}

export function GradePanel({ examId, blockId, teacherId, onBack }: Props) {
  const [queue, setQueue] = useState<ReviewBlockCropItem[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  // v1.9.0: 自动检测设备类型：触摸设备(PAD/手机)默认手写，桌面端默认文字批注
  const [annotateMode, setAnnotateMode] = useState<"text" | "drawing" | false>(false);
  const isTouchDevice = typeof window !== "undefined" && ("ontouchstart" in window || navigator.maxTouchPoints > 0);
  const [draftScores, setDraftScores] = useState<Record<string, number>>({});
  const [saving, setSaving] = useState(false);
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const [annotations, setAnnotations] = useState<ReviewAnnotation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const imageRef = useRef<HTMLDivElement>(null);

  const current = queue[currentIndex];
  const currentScore = current ? (draftScores[current.id] ?? current.score ?? 0) : 0;
  const maxScore = current?.maxScore ?? 0;

  // 加载阅卷队列
  const loadQueue = useCallback(async () => {
    try {
      const res = await fetchJson<{ ok: boolean; rows: ReviewBlockCropItem[] }>(
        `/api/review/exams/${examId}/block-crops?blockId=${encodeURIComponent(blockId)}&status=ready`
      );
      if (res.ok) setQueue(res.rows);
    } catch (err: any) { setError(err.message); }
  }, [examId, blockId]);

  // 加载会话
  const loadSession = useCallback(async () => {
    try {
      const res = await fetchJson<{ ok: boolean; data: any }>(
        `/api/review-session/exams/${examId}/blocks/${encodeURIComponent(blockId)}`
      );
      if (res.ok && res.data) {
        setCurrentIndex(res.data.currentIndex ?? 0);
        if (res.data.draftScores) setDraftScores(res.data.draftScores);
        setSessionLoaded(true);
      }
    } catch { /* no session yet */ }
  }, [examId, blockId]);

  // 保存会话
  const saveSession = useCallback(async (idx: number, scores: Record<string, number>) => {
    try {
      await fetchJson(`/api/review-session/exams/${examId}/blocks/${encodeURIComponent(blockId)}`, {
        method: "PUT",
        body: JSON.stringify({
          currentIndex: idx,
          positionJson: { zoom, rotation },
          draftScores: scores,
        }),
      });
    } catch { /* silent */ }
  }, [examId, blockId, zoom, rotation]);

  // 加载批注
  const loadAnnotations = useCallback(async (cropId: string) => {
    try {
      const res = await fetchJson<{ ok: boolean; data: ReviewAnnotation[] }>(
        `/api/review-annotations?cropId=${encodeURIComponent(cropId)}`
      );
      if (res.ok) setAnnotations(res.data);
    } catch { setAnnotations([]); }
  }, []);

  useEffect(() => {
    loadQueue();
    loadSession();
  }, [loadQueue, loadSession]);

  // 当前切块变化时加载批注
  useEffect(() => {
    if (current) loadAnnotations(current.id);
  }, [current?.id, loadAnnotations]);

  // 导航
  const goTo = useCallback((index: number) => {
    const clamped = Math.max(0, Math.min(queue.length - 1, index));
    setCurrentIndex(clamped);
    setZoom(1);
    setRotation(0);
    setAnnotateMode(false);
    saveSession(clamped, draftScores);
  }, [queue.length, draftScores, saveSession]);

  // 分数变化
  const handleScoreChange = useCallback((score: number) => {
    if (!current) return;
    const newScores = { ...draftScores, [current.id]: score };
    setDraftScores(newScores);
  }, [current, draftScores]);

  // 保存并下一份
  const handleSubmit = useCallback(async (scoreOverride?: number) => {
    if (!current || saving) return;
    setSaving(true);
    setError(null);

    try {
      const score = scoreOverride ?? draftScores[current.id] ?? 0;
      const res = await fetchJson<ReviewSubmitResult>(
        `/api/review/exams/${examId}/block-crops/${encodeURIComponent(current.id)}/submit`,
        {
          method: "POST",
          body: JSON.stringify({
            scores: current.questionNumbers.map((q: any) => ({
              questionNumber: Number(q),
              scoreType: current.blockType || "subjective",
            })),
            blockTotalScore: score,
            status: "reviewed",
          }),
        }
      );

      if (res.ok) {
        if (res.disputed) {
          setError(`⚠ 该卷已标记为争议：${res.disputeReason}`);
        }

        // 清除草稿
        const newScores = { ...draftScores };
        delete newScores[current.id];
        setDraftScores(newScores);

        // 如果还有下一份，自动翻页
        if (currentIndex < queue.length - 1) {
          goTo(currentIndex + 1);
        } else {
          setError("✅ 该题块已全部批完！");
        }

        saveSession(currentIndex + 1, newScores);
      }
    } catch (err: any) {
      setError(err.message);
    }
    setSaving(false);
  }, [current, saving, draftScores, examId, currentIndex, queue.length, maxScore, goTo, saveSession]);

  // 缩放
  const zoomIn = () => setZoom((z) => Math.min(4, z + 0.25));
  const zoomOut = () => setZoom((z) => Math.max(0.25, z - 0.25));

  // 旋转
  const rotateCW = () => setRotation((r) => (r + 90) % 360);
  const rotateCCW = () => setRotation((r) => (r - 90 + 360) % 360);

  // 滚轮缩放
  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      if (e.deltaY < 0) zoomIn();
      else zoomOut();
    }
  }, []);

  // 保存批注
  const handleSaveAnnotation = useCallback(async (ann: any) => {
    if (!current) return;
    try {
      await fetchJson(`/api/review-annotations`, {
        method: "POST",
        body: JSON.stringify({
          cropId: current.id,
          type: ann.type,
          dataJson: ann.dataJson,
          positionX: ann.x,
          positionY: ann.y,
          width: ann.w,
          height: ann.h,
        }),
      });
      loadAnnotations(current.id);
    } catch { /* silent */ }
  }, [current, loadAnnotations]);

  // 快捷键
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Enter" && !saving && current) {
        e.preventDefault();
        handleSubmit();
      }
      if (e.key === "ArrowLeft" && currentIndex > 0) {
        goTo(currentIndex - 1);
      }
      if (e.key === "ArrowRight" && currentIndex < queue.length - 1) {
        goTo(currentIndex + 1);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [currentIndex, queue.length, saving, current, handleSubmit, goTo]);

  if (queue.length === 0 && sessionLoaded) {
    return (
      <div style={{ padding: 24 }}>
        <button onClick={onBack} className="back-to-home-button" style={backBtnStyle}>← 返回</button>
        <div style={{ padding: 40, textAlign: "center", color: "var(--color-text-tertiary)" }}>
          {error || "暂无待阅切块"}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden" }}>
      {/* 顶部栏 */}
      <div style={{
        display: "flex",
        alignItems: "center",
        padding: "8px 16px",
        borderBottom: "0.5px solid var(--color-border-tertiary)",
        gap: 12,
        minHeight: 52,
      }}>
        <button onClick={onBack} style={backBtnStyle}>← 返回</button>
        <div style={{ flex: 1, fontWeight: 500, fontSize: 15 }}>
          {current?.blockTitle || blockId}
        </div>
        <div style={{ fontSize: 14, fontWeight: 500, color: "var(--color-text-secondary)" }}>
          {currentIndex + 1} / {queue.length}
        </div>
      </div>

      {/* 主体 — PAD/移动端响应式 */}
      <div className="grade-panel-body" style={{
        flex: 1,
        display: "grid",
        gridTemplateColumns: "1.2fr 0.8fr",
        overflow: "hidden",
      }}>
        <style>{`
          @media (max-width: 900px) {
            .grade-panel-body {
              grid-template-columns: 1fr !important;
              grid-template-rows: 55% 45% !important;
            }
          }
        `}</style>
        {/* 左侧: 图片区 */}
        <div style={{
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          background: "var(--color-background-tertiary)",
        }}>
          {/* 学生信息 */}
          {current && (
            <div style={{
              padding: "8px 16px",
              fontSize: 13,
              color: "var(--color-text-secondary)",
              display: "flex",
              gap: 16,
            }}>
              <span>{current.studentName || `学生${current.studentId}`}</span>
              {current.studentNumber && <span>考号: {current.studentNumber}</span>}
            </div>
          )}

          {/* 图片区域 */}
          <div
            ref={imageRef}
            style={{
              flex: 1,
              overflow: "auto",
              display: "flex",
              justifyContent: "center",
              alignItems: "flex-start",
              padding: 16,
              position: "relative",
            }}
            onWheel={handleWheel}
          >
            {current && (
              <div style={{
                position: "relative",
                transform: `scale(${zoom}) rotate(${rotation}deg)`,
                transformOrigin: "center center",
                transition: "transform 0.2s",
              }}>
                <img
                  src={mediaUrl(current.imageUrl)}
                  alt={current.blockTitle || "作答切块"}
                  style={{
                    maxWidth: "100%",
                    maxHeight: "65vh",
                    display: "block",
                  }}
                  draggable={false}
                />
                <AnnotationOverlay
                  cropId={current.id}
                  imageWidth={current.widthPx || 800}
                  imageHeight={current.heightPx || 600}
                  mode={annotateMode}
                  existingAnnotations={annotations}
                  onSaveAnnotation={handleSaveAnnotation}
                />
              </div>
            )}
          </div>

          {/* 工具栏 */}
          <div style={{
            display: "flex",
            alignItems: "center",
            padding: "8px 16px",
            borderTop: "0.5px solid var(--color-border-tertiary)",
            gap: 8,
            minHeight: 48,
          }}>
            <button onClick={() => goTo(currentIndex - 1)} disabled={currentIndex <= 0} style={iconBtnStyle}>
              <ChevronLeft size={20} />
            </button>
            <button onClick={() => goTo(currentIndex + 1)} disabled={currentIndex >= queue.length - 1} style={iconBtnStyle}>
              <ChevronRight size={20} />
            </button>
            <div style={{ width: 1, height: 20, background: "var(--color-border-primary)" }} />
            <button onClick={zoomOut} style={iconBtnStyle}><ZoomOut size={20} /></button>
            <span style={{ fontSize: 12, color: "var(--color-text-secondary)", minWidth: 40, textAlign: "center" }}>
              {Math.round(zoom * 100)}%
            </span>
            <button onClick={zoomIn} style={iconBtnStyle}><ZoomIn size={20} /></button>
            <div style={{ width: 1, height: 20, background: "var(--color-border-primary)" }} />
            <button onClick={rotateCCW} style={iconBtnStyle}><RotateCcw size={20} /></button>
            <button onClick={rotateCW} style={iconBtnStyle}><RotateCw size={20} /></button>
            <div style={{ width: 1, height: 20, background: "var(--color-border-primary)" }} />
            <button
              onClick={() => setAnnotateMode(annotateMode ? false : (isTouchDevice ? "drawing" : "text"))}
              style={{
                ...iconBtnStyle,
                background: annotateMode ? "var(--color-text-primary)" : "transparent",
                color: annotateMode ? "var(--color-background-primary)" : "var(--color-text-primary)",
              }}
            >
              <PenLine size={20} />
            </button>
          </div>
        </div>

        {/* 右侧: 打分面板 */}
        <div style={{
          padding: 16,
          borderLeft: "0.5px solid var(--color-border-tertiary)",
          overflow: "auto",
          display: "flex",
          flexDirection: "column",
        }}>
          <ScorePad
            maxScore={maxScore}
            hasHalfPoint={current?.hasHalfPoint === 1}
            currentScore={currentScore}
            onScoreChange={handleScoreChange}
            onSubmit={handleSubmit}
            disabled={saving}
          />

          <div style={{ flex: 1 }} />

          {/* 错误提示 */}
          {error && (
            <div style={{
              fontSize: 13,
              color: error.includes("✅") ? "var(--color-text-success, #22c55e)" : "#E24B4A",
              marginBottom: 12,
              padding: "8px 12px",
              background: error.includes("✅") ? "rgba(34,197,94,0.1)" : "rgba(226,75,74,0.1)",
              borderRadius: 8,
            }}>
              {error}
            </div>
          )}

          {/* 操作按钮 */}
          <button
            onClick={() => handleSubmit()}
            disabled={saving || !current}
            style={{
              width: "100%",
              minHeight: 56,
              fontSize: 18,
              fontWeight: 500,
              borderRadius: 12,
              border: "none",
              background: "#3C3489",
              color: "#fff",
              cursor: saving ? "default" : "pointer",
              opacity: saving ? 0.7 : 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              marginBottom: 8,
              touchAction: "manipulation",
            }}
          >
            <Save size={20} />
            {saving ? "保存中..." : "保存并下一份"}
          </button>

          <div style={{ fontSize: 12, color: "var(--color-text-tertiary)", textAlign: "center" }}>
            Enter = 保存并下一份 · ← → = 翻页 · 滚轮 = 缩放
          </div>
        </div>
      </div>
    </div>
  );
}

const backBtnStyle: React.CSSProperties = {
  height: 44,
  padding: "0 18px",
  fontSize: 14,
  fontWeight: 500,
  border: "1px solid var(--color-border-primary)",
  borderRadius: 8,
  background: "var(--color-background-secondary)",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
};

const iconBtnStyle: React.CSSProperties = {
  height: 40,
  width: 40,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  border: "0.5px solid var(--color-border-tertiary)",
  borderRadius: 8,
  background: "transparent",
  cursor: "pointer",
};
