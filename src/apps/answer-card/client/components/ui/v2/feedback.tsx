import * as React from "react";
import { Loader2 } from "lucide-react";
import { cn } from "../../../lib/utils";

/**
 * Spinner / Skeleton / Kbd —— DESIGN-SYSTEM §6
 * Skeleton：页面首载一律骨架屏模拟真实布局；
 * Spinner：仅限按钮内与 <300ms 场景（长任务必须用确定性 Progress）。
 */

export function Spinner({
  className,
  size = 16,
  label = "加载中",
}: {
  className?: string;
  size?: number;
  label?: string;
}) {
  return (
    <Loader2
      role="status"
      aria-label={label}
      className={cn("animate-spin text-muted-foreground", className)}
      style={{ width: size, height: size }}
    />
  );
}

export function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden
      className={cn("animate-pulse rounded-sm bg-muted", className)}
      {...props}
    />
  );
}

/** 文本行骨架：按行数生成，最后一行缩短，贴近真实段落 */
export function SkeletonText({
  lines = 3,
  className,
}: {
  lines?: number;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          className={cn("h-3.5", i === lines - 1 ? "w-3/5" : "w-full")}
        />
      ))}
    </div>
  );
}

/** 键盘提示：扫描/判分界面右下角常驻快捷键卡使用 */
export function Kbd({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center",
        "rounded-xs border border-border bg-secondary px-1.5",
        "font-mono text-xs leading-none text-secondary-foreground",
        className,
      )}
      {...props}
    >
      {children}
    </kbd>
  );
}
