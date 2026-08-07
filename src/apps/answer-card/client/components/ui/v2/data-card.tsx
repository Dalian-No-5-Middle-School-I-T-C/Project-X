import type { ReactNode } from "react";
import { cn } from "../../../lib/utils";

/**
 * DataCard —— 移动端「表格卡片化」的统一容器（DESIGN-SYSTEM §6 数据展示）
 *
 * P5 迁移：替代旧 components/ui/DataCard.tsx（依赖 styles.css 的
 * .data-card-list / .data-card / .data-card-row 等 legacy 类）。
 * 本版本零手写 CSS，仅消费语义工具类，视觉与旧版一致：
 *   卡片 bg-card + border-border + rounded-lg(12px) + p-3(12px) + gap-2(8px)
 *   行   label 左 / value 右，baseline 对齐
 *   操作区 上分隔线 + 等宽平铺 + 触控高度下限
 */

export interface DataCardRow {
  label: string;
  value: ReactNode;
  /** 是否加粗强调（用于主字段如姓名/标题） */
  strong?: boolean;
}

export interface DataCardProps {
  rows: DataCardRow[];
  /** 卡片底部操作区（按钮/链接） */
  actions?: ReactNode;
  /** 点击整卡（可选，用于可点击卡片） */
  onClick?: () => void;
  className?: string;
}

/** 数据卡片列表容器：纵向排列，10px 间距（等价旧 .data-card-list） */
export function DataCardList({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn("flex flex-col gap-2.5", className)}>{children}</div>;
}

export function DataCard({ rows, actions, onClick, className }: DataCardProps) {
  const cardContent = (
    <>
      {rows.map((row, i) => (
        <div
          key={i}
          className="flex items-baseline justify-between gap-3 text-sm"
        >
          <span className="shrink-0 text-xs text-muted-foreground">
            {row.label}
          </span>
          <span
            className={cn(
              "break-words text-right text-foreground",
              row.strong && "font-medium",
            )}
          >
            {row.value}
          </span>
        </div>
      ))}
      {actions ? (
        <div
          className={cn(
            "mt-1 flex flex-wrap gap-2 border-t border-border pt-2",
            // 操作区内的按钮/链接等宽平铺，并保证移动端触控高度下限
            "[&>a]:min-h-touch [&>a]:min-w-0 [&>a]:flex-1",
            "[&>button]:min-h-touch [&>button]:min-w-0 [&>button]:flex-1",
          )}
        >
          {actions}
        </div>
      ) : null}
    </>
  );

  const base = "flex flex-col gap-2 rounded-lg border border-border bg-card p-3";

  if (onClick) {
    return (
      <div
        className={cn(
          base,
          "cursor-pointer transition-colors duration-(--px-dur-1) ease-standard",
          "hover:bg-secondary focus-visible:outline-none focus-visible:shadow-focus",
          className,
        )}
        onClick={onClick}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onClick();
          }
        }}
      >
        {cardContent}
      </div>
    );
  }

  return <div className={cn(base, className)}>{cardContent}</div>;
}
