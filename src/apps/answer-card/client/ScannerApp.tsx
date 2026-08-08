/// <reference types="vite/client" />

import { useState, useEffect, useCallback } from "react";
import { useAuth } from "./auth/AuthContext";
import { fetchJson, setAuthToken } from "./auth/api";
import { LoginPageScanner } from "./components/LoginPageScanner";
import { CardSelectPage } from "./components/CardSelectPage";
import { ScannerWorkspace } from "./components/ScannerWorkspace";
import { Spinner } from "./components/ui/v2";
import { DEFAULT_SKIN } from "./components/SkinSwitcher";
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

  // 未登录（登录页）也按本地记录/默认皮肤设置 data-skin（默认 'paper-edge' 的
  // CSS 覆盖块依赖该属性；登录后由下方 effect 以账号值为准覆盖）。
  useEffect(() => {
    try {
      document.documentElement.dataset.skin =
        localStorage.getItem("projectx-skin") || DEFAULT_SKIN;
    } catch { /* ignore storage failures */ }
  }, []);

  // v2.1.0: 登录后应用账号皮肤偏好（皮肤=风格维度；明暗沿用登录页/本地已生效的 data-theme）。
  // v2.3.0: 与 web 端同步策略一致——总是按账号值落盘 + 设 data-skin（默认 'paper-edge'
  // 也设；账号为 'flat' 时显式写入覆盖上一账号残留，避免换账号登录继承旧皮肤）。
  // 扫描端不提供切换入口，故无「会话内显式选择」逻辑。
  useEffect(() => {
    if (!user?.themeSkin) return;
    try {
      localStorage.setItem("projectx-skin", user.themeSkin);
      document.documentElement.dataset.skin = user.themeSkin;
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
