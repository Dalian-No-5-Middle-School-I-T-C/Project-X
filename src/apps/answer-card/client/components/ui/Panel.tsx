import type { ReactNode, HTMLAttributes } from "react";

/** 统一面板容器：复用 .panel + .panel-title */
export function Panel({
  title,
  icon,
  className = "",
  children,
  ...rest
}: { title?: ReactNode; icon?: ReactNode } & HTMLAttributes<HTMLDivElement>) {
  return (
    <section className={`panel ${className}`.trim()} {...rest}>
      {title !== undefined && (
        <div className="panel-title">
          {icon}
          {title}
        </div>
      )}
      {children}
    </section>
  );
}

/** 统一卡片容器（无标题版，复用 .panel 视觉） */
export function Card({
  className = "",
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`card ${className}`.trim()} {...rest}>
      {children}
    </div>
  );
}
