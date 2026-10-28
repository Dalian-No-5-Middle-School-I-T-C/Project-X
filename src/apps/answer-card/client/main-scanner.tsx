/// <reference types="vite/client" />

import React from "react";
import { createRoot } from "react-dom/client";
import { ScannerApp } from "./ScannerApp";
import { AuthProvider } from "./auth/AuthContext";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { reportRendererProblem, ScannerNotice } from "./components/ScannerNotice";
import { TooltipProvider } from "./components/ui/v2";
// 唯一样式入口（与 main.tsx 一致，层序由 app.css 内部保证）
import "./theme/app.css";

// 黑匣子诊断：全局未捕获错误兜底（main-scanner 此前无 ErrorBoundary，白屏无提示）。
// 现场反馈白屏/闪退时最怕整页被覆盖：这里只挂一个可关闭的诊断卡，页面还能继续用。
window.addEventListener("error", (event) => {
  const msg = event.error instanceof Error ? event.error.stack || event.error.message : String(event.message || event.error || "unknown error");
  console.error("[ScannerRenderer] window.error:", msg);
  reportRendererProblem("界面遇到异常", msg);
});
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason instanceof Error ? event.reason.stack || event.reason.message : String(event.reason || "unknown rejection");
  console.error("[ScannerRenderer] unhandledrejection:", reason);
  reportRendererProblem("界面遇到异步异常", reason);
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
      <TooltipProvider>
        <AuthProvider>
          <ScannerApp />
        </AuthProvider>
      </TooltipProvider>
    </ErrorBoundary>
    {/* 通知卡挂在边界外：界面整体降级时，诊断与恢复提示仍然显示得出来 */}
    <ScannerNotice />
  </React.StrictMode>
);
