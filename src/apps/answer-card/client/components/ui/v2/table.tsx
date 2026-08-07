import * as React from "react";
import { cn } from "../../../lib/utils";

/**
 * Table 原语 —— DESIGN-SYSTEM §6
 * 表头 12px/500 fg-tertiary + bg-subtle + sticky；行高 44（紧凑 36，走 L3 令牌自动切换）；
 * **文字左对齐、数字右对齐、操作列右置**；hover 行 bg-subtle；**斑马纹禁用**。
 *
 * 手写表格用这套原语；带排序/分页/选择的表用 <DataTable>（data-table.tsx）。
 */

/** 滚动容器：表头 sticky 依赖它做滚动上下文 */
export function TableWrap({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("relative w-full overflow-auto", className)} {...props} />
  );
}

export const Table = React.forwardRef<
  HTMLTableElement,
  React.TableHTMLAttributes<HTMLTableElement>
>(function Table({ className, ...props }, ref) {
  return (
    <table
      ref={ref}
      className={cn("w-full border-collapse text-base", className)}
      {...props}
    />
  );
});

export const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(function TableHeader({ className, ...props }, ref) {
  return <thead ref={ref} className={cn("", className)} {...props} />;
});

export const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(function TableBody({ className, ...props }, ref) {
  return <tbody ref={ref} className={cn("", className)} {...props} />;
});

export const TableRow = React.forwardRef<
  HTMLTableRowElement,
  React.HTMLAttributes<HTMLTableRowElement> & {
    /** 选中/高亮行（如异常卷），用 accent-soft 而非斑马纹 */
    selected?: boolean;
    /** 可点开详情的行 */
    clickable?: boolean;
  }
>(function TableRow({ className, selected, clickable, ...props }, ref) {
  return (
    <tr
      ref={ref}
      data-selected={selected || undefined}
      className={cn(
        "border-b border-border-subtle last:border-b-0",
        "transition-colors duration-(--px-dur-1) ease-standard",
        "hover:bg-secondary",
        selected && "bg-accent hover:bg-accent-soft-hover",
        clickable && "cursor-pointer",
        className,
      )}
      {...props}
    />
  );
});

export const TableHead = React.forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement> & {
    /** 数字列：右对齐（§6 定死项） */
    numeric?: boolean;
  }
>(function TableHead({ className, numeric, ...props }, ref) {
  return (
    <th
      ref={ref}
      className={cn(
        "sticky top-0 z-(--px-z-sticky) h-table-header px-3",
        "bg-secondary text-xs font-medium whitespace-nowrap text-muted-foreground",
        "border-b border-border",
        numeric ? "text-right" : "text-left",
        className,
      )}
      {...props}
    />
  );
});

export const TableCell = React.forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement> & {
    numeric?: boolean;
  }
>(function TableCell({ className, numeric, ...props }, ref) {
  return (
    <td
      ref={ref}
      className={cn(
        "h-table-row px-3 align-middle text-foreground",
        numeric ? "text-right tabular-nums" : "text-left",
        className,
      )}
      {...props}
    />
  );
});

export function TableCaption({
  className,
  ...props
}: React.HTMLAttributes<HTMLTableCaptionElement>) {
  return (
    <caption
      className={cn("py-2 text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}
