// Calendar —— v2 月历网格（日期单选 + 日期标记数）。
// 供考试管理「日历视图」使用：markedDates 传入 日期→考试数，日期格内展示角标；
// 点击日期即选中并回调 onValueChange。零手写 CSS，仅 Tailwind 工具类 + --px-* 语义令牌。
import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "../../../lib/utils";

export interface CalendarProps {
  /** 当前选中日期 "YYYY-MM-DD"；传空串/非法值视为未选中 */
  value?: string | null;
  /** 点击日期回调（始终以规范化后的 "YYYY-MM-DD" 触发） */
  onValueChange?: (date: string) => void;
  /** 日期 → 标记数量（如当天考试数），>0 时在日期格右上角展示小角标 */
  markedDates?: ReadonlyMap<string, number>;
  className?: string;
}

const WEEKDAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"] as const;

function toDateString(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** 解析 "YYYY-MM-DD" 并校验为真实日历日 */
function parseDateString(value: string): [number, number, number] | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(year, month, day);
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return null;
  return [year, month, day];
}

export function Calendar({ value, onValueChange, markedDates, className }: CalendarProps) {
  const today = new Date();
  const todayStr = toDateString(today.getFullYear(), today.getMonth(), today.getDate());
  const initial = value ? parseDateString(value) : null;
  const [viewYear, setViewYear] = useState(initial ? initial[0] : today.getFullYear());
  const [viewMonth, setViewMonth] = useState(initial ? initial[1] : today.getMonth());

  // 外部选中日期变化（如「回到今天」）时同步视图月份
  useEffect(() => {
    const parsed = value ? parseDateString(value) : null;
    if (parsed) {
      setViewYear(parsed[0]);
      setViewMonth(parsed[1]);
    }
  }, [value]);

  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const leading = new Date(viewYear, viewMonth, 1).getDay();
  const cells: Array<{ day: number; date: string } | null> = [];
  for (let i = 0; i < leading; i++) cells.push(null);
  for (let day = 1; day <= daysInMonth; day++) {
    cells.push({ day, date: toDateString(viewYear, viewMonth, day) });
  }

  function moveMonth(delta: number) {
    let year = viewYear;
    let month = viewMonth + delta;
    if (month < 0) { month = 11; year -= 1; }
    else if (month > 11) { month = 0; year += 1; }
    setViewYear(year);
    setViewMonth(month);
  }

  function selectToday() {
    setViewYear(today.getFullYear());
    setViewMonth(today.getMonth());
    onValueChange?.(todayStr);
  }

  return (
    <div className={cn("w-full", className)}>
      <div className="mb-2 flex items-center justify-between">
        <button
          type="button"
          onClick={() => moveMonth(-1)}
          aria-label="上个月"
          className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <ChevronLeft className="size-4" />
        </button>
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold text-foreground">{viewYear} 年 {viewMonth + 1} 月</span>
          <button
            type="button"
            onClick={selectToday}
            className="rounded-md px-1.5 py-0.5 text-xs font-medium text-info-foreground transition-colors hover:bg-secondary"
          >
            今天
          </button>
        </div>
        <button
          type="button"
          onClick={() => moveMonth(1)}
          aria-label="下个月"
          className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <ChevronRight className="size-4" />
        </button>
      </div>
      <div className="mb-1 grid grid-cols-7 gap-1 text-center text-xs font-semibold text-muted-foreground">
        {WEEKDAY_LABELS.map((label) => <div key={label}>{label}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-1 text-center">
        {cells.map((cell, index) => {
          if (!cell) return <div key={index} />;
          const { day, date } = cell;
          const count = markedDates?.get(date) ?? 0;
          const isToday = date === todayStr;
          const isSelected = date === value;
          return (
            <button
              key={index}
              type="button"
              onClick={() => onValueChange?.(date)}
              aria-label={`${viewYear} 年 ${viewMonth + 1} 月 ${day} 日${count > 0 ? `，${count} 场考试` : ""}`}
              aria-pressed={isSelected}
              className={cn(
                "relative flex h-9 items-center justify-center rounded-md text-sm transition-colors outline-none focus-visible:shadow-focus",
                isSelected
                  ? "border-2 border-primary bg-accent font-semibold text-accent-foreground"
                  : isToday
                    ? "bg-secondary font-semibold text-foreground hover:bg-secondary/70"
                    : "text-foreground hover:bg-secondary",
              )}
            >
              <span>{day}</span>
              {count > 0 && (
                <span className="absolute top-0.5 right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] leading-none font-semibold text-primary-foreground">
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}