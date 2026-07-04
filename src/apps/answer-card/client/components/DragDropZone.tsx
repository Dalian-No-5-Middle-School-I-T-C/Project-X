import React, { useRef, useState, useCallback } from "react";

interface Props {
  accept: string;
  maxSize: number;
  onFile: (file: File) => void;
  disabled?: boolean;
  label?: string;
  sublabel?: string;
}

export function DragDropZone({ accept, maxSize, onFile, disabled, label, sublabel }: Props) {
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const validate = useCallback(
    (file: File): string | null => {
      if (maxSize && file.size > maxSize) {
        return `文件过大（${(file.size / 1024 / 1024).toFixed(1)}MB），最大 ${(maxSize / 1024 / 1024).toFixed(0)}MB`;
      }
      const ext = "." + file.name.split(".").pop()?.toLowerCase();
      const exts = accept.split(",").map((s) => s.trim());
      const mimeOk = exts.some(
        (a) => file.type.startsWith(a.replace("/*", "/")) || a === ext
      );
      if (accept && !mimeOk) {
        return `不支持的文件格式（${ext}）`;
      }
      return null;
    },
    [accept, maxSize]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      if (disabled) return;
      const file = e.dataTransfer.files[0];
      if (!file) return;
      const err = validate(file);
      if (err) {
        setError(err);
        setTimeout(() => setError(null), 3000);
        return;
      }
      setError(null);
      onFile(file);
    },
    [disabled, validate, onFile]
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const err = validate(file);
      if (err) {
        setError(err);
        setTimeout(() => setError(null), 3000);
        return;
      }
      setError(null);
      onFile(file);
    },
    [validate, onFile]
  );

  return (
    <div
      className={`drag-drop-zone${dragOver ? " drag-over" : ""}${disabled ? " disabled" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      onClick={() => !disabled && inputRef.current?.click()}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        capture="environment"
        onChange={handleChange}
        style={{ display: "none" }}
        disabled={disabled}
      />
      {error ? (
        <div className="drag-drop-error">{error}</div>
      ) : (
        <>
          <div className="drag-drop-icon">📤</div>
          <div className="drag-drop-label">
            {label || "拖拽文件到此处，或点击选择"}
          </div>
          <div className="drag-drop-sublabel">
            {sublabel || `支持 ${accept}，最大 ${(maxSize / 1024 / 1024).toFixed(0)}MB`}
          </div>
        </>
      )}
    </div>
  );
}
