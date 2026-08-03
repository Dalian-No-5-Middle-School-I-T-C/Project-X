import * as React from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { Check, Minus } from "lucide-react";
import { cn } from "../../../lib/utils";

/**
 * Checkbox / Radio / Switch —— DESIGN-SYSTEM §6
 * 选中一律填充品牌红。
 * 纪律：Switch 用于「即时生效」的设置项，Checkbox 用于「提交前」的选择，二者不混用。
 */

export const Checkbox = React.forwardRef<
  React.ComponentRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(function Checkbox({ className, ...props }, ref) {
  return (
    <CheckboxPrimitive.Root
      ref={ref}
      className={cn(
        "peer size-4 shrink-0 rounded-xs border border-input bg-card",
        "transition-[background-color,border-color,box-shadow] duration-(--px-dur-1) ease-standard",
        "hover:border-input-hover",
        "outline-none focus-visible:shadow-focus",
        "data-[state=checked]:border-primary data-[state=checked]:bg-primary",
        "data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center text-primary-foreground">
        {props.checked === "indeterminate" ? (
          <Minus className="size-3" strokeWidth={3} />
        ) : (
          <Check className="size-3" strokeWidth={3} />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
});

export const RadioGroup = React.forwardRef<
  React.ComponentRef<typeof RadioGroupPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Root>
>(function RadioGroup({ className, ...props }, ref) {
  return (
    <RadioGroupPrimitive.Root
      ref={ref}
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  );
});

export const RadioGroupItem = React.forwardRef<
  React.ComponentRef<typeof RadioGroupPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item>
>(function RadioGroupItem({ className, ...props }, ref) {
  return (
    <RadioGroupPrimitive.Item
      ref={ref}
      className={cn(
        "size-4 shrink-0 rounded-full border border-input bg-card",
        "transition-[border-color,box-shadow] duration-(--px-dur-1) ease-standard",
        "hover:border-input-hover",
        "outline-none focus-visible:shadow-focus",
        "data-[state=checked]:border-primary",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator className="flex size-full items-center justify-center">
        <span className="size-2 rounded-full bg-primary" />
      </RadioGroupPrimitive.Indicator>
    </RadioGroupPrimitive.Item>
  );
});

export const Switch = React.forwardRef<
  React.ComponentRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(function Switch({ className, ...props }, ref) {
  return (
    <SwitchPrimitive.Root
      ref={ref}
      className={cn(
        "peer inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent p-0.5",
        "bg-muted",
        "transition-[background-color,box-shadow] duration-(--px-dur-1) ease-standard",
        "outline-none focus-visible:shadow-focus",
        "data-[state=checked]:bg-primary",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "pointer-events-none block size-4 rounded-full bg-card shadow-1",
          "transition-transform duration-(--px-dur-1) ease-standard",
          "data-[state=unchecked]:translate-x-0 data-[state=checked]:translate-x-4",
        )}
      />
    </SwitchPrimitive.Root>
  );
});

/**
 * 带标签的行式控件容器：把 Checkbox/Radio/Switch 与文字对齐成一行，
 * 整行可点（label 关联），避免各页自行拼装造成对齐不一致。
 */
export function ControlRow({
  control,
  label,
  description,
  htmlFor,
  reverse = false,
  className,
}: {
  control: React.ReactNode;
  label: React.ReactNode;
  description?: React.ReactNode;
  htmlFor?: string;
  /** true = 控件在右（设置项常用：文字在左、Switch 在右） */
  reverse?: boolean;
  className?: string;
}) {
  const text = (
    <div className="flex min-w-0 flex-col gap-0.5">
      <label
        htmlFor={htmlFor}
        className="cursor-pointer text-base text-foreground select-none"
      >
        {label}
      </label>
      {description && (
        <p className="m-0 text-xs text-muted-foreground">{description}</p>
      )}
    </div>
  );

  return (
    <div
      className={cn(
        "flex items-start gap-3",
        reverse && "justify-between",
        className,
      )}
    >
      {reverse ? (
        <>
          {text}
          <div className="shrink-0 pt-0.5">{control}</div>
        </>
      ) : (
        <>
          <div className="shrink-0 pt-0.5">{control}</div>
          {text}
        </>
      )}
    </div>
  );
}
