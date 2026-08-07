import { useState } from "react";
import { Lock, Moon, Palette, Sun } from "lucide-react";
import { cn } from "../lib/utils";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "./ui/v2";

/* ══════════════════════════════════════════════════════════════════
   皮肤切换器（v2.1.0）
   ------------------------------------------------------------------
   皮肤 = 风格维度（data-skin），与明暗（data-theme）正交：
   - 皮肤选择的是「整套视觉风格」，当前仅有默认皮肤 'flat'（明澈 Flat 2.0）；
     未来新增皮肤时：① tokens.css 增加 [data-skin="xxx"] 的 L2 语义令牌覆盖块；
     ② 在本文件 SKIN_OPTIONS 注册表登记（id 与 data-skin 值一致）。
   - 明暗选择复用既有 projectx-theme / data-theme 机制，与皮肤互不干扰。

   两种使用模式：
   - 受控（App / 设置页）：传 skin/theme + onSkinChange/onThemeChange；
   - 自管（登录页等 WorkspaceProvider 之外）：不传 props，组件直接读写
     localStorage（projectx-skin / projectx-theme）与 documentElement 属性。
   ══════════════════════════════════════════════════════════════════ */

/** 皮肤注册表 —— 新增皮肤在此登记（id 同时是 data-skin 属性值） */
export const SKIN_OPTIONS: ReadonlyArray<{ id: string; label: string; description: string }> = [
  { id: "flat", label: "明澈 Flat 2.0", description: "默认风格" },
];

export const DEFAULT_SKIN = "flat";
export const SKIN_STORAGE_KEY = "projectx-skin";
export const THEME_STORAGE_KEY = "projectx-theme";

function readLocalSkin(): string {
  try {
    return localStorage.getItem(SKIN_STORAGE_KEY) || DEFAULT_SKIN;
  } catch {
    return DEFAULT_SKIN;
  }
}

function readLocalTheme(): "light" | "dark" {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

function writeLocalSkin(skin: string): void {
  // 默认皮肤不设 data-skin 也不落盘（零污染；localStorage 无记录 ⇔ 未显式选择，
  // 与 App.tsx 的皮肤同步 effect 保持一致，供登录后「账号为权威」逻辑区分）
  if (skin === DEFAULT_SKIN) {
    try {
      localStorage.removeItem(SKIN_STORAGE_KEY);
    } catch {
      /* private browsing / storage disabled */
    }
    delete document.documentElement.dataset.skin;
    return;
  }
  try {
    localStorage.setItem(SKIN_STORAGE_KEY, skin);
  } catch {
    /* private browsing / storage disabled */
  }
  document.documentElement.dataset.skin = skin;
}

function writeLocalTheme(theme: "light" | "dark"): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* private browsing / storage disabled */
  }
  document.documentElement.setAttribute("data-theme", theme);
}

export interface SkinSwitcherProps {
  /** 受控皮肤 id（不传则自管：读写 localStorage + data-skin） */
  skin?: string;
  onSkinChange?: (skin: string) => void;
  /** 受控明暗（不传则自管：读写 localStorage + data-theme） */
  theme?: "light" | "dark";
  onThemeChange?: (theme: "light" | "dark") => void;
  /** 触发器尺寸：md=控件标准高，sm=32px */
  size?: "md" | "sm";
  align?: "start" | "center" | "end";
  className?: string;
}

export function SkinSwitcher({
  skin,
  onSkinChange,
  theme,
  onThemeChange,
  size = "md",
  align = "end",
  className,
}: SkinSwitcherProps) {
  const [localSkin, setLocalSkin] = useState<string>(readLocalSkin);
  const [localTheme, setLocalTheme] = useState<"light" | "dark">(readLocalTheme);

  const activeSkin = skin ?? localSkin;
  const activeTheme = theme ?? localTheme;
  const currentSkinLabel = SKIN_OPTIONS.find((s) => s.id === activeSkin)?.label ?? activeSkin;

  function handleSkinChange(next: string) {
    if (onSkinChange) onSkinChange(next);
    else {
      setLocalSkin(next);
      writeLocalSkin(next);
    }
  }

  function handleThemeChange(next: "light" | "dark") {
    if (onThemeChange) onThemeChange(next);
    else {
      setLocalTheme(next);
      writeLocalTheme(next);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={`外观与皮肤 · 当前：${currentSkinLabel} · ${activeTheme === "light" ? "亮色" : "暗色"}`}
          aria-label="切换外观与皮肤"
          className={cn(
            "inline-flex items-center justify-center rounded-md text-secondary-foreground",
            "transition-colors duration-(--px-dur-1) hover:bg-secondary hover:text-foreground",
            size === "md" ? "h-control-md w-control-md" : "size-8",
            className,
          )}
        >
          <Palette size={18} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-52">
        <DropdownMenuLabel>外观</DropdownMenuLabel>
        <DropdownMenuGroup>
          {SKIN_OPTIONS.map((option) => (
            <DropdownMenuCheckboxItem
              key={option.id}
              checked={activeSkin === option.id}
              onCheckedChange={() => handleSkinChange(option.id)}
            >
              <Palette className="mr-2 size-4 text-muted-foreground" />
              {option.label}
            </DropdownMenuCheckboxItem>
          ))}
          <DropdownMenuCheckboxItem checked={false} disabled>
            <Lock className="mr-2 size-4 text-muted-foreground" />
            更多皮肤
            <DropdownMenuShortcut>开发中</DropdownMenuShortcut>
          </DropdownMenuCheckboxItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>明暗</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={activeTheme} onValueChange={(v) => handleThemeChange(v as "light" | "dark")}>
          <DropdownMenuRadioItem value="light">
            <Sun className="mr-2 size-4 text-muted-foreground" /> 亮色
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <Moon className="mr-2 size-4 text-muted-foreground" /> 暗色
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
