import * as React from "react";
import * as ToggleGroupPrimitive from "@radix-ui/react-toggle-group";
import { cn } from "../../../lib/utils";
import { Tip } from "./tooltip";

/**
 * SegmentedControl —— DESIGN-SYSTEM §6（基座 ToggleGroup）
 * 容器 bg-subtle 圆角 8；选中项浮起（亮色白底 / 暗色升面）+ shadow-1。
 * 仅用于 ≤5 项的视图切换（设计器预览工具栏、分析图表维度切换等）。
 *
 * 单选语义：再次点击已选项不会取消（视图切换必须恒有选中项）。
 */

export interface SegmentedItem<T extends string> {
  value: T;
  /** 文字标签；纯图标项可省略，但必须给 ariaLabel */
  label?: React.ReactNode;
  icon?: React.ReactNode;
  /** 纯图标项必填（§6 IconButton 规约：aria-label + Tooltip） */
  ariaLabel?: string;
  /** 悬停提示，纯图标项建议填 */
  tip?: React.ReactNode;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  value: T;
  onValueChange: (value: T) => void;
  items: readonly SegmentedItem<T>[];
  size?: "sm" | "md";
  /** 撑满容器宽度并等分 */
  block?: boolean;
  className?: string;
  "aria-label"?: string;
}

export function SegmentedControl<T extends string>({
  value,
  onValueChange,
  items,
  size = "md",
  block = false,
  className,
  "aria-label": ariaLabel,
}: SegmentedControlProps<T>) {
  return (
    <ToggleGroupPrimitive.Root
      type="single"
      value={value}
      // 空串 = Radix 的取消选中，视图切换场景一律忽略
      onValueChange={(next) => {
        if (next) onValueChange(next as T);
      }}
      aria-label={ariaLabel}
      className={cn(
        "inline-flex items-center gap-0.5 rounded-md bg-secondary p-0.5",
        block && "flex w-full",
        className,
      )}
    >
      {items.map((item) => {
        const node = (
          <ToggleGroupPrimitive.Item
            key={item.value}
            value={item.value}
            disabled={item.disabled}
            aria-label={item.ariaLabel}
            className={cn(
              "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-sm whitespace-nowrap",
              "border-0 bg-transparent",
              "font-medium text-muted-foreground",
              "transition-[background-color,color,box-shadow] duration-(--px-dur-1) ease-standard",
              "hover:text-foreground",
              "outline-none focus-visible:shadow-focus",
              "disabled:pointer-events-none disabled:opacity-50",
              // 选中态：浮起一层（亮色=白面，暗色=升面），仅 shadow-1，不做位移
              "data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-1",
              size === "sm"
                ? "h-7 px-2 text-sm"
                : "h-8 px-3 text-base",
              !item.label && (size === "sm" ? "w-7 px-0" : "w-8 px-0"),
              block && "flex-1",
              "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
            )}
          >
            {item.icon}
            {item.label}
          </ToggleGroupPrimitive.Item>
        );
        return item.tip ? (
          <Tip key={item.value} label={item.tip}>
            {node}
          </Tip>
        ) : (
          node
        );
      })}
    </ToggleGroupPrimitive.Root>
  );
}

/** 需要多选（如筛选标签组）时用原语自行组装，样式沿用上面的配方 */
export const ToggleGroup = ToggleGroupPrimitive.Root;
export const ToggleGroupItem = ToggleGroupPrimitive.Item;
