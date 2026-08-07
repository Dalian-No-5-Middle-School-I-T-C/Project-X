/// <reference types="vite/client" />

import "./polyfills";
import React from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import App from "./App";
import { AuthProvider } from "./auth/AuthContext";
import { ErrorBoundary } from "./components/ErrorBoundary";
// 唯一样式入口：app.css 内部按 legacy < theme < base < components < utilities
// 的层序依次引入 tokens.css / styles.css / legacy-bridge.css，顺序不得在此绕过。
import "./theme/app.css";
// 背景图浮层（从 styles.css 迁出的功能性样式，非遗留装饰）
import "./theme/backdrop.css";

// Match the demo's theme before React paints, avoiding a light-frame flash for dark users.
try {
  const storedTheme = localStorage.getItem("projectx-theme");
  document.documentElement.setAttribute("data-theme", storedTheme === "dark" ? "dark" : "light");
} catch {
  document.documentElement.setAttribute("data-theme", "light");
}

// v2.1.0: 皮肤预置（皮肤=风格维度，与明暗正交）。默认皮肤 'flat' 不设 data-skin，
// 只有非默认皮肤才需要设置该属性（tokens.css 以 [data-skin="xxx"] 覆盖 L2 语义令牌）。
try {
  const storedSkin = localStorage.getItem("projectx-skin");
  if (storedSkin && storedSkin !== "flat") {
    document.documentElement.dataset.skin = storedSkin;
  }
} catch {
  /* private browsing / storage disabled */
}

// This is the web mode entry point (teacher + student, no scanner panel).
// Used in dev (npm run dev) and in web builds (vite build --mode web).
// Phase 2: 数据路由（createBrowserRouter）让每个工作模式 = 真实 URL，
// 并且使 useBlocker（未保存离开确认）能真正拦截导航。App 内部按 URL 渲染对应模式。

// DESIGN_PREVIEW：P2 过闸走查页（临时，不发布）。
// 放在鉴权闸之外，走查时不需要登录。P5 清理时删除本 lazy 与下方对应路由。
const DesignPreviewPage = React.lazy(() => import("./dev/DesignPreviewPage"));

const router = createBrowserRouter([
  // DESIGN_PREVIEW：P5 清理时连同 dev/ 目录一并删除
  {
    path: "/design-preview",
    element: (
      <React.Suspense fallback={null}>
        <DesignPreviewPage />
      </React.Suspense>
    ),
  },
  {
    path: "*",
    element: <App />,
  },
]);

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
