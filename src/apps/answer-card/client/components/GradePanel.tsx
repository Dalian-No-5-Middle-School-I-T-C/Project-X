import React, { useState, useEffect, useCallback, useRef } from "react";
import { AlertTriangle, ArrowLeft, CheckCircle2, ChevronLeft, ChevronRight, ClipboardList, ZoomIn, ZoomOut, RotateCw, RotateCcw, PenLine, Save } from "lucide-react";
import { fetchJson, mediaUrl } from "../auth/api";
import { ScorePad } from "./ScorePad";
import { AnnotationOverlay } from "./AnnotationOverlay";
import type { ReviewBlockCropItem, ReviewAnnotation, ReviewSubmitResult } from "../../../../shared/types";
import { Button, EmptyState, Kbd } from "./ui/v2";
import { cn } from "../lib/utils";

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
  const [errorTone, setErrorTone] = useState<"success" | "error">("error");
  const [scoringMode, setScoringMode] = useState<string>("block_total");
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
    } catch (err: any) { setError(err.message); setErrorTone("error"); }
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

  // 加载题块评分配置
  const loadConfig = useCallback(async () => {
    try {
      const res = await fetchJson<{ ok: boolean; data?: { scoringMode?: string } }>(
        `/api/block-grading-config/exams/${examId}/blocks/${encodeURIComponent(blockId)}`
      );
      if (res.ok && res.data?.scoringMode) setScoringMode(res.data.scoringMode);
    } catch { /* 使用默认题块总分模式 */ }
  }, [examId, blockId]);

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
    loadConfig();
  }, [loadQueue, loadSession, loadConfig]);

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
    if (scoringMode === "per_question") {
      setError("本题块为逐题评分模式，请使用在线阅卷逐题输入");
      return;
    }
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
          setError(`该卷已标记为争议：${res.disputeReason}`);
          setErrorTone("error");
        }

        // 清除草稿
        const newScores = { ...draftScores };
        delete newScores[current.id];
        setDraftScores(newScores);

        // 如果还有下一份，自动翻页
        if (currentIndex < queue.length - 1) {
          goTo(currentIndex + 1);
        } else {
          setError("该题块已全部批完！");
          setErrorTone("success");
        }

        saveSession(currentIndex + 1, newScores);
      }
    } catch (err: any) {
      setError(err.message);
    }
    setSaving(false);
  }, [current, saving, draftScores, examId, currentIndex, queue.length, maxScore, goTo, saveSession, scoringMode]);

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
      <div className="p-6">
        <Button variant="outline" icon={<ArrowLeft />} onClick={onBack}>返回</Button>
        <EmptyState
          className="mt-4"
          icon={<ClipboardList />}
          title={error || "暂无待阅切块"}
        />
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {/* 顶部栏 */}
      <div className="flex min-h-13 items-center gap-3 border-b border-border-subtle px-4 py-2">
        <Button variant="outline" icon={<ArrowLeft />} onClick={onBack}>返回</Button>
        <div className="min-w-0 flex-1 truncate text-base font-medium text-foreground">
          {current?.blockTitle || blockId}
        </div>
        <div className="text-sm font-medium text-muted-foreground tabular-nums">
          {currentIndex + 1} / {queue.length}
        </div>
      </div>

      {/* 主体 — PAD/移动端响应式：<900px 上下分栏，≥900px 左右分栏 */}
      <div className="grid flex-1 grid-cols-1 grid-rows-[55%_45%] overflow-hidden min-[900px]:grid-cols-[1.2fr_0.8fr] min-[900px]:grid-rows-1">
        {/* 左侧: 图片区 */}
        <div className="flex flex-col overflow-hidden bg-secondary">
          {/* 学生信息 */}
          {current && (
            <div className="flex gap-4 px-4 py-2 text-sm text-muted-foreground">
              <span>{current.studentName || `学生${current.studentId}`}</span>
              {current.studentNumber && <span>考号: {current.studentNumber}</span>}
            </div>
          )}

          {/* 图片区域 */}
          <div
            ref={imageRef}
            className="relative flex flex-1 items-start justify-center overflow-auto p-4"
            onWheel={handleWheel}
          >
            {current && (
              <div
                className="relative origin-center transition-transform duration-(--px-dur-2) ease-standard"
                // 动态缩放/旋转（EXECUTION-PLAN §1.3 允许的动态值内联）
                style={{ transform: `scale(${zoom}) rotate(${rotation}deg)` }}
              >
                <img
                  src={mediaUrl(current.imageUrl)}
                  alt={current.blockTitle || "作答切块"}
                  className="block max-h-[65vh] max-w-full"
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
          <div className="flex min-h-12 items-center gap-2 border-t border-border-subtle px-4 py-2">
            <Button variant="ghost" size="icon" aria-label="上一份" onClick={() => goTo(currentIndex - 1)} disabled={currentIndex <= 0}>
              <ChevronLeft />
            </Button>
            <Button variant="ghost" size="icon" aria-label="下一份" onClick={() => goTo(currentIndex + 1)} disabled={currentIndex >= queue.length - 1}>
              <ChevronRight />
            </Button>
            <div className="h-5 w-px bg-border" aria-hidden />
            <Button variant="ghost" size="icon" aria-label="缩小" onClick={zoomOut}><ZoomOut /></Button>
            <span className="min-w-10 text-center text-xs text-muted-foreground tabular-nums">
              {Math.round(zoom * 100)}%
            </span>
            <Button variant="ghost" size="icon" aria-label="放大" onClick={zoomIn}><ZoomIn /></Button>
            <div className="h-5 w-px bg-border" aria-hidden />
            <Button variant="ghost" size="icon" aria-label="逆时针旋转" onClick={rotateCCW}><RotateCcw /></Button>
            <Button variant="ghost" size="icon" aria-label="顺时针旋转" onClick={rotateCW}><RotateCw /></Button>
            <div className="h-5 w-px bg-border" aria-hidden />
            <Button
              variant="ghost"
              size="icon"
              aria-label="批注"
              aria-pressed={Boolean(annotateMode)}
              className={cn(annotateMode && "bg-primary text-primary-foreground hover:bg-primary-hover hover:text-primary-foreground")}
              onClick={() => setAnnotateMode(annotateMode ? false : (isTouchDevice ? "drawing" : "text"))}
            >
              <PenLine />
            </Button>
          </div>
        </div>

        {/* 右侧: 打分面板 */}
        <div className="flex flex-col overflow-auto border-l border-border-subtle p-4">
          {scoringMode === "per_question" ? (
            <div className="rounded-lg bg-destructive-soft px-3.5 py-3 text-base text-destructive-fg">
              本题块配置为「逐题评分」模式，请使用在线阅卷逐题输入；如需在此面板打分，请管理员将评分模式改为「题块总分」。
            </div>
          ) : (
            <ScorePad
              maxScore={maxScore}
              hasHalfPoint={current?.hasHalfPoint === 1}
              currentScore={currentScore}
              onScoreChange={handleScoreChange}
              onSubmit={handleSubmit}
              disabled={saving}
            />
          )}

          <div className="flex-1" />

          {/* 错误提示 */}
          {error && (
            <div
              className={cn(
                "mb-3 flex items-center gap-2 rounded-lg px-3 py-2 text-sm",
                errorTone === "success"
                  ? "bg-success-soft text-success-foreground"
                  : "bg-destructive-soft text-destructive-fg",
              )}
              role="status"
            >
              {errorTone === "success"
                ? <CheckCircle2 className="size-4 shrink-0" aria-hidden />
                : <AlertTriangle className="size-4 shrink-0" aria-hidden />}
              {error}
            </div>
          )}

          {/* 操作按钮 */}
          <Button
            variant="primary"
            block
            className="mb-2 min-h-14 text-lg [touch-action:manipulation]"
            icon={<Save className="size-5" />}
            loading={saving}
            disabled={!current || scoringMode === "per_question"}
            onClick={() => handleSubmit()}
          >
            {saving ? "保存中..." : "保存并下一份"}
          </Button>

          <div className="flex flex-wrap items-center justify-center gap-1.5 text-xs text-muted-foreground">
            <Kbd>Enter</Kbd> 保存并下一份 · <Kbd>←</Kbd> <Kbd>→</Kbd> 翻页 · 滚轮 缩放
          </div>
        </div>
      </div>
    </div>
  );
}
