import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "../../../lib/utils";

/**
 * Tooltip —— DESIGN-SYSTEM §6
 * 仅解释图标 / 截断文本，200ms 延迟，禁止放交互内容。
 * 反色底（bg-inverse）+ 12px 文字，层级 z-(--px-z-dropdown)。
 *
 * 用法：应用根部挂一次 <TooltipProvider>，页面里直接用 <Tip label="…">。
 */

export const TooltipProvider = TooltipPrimitive.Provider;
export const TooltipRoot = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export const TooltipContent = React.forwardRef<
  React.ComponentRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(function TooltipContent({ className, sideOffset = 6, ...props }, ref) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn(
          "max-w-64 rounded-sm px-2 py-1.5 text-xs",
          "bg-inverse text-inverse-foreground shadow-3",
          "z-(--px-z-dropdown)",
          "data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95",
          "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          "duration-(--px-dur-1) ease-standard",
          className,
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
});

export interface TipProps
  extends Pick<
    React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>,
    "side" | "align" | "sideOffset"
  > {
  /** 提示文案；为空则不渲染提示层（便于条件禁用） */
  label?: React.ReactNode;
  /** 触发元素（必须能接收 ref 与事件） */
  children: React.ReactElement;
  /** 覆盖默认 200ms 延迟（§6 定死项，非必要不改） */
  delayDuration?: number;
}

/** 常用糖：一行给图标按钮/截断文本加提示 */
export function Tip({
  label,
  children,
  side = "top",
  align = "center",
  sideOffset,
  delayDuration = 200,
}: TipProps) {
  if (!label) return children;
  return (
    <TooltipRoot delayDuration={delayDuration}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} align={align} sideOffset={sideOffset}>
        {label}
      </TooltipContent>
    </TooltipRoot>
  );
}
