import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from "lucide-react";
import { cn } from "../lib/utils";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/v2";

/**
 * AnswerCardLightbox —— 答题卡放大查看（T2 迁移裁决 O-6）
 *
 * 取代 ScoreFixPage / StudentScoreDetail 中两份重复的 `createPortal` +
 * 手写 ESC + `zIndex: 999999` + `#1a1a1a` 实现：
 *  · 覆盖层统一走 v2 `Dialog`（Radix：ESC / 点遮罩关闭 / 焦点陷阱 / 层级令牌）
 *  · 图片区 `bg-overlay`，缩放与翻页一律 v2 `Button`
 *  · 缩放倍率是运行时数值，只能落在 `style.transform` 上（§0 铁律 2 允许的动态值）
 */

export const LIGHTBOX_ZOOM_MIN = 0.5;
export const LIGHTBOX_ZOOM_MAX = 3;
export const LIGHTBOX_ZOOM_STEP = 0.25;

export function clampLightboxZoom(value: number): number {
  return Math.min(LIGHTBOX_ZOOM_MAX, Math.max(LIGHTBOX_ZOOM_MIN, value));
}

export interface LightboxItem {
  id: string;
  title: string;
  subtitle?: string;
  imageUrl: string;
}

export interface AnswerCardLightboxProps {
  items: LightboxItem[];
  /** 当前页索引；-1 或越界即视为关闭 */
  index: number;
  zoom: number;
  onIndexChange: (next: number) => void;
  onZoomChange: (next: number) => void;
  onClose: () => void;
}

export function AnswerCardLightbox({
  items,
  index,
  zoom,
  onIndexChange,
  onZoomChange,
  onClose,
}: AnswerCardLightboxProps) {
  const current = index >= 0 && index < items.length ? items[index] : null;
  if (!current) return null;

  const hasPrev = index > 0;
  const hasNext = index < items.length - 1;

  /** 翻页时复位缩放（沿用迁移前两处实现的一致行为） */
  function goTo(next: number): void {
    onIndexChange(next);
    onZoomChange(1);
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        size="lg"
        className="h-[90vh] max-w-[min(1280px,94vw)]"
        aria-label="答题卡放大查看"
      >
        <DialogHeader className="flex-row items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <DialogTitle className="truncate text-base">
              {current.title}
            </DialogTitle>
            <DialogDescription className="truncate text-xs">
              {current.subtitle ? `${current.subtitle} · ` : ""}
              <span className="tabular-nums">
                第 {index + 1}/{items.length} 张
              </span>
            </DialogDescription>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="缩小"
              title="缩小"
              disabled={zoom <= LIGHTBOX_ZOOM_MIN}
              onClick={() => onZoomChange(clampLightboxZoom(zoom - LIGHTBOX_ZOOM_STEP))}
            >
              <ZoomOut />
            </Button>
            <span className="w-12 text-center text-xs tabular-nums text-muted-foreground">
              {Math.round(zoom * 100)}%
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="放大"
              title="放大"
              disabled={zoom >= LIGHTBOX_ZOOM_MAX}
              onClick={() => onZoomChange(clampLightboxZoom(zoom + LIGHTBOX_ZOOM_STEP))}
            >
              <ZoomIn />
            </Button>
          </div>
        </DialogHeader>

        {/* 图片区：O-6 定死 bg-overlay */}
        <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto bg-overlay px-14 py-4">
          {hasPrev && (
            <Button
              variant="secondary"
              size="icon"
              aria-label="上一张"
              title="上一张"
              onClick={() => goTo(index - 1)}
              className="absolute top-1/2 left-3 z-(--px-z-sticky) -translate-y-1/2 rounded-full"
            >
              <ChevronLeft />
            </Button>
          )}
          <img
            src={current.imageUrl}
            alt={current.title}
            className="max-h-full max-w-full object-contain transition-transform duration-(--px-dur-1) ease-standard"
            style={{ transform: `scale(${zoom})` }}
          />
          {hasNext && (
            <Button
              variant="secondary"
              size="icon"
              aria-label="下一张"
              title="下一张"
              onClick={() => goTo(index + 1)}
              className="absolute top-1/2 right-3 z-(--px-z-sticky) -translate-y-1/2 rounded-full"
            >
              <ChevronRight />
            </Button>
          )}
        </div>

        {/* 缩略图导航 */}
        {items.length > 1 && (
          <div className="flex shrink-0 items-center justify-center gap-1.5 overflow-x-auto border-t border-border-subtle px-4 py-2">
            {items.map((item, idx) => (
              <button
                key={`${item.id}-${idx}`}
                type="button"
                title={item.title}
                aria-label={item.title}
                aria-current={idx === index || undefined}
                onClick={() => goTo(idx)}
                className={cn(
                  "shrink-0 overflow-hidden rounded-xs border-2 bg-transparent p-0",
                  "transition-[border-color,opacity] duration-(--px-dur-1) ease-standard",
                  "outline-none focus-visible:shadow-focus",
                  idx === index
                    ? "border-primary opacity-100"
                    : "border-transparent opacity-60 hover:opacity-100",
                )}
              >
                <img
                  src={item.imageUrl}
                  alt=""
                  loading="lazy"
                  className="h-14 w-10 object-cover"
                />
              </button>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
