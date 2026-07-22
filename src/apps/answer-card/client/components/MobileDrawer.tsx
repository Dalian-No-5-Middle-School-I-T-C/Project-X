import { useEffect } from "react";
import { createPortal } from "react-dom";
import { X, Home, SquarePen, ClipboardList, BarChart3, Users, FileDown, Save, Sun, Moon, Info, Shield, BookOpen, Heart } from "lucide-react";
import { useWorkspace } from "../WorkspaceContext";
import { urlWithToken } from "../auth/api";
import { MODE_PATH } from "../modeRoutes";
import type { AppMode } from "../WorkspaceContext";

/**
 * 移动端抽屉导航（≤480px 渲染）。
 * 承载：① 全部 9 mode 导航（含被 mobileNavItems 截断的条目）
 *      ② 设计模式操作（坐标JSON / PDF / 保存，从 topbar-actions-left 迁移）
 *      ③ 主题切换与信息页入口（sponsor / guide / permissions）
 * 桌面端不渲染（由 CSS 媒体查询与父组件条件渲染双重保证）。
 */
export function MobileDrawer() {
  const {
    mode,
    switchMode,
    card,
    canDesign,
    isBusy,
    exportPdfForCurrentCard,
    saveCard,
    autoSaveLabel,
    autoSaveState,
    drawerOpen,
    setDrawerOpen,
    theme,
    setTheme,
    hasPermission,
    canManageExams,
    canAnalyze,
    showScoresTab,
    canManageAccounts,
  } = useWorkspace();

  // ESC 关闭 + 模式切换后自动关闭
  useEffect(() => {
    if (!drawerOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setDrawerOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawerOpen, setDrawerOpen]);

  useEffect(() => {
    setDrawerOpen(false);
  }, [mode, setDrawerOpen]);

  if (!drawerOpen) return null;

  const navigate = (m: AppMode) => {
    void switchMode(m);
  };

  const navItems: Array<{ id: AppMode; icon: React.ReactNode; label: string }> = [
    { id: "home", icon: <Home size={20} />, label: "首页" },
  ];
  if (canDesign) navItems.push({ id: "design", icon: <SquarePen size={20} />, label: "答题卡设计" });
  if (canManageExams) navItems.push({ id: "exam-manage", icon: <ClipboardList size={20} />, label: "考试管理" });
  if (canAnalyze) navItems.push({ id: "analysis", icon: <BarChart3 size={20} />, label: "成绩分析" });
  if (showScoresTab) navItems.push({ id: "scores", icon: <BarChart3 size={20} />, label: "我的成绩" });
  if (canManageAccounts) navItems.push({ id: "account", icon: <Users size={20} />, label: "账号管理" });

  const infoItems: Array<{ id: AppMode; icon: React.ReactNode; label: string }> = [
    { id: "guide", icon: <BookOpen size={20} />, label: "使用说明" },
  ];
  if (hasPermission("sponsor:view")) infoItems.push({ id: "sponsor", icon: <Heart size={20} />, label: "赞助支持" });
  if (hasPermission("permissions:manage")) infoItems.push({ id: "permissions", icon: <Shield size={20} />, label: "权限管理" });

  return createPortal(
    <>
      <div className="mobile-drawer-overlay" onClick={() => setDrawerOpen(false)} aria-hidden="true" />
      <aside className="mobile-drawer" role="dialog" aria-modal="true" aria-label="移动端导航">
        <div className="mobile-drawer-header">
          <span className="mobile-drawer-title">功能导航</span>
          <button className="ghost-button" type="button" onClick={() => setDrawerOpen(false)} aria-label="关闭">
            <X size={20} />
          </button>
        </div>

        <nav className="mobile-drawer-nav" aria-label="主导航">
          {navItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`drawer-nav-item ${mode === item.id ? "active" : ""}`}
              onClick={() => navigate(item.id)}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        {card && canDesign && mode === "design" && (
          <div className="mobile-drawer-section">
            <div className="mobile-drawer-section-title">设计操作</div>
            <a className="drawer-nav-item" href={urlWithToken(`/api/cards/${card.id}/layout`)} target="_blank" rel="noreferrer">
              <Info size={20} />
              <span>坐标JSON</span>
            </a>
            <button className="drawer-nav-item" type="button" onClick={() => void exportPdfForCurrentCard()} disabled={isBusy}>
              <FileDown size={20} />
              <span>导出 PDF</span>
            </button>
            <button className="drawer-nav-item drawer-nav-primary" type="button" onClick={() => void saveCard()} disabled={isBusy}>
              <Save size={20} />
              <span>保存答题卡</span>
            </button>
            {autoSaveLabel && (
              <span className={`autosave-status autosave-${autoSaveState}`} style={{ marginLeft: 16 }}>
                {autoSaveLabel}
              </span>
            )}
          </div>
        )}

        <div className="mobile-drawer-section">
          <div className="mobile-drawer-section-title">其他</div>
          <button
            className="drawer-nav-item"
            type="button"
            onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
          >
            {theme === "light" ? <Moon size={20} /> : <Sun size={20} />}
            <span>{theme === "light" ? "夜间模式" : "日间模式"}</span>
          </button>
          {infoItems.map((item) => (
            <button key={item.id} type="button" className="drawer-nav-item" onClick={() => navigate(item.id)}>
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </div>

        <div className="mobile-drawer-footer">
          <span className="mobile-drawer-version">Project-X v1.9.2</span>
        </div>
      </aside>
    </>,
    document.body
  );
}
