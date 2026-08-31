"""PDF 原卷 -> 压缩页图（多模态直传前处理）。

OpenAI 兼容的多模态接口只接受 webp/png/jpeg/gif 图片，
整份 PDF 以 data URL 直传会被拒绝（实测 deepseek-v4-flash-vision-exp 返回 400）。
因此多模态直传前把 PDF 页渲染成 JPEG（长边 <= 2048，质量 80），
与 Web 端图片上传的压缩策略保持一致。
"""

from __future__ import annotations

import base64

import pymupdf

MAX_AI_PAGES = 40
LONG_EDGE = 2048
JPEG_QUALITY = 80
MAX_DPI = 300


class PdfPageLimitError(ValueError):
    """PDF 页数超过多模态直传上限。"""


def pdf_bytes_to_images(pdf_bytes: bytes, max_pages: int = MAX_AI_PAGES) -> list[dict[str, str]]:
    """把一份 PDF 渲染成压缩 JPEG 页图（base64），每页长边 <= 2048。"""
    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    try:
        page_count = doc.page_count
        if page_count > max_pages:
            raise PdfPageLimitError(
                f"PDF 共 {page_count} 页，超过多模态直传上限 {max_pages} 页"
            )
        images: list[dict[str, str]] = []
        for page in doc:
            long_pt = max(page.rect.width, page.rect.height)
            dpi = min(MAX_DPI, int(LONG_EDGE * 72 / long_pt))
            pix = page.get_pixmap(dpi=dpi)
            data = pix.tobytes("jpeg", jpg_quality=JPEG_QUALITY)
            images.append({"mimeType": "image/jpeg", "base64": base64.b64encode(data).decode()})
        return images
    finally:
        doc.close()


def normalize_direct_files(files: list[dict[str, str]], max_pages: int = MAX_AI_PAGES) -> list[dict[str, str]]:
    """直传前归一化：PDF 转压缩页图，图片原样保留。"""
    out: list[dict[str, str]] = []
    pdf_pages_used = 0
    for f in files:
        mime = (f.get("mimeType") or "").lower()
        if mime == "application/pdf":
            page_images = pdf_bytes_to_images(
                base64.b64decode(f["base64"]),
                max_pages=max_pages - pdf_pages_used,
            )
            out.extend(page_images)
            pdf_pages_used += len(page_images)
        else:
            out.append(f)
    return out
