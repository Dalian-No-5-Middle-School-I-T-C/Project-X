import { CardCorrectionButton } from "./CardCorrectionEditor";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { uniqueScanConflictCards } from "../../../../shared/scanPages";
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
import { isGroupQueued } from "../lib/scannerUploadLedger";
import type { ScanBatchResponse, ScanBatchFailure, ScanBatchResult, ScanConflictCard } from "../../../../shared/scanPages";
import type { ScannerSourcesResult, ScanProgressEvent } from "../../server/scanner/scanner-types";
import { ScanPreviewModal } from "./ScanPreviewModal";
import type { AnswerCard } from "../../../../shared/types";
import { cardFingerprint } from "../../../../shared/cardVersion";
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
  notify,
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
  /** 继续扫描/重开前把当前会话交给后处理页：部分中断的批次不能因为离开面板就消失。 */
  onBatchArchived?: (sessionId: string, pageCount: number) => void;
  /** 从后处理页点「继续扫描」进入时自动开始下一批；消费后回调避免刷新重复触发。 */
  autoStartScan?: boolean;
  onAutoStartConsumed?: () => void;
  onClose?: () => void;
}

type ScannerState =
  | "idle"
  | "detecting"
  | "ready"
  | "scanning"
  | "recognizing"
  | "done"
  | "partial"
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

/** 扫描设置跨批次记忆：继续扫描会重挂载面板，DPI/色彩/纸型不该回到默认值。 */
const SCAN_SETTINGS_KEY = "projectx-scanner-settings-v1";
type StoredScanSettings = {
  dpi: number;
  colorMode: "gray" | "color" | "bw";
  paperSize: "A4" | "Letter" | "A3";
  maxSheets: number;
  pageTimeoutSec: number;
  showUi: boolean;
  selectedSource: string;
};

function readStoredScanSettings(): Partial<StoredScanSettings> {
  try {
    const parsed = JSON.parse(localStorage.getItem(SCAN_SETTINGS_KEY) || "null") as Partial<StoredScanSettings> | null;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function ScannerPanel({ cardId, onScansComplete, onBatchArchived, autoStartScan, onAutoStartConsumed, onClose }: ScannerPanelProps) {
  const storedSettings = useRef(readStoredScanSettings()).current;
  const [state, setState] = useState<ScannerState>("idle");
  const [sources, setSources] = useState<string[]>([]);
  const [selectedSource, setSelectedSource] = useState(storedSettings.selectedSource ?? "");
  const [dpi, setDpi] = useState(storedSettings.dpi ?? 300);
  const [duplex, setDuplex] = useState(false);
  const [legacyIdentity, setLegacyIdentity] = useState(false);
  const [sessionLegacyIdentity, setSessionLegacyIdentity] = useState(false);
  const [showUi, setShowUi] = useState(storedSettings.showUi ?? false);
  const [colorMode, setColorMode] = useState<"gray" | "color" | "bw">(storedSettings.colorMode ?? "color");
  const [paperSize, setPaperSize] = useState<"A4" | "Letter" | "A3">(storedSettings.paperSize ?? "A4");
  // 单次批扫上限按「张」输入（0=不限，最高 400 张）；发给服务端时按单双面折算成页数
  const [maxSheets, setMaxSheets] = useState(storedSettings.maxSheets ?? 0);
  // 等纸空闲超时（秒）：0=用 native 默认 60s。厚纸/慢速 ADF 进纸间隔大时需要调高，
  // 否则会出现「扫到一半提前收尾」。历史默认 15s 对 300/600dpi ADF 偏短。
  const [pageTimeoutSec, setPageTimeoutSec] = useState(storedSettings.pageTimeoutSec ?? 0);
  // 检测诊断（根因/建议/原始输出）：把「未检测到扫描仪」这一类笼统文案拆成可操作结论
  const [sourcesDiag, setSourcesDiag] = useState<ScannerSourcesResult | null>(null);
  const [sessionId, setSessionId] = useState("");
  const [progressMessage, setProgressMessage] = useState("");
  const [pages, setPages] = useState<ScanPage[]>([]);
  const [errorMessage, setErrorMessage] = useState("");
  const [scanErrorMessage, setScanErrorMessage] = useState("");
  const partialSessionRef = useRef(false);
  const [studentResults, setStudentResults] = useState<StudentResult[]>([]);
  const [failures, setFailures] = useState<ScanBatchFailure[]>([]);
  const [reviewCards, setReviewCards] = useState<ScanConflictCard[]>([]);
  const [activeFailure, setActiveFailure] = useState<ScanBatchFailure | null>(null);
  const [corrections, setCorrections] = useState<Record<string, string>>({});
  const [resultsBusy, setResultsBusy] = useState(false);
  const resultsBusyRef = useRef(false);
  const [resultMessage, setResultMessage] = useState("");
  // 扫描阶段告警（type: "warning"）：流程继续但结果与设定不符，例如驱动替代了分辨率
  const [scanWarnings, setScanWarnings] = useState<string[]>([]);
  const [uploadJobs, setUploadJobs] = useState<Record<string, string>>({});
  const uploadJobsRef = useRef<Record<string, string>>({});
  const sessionUploadRef = useRef<{ sessionId: string; cardId: string;
    identityMode: "strict" | "legacy"; cardVersion: string; dpi: number; paperSize: string } | null>(null);
  const scanAttemptRef = useRef(0);
  const uploadState = useSyncExternalStore(scannerUploadManager.subscribe, scannerUploadManager.getState);
  const [activeStudent, setActiveStudent] = useState<StudentResult | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  // 用 ref 追踪最新值，避免 SSE onmessage / setTimeout 闭包捕获到过期的 state
  const pagesRef = useRef<ScanPage[]>([]);
  const sessionIdRef = useRef("");
  /** 卸载时才取的回调：卸载清理的闭包里读 props 会拿到第一次渲染的值。 */
  const onBatchArchivedRef = useRef(onBatchArchived);
  useEffect(() => { onBatchArchivedRef.current = onBatchArchived; }, [onBatchArchived]);

  // UI-5: SSE 断开重连状态
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const completedRef = useRef(false);
  const [disconnected, setDisconnected] = useState(false);
  // v2.5.6：诊断复制反馈（老师现场无法翻日志，一键复制即可反馈）
  const [diagCopied, setDiagCopied] = useState(false);
  /** 继续扫描自动开扫前，先等答题卡默认纸型/单双面读回来，避免用默认 A4/单面开第一批。 */
  const [cardSettingsReady, setCardSettingsReady] = useState(false);
  /** 自动续扫还要等数据源枚举结束：否则枚举晚到会把正在扫描的界面切回 ready，或覆盖上次选定的设备。 */
  const [sourcesReady, setSourcesReady] = useState(false);
  const detectAttemptRef = useRef(0);
  const autoStartedRef = useRef(false);

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
    uploadJobsRef.current = uploadJobs;
  }, [uploadJobs]);

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
      .catch(() => undefined)
      .finally(() => { if (active) setCardSettingsReady(true); });
    return () => {
      active = false;
    };
  }, [cardId]);

  // 扫描设置跨批次记忆：继续扫描重挂载后仍用上一次的 DPI/色彩/纸型/数据源。
  useEffect(() => {
    try {
      const settings: StoredScanSettings = { dpi, colorMode, paperSize, maxSheets, pageTimeoutSec, showUi, selectedSource };
      localStorage.setItem(SCAN_SETTINGS_KEY, JSON.stringify(settings));
    } catch { /* 存储不可用不影响本次扫描 */ }
  }, [dpi, colorMode, paperSize, maxSheets, pageTimeoutSec, showUi, selectedSource]);

  // 从后处理页点「继续扫描」：面板挂载并读到答题卡设置后自动开下一批。
  useEffect(() => {
    if (!autoStartScan || !cardSettingsReady || !sourcesReady || autoStartedRef.current) return;
    autoStartedRef.current = true;
    onAutoStartConsumed?.();
    void startScan();
    // startScan 是组件内函数声明；只允许在进入时消费一次自动开扫标记。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStartScan, cardSettingsReady, sourcesReady]);

  // Detect sources on mount
  useEffect(() => {
    detectSources();
    return () => {
      eventSourceRef.current?.close();
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      // 卸载后仍有在途的启动请求：自增尝试号让它在返回时走取消分支，别在新会话上继续开流。
      scanAttemptRef.current += 1;
      // 离开面板（关闭 / 返回工作台 / 切走卡片）不等于放弃这一批：扫描还在跑就先停设备，
      // 已扫出的页面交给后处理页，避免后台继续送纸却再也找不到这批卷的入口。
      const sid = sessionIdRef.current;
      if (!sid) return;
      if (!completedRef.current) {
        // 停不下来必须让老师知道：设备可能还在送纸，界面却已经没有这批卷的入口。
        void authFetch(`/api/scanner/scan/${sid}/cancel`, { method: "POST" }).catch((error) => {
          console.error("[scanner] 离开面板时停止扫描失败", error);
          notify.error("未能确认扫描仪已停止，请检查设备是否还在送纸");
        });
      }
      const pageCount = pagesRef.current.length;
      if (pageCount > 0) onBatchArchivedRef.current?.(sid, pageCount);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function detectSources() {
    const attempt = ++detectAttemptRef.current;
    const scanAtStart = scanAttemptRef.current;
    setSourcesReady(false);
    // 重新检测前丢弃上次枚举的列表；否则本次失败后仍会显示旧下拉框，
    // 老师无法使用留空或手填数据源的兜底入口。已记忆的数据源先留着，成功后再判断是否仍有效。
    setSources([]);
    setState("detecting");
    setSourcesDiag(null);
    try {
      const res = await authFetch("/api/scanner/sources");
      const data = (await res.json()) as ScannerSourcesResult;
      // 扫描已在本轮检测期间启动：晚到的检测结果不能把 scanning 改回 ready。
      if (attempt !== detectAttemptRef.current || scanAttemptRef.current !== scanAtStart) return;
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
        setSelectedSource((previous) => {
          const remembered = previous.trim();
          return remembered && data.sources.some((source) => source.name === remembered)
            ? remembered
            : kodak?.name || data.sources[0].name;
        });
        setState("ready");
      } else {
        setSourcesDiag(data);
        setErrorMessage(data.message || "未检测到扫描仪");
        setState("error");
      }
    } catch (err) {
      if (attempt !== detectAttemptRef.current || scanAttemptRef.current !== scanAtStart) return;
      setErrorMessage(err instanceof Error ? err.message : "检测扫描仪失败");
      setState("error");
    } finally {
      if (attempt === detectAttemptRef.current) setSourcesReady(true);
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
      `错误信息：${[scanErrorMessage, errorMessage].filter(Boolean).join("；") || "（无）"}`,
      `扫描告警：${scanWarnings.join("；") || "（无）"}`,
      ...(sourcesDiag ? diagnosticLines(sourcesDiag) : ["（无检测诊断数据）"]),
    ].join("\n");
  }

  /**
   * v2.5.6：一键复制诊断。
   *
   * 走两条路（CR #313 P2-7）：Clipboard API 抛错**和**不存在都要回退到隐藏 textarea。
   * 只判 `navigator.clipboard?.writeText` 是否存在是不够的——扫描端是 Electron 壳，
   * R23 的权限策略对设备能力默认拒绝，writeText 会好好存在却以 NotAllowedError 失败，
   * 于是「复制诊断」按下去毫无反馈，而它正是现场自证、少走弯路的入口。
   */
  async function copyDiagnostics(): Promise<void> {
    const text = diagnosticText();
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        copied = true;
      }
    } catch {
      copied = false; // 权限被拒/文档失焦：交给下面的回退
    }
    if (!copied) copied = copyViaTextarea(text);
    setDiagCopied(copied);
    if (copied) setTimeout(() => setDiagCopied(false), 2000);
  }

  /** 回退路径：以 execCommand 的真实返回值为准，不谎报成功。 */
  function copyViaTextarea(text: string): boolean {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
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
          case "warning": {
            // 不能并进 progressMessage：紧随其后的 ocr_start 会把它冲掉，老师根本看不到
            const text = data.message?.trim();
            if (text) setScanWarnings((prev) => (prev.includes(text) ? prev : [...prev, text]));
            break;
          }
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
            completedRef.current = true;
            es.close();
            // 首次订阅或重连可能只收到终态，页面以持久化记录为准。
            partialSessionRef.current = true;
            setState("partial");
            setScanErrorMessage(data.message || "扫描出错");
            void fetchCombinedResults(sid);
            break;
          case "cancelled":
            completedRef.current = true;
            es.close();
            setState("idle");
            setProgressMessage(data.message || "扫描已取消");
            break;
          case "done":
            completedRef.current = true;
            es.close();
            setState("done");
            // 通过 ref 读取最新页数，避免闭包捕获扫描开始时的空数组
            onScansComplete?.(sid, pagesRef.current.length);
            // Summarize and queue successful cards using this session's snapshot.
            void fetchCombinedResults(sid);
            break;
        }
      };

      es.onerror = () => {
        es.close();
        // 服务端关闭终态流后无需重连。
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
    if (data.warnings?.length) {
      setScanWarnings(prev => [...new Set([...prev, ...data.warnings!])]);
    }
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
    // SSE 回调及订正后的刷新都必须沿用本会话的失败状态，避免刷新触发自动上传。
    const partial = partialSessionRef.current;
    const attempt = scanAttemptRef.current;
    const current = () => sid === sessionIdRef.current && attempt === scanAttemptRef.current;
    resultsBusyRef.current = true;
    setResultsBusy(true);
    setErrorMessage("");
    try {
      if (partial) {
        const response = await authFetch(`/api/scanner/scan/${sid}`);
        const snapshot = await response.json();
        if (!current()) return;
        if (!response.ok) throw new Error(snapshot.message || `读取保留页面失败（HTTP ${response.status}）`);
        const records = snapshot.records as Array<Omit<ScanPage, "recordId"> & { id: string }>;
        const retainedPages = records.map(({ id, ...page }) => ({ ...page, recordId: id }));
        pagesRef.current = retainedPages;
        setPages(retainedPages);
        if (retainedPages.length === 0) {
          partialSessionRef.current = false;
          setState("error");
          setScanErrorMessage("");
          setErrorMessage(snapshot.session.error_msg || "扫描出错");
          return;
        }
      }
      const data = await readResults(sid);
      if (!current()) return;
      applyResults(data);
      // 远端模式：成绩汇总一完成即自动后台上传（先出分、图片续传，进度见右上角进度条）
      if (!partial && getScannerMode() === "remote" && isRemoteServerConfigured()) {
        queueSuccessfulUploads(data, sid);
      }
    }
    catch (err) {
      if (!current()) return;
      const message = err instanceof Error ? err.message : "汇总失败，请重试";
      setErrorMessage(message);
    }
    finally { if (current()) { resultsBusyRef.current = false; setResultsBusy(false); } }
  }

  /** 把成功答题卡加入后台上传队列（自动与手动共用；已入队的组自动跳过） */
  function queueSuccessfulUploads(data: ScanBatchResponse, sid: string) {
    const metadata = sessionUploadRef.current;
    if (!metadata || metadata.sessionId !== sid) return;
    const nextJobs = { ...uploadJobsRef.current };
    let queued = 0;
    for (const result of data.results) {
      // 存疑题随结果一起上传，由服务器保存并返回 needsReviewCount；不要在上传前拦下整份卷。
      if (nextJobs[result.groupId]) continue;
      if (isGroupQueued(metadata.cardId, sid, result.groupId)) continue;
      if (scannerUploadManager.hasGroupUpload(metadata.cardId, result.groupId, sid)) continue;
      // Independent cards can finish even when another card fails remotely.
      nextJobs[result.groupId] = scannerUploadManager.startUpload({
        identityMode: metadata.identityMode,
        kind: "scan", cardId: metadata.cardId, name: `扫描_${result.studentId}`,
        localSessionId: sid,
        dpi: metadata.dpi, paperSize: metadata.paperSize, cardVersion: metadata.cardVersion,
        pages: result.pages.map(page => ({
          recordId: page.recordId,
          pageNum: page.pageNum, side: page.side, groupId: result.groupId,
          layoutPage: page.layoutPage, studentId: result.studentId,
          getCorrection: async () => {
            const response = await authFetch(`/api/scanner/session/${sid}/groups/${result.groupId}/correction`);
            if (response.status === 409) return undefined; // Older scans have no alignment snapshot.
            if (!response.ok) throw new Error("读取已保存的填涂订正失败");
            const document = await response.json() as import("../../../../shared/scanCorrection").CorrectionDocument;
            return document.pages.find(p => p.sourceId === page.recordId)?.recognition;
          },
          getBlob: async () => {
            const res = await authFetch(`/api/scanner/scan-image/${page.recordId}`);
            if (!res.ok) throw new Error(`读取本机扫描图失败（HTTP ${res.status}）`);
            return res.blob();
          },
        })),
      });
      queued++;
    }
    uploadJobsRef.current = nextJobs;
    setUploadJobs(nextJobs);
    if (queued > 0) setResultMessage("成功答题卡已加入上传队列，图片将在后台续传；失败答题卡保留在本机，可继续订正。");
  }

  /** 这一组不再有上传任务占位：清掉行内标记，否则 queueSuccessfulUploads 会永久跳过它（评审 P2）。 */
  function forgetQueuedMarker(groupId: string) {
    const nextJobs = { ...uploadJobsRef.current };
    delete nextJobs[groupId];
    uploadJobsRef.current = nextJobs;
    setUploadJobs(nextJobs);
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
        queueSuccessfulUploads(data, sessionId);
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
    const attempt = ++scanAttemptRef.current;
    // 继续扫描/重开前先断开上一批的 SSE：旧批次在后台跑完时不能再把界面从新批次切走。
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    setDisconnected(false);
    // v2.5.6：不再因「没选到数据源」静默 return——那会把老师直接挡在门外且毫无反馈。
    // 留空是合法输入：服务端 sourceName 缺省为 ""，桥接在枚举为空或名称无匹配时
    // 回退 MSG_GETDEFAULT（系统默认数据源）；真失败时由 bridge 返回可诊断的错误。
    setState("scanning");
    setErrorMessage("");
    setScanErrorMessage("");
    partialSessionRef.current = false;
    resultsBusyRef.current = false;
    setResultsBusy(false);
    setPages([]);
    pagesRef.current = [];
    setStudentResults([]);
    setFailures([]);
    setReviewCards([]);
    setCorrections({});
    setUploadJobs({});
    uploadJobsRef.current = {};
    sessionUploadRef.current = null;
    setResultMessage("");
    setScanWarnings([]);
    reconnectAttemptsRef.current = 0;
    completedRef.current = false;
    setDisconnected(false);
    setActiveStudent(null);
    setSessionLegacyIdentity(false);
    setSessionId("");
    sessionIdRef.current = "";

    try {
      // Fetch before starting OMR so even an early click has a nonempty, pinned
      // version. SSE callbacks read the resulting session snapshot through a ref.
      const cardResponse = await authFetch(`/api/cards/${encodeURIComponent(cardId)}`);
      if (!cardResponse.ok) throw new Error("读取答题卡版本失败，请重试");
      const card = await cardResponse.json() as AnswerCard;
      const version = cardFingerprint(card);
      if (attempt !== scanAttemptRef.current) return;
      const identityMode = legacyIdentity ? "legacy" : "strict";
      const res = await authFetch("/api/scanner/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cardId,
          sourceName: selectedSource,
          sessionName: `扫描_${cardId}_${new Date().toLocaleString("zh-CN")}`,
          dpi,
          duplex,
          identityMode,
          colorMode,
          paperSize,
          maxPages: maxSheets > 0 ? maxSheets * (duplex ? 2 : 1) : 0,
          showUi,
          // 0 表示沿用 native 默认（60000ms）
          pageTimeoutMs: pageTimeoutSec > 0 ? Math.round(pageTimeoutSec * 1000) : undefined,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "启动扫描失败");
      }

      const data = await res.json();
      if (attempt !== scanAttemptRef.current) {
        void authFetch(`/api/scanner/scan/${data.sessionId}/cancel`, { method: "POST" }).catch(() => undefined);
        return;
      }
      sessionUploadRef.current = { sessionId: data.sessionId, cardId, identityMode,
        cardVersion: version, dpi, paperSize };
      sessionIdRef.current = data.sessionId;
      setSessionId(data.sessionId);
      setSessionLegacyIdentity(identityMode === "legacy");
      setLegacyIdentity(false);
      listenProgress(data.sessionId);
    } catch (err) {
      if (attempt !== scanAttemptRef.current) return;
      setErrorMessage(err instanceof Error ? err.message : "扫描失败");
      setState("error");
    }
  }

  function cancelScan() {
    scanAttemptRef.current++;
    sessionUploadRef.current = null;
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

  /** 把当前会话交给后处理页：继续扫描/开始新扫描离开面板后，部分中断的批次仍能回去处理。 */
  function archiveCurrentBatch() {
    const sid = sessionIdRef.current;
    const pageCount = pagesRef.current.length;
    if (sid && pageCount > 0) onBatchArchived?.(sid, pageCount);
  }

  /** 同一答题卡继续扫下一批：保留上一批结果，新批次完成后在「扫描后处理」里一起保存。 */
  function continueScan() {
    if (resultsBusyRef.current) return;
    archiveCurrentBatch();
    void startScan();
  }

  function reset() {
    archiveCurrentBatch();
    scanAttemptRef.current++;
    eventSourceRef.current?.close();
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    setDisconnected(false);
    reconnectAttemptsRef.current = 0;
    completedRef.current = false;
    resultsBusyRef.current = false;
    setResultsBusy(false);
    setState("idle");
    setSessionId("");
    sessionIdRef.current = "";
    setPages([]);
    pagesRef.current = [];
    setStudentResults([]);
    setFailures([]);
    setCorrections({});
    setUploadJobs({});
    uploadJobsRef.current = {};
    sessionUploadRef.current = null;
    setResultMessage("");
    setScanWarnings([]);
    setActiveStudent(null);
    setProgressMessage("");
    setErrorMessage("");
    setScanErrorMessage("");
    partialSessionRef.current = false;
    setSourcesDiag(null);
    detectSources();
  }

  function imageUrl(recordId: string): string {
    return mediaUrl(`/api/scanner/scan-image/${recordId}`);
  }

  return (
    <div className="flex flex-col gap-4">
      {sessionLegacyIdentity && <p role="status" className="m-0 rounded-md bg-warning-soft p-3 text-sm text-foreground">本次会话兼容旧卡：无可读二维码的页面未校验卡 ID，请人工核对。</p>}
      {/* 扫描告警（例如驱动把设定分辨率替代成了别的档位）：与错误态分开——纸已经扫出来、
          流程继续，但结果与设定不符，必须在出分前让老师看得见，而不是只留在日志里。 */}
      {scanWarnings.length > 0 && (
        <div role="status" className="flex flex-col gap-2 rounded-md border border-warning-border bg-warning-soft px-3 py-3 text-sm text-foreground">
          {scanWarnings.map((warning) => (
            <div key={warning} className="flex items-start gap-2">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <span className="min-w-0 flex-1 break-words">{warning}</span>
            </div>
          ))}
        </div>
      )}
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
      {(state === "error" || state === "partial") && (
        <div className="flex flex-col gap-2 rounded-md border border-destructive-border bg-destructive-soft px-3 py-3 text-sm text-destructive-fg">
          <div className="flex items-center gap-2">
            <AlertTriangle size={20} className="shrink-0" />
            <span className="min-w-0 flex-1 break-words">{state === "partial" ? scanErrorMessage : errorMessage}</span>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              icon={diagCopied ? <Check size={14} /> : <Copy size={14} />}
              onClick={() => void copyDiagnostics()}
            >
              {diagCopied ? "已复制" : "复制诊断"}
            </Button>
            {state === "error" && <Button variant="outline" size="sm" className="shrink-0" icon={<RefreshCw size={14} />} onClick={detectSources}>
              重试
            </Button>}
          </div>
          {sourcesDiag?.hint && (
            <p className="m-0 text-xs leading-relaxed">{sourcesDiag.hint}</p>
          )}
          {sourcesDiag && diagnosticLines(sourcesDiag).length > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer select-none opacity-80">
                技术细节
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
                  hint="未枚举到 TWAIN 数据源：留空即由桥接改用系统默认数据源；也可直接填入厂商扫描软件中显示的「数据源名称」。"
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
                  未检测到扫描仪列表，但不阻止扫描：若扫描仪厂商软件能正常扫描，直接留空点下方「开始扫描」即可。
                  若仍失败，请展开上方错误信息中的「技术细节」并复制反馈。
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
              <Field label="单次最多张数">
                <Input
                  type="number"
                  min={0}
                  max={400}
                  value={maxSheets}
                  onChange={(e) => setMaxSheets(Math.max(0, Math.min(400, Math.trunc(Number(e.target.value)) || 0)))}
                  placeholder="0=不限（最高400）"
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
                placeholder="0=默认 60 秒"
              />
            </Field>
            <p className="m-0 text-xs text-muted-foreground">
              进纸后若超过该时长没有下一张，扫描即视为结束。多张连续扫描时建议不低于 30 秒；
              留 0 使用默认值 60 秒（有效范围 2–120 秒）。
            </p>

            <ControlRow
              control={<Checkbox checked={legacyIdentity} onCheckedChange={(c) => setLegacyIdentity(c === true)} />}
              label="兼容旧卡"
            />
            <ControlRow
              control={<Checkbox checked={duplex} onCheckedChange={(c) => setDuplex(c === true)} />}
              label="双面扫描"
            />
            <ControlRow
              control={<Checkbox checked={showUi} onCheckedChange={(c) => setShowUi(c === true)} />}
              label="显示扫描仪界面"
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

      {/* 已完成的批次与中断后保留的部分结果共用查看、订正和显式保存入口。 */}
      {(state === "done" || state === "partial") && (
        <div className="flex flex-col gap-3">
          <div className={`flex items-center gap-2 rounded-md border px-3 py-3 text-sm ${state === "partial" ? "border-warning-border bg-warning-soft text-warning-foreground" : "border-success-border bg-success-soft text-success-foreground"}`}>
            {state === "partial" ? <AlertTriangle size={20} className="shrink-0" /> : <Check size={20} className="shrink-0" />}
            <span>
              {state === "partial" ? pages.length > 0 ? `扫描中断，已保留 ${pages.length} 页` : "扫描中断，保留页面待确认" : "扫描完成"} — {resultsBusy ? "正在汇总…" : `${studentResults.length} 份成功，${failures.length} 份失败`}
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
          {(reviewCards.length > 0 || failures.some(f => f.conflicts?.length)) && <ScannerConflictCards
            cards={uniqueScanConflictCards([...reviewCards, ...failures.flatMap(f => f.conflicts ?? [])])}
            onChanged={() => fetchCombinedResults(sessionId)} />}
          {failures.length > 0 && (
            <div className="flex flex-col gap-3 rounded-md border border-warning-border bg-warning-soft p-3">
              <strong>以下答题卡未保存</strong>
              <p className="text-sm">可查看图片，订正学号后重新识别。缺页、错页或图像不清时，请整理原卷后重新扫描整份答题卡。</p>
              {failures.map(failure => (
                <div key={failure.groupId} className="flex flex-col gap-2 border-t border-border-subtle pt-2">
                  <span className="text-sm">{failure.studentId || "未识别学号"} · {failure.pages.map(p => `第 ${p.pageNum} 张${p.side === "front" ? "正面" : "背面"}`).join("、")}：{failure.message}</span>
                  {!failure.conflicts?.length && <div className="flex flex-wrap items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => setActiveFailure(failure)}>查看失败卡</Button>
                    <CardCorrectionButton disabled={resultsBusy} url={`/api/scanner/session/${sessionId}/groups/${failure.groupId}/correction`} onSaved={() => fetchCombinedResults(sessionId)} />
                    {failure.stage !== "saving" && <Input aria-label={`第 ${Number(failure.groupId) + 1} 份答题卡订正学号`} placeholder="订正学号（可选）" value={corrections[failure.groupId] ?? ""} onChange={e => setCorrections(current => ({ ...current, [failure.groupId]: e.target.value }))} disabled={resultsBusy} />}
                    <Button variant="outline" size="sm" disabled={resultsBusy} onClick={() => void retryCard(failure)}>{failure.stage === "saving" ? "重新汇总" : "重新识别此卡"}</Button>
                  </div>}
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
                        {!sr.saved && (() => {
                          // 逐页上传时每页现读本机订正：在途或仍留着可续传的半成品时改分，
                          // 先传出去的页保留旧识别、后传出去的页带上新识别，服务器会收到半旧半新的一份快照。
                          const cardId = sessionUploadRef.current?.cardId ?? null;
                          const block = scannerUploadManager.groupUploadBlock(cardId, sr.groupId, sessionId);
                          const resumable = block === "partial-pages";
                          return (
                            <>
                              <CardCorrectionButton disabled={resultsBusy || block !== null}
                                disabledReason={block === "recovery-damaged"
                                  ? "本机上传恢复记录已损坏，读不出远端会话与逐页进度；这一卷可能已经入库，改分或重传都会改写正式成绩。请先在服务器核对原上传会话，再点「已核对服务器，清除损坏记录」"
                                  : block === "completion-pending"
                                  ? "这一卷的页面都已上传、只差提交（重复学号这类冲突是服务器拒的）；现在改分会让服务器收到半旧半新的识别结果，请先「重试保存」或处理冲突卷"
                                  : resumable
                                  ? "这一卷已上传一部分、还有失败页可续传；现在改分会让服务器收到半旧半新的识别结果。请先「重试失败页」，或点「放弃续传」后再改分"
                                  : "这一卷正在上传；现在改分会让服务器收到半旧半新的识别结果，请等它传完或先取消任务"}
                                url={`/api/scanner/session/${sessionId}/groups/${sr.groupId}/correction`} onSaved={() => {
                                // 远端模式下本机 saved 不会因上传完成而变化：这一卷已经交给服务器，
                                // 工作台再改分只留本机，不提示就会静默分歧（与后处理页同一句话）。
                                if (scannerMode === "remote" && uploadJobs[sr.groupId]) {
                                  setResultMessage("该卷已随本批上传，本机改动不再重复上传；服务器成绩请走 Web 成绩修改。");
                                }
                                void fetchCombinedResults(sessionId);
                              }}
                              />
                              {resumable && cardId && (
                                <Button variant="ghost" size="sm" onClick={() => {
                                  if (!window.confirm("放弃续传后，已上传的半成品不再补传，这一卷可以立即整卡改分（改完请整卷重新上传）。服务器上的半成品会话不会写入成绩。确定放弃吗？")) return;
                                  const result = scannerUploadManager.abandonGroupUpload(cardId, sr.groupId, sessionId);
                                  if (!result.ok) { setResultMessage(result.message); return; }
                                  forgetQueuedMarker(sr.groupId);
                                  setResultMessage("已放弃这一卷的续传，现在可以整卡改分；保存后这一卷会随下一次上传整卷重传。");
                                }}>
                                  放弃续传
                                </Button>
                              )}
                              {block === "recovery-damaged" && cardId && (
                                <Button variant="ghost" size="sm" onClick={() => {
                                  const remoteSessionId = scannerUploadManager.damagedRecoverySessionId(cardId, sr.groupId, sessionId);
                                  if (!window.confirm(`本机上传恢复记录已损坏，无法确认这份卷在服务器上是否已经入库${remoteSessionId ? `（原上传会话 ${remoteSessionId}）` : ""}。请先在成绩或异常卷列表里核对那一份：确认没有已保存的成绩之后，再清除本机记录；清除后这一卷会按新会话重新上传。确定已经核对过吗？`)) return;
                                  const result = scannerUploadManager.discardDamagedRecovery(cardId, sr.groupId, sessionId);
                                  if (!result.ok) { setResultMessage(result.message); return; }
                                  forgetQueuedMarker(sr.groupId);
                                  setResultMessage("已清除损坏的恢复记录；请先把这一卷的填涂核对确认，再整卷重新上传。");
                                }}>
                                  已核对服务器，清除损坏记录
                                </Button>
                              )}
                            </>
                          );
                        })()}
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

          <div className="flex flex-col gap-2">
            <Button variant="primary" block disabled={resultsBusy} icon={<RefreshCw size={16} />} onClick={reset}>
              开始新扫描
            </Button>
            <Button variant="outline" block disabled={resultsBusy} icon={<Play size={16} />} onClick={continueScan}>
              继续扫描
            </Button>
            <p className="m-0 text-xs text-muted-foreground">
              继续扫描会在同一张答题卡下再扫一批，已扫结果保留在「扫描后处理」，可一起核对和保存。
            </p>
          </div>
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
