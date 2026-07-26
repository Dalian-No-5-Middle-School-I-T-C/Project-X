import type { InputHTMLAttributes, TextareaHTMLAttributes, ReactNode } from "react";

/** 统一文本输入：复用 .text-input 令牌样式（radius 10 / 高 38 / 令牌边框） */
export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  const { className = "", ...rest } = props;
  return <input className={`text-input ${className}`.trim()} {...rest} />;
}

/** 统一多行输入：复用 .textarea-input */
export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { className = "", ...rest } = props;
  return <textarea className={`textarea-input ${className}`.trim()} {...rest} />;
}

/** 带标签的表单字段包装 */
export function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <label>
      {label}
      {children}
    </label>
  );
}
