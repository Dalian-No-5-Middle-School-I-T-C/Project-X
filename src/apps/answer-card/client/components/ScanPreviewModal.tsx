import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";
import {
  Badge,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/v2";

/**
 * ScanPreviewModal —— T2 迁移（T04 明细/订正/弹窗）
 *
 * 换肤范围（功能守恒，接口/路由/权限零改动）：
 *  · 手写 Portal + `.pdf-modal-*` 毛玻璃弹窗 → v2 `Dialog`
 *    （Radix 负责 ESC / 点遮罩关闭 / 焦点陷阱 / 层级令牌，删掉手写 ESC 分支）
 *  · 页面定位从 `.pdf-page-item` 类选择器改为 `[data-page-item]` 数据属性，
 *    与被删除的旧 CSS 彻底解耦
 *  · PageUp / PageDown 翻页与缩略图跳转行为原样保留
 */

export interface ScanPage {
  recordId: string;
  pageNum: number;
  side: string;
  imageUrl: string;
  objectiveScore?: number;
  subjectiveScore?: number;
  totalScore?: number;
  totalMaxScore?: number;
}

export interface ScanPreviewModalProps {
  title: string;
  subtitle?: string;
  pages: ScanPage[];
  onClose: () => void;
}

export function ScanPreviewModal({ title, subtitle, pages, onClose }: ScanPreviewModalProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [activePageIndex, setActivePageIndex] = useState(0);

  // Keyboard shortcuts（ESC 交给 Radix Dialog，这里只管翻页）
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "PageDown" || e.key === "PageUp") {
        e.preventDefault();
        const container = scrollRef.current;
        if (container) {
          container.scrollBy({
            top: (e.key === "PageDown" ? 1 : -1) * container.clientHeight * 0.8,
            behavior: "smooth"
          });
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Track which page is currently visible
  const handleScroll = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    const pageEls = container.querySelectorAll<HTMLElement>("[data-page-item]");
    let bestIdx = 0;
    let bestDist = Infinity;
    const midY = container.scrollTop + container.clientHeight / 2;
    pageEls.forEach((el, idx) => {
      const center = el.offsetTop + el.offsetHeight / 2;
      const dist = Math.abs(center - midY);
      if (dist < bestDist) { bestDist = dist; bestIdx = idx; }
    });
    setActivePageIndex(bestIdx);
  }, []);

  function scrollToPage(index: number) {
    const container = scrollRef.current;
    if (!container) return;
    const el = container.querySelectorAll<HTMLElement>("[data-page-item]")[index];
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  const hasScores = pages.some((p) => p.totalScore != null);
  const hasSides = pages.some((p) => p.side !== "front");

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent size="lg" className="h-[92vh] max-w-[min(92vw,900px)]">
        <DialogHeader>
          <DialogTitle className="truncate text-base">{title}</DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-3">
            {subtitle && <span className="truncate">{subtitle}</span>}
            <span className="tabular-nums">{pages.length} 页</span>
          </DialogDescription>
        </DialogHeader>

        {/* PDF-style scrolling pages */}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="flex min-h-0 flex-1 scroll-smooth flex-col items-center gap-7 overflow-x-hidden overflow-y-auto bg-background p-6"
        >
          {pages.map((page, idx) => (
            <div
              key={page.recordId}
              data-page-item=""
              className="flex w-full max-w-[760px] flex-col gap-2.5"
            >
              <div className="flex items-center justify-between gap-3 px-1 text-sm font-semibold text-muted-foreground">
                <span>
                  第 <span className="tabular-nums">{page.pageNum}</span> 页
                  {hasSides ? ` · ${page.side === "front" ? "正面" : "反面"}` : ""}
                </span>
                {hasScores && page.totalScore != null && (
                  <Badge tone="accent" className="tabular-nums">
                    {page.totalScore}/{page.totalMaxScore}
                    {" "}(客观 {page.objectiveScore ?? "—"} · 主观 {page.subjectiveScore ?? "—"})
                  </Badge>
                )}
              </div>
              <div className="flex justify-center overflow-hidden rounded-lg bg-paper shadow-2">
                <img
                  src={page.imageUrl}
                  alt={`第${page.pageNum}页${hasSides ? (page.side === "front" ? " 正面" : " 反面") : ""}`}
                  className="block h-auto w-full"
                  loading={idx < 2 ? "eager" : "lazy"}
                />
              </div>
            </div>
          ))}
        </div>

        {/* Bottom thumbnail navigation */}
        <div className="flex shrink-0 items-center gap-3 border-t border-border-subtle px-5 py-3">
          <span className="min-w-12 shrink-0 text-xs font-semibold tabular-nums whitespace-nowrap text-muted-foreground">
            {activePageIndex + 1} / {pages.length}
          </span>
          <div className="flex flex-1 gap-2 overflow-x-auto py-0.5">
            {pages.map((page, idx) => (
              <button
                key={page.recordId}
                type="button"
                onClick={() => scrollToPage(idx)}
                title={`第${page.pageNum}页 ${page.side === "front" ? "正面" : "反面"}`}
                aria-current={idx === activePageIndex || undefined}
                className={cn(
                  "flex shrink-0 flex-col items-center gap-0.5 overflow-hidden rounded-md border-2 bg-card p-0",
                  "transition-[border-color,color] duration-(--px-dur-1) ease-standard",
                  "outline-none focus-visible:shadow-focus",
                  idx === activePageIndex
                    ? "border-primary text-primary"
                    : "border-border text-muted-foreground hover:border-border-strong",
                )}
              >
                <img
                  src={page.imageUrl}
                  alt={`第${page.pageNum}页`}
                  loading="lazy"
                  className="block h-19 w-14 object-cover"
                />
                <span className="px-1 pb-1 text-xs font-medium whitespace-nowrap tabular-nums">
                  P{page.pageNum}{hasSides ? (page.side === "front" ? "正" : "反") : ""}
                </span>
              </button>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
