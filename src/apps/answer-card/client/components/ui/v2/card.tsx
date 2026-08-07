import * as React from "react";
import { cn } from "../../../lib/utils";

/**
 * Card / Panel —— DESIGN-SYSTEM §6 + §4.3
 * 圆角 lg(12) + 1px border-subtle + 静止无阴影；
 * 可点击时 hover 抬升 shadow-2 + translateY(-2px)，160ms。
 */
export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** 可点击卡片：启用 hover 抬升与指针样式 */
  interactive?: boolean;
  /** 选中态：品牌红边 + 软底（列表卡片用） */
  selected?: boolean;
}

export const Card = React.forwardRef<HTMLDivElement, CardProps>(function Card(
  { className, interactive, selected, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      data-selected={selected || undefined}
      className={cn(
        "relative rounded-lg border border-border-subtle bg-card text-card-foreground",
        interactive && [
          "cursor-pointer",
          "transition-[box-shadow,transform,border-color] duration-(--px-dur-2) ease-out-token",
          "hover:-translate-y-0.5 hover:shadow-2 hover:border-border",
        ],
        selected && "border-primary bg-accent",
        className,
      )}
      {...props}
    />
  );
});

export const CardHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(function CardHeader({ className, ...props }, ref) {
  return (
    <div
      ref={ref}
      className={cn(
        "flex items-start justify-between gap-3 px-5 pt-5 pb-3",
        className,
      )}
      {...props}
    />
  );
});

export const CardTitle = React.forwardRef<
  HTMLHeadingElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(function CardTitle({ className, ...props }, ref) {
  return (
    <h3
      ref={ref}
      className={cn("m-0 text-lg font-semibold text-foreground", className)}
      {...props}
    />
  );
});

export const CardDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(function CardDescription({ className, ...props }, ref) {
  return (
    <p
      ref={ref}
      className={cn("m-0 text-sm text-muted-foreground", className)}
      {...props}
    />
  );
});

export const CardContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(function CardContent({ className, ...props }, ref) {
  return <div ref={ref} className={cn("px-5 pb-5", className)} {...props} />;
});

export const CardFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(function CardFooter({ className, ...props }, ref) {
  return (
    <div
      ref={ref}
      className={cn(
        "flex items-center justify-end gap-2 border-t border-border-subtle px-5 py-3",
        className,
      )}
      {...props}
    />
  );
});

/**
 * Panel：与 Card 同族，用于工作台内的区块容器
 * （无外边距、常配合 flex 布局撑满可用空间）。
 */
export const Panel = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(function Panel({ className, ...props }, ref) {
  return (
    <div
      ref={ref}
      className={cn(
        "flex min-h-0 flex-col rounded-lg border border-border-subtle bg-card",
        className,
      )}
      {...props}
    />
  );
});
