import { useEffect, useState } from "react";
import { cn } from "../lib/utils";
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
    fetch("/api/analysis/config/bands")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (active && d && d.difficulty && d.discrimination) setBands(d); })
      .catch(() => {});
    return () => { active = false; };
  }, []);
  return bands;
}

/** 无档位数据时的兜底色：走语义 token，避免硬编码灰 */
const FALLBACK_BAND_COLOR = "var(--color-muted-foreground)";

/** 依据档位数组判定归属（value ≤ max 归入该档） */
export function classifyBand(value: number, bands: ThresholdBand[] | undefined): { label: string; color: string } {
  if (!bands || bands.length === 0) return { label: "—", color: FALLBACK_BAND_COLOR };
  for (const b of bands) if (value <= b.max) return { label: b.label, color: b.color };
  const last = bands[bands.length - 1];
  return { label: last.label, color: last.color };
}

/** 徽章版式：静态部分走工具类，仅「服务端档位色」保留数据驱动行内值（O-5） */
const BAND_BADGE_CLASS = cn(
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5",
  "text-xs leading-4 font-medium tabular-nums",
);

function BandBadge({ value, bands, title }: { value: number; bands?: ThresholdBand[]; title: string }) {
  const { label, color } = classifyBand(value, bands);
  return (
    <span
      className={BAND_BADGE_CLASS}
      title={title}
      // 数据驱动色：档位配色由服务端下发，不属于设计 token（O-5）
      style={{ color, borderColor: color, backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)` }}
    >
      <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden />
      {label} · {value.toFixed(2)}
    </span>
  );
}

export function DifficultyBadge({ value, bands }: { value: number; bands?: ThresholdBand[] }) {
  return <BandBadge value={value} bands={bands} title="难度系数 P" />;
}

export function DiscriminationBadge({ value, bands }: { value: number; bands?: ThresholdBand[] }) {
  return <BandBadge value={value} bands={bands} title="区分度 D" />;
}
