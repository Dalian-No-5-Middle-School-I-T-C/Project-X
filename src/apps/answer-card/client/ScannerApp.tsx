/// <reference types="vite/client" />

import { useState, useEffect, useCallback } from "react";
import { useAuth } from "./auth/AuthContext";
import { fetchJson } from "./auth/api";
import { LoginPageScanner } from "./components/LoginPageScanner";
import { CardSelectPage } from "./components/CardSelectPage";
import { ScannerWorkspace } from "./components/ScannerWorkspace";
import { SkinOnboarding, shouldShowSkinOnboarding } from "./components/SkinOnboarding";
import { Spinner } from "./components/ui/v2";
import { DEFAULT_SKIN, SKIN_CHOSEN_KEY } from "./components/SkinSwitcher";
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
  // v2.1.0: 皮肤 = 风格维度（与明暗正交），同步策略与 web 端 App 保持一致。
  const [skin, setSkin] = useState<string>(() => {
    try {
      return localStorage.getItem("projectx-skin") || DEFAULT_SKIN;
    } catch {
      return DEFAULT_SKIN;
    }
  });
  // 首次进入强制选肤（与 web 端一致）：未走过引导时先二选一，确认后才进登录页。
  const [showOnboarding, setShowOnboarding] = useState<boolean>(() => shouldShowSkinOnboarding());

  useEffect(() => {
    document.documentElement.dataset.density = "compact";
    return () => { delete document.documentElement.dataset.density; };
  }, []);

  // 皮肤同步：始终落盘 + 设 data-skin（默认 paper-edge 的 CSS 覆盖块依赖该属性）。
  useEffect(() => {
    document.documentElement.dataset.skin = skin;
    try { localStorage.setItem("projectx-skin", skin); } catch { /* ignore storage failures */ }
  }, [skin]);

  // 登录后皮肤偏好同步（v2.3.0 语义：账号为权威，本会话显式选择优先）：
  // - sessionStorage 有「会话内显式选择」标记（首次引导 / 未来切换入口）→ 本地优先；
  // - 无标记 → 应用账号 themeSkin（换设备恢复账号偏好；登出时 AuthContext 清除标记，
  //   避免换账号登录继承旧皮肤）。
  useEffect(() => {
    if (!user) return;
    const serverSkin = user.themeSkin || DEFAULT_SKIN;
    let chosen: string | null = null;
    try { chosen = sessionStorage.getItem(SKIN_CHOSEN_KEY); } catch { /* ignore */ }
    setSkin(chosen || serverSkin);
  }, [user?.id, user?.themeSkin]);

  // 皮肤变更（含首次引导的选择）→ 登录状态下 PATCH 同步到账号偏好。fire-and-forget。
  useEffect(() => {
    if (!user) return;
    const serverSkin = user.themeSkin || DEFAULT_SKIN;
    if (skin === serverSkin) return;
    void fetchJson("/api/users/me/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ themeSkin: skin }),
    }).catch(() => { /* 同步失败不打扰用户 */ });
  }, [skin, user?.id, user?.themeSkin]);

  if (loading) {
    return (
      <div className="flex h-[100dvh] w-full flex-col items-center justify-center gap-3 bg-background">
        <Spinner size={28} />
        <p className="m-0 text-sm text-muted-foreground">加载中…</p>
      </div>
    );
  }

  if (!user) {
    if (showOnboarding) {
      return (
        <SkinOnboarding
          onComplete={() => {
            try { setSkin(localStorage.getItem("projectx-skin") || DEFAULT_SKIN); } catch { /* ignore */ }
            setShowOnboarding(false);
          }}
          subtitle="请选择一套视觉风格后再进入登录；选定后将保存到本机并同步到账号偏好"
          footerNote="如需更改皮肤，可随时在登录页右上角的调色盘按钮切换；登录后也可在各页面顶栏右侧切换。"
        />
      );
    }
    return <LoginPageScanner />;
  }

  if (page === "workspace" && selectedCardId) {
    return (
      <ScannerWorkspace
        cardId={selectedCardId}
        cardTitle={selectedCardTitle}
        onBack={() => setPage("select")}
        skin={skin}
        onSkinChange={setSkin}
      />
    );
  }

  return (
    <CardSelectPage
      skin={skin}
      onSkinChange={setSkin}
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
