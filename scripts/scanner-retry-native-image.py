"""Fill the concurrency test's exported PDF for the real Windows recognizer."""
import argparse
import json
from pathlib import Path

import pymupdf

parser = argparse.ArgumentParser()
parser.add_argument("directory", type=Path)
args = parser.parse_args()
layout = json.loads((args.directory / "layout.json").read_text())
doc = pymupdf.open(args.directory / "并发回归答题卡.pdf")
page = doc[0]
scale = 72 / 25.4
for cell in layout["pages"][0]["elements"]:
    filled = (
        cell["type"] == "student_digit"
        and cell["digit"] == int("91001"[cell["digitIndex"]])
    ) or (cell["type"] == "objective_option" and cell["option"] == "A")
    r = cell.get("rect")
    if not r:
        continue
    rect = pymupdf.Rect(
        r["x"] * scale, r["y"] * scale,
        (r["x"] + r["width"]) * scale, (r["y"] + r["height"]) * scale,
    )
    if filled:
        rect += (0.15 * scale, 0.15 * scale, -0.15 * scale, -0.15 * scale)
        page.draw_rect(rect, color=None, fill=(0.04, 0.04, 0.04), overlay=True)
    elif cell["type"] == "score_cell" and cell["score"] == 10:
        page.draw_line(
            pymupdf.Point(rect.x0 - 1, rect.y0 + 0.7),
            pymupdf.Point(rect.x1 + 1, rect.y1 - 0.7),
            color=(0.88, 0.02, 0.02), width=1.25, overlay=True,
        )
page.get_pixmap(dpi=300, alpha=False).save(args.directory / "并发回归填涂.png")
doc.close()
print("Generated native test image: 91001, choice A, red-pen score 10")
