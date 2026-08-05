// AnnotationOverlay —— 阅卷批注浮层（T5 v2 迁移）
// UI-4：浮层 z-index 一律走令牌阶梯（--px-z-raised / --px-z-dropdown），杜绝魔法数。
// 视觉层令牌化：批注红改走 destructive 语义；canvas 笔触颜色从 --px-danger-bg 读取，
// 因此暗色主题下批注颜色会自动跟随，而不再写死 #FF3B30。
// 功能守恒：批注坐标换算、palm rejection、笔画采集与 onSaveAnnotation 回调形状零改动。
// 说明：批注定位是数据驱动的动态百分比，按 EXECUTION-PLAN §1.3「动态值除外」
//       仅保留几何定位的 inline style，不承载任何颜色。
import React, { useRef, useState, useCallback, useEffect } from "react";
import type { ReviewAnnotation } from "../../../../shared/types";
import { Input } from "./ui/v2";

interface Props {
  cropId: string;
  imageWidth: number;
  imageHeight: number;
  mode: "text" | "drawing" | false;
  existingAnnotations: ReviewAnnotation[];
  onSaveAnnotation: (annotation: { type: "text" | "drawing"; dataJson: Record<string, unknown>; x: number; y: number; w?: number; h?: number }) => void;
}

/** canvas 2D 无法消费 CSS 类，按 chart.tsx 既有做法从令牌读取笔触色 */
const INK_FALLBACK = "rgb(192 15 40)";
function readInkColor(): string {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return INK_FALLBACK;
  }
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue("--px-danger-bg")
    .trim();
  return value || INK_FALLBACK;
}

export function AnnotationOverlay({ cropId, imageWidth, imageHeight, mode, existingAnnotations, onSaveAnnotation }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [textInput, setTextInput] = useState<{ x: number; y: number; show: boolean }>({ x: 0, y: 0, show: false });
  const [textValue, setTextValue] = useState("");

  // 文字批注点击定位
  const handleTextClick = useCallback((e: React.MouseEvent) => {
    if (mode !== "text" || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * imageWidth;
    const y = ((e.clientY - rect.top) / rect.height) * imageHeight;
    setTextInput({ x, y, show: true });
    setTextValue("");
  }, [mode, imageWidth, imageHeight]);

  // 提交文字批注
  const handleTextSubmit = () => {
    if (!textValue.trim()) {
      setTextInput({ ...textInput, show: false });
      return;
    }
    onSaveAnnotation({
      type: "text",
      dataJson: { text: textValue },
      x: textInput.x,
      y: textInput.y,
      w: 200,
      h: 40,
    });
    setTextInput({ ...textInput, show: false });
  };

  // 手写批注
  useEffect(() => {
    if (mode !== "drawing" || !canvasRef.current || !containerRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = containerRef.current.clientWidth;
    canvas.height = containerRef.current.clientHeight;

    const inkColor = readInkColor();
    let drawing = false;
    let lastX = 0;
    let lastY = 0;
    const strokes: Array<{ points: number[][] }> = [];
    let currentStroke: number[][] = [];

    const getPos = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: (e.clientX - rect.left) / rect.width * imageWidth,
        y: (e.clientY - rect.top) / rect.height * imageHeight,
      };
    };

    const onDown = (e: PointerEvent) => {
      // palm rejection: ignore large touch areas
      if (e.pointerType === "touch" && (e.width > 30 || e.height > 30)) return;
      drawing = true;
      const pos = getPos(e);
      lastX = pos.x;
      lastY = pos.y;
      currentStroke = [[pos.x, pos.y]];
      ctx.beginPath();
      ctx.moveTo(e.clientX - canvas.getBoundingClientRect().left, e.clientY - canvas.getBoundingClientRect().top);
    };

    const onMove = (e: PointerEvent) => {
      if (!drawing) return;
      const pos = getPos(e);
      currentStroke.push([pos.x, pos.y]);
      ctx.lineTo(e.clientX - canvas.getBoundingClientRect().left, e.clientY - canvas.getBoundingClientRect().top);
      ctx.strokeStyle = inkColor;
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke();
    };

    const onUp = () => {
      if (!drawing) return;
      drawing = false;
      strokes.push({ points: currentStroke });
      setIsDrawing(false);
      // 保存手写批注
      onSaveAnnotation({
        type: "drawing",
        dataJson: { strokes: strokes.map((s) => ({ points: s.points })) },
        x: 0,
        y: 0,
        w: imageWidth,
        h: imageHeight,
      });
    };

    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointerleave", onUp);

    return () => {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointerleave", onUp);
    };
  }, [mode, imageWidth, imageHeight, onSaveAnnotation]);

  if (!mode) return null;

  return (
    <div
      ref={containerRef}
      data-crop-id={cropId}
      data-drawing={isDrawing || undefined}
      className="absolute inset-0 z-(--px-z-raised) cursor-crosshair"
      onClick={mode === "text" ? handleTextClick : undefined}
    >
      {/* 已有批注渲染 */}
      {existingAnnotations.map((ann) => (
        <div
          key={ann.id}
          className={
            ann.type === "text"
              ? "pointer-events-none absolute h-auto w-auto"
              : "pointer-events-none absolute h-full w-full"
          }
          style={{
            left: `${(ann.dataJson.x as number ?? 0) / imageWidth * 100}%`,
            top: `${(ann.dataJson.y as number ?? 0) / imageHeight * 100}%`,
          }}
        >
          {ann.type === "text" && (
            <div className="max-w-50 rounded-xs border-l-2 border-destructive bg-destructive-soft px-2 py-0.5 text-xs text-destructive-fg">
              {ann.dataJson.text as string}
            </div>
          )}
        </div>
      ))}

      {/* 手写 Canvas */}
      {mode === "drawing" && (
        <canvas
          ref={canvasRef}
          className="absolute top-0 left-0 h-full w-full touch-none"
        />
      )}

      {/* 文字输入弹层 */}
      {textInput.show && (
        <div
          className="absolute z-(--px-z-dropdown)"
          style={{
            left: `${textInput.x / imageWidth * 100}%`,
            top: `${textInput.y / imageHeight * 100}%`,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <Input
            autoFocus
            value={textValue}
            onChange={(e) => setTextValue(e.target.value)}
            onBlur={handleTextSubmit}
            onKeyDown={(e) => { if (e.key === "Enter") handleTextSubmit(); if (e.key === "Escape") setTextInput({ ...textInput, show: false }); }}
            placeholder="输入批注..."
            aria-label="输入批注"
            className="h-control-sm w-40 border-destructive-border text-sm"
          />
        </div>
      )}
    </div>
  );
}
