import React, { useMemo } from "react";

interface Props {
  maxScore: number;
  /** 本题块是否含 0.5 小数（v1.9.4） */
  hasHalfPoint: boolean;
  currentScore: number;
  /** 中间选值（用于预览，不自动提交） */
  onScoreChange: (score: number) => void;
  /** 选满即提交并自动跳下一页（v1.9.4 自动跳转） */
  onSubmit: (score: number) => void;
  disabled?: boolean;
}

interface ScoreButton {
  label: string;
  value: number;
}

const round = (v: number) => Math.round(v * 100) / 100;
const formatHalf = (v: number) => {
  const r = Math.round(v * 2) / 2;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
};

export function ScorePad({ maxScore, hasHalfPoint, currentScore, onScoreChange, onSubmit, disabled }: Props) {
  const usePositionMode = maxScore >= 20;

  // 位置模式（满分 ≥ 20）：十位 + 个位 + 十分位（0 / 0.5）
  const positionColumns = useMemo<ScoreButton[][]>(() => {
    if (!usePositionMode) return [];
    const maxTens = Math.floor(maxScore / 10);
    const tens: ScoreButton[] = [];
    for (let t = 0; t <= maxTens; t++) tens.push({ label: String(t * 10), value: t * 10 });
    const ones: ScoreButton[] = [];
    for (let u = 0; u <= 9; u++) ones.push({ label: String(u), value: u });
    const tenths: ScoreButton[] = hasHalfPoint
      ? [{ label: "0", value: 0 }, { label: "0.5", value: 0.5 }]
      : [{ label: "0", value: 0 }];
    return [tens, ones, tenths];
  }, [usePositionMode, maxScore, hasHalfPoint]);

  // 枚举模式（满分 < 20）：主区枚举 + 底部 0/0.5 专用行
  const enumMain = useMemo<ScoreButton[]>(() => {
    if (usePositionMode) return [];
    const arr: ScoreButton[] = [];
    if (hasHalfPoint) {
      for (let v = 1; v <= maxScore + 1e-9; v += 0.5) arr.push({ label: formatHalf(v), value: round(v) });
    } else {
      for (let v = 0; v <= maxScore; v += 1) arr.push({ label: String(v), value: v });
    }
    return arr;
  }, [usePositionMode, maxScore, hasHalfPoint]);
  const enumBottom = useMemo<ScoreButton[]>(
    () => (hasHalfPoint && !usePositionMode ? [{ label: "0", value: 0 }, { label: "0.5", value: 0.5 }] : []),
    [hasHalfPoint, usePositionMode]
  );

  const commit = (value: number) => {
    if (disabled) return;
    const v = Math.max(0, Math.min(value, maxScore));
    onScoreChange(v);
    onSubmit(v);
  };

  // 位置模式当前选中的各位值
  const tens = Math.floor(currentScore / 10) * 10;
  const ones = Math.round(currentScore) - tens;
  const half = currentScore % 1 >= 0.49 ? 0.5 : 0;

  const isSelected = (col: number, val: number) => {
    if (!usePositionMode) return false;
    if (col === 0) return tens === val;
    if (col === 1) return Math.round(ones) === val;
    if (col === positionColumns.length - 1) return half === val;
    return false;
  };

  const handlePositionClick = (col: number, val: number) => {
    if (disabled) return;
    const lastCol = positionColumns.length - 1;
    if (col === lastCol) {
      // 末位（十分位）→ 合成完整分值并提交（自动跳）
      const base = Math.floor(currentScore);
      commit(round(base + val));
      return;
    }
    // 十位 / 个位 → 仅更新预览
    if (col === 0) {
      const frac = currentScore - Math.floor(currentScore / 10) * 10;
      onScoreChange(Math.min(round(val + frac), maxScore));
    } else {
      const newTens = Math.floor(currentScore / 10) * 10;
      const frac = currentScore % 1 >= 0.49 ? 0.5 : 0;
      onScoreChange(Math.min(round(newTens + val + frac), maxScore));
    }
  };

  if (usePositionMode) {
    return (
      <div style={{ userSelect: "none" }}>
        <div style={{ fontSize: 13, color: "var(--color-text-secondary)", marginBottom: 8 }}>
          满分 {maxScore} 分 · 位值输入
        </div>
        <div style={{
          display: "grid",
          gridTemplateColumns: positionColumns.map(() => "1fr").join(" "),
          gap: 8,
          marginBottom: 12,
        }}>
          {positionColumns.map((col, colIdx) => (
            <div key={colIdx} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {col.map((btn, btnIdx) => (
                <button
                  key={btnIdx}
                  onClick={() => handlePositionClick(colIdx, btn.value)}
                  disabled={disabled}
                  style={padBtnStyle(isSelected(colIdx, btn.value), disabled)}
                >
                  {btn.label}
                </button>
              ))}
            </div>
          ))}
        </div>
        <ScorePreview currentScore={currentScore} />
      </div>
    );
  }

  // 枚举模式
  return (
    <div style={{ userSelect: "none" }}>
      <div style={{ fontSize: 13, color: "var(--color-text-secondary)", marginBottom: 8 }}>
        满分 {maxScore} 分 · 点击即定分
      </div>
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(64px, 1fr))",
        gap: 8,
        marginBottom: 12,
      }}>
        {enumMain.map((btn, idx) => (
          <button
            key={idx}
            onClick={() => commit(btn.value)}
            disabled={disabled}
            style={padBtnStyle(false, disabled)}
          >
            {btn.label}
          </button>
        ))}
      </div>

      {enumBottom.length > 0 && (
        <>
          <div style={{ height: 1, background: "var(--color-border-tertiary)", margin: "4px 0 12px" }} />
          <div style={{ fontSize: 12, color: "var(--color-text-tertiary)", marginBottom: 6 }}>
            极低分（空白 / 近空白卷）请显式点选：
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {enumBottom.map((btn, idx) => (
              <button
                key={idx}
                onClick={() => commit(btn.value)}
                disabled={disabled}
                style={{
                  ...padBtnStyle(false, disabled),
                  minHeight: 52,
                  background: "var(--color-background-tertiary)",
                }}
              >
                {btn.label}
              </button>
            ))}
          </div>
        </>
      )}

      <ScorePreview currentScore={currentScore} />
    </div>
  );
}

function ScorePreview({ currentScore }: { currentScore: number }) {
  return (
    <div style={{ textAlign: "center", fontSize: 28, fontWeight: 500, padding: "8px 0" }}>
      {currentScore % 1 > 0 ? currentScore.toFixed(1) : currentScore}
      <span style={{ fontSize: 14, color: "var(--color-text-secondary)" }}> 分</span>
    </div>
  );
}

const padBtnStyle = (selected: boolean, disabled?: boolean): React.CSSProperties => ({
  minHeight: 56,
  minWidth: 56,
  fontSize: 22,
  fontWeight: 500,
  borderRadius: 10,
  border: selected
    ? "2px solid var(--color-text-primary)"
    : "1px solid var(--color-border-primary)",
  background: selected ? "var(--color-text-primary)" : "var(--color-background-secondary)",
  color: selected ? "var(--color-background-primary)" : "var(--color-text-primary)",
  cursor: disabled ? "default" : "pointer",
  transition: "all 0.1s",
  touchAction: "manipulation",
});
