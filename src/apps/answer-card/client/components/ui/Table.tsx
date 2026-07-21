import type { TableHTMLAttributes } from "react";

/** 统一表格：复用 .data-table 基础令牌样式，可叠加 analysis-* / account-table 等语义类 */
export function Table({ className = "", ...rest }: TableHTMLAttributes<HTMLTableElement>) {
  return <table className={`data-table ${className}`.trim()} {...rest} />;
}
