import * as React from "react";
import {
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
  type Table as TanstackTable,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { cn } from "../../../lib/utils";
import { EmptyState, ErrorState } from "./empty-state";
import { Skeleton } from "./feedback";
import { Pagination } from "./pagination";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableWrap,
} from "./table";

/**
 * DataTable —— DESIGN-SYSTEM §6（TanStack Table + 本系统 Table 原语）
 *
 * 内建 §7「异步四态」：loading(骨架) / error(重试) / empty(EmptyState) / success。
 * 列对齐规约通过 `meta.numeric` 声明（数字右对齐 + tabular-nums），
 * 操作列声明 `meta.action` 会自动右置并禁止排序。
 *
 * ⚠ ≥200 行请改用虚拟滚动，不要靠翻页硬撑（§6）。
 */

declare module "@tanstack/react-table" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends unknown, TValue> {
    /** 数字列：右对齐 + 等宽数字 */
    numeric?: boolean;
    /** 操作列：右置、不排序、不换行 */
    action?: boolean;
    /** 固定列宽（如 "w-24"），传 Tailwind 宽度类 */
    widthClass?: string;
  }
}

export interface DataTableProps<T> {
  columns: ColumnDef<T, any>[];
  data: T[];
  /** 骨架行数（loading 时），默认 8 */
  loading?: boolean;
  skeletonRows?: number;
  /** 非空即渲染 ErrorState */
  error?: string | null;
  onRetry?: () => void;
  /** 空态；不传则用默认「暂无数据」 */
  empty?: React.ReactNode;
  /** 行点击（列表→详情） */
  onRowClick?: (row: T) => void;
  /** 判定行是否处于选中/高亮态（如异常卷） */
  isRowSelected?: (row: T) => boolean;
  getRowId?: (row: T, index: number) => string;
  /** 开启客户端分页；传数字即每页条数 */
  pageSize?: number;
  pageSizeOptions?: readonly number[];
  /** 分页栏左侧附加信息 */
  paginationExtra?: React.ReactNode;
  /** 初始排序 */
  initialSorting?: SortingState;
  /** 表格外层高度限制（如 "max-h-[560px]"），配合 sticky 表头 */
  wrapClassName?: string;
  className?: string;
  /** 拿到 table 实例做外部控制（如导出当前视图） */
  tableRef?: (table: TanstackTable<T>) => void;
}

export function DataTable<T>({
  columns,
  data,
  loading = false,
  skeletonRows = 8,
  error = null,
  onRetry,
  empty,
  onRowClick,
  isRowSelected,
  getRowId,
  pageSize,
  pageSizeOptions,
  paginationExtra,
  initialSorting = [],
  wrapClassName,
  className,
  tableRef,
}: DataTableProps<T>) {
  const [sorting, setSorting] = React.useState<SortingState>(initialSorting);
  const [pageIndex, setPageIndex] = React.useState(0);
  const [size, setSize] = React.useState(pageSize ?? 0);

  const paginated = Boolean(pageSize);

  const table = useReactTable({
    data,
    columns,
    state: {
      sorting,
      ...(paginated ? { pagination: { pageIndex, pageSize: size } } : {}),
    },
    onSortingChange: setSorting,
    getRowId,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    ...(paginated ? { getPaginationRowModel: getPaginationRowModel() } : {}),
    manualPagination: !paginated,
  });

  React.useEffect(() => {
    tableRef?.(table);
  }, [table, tableRef]);

  const headerGroups = table.getHeaderGroups();
  const rows = table.getRowModel().rows;
  const colCount = table.getAllLeafColumns().length;

  const body = () => {
    if (loading) {
      return Array.from({ length: skeletonRows }, (_, r) => (
        <TableRow key={`sk-${r}`} className="hover:bg-transparent">
          {table.getAllLeafColumns().map((col) => (
            <TableCell key={col.id}>
              <Skeleton className="h-4 w-full max-w-40" />
            </TableCell>
          ))}
        </TableRow>
      ));
    }
    if (error) {
      return (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={colCount} className="h-auto p-0">
            <ErrorState size="sm" description={error} onRetry={onRetry} />
          </TableCell>
        </TableRow>
      );
    }
    if (rows.length === 0) {
      return (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={colCount} className="h-auto p-0">
            {empty ?? <EmptyState size="sm" title="暂无数据" />}
          </TableCell>
        </TableRow>
      );
    }
    return rows.map((row) => (
      <TableRow
        key={row.id}
        selected={isRowSelected?.(row.original)}
        clickable={Boolean(onRowClick)}
        onClick={onRowClick ? () => onRowClick(row.original) : undefined}
      >
        {row.getVisibleCells().map((cell) => {
          const meta = cell.column.columnDef.meta;
          return (
            <TableCell
              key={cell.id}
              numeric={meta?.numeric}
              className={cn(
                meta?.action && "text-right whitespace-nowrap",
                meta?.widthClass,
              )}
            >
              {flexRender(cell.column.columnDef.cell, cell.getContext())}
            </TableCell>
          );
        })}
      </TableRow>
    ));
  };

  return (
    <div className={cn("flex flex-col", className)}>
      <TableWrap className={wrapClassName}>
        <Table>
          <TableHeader>
            {headerGroups.map((group) => (
              <TableRow key={group.id} className="hover:bg-transparent">
                {group.headers.map((header) => {
                  const meta = header.column.columnDef.meta;
                  const sortable =
                    header.column.getCanSort() && !meta?.action && !loading;
                  const dir = header.column.getIsSorted();
                  return (
                    <TableHead
                      key={header.id}
                      numeric={meta?.numeric}
                      colSpan={header.colSpan}
                      className={cn(
                        meta?.action && "text-right",
                        meta?.widthClass,
                      )}
                      aria-sort={
                        dir === "asc"
                          ? "ascending"
                          : dir === "desc"
                            ? "descending"
                            : undefined
                      }
                    >
                      {header.isPlaceholder ? null : sortable ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className={cn(
                            "-mx-1 inline-flex h-6 items-center gap-1 rounded-xs px-1",
                            "text-xs font-medium text-muted-foreground",
                            "transition-colors duration-(--px-dur-1) ease-standard",
                            "hover:text-foreground",
                            "outline-none focus-visible:shadow-focus",
                            dir && "text-foreground",
                          )}
                        >
                          {flexRender(
                            header.column.columnDef.header,
                            header.getContext(),
                          )}
                          {dir === "asc" ? (
                            <ArrowUp className="size-3.5" />
                          ) : dir === "desc" ? (
                            <ArrowDown className="size-3.5" />
                          ) : (
                            <ChevronsUpDown className="size-3.5 opacity-50" />
                          )}
                        </button>
                      ) : (
                        flexRender(
                          header.column.columnDef.header,
                          header.getContext(),
                        )
                      )}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>{body()}</TableBody>
        </Table>
      </TableWrap>

      {paginated && !loading && !error && rows.length > 0 && (
        <Pagination
          total={data.length}
          page={pageIndex + 1}
          pageSize={size}
          onPageChange={(p) => setPageIndex(p - 1)}
          pageSizeOptions={pageSizeOptions}
          onPageSizeChange={
            pageSizeOptions
              ? (next) => {
                  setSize(next);
                  setPageIndex(0);
                }
              : undefined
          }
          extra={paginationExtra}
        />
      )}
    </div>
  );
}

export type { ColumnDef, SortingState };
