"""Fill the application's exported PDF and rasterize 50 controlled scanned cards."""
import json
from pathlib import Path

import pymupdf

root = Path(__file__).resolve().parent.parent / "ignored" / "production-flow"
(root / "images").mkdir(parents=True, exist_ok=True)
layout = json.loads((root / "layout.json").read_text())["pages"][0]
source = (root / "答题卡原版.pdf").read_bytes()
scale = 72 / 25.4
manifest = []


def rectangle(value, inset=0):
    return pymupdf.Rect(
        (value["x"] + inset) * scale,
        (value["y"] + inset) * scale,
        (value["x"] + value["width"] - inset) * scale,
        (value["y"] + value["height"] - inset) * scale,
    )


for index, number in enumerate(range(10001, 10051), start=1):
    filled_id = {10002: "10001", 10004: "10003", 10006: "10005", 10007: ""}.get(number, str(number))
    correct_count = index % 5
    manual_score = 10 + index % 10
    answers = {}
    doc = pymupdf.open(stream=source, filetype="pdf")
    page = doc[0]
    for cell in layout["elements"]:
        if cell["type"] == "student_digit" and filled_id:
            if int(filled_id[cell["digitIndex"]]) == cell["digit"]:
                page.draw_rect(rectangle(cell["rect"], 0.15), color=None, fill=(0.04, 0.04, 0.04), overlay=True)
        elif cell["type"] == "objective_option":
            question = int(cell["questionNumber"])
            expected = "ABCD"[question - 1]
            selected = expected if question <= correct_count else "BCDA"[question - 1]
            answers[str(question)] = selected
            if cell["option"] == selected:
                page.draw_rect(rectangle(cell["rect"], 0.15), color=None, fill=(0.04, 0.04, 0.04), overlay=True)
        elif cell["type"] == "score_cell":
            score = cell["score"]
            if score == 10 or (manual_score % 10 and score == manual_score % 10):
                r = rectangle(cell["rect"])
                page.draw_line(pymupdf.Point(r.x0 - 1, r.y0 + 0.7), pymupdf.Point(r.x1 + 1, r.y1 - 0.7), color=(0.88, 0.02, 0.02), width=1.25, overlay=True)
    # Human-readable physical identity survives an intentionally wrong/blank bubbled ID.
    name_row = layout["studentArea"]["fieldRows"][0]
    page.insert_text(pymupdf.Point((name_row["lineX1"] + 1) * scale, (name_row["lineY"] - 0.8) * scale), f"Student {number}", fontsize=10, color=(0.05, 0.05, 0.05), overlay=True)
    page.insert_text(pymupdf.Point(27 * scale, 126 * scale), f"Solution: x = {index} + 2", fontsize=11, color=(0.05, 0.05, 0.05), overlay=True)
    image = root / "images" / f"答题卡-{number}.png"
    page.get_pixmap(dpi=300, alpha=False).save(str(image))
    manifest.append({
        "physicalStudent": str(number), "bubbledStudent": filled_id, "image": image.name,
        "answers": answers, "objectiveScore": correct_count * 5, "subjectiveScore": manual_score,
        "totalScore": correct_count * 5 + manual_score,
    })
    doc.close()
(root / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
print("Generated 50 images from the application's exported PDF; 3 duplicate pairs and 1 blank ID")
