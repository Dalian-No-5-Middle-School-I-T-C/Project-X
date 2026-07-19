import React, { useEffect, useState, useCallback } from "react";
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
    return <img src={mediaUrl(imageUrl)} alt="作答切块" style={{ maxWidth: "100%", display: "block" }} />;
  }

  return (
    <div style={{ position: "relative", display: "inline-block", maxWidth: "100%" }}>
      <img src={mediaUrl(imageUrl)} alt="作答切块" style={{ maxWidth: "100%", display: "block" }} />
      {annotations.map((ann) => (
        <div
          key={ann.id}
          style={{
            position: "absolute",
            left: `${(ann.dataJson.x as number ?? 0) / widthPx * 100}%`,
            top: `${(ann.dataJson.y as number ?? 0) / heightPx * 100}%`,
            pointerEvents: "none",
          }}
        >
          {ann.type === "text" && (
            <div style={{
              background: "rgba(255, 59, 48, 0.15)",
              borderLeft: "2px solid #FF3B30",
              padding: "2px 8px",
              fontSize: 12,
              borderRadius: 4,
              color: "#FF3B30",
              maxWidth: 200,
              whiteSpace: "pre-wrap",
            }}>
              {ann.dataJson.text as string}
            </div>
          )}
          {ann.type === "drawing" && (
            <div style={{
              fontSize: 11,
              color: "#FF3B30",
              fontStyle: "italic",
            }}>
              ✏️ 手写批注
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
