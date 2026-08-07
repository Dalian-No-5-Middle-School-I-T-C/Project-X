import * as React from "react";
import { Toaster as SonnerToaster, toast } from "sonner";
import { CheckCircle2, Info, Loader2, TriangleAlert, XCircle } from "lucide-react";

/**
 * Toast —— DESIGN-SYSTEM §6
 * 右下、4 语义色、成功 3s / 失败常驻可关、操作型 toast 带撤销按钮。
 *
 * 全量 `unstyled`：sonner 自带的视觉一律关掉，只借它的定位/堆叠/手势逻辑，
 * 外观 100% 由本文件的工具类给出（零手写 CSS）。
 *
 * ⚠ `z-…!`：sonner 把容器样式以运行时 <style> 注入（无层），按 CSS 层叠规则
 * 无层样式恒压过层内工具类，且它硬编码 z-index: 999999999，会盖住 lightbox(600)。
 * 这是全项目唯一允许的 important 工具类，理由记录在此。
 */

const FAILURE_DURATION = Number.POSITIVE_INFINITY;

export function Toaster() {
  return (
    <SonnerToaster
      position="bottom-right"
      offset={20}
      gap={8}
      visibleToasts={4}
      className="z-(--px-z-toast)!"
      icons={{
        success: <CheckCircle2 className="size-4 text-success" />,
        error: <XCircle className="size-4 text-destructive" />,
        warning: <TriangleAlert className="size-4 text-warning" />,
        info: <Info className="size-4 text-info" />,
        loading: <Loader2 className="size-4 animate-spin text-muted-foreground" />,
      }}
      toastOptions={{
        unstyled: true,
        duration: 3000,
        closeButtonAriaLabel: "关闭提示",
        classNames: {
          // 宽度交给 sonner 容器（它负责定位/移动端满宽），这里只管内部排版
          toast: [
            "flex w-full items-start gap-3",
            "rounded-lg border border-border bg-popover px-4 py-3 shadow-3",
            "text-popover-foreground",
          ].join(" "),
          icon: "mt-0.5 flex shrink-0 items-center justify-center",
          content: "flex min-w-0 flex-1 flex-col gap-0.5",
          title: "text-base font-medium text-foreground",
          description: "text-sm text-muted-foreground",
          // 语义色只落在左侧色条（border-l-2），不整块染色 —— 扁平化基调
          success: "border-l-2 border-l-success",
          error: "border-l-2 border-l-destructive",
          warning: "border-l-2 border-l-warning",
          info: "border-l-2 border-l-info",
          loading: "border-l-2 border-l-border-strong",
          actionButton: [
            "ml-auto inline-flex h-control-sm shrink-0 items-center justify-center rounded-md px-3",
            "bg-primary text-sm font-medium text-primary-foreground",
            "transition-colors duration-(--px-dur-1) ease-standard hover:bg-primary-hover",
            "outline-none focus-visible:shadow-focus",
          ].join(" "),
          cancelButton: [
            "inline-flex h-control-sm shrink-0 items-center justify-center rounded-md px-3",
            "bg-secondary text-sm font-medium text-secondary-foreground",
            "transition-colors duration-(--px-dur-1) ease-standard hover:bg-muted",
            "outline-none focus-visible:shadow-focus",
          ].join(" "),
          closeButton: [
            "inline-flex size-5 items-center justify-center rounded-xs",
            "border border-border bg-popover text-muted-foreground",
            "transition-colors duration-(--px-dur-1) ease-standard hover:text-foreground",
          ].join(" "),
        },
      }}
    />
  );
}

type ToastArg = Parameters<typeof toast.success>[1];

/**
 * notify —— 业务侧唯一提示入口
 * 直接调 sonner 的 toast.* 也能用，但走这里才能保证「失败常驻可关」等定死项。
 */
export const notify = {
  success(message: React.ReactNode, options?: ToastArg) {
    return toast.success(message, options);
  },
  info(message: React.ReactNode, options?: ToastArg) {
    return toast.info(message, options);
  },
  warning(message: React.ReactNode, options?: ToastArg) {
    return toast.warning(message, { duration: 6000, ...options });
  },
  /** 失败：常驻 + 关闭按钮（§6 定死项），可传 action 提供重试 */
  error(message: React.ReactNode, options?: ToastArg) {
    return toast.error(message, {
      duration: FAILURE_DURATION,
      closeButton: true,
      ...options,
    });
  },
  loading(message: React.ReactNode, options?: ToastArg) {
    return toast.loading(message, options);
  },
  /** 操作型：附撤销按钮（§6「操作型 toast 带撤销按钮」） */
  undoable(
    message: React.ReactNode,
    onUndo: () => void,
    options?: ToastArg,
  ) {
    return toast.success(message, {
      duration: 6000,
      action: { label: "撤销", onClick: onUndo },
      ...options,
    });
  },
  dismiss(id?: string | number) {
    return toast.dismiss(id);
  },
  promise: toast.promise,
};

export { toast };
