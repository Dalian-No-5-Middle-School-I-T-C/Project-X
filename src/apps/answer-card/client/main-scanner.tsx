/// <reference types="vite/client" />

import React from "react";
import { createRoot } from "react-dom/client";
import { ScannerApp } from "./ScannerApp";
import { AuthProvider } from "./auth/AuthContext";
// 唯一样式入口（与 main.tsx 一致，层序由 app.css 内部保证）
import "./theme/app.css";

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
    <AuthProvider>
      <ScannerApp />
    </AuthProvider>
  </React.StrictMode>
);
