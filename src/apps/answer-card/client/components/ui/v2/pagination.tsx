import * as React from "react";
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";
import { cn } from "../../../lib/utils";
import { Button } from "./button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select";

/**
 * Pagination —— DESIGN-SYSTEM §6
 * 表格统一底栏：左「共 N 条」、右翻页。≥200 行的表改用虚拟滚动，不要靠翻页硬撑。
 */

/** 生成页码序列，中间用 "…" 折叠（总页数 ≤7 时全展开） */
function pageItems(page: number, pageCount: number): (number | "…")[] {
  if (pageCount <= 7) {
    return Array.from({ length: pageCount }, (_, i) => i + 1);
  }
  const items: (number | "…")[] = [1];
  const start = Math.max(2, page - 1);
  const end = Math.min(pageCount - 1, page + 1);
  if (start > 2) items.push("…");
  for (let i = start; i <= end; i += 1) items.push(i);
  if (end < pageCount - 1) items.push("…");
  items.push(pageCount);
  return items;
}

export interface PaginationProps {
  /** 总条数 */
  total: number;
  /** 当前页（1 起） */
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  /** 传入则显示每页条数选择器 */
  pageSizeOptions?: readonly number[];
  onPageSizeChange?: (size: number) => void;
  /** 左侧附加信息（如「已选 3 项」），置于「共 N 条」之后 */
  extra?: React.ReactNode;
  className?: string;
}

export function Pagination({
  total,
  page,
  pageSize,
  onPageChange,
  pageSizeOptions,
  onPageSizeChange,
  extra,
  className,
}: PaginationProps) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), pageCount);
  const items = pageItems(safePage, pageCount);

  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle px-4 py-2.5",
        className,
      )}
    >
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <span>
          共 <span className="tabular-nums text-foreground">{total}</span> 条
        </span>
        {extra}
        {pageSizeOptions && onPageSizeChange && (
          <Select
            value={String(pageSize)}
            onValueChange={(v) => onPageSizeChange(Number(v))}
          >
            <SelectTrigger className="h-control-sm w-24 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {pageSizeOptions.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size} 条/页
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      <nav className="flex items-center gap-1" aria-label="分页">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="首页"
          disabled={safePage <= 1}
          onClick={() => onPageChange(1)}
        >
          <ChevronsLeft />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="上一页"
          disabled={safePage <= 1}
          onClick={() => onPageChange(safePage - 1)}
        >
          <ChevronLeft />
        </Button>

        {items.map((item, index) =>
          item === "…" ? (
            <span
              key={`gap-${index}`}
              className="px-1 text-sm text-muted-foreground select-none"
              aria-hidden
            >
              …
            </span>
          ) : (
            <Button
              key={item}
              variant={item === safePage ? "primary" : "ghost"}
              size="icon-sm"
              aria-current={item === safePage ? "page" : undefined}
              className="tabular-nums"
              onClick={() => onPageChange(item)}
            >
              {item}
            </Button>
          ),
        )}

        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="下一页"
          disabled={safePage >= pageCount}
          onClick={() => onPageChange(safePage + 1)}
        >
          <ChevronRight />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="末页"
          disabled={safePage >= pageCount}
          onClick={() => onPageChange(pageCount)}
        >
          <ChevronsRight />
        </Button>
      </nav>
    </div>
  );
}
