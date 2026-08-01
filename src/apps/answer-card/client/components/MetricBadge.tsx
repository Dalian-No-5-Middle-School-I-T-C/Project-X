import { useEffect, useState } from "react";
import type { ThresholdBand } from "../../../../shared/stats";

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

/** 依据档位数组判定归属（value ≤ max 归入该档） */
export function classifyBand(value: number, bands: ThresholdBand[] | undefined): { label: string; color: string } {
  if (!bands || bands.length === 0) return { label: "—", color: "#888780" };
  for (const b of bands) if (value <= b.max) return { label: b.label, color: b.color };
  const last = bands[bands.length - 1];
  return { label: last.label, color: last.color };
}

function badgeStyle(color: string): React.CSSProperties {
  return {
    display: "inline-block",
    padding: "1px 8px",
    borderRadius: 999,
    fontSize: 12,
    lineHeight: "18px",
    color,
    border: `1px solid ${color}`,
    background: `${color}1f`
  };
}

export function DifficultyBadge({ value, bands }: { value: number; bands?: ThresholdBand[] }) {
  const { label, color } = classifyBand(value, bands);
  return <span style={badgeStyle(color)} title="难度系数 P">{label} · {value.toFixed(2)}</span>;
}

export function DiscriminationBadge({ value, bands }: { value: number; bands?: ThresholdBand[] }) {
  const { label, color } = classifyBand(value, bands);
  return <span style={badgeStyle(color)} title="区分度 D">{label} · {value.toFixed(2)}</span>;
}
