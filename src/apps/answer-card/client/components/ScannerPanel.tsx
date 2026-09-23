import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ScannerConflictCards } from "./ScannerConflictCards";
import {
  AlertTriangle,
  Camera,
  Check,
  Copy,
  Database,
  Eye,
  Play,
  RefreshCw,
  Square,
  Upload,
} from "lucide-react";
import { authFetch, mediaUrl, urlWithToken } from "../auth/api";
import { useScannerMode, getScannerMode, isRemoteServerConfigured } from "../lib/scannerMode";
import { scannerUploadManager } from "../lib/scannerUploadManager";
import type { ScanBatchResponse, ScanBatchFailure, ScanBatchResult, ScanConflictCard } from "../../../../shared/scanPages";
import type { ScannerSourcesResult, ScanProgressEvent } from "../../server/scanner/scanner-types";
import { ScanPreviewModal } from "./ScanPreviewModal";
import type { AnswerCard } from "../../../../shared/types";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  ControlRow,
  Field,
  Input,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableWrap,
} from "./ui/v2";

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

type StudentResult = ScanBatchResult;

// UI-5: SSE 自动重连参数
const MAX_RECONNECT = 5;
const RECONNECT_DELAY = 5000;

export function ScannerPanel({ cardId, onScansComplete, onClose }: ScannerPanelProps) {
  const [state, setState] = useState<ScannerState>("idle");
  const [sources, setSources] = useState<string[]>([]);
  const [selectedSource, setSelectedSource] = useState("");
  const [dpi, setDpi] = useState(300);
  const [duplex, setDuplex] = useState(false);
  const [legacyIdentity, setLegacyIdentity] = useState(false);
  const [sessionLegacyIdentity, setSessionLegacyIdentity] = useState(false);
  const [showUi, setShowUi] = useState(false);
  const [colorMode, setColorMode] = useState<"gray" | "color" | "bw">("gray");
  const [paperSize, setPaperSize] = useState<"A4" | "Letter" | "A3">("A4");
  const [maxPages, setMaxPages] = useState(0);
  // 等纸空闲超时（秒）：0=用 native 默认 15s。厚纸/慢速 ADF 进纸间隔大时需要调高，
  // 否则会出现「扫到一半提前收尾」。
  const [pageTimeoutSec, setPageTimeoutSec] = useState(0);
  // 检测诊断（根因/建议/原始输出）：把「未检测到扫描仪」这一类笼统文案拆成可操作结论
  const [sourcesDiag, setSourcesDiag] = useState<ScannerSourcesResult | null>(null);
  const [sessionId, setSessionId] = useState("");
  const [progressMessage, setProgressMessage] = useState("");
  const [pages, setPages] = useState<ScanPage[]>([]);
  const [errorMessage, setErrorMessage] = useState("");
  const [studentResults, setStudentResults] = useState<StudentResult[]>([]);
  const [failures, setFailures] = useState<ScanBatchFailure[]>([]);
  const [reviewCards, setReviewCards] = useState<ScanConflictCard[]>([]);
  const [activeFailure, setActiveFailure] = useState<ScanBatchFailure | null>(null);
  const [corrections, setCorrections] = useState<Record<string, string>>({});
  const [resultsBusy, setResultsBusy] = useState(false);
  const resultsBusyRef = useRef(false);
  const [resultMessage, setResultMessage] = useState("");
  const [uploadJobs, setUploadJobs] = useState<Record<string, string>>({});
  const uploadState = useSyncExternalStore(scannerUploadManager.subscribe, scannerUploadManager.getState);
  const [activeStudent, setActiveStudent] = useState<StudentResult | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  // 用 ref 追踪最新值，避免 SSE onmessage / setTimeout 闭包捕获到过期的 state
  const pagesRef = useRef<ScanPage[]>([]);
  const sessionIdRef = useRef("");

  // UI-5: SSE 断开重连状态
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const completedRef = useRef(false);
  const [disconnected, setDisconnected] = useState(false);
  // v2.5.6：诊断复制反馈（老师现场无法翻日志，一键复制即可反馈）
  const [diagCopied, setDiagCopied] = useState(false);

  // v2.5.1: 扫描存储模式共享 hook（与导入阅卷卡片共用同一记忆）
  const [scannerMode, setScannerMode] = useScannerMode();

  // 保持 ref 与 state 同步
  useEffect(() => {
    pagesRef.current = pages;
  }, [pages]);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    let active = true;
    void authFetch(`/api/cards/${cardId}`)
      .then(async (response) => {
        if (!response.ok) return;
        const card = (await response.json()) as AnswerCard;
        if (active) {
          setPaperSize(card.paper?.size === "A3" ? "A3" : "A4");
          setDuplex(card.sided === "double");
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [cardId]);

  // Detect sources on mount
  useEffect(() => {
    detectSources();
    return () => {
      eventSourceRef.current?.close();
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function detectSources() {
    // 重新检测前丢弃上次枚举的列表；否则本次失败后仍会显示旧下拉框，
    // 老师无法使用留空或手填数据源的兜底入口。
    if (sources.length > 0) setSelectedSource("");
    setSources([]);
    setState("detecting");
    setSourcesDiag(null);
    try {
      const res = await authFetch("/api/scanner/sources");
      const data = (await res.json()) as ScannerSourcesResult;
      // 先判 HTTP 状态：服务端异常时 body 可能没有 status 字段，
      // 旧代码直接读 data.status 会走到通用兜底文案，丢掉真正的错误
      if (!res.ok) {
        setSourcesDiag(data);
        setErrorMessage(data?.message || `检测扫描仪失败（HTTP ${res.status}）`);
        setState("error");
        return;
      }
      if (data.status === "ok" && data.sources.length > 0) {
        setSources(data.sources.map((s) => s.name));
        const kodak = data.sources.find(
          (s) => s.name.toLowerCase().includes("kodak") || s.name.toLowerCase().includes("i3000")
        );
        setSelectedSource(kodak?.name || data.sources[0].name);
        setState("ready");
      } else {
        setSourcesDiag(data);
        setErrorMessage(data.message || "未检测到扫描仪");
        setState("error");
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "检测扫描仪失败");
      setState("error");
    }
  }

  /** 诊断原始细节：现场截图即可自证，不必再让老师翻日志 */
  function diagnosticLines(diag: ScannerSourcesResult): string[] {
    const lines: string[] = [];
    if (diag.code) lines.push(`根因代码：${diag.code}`);
    if (diag.arch) lines.push(`扫描端位数：${diag.arch}`);
    if (diag.dsmLoaded !== undefined) lines.push(`TWAIN 管理器已加载：${diag.dsmLoaded ? "是" : "否"}`);
    if (diag.dsmPath) lines.push(`TWAIN 管理器：${diag.dsmPath}`);
    if (diag.dsmSearch) lines.push(`加载探试：${diag.dsmSearch}`);
    if (diag.openDsmRc !== undefined && diag.openDsmRc >= 0) lines.push(`OPENDSM 返回码：${diag.openDsmRc}`);
    if (diag.conditionCode !== undefined && diag.conditionCode >= 0) lines.push(`条件码：${diag.conditionCode}`);
    if (diag.windowCreated !== undefined) lines.push(`宿主窗口创建成功：${diag.windowCreated ? "是" : "否"}`);
    if (diag.exitCode !== undefined) lines.push(`桥接进程退出码：${diag.exitCode ?? "无"}`);
    if (diag.bridgeStderr) lines.push(`桥接进程原始输出：\n${diag.bridgeStderr}`);
    return lines;
  }

  /** 诊断原文：现场截图或一键复制即可自证，不必再让老师翻日志 */
  function diagnosticText(): string {
    return [
      `Project-X 扫描端诊断 @ ${new Date().toLocaleString("zh-CN")}`,
      `答题卡 ID：${cardId}`,
      `错误信息：${errorMessage || "（无）"}`,
      ...(sourcesDiag ? diagnosticLines(sourcesDiag) : ["（无检测诊断数据）"]),
    ].join("\n");
  }

  /** v2.5.6：一键复制诊断（剪贴板不可用时回退到隐藏 textarea 选中复制） */
  async function copyDiagnostics(): Promise<void> {
    const text = diagnosticText();
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setDiagCopied(true);
      setTimeout(() => setDiagCopied(false), 2000);
    } catch {
      setDiagCopied(false);
    }
  }

  // UI-5: 监听扫描进度，连接中断时自动重连（封顶 MAX_RECONNECT 次）
  function listenProgress(sid: string) {
    setDisconnected(false);
    reconnectAttemptsRef.current = 0;
    completedRef.current = false;
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);

    const open = () => {
      eventSourceRef.current?.close();
      const es = new EventSource(urlWithToken(`/api/scanner/progress/${sid}`));
      eventSourceRef.current = es;

      es.onmessage = (event) => {
        // 连接正常 — 清除断开提示横幅
        setDisconnected(false);
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
          case "page_done": {
            // v2.5.1 审查修复：同步推进 ref（原仅靠 effect 提交后同步，终态早到时存在空窗）
            const page: ScanPage = {
              recordId: data.recordId ?? "",
              pageNum: data.pageNum || 0,
              side: data.side || "front",
              studentId: null,
              studentConf: null,
              ocrStatus: "pending",
            };
            setPages((prev) => [...prev, page]);
            pagesRef.current = [...pagesRef.current, page];
            break;
          }
          case "ocr_start":
            setState("recognizing");
            setProgressMessage(data.message || "正在识别...");
            break;
          case "ocr_page_done":
            setPages((prev) =>
              prev.map((p) =>
                p.pageNum === data.pageNum && p.side === data.side
                  ? {
                      ...p,
                      studentId: data.studentId ?? null,
                      studentConf: data.studentConf ?? null,
                      ocrStatus: data.ocrStatus ?? (data.studentId ? "done" : "review"),
                    }
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
          case "cancelled":
            setState("idle");
            setProgressMessage(data.message || "扫描已取消");
            break;
          case "done":
            completedRef.current = true;
            setState("done");
            // 通过 ref 读取最新页数，避免闭包捕获扫描开始时的空数组
            onScansComplete?.(sid, pagesRef.current.length);
            // Wait for teacher review before saving or uploading successful cards.
            void fetchCombinedResults(sid);
            break;
        }
      };

      es.onerror = () => {
        es.close();
        // 扫描已正常完成（服务端在 done 后关闭流），无需重连
        if (completedRef.current) return;
        // 重连次数耗尽 — 放弃，转为错误态
        if (reconnectAttemptsRef.current >= MAX_RECONNECT) {
          setDisconnected(false);
          setState("error");
          setErrorMessage("与扫描进度服务连接中断，重连失败，请刷新页面重试");
          return;
        }
        reconnectAttemptsRef.current += 1;
        setDisconnected(true);
        reconnectTimerRef.current = setTimeout(() => {
          setDisconnected(false);
          open();
        }, RECONNECT_DELAY);
      };
    };

    open();
  }

  function applyResults(data: ScanBatchResponse) {
    setStudentResults(data.results);
    setFailures(data.failures);
    setReviewCards(data.reviewCards ?? []);
  }

  async function readResults(sid: string, save = false): Promise<ScanBatchResponse> {
    const remotePreview = !save && getScannerMode() === "remote";
    const res = await authFetch(`/api/scanner/session/${sid}/${remotePreview ? "results?previewOnly=1" : save ? "results" : "validate"}`, { method: remotePreview ? "GET" : "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || `汇总失败（HTTP ${res.status}）`);
    return data as ScanBatchResponse;
  }

  async function fetchCombinedResults(sid: string) {
    if (resultsBusyRef.current) return;
    resultsBusyRef.current = true;
    setResultsBusy(true);
    setErrorMessage("");
    try { applyResults(await readResults(sid)); }
    catch (err) { setErrorMessage(err instanceof Error ? err.message : "汇总失败，请重试"); }
    finally { resultsBusyRef.current = false; setResultsBusy(false); }
  }

  async function saveSuccessful() {
    if (resultsBusyRef.current) return;
    resultsBusyRef.current = true;
    setResultsBusy(true);
    setErrorMessage("");
    try {
      const remote = getScannerMode() === "remote";
      if (remote && !isRemoteServerConfigured()) throw new Error("请先配置服务器地址");
      const data = await readResults(sessionId, !remote);
      applyResults(data);
      if (remote) {
        const nextJobs = { ...uploadJobs };
        for (const result of data.results) {
          if (nextJobs[result.groupId]) continue;
          // Independent cards can finish even when another card fails remotely.
          nextJobs[result.groupId] = scannerUploadManager.startUpload({
            identityMode: sessionLegacyIdentity ? "legacy" : "strict",
            kind: "scan", cardId, name: `扫描_${result.studentId}`, dpi, paperSize,
            pages: result.pages.map(page => ({
              pageNum: page.pageNum, side: page.side, groupId: result.groupId,
              layoutPage: page.layoutPage, studentId: result.studentId,
              getBlob: async () => {
                const res = await authFetch(`/api/scanner/scan-image/${page.recordId}`);
                if (!res.ok) throw new Error(`读取本机扫描图失败（HTTP ${res.status}）`);
                return res.blob();
              },
            })),
          });
        }
        setUploadJobs(nextJobs);
        setResultMessage("成功答题卡已加入上传队列；失败答题卡保留在本机，可继续订正。");
      } else {
        setResultMessage(`已保存 ${data.results.filter(r => r.saved).length} 份；${data.failures.length} 份失败，可继续处理。`);
      }
    } catch (err) { setErrorMessage(err instanceof Error ? err.message : "保存失败"); }
    finally { resultsBusyRef.current = false; setResultsBusy(false); }
  }

  async function retryCard(failure: ScanBatchFailure) {
    if (resultsBusyRef.current) return;
    resultsBusyRef.current = true;
    setResultsBusy(true);
    setErrorMessage("");
    try {
      if (failure.stage === "saving") {
        applyResults(await readResults(sessionId));
      } else {
        const res = await authFetch(`/api/scanner/session/${sessionId}/retry`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ groupId: failure.groupId, studentId: corrections[failure.groupId]?.trim() || undefined }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || "重新识别失败");
        applyResults(data as ScanBatchResponse);
      }
      setResultMessage("已重新汇总，请核对后保存成功部分。");
    } catch (err) { setErrorMessage(err instanceof Error ? err.message : "重试失败"); }
    finally { resultsBusyRef.current = false; setResultsBusy(false); }
  }

  async function startScan() {
    // v2.5.6：不再因「没选到数据源」静默 return——那会把老师直接挡在门外且毫无反馈。
    // 留空是合法输入：服务端 sourceName 缺省为 ""，桥接在枚举为空或名称无匹配时
    // 回退 MSG_GETDEFAULT（系统默认数据源）；真失败时由 bridge 返回可诊断的错误。
    setState("scanning");
    setErrorMessage("");
    setPages([]);
    pagesRef.current = [];
    setStudentResults([]);
    setFailures([]);
    setCorrections({});
    setUploadJobs({});
    setResultMessage("");
    reconnectAttemptsRef.current = 0;
    completedRef.current = false;
    setDisconnected(false);

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
          identityMode: legacyIdentity ? "legacy" : "strict",
          colorMode,
          paperSize,
          maxPages,
          showUi,
          // 0 表示沿用 native 默认（15000ms）
          pageTimeoutMs: pageTimeoutSec > 0 ? Math.round(pageTimeoutSec * 1000) : undefined,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "启动扫描失败");
      }

      const data = await res.json();
      sessionIdRef.current = data.sessionId;
      setSessionId(data.sessionId);
      setSessionLegacyIdentity(legacyIdentity);
      setLegacyIdentity(false);
      listenProgress(data.sessionId);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "扫描失败");
      setState("error");
    }
  }

  function cancelScan() {
    eventSourceRef.current?.close();
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    setDisconnected(false);
    reconnectAttemptsRef.current = 0;
    completedRef.current = false;
    setState("idle");
    setProgressMessage("扫描已取消");

    // 通知后端终止 scanner-bridge.exe 子进程（不再只是关闭 SSE，否则 ADF 会继续送纸）
    const sid = sessionIdRef.current;
    if (sid) {
      void authFetch(`/api/scanner/scan/${sid}/cancel`, { method: "POST" }).catch(() => undefined);
    }
  }

  function reset() {
    eventSourceRef.current?.close();
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    setDisconnected(false);
    reconnectAttemptsRef.current = 0;
    completedRef.current = false;
    setState("idle");
    setSessionId("");
    sessionIdRef.current = "";
    setPages([]);
    pagesRef.current = [];
    setStudentResults([]);
    setFailures([]);
    setCorrections({});
    setUploadJobs({});
    setResultMessage("");
    setActiveStudent(null);
    setProgressMessage("");
    setErrorMessage("");
    setSourcesDiag(null);
    detectSources();
  }

  function imageUrl(recordId: string): string {
    return mediaUrl(`/api/scanner/scan-image/${recordId}`);
  }

  return (
    <div className="flex flex-col gap-4">
      {sessionLegacyIdentity && <p role="status" className="m-0 rounded-md bg-warning-soft p-3 text-sm text-foreground">本次会话兼容旧卡：无可读二维码的页面未校验卡 ID，请人工核对。</p>}
      {/* UI-5: SSE 断开重连提示横幅（顶部，红色） */}
      {disconnected && (
        <div className="flex items-center gap-2 rounded-md border border-destructive-border bg-destructive-soft px-3 py-2 text-sm text-destructive-fg">
          <AlertTriangle size={16} className="shrink-0" />
          <span>与扫描进度服务断开，正在重连…</span>
        </div>
      )}

      {/* 标题栏 */}
      <div className="flex items-center gap-2 text-base font-semibold text-foreground">
        <Camera size={18} className="shrink-0" />
        <span>扫描仪录入</span>
        {onClose && (
          <Button variant="ghost" size="sm" className="ml-auto" onClick={onClose}>
            关闭
          </Button>
        )}
      </div>

      {/* State: detecting */}
      {state === "detecting" && (
        <div className="flex items-center gap-2 rounded-md border border-border-subtle bg-secondary px-3 py-3 text-sm text-muted-foreground">
          <Spinner size={20} />
          <span>正在检测扫描仪...</span>
        </div>
      )}

      {/* State: error */}
      {state === "error" && (
        <div className="flex flex-col gap-2 rounded-md border border-destructive-border bg-destructive-soft px-3 py-3 text-sm text-destructive-fg">
          <div className="flex items-center gap-2">
            <AlertTriangle size={20} className="shrink-0" />
            <span className="min-w-0 flex-1 break-words">{errorMessage}</span>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              icon={diagCopied ? <Check size={14} /> : <Copy size={14} />}
              onClick={() => void copyDiagnostics()}
            >
              {diagCopied ? "已复制" : "复制诊断"}
            </Button>
            <Button variant="outline" size="sm" className="shrink-0" icon={<RefreshCw size={14} />} onClick={detectSources}>
              重试
            </Button>
          </div>
          {sourcesDiag?.hint && (
            <p className="m-0 text-xs leading-relaxed">{sourcesDiag.hint}</p>
          )}
          {sourcesDiag && diagnosticLines(sourcesDiag).length > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer select-none opacity-80">
                技术细节（可点「复制诊断」一键反馈，无需翻日志）
              </summary>
              <pre className="m-0 mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-card px-2 py-2 text-[11px] leading-relaxed">
                {diagnosticLines(sourcesDiag).join("\n")}
              </pre>
            </details>
          )}
        </div>
      )}

      {/* State: ready / idle / error —— v2.5.6：设置与「开始扫描」不再依赖检测结果。
          此前整块设置（含图片去向与「开始扫描」）被 sources.length > 0 门控，
          一旦扫描仪检测失败，老师就被应用拦住、完全没有扫描入口——这正是现场
          「扫描端阻止我扫」的直接原因，而设备本身在厂商软件里可以正常扫描。 */}
      {(state === "ready" || state === "idle" || state === "error") && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">扫描设置</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {sources.length > 0 ? (
              <Field label="扫描仪">
                <Select value={selectedSource} onValueChange={setSelectedSource}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {sources.map((name) => (
                      <SelectItem key={name} value={name}>
                        {name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            ) : (
              <>
                <Field
                  label="扫描仪数据源名称（可留空）"
                  hint="未枚举到 TWAIN 数据源时的兜底入口：留空即由桥接改用系统默认数据源；也可直接填入厂商扫描软件中显示的「数据源名称」。"
                >
                  <div className="flex items-center gap-2">
                    <Input
                      value={selectedSource}
                      onChange={(e) => setSelectedSource(e.target.value)}
                      placeholder="留空 = 使用系统默认扫描仪"
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      type="button"
                      className="shrink-0"
                      icon={<RefreshCw size={14} />}
                      onClick={() => void detectSources()}
                    >
                      重新检测
                    </Button>
                  </div>
                </Field>
                <p className="m-0 rounded-md border border-warning-border bg-warning-soft px-3 py-2 text-xs text-warning-foreground">
                  未检测到扫描仪列表，但不阻止扫描：若扫描仪厂商软件能正常扫描，直接留空点下方「开始扫描」即可
                  （桥接会请求系统默认数据源）。若仍失败，请展开上方错误信息中的「技术细节」并复制反馈。
                </p>
              </>
            )}

            <div className="grid grid-cols-2 gap-3">
              <Field label="DPI">
                <Select value={String(dpi)} onValueChange={(v) => setDpi(Number(v))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[150, 200, 300, 400, 600].map((d) => (
                      <SelectItem key={d} value={String(d)}>
                        {d}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="色彩">
                <Select value={colorMode} onValueChange={(v) => setColorMode(v as "gray" | "color" | "bw")}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="gray">灰度</SelectItem>
                    <SelectItem value="color">彩色</SelectItem>
                    <SelectItem value="bw">黑白</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="纸张">
                <Select value={paperSize} onValueChange={(v) => setPaperSize(v as "A4" | "Letter" | "A3")}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="A4">A4</SelectItem>
                    <SelectItem value="Letter">Letter</SelectItem>
                    <SelectItem value="A3">A3</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label="最大页数">
                <Input
                  type="number"
                  min={0}
                  value={maxPages}
                  onChange={(e) => setMaxPages(Number(e.target.value))}
                  placeholder="0=不限"
                />
              </Field>
            </div>

            <Field label="等纸超时（秒）">
              <Input
                type="number"
                min={0}
                max={120}
                value={pageTimeoutSec}
                onChange={(e) => setPageTimeoutSec(Math.max(0, Math.min(120, Math.trunc(Number(e.target.value)) || 0)))}
                placeholder="0=默认 15 秒"
              />
            </Field>
            <p className="m-0 text-xs text-muted-foreground">
              进纸后若超过该时长没有下一张，扫描即视为结束。厚纸或慢速进纸器可调到 20–30 秒；
              留 0 使用默认值 15 秒（有效范围 2–120 秒）。
            </p>

            <ControlRow
              control={<Checkbox checked={legacyIdentity} onCheckedChange={(c) => setLegacyIdentity(c === true)} />}
              label="兼容旧卡（无可读二维码时未校验卡 ID）"
            />
            <ControlRow
              control={<Checkbox checked={duplex} onCheckedChange={(c) => setDuplex(c === true)} />}
              label="双面扫描"
            />
            <ControlRow
              control={<Checkbox checked={showUi} onCheckedChange={(c) => setShowUi(c === true)} />}
              label="显示扫描仪界面（调试）"
            />

            {/* ── v1.6.0: 扫描存储模式切换 ── */}
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-secondary-foreground">扫描存储模式</span>
              <SegmentedControl
                aria-label="扫描存储模式"
                value={scannerMode}
                onValueChange={setScannerMode}
                block
                items={[
                  {
                    value: "local",
                    label: "本地存储",
                    icon: <Database size={14} />,
                    tip: "扫描结果存入本地 SQLite",
                  },
                  {
                    value: "remote",
                    label: "上传服务器",
                    icon: <Upload size={14} />,
                    tip: "扫描结果上传到远端服务器",
                  },
                ]}
              />
              {scannerMode === "remote" && !isRemoteServerConfigured() && (
                <p className="m-0 rounded-md border border-warning-border bg-warning-soft px-3 py-2 text-xs text-warning-foreground">
                  未配置远端服务器：扫描结果无法上传。请先在页面右上角「服务器连接」中填写服务器地址与 API Key。
                </p>
              )}
            </div>

            <Button variant="primary" block icon={<Play size={17} />} onClick={startScan}>
              开始扫描
            </Button>

            <p className="m-0 text-xs text-muted-foreground">
              将答题卡放入扫描仪进纸器，点击开始扫描。扫描完成后自动识别学号和答案。
            </p>
          </CardContent>
        </Card>
      )}

      {/* State: scanning / recognizing */}
      {(state === "scanning" || state === "recognizing") && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 rounded-md border border-border-subtle bg-secondary px-3 py-3 text-sm text-foreground">
            <Spinner size={20} />
            <span className="min-w-0 flex-1 truncate">{progressMessage}</span>
          </div>

          {pages.length > 0 && (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
              {pages.map((page, idx) => (
                <div
                  key={idx}
                  className={`flex flex-col gap-0.5 rounded-md border bg-card px-2 py-1.5 text-xs ${
                    page.ocrStatus === "done"
                      ? "border-success-border"
                      : page.ocrStatus === "review"
                        ? "border-warning-border"
                        : "border-border-subtle"
                  }`}
                >
                  <span className="font-medium tabular-nums text-foreground">P{page.pageNum}</span>
                  <span className="text-muted-foreground">{page.side === "front" ? "正面" : "反面"}</span>
                  {state === "recognizing" && (
                    <span
                      className={`mt-0.5 ${
                        page.studentId ? "text-success-foreground" : "text-warning-foreground"
                      }`}
                    >
                      {page.studentId || "识别中"}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          <Button variant="outline" block icon={<Square size={16} />} onClick={cancelScan}>
            停止扫描
          </Button>
        </div>
      )}

      {/* State: done */}
      {state === "done" && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 rounded-md border border-success-border bg-success-soft px-3 py-3 text-sm text-success-foreground">
            <Check size={20} className="shrink-0" />
            <span>
              扫描完成 — {resultsBusy ? "正在汇总…" : `${studentResults.length} 份成功，${failures.length} 份失败`}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" disabled={resultsBusy || !studentResults.some(r => scannerMode === "remote" ? !uploadJobs[r.groupId] : !r.saved)} onClick={() => void saveSuccessful()}>
              {scannerMode === "remote" ? "保存成功部分到服务器" : "保存成功部分"}
            </Button>
            <Button variant="outline" disabled={resultsBusy} onClick={() => void fetchCombinedResults(sessionId)}>刷新汇总</Button>
          </div>
          {resultMessage && <p role="status" className="text-sm text-muted-foreground">{resultMessage}</p>}
          {errorMessage && <p role="alert" className="text-sm text-destructive-fg">{errorMessage}</p>}
          {reviewCards.length > 0 && <ScannerConflictCards cards={reviewCards} onChanged={() => void fetchCombinedResults(sessionId)} />}
          {failures.length > 0 && (
            <div className="flex flex-col gap-3 rounded-md border border-warning-border bg-warning-soft p-3">
              <strong>以下答题卡未保存</strong>
              <p className="text-sm">可查看图片，订正学号后重新识别。缺页、错页或图像不清时，请整理原卷后重新扫描整份答题卡。</p>
              {failures.map(failure => (
                <div key={failure.groupId} className="flex flex-col gap-2 border-t border-border-subtle pt-2">
                  <span className="text-sm">{failure.studentId || "未识别学号"} · {failure.pages.map(p => `第 ${p.pageNum} 张${p.side === "front" ? "正面" : "背面"}`).join("、")}：{failure.message}</span>
                  {failure.conflicts && <ScannerConflictCards cards={failure.conflicts} onChanged={() => void fetchCombinedResults(sessionId)} />}
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => setActiveFailure(failure)}>查看失败卡</Button>
                    {failure.stage !== "saving" && <Input aria-label={`第 ${Number(failure.groupId) + 1} 份答题卡订正学号`} placeholder="订正学号（可选）" value={corrections[failure.groupId] ?? ""} onChange={e => setCorrections(current => ({ ...current, [failure.groupId]: e.target.value }))} disabled={resultsBusy} />}
                    <Button variant="outline" size="sm" disabled={resultsBusy} onClick={() => void retryCard(failure)}>{failure.stage === "saving" ? "重新汇总" : "重新识别此卡"}</Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Combined student result list */}
          {studentResults.length > 0 ? (
            <TableWrap className="rounded-lg border border-border-subtle bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>学号</TableHead>
                    <TableHead numeric>页数</TableHead>
                    <TableHead numeric>总分</TableHead>
                    <TableHead numeric>客观/主观</TableHead>
                    <TableHead numeric>待复核</TableHead>
                    <TableHead>操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {studentResults.map((sr, idx) => (
                    <TableRow key={idx}>
                      <TableCell className={sr.studentId === "未识别" ? "text-warning-foreground" : ""}>
                        {sr.studentId}
                      </TableCell>
                      <TableCell numeric>{sr.pageCount}</TableCell>
                      <TableCell numeric>
                        {sr.totalScore}/{sr.maxScore}
                      </TableCell>
                      <TableCell numeric>{sr.objectiveScore}/{sr.objectiveMaxScore} · {sr.subjectiveScore}/{sr.subjectiveMaxScore}</TableCell>
                      <TableCell numeric>
                        {sr.needsReviewCount > 0 ? (
                          <span className="text-warning-foreground">{sr.needsReviewCount}</span>
                        ) : (
                          sr.needsReviewCount
                        )}
                      </TableCell>
                      <TableCell>
                        <span className="mr-2 text-xs text-muted-foreground">{scannerMode === "remote" ? (uploadState.jobs.find(j => j.id === uploadJobs[sr.groupId])?.message || (uploadJobs[sr.groupId] ? "已加入上传队列" : "待上传")) : (sr.saved ? "已保存" : "待保存")}</span>
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={<Eye size={14} />}
                          onClick={() => setActiveStudent(sr)}
                        >
                          查看
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableWrap>
          ) : (
            <TableWrap className="rounded-lg border border-border-subtle bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead numeric>页码</TableHead>
                    <TableHead>面</TableHead>
                    <TableHead>学号</TableHead>
                    <TableHead>状态</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pages.map((page, idx) => (
                    <TableRow key={idx}>
                      <TableCell numeric>{page.pageNum}</TableCell>
                      <TableCell>{page.side === "front" ? "正面" : "反面"}</TableCell>
                      <TableCell className={page.studentId ? "" : "text-warning-foreground"}>
                        {page.studentId || "未识别"}
                      </TableCell>
                      <TableCell>
                        {page.ocrStatus === "done" ? (
                          <Badge tone="success" dot>
                            已识别
                          </Badge>
                        ) : (
                          <Badge tone="warning" dot>
                            待复核
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableWrap>
          )}

          <Button variant="primary" block disabled={resultsBusy} icon={<RefreshCw size={16} />} onClick={reset}>
            开始新扫描
          </Button>
        </div>
      )}

      {/* v2.5.6：原「点击上方按钮检测扫描仪」独立提示块已移除——
          同一状态（idle 且无数据源）下，「扫描设置」内已含手填数据源与「重新检测」，
          保留两块入口只会让老师分不清该点哪个。 */}

      {activeFailure && <ScanPreviewModal title="失败答题卡" subtitle={activeFailure.message} pages={activeFailure.pages.map(p => ({ ...p, imageUrl: imageUrl(p.recordId) }))} onClose={() => setActiveFailure(null)} />}
      {/* ── PDF-Style Student Detail Modal ──────────────── */}
      {activeStudent && (
        <ScanPreviewModal
          title={`学号: ${activeStudent.studentId}`}
          subtitle={`总分 ${activeStudent.totalScore} / ${activeStudent.maxScore} · 客观 ${activeStudent.objectiveScore} · 主观 ${activeStudent.subjectiveScore}${
            activeStudent.needsReviewCount > 0 ? ` · 待复核 ${activeStudent.needsReviewCount} 题` : ""
          }`}
          pages={activeStudent.pages.map((p) => ({
            recordId: p.recordId,
            pageNum: p.pageNum,
            side: p.side,
            imageUrl: imageUrl(p.recordId),
            objectiveScore: p.objectiveScore,
            subjectiveScore: p.subjectiveScore,
            totalScore: p.totalScore,
            totalMaxScore: p.totalMaxScore,
          }))}
          onClose={() => setActiveStudent(null)}
        />
      )}
    </div>
  );
}

// Removed: StudentDetailModal — replaced by shared ScanPreviewModal
