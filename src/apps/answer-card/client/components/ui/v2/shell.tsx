import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { AlertCircle, Check, Loader2, RotateCw } from "lucide-react";
import { cn } from "../../../lib/utils";
import { Tip } from "./tooltip";

/**
 * 应用外壳 —— DESIGN-SYSTEM §5.1
 *
 * ┌──────────┬─────────────────────────────────┐
 * │          │ PageHeader                 60px │
 * │ AppRail  ├─────────────────────────────────┤
 * │  232px   │ [ContextPanel 300px] Content    │
 * │ ↔ 64px   ├─────────────────────────────────┤
 * │          │ StatusBar                  30px │
 * └──────────┴─────────────────────────────────┘
 *
 * 所有尺寸走 L3 令牌（w-rail / h-page-header / h-statusbar…），
 * [data-density="compact"] 与移动端断点由令牌与工具类接管，组件不写分支。
 * 路由/权限逻辑一律留在调用方，本文件只负责骨架与视觉。
 */

/* ── AppShell 骨架 ───────────────────────────────────────────────── */

export function AppShell({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex h-screen w-full overflow-hidden bg-background", className)}
      {...props}
    />
  );
}

/** 右侧主区（Header + Content + StatusBar 的纵向容器） */
export function AppMain({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex min-w-0 flex-1 flex-col overflow-hidden", className)}
      {...props}
    />
  );
}

/** 内容区：横向承载可选 ContextPanel + 滚动内容 */
export function AppContentRow({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex min-h-0 flex-1 overflow-hidden", className)}
      {...props}
    />
  );
}

export interface AppContentProps extends React.HTMLAttributes<HTMLElement> {
  /** 内容最大宽度：normal=1200 / wide=1440 / full=不限（画布类页面） */
  width?: "normal" | "wide" | "full";
  /** 去掉默认内边距（画布类页面自行铺满） */
  bare?: boolean;
}

export function AppContent({
  className,
  width = "normal",
  bare = false,
  children,
  ...props
}: AppContentProps) {
  return (
    <main
      className={cn("min-w-0 flex-1 overflow-auto", className)}
      {...props}
    >
      <div
        className={cn(
          "mx-auto w-full",
          !bare && "p-6",
          bare && "h-full",
          width === "normal" && "max-w-content",
          width === "wide" && "max-w-content-wide",
        )}
      >
        {children}
      </div>
    </main>
  );
}

/* ── AppRail 主导航栏 ─────────────────────────────────────────────── */

export interface AppRailProps extends React.HTMLAttributes<HTMLElement> {
  collapsed?: boolean;
}

export function AppRail({
  className,
  collapsed = false,
  ...props
}: AppRailProps) {
  return (
    <aside
      data-collapsed={collapsed || undefined}
      className={cn(
        "relative z-30 flex shrink-0 flex-col gap-0.5 overflow-visible border-r border-border-subtle bg-card max-[640px]:hidden",
        "transition-[width] duration-(--px-dur-2) ease-standard",
        collapsed ? "w-rail-collapsed px-2 py-3" : "w-rail px-2.5 py-3",
        className,
      )}
      {...props}
    />
  );
}

export interface AppRailBrandProps {
  /** 校徽/系统标志；不传则用系统名首字 */
  logo?: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  collapsed?: boolean;
  className?: string;
}

export function AppRailBrand({
  logo,
  title,
  subtitle,
  collapsed = false,
  className,
}: AppRailBrandProps) {
  return (
    <div
      className={cn(
        "mb-2 flex items-center gap-2.5 px-1",
        collapsed && "justify-center px-0",
        className,
      )}
    >
      <span className="flex size-8.5 shrink-0 items-center justify-center overflow-hidden rounded-md bg-primary text-base font-bold text-primary-foreground">
        {logo}
      </span>
      {!collapsed && (
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-semibold text-foreground">
            {title}
          </span>
          {subtitle && (
            <span className="truncate text-xs text-muted-foreground">
              {subtitle}
            </span>
          )}
        </span>
      )}
    </div>
  );
}

export function AppRailNav({
  className,
  ...props
}: React.HTMLAttributes<HTMLElement>) {
  return (
    <nav
      className={cn("flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto", className)}
      {...props}
    />
  );
}

/** 导航分组标题（收起时自动隐藏，仅留分隔线） */
export function AppRailGroupLabel({
  className,
  collapsed,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { collapsed?: boolean }) {
  if (collapsed) {
    return <div className="mx-2 my-1.5 h-px bg-border-subtle" aria-hidden />;
  }
  return (
    <div
      className={cn(
        "mt-3 mb-1 px-2 text-xs font-medium text-muted-foreground",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export interface AppRailItemProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: React.ReactNode;
  label: React.ReactNode;
  active?: boolean;
  collapsed?: boolean;
  /** 右侧计数/状态点，如未读异常卷数 */
  badge?: React.ReactNode;
  /** 套到 <NavLink>/<a> 上 */
  asChild?: boolean;
}

/**
 * 选中态（§5.1 定死项）：浅红底 + 品牌红文字 + 左侧 3px 指示条。
 * 收起时自动挂 Tooltip（§6 IconButton 规约）。
 */
export const AppRailItem = React.forwardRef<
  HTMLButtonElement,
  AppRailItemProps
>(function AppRailItem(
  {
    className,
    icon,
    label,
    active = false,
    collapsed = false,
    badge,
    asChild = false,
    children,
    ...props
  },
  ref,
) {
  const Comp = asChild ? Slot : "button";
  const node = (
    <Comp
      ref={ref}
      data-active={active || undefined}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative flex h-9 shrink-0 items-center gap-2.5 rounded-md text-base font-medium",
        "border-0 bg-transparent",
        "transition-colors duration-(--px-dur-1) ease-standard",
        "outline-none focus-visible:shadow-focus",
        collapsed ? "justify-center px-0" : "px-2.5",
        active
          ? "bg-accent font-semibold text-accent-foreground"
          : "text-secondary-foreground hover:bg-secondary hover:text-foreground",
        // 左侧 3px 指示条
        "before:absolute before:top-2 before:bottom-2 before:-left-1.5 before:w-[3px] before:rounded-full",
        active ? "before:bg-primary" : "before:bg-transparent",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      {asChild ? (
        children
      ) : (
        <>
          {icon}
          {!collapsed && <span className="min-w-0 flex-1 truncate">{label}</span>}
          {!collapsed && badge}
        </>
      )}
    </Comp>
  );

  return collapsed ? (
    <Tip label={label} side="right">
      {node}
    </Tip>
  ) : (
    node
  );
});

/** 底部区：主题切换 + 账号入口（demo.html rail 底部「头像+姓名+更多」蓝本） */
export function AppRailFooter({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-2 border-t border-border-subtle px-2 py-2",
        className,
      )}
      {...props}
    />
  );
}

/* ── PageHeader ───────────────────────────────────────────────────── */

export interface PageHeaderProps {
  title: React.ReactNode;
  /** 一句副标题，说清这页在干什么 */
  subtitle?: React.ReactNode;
  /** 标题左侧（返回按钮 / 面包屑） */
  leading?: React.ReactNode;
  /** 右置动作区：主按钮 ≤1（§5.1） */
  actions?: React.ReactNode;
  className?: string;
}

export function PageHeader({
  title,
  subtitle,
  leading,
  actions,
  className,
}: PageHeaderProps) {
  return (
    <header
      className={cn(
        "flex h-page-header shrink-0 items-center gap-4 border-b border-border-subtle bg-card px-6",
        className,
      )}
    >
      {leading}
      <div className="flex min-w-0 flex-1 flex-col">
        <h1 className="truncate text-lg font-semibold text-foreground">
          {title}
        </h1>
        {subtitle && (
          <span className="truncate text-xs text-muted-foreground">
            {subtitle}
          </span>
        )}
      </div>
      {actions && (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      )}
    </header>
  );
}

/* ── ContextPanel（300px，仅设计模式等确有需要的模块）───────────────── */

export function ContextPanel({
  className,
  ...props
}: React.HTMLAttributes<HTMLElement>) {
  return (
    <aside
      className={cn(
        "flex w-context-panel shrink-0 flex-col overflow-hidden border-r border-border-subtle bg-card",
        className,
      )}
      {...props}
    />
  );
}

export function ContextPanelHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border-subtle px-3",
        className,
      )}
      {...props}
    />
  );
}

export function ContextPanelBody({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2.5", className)}
      {...props}
    />
  );
}

export interface ContextItemProps
  // 让位于富文本标题；原生 title 提示请改用 <Tip>
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "title"> {
  icon?: React.ReactNode;
  title: React.ReactNode;
  meta?: React.ReactNode;
  active?: boolean;
  /** 右侧操作（拖拽手柄/删除），点击不冒泡到选中 */
  trailing?: React.ReactNode;
}

/** 上下文列表项（设计器题块列表）：选中 = 左侧 3px 品牌红条 + accent-soft 底 */
export const ContextItem = React.forwardRef<HTMLButtonElement, ContextItemProps>(
  function ContextItem(
    { className, icon, title, meta, active = false, trailing, ...props },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type="button"
        data-active={active || undefined}
        className={cn(
          "group flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-left",
          "border border-border-subtle border-l-[3px]",
          "transition-colors duration-(--px-dur-1) ease-standard",
          "outline-none focus-visible:shadow-focus",
          active
            ? "border-l-primary bg-accent"
            : "border-l-transparent bg-card hover:bg-secondary",
          "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
          className,
        )}
        {...props}
      >
        {icon && (
          <span className={cn(active ? "text-primary" : "text-muted-foreground")}>
            {icon}
          </span>
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          <span
            className={cn(
              "truncate text-sm font-medium",
              active ? "text-accent-foreground" : "text-foreground",
            )}
          >
            {title}
          </span>
          {meta && (
            <span className="truncate text-xs text-muted-foreground">{meta}</span>
          )}
        </span>
        {trailing && <span className="shrink-0">{trailing}</span>}
      </button>
    );
  },
);

/* ── StatusBar ────────────────────────────────────────────────────── */

export function StatusBar({
  className,
  ...props
}: React.HTMLAttributes<HTMLElement>) {
  return (
    <footer
      className={cn(
        "flex h-statusbar shrink-0 items-center gap-4 border-t border-border-subtle bg-card px-4",
        "text-xs text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

const statusDotTone = {
  ok: "bg-success",
  warn: "bg-warning",
  error: "bg-destructive",
  idle: "bg-border-strong",
} as const;

export interface StatusItemProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: keyof typeof statusDotTone;
  /** 不显示状态点（纯文字项，如版本号） */
  plain?: boolean;
}

export function StatusItem({
  className,
  tone = "ok",
  plain = false,
  children,
  ...props
}: StatusItemProps) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)} {...props}>
      {!plain && (
        <span
          className={cn("size-1.5 rounded-full", statusDotTone[tone])}
          aria-hidden
        />
      )}
      {children}
    </span>
  );
}

/** 把左右两组状态推开 */
export function StatusSpacer() {
  return <span className="flex-1" />;
}

export type SaveState = "idle" | "editing" | "saving" | "saved" | "error";

export interface SaveStatusProps {
  state: SaveState;
  /** 最近一次保存成功时间，建议传 "HH:mm" */
  savedAt?: string;
  onRetry?: () => void;
  className?: string;
}

/**
 * 自动保存状态机（§7）：编辑 →(1s 防抖)→ 保存中 → 已保存 HH:mm / 失败(重试)。
 * 防抖与实际保存由调用方的 hook 负责，本组件只呈现状态。
 */
export function SaveStatus({
  state,
  savedAt,
  onRetry,
  className,
}: SaveStatusProps) {
  if (state === "idle") return null;
  return (
    <span
      className={cn("inline-flex items-center gap-1.5", className)}
      aria-live="polite"
    >
      {state === "editing" && (
        <>
          <span className="size-1.5 rounded-full bg-border-strong" aria-hidden />
          待保存
        </>
      )}
      {state === "saving" && (
        <>
          <Loader2 className="size-3 animate-spin" aria-hidden />
          保存中…
        </>
      )}
      {state === "saved" && (
        <>
          <Check className="size-3 text-success" aria-hidden />
          已保存{savedAt ? ` ${savedAt}` : ""}
        </>
      )}
      {state === "error" && (
        <>
          <AlertCircle className="size-3 text-destructive" aria-hidden />
          <span className="text-destructive-fg">保存失败</span>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className={cn(
                "inline-flex items-center gap-1 rounded-xs px-1 text-xs",
                "text-destructive-fg underline-offset-2",
                "transition-colors duration-(--px-dur-1) ease-standard hover:underline",
                "outline-none focus-visible:shadow-focus",
              )}
            >
              <RotateCw className="size-3" />
              重试
            </button>
          )}
        </>
      )}
    </span>
  );
}
