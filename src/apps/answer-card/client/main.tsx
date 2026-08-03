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

// This is the web mode entry point (teacher + student, no scanner panel).
// Used in dev (npm run dev) and in web builds (vite build --mode web).
// Phase 2: 数据路由（createBrowserRouter）让每个工作模式 = 真实 URL，
// 并且使 useBlocker（未保存离开确认）能真正拦截导航。App 内部按 URL 渲染对应模式。

const router = createBrowserRouter([
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
