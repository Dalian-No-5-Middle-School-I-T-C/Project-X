/// <reference types="vite/client" />

import React from "react";
import { createRoot } from "react-dom/client";
import { ScannerApp } from "./ScannerApp";
import { AuthProvider } from "./auth/AuthContext";
// 唯一样式入口（与 main.tsx 一致，层序由 app.css 内部保证）
import "./theme/app.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthProvider>
      <ScannerApp />
    </AuthProvider>
  </React.StrictMode>
);
