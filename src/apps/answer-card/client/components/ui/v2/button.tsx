import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { cn } from "../../../lib/utils";

/**
 * Button —— DESIGN-SYSTEM §6
 * 5 变体 · 3 尺寸（+2 图标档）· loading 态强制 · 图标与文字间距 8px
 *
 * 高度取 --px-control-h-*，因此 [data-density="compact"] 下自动变矮，
 * 组件内不写任何密度分支。
 */
const buttonVariants = cva(
  [
    "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap",
    "rounded-md font-medium select-none",
    "border border-transparent",
    // §4.4 微反馈 100ms，只变色不位移
    "transition-[background-color,border-color,color,box-shadow] duration-(--px-dur-1) ease-standard",
    // §4.5 全局唯一焦点环：2px 底色 + 4px 品牌红 30%
    "outline-none focus-visible:shadow-focus",
    "disabled:pointer-events-none disabled:opacity-50",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  ],
  {
    variants: {
      variant: {
        primary:
          "bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-active",
        secondary:
          "bg-secondary text-foreground border-border hover:bg-muted",
        outline:
          "bg-card text-foreground border-border hover:bg-secondary hover:border-border-strong",
        ghost:
          "bg-transparent text-secondary-foreground hover:bg-secondary hover:text-foreground",
        destructive:
          "bg-destructive text-primary-foreground hover:bg-destructive-hover active:bg-destructive-active",
      },
      size: {
        sm: "h-control-sm px-3 text-sm",
        md: "h-control-md px-4 text-base",
        lg: "h-control-lg px-5 text-base",
        icon: "h-control-md w-control-md p-0",
        "icon-sm": "h-control-sm w-control-sm p-0",
      },
      block: {
        true: "w-full",
        false: "",
      },
    },
    defaultVariants: {
      variant: "secondary",
      size: "md",
      block: false,
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** 以子元素为宿主渲染（用于把按钮样式套到 <a>/<Link> 上） */
  asChild?: boolean;
  /** 加载中：spinner 顶替前置图标并禁用交互（§6 强制项） */
  loading?: boolean;
  /** 文字前图标，loading 时被 spinner 顶替 */
  icon?: React.ReactNode;
  /** 文字后图标（如下拉箭头） */
  iconRight?: React.ReactNode;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      className,
      variant,
      size,
      block,
      asChild = false,
      loading = false,
      icon,
      iconRight,
      disabled,
      children,
      ...props
    },
    ref,
  ) {
    // asChild 场景下 Slot 只接受单个子元素，不注入 spinner/图标包装
    if (asChild) {
      return (
        <Slot
          ref={ref}
          className={cn(buttonVariants({ variant, size, block }), className)}
          {...props}
        >
          {children}
        </Slot>
      );
    }

    return (
      <button
        ref={ref}
        className={cn(buttonVariants({ variant, size, block }), className)}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        {...props}
      >
        {loading ? (
          <Loader2 className="size-4 animate-spin" aria-hidden />
        ) : (
          icon
        )}
        {children}
        {!loading && iconRight}
      </button>
    );
  },
);

export { buttonVariants };
