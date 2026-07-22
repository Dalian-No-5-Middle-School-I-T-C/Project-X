import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "ghost" | "danger";
type Size = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
}

/** 统一按钮：primary / ghost / danger，底层复用 .primary-button / .ghost-button(.danger) */
export function Button({
  variant = "primary",
  size = "md",
  icon,
  className = "",
  children,
  ...rest
}: ButtonProps) {
  const base =
    variant === "primary" ? "primary-button" : variant === "danger" ? "ghost-button danger" : "ghost-button";
  const sizeCls = size === "sm" ? "btn-sm" : "";
  return (
    <button className={[base, sizeCls, className].filter(Boolean).join(" ")} {...rest}>
      {icon}
      {children}
    </button>
  );
}
