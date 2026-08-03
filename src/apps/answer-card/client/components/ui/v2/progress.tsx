import * as React from "react";
import * as ProgressPrimitive from "@radix-ui/react-progress";
import { cn } from "../../../lib/utils";

/**
 * Progress —— DESIGN-SYSTEM §6
 * 扫描 / 导出 / 识别**必须**确定性进度（百分比 + 当前项名），
 * 不允许拿无限 spinner 兜底 —— 业务侧请用 <TaskProgress>。
 */

const toneClass = {
  primary: "bg-primary",
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
} as const;

export type ProgressTone = keyof typeof toneClass;

export interface ProgressProps
  extends Omit<
    React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root>,
    "value"
  > {
  /** 0–100；传 null 表示总量未知（仅允许于「正在建立连接」这类瞬时态） */
  value: number | null;
  tone?: ProgressTone;
  size?: "sm" | "md";
}

export const Progress = React.forwardRef<
  React.ComponentRef<typeof ProgressPrimitive.Root>,
  ProgressProps
>(function Progress(
  { className, value, tone = "primary", size = "md", ...props },
  ref,
) {
  const pct = value == null ? null : Math.min(100, Math.max(0, value));
  return (
    <ProgressPrimitive.Root
      ref={ref}
      value={pct}
      className={cn(
        "relative w-full overflow-hidden rounded-full bg-secondary",
        size === "sm" ? "h-1" : "h-2",
        className,
      )}
      {...props}
    >
      <ProgressPrimitive.Indicator
        className={cn(
          "h-full w-full rounded-full transition-transform duration-(--px-dur-3) ease-out-token",
          toneClass[tone],
          // 总量未知：低调的脉冲，绝不冒充确定性进度
          pct == null && "animate-pulse",
        )}
        style={{ transform: `translateX(-${100 - (pct ?? 8)}%)` }}
      />
    </ProgressPrimitive.Root>
  );
});

export interface TaskProgressProps {
  /** 任务名，如「识别中」「导出成绩」 */
  label: React.ReactNode;
  /** 当前处理项名（文件名/学号），§6 定死项 */
  current?: React.ReactNode;
  done: number;
  total: number;
  tone?: ProgressTone;
  /** 失败计数，>0 时右侧以 danger 文字提示 */
  failed?: number;
  className?: string;
}

/** 扫描 / 导出 / 识别统一进度块：百分比 + 当前项名 + 已完成/总数 */
export function TaskProgress({
  label,
  current,
  done,
  total,
  tone = "primary",
  failed = 0,
  className,
}: TaskProgressProps) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate text-base font-medium text-foreground">
          {label}
        </span>
        <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
          {done}/{total}
          <span className="ml-2 text-foreground">{pct}%</span>
        </span>
      </div>
      <Progress value={pct} tone={tone} />
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate text-xs text-muted-foreground">
          {current}
        </span>
        {failed > 0 && (
          <span className="shrink-0 text-xs tabular-nums text-destructive-fg">
            失败 {failed}
          </span>
        )}
      </div>
    </div>
  );
}
