// ScorePad —— 阅卷分数键盘（T5 v2 迁移）
// 视觉层令牌化：按钮改用 v2 语义类（选中=品牌红实底，未选=secondary），
// 触摸目标沿用 56px 下限（大于 --px-touch-target 44px，判分工作台刻意放大）。
// 功能守恒：位置模式 / 枚举模式的取值、提交与自动跳转逻辑逐行保留。
import React, { useMemo } from "react";
import { cn } from "../lib/utils";

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

/** 判分键统一配方：56px 触摸目标 + 语义色，选中态为品牌红实底 */
const padBtnClass = (selected: boolean, disabled?: boolean, emphasis?: boolean): string =>
  cn(
    "min-h-14 min-w-14 rounded-lg border text-2xl font-medium tabular-nums touch-manipulation",
    "transition-colors duration-(--px-dur-1) ease-standard",
    "outline-none focus-visible:shadow-focus",
    selected
      ? "border-primary bg-primary text-primary-foreground"
      : emphasis
        ? "border-border bg-muted text-foreground hover:bg-secondary"
        : "border-border bg-secondary text-foreground hover:border-border-strong",
    disabled ? "cursor-default opacity-50" : "cursor-pointer",
  );

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
      <div className="select-none">
        <p className="mb-2 text-sm text-muted-foreground">
          满分 <span className="tabular-nums">{maxScore}</span> 分 · 位值输入
        </p>
        <div className="mb-3 flex gap-2">
          {positionColumns.map((col, colIdx) => (
            <div key={colIdx} className="flex flex-1 flex-col gap-2">
              {col.map((btn, btnIdx) => (
                <button
                  key={btnIdx}
                  type="button"
                  onClick={() => handlePositionClick(colIdx, btn.value)}
                  disabled={disabled}
                  aria-pressed={isSelected(colIdx, btn.value)}
                  className={padBtnClass(isSelected(colIdx, btn.value), disabled)}
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
    <div className="select-none">
      <p className="mb-2 text-sm text-muted-foreground">
        满分 <span className="tabular-nums">{maxScore}</span> 分 · 点击即定分
      </p>
      <div className="mb-3 grid grid-cols-[repeat(auto-fill,minmax(64px,1fr))] gap-2">
        {enumMain.map((btn, idx) => (
          <button
            key={idx}
            type="button"
            onClick={() => commit(btn.value)}
            disabled={disabled}
            className={padBtnClass(false, disabled)}
          >
            {btn.label}
          </button>
        ))}
      </div>

      {enumBottom.length > 0 && (
        <>
          <div className="mt-1 mb-3 h-px bg-border-subtle" />
          <p className="mb-1.5 text-xs text-muted-foreground">
            极低分（空白 / 近空白卷）请显式点选：
          </p>
          <div className="grid grid-cols-2 gap-2">
            {enumBottom.map((btn, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => commit(btn.value)}
                disabled={disabled}
                className={cn(padBtnClass(false, disabled, true), "min-h-13")}
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
    <div className="py-2 text-center text-3xl font-medium tabular-nums text-foreground">
      {currentScore % 1 > 0 ? currentScore.toFixed(1) : currentScore}
      <span className="text-base text-muted-foreground"> 分</span>
    </div>
  );
}
