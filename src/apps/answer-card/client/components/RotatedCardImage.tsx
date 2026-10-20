import { useEffect, useState } from "react";
import { RotateCcw, RotateCw } from "lucide-react";
import { cn } from "../lib/utils";
import { Button } from "./ui/v2";

/**
 * 原卷图片旋转（issue #347：扫描仪送来的页面整张横 90°，改分与查看原卷要点选/滚动很费劲）。
 *
 * 旋转一律走 SVG：把 viewBox 的宽高交换后再对内容做 rotate，布局盒与旋转后的视觉盒一致，
 * 容器不需要测量尺寸也不会留出空白或裁切。整卡改分的填涂热区与图片在同一个 SVG 内，
 * 因此热区随图旋转，点选坐标不受影响（见 CorrectionCanvas）。
 */
export type ImageRotation = 0 | 90 | 180 | 270;

export function rotateImageBy(rotation: ImageRotation, delta: 90 | -90): ImageRotation {
  return ((((rotation + delta) % 360) + 360) % 360) as ImageRotation;
}

export function rotationViewBox(width: number, height: number, rotation: ImageRotation): string {
  return rotation === 90 || rotation === 270 ? `0 0 ${height} ${width}` : `0 0 ${width} ${height}`;
}

/** SVG 变换从右往左作用，所以先 rotate 再把内容平移回交换后的视口内。 */
export function rotationTransform(width: number, height: number, rotation: ImageRotation): string {
  switch (rotation) {
    case 90: return `translate(0 ${width}) rotate(-90)`;
    case 180: return `translate(${width} ${height}) rotate(180)`;
    case 270: return `translate(${height} 0) rotate(90)`;
    default: return "";
  }
}

export interface RotatedCardImageProps {
  src: string;
  alt: string;
  rotation?: ImageRotation;
  /** 附加在旋转容器上的类名；默认按宽度铺满、高度随比例（与原 <img class="block h-auto w-full"> 一致）。 */
  className?: string;
  loading?: "eager" | "lazy";
  /** 未旋转或尚未取到尺寸时回落到普通 <img>，此时把加载失败交给调用方（如媒体票据重签）。 */
  onError?: (event: { currentTarget: HTMLImageElement }) => void;
}

/** 只读展示用的原卷图片：rotation 为 0 时保持原来的 <img> 渲染，不引入额外布局。 */
export function RotatedCardImage({ src, alt, rotation = 0, className, loading = "lazy", onError }: RotatedCardImageProps) {
  const [dims, setDims] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => setDims(null), [src]);

  if (rotation === 0 || !dims) {
    return (
      <img
        src={src}
        alt={alt}
        loading={loading}
        onError={onError}
        onLoad={(event) => {
          const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
          if (rotation !== 0 && width > 0 && height > 0) setDims({ width, height });
        }}
        className={cn("block h-auto w-full", className)}
      />
    );
  }
  return (
    <svg
      viewBox={rotationViewBox(dims.width, dims.height, rotation)}
      width="100%"
      role="img"
      aria-label={alt}
      style={{ aspectRatio: `${dims.width} / ${dims.height}` }}
      className={cn("block h-auto max-w-none", className)}
    >
      <g transform={rotationTransform(dims.width, dims.height, rotation)}>
        <image href={src} width={dims.width} height={dims.height} preserveAspectRatio="none" />
      </g>
    </svg>
  );
}

/** 工具条上的旋转按钮对：与「缩小 / 放大 / 百分比」同排使用。 */
export function RotationButtons({ rotation, onChange, size = "icon-sm", variant = "outline", disabled = false }: {
  rotation: ImageRotation;
  onChange: (next: ImageRotation) => void;
  size?: "sm" | "icon" | "icon-sm";
  variant?: "outline" | "ghost";
  disabled?: boolean;
}) {
  return (
    <>
      <Button size={size} variant={variant} disabled={disabled} aria-label="逆时针旋转 90 度" title="逆时针旋转 90°" onClick={() => onChange(rotateImageBy(rotation, -90))}>
        <RotateCcw />
      </Button>
      <span className="min-w-9 text-center text-sm tabular-nums" role="status">{rotation}°</span>
      <Button size={size} variant={variant} disabled={disabled} aria-label="顺时针旋转 90 度" title="顺时针旋转 90°" onClick={() => onChange(rotateImageBy(rotation, 90))}>
        <RotateCw />
      </Button>
    </>
  );
}
