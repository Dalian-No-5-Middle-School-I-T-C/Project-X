import * as React from "react";
import { AlertTriangle, Upload } from "lucide-react";
import { cn } from "../../../lib/utils";

/**
 * UploadZone —— DESIGN-SYSTEM §6（自研，功能守恒自旧 DragDropZone）
 * 虚线框 1.5px border-strong 圆角 12 + 图标 + "拖拽或点击"；
 * 拖拽悬停 = 品牌红边 + accent-soft 底。
 *
 * 相对旧 DragDropZone 的差异**仅限外观与可访问性**：
 *  · 📤 emoji → lucide Upload（§4.6 图标只用 lucide）
 *  · 增加键盘可达（role=button + Enter/Space）与 aria-disabled
 * 校验规则（maxSize / accept 后缀与 MIME 双判）、multiple 语义、
 * capture="environment"、错误 3s 自动消失 —— 全部原样保留。
 */

export interface UploadZoneProps {
  /** 逗号分隔的后缀或 MIME，如 ".jpg,.png" 或 "image/*" */
  accept: string;
  /** 单文件大小上限（字节）；传 0 表示不限 */
  maxSize?: number;
  onFile?: (file: File) => void;
  onFiles?: (files: File[]) => void;
  multiple?: boolean;
  disabled?: boolean;
  label?: string;
  sublabel?: string;
  /** 紧凑档（嵌在面板里），默认 md */
  size?: "sm" | "md";
  className?: string;
}

function formatMB(bytes: number) {
  return (bytes / 1024 / 1024).toFixed(0);
}

export function UploadZone({
  accept,
  maxSize = 0,
  onFile,
  onFiles,
  multiple = false,
  disabled = false,
  label,
  sublabel,
  size = "md",
  className,
}: UploadZoneProps) {
  const [dragOver, setDragOver] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const flashError = React.useCallback((message: string) => {
    setError(message);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setError(null), 3000);
  }, []);

  const validate = React.useCallback(
    (file: File): string | null => {
      if (maxSize && file.size > maxSize) {
        return `文件过大（${(file.size / 1024 / 1024).toFixed(1)}MB），最大 ${formatMB(maxSize)}MB`;
      }
      if (!accept) return null;
      const ext = "." + (file.name.split(".").pop()?.toLowerCase() ?? "");
      const exts = accept.split(",").map((s) => s.trim());
      const ok = exts.some(
        (a) => file.type.startsWith(a.replace("/*", "/")) || a === ext,
      );
      return ok ? null : `不支持的文件格式（${ext}）`;
    },
    [accept, maxSize],
  );

  const handleSelected = React.useCallback(
    (list: File[]) => {
      if (list.length === 0) return;
      if (multiple && onFiles) {
        const valid = list.filter((f) => !validate(f));
        if (valid.length === 0) {
          flashError(validate(list[0]) || "文件格式不支持");
          return;
        }
        setError(null);
        onFiles(valid);
        return;
      }
      const file = list[0];
      const err = validate(file);
      if (err) {
        flashError(err);
        return;
      }
      setError(null);
      onFile?.(file);
    },
    [multiple, onFiles, onFile, validate, flashError],
  );

  const open = () => {
    if (!disabled) inputRef.current?.click();
  };

  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      aria-label={label || "拖拽文件到此处，或点击选择"}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (disabled) return;
        handleSelected(Array.from(e.dataTransfer.files));
      }}
      className={cn(
        "flex w-full cursor-pointer flex-col items-center justify-center gap-2 text-center",
        // 1.5px 必须写成 border-[length:1.5px]：Tailwind v4 里 border-[1.5px]
        // 会被当成颜色候选而静默丢弃（本项目未引 Preflight，丢弃后会退化成
        // 浏览器默认 medium ≈3px 虚线框）。
        "rounded-lg border-[length:1.5px] border-dashed border-border-strong bg-card",
        "transition-[background-color,border-color] duration-(--px-dur-2) ease-standard",
        "outline-none focus-visible:shadow-focus",
        size === "sm" ? "px-4 py-5" : "px-6 py-7",
        !disabled && "hover:border-primary hover:bg-accent",
        dragOver && "border-primary bg-accent",
        error && "border-destructive-border bg-destructive-soft",
        disabled && "cursor-not-allowed opacity-50",
        className,
      )}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        capture="environment"
        disabled={disabled}
        className="hidden"
        onChange={(e) => {
          handleSelected(Array.from(e.target.files || []));
          e.target.value = "";
        }}
      />
      {error ? (
        <>
          <AlertTriangle className="size-6 text-destructive" aria-hidden />
          <span className="text-sm text-destructive-fg">{error}</span>
        </>
      ) : (
        <>
          <Upload
            className={cn(
              "text-muted-foreground",
              dragOver && "text-primary",
              size === "sm" ? "size-5" : "size-6",
            )}
            aria-hidden
          />
          <span className="text-base text-secondary-foreground">
            {label || "拖拽文件到此处，或点击选择"}
          </span>
          <span className="text-xs text-muted-foreground">
            {sublabel ||
              `支持 ${accept}${maxSize ? `，最大 ${formatMB(maxSize)}MB` : ""}`}
          </span>
        </>
      )}
    </div>
  );
}
