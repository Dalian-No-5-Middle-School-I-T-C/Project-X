export interface ScannerSource {
  name: string;
}

export interface ScannerSourcesResult {
  status: "ok" | "error";
  sources: ScannerSource[];
  message?: string;
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
}

export interface ScanProgressEvent {
  sessionId: string;
  type: "scanning" | "page_done" | "ocr_start" | "ocr_page_done" | "ocr_done" | "error" | "done";
  pageNum?: number;
  side?: string;
  totalPages?: number;
  studentId?: string | null;
  studentConf?: number;
  message?: string;
}
