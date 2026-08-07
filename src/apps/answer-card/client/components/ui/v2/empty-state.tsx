import * as React from "react";
import { AlertTriangle, Inbox, RefreshCw } from "lucide-react";
import { cn } from "../../../lib/utils";
import { Button } from "./button";

/**
 * EmptyState / ErrorState —— DESIGN-SYSTEM §6 + §7「异步四态」
 * 三段式：lucide 线框图标 48px(fg-tertiary) + 标题 + 一句引导 + 主行动按钮。
 * 任何数据区都必须有 loading(骨架) / error(重试) / empty(本组件) / success 四态。
 */

export interface EmptyStateProps {
  /** 线框图标，默认 Inbox；传入的图标由本组件统一放大到 48px */
  icon?: React.ReactNode;
  title: React.ReactNode;
  /** 一句引导，说清"接下来该做什么" */
  description?: React.ReactNode;
  /** 主行动（≤1 个主按钮） */
  action?: React.ReactNode;
  /** 嵌在表格/卡片内时用 sm，整页空态用 md */
  size?: "sm" | "md";
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  size = "md",
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex w-full flex-col items-center justify-center gap-2 text-center",
        size === "sm" ? "px-6 py-10" : "px-6 py-16",
        className,
      )}
    >
      <span
        className={cn(
          "text-muted-foreground",
          size === "sm"
            ? "[&_svg]:size-8"
            : "[&_svg]:size-12",
        )}
        aria-hidden
      >
        {icon ?? <Inbox />}
      </span>
      <span
        className={cn(
          "font-semibold text-foreground",
          size === "sm" ? "text-base" : "text-lg",
        )}
      >
        {title}
      </span>
      {description && (
        <span className="max-w-md text-sm text-muted-foreground">
          {description}
        </span>
      )}
      {action && <div className="mt-2 flex items-center gap-2">{action}</div>}
    </div>
  );
}

export interface ErrorStateProps {
  title?: React.ReactNode;
  /** 人话说清失败原因，不要直接甩后端堆栈 */
  description?: React.ReactNode;
  onRetry?: () => void;
  retrying?: boolean;
  size?: "sm" | "md";
  className?: string;
}

/** 异步四态之 error：必须带重试按钮（§7） */
export function ErrorState({
  title = "加载失败",
  description,
  onRetry,
  retrying = false,
  size = "md",
  className,
}: ErrorStateProps) {
  return (
    <EmptyState
      size={size}
      className={className}
      icon={<AlertTriangle className="text-destructive" />}
      title={title}
      description={description}
      action={
        onRetry ? (
          <Button
            variant="outline"
            size="sm"
            icon={<RefreshCw />}
            loading={retrying}
            onClick={onRetry}
          >
            重试
          </Button>
        ) : undefined
      }
    />
  );
}
