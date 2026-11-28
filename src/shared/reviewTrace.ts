import type { ReviewTraceItem } from "./types";

export const TRACE_STATUS_OPTIONS = [
  { value: "all", label: "全部状态" },
  { value: "ready", label: "待阅" },
  { value: "claimed", label: "已领取" },
  { value: "pending", label: "待复核" },
  { value: "reviewed", label: "已审" },
  { value: "disputed", label: "争议中" },
  { value: "shelved", label: "已搁置" },
] as const;

const STATUS_LABELS: Record<string, string> = Object.fromEntries(
  TRACE_STATUS_OPTIONS.filter(option => option.value !== "all").map(option => [option.value, option.label])
);

export const TRACE_PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const;

export function traceStatusLabel(status: string): string {
  return STATUS_LABELS[status] ?? "未知状态";
}

export function traceStatusTone(status: string): "success" | "danger" | "warning" | "neutral" | "info" {
  if (status === "reviewed") return "success";
  if (status === "disputed") return "danger";
  if (status === "pending" || status === "shelved") return "warning";
  if (status === "claimed") return "info";
  return "neutral";
}

export type TraceFilter = {
  q?: string;
  status?: string;
  blockId?: string;
};

/** Filter only data returned by the already-authorized trace endpoint. */
export function filterReviewTrace(items: ReviewTraceItem[], filter: TraceFilter): ReviewTraceItem[] {
  const query = filter.q?.trim().toLocaleLowerCase() ?? "";
  return items.filter(item => {
    if (filter.status && filter.status !== "all" && item.status !== filter.status) return false;
    const blockId = (item as ReviewTraceItem & { blockId?: string }).blockId;
    if (filter.blockId && blockId !== filter.blockId) return false;
    if (!query) return true;
    const haystack = [item.studentName, item.studentNumber, item.blockTitle,
      ...item.rounds.map(round => round.reviewerName), item.resolvedBy ?? ""]
      .join(" ").toLocaleLowerCase();
    return haystack.includes(query);
  });
}

/** Bounded client pagination while the trace API has no page/pageSize contract. */
export function paginateReviewTrace<T>(items: T[], page: number, pageSize: number): {
  page: number;
  pageCount: number;
  rows: T[];
} {
  const safeSize = TRACE_PAGE_SIZE_OPTIONS.includes(pageSize as (typeof TRACE_PAGE_SIZE_OPTIONS)[number]) ? pageSize : 20;
  const pageCount = Math.max(1, Math.ceil(items.length / safeSize));
  const safePage = Math.min(Math.max(1, Math.floor(page) || 1), pageCount);
  const start = (safePage - 1) * safeSize;
  return { page: safePage, pageCount, rows: items.slice(start, start + safeSize) };
}
