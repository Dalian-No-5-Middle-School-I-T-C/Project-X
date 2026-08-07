import * as React from "react";
import { ArrowDown, ArrowRight, ArrowUp } from "lucide-react";
import { cn } from "../../../lib/utils";
import { Skeleton } from "./feedback";

/**
 * StatCard —— DESIGN-SYSTEM §6
 * 大数字 text-3xl tabular-nums + 12px 指标名 + 环比小字。
 *
 * 环比着色（教育语境）：**成绩变好=绿、变差=红**。
 * 部分指标"数值上升"其实是坏事（缺考率、异常卷率），这类传 direction="up-is-bad"。
 */

export interface StatCardProps {
  /** 指标名，如「平均分」 */
  label: React.ReactNode;
  /** 主数值；数字类请传已格式化好的字符串以免精度漂移 */
  value: React.ReactNode;
  /** 单位/后缀，小一号灰字紧跟主数值 */
  suffix?: React.ReactNode;
  /** 环比变化量（带符号的数值，如 +2.4 / -1.8）；传 0 显示持平 */
  delta?: number | null;
  /** 环比文案后缀，默认「较上次」 */
  deltaLabel?: React.ReactNode;
  /** 数值上升是好事还是坏事 */
  direction?: "up-is-good" | "up-is-bad";
  /** 左下补充说明 */
  hint?: React.ReactNode;
  loading?: boolean;
  className?: string;
}

export function StatCard({
  label,
  value,
  suffix,
  delta,
  deltaLabel = "较上次",
  direction = "up-is-good",
  hint,
  loading = false,
  className,
}: StatCardProps) {
  const hasDelta = typeof delta === "number";
  const flat = hasDelta && delta === 0;
  const up = hasDelta && delta > 0;
  const good = direction === "up-is-good" ? up : !up;

  return (
    <div
      className={cn(
        "flex min-w-[150px] flex-1 flex-col gap-1 rounded-lg border border-border-subtle bg-card px-5 py-4",
        className,
      )}
    >
      {loading ? (
        <>
          <Skeleton className="h-8 w-24" />
          <Skeleton className="mt-1 h-3 w-16" />
        </>
      ) : (
        <>
          <div className="flex items-baseline gap-1">
            <span className="text-3xl leading-tight font-bold tracking-tight tabular-nums text-foreground">
              {value}
            </span>
            {suffix && (
              <span className="text-sm text-muted-foreground">{suffix}</span>
            )}
          </div>
          <span className="text-xs text-muted-foreground">{label}</span>
          {hasDelta && (
            <span
              className={cn(
                "mt-0.5 inline-flex items-center gap-1 text-xs tabular-nums",
                flat
                  ? "text-muted-foreground"
                  : good
                    ? "text-success-foreground"
                    : "text-destructive-fg",
              )}
            >
              {flat ? (
                <ArrowRight className="size-3" />
              ) : up ? (
                <ArrowUp className="size-3" />
              ) : (
                <ArrowDown className="size-3" />
              )}
              {flat ? "持平" : `${delta > 0 ? "+" : ""}${delta}`}
              <span className="text-muted-foreground">{deltaLabel}</span>
            </span>
          )}
          {hint && (
            <span className="mt-0.5 text-xs text-muted-foreground">{hint}</span>
          )}
        </>
      )}
    </div>
  );
}

/** StatCard 行容器：等分 + 换行，供概况区一行摆 4~6 个指标 */
export function StatCardRow({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-wrap gap-3", className)} {...props} />;
}

/* ══════════════════════════════════════════════════════════════════
   ScoreBadge —— §6
   得分/满分 `12/15` 等宽数字；得分率着色 ≥85% 绿 / 60–84% 中性 / <60% 红
   ══════════════════════════════════════════════════════════════════ */

export interface ScoreBadgeProps {
  score: number;
  full: number;
  /** 只显示得分（用于满分已在表头声明的场景） */
  hideFull?: boolean;
  size?: "sm" | "md";
  className?: string;
}

export function ScoreBadge({
  score,
  full,
  hideFull = false,
  size = "md",
  className,
}: ScoreBadgeProps) {
  const rate = full > 0 ? score / full : 0;
  const tone =
    rate >= 0.85 ? "good" : rate >= 0.6 ? "mid" : "bad";

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-sm font-medium tabular-nums",
        size === "sm" ? "h-5 px-1.5 text-xs" : "h-6 px-2 text-base",
        tone === "good" && "bg-success-soft text-success-foreground",
        tone === "mid" && "bg-secondary text-secondary-foreground",
        tone === "bad" && "bg-destructive-soft text-destructive-fg",
        className,
      )}
      title={`得分率 ${Math.round(rate * 100)}%`}
    >
      {score}
      {!hideFull && (
        <span className="opacity-60">/{full}</span>
      )}
    </span>
  );
}
