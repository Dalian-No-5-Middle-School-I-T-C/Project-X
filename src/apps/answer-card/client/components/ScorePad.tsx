import React, { useMemo } from "react";

interface Props {
  maxScore: number;
  currentScore: number;
  onScoreChange: (score: number) => void;
  disabled?: boolean;
}

interface ScoreButton {
  label: string;
  value: number;
}

function generateButtons(maxScore: number): ScoreButton[][] {
  if (maxScore <= 0) return [[{ label: "0", value: 0 }]];

  if (maxScore < 10) {
    // 小分题: 个位列 + 半分别
    const ones: ScoreButton[] = [];
    for (let i = maxScore; i >= 0; i--) {
      ones.push({ label: String(i), value: i });
    }

    const halfs: ScoreButton[] = [{ label: "0", value: 0 }];
    if (maxScore >= 0.5) {
      halfs.push({ label: "0.5", value: 0.5 });
    }
    halfs.reverse();
    return [ones, halfs];
  }

  // 大分题: 十位列 + 个位列 + 半分别
  const maxTens = Math.floor(maxScore / 10);
  const tens: ScoreButton[] = [];
  for (let t = maxTens; t >= 0; t--) {
    tens.push({ label: String(t * 10), value: t * 10 });
  }

  const ones: ScoreButton[] = [];
  for (let u = 9; u >= 0; u--) {
    ones.push({ label: String(u), value: u });
  }

  const halfs: ScoreButton[] = [{ label: "0", value: 0 }, { label: "0.5", value: 0.5 }];
  halfs.reverse();

  return [tens, ones, halfs];
}

export function ScorePad({ maxScore, currentScore, onScoreChange, disabled }: Props) {
  const columns = useMemo(() => generateButtons(maxScore), [maxScore]);

  // 当前选中的各位值
  const tens = Math.floor(currentScore / 10) * 10;
  const ones = currentScore - tens;
  const half = currentScore % 1 >= 0.49 ? 0.5 : 0;

  const isSelected = (col: number, val: number) => {
    if (col === 0 && columns.length === 2) {
      // 小分题: 第0列是个位
      return currentScore === val;
    }
    if (col === 0 && columns.length === 3) {
      // 大分题: 第0列是十位
      return tens === val;
    }
    if (col === 1 && columns.length === 3) {
      return Math.round(ones) === val;
    }
    if (col === columns.length - 1) {
      return half === val;
    }
    return false;
  };

  const handleClick = (col: number, val: number) => {
    if (disabled) return;

    if (columns.length === 2) {
      // 小分题: 个位 + 0.5
      if (col === 0) {
        const newScore = val;
        onScoreChange(Math.min(newScore + (currentScore % 1), maxScore));
      } else {
        const base = Math.floor(currentScore);
        onScoreChange(Math.min(base + val, maxScore));
      }
      return;
    }

    // 大分题: 十位 + 个位 + 0.5
    if (col === 0) {
      // 选择十位
      const newScore = val + (currentScore % 10);
      onScoreChange(Math.min(newScore, maxScore));
    } else if (col === 1) {
      // 选择个位
      const newTens = Math.floor(currentScore / 10) * 10;
      const newScore = newTens + val + (currentScore % 1);
      onScoreChange(Math.min(newScore, maxScore));
    } else {
      // 选择 0.5
      const base = Math.floor(currentScore);
      onScoreChange(Math.min(base + val, maxScore));
    }
  };

  if (columns.length === 0) return null;

  return (
    <div style={{ userSelect: "none" }}>
      <div style={{
        fontSize: 13,
        color: "var(--color-text-secondary)",
        marginBottom: 8
      }}>
        满分 {maxScore} 分
      </div>
      <div style={{
        display: "grid",
        gridTemplateColumns: columns.map(() => "1fr").join(" "),
        gap: 8,
        marginBottom: 12,
      }}>
        {columns.map((col, colIdx) => (
          <div key={colIdx} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {col.map((btn, btnIdx) => (
              <button
                key={btnIdx}
                onClick={() => handleClick(colIdx, btn.value)}
                disabled={disabled}
                style={{
                  minHeight: 56,
                  minWidth: 56,
                  fontSize: 22,
                  fontWeight: 500,
                  borderRadius: 10,
                  border: isSelected(colIdx, btn.value)
                    ? "2px solid var(--color-text-primary)"
                    : "1px solid var(--color-border-primary)",
                  background: isSelected(colIdx, btn.value)
                    ? "var(--color-text-primary)"
                    : "var(--color-background-secondary)",
                  color: isSelected(colIdx, btn.value)
                    ? "var(--color-background-primary)"
                    : "var(--color-text-primary)",
                  cursor: disabled ? "default" : "pointer",
                  transition: "all 0.1s",
                  touchAction: "manipulation",
                }}
              >
                {btn.label}
              </button>
            ))}
          </div>
        ))}
      </div>

      <div style={{
        textAlign: "center",
        fontSize: 28,
        fontWeight: 500,
        padding: "8px 0",
      }}>
        {currentScore % 1 > 0 ? currentScore.toFixed(1) : currentScore}<span style={{ fontSize: 14, color: "var(--color-text-secondary)" }}> 分</span>
      </div>
    </div>
  );
}
