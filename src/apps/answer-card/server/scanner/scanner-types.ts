export interface ScannerSource {
  name: string;
}

/**
 * 检测失败的可区分根因。native 侧（新版 scanner-bridge）直接给出 code；
 * 旧版 exe 只有字段缺失的 JSON，由 twain-bridge 从 stderr / 退出码反推，
 * 保证「不重编译 exe 也能拿到可定位的结论」。
 */
export type ScannerSourcesCode =
  | "OK"                    // 枚举到数据源
  | "NO_SOURCES"            // DSM 正常，但一台扫描仪驱动都没有
  | "DSM_LOAD_FAILED"       // TWAINDSM.dll 缺失/损坏/被隔离
  | "OPENDSM_FAILED"        // DSM_Entry(OPENDSM) 失败（设备离线、环境受限、位宽不匹配）
  | "WINDOW_CREATE_FAILED"  // 桥接进程无法创建 TWAIN 宿主窗口
  | "BRIDGE_MISSING"        // scanner-bridge.exe 未找到，或无法启动（缺运行库/位宽错误）
  | "BRIDGE_EXIT_NONZERO"   // 桥接进程非零退出且没有可用输出
  | "BRIDGE_NO_OUTPUT"      // 桥接进程输出了无法解析的内容
  | "UNKNOWN";

export interface ScannerSourcesResult {
  status: "ok" | "error";
  sources: ScannerSource[];
  message?: string;
  /** 按根因给出的可操作建议（位宽、驱动、运行库等） */
  hint?: string;
  code?: ScannerSourcesCode;
  /** 当前扫描端进程位宽：32 位驱动只能被 ia32 版枚举，反之亦然 */
  arch?: string;
  dsmLoaded?: boolean;
  dsmPath?: string;
  /** DSM 加载失败时各候选路径的探试记录 */
  dsmSearch?: string;
  openDsmRc?: number;
  conditionCode?: number;
  windowCreated?: boolean;
  /** 桥接进程 stderr 原文：现场自证的原始证据 */
  bridgeStderr?: string;
  exitCode?: number | null;
}

export interface ScannerCapabilities {
  sourceName: string;
  maxDpi: number;
  supportsDuplex: boolean;
  supportsADF: boolean;
  colorModes: string[];
  paperSizes: string[];
}

export interface ScanPage {
  path: string;
  page: number;
  side: "front" | "back";
  width: number;
  height: number;
}

export interface BridgeScanResult {
  status: "ok" | "error";
  page_count: number;
  pages: ScanPage[];
  message?: string;
}

export interface ScanSessionConfig {
  cardId: string;
  sessionName: string;
  sourceName: string;
  dpi: number;
  duplex: boolean;
  colorMode: "gray" | "color" | "bw";
  paperSize: "A4" | "Letter" | "A3";
  maxPages: number;
  showUi?: boolean;
  /** 等待下一页（ADF 送纸）的空闲超时，毫秒。留空走 native 默认 15000。 */
  pageTimeoutMs?: number;
}

export interface ScanProgressEvent {
  sessionId: string;
  type: "scanning" | "page_done" | "ocr_start" | "ocr_page_done" | "ocr_done" | "error" | "done" | "cancelled";
  recordId?: string;
  pageNum?: number;
  side?: string;
  totalPages?: number;
  studentId?: string | null;
  studentConf?: number;
  message?: string;
}
