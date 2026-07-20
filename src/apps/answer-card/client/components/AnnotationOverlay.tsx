import React, { useRef, useState, useCallback, useEffect } from "react";
import type { ReviewAnnotation } from "../../../../shared/types";

interface Props {
  cropId: string;
  imageWidth: number;
  imageHeight: number;
  mode: "text" | "drawing" | false;
  existingAnnotations: ReviewAnnotation[];
  onSaveAnnotation: (annotation: { type: "text" | "drawing"; dataJson: Record<string, unknown>; x: number; y: number; w?: number; h?: number }) => void;
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
      ctx.strokeStyle = "#FF3B30";
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
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        cursor: mode === "text" ? "crosshair" : mode === "drawing" ? "crosshair" : "default",
      }}
      onClick={mode === "text" ? handleTextClick : undefined}
    >
      {/* 已有批注渲染 */}
      {existingAnnotations.map((ann) => (
        <div
          key={ann.id}
          style={{
            position: "absolute",
            left: `${(ann.dataJson.x as number ?? 0) / imageWidth * 100}%`,
            top: `${(ann.dataJson.y as number ?? 0) / imageHeight * 100}%`,
            width: ann.type === "text" ? "auto" : "100%",
            height: ann.type === "text" ? "auto" : "100%",
            pointerEvents: "none",
          }}
        >
          {ann.type === "text" && (
            <div style={{
              background: "rgba(255, 59, 48, 0.15)",
              borderLeft: "2px solid #FF3B30",
              padding: "2px 8px",
              fontSize: 12,
              borderRadius: 4,
              color: "#FF3B30",
              maxWidth: 200,
            }}>
              {ann.dataJson.text as string}
            </div>
          )}
        </div>
      ))}

      {/* 手写 Canvas */}
      {mode === "drawing" && (
        <canvas
          ref={canvasRef}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            touchAction: "none",
          }}
        />
      )}

      {/* 文字输入弹层 */}
      {textInput.show && (
        <div
          style={{
            position: "absolute",
            left: `${textInput.x / imageWidth * 100}%`,
            top: `${textInput.y / imageHeight * 100}%`,
            transform: "translate(0, 0)",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <input
            autoFocus
            value={textValue}
            onChange={(e) => setTextValue(e.target.value)}
            onBlur={handleTextSubmit}
            onKeyDown={(e) => { if (e.key === "Enter") handleTextSubmit(); if (e.key === "Escape") setTextInput({ ...textInput, show: false }); }}
            placeholder="输入批注..."
            style={{
              border: "1px solid #FF3B30",
              borderRadius: 4,
              padding: "4px 8px",
              fontSize: 13,
              outline: "none",
              background: "white",
              minWidth: 150,
            }}
          />
        </div>
      )}
    </div>
  );
}
