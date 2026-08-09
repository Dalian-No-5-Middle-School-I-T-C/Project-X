/* ══════════════════════════════════════════════════════════════════
   首次登录前皮肤引导层（新增）
   ------------------------------------------------------------------
   仅当「未走过引导」（localStorage projectx-skin-onboarded 缺失）时显示；
   登录成功后登录页卸载，天然只覆盖未登录态。
   必须二选一（无默认），确认后才可进入登录页。
   确认时复用以有的自管皮肤写入逻辑（writeLocalSkin 落盘 + 设 data-skin）
   并写 sessionStorage「会话内显式选择」标志（登录同步 effect 据此本地优先），
   再写一次性 onboarded 标志；纯 Tailwind 语义令牌，无手写 CSS。
   ══════════════════════════════════════════════════════════════════ */
import { useState } from "react";
import { Check } from "lucide-react";
import { Button } from "./ui/v2";
import { cn } from "../lib/utils";
import { SKIN_CHOSEN_KEY, writeLocalSkin } from "./SkinSwitcher";

/** 一次性引导标志：标记设备已走过首次皮肤选择，避免每次刷新重复弹窗 */
export const SKIN_ONBOARDED_KEY = "projectx-skin-onboarded";

/** 预览图（置于 public/，构建后以根路径引用） */
const FLAT_PREVIEW = "/skin-onboarding-assets/flat-preview.png";
const PAPER_PREVIEW = "/skin-onboarding-assets/paper-edge-preview.png";

/** 引导选项：与 SkinSwitcher.SKIN_OPTIONS 对应（id 即 data-skin 值） */
const ONBOARD_OPTIONS = [
  {
    id: "flat",
    name: "明澈 Flat 2.0",
    desc: "轻盈、现代、白底绯红强调色；适合日常高频阅卷与明亮办公环境。",
    preview: FLAT_PREVIEW,
  },
  {
    id: "paper-edge",
    name: "纸锋 Paper Edge",
    desc: "纸米色底、墨色文字、亮蓝强调；直角硬影、杂志编辑感，适合展示汇报。",
    preview: PAPER_PREVIEW,
  },
] as const;

/** 是否应显示引导层：未标记 onboarded 即显示（首次/清缓存后） */
export function shouldShowSkinOnboarding(): boolean {
  try {
    return localStorage.getItem(SKIN_ONBOARDED_KEY) !== "1";
  } catch {
    return true;
  }
}

export function SkinOnboarding({ onComplete }: { onComplete: () => void }) {
  const [selected, setSelected] = useState<string | null>(null);

  function handleConfirm() {
    if (!selected) return;
    // 会话内显式选择标记：登录同步 effect 据此「本地优先」保留本次选择
    try {
      sessionStorage.setItem(SKIN_CHOSEN_KEY, selected);
    } catch {
      /* private browsing / storage disabled */
    }
    // 自管写入：落盘 + 设 data-skin（即时生效，与应用内逻辑一致）
    writeLocalSkin(selected);
    // 一次性引导标志
    try {
      localStorage.setItem(SKIN_ONBOARDED_KEY, "1");
    } catch {
      /* private browsing / storage disabled */
    }
    onComplete();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-background p-6">
      <div className="w-full max-w-6xl">
        <div className="rounded-2xl bg-card p-8 shadow-xl md:p-12">
          <div className="mb-8 text-center">
            <h1 className="mb-2 text-2xl font-bold text-foreground md:text-3xl">选择界面风格</h1>
            <p className="text-sm text-muted-foreground md:text-base">
              请选择一套视觉风格后再进入登录；选定后仍可前往账号设置随时改回
            </p>
          </div>

          <div
            className="mb-8 grid grid-cols-1 gap-6 md:grid-cols-2"
            role="radiogroup"
            aria-label="选择界面风格"
          >
            {ONBOARD_OPTIONS.map((opt) => {
              const isSel = selected === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  role="radio"
                  aria-checked={isSel}
                  onClick={() => setSelected(opt.id)}
                  className={cn(
                    "group relative overflow-hidden rounded-xl bg-card text-left transition",
                    "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2",
                    isSel
                      ? "border-2 border-primary shadow-lg"
                      : "border-2 border-border-subtle hover:-translate-y-0.5",
                  )}
                >
                  {isSel && (
                    <div className="absolute right-3 top-3 z-10 flex size-7 items-center justify-center rounded-full bg-primary text-primary-foreground shadow">
                      <Check size={16} strokeWidth={3} />
                    </div>
                  )}
                  <div className="aspect-[3/2] w-full overflow-hidden border-b border-border-subtle bg-muted">
                    <img
                      src={opt.preview}
                      alt={`${opt.name} 预览`}
                      className="h-full w-full object-cover object-top"
                    />
                  </div>
                  <div className="p-6">
                    <h2 className="mb-1.5 text-lg font-bold text-foreground">{opt.name}</h2>
                    <p className="text-sm leading-relaxed text-muted-foreground">{opt.desc}</p>
                  </div>
                </button>
              );
            })}
          </div>

          <div className="flex flex-col items-center justify-between gap-4 pt-2 sm:flex-row">
            <p className="text-center text-xs text-muted-foreground sm:text-left">
              标准设置后，仍可前往「账号设置 → 客户端设置」修改外观与皮肤。
            </p>
            <Button variant="primary" size="lg" disabled={!selected} onClick={handleConfirm}>
              {selected === "flat"
                ? "使用明澈风格，进入登录"
                : selected === "paper-edge"
                  ? "使用纸锋风格，进入登录"
                  : "请先选择一种风格"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
