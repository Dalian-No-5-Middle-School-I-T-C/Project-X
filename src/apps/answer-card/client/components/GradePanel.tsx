import React, { useState, useEffect, useCallback, useRef } from "react";
import { AlertTriangle, ArrowLeft, CheckCircle2, ChevronLeft, ChevronRight, ClipboardList, ZoomIn, ZoomOut, RotateCw, RotateCcw, PenLine, Save } from "lucide-react";
import { fetchJson, mediaUrl } from "../auth/api";
import { ScorePad } from "./ScorePad";
import { AnnotationOverlay } from "./AnnotationOverlay";
import type { ReviewBlockCropItem, ReviewAnnotation, ReviewSession, ReviewSubmitResult } from "../../../../shared/types";
import { Button, EmptyState, Kbd, Spinner } from "./ui/v2";
import { cn } from "../lib/utils";
import { retryMediaTicketImage } from "../lib/mediaTicketRetry";

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
  const [claiming, setClaiming] = useState(false);
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const [annotations, setAnnotations] = useState<ReviewAnnotation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [errorTone, setErrorTone] = useState<"success" | "error">("error");
  const [scoringMode, setScoringMode] = useState<string>("block_total");
  const imageRef = useRef<HTMLDivElement>(null);

  const current = queue[currentIndex];
  const [selectedPartId, setSelectedPartId] = useState<string | null>(null);
  const parts = current?.reviewImages;
  const part = parts?.find(image => image.id === selectedPartId) ?? parts?.[0] ?? current;
  const partLabel = (index: number, page: number) => `作文第 ${index + 1} 段（第 ${page} 页）`;
  const supportsPerQuestion = Boolean(parts?.length && current.questionNumbers.length === 1);
  const currentScore = current ? (draftScores[current.id] ?? current.score ?? 0) : 0;
  const maxScore = current?.maxScore ?? 0;
  // 是否已为本卷显式选过分数（防止未选分时误提交 0 分）
  const hasEnteredScore = current ? draftScores[current.id] !== undefined : false;

  const pendingSession = useRef(Promise.resolve());
  const sessionUrl = `/api/review-session/exams/${examId}/blocks/${encodeURIComponent(blockId)}`;
  const fetchQueue = useCallback(async () => {
    const res = await fetchJson<{ data: { entries: ReviewBlockCropItem[] } }>(
      `/api/review-pool/exams/${examId}/blocks/${encodeURIComponent(blockId)}?mine=1`
    );
    return res.data.entries;
  }, [examId, blockId]);

  // Issue #174: 从试卷池领取下一份（题块总分模式同样走池，避免重复批阅）
  const claimNext = useCallback(async () => {
    if (claiming) return;
    setClaiming(true);
    setError(null);
    try {
      const res = await fetchJson<{ ok: boolean; data?: ReviewBlockCropItem; error?: string }>(
        `/api/review-pool/exams/${examId}/blocks/${encodeURIComponent(blockId)}/claim`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) }
      );
      if (!res.ok || !res.data) throw new Error(res.error ?? "领卷失败");
      setQueue((prev) => {
        setCurrentIndex(prev.length);
        return [...prev, res.data!];
      });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setClaiming(false);
    }
  }, [examId, blockId, claiming]);

  // 选分、翻页和提交都写同一个会话，按操作顺序落库。
  const saveSession = useCallback((idx: number, scores: Record<string, number>, cropId?: string) => {
    const body = JSON.stringify({ currentIndex: idx, positionJson: { zoom, rotation, cropId }, draftScores: scores });
    pendingSession.current = pendingSession.current
      .then(() => fetchJson<void>(sessionUrl, { method: "PUT", body }))
      .catch(() => { setError("阅卷进度未保存，请检查连接后重试。"); setErrorTone("error"); });
  }, [sessionUrl, zoom, rotation]);

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
  const activePartId = useRef<string | undefined>(undefined);
  const loadAnnotations = useCallback(async (cropId: string) => {
    try {
      const res = await fetchJson<{ ok: boolean; data: ReviewAnnotation[] }>(
        `/api/review-annotations?cropId=${encodeURIComponent(cropId)}`
      );
      if (activePartId.current === cropId && res.ok) setAnnotations(res.data);
    } catch { if (activePartId.current === cropId) setAnnotations([]); }
  }, []);

  useEffect(() => {
    let active = true;
    setSessionLoaded(false);
    setQueue([]);
    setDraftScores({});
    void Promise.all([
      fetchQueue(),
      fetchJson<{ data: ReviewSession | null }>(sessionUrl),
    ]).then(([entries, { data }]) => {
      if (!active) return;
      const savedIndex = entries.findIndex(entry => entry.id === data?.positionJson?.cropId);
      setQueue(entries);
      setCurrentIndex(savedIndex >= 0 ? savedIndex : Math.max(0, Math.min(data?.currentIndex ?? 0, entries.length - 1)));
      const loadedDrafts = data?.draftScores ?? {};
      setDraftScores(Object.fromEntries(
        Object.entries(loadedDrafts).filter((entry): entry is [string, number] => typeof entry[1] === "number")
      ));
    }).catch((err: Error) => {
      if (active) { setError(err.message); setErrorTone("error"); }
    }).finally(() => { if (active) setSessionLoaded(true); });
    return () => { active = false; };
  }, [fetchQueue, sessionUrl]);

  useEffect(() => { void loadConfig(); }, [loadConfig]);

  // 当前切块变化时加载批注
  useEffect(() => {
    activePartId.current = part?.id;
    setAnnotations([]);
    if (part) loadAnnotations(part.id);
    return () => { activePartId.current = undefined; };
  }, [part?.id, loadAnnotations]);

  // 导航
  const goTo = useCallback((index: number) => {
    const clamped = Math.max(0, Math.min(queue.length - 1, index));
    setCurrentIndex(clamped);
    setZoom(1);
    setRotation(0);
    setAnnotateMode(false);
    saveSession(clamped, draftScores, queue[clamped]?.id);
  }, [queue, draftScores, saveSession]);

  // 分数变化
  const handleScoreChange = useCallback((score: number) => {
    if (!current) return;
    const newScores = { ...draftScores, [current.id]: score };
    setDraftScores(newScores);
    saveSession(currentIndex, newScores, current.id);
  }, [current, currentIndex, draftScores, saveSession]);

  // 保存并下一份
  const handleSubmit = useCallback(async (scoreOverride?: number) => {
    if (!current || saving || current.reviewIssue) return;
    if (scoreOverride === undefined && draftScores[current.id] === undefined) {
      setError("请先选择分数再提交，避免误提交 0 分");
      setErrorTone("error");
      return;
    }
    if (scoringMode === "per_question" && !supportsPerQuestion) {
      setError("本题块采用逐题评分，不能在这里提交题块总分。");
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
              ...(scoringMode === "per_question" ? { score } : {}),
            })),
            ...(scoringMode === "per_question" ? {} : { blockTotalScore: score }),
            status: "reviewed",
          }),
        }
      );

      if (res.ok) {
        if (res.rankingsRecalculated === false) {
          setError(`分数已保存，但排名/赋分重算失败：${res.rankingError ?? "未知错误"}，请稍后联系管理员重算`);
          setErrorTone("error");
        } else if (res.assignedScoresRecalculated === false) {
          setError(`分数已保存，但赋分重算失败：${res.assignedScoreError ?? "未知错误"}，请稍后联系管理员重算`);
          setErrorTone("error");
        }
        if (res.disputed) {
          setError(`该卷已标记为争议：${res.disputeReason}`);
          setErrorTone("error");
        }

        // 清除草稿
        const newScores = { ...draftScores };
        delete newScores[current.id];
        setDraftScores(newScores);

        // Issue #174: 提交后试卷离开已领队列（待复核会回到池中），刷新队列
        setQueue((prev) => prev.filter((item) => item.id !== current.id));
        setCurrentIndex(0);
        saveSession(0, newScores);
        void fetchQueue().then(setQueue).catch((err: Error) => setError(err.message));
      }
    } catch (err: any) {
      setError(err.message);
    }
    setSaving(false);
  }, [current, saving, draftScores, examId, currentIndex, queue.length, maxScore, goTo, saveSession, scoringMode, supportsPerQuestion, fetchQueue]);

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
    if (!part) return;
    try {
      await fetchJson(`/api/review-annotations`, {
        method: "POST",
        body: JSON.stringify({
          cropId: part.id,
          type: ann.type,
          dataJson: ann.dataJson,
          positionX: ann.x,
          positionY: ann.y,
          width: ann.w,
          height: ann.h,
        }),
      });
      loadAnnotations(part.id);
    } catch { /* silent */ }
  }, [part, loadAnnotations]);

  // 快捷键
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && (e.target.isContentEditable || e.target.closest("input, textarea, select"))) return;
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

  if (!sessionLoaded) return <div role="status" className="flex justify-center p-6"><Spinner size={20} /></div>;

  if (queue.length === 0) {
    return (
      <div className="p-6">
        <Button variant="outline" icon={<ArrowLeft />} onClick={onBack}>返回</Button>
        <div className="mt-6 flex items-center justify-center">
          <Button variant="primary" loading={claiming} onClick={() => void claimNext()}>
            {claiming ? "领取中..." : "从试卷池领取试卷"}
          </Button>
        </div>
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
        <button
          type="button"
          onClick={() => void claimNext()}
          disabled={claiming}
          className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border bg-secondary px-3 py-1.5 text-[13px] text-foreground disabled:cursor-default disabled:opacity-50"
        >
          {claiming ? "领取中..." : "领取下一份"}
        </button>
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

          {parts && parts.length > 1 && <div className="flex flex-wrap gap-2 px-4 pb-2">
            {parts.map((image, index) => <Button key={image.id} size="sm"
              variant={image.id === part?.id ? "primary" : "outline"}
              aria-pressed={image.id === part?.id} onClick={() => setSelectedPartId(image.id)}>
              {partLabel(index, image.pageNumber)}
            </Button>)}
          </div>}
          {current?.reviewIssue && <p role="alert">{current.reviewIssue}</p>}
          {/* 图片区域 */}
          <div
            ref={imageRef}
            className="relative flex flex-1 items-start justify-center overflow-auto p-4"
            onWheel={handleWheel}
          >
            {current && part && !current.reviewIssue && (
              <div
                className="relative origin-center transition-transform duration-(--px-dur-2) ease-standard"
                // 动态缩放/旋转（EXECUTION-PLAN §1.3 允许的动态值内联）
                style={{ transform: `scale(${zoom}) rotate(${rotation}deg)` }}
              >
                <img
                  src={mediaUrl(part.imageUrl)}
                  alt={parts?.length ? partLabel(parts.findIndex(p => p.id === part.id), part.pageNumber) : current.blockTitle || "作答切块"}
                  className="block max-h-[65vh] max-w-full"
                  draggable={false}
                  // 跨源模式回看早期切块时，缓存的票据可能已被服务端淘汰 → 重签一次再试
                  onError={(event) => { retryMediaTicketImage(event.currentTarget); }}
                />
                <AnnotationOverlay
                  key={part.id}
                  cropId={part.id}
                  imageWidth={part.widthPx || 800}
                  imageHeight={part.heightPx || 600}
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
          {scoringMode === "per_question" && !supportsPerQuestion ? (
            <div className="rounded-lg bg-destructive-soft px-3.5 py-3 text-base text-destructive-fg">
              本题块采用「逐题评分」。此面板只支持题块总分，请返回阅卷列表选择逐题评分入口；如需在此打分，请管理员把评分模式改为「题块总分」。
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
            disabled={!current || Boolean(current.reviewIssue) || (scoringMode === "per_question" && !supportsPerQuestion) || !hasEnteredScore}
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
