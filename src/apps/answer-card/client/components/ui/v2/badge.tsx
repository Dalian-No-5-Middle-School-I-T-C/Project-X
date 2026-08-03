import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../../lib/utils";

/**
 * Badge —— DESIGN-SYSTEM §6
 * 状态徽章 = soft 底 + fg 字 + 前置 8px 状态点。
 * 色彩永不单独承载状态（§4.5）：状态点/图标与文字始终同在。
 */
const badgeVariants = cva(
  [
    "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap",
    "rounded-sm px-2 py-0.5 text-xs font-medium",
    "border",
    "[&_svg]:size-3.5 [&_svg]:shrink-0",
  ],
  {
    variants: {
      tone: {
        neutral: "bg-secondary text-secondary-foreground border-border",
        accent: "bg-accent text-accent-foreground border-accent-border",
        success: "bg-success-soft text-success-foreground border-success-border",
        warning: "bg-warning-soft text-warning-foreground border-warning-border",
        info: "bg-info-soft text-info-foreground border-info-border",
        danger:
          "bg-destructive-soft text-destructive-fg border-destructive-border",
        /** 实底：仅用于必须抢眼的极少数场景 */
        solid: "bg-primary text-primary-foreground border-transparent",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

const dotTone: Record<string, string> = {
  neutral: "bg-muted-foreground",
  accent: "bg-primary",
  success: "bg-success",
  warning: "bg-warning",
  info: "bg-info",
  danger: "bg-destructive",
  solid: "bg-primary-foreground",
};

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  /** 前置状态点（状态类徽章默认开启） */
  dot?: boolean;
  icon?: React.ReactNode;
}

export function Badge({
  className,
  tone = "neutral",
  dot = false,
  icon,
  children,
  ...props
}: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ tone }), className)} {...props}>
      {dot && (
        <span
          className={cn("size-1.5 shrink-0 rounded-full", dotTone[tone ?? "neutral"])}
          aria-hidden
        />
      )}
      {icon}
      {children}
    </span>
  );
}

/**
 * 考试状态枚举徽章（§6 定死项）：
 * 未开始(灰) / 阅卷中(琥珀) / 已完成(绿) / 异常(红)
 */
export type ExamStatus = "pending" | "grading" | "done" | "error";

const examStatusMap: Record<ExamStatus, { tone: BadgeProps["tone"]; label: string }> = {
  pending: { tone: "neutral", label: "未开始" },
  grading: { tone: "warning", label: "阅卷中" },
  done: { tone: "success", label: "已完成" },
  error: { tone: "danger", label: "异常" },
};

export function ExamStatusBadge({
  status,
  label,
  className,
}: {
  status: ExamStatus;
  /** 覆盖默认文案（如「阅卷中 3/5」） */
  label?: string;
  className?: string;
}) {
  const cfg = examStatusMap[status];
  return (
    <Badge tone={cfg.tone} dot className={className}>
      {label ?? cfg.label}
    </Badge>
  );
}

export { badgeVariants };
