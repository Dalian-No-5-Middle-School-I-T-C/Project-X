import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * 合并 Tailwind 类名：clsx 处理条件拼接，twMerge 消解同族工具类冲突
 * （后写的赢，例如 cn("px-4", "px-2") → "px-2"）。
 *
 * 设计系统唯一的类名合并入口，组件 className 透传一律经过它。
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
