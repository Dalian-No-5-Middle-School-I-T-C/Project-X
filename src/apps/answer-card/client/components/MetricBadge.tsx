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

/** 区分度 D 的最小可信样本量（极端组法在更小样本下每组不足 1 人，D 失去意义） */
export const MIN_D_SAMPLE_SIZE = 4;

export function DiscriminationBadge({ value, bands, sampleSize }: { value: number; bands?: ThresholdBand[]; sampleSize?: number }) {
  if (sampleSize !== undefined && sampleSize < MIN_D_SAMPLE_SIZE) {
    return <span style={badgeStyle("#888780")} title={`区分度 D：样本不足（至少需要 ${MIN_D_SAMPLE_SIZE} 人）`}>样本不足</span>;
  }
  const { label, color } = classifyBand(value, bands);
  return <span style={badgeStyle(color)} title="区分度 D">{label} · {value.toFixed(2)}</span>;
}
