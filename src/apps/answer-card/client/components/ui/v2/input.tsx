import * as React from "react";
import { cn } from "../../../lib/utils";

/**
 * Input / Textarea / Field —— DESIGN-SYSTEM §6
 * 高 36（--px-control-h-md，紧凑密度自动 32）· 边框 --input · focus=全局焦点环
 * 错误态 = danger 边框 + 下方 12px 错误文案（由 Field 渲染）
 */

const controlBase = [
  "w-full min-w-0 bg-card text-foreground",
  "rounded-md border border-input",
  "px-3 text-base",
  "placeholder:text-muted-foreground",
  "transition-[border-color,box-shadow] duration-(--px-dur-1) ease-standard",
  "hover:border-input-hover",
  "outline-none focus-visible:shadow-focus focus-visible:border-primary",
  "disabled:cursor-not-allowed disabled:bg-muted disabled:text-disabled-foreground",
];

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  function Input({ className, invalid, ...props }, ref) {
    return (
      <input
        ref={ref}
        aria-invalid={invalid || undefined}
        className={cn(
          controlBase,
          "h-control-md",
          invalid && "border-destructive-border focus-visible:border-destructive",
          className,
        )}
        {...props}
      />
    );
  },
);

export interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea({ className, invalid, rows = 3, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        rows={rows}
        aria-invalid={invalid || undefined}
        className={cn(
          controlBase,
          "min-h-control-lg resize-y py-2 leading-normal",
          invalid && "border-destructive-border focus-visible:border-destructive",
          className,
        )}
        {...props}
      />
    );
  },
);

export const Label = React.forwardRef<
  HTMLLabelElement,
  React.LabelHTMLAttributes<HTMLLabelElement>
>(function Label({ className, ...props }, ref) {
  return (
    <label
      ref={ref}
      className={cn(
        "text-sm font-medium text-secondary-foreground select-none",
        className,
      )}
      {...props}
    />
  );
});

export interface FieldProps {
  label?: React.ReactNode;
  /** 标签右侧的说明/操作（如「忘记密码」） */
  labelAddon?: React.ReactNode;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  required?: boolean;
  htmlFor?: string;
  className?: string;
  children: React.ReactNode;
}

/** 表单字段容器：标签 + 控件 + 提示/错误（错误优先，二者不同时出现） */
export function Field({
  label,
  labelAddon,
  hint,
  error,
  required,
  htmlFor,
  className,
  children,
}: FieldProps) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {(label || labelAddon) && (
        <div className="flex items-baseline justify-between gap-2">
          {label && (
            <Label htmlFor={htmlFor}>
              {label}
              {required && (
                <span className="ml-1 text-destructive" aria-hidden>
                  *
                </span>
              )}
            </Label>
          )}
          {labelAddon}
        </div>
      )}
      {children}
      {error ? (
        <p className="text-xs text-destructive-fg">{error}</p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
