import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";

export interface SegItem {
  value: string;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
  /** 提供则渲染为 NavLink（路由模式，自动高亮激活） */
  to?: string;
}

export interface SegmentedControlProps {
  items: SegItem[];
  value?: string;
  onChange?: (value: string) => void;
  ariaLabel?: string;
}

/**
 * 通用分段控制器，复用 .mode-toggle 视觉。
 * - 受控模式：传 value + onChange（非路由场景）
 * - 路由模式：item 传 to，渲染 NavLink（自动 active 高亮）
 * 用于统一全仓 4 套 modeToggle / toggleBtn / CrossModeBtn。
 */
export function SegmentedControl({ items, value, onChange, ariaLabel }: SegmentedControlProps) {
  return (
    <div className="mode-toggle" role="tablist" aria-label={ariaLabel}>
      {items.map((it) => {
        const content = (
          <>
            {it.icon}
            {it.label}
          </>
        );
        if (it.to) {
          return (
            <NavLink
              key={it.value}
              to={it.to}
              className={({ isActive }) => (isActive ? "active" : "")}
              aria-disabled={it.disabled || undefined}
            >
              {content}
            </NavLink>
          );
        }
        return (
          <button
            key={it.value}
            type="button"
            className={value === it.value ? "active" : ""}
            disabled={it.disabled}
            onClick={() => onChange?.(it.value)}
          >
            {content}
          </button>
        );
      })}
    </div>
  );
}
