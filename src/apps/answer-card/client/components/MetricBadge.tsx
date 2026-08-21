import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { cn } from "../lib/utils";
import { authFetch } from "../auth/api";
import type { ThresholdBand } from "../../../../shared/stats";

/**
 * MetricBadge —— T2 迁移（T03 主分析页 + 图表子树）
 *
 * 换肤范围（功能守恒，接口/路由/权限零改动）：
 *  · 版式（圆角/字号/行高/内边距/边框宽度）改由 Tailwind 语义工具类承担
 *  · **档位配色仍由服务端 `/api/analysis/config/bands` 下发**（裁决 O-5）：
 *    难度/区分度的 `color` 属于业务数据而非设计 token，管理员可在系统设置里改，
 *    因此这里保留数据驱动的行内色值，不改成语义 class、也不塞进 theme.ts。
 *  · 无 bands 时的兜底色改用语义变量 `--color-muted-foreground`，不再硬编码灰值。
 *  · 合并 main：区分度 D 增加最小样本量守卫（MIN_D_SAMPLE_SIZE，极端组法样本不足时提示）。
 *  · 2026-08 纸锋直角化评审：纸锋皮肤（data-skin="paper-edge"）下服务端档位色不生效，
 *    按档位位置重映射到纸锋三族（最优→蓝软族 / 最差→绯红描边族 / 中间→墨描边族），
 *    守住「蓝为主、绯红仅危险」的单色纪律；其余皮肤行为不变。圆角直角由 tokens.css 规则⑮承担。
 */

export interface BandSet {
  difficulty: ThresholdBand[];
  discrimination: ThresholdBand[];
}

/** 读取难度/区分度档位（系统设置可配，缺省回退内置默认）。每页调用一次即可。 */
export function useBands(): BandSet | null {
  const [bands, setBands] = useState<BandSet | null>(null);
  useEffect(() => {
    let active = true;
    authFetch("/api/analysis/config/bands")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (active && d && d.difficulty && d.discrimination) setBands(d); })
      .catch(() => {});
    return () => { active = false; };
  }, []);
  return bands;
}

/** 无档位数据时的兜底色：走语义 token，避免硬编码灰 */
const FALLBACK_BAND_COLOR = "var(--color-muted-foreground)";

/** 依据档位数组判定归属（value ≤ max 归入该档）；index = 命中档位下标（升序，0 = 最差档），无档位时为 -1 */
export function classifyBand(value: number, bands: ThresholdBand[] | undefined): { label: string; color: string; index: number } {
  if (!bands || bands.length === 0) return { label: "—", color: FALLBACK_BAND_COLOR, index: -1 };
  for (let i = 0; i < bands.length; i++) {
    if (value <= bands[i].max) return { label: bands[i].label, color: bands[i].color, index: i };
  }
  const last = bands[bands.length - 1];
  return { label: last.label, color: last.color, index: bands.length - 1 };
}

/** 当前是否纸锋皮肤（响应 SkinSwitcher 运行时切换；与 chart.tsx 同款 MutationObserver 模式） */
function useIsPaperEdgeSkin(): boolean {
  const [is, setIs] = useState(
    () => typeof document !== "undefined" && document.documentElement.dataset.skin === "paper-edge",
  );
  useEffect(() => {
    const el = document.documentElement;
    const obs = new MutationObserver(() => setIs(el.dataset.skin === "paper-edge"));
    obs.observe(el, { attributes: true, attributeFilter: ["data-skin"] });
    return () => obs.disconnect();
  }, []);
  return is;
}

/**
 * 纸锋三族重映射（仅 data-skin="paper-edge" 下调用）：服务端档位色让位于单色纪律——
 * 最优档（末位）→ 蓝软族；最差档（index 0）→ 绯红描边族（D 低 / P 异常的关注语义）；
 * 中间档 → 墨描边族。全部走 L2 语义变量，暗色主题自动适配。
 */
function paperEdgeBandStyle(index: number, total: number): CSSProperties {
  if (total > 1 && index === total - 1) {
    return {
      color: "var(--px-success-fg)",
      borderColor: "var(--px-success-border)",
      backgroundColor: "var(--px-success-soft)",
    };
  }
  if (total > 1 && index === 0) {
    return {
      color: "var(--px-danger-fg)",
      borderColor: "var(--px-danger-fg)",
      backgroundColor: "transparent",
    };
  }
  return {
    color: "var(--px-fg-primary)",
    borderColor: "var(--px-border-strong)",
    backgroundColor: "transparent",
  };
}

/** 徽章版式：静态部分走工具类，仅「服务端档位色」保留数据驱动行内值（O-5） */
const BAND_BADGE_CLASS = cn(
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5",
  "text-xs leading-4 font-medium tabular-nums",
);

function BandBadge({ value, bands, title }: { value: number; bands?: ThresholdBand[]; title: string }) {
  const paperEdge = useIsPaperEdgeSkin();
  const { label, color, index } = classifyBand(value, bands);
  const style: CSSProperties =
    paperEdge && index >= 0
      ? paperEdgeBandStyle(index, bands!.length)
      // 数据驱动色：档位配色由服务端下发，不属于设计 token（O-5）
      : { color, borderColor: color, backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)` };
  return (
    <span
      className={BAND_BADGE_CLASS}
      title={title}
      style={style}
    >
      <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden />
      {label} {value.toFixed(2)}
    </span>
  );
}

export function DifficultyBadge({ value, bands }: { value: number; bands?: ThresholdBand[] }) {
  return <BandBadge value={value} bands={bands} title="难度系数 P" />;
}

/** 区分度 D 的最小可信样本量（极端组法在更小样本下每组不足 1 人，D 失去意义） */
export const MIN_D_SAMPLE_SIZE = 4;

export function DiscriminationBadge({ value, bands, sampleSize }: { value: number; bands?: ThresholdBand[]; sampleSize?: number }) {
  if (sampleSize !== undefined && sampleSize < MIN_D_SAMPLE_SIZE) {
    return (
      <span
        className={BAND_BADGE_CLASS}
        title={`区分度 D：样本不足（至少需要 ${MIN_D_SAMPLE_SIZE} 人）`}
        style={{ color: "var(--color-muted-foreground)", borderColor: "var(--color-muted-foreground)", backgroundColor: "color-mix(in srgb, var(--color-muted-foreground) 12%, transparent)" }}
      >
        <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden />
        样本不足
      </span>
    );
  }
  return <BandBadge value={value} bands={bands} title="区分度 D" />;
}
