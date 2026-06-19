import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { UserGuidePage } from "./UserGuidePage";

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
        <UserGuidePage embedded />
      </div>
    </div>,
    document.body
  );
}
