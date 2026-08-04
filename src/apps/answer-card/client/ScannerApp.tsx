/// <reference types="vite/client" />

import { useState, useEffect, useCallback } from "react";
import { useAuth } from "./auth/AuthContext";
import { fetchJson, setAuthToken } from "./auth/api";
import { LoginPageScanner } from "./components/LoginPageScanner";
import { CardSelectPage } from "./components/CardSelectPage";
import { ScannerWorkspace } from "./components/ScannerWorkspace";
import type { CardSummary } from "../../../shared/types";

// ── ScannerApp：双屏容器 ──
// page="select" → CardSelectPage（答题卡选择，含单科/大考双Tab）
// page="workspace" → ScannerWorkspace（TWAIN扫描 + 文件导入阅卷）

type Page = "select" | "workspace";

export function ScannerApp() {
  const { user, loading } = useAuth();

  const [page, setPage] = useState<Page>("select");
  const [selectedCardId, setSelectedCardId] = useState<string>("");
  const [selectedCardTitle, setSelectedCardTitle] = useState<string>("");

  useEffect(() => {
    document.documentElement.dataset.density = "compact";
    return () => { delete document.documentElement.dataset.density; };
  }, []);

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="loading-spinner" />
        <p>加载中…</p>
      </div>
    );
  }

  if (!user) {
    return <LoginPageScanner />;
  }

  if (page === "workspace" && selectedCardId) {
    return (
      <ScannerWorkspace
        cardId={selectedCardId}
        cardTitle={selectedCardTitle}
        onBack={() => setPage("select")}
      />
    );
  }

  return (
    <CardSelectPage
      onSelectCard={(cardId) => {
        // Fetch card title before entering workspace
        fetchJson<CardSummary>(`/api/cards/${cardId}`)
          .then((card) => {
            setSelectedCardId(cardId);
            setSelectedCardTitle(card.title || cardId);
            setPage("workspace");
          })
          .catch(() => {
            setSelectedCardId(cardId);
            setSelectedCardTitle(cardId);
            setPage("workspace");
          });
      }}
    />
  );
}
