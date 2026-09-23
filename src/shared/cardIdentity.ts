import QRCode from "qrcode";
import type { Rect } from "./types";

export type IdentityMode = "strict" | "legacy";
export type CardIdentity = {
  status: "verified" | "unverified" | "rejected";
  code: string;
  cardId?: string;
  pageNumber?: number;
};
export type CardQrCode = { payload: string; rect: Rect; size: number; modules: number[] };

export function parseIdentityMode(value: unknown): IdentityMode {
  if (value === undefined || value === "strict") return "strict";
  if (value === "legacy") return "legacy";
  throw new Error("identityMode 必须是 strict 或 legacy");
}

export function createCardQrCode(cardId: string, pageNumber: number, rect: Rect): CardQrCode {
  const payload = `PXAC:1:${encodeURIComponent(cardId)}:${pageNumber}`;
  const { modules } = QRCode.create(payload, { errorCorrectionLevel: "M" });
  return { payload, rect, size: modules.size, modules: Array.from(modules.data) };
}

/** Shared vector geometry, including the mandatory four-module quiet zone. */
export function qrDarkRects(qr: CardQrCode): Rect[] {
  const unit = qr.rect.width / (qr.size + 8);
  const rects: Rect[] = [];
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.modules[y * qr.size + x]) rects.push({
        x: qr.rect.x + (x + 4) * unit, y: qr.rect.y + (y + 4) * unit,
        width: unit, height: unit,
      });
    }
  }
  return rects;
}
