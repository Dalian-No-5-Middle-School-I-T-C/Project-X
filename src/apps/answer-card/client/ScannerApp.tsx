/// <reference types="vite/client" />

import { useState, useEffect, useRef } from "react";
import { useAuth } from "./auth/AuthContext";
import { fetchJson } from "./auth/api";
import { fetchCardDetailSynced, importCardLocally } from "./lib/scannerSync";
import { shortCardVersion } from "../../../shared/cardVersion";
import type { AnswerCard } from "../../../shared/types";
import { LoginPageScanner } from "./components/LoginPageScanner";
import { UploadProgressCard } from "./components/UploadProgressCard";
import { CardSelectPage } from "./components/CardSelectPage";
import { ScannerWorkspace } from "./components/ScannerWorkspace";
import { ScannerPostprocessPage } from "./components/ScannerPostprocessPage";
import { SkinOnboarding, shouldShowSkinOnboarding } from "./components/SkinOnboarding";
import { notify, Spinner } from "./components/ui/v2";
import { DEFAULT_SKIN, SKIN_CHOSEN_KEY } from "./components/SkinSwitcher";
import { skinPatchDecision } from "./lib/skinPatchGuard";
import { useSkinPreferenceWriter } from "./lib/skinSync";
import {
  clearActivePostprocess, clearPostprocessView, readActivePostprocess, readPostprocessSessions,
  writeActivePostprocess, writePostprocessSessions,
} from "./lib/postprocessResume";

// ── ScannerApp：三屏容器 ──
// page="select" → CardSelectPage（答题卡选择，含单科/大考双Tab）
// page="workspace" → ScannerWorkspace（TWAIN扫描 + 文件导入阅卷）
// page="postprocess" → ScannerPostprocessPage（每批扫完自动进入，可返回工作台续扫）

type Page = "select" | "workspace" | "postprocess";

function ScannerAppInner() {
  const { user, loading, patchUserLocal, refreshUser } = useAuth();
  // 皮肤偏好回写（R49）：与 web 端共用同一套「成功更新权威快照 / 失败以服务端为准」的实现。
  const writeSkinPreference = useSkinPreferenceWriter();

  const [page, setPage] = useState<Page>("select");
  const [selectedCardId, setSelectedCardId] = useState<string>("");
  const [selectedCardTitle, setSelectedCardTitle] = useState<string>("");
  // v2.7.2：本卡已扫完的批次会话；返回工作台续扫后新批次累加进来，异常队列共用同一份
  const [postSessions, setPostSessions] = useState<Array<{ sessionId: string; pageCount: number }>>([]);
  /** 离开工作台时 selectedCardId 会先被清空，而扫描面板的卸载清理要等到提交阶段才归档；
   *  落盘得认「刚才那张卡」，否则重选同一张卡时会被上次写下的旧列表覆盖。 */
  const lastSelectedCardIdRef = useRef("");
  useEffect(() => { if (selectedCardId) lastSelectedCardIdRef.current = selectedCardId; }, [selectedCardId]);
  /** 后处理页点「继续扫描」→ 回到工作台并自动开下一批；工作台消费后清掉，避免再次进入重复开扫。 */
  const [pendingContinueScan, setPendingContinueScan] = useState(false);
  // 安全 R35：离线用缓存卡进入时的工作台提示（版本 + 缓存时间），空串表示版本与服务器一致
  const [cardVersionNote, setCardVersionNote] = useState<string>("");
  // v2.1.0: 皮肤 = 风格维度（与明暗正交），同步策略与 web 端 App 保持一致。
  const [skin, setSkin] = useState<string>(() => {
    try {
      return localStorage.getItem("projectx-skin") || DEFAULT_SKIN;
    } catch {
      return DEFAULT_SKIN;
    }
  });
  // Task3: 先校验后切页 — 校验期间按钮 loading 防重 + 404 阻断切页并刷新列表
  const [validatingCardId, setValidatingCardId] = useState<string | null>(null);
  const [listRefreshKey, setListRefreshKey] = useState(0);
  // 首次进入强制选肤（与 web 端一致）：未走过引导时先二选一，确认后才进登录页。
  const [showOnboarding, setShowOnboarding] = useState<boolean>(() => shouldShowSkinOnboarding());
  // PATCH 回写护栏状态：记录上一轮见到的 user.id（见 lib/skinPatchGuard.ts）。
  const skinPatchPrevUserRef = useRef<string | number | null>(null);

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
  // 经 skinPatchDecision 护栏：登录瞬态（冷启动恢复会话/重登/换账号）不信任本轮
  // 闭包里的陈旧 skin，防止「登录前切换的本机旧皮肤」覆盖账号偏好（PR #260 缺陷）。
  useEffect(() => {
    const userId = user?.id ?? null;
    const serverSkin = user?.themeSkin || DEFAULT_SKIN;
    let chosen: string | null = null;
    try { chosen = sessionStorage.getItem(SKIN_CHOSEN_KEY); } catch { /* ignore */ }
    const decision = skinPatchDecision(skinPatchPrevUserRef.current, userId, skin, serverSkin, chosen);
    skinPatchPrevUserRef.current = decision.nextPrevUserId;
    if (!decision.patch) return;
    // R49：PATCH 成功后必须把值写回本地用户快照，否则「切 A→B→A」的最后一步
    // 会因为与登录快照一致而被上面的判断跳过，账号最终留在 B。
    void writeSkinPreference(
      skin,
      (applied) => patchUserLocal({ themeSkin: applied }),
      () => { void refreshUser(); }
    );
  }, [skin, user?.id, user?.themeSkin, writeSkinPreference, patchUserLocal, refreshUser]);

  // 闪退/白屏后回到应用：上次停在这张卡的扫描后处理，就恢复会话列表并直接打开，
  // 否则草稿还在本机却没有入口。只在刚登录且尚未选卡时触发。
  useEffect(() => {
    if (!user || selectedCardId) return;
    // 只读本人槽位：同机其他账号的标记原样留着，他们回来时仍能自动回到自己的后处理页。
    const active = readActivePostprocess(user.id);
    if (!active) return;
    const sessions = readPostprocessSessions(active.cardId, user.id);
    if (!sessions.length) {
      clearActivePostprocess(user.id);
      return;
    }
    setSelectedCardId(active.cardId);
    setSelectedCardTitle(active.cardTitle);
    setPostSessions(sessions);
    setPage("postprocess");
  }, [user?.id, selectedCardId]);

  // 会话列表随卡片落到本机：崩溃重载后仍能回到同一批卷。
  // 未登录/登录态过期时不写：否则会把 userId 改成 null，崩溃后同一账号也恢复不了。
  useEffect(() => {
    // 返回卡片列表时 selectedCardId 已清空，但面板卸载清理刚归档的批次要归到刚才那张卡上。
    const targetCardId = selectedCardId || lastSelectedCardIdRef.current;
    if (!targetCardId || !user) return;
    writePostprocessSessions(targetCardId, postSessions, user.id);
    // 只有在后处理页才记「活动卡」；老师主动回到工作台后崩溃，重载应回工作台，
    // 而不是被一个仅因存在历史会话就写回的标记拉回后处理。
    if (selectedCardId && page === "postprocess" && postSessions.length) writeActivePostprocess(selectedCardId, selectedCardTitle, user.id);
    else clearActivePostprocess(user.id);
  }, [selectedCardId, selectedCardTitle, postSessions, page, user?.id]);

  // 登出/会话过期时清掉工作台选择，避免下一个登录账号继承上一人的扫描会话。
  useEffect(() => {
    if (user || !selectedCardId) return;
    setSelectedCardId("");
    setSelectedCardTitle("");
    setPostSessions([]);
    setPage("select");
  }, [user?.id, selectedCardId]);

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
    return <LoginPageScanner skin={skin} onSkinChange={setSkin} />;
  }

  if (page === "postprocess" && selectedCardId && postSessions.length) {
    return (
      <ScannerPostprocessPage
        cardId={selectedCardId}
        cardTitle={selectedCardTitle}
        sessions={postSessions}
        userId={user?.id ?? null}
        onBack={() => { clearActivePostprocess(user?.id); clearPostprocessView(selectedCardId, user?.id); setPage("workspace"); }}
        onContinueScan={() => {
          setPendingContinueScan(true);
          setPage("workspace");
        }}
      />
    );
  }

  if (page === "workspace" && selectedCardId) {
    return (
      <ScannerWorkspace
        cardId={selectedCardId}
        cardTitle={selectedCardTitle}
        cardVersionNote={cardVersionNote}
        onBack={() => {
          clearActivePostprocess(user?.id);
          setSelectedCardId("");
          setSelectedCardTitle("");
          setPostSessions([]);
          setPage("select");
        }}
        autoStartScan={pendingContinueScan}
        onAutoStartConsumed={() => setPendingContinueScan(false)}
        onBatchArchived={(sid, pageCount) => {
          setPostSessions(prev => [...prev.filter(p => p.sessionId !== sid), { sessionId: sid, pageCount }]);
        }}
        onScansComplete={(sid, pageCount) => {
          setPostSessions(prev => [...prev.filter(p => p.sessionId !== sid), { sessionId: sid, pageCount }]);
          setPage("postprocess");
        }}
        postprocessBatchCount={postSessions.length}
        onOpenPostprocess={() => setPage("postprocess")}
        skin={skin}
        onSkinChange={setSkin}
      />
    );
  }

  return (
    <>
      <CardSelectPage
        key={listRefreshKey}
        skin={skin}
        onSkinChange={setSkin}
        onSelectCard={async (cardId) => {
          if (validatingCardId) return;
          setValidatingCardId(cardId);
          try {
            const { card, stale } = await fetchCardDetailSynced(cardId);
            // 安全 R35：远端连不上时这份卡来自本机缓存，服务器上的布局/答案可能已经改过。
            // 不静默进入工作区——把版本摆出来，让老师显式选择「离线继续」。
            if (stale) {
              const version = card ? shortCardVersion(card as AnswerCard) : "未知";
              const updatedAt = (card as { updatedAt?: string } | null)?.updatedAt || "未知";
              const proceed = confirm(
                `无法连接服务器，读到的是本机缓存的答题卡：\n\n` +
                  `名称：${(card as { title?: string } | null)?.title || cardId}\n` +
                  `本机版本：${version}（缓存于 ${updatedAt}）\n\n` +
                  `服务器上的版面或答案可能已经修改，按旧卡识别会把分数算错，` +
                  `且上传时会被服务器拒绝（版本不一致）。\n\n` +
                  `仍要以本机缓存版本离线继续吗？`,
              );
              if (!proceed) return;
              setCardVersionNote(`本机缓存版本 ${version}（未连上服务器，${updatedAt}）`);
              setSelectedCardId(cardId);
              setSelectedCardTitle(card?.title || cardId);
              const restored = readPostprocessSessions(cardId, user?.id);
              const active = readActivePostprocess(user?.id);
              setPostSessions(restored);
              setPage(active?.cardId === cardId && active.userId === user?.id ? "postprocess" : "workspace");
              return;
            }
            // 远端新建的卡不在本机库：直扫/阅卷只读本机服务，先进本机库（幂等 upsert）
            if (card && typeof (card as { id?: string }).id === "string") {
              await importCardLocally(card as { id: string });
            }
            setCardVersionNote("");
            setSelectedCardId(cardId);
            setSelectedCardTitle(card?.title || cardId);
            const restored = readPostprocessSessions(cardId, user?.id);
            const active = readActivePostprocess(user?.id);
            setPostSessions(restored);
            setPage(active?.cardId === cardId && active.userId === user?.id ? "postprocess" : "workspace");
          } catch (e: unknown) {
            const err = e as { status?: number; message?: string };
            if (err?.status === 404) {
              notify.error("该答题卡已在服务器删除，已刷新列表");
              setListRefreshKey((k) => k + 1);
              return;
            }
            notify.error(err?.message || "加载答题卡失败，请重试");
          } finally {
            setValidatingCardId(null);
          }
        }}
      />
      {validatingCardId && (
        <div className="fixed inset-0 z-10 flex items-center justify-center bg-background/60 backdrop-blur-[2px]">
          <div className="flex items-center gap-2 rounded-md border bg-card px-4 py-2 shadow-2">
            <Spinner size={16} />
            <span className="text-sm">校验答题卡…</span>
          </div>
        </div>
      )}
    </>
  );
}

/** v2.5.1: 对外入口 = 原双屏容器 + 全局上传进度卡（右上角下弹） */
export function ScannerApp() {
  return (
    <>
      <ScannerAppInner />
      <UploadProgressCard />
    </>
  );
}
