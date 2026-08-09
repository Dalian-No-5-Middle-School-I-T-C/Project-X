import { useState } from "react";
import { Moon, Palette, Sun } from "lucide-react";
import { cn } from "../lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/v2";

/* ══════════════════════════════════════════════════════════════════
   皮肤切换器（v2.1.0；v2.3.0 默认皮肤改为 'paper-edge'）
   ------------------------------------------------------------------
   皮肤 = 风格维度（data-skin），与明暗（data-theme）正交：
   - 皮肤选择的是「整套视觉风格」，现有 'paper-edge'（纸锋 Paper Edge，默认）与
     'flat'（明澈 Flat 2.0）两套；
     未来新增皮肤时：① tokens.css 增加 [data-skin="xxx"] 的 L2 语义令牌覆盖块；
     ② 在本文件 SKIN_OPTIONS 注册表登记（id 与 data-skin 值一致）。
   - 明暗选择复用既有 projectx-theme / data-theme 机制，与皮肤互不干扰。
   - 显式选择标记：任何一次切换（受控/自管）都会写入 sessionStorage
     projectx-skin-chosen，App 登录同步 effect 据此区分「本会话显式选择」与
     「默认值落盘」（见 readus/SKIN-THEME.md §二）；登出时由 AuthContext 清除。

   两种使用模式：
   - 受控（App / 设置页）：传 skin/theme + onSkinChange/onThemeChange；
   - 自管（登录页等 WorkspaceProvider 之外）：不传 props，组件直接读写
     localStorage（projectx-skin / projectx-theme）与 documentElement 属性。
   ══════════════════════════════════════════════════════════════════ */

/** 皮肤注册表 —— 新增皮肤在此登记（id 同时是 data-skin 属性值） */
export const SKIN_OPTIONS: ReadonlyArray<{ id: string; label: string; description: string }> = [
  { id: "paper-edge", label: "纸锋 Paper Edge", description: "默认风格 · 纸面墨蓝 · 直角硬影" },
  { id: "flat", label: "明澈 Flat 2.0", description: "可选风格 · 白底绯红" },
];

export const DEFAULT_SKIN = "paper-edge";
export const SKIN_STORAGE_KEY = "projectx-skin";
export const SKIN_CHOSEN_KEY = "projectx-skin-chosen";
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

export function writeLocalSkin(skin: string): void {
  // 默认皮肤也落盘 + 设 data-skin：默认 paper-edge 的 CSS 覆盖块依赖 data-skin 属性；
  // localStorage 仅作跨会话登录页记忆，「显式选择」语义由 sessionStorage chosen 标志承载。
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
    // 会话内显式选择标记（登录页/设置页任何切换都记录）：App 登录同步 effect
    // 据此区分「本会话显式选择」（本地优先）与「默认值落盘」（账号为权威），
    // 避免共享设备上账号间皮肤继承；登出时由 AuthContext 清除。
    try {
      sessionStorage.setItem(SKIN_CHOSEN_KEY, next);
    } catch {
      /* private browsing / storage disabled */
    }
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
          <DropdownMenuRadioGroup value={activeSkin} onValueChange={handleSkinChange}>
            {SKIN_OPTIONS.map((option) => (
              <DropdownMenuRadioItem key={option.id} value={option.id}>
                <Palette className="mr-2 size-4 shrink-0 text-muted-foreground" />
                <span className="flex min-w-0 flex-col">
                  <span>{option.label}</span>
                  <span className="truncate text-xs font-normal text-muted-foreground">
                    {option.description}
                  </span>
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
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
