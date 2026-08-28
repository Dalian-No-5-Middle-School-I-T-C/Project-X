/// <reference types="vite/client" />

import React from "react";
import { createRoot } from "react-dom/client";
import { ScannerApp } from "./ScannerApp";
import { AuthProvider } from "./auth/AuthContext";
import { ErrorBoundary } from "./components/ErrorBoundary";
// 唯一样式入口（与 main.tsx 一致，层序由 app.css 内部保证）
import "./theme/app.css";

// 黑匣子诊断：全局未捕获错误兜底（main-scanner 此前无 ErrorBoundary，白屏无提示）
window.addEventListener("error", (event) => {
  const msg = event.error instanceof Error ? event.error.stack || event.error.message : String(event.message || event.error || "unknown error");
  console.error("[ScannerRenderer] window.error:", msg);
  const overlayId = "__px_scanner_error_overlay";
  if (!document.getElementById(overlayId)) {
    const el = document.createElement("div");
    el.id = overlayId;
    el.setAttribute("role", "alert");
    el.style.cssText = "position:fixed;inset:12px;z-index:99999;background:#fff;color:#111;border:2px solid #d32f2f;border-radius:8px;padding:16px;overflow:auto;font:12px/1.5 monospace;white-space:pre-wrap;word-break:break-all;";
    el.textContent = `扫描端渲染异常（已捕获）：\n${msg}\n\n请截图此信息并回传，日志位于 %APPDATA%\\answer-card-designer\\logs\\main.log`;
    document.body.appendChild(el);
  }
});
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason instanceof Error ? event.reason.stack || event.reason.message : String(event.reason || "unknown rejection");
  console.error("[ScannerRenderer] unhandledrejection:", reason);
  const overlayId = "__px_scanner_rejection_overlay";
  if (!document.getElementById(overlayId)) {
    const el = document.createElement("div");
    el.id = overlayId;
    el.setAttribute("role", "alert");
    el.style.cssText = "position:fixed;inset:12px;z-index:99999;background:#fff;color:#111;border:2px solid #d32f2f;border-radius:8px;padding:16px;overflow:auto;font:12px/1.5 monospace;white-space:pre-wrap;word-break:break-all;";
    el.textContent = `扫描端异步异常（已捕获）：\n${reason}\n\n请截图此信息并回传，日志位于 %APPDATA%\\answer-card-designer\\logs\\main.log`;
    document.body.appendChild(el);
  }
});

try {
  const storedTheme = localStorage.getItem("projectx-theme");
  document.documentElement.setAttribute("data-theme", storedTheme === "dark" ? "dark" : "light");
} catch {
  document.documentElement.setAttribute("data-theme", "light");
}

// v2.1.0: 皮肤预置（与 main.tsx 一致）。v2.3.0 起默认皮肤 = 'paper-edge'，
// 其 CSS 覆盖块依赖 data-skin 属性，故 localStorage 有记录即设置（含默认值）。
try {
  const storedSkin = localStorage.getItem("projectx-skin");
  if (storedSkin) {
    document.documentElement.dataset.skin = storedSkin;
  }
} catch {
  /* private browsing / storage disabled */
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <AuthProvider>
        <ScannerApp />
      </AuthProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
