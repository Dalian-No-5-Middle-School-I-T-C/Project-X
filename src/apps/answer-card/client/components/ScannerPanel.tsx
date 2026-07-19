import { useEffect, useRef, useState } from "react";
import { Camera, Play, Square, RefreshCw, AlertTriangle, Check, Loader, Eye, Upload, Database } from "lucide-react";
import { authFetch, mediaUrl, urlWithToken } from "../auth/api";
import type { ScannerSourcesResult, ScanProgressEvent } from "../../server/scanner/scanner-types";
import { ScanPreviewModal } from "./ScanPreviewModal";

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
  recordId: string;
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
  const [showUi, setShowUi] = useState(false);
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
  // 用 ref 追踪最新值，避免 SSE onmessage / setTimeout 闭包捕获到过期的 state
  const pagesRef = useRef<ScanPage[]>([]);
  const sessionIdRef = useRef("");
  const uploadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // v1.6.0: 扫描模式 — 本地存储 或 上传服务器
  const [scannerMode, setScannerMode] = useState<"local" | "remote">(() => {
    try { return (localStorage.getItem("projectx_scanner_mode") as "local" | "remote") || "local"; } catch { return "local"; }
  });
  const scannerModeRef = useRef(scannerMode);
  const [uploadState, setUploadState] = useState<"" | "uploading" | "done" | "error">("");
  const [uploadMsg, setUploadMsg] = useState("");

  function setMode(m: "local" | "remote") {
    setScannerMode(m);
    try { localStorage.setItem("projectx_scanner_mode", m); } catch { /* ignore */ }
  }

  // 保持 ref 与 state 同步
  useEffect(() => { pagesRef.current = pages; }, [pages]);
  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);
  useEffect(() => { scannerModeRef.current = scannerMode; }, [scannerMode]);

  // Detect sources on mount
  useEffect(() => {
    detectSources();
    return () => {
      eventSourceRef.current?.close();
      if (uploadTimerRef.current) clearTimeout(uploadTimerRef.current);
    };
  }, []);

  async function detectSources() {
    setState("detecting");
    try {
      const res = await authFetch("/api/scanner/sources");
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
    const es = new EventSource(urlWithToken(`/api/scanner/progress/${sid}`));
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      let data: ScanProgressEvent;
      try {
        data = JSON.parse(event.data) as ScanProgressEvent;
      } catch {
        // 忽略非 JSON 消息（如心跳），避免抛出未捕获异常中断 SSE
        return;
      }

      switch (data.type) {
        case "scanning":
          setState("scanning");
          setProgressMessage(data.message || "正在扫描...");
          break;
        case "page_done":
          setPages((prev) => [
            ...prev,
            {
              recordId: data.recordId ?? "",
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
          // 通过 ref 读取最新页数，避免闭包捕获扫描开始时的空数组
          onScansComplete?.(sid, pagesRef.current.length);
          // Fetch combined results after scan completes
          fetchCombinedResults(sid);
          // v1.6.0: 远程模式下自动上传
          if (scannerModeRef.current === "remote") {
            if (uploadTimerRef.current) clearTimeout(uploadTimerRef.current);
            uploadTimerRef.current = setTimeout(() => void uploadToRemote(), 500);
          }
          break;
      }
    };

    es.onerror = () => {
      es.close();
      setState("error");
      setErrorMessage("与扫描服务的连接中断，请重试");
    };
  }

  async function fetchCombinedResults(sid: string) {
    try {
      const res = await authFetch(`/api/scanner/session/${sid}/results`);
      if (res.ok) {
        const data = await res.json();
        setStudentResults(data as StudentResult[]);
      }
    } catch (err) {
      console.error("Failed to fetch combined results:", err);
    }
  }

  // v1.6.0: 上传扫描结果到远程服务器
  async function uploadToRemote() {
    // 使用 ref 读取最新值，避免闭包捕获扫描开始时的空 pages / 空 sessionId
    const currentPages = pagesRef.current;
    if (!sessionIdRef.current || scannerModeRef.current !== "remote") return;
    setUploadState("uploading");
    setUploadMsg("正在上传到服务器...");

    try {
      // Step 1: 创建远程扫描会话
      const createRes = await authFetch("/api/scanner/upload/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cardId,
          name: `扫描_${cardId}_${new Date().toISOString().slice(0, 10)}`,
          dpi, paperSize, pageCount: currentPages.length,
        }),
      });
      if (!createRes.ok) throw new Error("创建远程会话失败");
      const { sessionId: remoteSessionId, uploadTokens } = await createRes.json() as { sessionId: string; uploadTokens: string[] };

      // Step 2: 逐页上传图片
      for (let i = 0; i < currentPages.length; i++) {
        const page = currentPages[i];
        const token = uploadTokens[i];
        setUploadMsg(`正在上传第 ${page.pageNum} 页 (${i + 1}/${currentPages.length})...`);

        // 获取本地图片并上传
        const imageRes = await authFetch(`/api/scanner/scan-image/${page.recordId}`);
        if (!imageRes.ok) continue;
        const blob = await imageRes.blob();

        const form = new FormData();
        form.append("image", blob, `page_${page.pageNum}.jpg`);
        form.append("token", token);
        form.append("pageNum", String(page.pageNum));
        form.append("side", page.side);

        const uploadRes = await authFetch(`/api/scanner/upload/sessions/${remoteSessionId}/pages`, {
          method: "POST",
          body: form,
        });
        if (!uploadRes.ok) {
          console.error(`Page ${page.pageNum} upload failed`);
        }
      }

      // Step 3: 标记完成
      await authFetch(`/api/scanner/upload/sessions/${remoteSessionId}/complete`, { method: "POST" });

      setUploadState("done");
      setUploadMsg(`上传完成！${currentPages.length} 页已提交到服务器`);
    } catch (err) {
      setUploadState("error");
      setUploadMsg(err instanceof Error ? err.message : "上传失败");
    }
  }

  async function startScan() {
    if (!selectedSource) return;

    setState("scanning");
    setErrorMessage("");
    setPages([]);
    pagesRef.current = [];
    setStudentResults([]);

    try {
      const res = await authFetch("/api/scanner/scan", {
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
          maxPages,
          showUi
        })
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "启动扫描失败");
      }

      const data = await res.json();
      sessionIdRef.current = data.sessionId;
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
    sessionIdRef.current = "";
    setPages([]);
    pagesRef.current = [];
    setStudentResults([]);
    setActiveStudent(null);
    setProgressMessage("");
    setErrorMessage("");
    detectSources();
  }

  function imageUrl(recordId: string): string {
    return mediaUrl(`/api/scanner/scan-image/${recordId}`);
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

          {/* ── v1.6.0: 扫描存储模式切换 ── */}
          <div className="scanner-mode-switch" style={{ display: "flex", gap: 4, marginTop: 6, background: "var(--surface-soft)", borderRadius: 6, padding: 3 }}>
            <button
              type="button"
              className={scannerMode === "local" ? "primary-button" : "ghost-button"}
              style={{ flex: 1, fontSize: 12, padding: "4px 8px" }}
              onClick={() => setMode("local")}
              title="扫描结果存入本地 SQLite"
            >
              <Database size={13} style={{ marginRight: 4 }} />本地存储
            </button>
            <button
              type="button"
              className={scannerMode === "remote" ? "primary-button" : "ghost-button"}
              style={{ flex: 1, fontSize: 12, padding: "4px 8px" }}
              onClick={() => setMode("remote")}
              title="扫描结果上传到远端服务器"
            >
              <Upload size={13} style={{ marginRight: 4 }} />上传服务器
            </button>
          </div>

          <label className="check-row">
            <input
              type="checkbox"
              checked={showUi}
              onChange={(e) => setShowUi(e.target.checked)}
            />
            显示扫描仪界面（调试）
          </label>

          <button className="primary-button wide-button" onClick={startScan}>
            <Play size={17} /> 开始扫描
          </button>

          {/* 上传状态指示 */}
          {uploadState && (
            <div style={{ fontSize: 12, padding: "6px 8px", borderRadius: 4, marginTop: 4, background: uploadState === "done" ? "#e8f5e9" : uploadState === "error" ? "#ffebee" : "#e3f2fd", color: uploadState === "done" ? "#2E7D32" : uploadState === "error" ? "var(--brand)" : "#1565C0" }}>
              {uploadState === "uploading" && <><Loader size={12} className="spinning" style={{ marginRight: 4 }} /> {uploadMsg}</>}
              {uploadState === "done" && <><Check size={12} style={{ marginRight: 4 }} /> {uploadMsg}</>}
              {uploadState === "error" && <><AlertTriangle size={12} style={{ marginRight: 4 }} /> {uploadMsg}</>}
            </div>
          )}          <p className="hint">将答题卡放入扫描仪进纸器，点击开始扫描。扫描完成后自动识别学号和答案。</p>
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
        <ScanPreviewModal
          title={`学号: ${activeStudent.studentId}`}
          subtitle={`总分 ${activeStudent.totalScore} / ${activeStudent.maxScore} · 客观 ${activeStudent.objectiveScore} · 主观 ${activeStudent.subjectiveScore}${activeStudent.needsReviewCount > 0 ? ` · 待复核 ${activeStudent.needsReviewCount} 题` : ""}`}
          pages={activeStudent.pages.map((p) => ({
            recordId: p.recordId,
            pageNum: p.pageNum,
            side: p.side,
            imageUrl: imageUrl(p.recordId),
            objectiveScore: p.objectiveScore,
            subjectiveScore: p.subjectiveScore,
            totalScore: p.totalScore,
            totalMaxScore: p.totalMaxScore
          }))}
          onClose={() => setActiveStudent(null)}
        />
      )}
    </div>
  );
}

// Removed: StudentDetailModal — replaced by shared ScanPreviewModal
