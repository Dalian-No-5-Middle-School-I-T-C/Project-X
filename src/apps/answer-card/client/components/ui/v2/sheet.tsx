import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cva, type VariantProps } from "class-variance-authority";
import { X } from "lucide-react";
import { cn } from "../../../lib/utils";

/**
 * Sheet —— DESIGN-SYSTEM §6
 * 右侧 420px 用于详情速览（学生逐题 / 扫描异常卷）；移动端导航用左侧。
 * 层级 z-(--px-z-drawer)（200），低于 Dialog(400)：抽屉里还能再开确认框。
 */

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;

const sheetVariants = cva(
  [
    "fixed z-(--px-z-drawer) flex flex-col bg-card text-foreground shadow-4",
    "duration-(--px-dur-3) ease-standard",
    "data-[state=open]:animate-in data-[state=closed]:animate-out",
    "outline-none",
  ],
  {
    variants: {
      side: {
        right:
          "inset-y-0 right-0 h-full w-[420px] max-w-[calc(100vw-32px)] border-l border-border data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right",
        left: "inset-y-0 left-0 h-full w-[300px] max-w-[calc(100vw-56px)] border-r border-border data-[state=open]:slide-in-from-left data-[state=closed]:slide-out-to-left",
        bottom:
          "inset-x-0 bottom-0 max-h-[80vh] w-full rounded-t-xl border-t border-border data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom",
      },
    },
    defaultVariants: { side: "right" },
  },
);

export interface SheetContentProps
  extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>,
    VariantProps<typeof sheetVariants> {
  hideClose?: boolean;
}

export const SheetContent = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Content>,
  SheetContentProps
>(function SheetContent(
  { className, children, side = "right", hideClose = false, ...props },
  ref,
) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay
        className={cn(
          "fixed inset-0 z-(--px-z-drawer) bg-scrim",
          "data-[state=open]:animate-in data-[state=open]:fade-in-0",
          "data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
        )}
      />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(sheetVariants({ side }), className)}
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
    </DialogPrimitive.Portal>
  );
});

export function SheetHeader({
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

export const SheetTitle = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(function SheetTitle({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Title
      ref={ref}
      className={cn("text-lg font-semibold text-foreground", className)}
      {...props}
    />
  );
});

export const SheetDescription = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(function SheetDescription({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Description
      ref={ref}
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
});

export function SheetBody({
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

export function SheetFooter({
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
