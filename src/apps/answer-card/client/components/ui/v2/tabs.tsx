import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "../../../lib/utils";

/**
 * Tabs —— DESIGN-SYSTEM §6
 * **下划线式唯一形态**：选中 = 文本主色 + 2px 品牌红下划线；未选 = 三级文本色。
 * 不提供胶囊/卡片式分叉（考试详情 6 Tab 亦归此）。
 */

export const Tabs = TabsPrimitive.Root;

export const TabsList = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(function TabsList({ className, ...props }, ref) {
  return (
    <TabsPrimitive.List
      ref={ref}
      className={cn(
        "flex items-center gap-1 overflow-x-auto border-b border-border-subtle",
        className,
      )}
      {...props}
    />
  );
});

export const TabsTrigger = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(function TabsTrigger({ className, children, ...props }, ref) {
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(
        // border-0 覆盖 Chrome UA button 默认边框（Preflight 未引入，详见 app.css）
        "relative inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap border-0 px-3",
        "text-base font-medium text-muted-foreground",
        "transition-colors duration-(--px-dur-1) ease-standard",
        "hover:text-foreground",
        "outline-none focus-visible:shadow-focus focus-visible:rounded-xs",
        "disabled:pointer-events-none disabled:opacity-50",
        "data-[state=active]:text-foreground",
        // 2px 品牌红下划线：压在 List 的 1px 底边之上（-bottom-px）
        "after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full",
        "after:bg-transparent data-[state=active]:after:bg-primary",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      {children}
    </TabsPrimitive.Trigger>
  );
});

export const TabsContent = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(function TabsContent({ className, ...props }, ref) {
  return (
    <TabsPrimitive.Content
      ref={ref}
      className={cn("outline-none focus-visible:shadow-focus", className)}
      {...props}
    />
  );
});

/** Tab 标题右侧的计数徽标（如「异常卷 12」），等宽数字防跳动 */
export function TabsCount({
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex min-w-5 items-center justify-center rounded-full px-1.5",
        "bg-secondary text-xs tabular-nums text-secondary-foreground",
        className,
      )}
      {...props}
    />
  );
}
