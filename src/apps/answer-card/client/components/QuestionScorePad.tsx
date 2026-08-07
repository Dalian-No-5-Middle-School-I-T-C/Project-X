import { useMemo } from "react";

interface Props {
  /** 该题满分；<=0 时只保留输入框（缺少满分信息时兜底） */
  maxScore: number;
  /** 给分步进：1 或 0.5 */
  step: 0.5 | 1;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * 网阅打分（Issue #173）：每题同时提供“输入 + 按钮”两种模式。
 * - 满分较小时直接枚举 0..满分 的分数按钮；
 * - 满分较大（按钮过多）时提供 0 / 0.5 / 满分 快捷按钮和 +/- 步进按钮；
 * - 输入框保留，步进跟随全局给分步进（0.5/1）。
 */
export function QuestionScorePad({ maxScore, step, value, onChange, disabled }: Props) {
  const numericValue = value === "" || value == null ? NaN : Number(value);

  const enumValues = useMemo(() => {
    if (maxScore <= 0) return [];
    const count = Math.floor(maxScore / step) + 1;
    if (count > 21) return [];
    const arr: number[] = [];
    for (let v = 0; v <= maxScore + 1e-9; v = round2(v + step)) arr.push(v);
    return arr;
  }, [maxScore, step]);

  const commit = (v: number) => {
    if (disabled || maxScore <= 0) return;
    const clamped = Math.max(0, Math.min(round2(v), maxScore));
    onChange(String(clamped));
  };

  const current = Number.isFinite(numericValue) ? Math.max(0, Math.min(numericValue, maxScore)) : 0;

  const btnStyle = (active = false): React.CSSProperties => ({
    minHeight: 30,
    minWidth: 34,
    padding: "3px 8px",
    fontSize: 13,
    fontWeight: active ? 600 : 400,
    borderRadius: 7,
    border: active ? "2px solid var(--primary)" : "1px solid var(--border)",
    background: active ? "var(--primary)" : "var(--surface)",
    color: active ? "#fff" : "var(--text-primary)",
    cursor: disabled ? "default" : "pointer",
    touchAction: "manipulation",
    whiteSpace: "nowrap",
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          type="number"
          min={0}
          max={maxScore > 0 ? maxScore : undefined}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          style={{
            width: 86,
            padding: "6px 8px",
            borderRadius: 6,
            border: "1px solid var(--border)",
            fontSize: 14,
            background: "var(--surface)",
            color: "var(--text-primary)",
            boxSizing: "border-box",
          }}
        />
        {maxScore > 0 && (
          <span style={{ fontSize: 12, color: "var(--muted)" }}>
            满分 {maxScore}
          </span>
        )}
      </div>

      {maxScore > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          {enumValues.length > 0 ? (
            <>
              {enumValues.map((v) => (
                <button
                  key={v}
                  type="button"
                  disabled={disabled}
                  onClick={() => commit(v)}
                  style={btnStyle(Number.isFinite(numericValue) && round2(numericValue) === v)}
                >
                  {v % 1 > 0 ? v.toFixed(1) : v}
                </button>
              ))}
            </>
          ) : (
            <>
              <button type="button" disabled={disabled} onClick={() => commit(0)} style={btnStyle(current === 0)}>
                0
              </button>
              {step === 0.5 && (
                <button type="button" disabled={disabled} onClick={() => commit(0.5)} style={btnStyle(current === 0.5)}>
                  0.5
                </button>
              )}
              <button
                type="button"
                disabled={disabled}
                onClick={() => commit(current - step)}
                style={btnStyle(false)}
                title={`减 ${step}`}
              >
                −{step}
              </button>
              <button
                type="button"
                disabled={disabled}
                onClick={() => commit(current + step)}
                style={btnStyle(false)}
                title={`加 ${step}`}
              >
                +{step}
              </button>
              <button type="button" disabled={disabled} onClick={() => commit(maxScore)} style={btnStyle(current === maxScore)}>
                满分
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
