import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** 最大宽度（px），默认 560 */
  width?: number;
  /** 点击遮罩是否关闭，默认 true */
  closeOnOverlay?: boolean;
  /** 自定义 modal-card 内联样式（用于特殊布局如设置页 flex） */
  cardStyle?: React.CSSProperties;
}

/**
 * 统一模态框：Portal 到 body，统一 z-index（--z-modal），
 * 支持 ESC 关闭 + 点击遮罩关闭。替代全仓 5+ 种手写 overlay 实现。
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = 560,
  closeOnOverlay = true,
  cardStyle,
}: ModalProps) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="modal-overlay" onClick={closeOnOverlay ? onClose : undefined}>
      <div
        className="modal-card"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: width, width: "92vw", maxHeight: "85vh", overflow: "hidden", display: "flex", flexDirection: "column", ...cardStyle }}
      >
        {title !== undefined && (
          <div className="modal-header">
            <h3 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>{title}</h3>
            <button className="ghost-button" type="button" onClick={onClose} aria-label="关闭">
              <X size={18} />
            </button>
          </div>
        )}
        <div className="modal-body" style={{ padding: "16px 20px", overflowY: "auto" }}>
          {children}
        </div>
        {footer && (
          <div
            className="modal-footer"
            style={{ padding: "12px 20px", borderTop: "1px solid var(--line)", display: "flex", gap: 8, justifyContent: "flex-end" }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
