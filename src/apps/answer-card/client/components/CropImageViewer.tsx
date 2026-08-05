// CropImageViewer —— 作答切块只读预览（含批注回显，T5 v2 迁移）
// 视觉层切换到 v2 令牌类：批注红改走 destructive 语义，emoji 改 lucide 图标。
// 功能守恒：GET /api/review-annotations?cropId=... 与数据形状零改动。
// 说明：批注坐标是数据驱动的动态百分比，按 EXECUTION-PLAN §1.3「动态值除外」
//       仅保留几何定位的 inline style，不承载任何颜色。
import React, { useEffect, useState } from "react";
import { PenLine } from "lucide-react";
import { mediaUrl, fetchJson } from "../auth/api";
import type { ReviewAnnotation } from "../../../../shared/types";

interface Props {
  cropId: string;
  imageUrl: string;
  widthPx?: number;
  heightPx?: number;
}

export function CropImageViewer({ cropId, imageUrl, widthPx = 800, heightPx = 600 }: Props) {
  const [annotations, setAnnotations] = useState<ReviewAnnotation[]>([]);

  useEffect(() => {
    fetchJson<{ ok: boolean; data: ReviewAnnotation[] }>(
      `/api/review-annotations?cropId=${encodeURIComponent(cropId)}`
    ).then((res) => { if (res.ok) setAnnotations(res.data); }).catch(() => {});
  }, [cropId]);

  if (annotations.length === 0) {
    return <img src={mediaUrl(imageUrl)} alt="作答切块" className="block max-w-full" />;
  }

  return (
    <div className="relative inline-block max-w-full">
      <img src={mediaUrl(imageUrl)} alt="作答切块" className="block max-w-full" />
      {annotations.map((ann) => (
        <div
          key={ann.id}
          className="pointer-events-none absolute"
          style={{
            left: `${(ann.dataJson.x as number ?? 0) / widthPx * 100}%`,
            top: `${(ann.dataJson.y as number ?? 0) / heightPx * 100}%`,
          }}
        >
          {ann.type === "text" && (
            <div className="max-w-50 rounded-xs border-l-2 border-destructive bg-destructive-soft px-2 py-0.5 text-xs whitespace-pre-wrap text-destructive-fg">
              {ann.dataJson.text as string}
            </div>
          )}
          {ann.type === "drawing" && (
            <span className="inline-flex items-center gap-1 text-xs italic text-destructive-fg">
              <PenLine className="size-3" aria-hidden="true" /> 手写批注
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
