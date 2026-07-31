import { lazy, Suspense } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

// 懒加载：隔离 react-markdown / remark-gfm / 用户指南 md 文本，仅打开弹窗时才加载
const UserGuidePage = lazy(() => import("./UserGuidePage").then((m) => ({ default: m.UserGuidePage })));

export function UserGuideModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;

  return createPortal(
    <div className="modal-overlay user-guide-modal-overlay" onClick={onClose}>
      <div
        className="modal-card user-guide-modal-card"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h3 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>使用说明</h3>
          <button className="ghost-button" type="button" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </div>
        <Suspense fallback={<p className="empty-text" style={{ padding: 24 }}>正在加载...</p>}>
          <UserGuidePage embedded />
        </Suspense>
      </div>
    </div>,
    document.body
  );
}
