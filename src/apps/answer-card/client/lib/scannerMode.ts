// v2.5.1: 扫描存储模式（local=本地存储 / remote=上传服务器）共享读写。
// 直扫面板与导入阅卷卡片共用同一 localStorage key，语义一致、记忆互通；
// useScannerMode 实例间经模块级监听器即时同步（两处控件可同屏并存）。
import { useCallback, useEffect, useState } from "react";

export type ScannerMode = "local" | "remote";

const MODE_KEY = "projectx_scanner_mode";

// v2.5.1 审查遗留：服务器地址 key 与 auth/api.ts 的 getRemoteScannerBase 同源，收敛为具名常量
export const SERVER_URL_KEY = "projectx_server_url";

/**
 * v2.5.6：服务器地址归一化——所有读写该 key 的位置必须走这里。
 *
 * 现场根因（「扫描端→主站链路受阻」且服务端日志无任何痕迹）：教师按习惯只填
 * `192.168.1.100:5174`（省略 scheme）。此时 `fetch("192.168.1.100:5174/api/...")`
 * 的 scheme 以数字开头，不是合法 URL，浏览器直接抛 TypeError，请求根本没发出去，
 * 服务端自然看不到任何记录；而 `isRemoteServerConfigured()` 只判非空，
 * 于是界面显示"已配置"，上传却永远失败。
 *
 * 归一化规则：去空白、去尾斜杠；缺 scheme 时补 `http://`；其余内容原样保留
 * （含端口、路径前缀、`https://`）。
 */
export function normalizeServerUrl(raw: string | null | undefined): string {
  const trimmed = (raw ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  // 已带 scheme（http://、https:// 或任何 xxx://）时不再改写
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  // `//host` 形式的省略协议写法按 http 补全
  if (trimmed.startsWith("//")) return `http:${trimmed}`;
  return `http://${trimmed}`;
}

/** 归一化后是否是可用于上传的 http(s) 地址（校验端口/主机名合法性，避免"配置了但发不出去"）。 */
export function isValidServerUrl(raw: string | null | undefined): boolean {
  const normalized = normalizeServerUrl(raw);
  if (!normalized) return false;
  try {
    const url = new URL(normalized);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return url.hostname.length > 0;
  } catch {
    return false;
  }
}

/** 读取已归一化的服务器地址（无配置/非法时返回空串）。 */
export function readServerUrl(): string {
  try {
    return normalizeServerUrl(localStorage.getItem(SERVER_URL_KEY));
  } catch {
    return "";
  }
}

/** 写入服务器地址（自动归一化；空串表示清除配置）。 */
export function writeServerUrl(raw: string): string {
  const normalized = normalizeServerUrl(raw);
  try {
    localStorage.setItem(SERVER_URL_KEY, normalized);
  } catch {
    /* ignore storage failures */
  }
  return normalized;
}

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

/**
 * 是否已**可用**地配置了远端服务器地址（remote 模式上传的前置条件）。
 * v2.5.6：此前只判非空，导致「填了但发不出去」的地址被判为已配置，
 * 界面不再提示、上传静默失败；现要求归一化后是合法 http(s) 地址。
 */
export function isRemoteServerConfigured(): boolean {
  return isValidServerUrl(readServerUrl());
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
