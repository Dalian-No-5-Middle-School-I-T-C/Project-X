import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "../../../lib/utils";
import { Button } from "./button";
import { Input } from "./input";

/**
 * Dialog —— DESIGN-SYSTEM §6 / §7「危险操作」
 *
 * 定死项：
 *  · 3 宽档 sm 480 / md 640 / lg 880（超出视口时自适应收缩）
 *  · 标题左、关闭按钮右上
 *  · 危险确认统一双按钮右置，主按钮 destructive，文案说清代价
 *  · 遮罩用纯色半透明 scrim（UI 重构视觉约定：扁平化，禁 backdrop-filter 模糊）
 *  · 层级走令牌 z-(--px-z-modal)，杜绝 9999 魔法数
 */

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export const DialogPortal = DialogPrimitive.Portal;

export const DialogOverlay = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(function DialogOverlay({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Overlay
      ref={ref}
      className={cn(
        "fixed inset-0 z-(--px-z-modal) bg-scrim",
        "data-[state=open]:animate-in data-[state=open]:fade-in-0",
        "data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
        className,
      )}
      {...props}
    />
  );
});

const dialogSizeClass = {
  sm: "max-w-[480px]",
  md: "max-w-[640px]",
  lg: "max-w-[880px]",
} as const;

export type DialogSize = keyof typeof dialogSizeClass;

export interface DialogContentProps
  extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  /** 宽档：sm 480 / md 640 / lg 880 */
  size?: DialogSize;
  /** 隐藏右上角关闭按钮（仅用于必须做出选择的阻断式对话） */
  hideClose?: boolean;
}

export const DialogContent = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(function DialogContent(
  { className, children, size = "md", hideClose = false, ...props },
  ref,
) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          "fixed top-1/2 left-1/2 z-(--px-z-modal) -translate-x-1/2 -translate-y-1/2",
          "flex max-h-[calc(100vh-64px)] w-[calc(100vw-32px)] flex-col",
          "rounded-lg border border-border bg-overlay text-foreground shadow-4",
          // §4.4 弹层进出 240ms fade + scale 0.98→1
          "duration-(--px-dur-3) ease-standard",
          "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          "outline-none",
          dialogSizeClass[size],
          className,
        )}
        {...props}
      >
        {children}
        {!hideClose && (
          <DialogPrimitive.Close
            aria-label="关闭"
            className={cn(
              "absolute top-3 right-3 inline-flex size-8 items-center justify-center",
              "rounded-sm text-muted-foreground",
              "transition-colors duration-(--px-dur-1) ease-standard",
              "hover:bg-secondary hover:text-foreground",
              "outline-none focus-visible:shadow-focus",
            )}
          >
            <X className="size-4" />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
});

export function DialogHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex shrink-0 flex-col gap-1 border-b border-border-subtle px-5 py-4 pr-12",
        className,
      )}
      {...props}
    />
  );
}

export const DialogTitle = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(function DialogTitle({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Title
      ref={ref}
      className={cn("text-lg font-semibold text-foreground", className)}
      {...props}
    />
  );
});

export const DialogDescription = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(function DialogDescription({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Description
      ref={ref}
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
});

/** 正文区：自身滚动，头/脚常驻 */
export function DialogBody({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("min-h-0 flex-1 overflow-y-auto px-5 py-4", className)}
      {...props}
    />
  );
}

/** 脚注：按钮一律右置（§6 危险确认双按钮右置） */
export function DialogFooter({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-end gap-2 border-t border-border-subtle px-5 py-3",
        className,
      )}
      {...props}
    />
  );
}

/* ══════════════════════════════════════════════════════════════════
   ConfirmDialog —— §7「危险操作」唯一配方
   删除/覆盖类必须走本组件；不可逆且影响面大者传 confirmText 要求输入名称。
   ══════════════════════════════════════════════════════════════════ */

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 标题：动作 + 对象，如「删除考试」 */
  title: string;
  /** 说清代价，如「该考试的 128 份扫描件与成绩将一并删除，不可恢复。」 */
  description?: React.ReactNode;
  /** 主按钮文案，默认按 tone 取「删除」/「确认」 */
  confirmLabel?: string;
  cancelLabel?: string;
  /** danger=红色主按钮（默认）；default=品牌红主按钮（非破坏性确认） */
  tone?: "danger" | "default";
  /** 传入后要求用户逐字输入该文本才放行（不可逆且影响面大者） */
  confirmText?: string;
  loading?: boolean;
  onConfirm: () => void;
  children?: React.ReactNode;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = "取消",
  tone = "danger",
  confirmText,
  loading = false,
  onConfirm,
  children,
}: ConfirmDialogProps) {
  const [typed, setTyped] = React.useState("");

  // 每次开启重置输入，避免上一次的残留直接放行
  React.useEffect(() => {
    if (open) setTyped("");
  }, [open]);

  const locked = Boolean(confirmText) && typed.trim() !== confirmText;
  const label = confirmLabel ?? (tone === "danger" ? "删除" : "确认");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm" role="alertdialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? (
            <DialogDescription>{description}</DialogDescription>
          ) : null}
        </DialogHeader>
        {(children || confirmText) && (
          <DialogBody className="flex flex-col gap-3">
            {children}
            {confirmText && (
              <div className="flex flex-col gap-1.5">
                <span className="text-sm text-secondary-foreground">
                  请输入 <span className="font-medium text-foreground">{confirmText}</span> 以确认
                </span>
                <Input
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  placeholder={confirmText}
                  autoComplete="off"
                />
              </div>
            )}
          </DialogBody>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={loading}
          >
            {cancelLabel}
          </Button>
          <Button
            variant={tone === "danger" ? "destructive" : "primary"}
            onClick={onConfirm}
            loading={loading}
            disabled={locked}
          >
            {label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
