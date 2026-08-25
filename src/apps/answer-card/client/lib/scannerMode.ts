// v2.5.1: 扫描存储模式（local=本地存储 / remote=上传服务器）共享读写。
// 直扫面板与导入阅卷卡片共用同一 localStorage key，语义一致、记忆互通；
// useScannerMode 实例间经模块级监听器即时同步（两处控件可同屏并存）。
import { useCallback, useEffect, useState } from "react";

export type ScannerMode = "local" | "remote";

const MODE_KEY = "projectx_scanner_mode";

// v2.5.1 审查遗留：服务器地址 key 与 auth/api.ts 的 getRemoteScannerBase 同源，收敛为具名常量
export const SERVER_URL_KEY = "projectx_server_url";

const modeListeners = new Set<(m: ScannerMode) => void>();

function readStoredMode(): ScannerMode {
  try {
    // v2.5.1 审查遗留：白名单化解析，杜绝脏值被 cast 成合法档位
    return localStorage.getItem(MODE_KEY) === "remote" ? "remote" : "local";
  } catch {
    return "local";
  }
}

export function getScannerMode(): ScannerMode {
  return readStoredMode();
}

export function setScannerMode(m: ScannerMode): void {
  try {
    localStorage.setItem(MODE_KEY, m);
  } catch {
    /* ignore storage failures */
  }
  for (const l of modeListeners) {
    try {
      l(m);
    } catch {
      /* 订阅方异常不互相影响 */
    }
  }
}

/** 是否已配置远端服务器地址（remote 模式上传的前置条件） */
export function isRemoteServerConfigured(): boolean {
  try {
    return (localStorage.getItem(SERVER_URL_KEY) ?? "").trim().length > 0;
  } catch {
    return false;
  }
}

/** React 绑定：本地 state + localStorage 双写 + 跨实例同步 */
export function useScannerMode(): [ScannerMode, (m: ScannerMode) => void] {
  const [mode, setModeState] = useState<ScannerMode>(readStoredMode);
  useEffect(() => {
    const l = (m: ScannerMode) => setModeState(m);
    modeListeners.add(l);
    return () => {
      modeListeners.delete(l);
    };
  }, []);
  const update = useCallback((m: ScannerMode) => setScannerMode(m), []);
  return [mode, update];
}
