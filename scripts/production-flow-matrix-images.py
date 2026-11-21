"""Fill and rasterize the actual PDFs exported by the matrix-exams stage."""

import argparse
import json
import os
from pathlib import Path

import pymupdf


def fill_page(page, layout, card_type, number, index):
    answers = {}
    millimetres = 72 / 25.4
    for cell in layout["elements"]:
        rect = cell["rect"]
        x, y, width, height = [rect[key] * millimetres for key in ("x", "y", "width", "height")]
        bounds = pymupdf.Rect(x + 0.5, y + 0.5, x + width - 0.5, y + height - 0.5)
        if cell["type"] == "student_digit":
            digit_index = cell["digitIndex"]
            if digit_index < len(number) and int(number[digit_index]) == cell["digit"]:
                page.draw_rect(bounds, color=None, fill=(0, 0, 0))
        elif cell["type"] == "objective_option":
            question = cell["questionNumber"]
            marked = ("AC", "A", "B", "")[index % 4] if card_type == "A" and question in (5, 6, 7) else "A"
            answers[question] = marked
            if cell["option"] in marked:
                page.draw_rect(bounds, color=None, fill=(0.05,) * 3)
        elif cell["type"] == "score_cell" and card_type == "A" and index % 7 != 6:
            marks = {10: (9, 0.5), 11.1: (10, 6)}
            if cell["score"] in marks.get(float(cell["questionNumber"]), ()):
                page.draw_line((x + 0.45, y + height * 0.85), (x + width - 0.45, y + height * 0.2),
                               color=(1, 0, 0), width=1.1)
    return answers


def write_cards(root, card_type, count, first=10001, output=None):
    directory = root / ("卡型" + card_type)
    destination = output or directory
    images = destination / "images"
    images.mkdir(exist_ok=True, parents=True)
    layouts = json.loads((directory / "layout.json").read_text())["pages"]
    manifest = []
    for index in range(count):
        number = str(first + index)
        with pymupdf.open(directory / "答题卡.pdf") as pdf:
            if len(pdf) != len(layouts):
                raise ValueError(f"PDF and layout page counts differ for {card_type}")
            for page_index, page in enumerate(pdf):
                answers = fill_page(page, layouts[page_index], card_type, number, index)
                page_num = page_index + 1
                page.insert_text((72, 150), f"Synthetic answer {number}, paper {card_type}, page {page_num}", fontsize=8)
                filename = f"{number}-{page_num}.png"
                page.get_pixmap(dpi=300, alpha=False).save(images / filename)
                manifest.append(dict(student=number, page=page_num, image=filename, answers=answers))
    (destination / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    print(f"{card_type}: {count} students, {len(manifest)} pages")


def write_legacy_pages(root):
    directory = root / "卡型C"
    target = directory / "旧卡"
    target.mkdir(exist_ok=True)
    pages = json.loads((directory / "layout.json").read_text())["pages"]
    for index, page in enumerate(pages, 1):
        image = pymupdf.Pixmap(str(directory / "images" / f"10001-{index}.png"))
        code = page["header"]["qrCode"]["rect"]
        sx, sy = image.width / page["width"], image.height / page["height"]
        bounds = pymupdf.IRect(int(code["x"] * sx) - 2, int(code["y"] * sy) - 2,
                               int((code["x"] + code["width"]) * sx) + 3,
                               int((code["y"] + code["height"]) * sy) + 3)
        image.set_rect(bounds, (255,) * image.n)
        image.save(str(target / f"{index}.png"))


if __name__ == "__main__":
    default_root = Path(__file__).resolve().parent.parent / "ignored" / "production-flow"
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=os.environ.get("PROJECTX_FLOW_ROOT", default_root))
    parser.add_argument("--cards", nargs="+", choices=["A", "B", "C"], default=["A", "B", "C"])
    parser.add_argument("--legacy", action="store_true", help="Render copies of the existing three C pages without QR codes")
    parser.add_argument("--roster-extra", action="store_true", help="Render two new duplex papers for the teacher approval page")
    parser.add_argument("--publish-samples", action="store_true", help="Render duplex papers for publication and network checks")
    args = parser.parse_args()
    if args.publish_samples:
        write_cards(args.root, "B", 6, first=10015, output=args.root / "公布策略")
        raise SystemExit(0)
    if args.legacy:
        write_legacy_pages(args.root)
        raise SystemExit(0)
    if args.roster_extra:
        write_cards(args.root, "B", 2, first=10013, output=args.root / "名单外审批")
        raise SystemExit(0)
    for name in args.cards:
        write_cards(args.root, name, {"A": 50, "B": 12, "C": 3}[name])
