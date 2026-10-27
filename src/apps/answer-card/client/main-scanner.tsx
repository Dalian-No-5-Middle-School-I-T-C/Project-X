/// <reference types="vite/client" />

import React from "react";
import { createRoot } from "react-dom/client";
import { ScannerApp } from "./ScannerApp";
import { AuthProvider } from "./auth/AuthContext";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { TooltipProvider } from "./components/ui/v2";
// 唯一样式入口（与 main.tsx 一致，层序由 app.css 内部保证）
import "./theme/app.css";

// 黑匣子诊断：全局未捕获错误兜底（main-scanner 此前无 ErrorBoundary，白屏无提示）。
// 现场反馈白屏/闪退时最怕整页被覆盖：这里只挂一个可关闭的诊断卡，页面还能继续用。
function showRendererProblem(title: string, detail: string): void {
  const overlayId = "__px_scanner_problem_overlay";
  const existing = document.getElementById(overlayId);
  if (existing) return;
  const card = document.createElement("div");
  card.id = overlayId;
  card.setAttribute("role", "alert");
  card.style.cssText = "position:fixed;left:16px;bottom:16px;z-index:99999;max-width:440px;background:var(--px-bg-surface);color:var(--px-fg-primary);border:1px solid var(--px-border-default);border-left:4px solid var(--px-warning-bg);border-radius:var(--px-radius-md);padding:12px 14px;box-shadow:0 8px 24px rgba(0,0,0,.16);font:13px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;";
  const heading = document.createElement("strong");
  heading.textContent = title;
  heading.style.cssText = "display:block;font-size:14px;margin-bottom:4px;";
  const note = document.createElement("p");
  note.textContent = "界面操作可能受影响。已写入本机的订正草稿会保留；未写入的修改可能丢失，请核对后重新保存。";
  note.style.cssText = "margin:0 0 8px;color:var(--px-fg-secondary);";
  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;gap:8px;align-items:center;";
  const reload = document.createElement("button");
  reload.type = "button";
  reload.textContent = "重新加载";
  reload.style.cssText = "cursor:pointer;border:1px solid var(--px-accent-bg);background:var(--px-accent-bg);color:var(--px-fg-on-accent);border-radius:var(--px-radius-sm);padding:4px 12px;font:inherit;";
  reload.onclick = () => window.location.reload();
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "关闭";
  close.style.cssText = "cursor:pointer;border:1px solid var(--px-border-strong);background:var(--px-bg-surface);color:var(--px-fg-primary);border-radius:var(--px-radius-sm);padding:4px 10px;font:inherit;";
  close.onclick = () => card.remove();
  const details = document.createElement("details");
  details.style.cssText = "margin-top:8px;color:var(--px-fg-secondary);";
  const summary = document.createElement("summary");
  summary.textContent = "技术信息";
  summary.style.cssText = "cursor:pointer;";
  const pre = document.createElement("pre");
  pre.textContent = detail;
  pre.style.cssText = "margin:6px 0 0;white-space:pre-wrap;word-break:break-all;font:11px/1.45 ui-monospace,Consolas,monospace;max-height:180px;overflow:auto;";
  details.append(summary, pre);
  actions.append(reload, close);
  card.append(heading, note, actions, details);
  document.body.appendChild(card);
}

window.addEventListener("error", (event) => {
  const msg = event.error instanceof Error ? event.error.stack || event.error.message : String(event.message || event.error || "unknown error");
  console.error("[ScannerRenderer] window.error:", msg);
  showRendererProblem("界面遇到异常", msg);
});
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason instanceof Error ? event.reason.stack || event.reason.message : String(event.reason || "unknown rejection");
  console.error("[ScannerRenderer] unhandledrejection:", reason);
  showRendererProblem("界面遇到异步异常", reason);
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
  </React.StrictMode>
);
