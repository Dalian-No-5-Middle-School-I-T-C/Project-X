import { useEffect, useRef, useState, useCallback } from "react";
import { Camera, Play, Square, RefreshCw, AlertTriangle, Check, Loader, Eye, X } from "lucide-react";
import type { ScannerSourcesResult, ScanProgressEvent } from "../../server/scanner/scanner-types";

interface ScannerPanelProps {
  cardId: string;
  onScansComplete?: (sessionId: string, pageCount: number) => void;
  onClose?: () => void;
}

type ScannerState =
  | "idle"
  | "detecting"
  | "ready"
  | "scanning"
  | "recognizing"
  | "done"
  | "error";

interface ScanPage {
  pageNum: number;
  side: string;
  studentId: string | null;
  studentConf: number | null;
  ocrStatus: string;
}

interface PageResult {
  recordId: string;
  pageNum: number;
  side: string;
  imagePath: string;
  objectiveScore: number;
  subjectiveScore: number;
  totalScore: number;
  totalMaxScore: number;
  needsReviewCount: number;
}

interface StudentResult {
  studentId: string;
  totalScore: number;
  maxScore: number;
  pageCount: number;
  objectiveScore: number;
  subjectiveScore: number;
  needsReviewCount: number;
  pages: PageResult[];
}

export function ScannerPanel({ cardId, onScansComplete, onClose }: ScannerPanelProps) {
  const [state, setState] = useState<ScannerState>("idle");
  const [sources, setSources] = useState<string[]>([]);
  const [selectedSource, setSelectedSource] = useState("");
  const [dpi, setDpi] = useState(300);
  const [duplex, setDuplex] = useState(false);
  const [colorMode, setColorMode] = useState<"gray" | "color" | "bw">("gray");
  const [paperSize, setPaperSize] = useState<"A4" | "Letter" | "A3">("A4");
  const [maxPages, setMaxPages] = useState(0);
  const [sessionId, setSessionId] = useState("");
  const [progressMessage, setProgressMessage] = useState("");
  const [pages, setPages] = useState<ScanPage[]>([]);
  const [errorMessage, setErrorMessage] = useState("");
  const [studentResults, setStudentResults] = useState<StudentResult[]>([]);
  const [activeStudent, setActiveStudent] = useState<StudentResult | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Detect sources on mount
  useEffect(() => {
    detectSources();
    return () => {
      eventSourceRef.current?.close();
    };
  }, []);

  // Keyboard shortcuts for PDF modal
  useEffect(() => {
    if (!activeStudent) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setActiveStudent(null);
      if (e.key === "PageDown" || e.key === "PageUp") {
        e.preventDefault();
        const container = document.getElementById("student-pdf-scroll");
        if (container) {
          container.scrollBy({ top: (e.key === "PageDown" ? 1 : -1) * container.clientHeight * 0.8, behavior: "smooth" });
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeStudent]);

  async function detectSources() {
    setState("detecting");
    try {
      const res = await fetch("/api/scanner/sources");
      const data: ScannerSourcesResult = await res.json();
      if (data.status === "ok" && data.sources.length > 0) {
        setSources(data.sources.map((s) => s.name));
        const kodak = data.sources.find((s) =>
          s.name.toLowerCase().includes("kodak") || s.name.toLowerCase().includes("i3000")
        );
        setSelectedSource(kodak?.name || data.sources[0].name);
        setState("ready");
      } else {
        setErrorMessage(data.message || "未检测到扫描仪");
        setState("error");
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "检测扫描仪失败");
      setState("error");
    }
  }

  function listenProgress(sid: string) {
    eventSourceRef.current?.close();
    const es = new EventSource(`/api/scanner/progress/${sid}`);
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      const data: ScanProgressEvent = JSON.parse(event.data);

      switch (data.type) {
        case "scanning":
          setState("scanning");
          setProgressMessage(data.message || "正在扫描...");
          break;
        case "page_done":
          setPages((prev) => [
            ...prev,
            {
              pageNum: data.pageNum || 0,
              side: data.side || "front",
              studentId: null,
              studentConf: null,
              ocrStatus: "pending"
            }
          ]);
          break;
        case "ocr_start":
          setState("recognizing");
          setProgressMessage(data.message || "正在识别...");
          break;
        case "ocr_page_done":
          setPages((prev) =>
            prev.map((p) =>
              p.pageNum === data.pageNum && p.side === data.side
                ? { ...p, studentId: data.studentId ?? null, studentConf: data.studentConf ?? null, ocrStatus: data.studentId ? "done" : "review" }
                : p
            )
          );
          break;
        case "ocr_done":
          setProgressMessage("扫描识别完成，正在汇总成绩...");
          break;
        case "error":
          setState("error");
          setErrorMessage(data.message || "扫描出错");
          break;
        case "done":
          setState("done");
          onScansComplete?.(sid, pages.length);
          // Fetch combined results after scan completes
          fetchCombinedResults(sid);
          break;
      }
    };

    es.onerror = () => {
      es.close();
    };
  }

  async function fetchCombinedResults(sid: string) {
    try {
      const res = await fetch(`/api/scanner/session/${sid}/results`);
      if (res.ok) {
        const data = await res.json();
        setStudentResults(data as StudentResult[]);
      }
    } catch (err) {
      console.error("Failed to fetch combined results:", err);
    }
  }

  async function startScan() {
    if (!selectedSource) return;

    setState("scanning");
    setErrorMessage("");
    setPages([]);
    setStudentResults([]);

    try {
      const res = await fetch("/api/scanner/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cardId,
          sourceName: selectedSource,
          sessionName: `扫描_${cardId}_${new Date().toLocaleString("zh-CN")}`,
          dpi,
          duplex,
          colorMode,
          paperSize,
          maxPages
        })
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "启动扫描失败");
      }

      const data = await res.json();
      setSessionId(data.sessionId);
      listenProgress(data.sessionId);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "扫描失败");
      setState("error");
    }
  }

  function cancelScan() {
    eventSourceRef.current?.close();
    setState("idle");
    setProgressMessage("扫描已取消");
  }

  function reset() {
    eventSourceRef.current?.close();
    setState("idle");
    setSessionId("");
    setPages([]);
    setStudentResults([]);
    setActiveStudent(null);
    setProgressMessage("");
    setErrorMessage("");
    detectSources();
  }

  function imageUrl(recordId: string): string {
    return `/api/scanner/scan-image/${recordId}`;
  }

  return (
    <div className="scanner-panel">
      <div className="panel-title">
        <Camera size={17} /> 扫描仪录入
        {onClose && (
          <button className="ghost-button" onClick={onClose} style={{ marginLeft: "auto" }}>
            关闭
          </button>
        )}
      </div>

      {/* State: detecting */}
      {state === "detecting" && (
        <div className="scanner-status">
          <Loader size={20} className="spinning" />
          <span>正在检测扫描仪...</span>
        </div>
      )}

      {/* State: error */}
      {state === "error" && (
        <div className="scanner-status scanner-error">
          <AlertTriangle size={20} />
          <span>{errorMessage}</span>
          <button className="ghost-button" onClick={detectSources}>
            <RefreshCw size={14} /> 重试
          </button>
        </div>
      )}

      {/* State: ready */}
      {(state === "ready" || state === "idle") && sources.length > 0 && (
        <div className="scanner-config">
          <label>
            扫描仪
            <select value={selectedSource} onChange={(e) => setSelectedSource(e.target.value)}>
              {sources.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </label>

          <div className="two-col">
            <label>
              DPI
              <select value={dpi} onChange={(e) => setDpi(Number(e.target.value))}>
                <option value={150}>150</option>
                <option value={200}>200</option>
                <option value={300}>300</option>
                <option value={400}>400</option>
                <option value={600}>600</option>
              </select>
            </label>
            <label>
              色彩
              <select value={colorMode} onChange={(e) => setColorMode(e.target.value as "gray" | "color" | "bw")}>
                <option value="gray">灰度</option>
                <option value="color">彩色</option>
                <option value="bw">黑白</option>
              </select>
            </label>
          </div>

          <div className="two-col">
            <label>
              纸张
              <select value={paperSize} onChange={(e) => setPaperSize(e.target.value as "A4" | "Letter" | "A3")}>
                <option value="A4">A4</option>
                <option value="Letter">Letter</option>
                <option value="A3">A3</option>
              </select>
            </label>
            <label>
              最大页数
              <input
                type="number"
                min={0}
                value={maxPages}
                onChange={(e) => setMaxPages(Number(e.target.value))}
                placeholder="0=不限"
              />
            </label>
          </div>

          <label className="check-row">
            <input
              type="checkbox"
              checked={duplex}
              onChange={(e) => setDuplex(e.target.checked)}
            />
            双面扫描
          </label>

          <button className="primary-button wide-button" onClick={startScan}>
            <Play size={17} /> 开始扫描
          </button>

          <p className="hint">将答题卡放入扫描仪进纸器，点击开始扫描。扫描完成后自动识别学号和答案。</p>
        </div>
      )}

      {/* State: scanning / recognizing */}
      {(state === "scanning" || state === "recognizing") && (
        <div className="scanner-progress">
          <div className="scanner-status">
            <Loader size={20} className="spinning" />
            <span>{progressMessage}</span>
          </div>

          {pages.length > 0 && (
            <div className="scan-preview-strip">
              {pages.map((page, idx) => (
                <div
                  key={idx}
                  className={`scan-thumb ${page.ocrStatus === "done" ? "ocr-done" : page.ocrStatus === "review" ? "ocr-review" : ""}`}
                >
                  <span className="thumb-page">P{page.pageNum}</span>
                  <span className="thumb-side">{page.side === "front" ? "正" : "反"}</span>
                  {state === "recognizing" && (
                    <span className={`thumb-student ${page.studentId ? "has-id" : "no-id"}`}>
                      {page.studentId || "识别中"}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          <button className="ghost-button wide-button" onClick={cancelScan}>
            <Square size={16} /> 停止扫描
          </button>
        </div>
      )}

      {/* State: done */}
      {state === "done" && (
        <div className="scanner-done">
          <div className="scanner-status scanner-success">
            <Check size={20} />
            <span>扫描完成 — 共 {studentResults.length > 0 ? `${studentResults.length} 名学生` : `${pages.length} 张`}</span>
          </div>

          {/* Combined student result list */}
          {studentResults.length > 0 ? (
            <div className="student-results-table">
              <div className="student-results-header">
                <span>学号</span>
                <span>页数</span>
                <span>总分</span>
                <span>客观/主观</span>
                <span>待复核</span>
                <span>操作</span>
              </div>
              {studentResults.map((sr, idx) => (
                <div key={idx} className="student-result-row">
                  <span className={sr.studentId === "未识别" ? "missing-id" : ""}>
                    {sr.studentId}
                  </span>
                  <span>{sr.pageCount}</span>
                  <span className="score-cell">
                    {sr.totalScore}/{sr.maxScore}
                  </span>
                  <span className="score-sub">
                    {sr.objectiveScore}/{sr.maxScore - sr.subjectiveScore} · {sr.subjectiveScore}/{sr.subjectiveScore}
                  </span>
                  <span className={sr.needsReviewCount > 0 ? "status-warn" : "status-ok"}>
                    {sr.needsReviewCount}
                  </span>
                  <span>
                    <button className="ghost-button" style={{ fontSize: 12, padding: "2px 8px" }}
                      onClick={() => setActiveStudent(sr)}>
                      <Eye size={14} /> 查看
                    </button>
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="scan-results-table">
              <div className="scan-results-header">
                <span>页码</span>
                <span>面</span>
                <span>学号</span>
                <span>状态</span>
              </div>
              {pages.map((page, idx) => (
                <div key={idx} className="scan-result-row">
                  <span>{page.pageNum}</span>
                  <span>{page.side === "front" ? "正面" : "反面"}</span>
                  <span className={page.studentId ? "" : "missing-id"}>
                    {page.studentId || "未识别"}
                  </span>
                  <span className={page.ocrStatus === "done" ? "status-ok" : "status-warn"}>
                    {page.ocrStatus === "done" ? "已识别" : "待复核"}
                  </span>
                </div>
              ))}
            </div>
          )}

          <button className="primary-button wide-button" onClick={reset}>
            <RefreshCw size={16} /> 开始新扫描
          </button>
        </div>
      )}

      {/* State: no sources */}
      {state === "idle" && sources.length === 0 && !errorMessage && (
        <div className="scanner-status">
          <Camera size={20} />
          <span>点击上方按钮检测扫描仪</span>
          <button className="ghost-button" onClick={detectSources}>
            <RefreshCw size={14} /> 检测
          </button>
        </div>
      )}

      {/* ── PDF-Style Student Detail Modal ──────────────── */}
      {activeStudent && (
        <StudentDetailModal
          student={activeStudent}
          imageUrl={imageUrl}
          onClose={() => setActiveStudent(null)}
        />
      )}
    </div>
  );
}

// ── Student Detail Modal (PDF-style vertical scroll) ──

function StudentDetailModal({
  student,
  imageUrl,
  onClose
}: {
  student: StudentResult;
  imageUrl: (recordId: string) => string;
  onClose: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [activePageIndex, setActivePageIndex] = useState(0);

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

  return (
    <div className="pdf-modal-backdrop" onClick={onClose}>
      <div className="pdf-modal" onClick={(e) => e.stopPropagation()}>
        {/* Top bar */}
        <div className="pdf-modal-topbar">
          <div className="pdf-modal-info">
            <strong>学号: {student.studentId}</strong>
            <span>总分 {student.totalScore} / {student.maxScore}</span>
            <span>客观 {student.objectiveScore} · 主观 {student.subjectiveScore}</span>
            {student.needsReviewCount > 0 && (
              <span className="status-warn" style={{ fontSize: 12, padding: "1px 8px" }}>
                待复核 {student.needsReviewCount} 题
              </span>
            )}
          </div>
          <button className="ghost-button" onClick={onClose} style={{ padding: "4px 10px" }}>
            <X size={18} />
          </button>
        </div>

        {/* PDF-style scrolling pages */}
        <div
          id="student-pdf-scroll"
          className="pdf-modal-scroll"
          ref={scrollRef}
          onScroll={handleScroll}
        >
          {student.pages.map((page, idx) => (
            <div key={page.recordId} className="pdf-page-item">
              <div className="pdf-page-label">
                <span>第 {page.pageNum} 页 · {page.side === "front" ? "正面" : "反面"}</span>
                <span className="pdf-page-score">
                  {page.totalScore}/{page.totalMaxScore}
                  {" "}(客观 {page.objectiveScore} · 主观 {page.subjectiveScore})
                </span>
              </div>
              <div className="pdf-page-image-wrapper">
                <img
                  src={imageUrl(page.recordId)}
                  alt={`P${page.pageNum} ${page.side}`}
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
            {activePageIndex + 1} / {student.pages.length}
          </span>
          <div className="pdf-thumbnail-strip">
            {student.pages.map((page, idx) => (
              <button
                key={page.recordId}
                className={`pdf-thumbnail ${idx === activePageIndex ? "active" : ""}`}
                onClick={() => scrollToPage(idx)}
                title={`P${page.pageNum} ${page.side === "front" ? "正面" : "反面"}`}
              >
                <img
                  src={imageUrl(page.recordId)}
                  alt={`P${page.pageNum}`}
                  loading="lazy"
                />
                <span>P{page.pageNum}{page.side === "front" ? "正" : "反"}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
