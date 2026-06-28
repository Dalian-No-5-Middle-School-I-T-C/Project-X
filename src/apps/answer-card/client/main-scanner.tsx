/// <reference types="vite/client" />

import React from "react";
import { createRoot } from "react-dom/client";
import { ScannerApp } from "./ScannerApp";
import { AuthProvider } from "./auth/AuthContext";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthProvider>
      <ScannerApp />
    </AuthProvider>
  </React.StrictMode>
);
