// ScorePad —— 阅卷分数键盘（T5 v2 迁移）
// 视觉层令牌化：按钮改用 v2 语义类（选中=品牌红实底，未选=secondary），
// 触摸目标沿用 56px 下限（大于 --px-touch-target 44px，判分工作台刻意放大）。
import React, { useMemo, useState } from "react";
import { cn } from "../lib/utils";

interface Props {
  maxScore: number;
  /** 本题块是否含 0.5 小数（v1.9.4） */
  hasHalfPoint: boolean;
  currentScore: number;
  /** 当前卷是否已有显式分数（决定位置模式是否点亮已选位值，避免把 0 当成已选） */
  entered?: boolean;
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

export function ScorePad({ maxScore, hasHalfPoint, currentScore, entered, onScoreChange, onSubmit, disabled }: Props) {
  const usePositionMode = maxScore >= 20;
  const initialTens = entered ? Math.floor(currentScore / 10) * 10 : null;
  const initialOnes = entered ? Math.floor(currentScore) - Math.floor(currentScore / 10) * 10 : null;
  const initialHalf = entered && hasHalfPoint
    ? (Math.abs(currentScore % 1) >= 0.5 ? 0.5 : 0)
    : null;
  // 位置模式用显式选择状态：0 分与「尚未选位」必须区分，否则未选十位/个位时点 0.5 会误交 0 分。
  const [selectedTens, setSelectedTens] = useState<number | null>(initialTens);
  const [selectedOnes, setSelectedOnes] = useState<number | null>(initialOnes);
  const [selectedHalf, setSelectedHalf] = useState<number | null>(hasHalfPoint ? initialHalf : 0);

  // 位置模式（满分 ≥ 20）：十位 + 个位（+ 含 0.5 时的十分位）
  const positionColumns = useMemo<ScoreButton[][]>(() => {
    if (!usePositionMode) return [];
    const maxTens = Math.floor(maxScore / 10);
    const tens: ScoreButton[] = [];
    for (let t = 0; t <= maxTens; t++) tens.push({ label: String(t * 10), value: t * 10 });
    const ones: ScoreButton[] = [];
    for (let u = 0; u <= 9; u++) ones.push({ label: String(u), value: u });
    if (!hasHalfPoint) return [tens, ones];
    return [tens, ones, [{ label: "0", value: 0 }, { label: "0.5", value: 0.5 }]];
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
    () => (hasHalfPoint && !usePositionMode ? [{ label: "0", value: 0 }, { label: "0.5", value: 0.5 }].filter(btn => btn.value <= maxScore) : []),
    [hasHalfPoint, usePositionMode, maxScore]
  );

  const syncSelection = (value: number) => {
    const bounded = Math.max(0, Math.min(value, maxScore));
    setSelectedTens(Math.floor(bounded / 10) * 10);
    setSelectedOnes(Math.floor(bounded) - Math.floor(bounded / 10) * 10);
    setSelectedHalf(hasHalfPoint ? (Math.abs(bounded % 1) >= 0.5 ? 0.5 : 0) : 0);
  };

  const commit = (value: number) => {
    if (disabled) return;
    const v = Math.max(0, Math.min(value, maxScore));
    syncSelection(v);
    onScoreChange(v);
    onSubmit(v);
  };

  // 当前预览值：十位/个位各自独立记录，未选的位不参与合成。
  const previewScore = (() => {
    if (!usePositionMode) return currentScore;
    const base = (selectedTens ?? 0) + (selectedOnes ?? 0);
    return Math.max(0, Math.min(base + (hasHalfPoint ? (selectedHalf ?? 0) : 0), maxScore));
  })();

  const isSelected = (col: number, val: number) => {
    if (!usePositionMode) return false;
    if (col === 0) return selectedTens === val;
    if (col === 1) return selectedOnes === val;
    return col === 2 && selectedHalf === val;
  };

  const tenthsReady = selectedTens !== null && selectedOnes !== null;
  const columnDisabled = (col: number): boolean => {
    if (!usePositionMode) return false;
    // 个位依赖十位；十分位必须等十位和个位都明确选过，避免「只选十位就点 0.5」。
    if (col === 1) return selectedTens === null;
    if (col === 2) return !tenthsReady;
    return false;
  };

  const handlePositionClick = (col: number, val: number) => {
    if (disabled || columnDisabled(col)) return;
    if (col === 0) {
      setSelectedTens(val);
      onScoreChange(Math.min(val + (selectedOnes ?? 0) + (hasHalfPoint ? (selectedHalf ?? 0) : 0), maxScore));
      return;
    }
    if (col === 1) {
      setSelectedOnes(val);
      const total = (selectedTens ?? 0) + val;
      if (!hasHalfPoint) {
        // 整数模式没有十分位列：十位+个位选完即完整，直接提交。
        commit(total);
      } else {
        onScoreChange(Math.min(total + (selectedHalf ?? 0), maxScore));
      }
      return;
    }
    // 十分位（仅 0.5 模式存在）：合成完整分值并提交。
    setSelectedHalf(val);
    commit((selectedTens ?? 0) + (selectedOnes ?? 0) + val);
  };

  const step = hasHalfPoint ? 0.5 : 1;
  const fullMarkButton = Math.abs(maxScore - Math.round(maxScore / step) * step) > 1e-9 && (
    <button
      type="button"
      onClick={() => commit(maxScore)}
      disabled={disabled}
      aria-pressed={currentScore === maxScore}
      className={padBtnClass(currentScore === maxScore, disabled)}
    >
      满分 {maxScore}
    </button>
  );

  if (usePositionMode) {
    return (
      <div className="select-none">
        <p className="mb-2 text-sm text-muted-foreground">
          满分 <span className="tabular-nums">{maxScore}</span> 分 · 位值输入
          {hasHalfPoint ? "（选完十位与个位后点末列确认）" : "（选完十位与个位即提交）"}
        </p>
        <div className="mb-3 flex gap-2">
          {positionColumns.map((col, colIdx) => (
            <div key={colIdx} className="flex flex-1 flex-col gap-2">
              {col.map((btn, btnIdx) => {
                const isDisabled = Boolean(disabled) || columnDisabled(colIdx);
                return (
                  <button
                    key={btnIdx}
                    type="button"
                    onClick={() => handlePositionClick(colIdx, btn.value)}
                    disabled={isDisabled}
                    aria-pressed={isSelected(colIdx, btn.value)}
                    className={padBtnClass(isSelected(colIdx, btn.value), isDisabled)}
                  >
                    {btn.label}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        {fullMarkButton}
        <ScorePreview currentScore={previewScore} />
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
        {fullMarkButton}
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
      {currentScore}
      <span className="text-base text-muted-foreground"> 分</span>
    </div>
  );
}
