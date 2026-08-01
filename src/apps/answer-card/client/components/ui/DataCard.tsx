import type { ReactNode } from "react";

export interface DataCardRow {
  label: string;
  value: ReactNode;
  /** 是否加粗强调(用于主字段如姓名/标题) */
  strong?: boolean;
}

export interface DataCardProps {
  rows: DataCardRow[];
  /** 卡片底部操作区(按钮/链接) */
  actions?: ReactNode;
  /** 点击整卡(可选,用于可点击卡片) */
  onClick?: () => void;
}

/**
 * 通用数据卡片:移动端表格卡片化的统一组件。
 * 与 styles.css 的 .data-card-list/.data-card/.data-card-row 配套。
 */
export function DataCard({ rows, actions, onClick }: DataCardProps) {
  const cardContent = (
    <>
      {rows.map((row, i) => (
        <div key={i} className="data-card-row">
          <span className="data-card-label">{row.label}</span>
          <span className={`data-card-value ${row.strong ? "strong" : ""}`}>{row.value}</span>
        </div>
      ))}
      {actions && <div className="data-card-actions">{actions}</div>}
    </>
  );

  if (onClick) {
    return (
      <div className="data-card" onClick={onClick} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onClick()}>
        {cardContent}
      </div>
    );
  }

  return <div className="data-card">{cardContent}</div>;
}
