// v2.5.1: 扫描存储模式（local=本地存储 / remote=上传服务器）共享读写。
// 直扫面板与导入阅卷卡片共用同一 localStorage key，语义一致、记忆互通。
import { useState } from "react";

export type ScannerMode = "local" | "remote";

const MODE_KEY = "projectx_scanner_mode";

export function getScannerMode(): ScannerMode {
  try {
    return (localStorage.getItem(MODE_KEY) as ScannerMode) || "local";
  } catch {
    return "local";
  }
}

export function setScannerMode(m: ScannerMode): void {
  try {
    localStorage.setItem(MODE_KEY, m);
  } catch {
    /* ignore storage failures */
  }
}

/** 是否已配置远端服务器地址（remote 模式上传的前置条件） */
export function isRemoteServerConfigured(): boolean {
  try {
    return (localStorage.getItem("projectx_server_url") ?? "").trim().length > 0;
  } catch {
    return false;
  }
}

/** React 绑定：本地 state + localStorage 双写 */
export function useScannerMode(): [ScannerMode, (m: ScannerMode) => void] {
  const [mode, setModeState] = useState<ScannerMode>(getScannerMode);
  const update = (m: ScannerMode) => {
    setScannerMode(m);
    setModeState(m);
  };
  return [mode, update];
}
