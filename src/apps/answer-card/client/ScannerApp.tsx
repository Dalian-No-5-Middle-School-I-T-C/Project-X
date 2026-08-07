/// <reference types="vite/client" />

import { useState, useEffect, useCallback } from "react";
import { useAuth } from "./auth/AuthContext";
import { fetchJson, setAuthToken } from "./auth/api";
import { LoginPageScanner } from "./components/LoginPageScanner";
import { CardSelectPage } from "./components/CardSelectPage";
import { ScannerWorkspace } from "./components/ScannerWorkspace";
import { Spinner } from "./components/ui/v2";
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

  // v2.1.0: 登录后应用账号皮肤偏好（皮肤=风格维度；明暗沿用登录页/本地已生效的 data-theme）。
  // 与 web 端 App.tsx 的同步策略一致：后端 theme_skin 非默认时写入 localStorage + data-skin。
  useEffect(() => {
    if (!user?.themeSkin) return;
    try {
      if (user.themeSkin !== "flat") {
        localStorage.setItem("projectx-skin", user.themeSkin);
        document.documentElement.dataset.skin = user.themeSkin;
      }
    } catch { /* ignore storage failures */ }
  }, [user?.themeSkin]);

  if (loading) {
    return (
      <div className="flex h-[100dvh] w-full flex-col items-center justify-center gap-3 bg-background">
        <Spinner size={28} />
        <p className="m-0 text-sm text-muted-foreground">加载中…</p>
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
