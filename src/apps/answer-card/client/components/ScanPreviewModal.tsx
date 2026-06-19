import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

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

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { onClose(); return; }
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
  }, [onClose]);

  // Track which page is currently visible
  const handleScroll = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    const pageEls = container.querySelectorAll<HTMLElement>(".pdf-page-item");
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
    const el = container.querySelectorAll<HTMLElement>(".pdf-page-item")[index];
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  const hasScores = pages.some((p) => p.totalScore != null);
  const hasSides = pages.some((p) => p.side !== "front");

  return (
    <div className="pdf-modal-backdrop" onClick={onClose}>
      <div className="pdf-modal" onClick={(e) => e.stopPropagation()}>
        {/* Top bar */}
        <div className="pdf-modal-topbar">
          <div className="pdf-modal-info">
            <strong>{title}</strong>
            {subtitle && <span>{subtitle}</span>}
            <span>{pages.length} 页</span>
          </div>
          <button className="ghost-button" onClick={onClose} style={{ padding: "4px 10px" }}>
            <X size={18} />
          </button>
        </div>

        {/* PDF-style scrolling pages */}
        <div
          className="pdf-modal-scroll"
          ref={scrollRef}
          onScroll={handleScroll}
        >
          {pages.map((page, idx) => (
            <div key={page.recordId} className="pdf-page-item">
              <div className="pdf-page-label">
                <span>第 {page.pageNum} 页{hasSides ? ` · ${page.side === "front" ? "正面" : "反面"}` : ""}</span>
                {hasScores && page.totalScore != null && (
                  <span className="pdf-page-score">
                    {page.totalScore}/{page.totalMaxScore}
                    {" "}(客观 {page.objectiveScore ?? "—"} · 主观 {page.subjectiveScore ?? "—"})
                  </span>
                )}
              </div>
              <div className="pdf-page-image-wrapper">
                <img
                  src={page.imageUrl}
                  alt={`第${page.pageNum}页${hasSides ? (page.side === "front" ? " 正面" : " 反面") : ""}`}
                  className="pdf-page-image"
                  loading={idx < 2 ? "eager" : "lazy"}
                />
              </div>
            </div>
          ))}
        </div>

        {/* Bottom thumbnail navigation */}
        <div className="pdf-modal-bottombar">
          <span className="pdf-page-counter">
            {activePageIndex + 1} / {pages.length}
          </span>
          <div className="pdf-thumbnail-strip">
            {pages.map((page, idx) => (
              <button
                key={page.recordId}
                className={`pdf-thumbnail ${idx === activePageIndex ? "active" : ""}`}
                onClick={() => scrollToPage(idx)}
                title={`第${page.pageNum}页 ${page.side === "front" ? "正面" : "反面"}`}
              >
                <img
                  src={page.imageUrl}
                  alt={`第${page.pageNum}页`}
                  loading="lazy"
                />
                <span>P{page.pageNum}{hasSides ? (page.side === "front" ? "正" : "反") : ""}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
