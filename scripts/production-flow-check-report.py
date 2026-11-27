"""Verify the individual report actually printed by Edge during teacher-print."""

import argparse
import re
from pathlib import Path

import pymupdf

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("pdf", type=Path)
parser.add_argument("--student", required=True)
parser.add_argument("--total", required=True)
parser.add_argument("--rank", required=True)
args = parser.parse_args()

with pymupdf.open(args.pdf) as document:
    if len(document) != 1:
        raise ValueError(f"Expected one A4 page, got {len(document)}")
    page = document[0]
    if abs(page.rect.width - 595) > 2 or abs(page.rect.height - 842) > 2:
        raise ValueError(f"Unexpected page dimensions {page.rect}")
    text = re.sub(r"\s+", "", page.get_text())
    for expected in ("成绩报告单", args.student, "总分" + args.total + "分", args.rank):
        if expected not in text:
            raise ValueError(f"Missing printed content: {expected}")
    print(f"Verified A4 report, {args.student}, {args.total} points, {args.rank}")
