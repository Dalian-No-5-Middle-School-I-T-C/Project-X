"""Verify paper identity codes and registration marks in rasterized application PDFs."""

import argparse
import json
from pathlib import Path

import cv2
import numpy as np
import pymupdf

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("root", type=Path)
args = parser.parse_args()
specs = json.loads((args.root / "matrix-exams.json").read_text())
detector = cv2.QRCodeDetector()
points_per_mm = 72 / 25.4


def clipped_gray(page, region, margin):
    x, y, width, height = (region[key] for key in ("x", "y", "width", "height"))
    clip = pymupdf.Rect(x - margin, y - margin, x + width + margin, y + height + margin) * points_per_mm
    pix = page.get_pixmap(dpi=240, colorspace=pymupdf.csGRAY, clip=clip, alpha=False)
    return np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width)


for name, spec in specs.items():
    folder = args.root / ("卡型" + name)
    layouts = json.loads((folder / "layout.json").read_text())["pages"]
    with pymupdf.open(folder / "答题卡.pdf") as pdf:
        assert len(pdf) == len(layouts)
        first = pdf[0].get_text()
        assert all(label in first for label in (spec["title"], "姓名", "班级"))
        for index, page in enumerate(pdf):
            layout = layouts[index]
            qr = clipped_gray(page, layout["header"]["qrCode"]["rect"], 2)
            text, _, _ = detector.detectAndDecode(qr)
            assert text == f"PXAC:1:{spec['card']}:{index + 1}", (spec["card"], index + 1, text)
            assert len(layout["markers"]) == 6
            for marker in layout["markers"]:
                center = clipped_gray(page, marker["rect"], -0.4)
                assert (center < 70).mean() > .95, (name, index + 1, marker["role"])
            print(f"{name} page {index + 1}: {text}, six printed registration marks")
