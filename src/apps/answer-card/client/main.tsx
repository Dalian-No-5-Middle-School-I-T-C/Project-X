/// <reference types="vite/client" />

import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AuthProvider } from "./auth/AuthContext";
import "./styles.css";

// This is the web mode entry point (teacher + student, no scanner panel).
// Used in dev (npm run dev) and in web builds (vite build --mode web).

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </React.StrictMode>
);
