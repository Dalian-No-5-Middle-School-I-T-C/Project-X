import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createDefaultCard } from "../src/shared/defaultCard";
import { buildLayout } from "../src/shared/layout";
import { qrDarkRects } from "../src/shared/cardIdentity";
import { gradeSubjectiveRecognition } from "../src/shared/grading";
import { recognizeAnswerCard } from "../src/apps/answer-card/server/recognition";
import type { CombinedRecognitionResult, Rect } from "../src/shared/types";

// Synthetic cards exercise the real native recognizer and grading consumer.
// Real server scans remain local investigation data, outside the repository.
type Stroke = "line" | "broken" | "thin" | "horizontal" | "black" | "short" | "one-ended" | "grazing" | "cross" | "parallel" | "dots";
const cases: Array<{ name: string; marks: Array<[number, Stroke]>; expected: number | null; max?: number }> = [
  { name: "tens plus ones", marks: [[20, "line"], [8, "line"]], expected: 28 },
  { name: "printed digit interrupts pen", marks: [[20, "line"], [8, "broken"]], expected: 28 },
  { name: "thin scanned pen", marks: [[20, "thin"], [8, "thin"]], expected: 28 },
  { name: "horizontal pen", marks: [[30, "horizontal"]], expected: 30 },
  { name: "ones plus half", marks: [[8, "line"], [.5, "broken"]], expected: 8.5 },
  { name: "explicit zero", marks: [[0, "broken"]], expected: 0 },
  { name: "blank grid", marks: [], expected: null },
  { name: "black pen", marks: [[20, "black"], [8, "black"]], expected: null },
  { name: "short ones cannot disappear", marks: [[20, "line"], [8, "short"]], expected: null },
  { name: "stroke stops inside cell", marks: [[20, "line"], [8, "one-ended"]], expected: null },
  { name: "stroke only grazes cell edge", marks: [[20, "line"], [8, "grazing"]], expected: null },
  { name: "cross cannot disappear", marks: [[20, "line"], [8, "cross"]], expected: null },
  { name: "parallel strokes", marks: [[20, "line"], [8, "parallel"]], expected: null },
  { name: "distant dots", marks: [[20, "line"], [8, "dots"]], expected: null },
  { name: "multiple ones", marks: [[20, "line"], [8, "broken"], [7, "line"]], expected: null },
  { name: "multiple tens", marks: [[30, "line"], [20, "broken"]], expected: null },
  { name: "score exceeds maximum", marks: [[30, "line"], [9, "line"]], expected: null },
  { name: "small score plus half", marks: [[12, "broken"], [.5, "line"]], expected: 12.5, max: 15 },
];
const box = (r: Rect, fill: string) => `<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" fill="${fill}"/>`;
function stroke(r: Rect, kind: Stroke): string {
  const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
  const line = (x1: number, y1: number, x2: number, y2: number, width = .2, color = "#d02040") =>
    `<path d="M${x1},${y1} L${x2},${y2}" fill="none" stroke="${color}" stroke-width="${width}"/>`;
  const slash = (offset = 0, width = .2, color = "#d02040") => line(cx - .8 + offset, r.y + r.height + .3, cx + .8 + offset, r.y - .3, width, color);
  switch (kind) {
    case "line": return slash();
    case "thin": return slash(0, .10);
    case "black": return slash(0, .2, "#111");
    case "horizontal": return line(r.x - .2, cy, r.x + r.width + .2, cy);
    case "broken": return slash() + box({ x: r.x, y: cy - .35, width: r.width, height: .7 }, "#111");
    case "short": return line(cx - .2, cy + .45, cx + .2, cy - .45, .4);
    case "one-ended": return line(r.x + r.width * .31, cy, r.x + r.width + .3, cy);
    case "grazing": return line(r.x - 1.2, r.y + r.height + .3, r.x + 1.3, r.y - .3);
    case "cross": return slash() + line(cx - .8, r.y - .3, cx + .8, r.y + r.height + .3);
    case "parallel": return slash(-.65) + slash(.65);
    case "dots": return [r.y + .25, r.y + r.height - .25].map(y => `<circle cx="${cx}" cy="${y}" r=".32" fill="#d02040"/>`).join("");
  }
}

const dir = await mkdtemp(path.join(os.tmpdir(), "projectx-red-line-"));
try {
  const card = createDefaultCard("90000019", "Red pen regression");
  card.bodyBlocks = [{ id: "red-pen", type: "subjective", blockKind: "answer", title: "Score grids",
    questions: cases.map((test, i) => ({ id: `red-${i}`, number: i + 1, score: test.max ?? 35,
      style: "manual_score_grid", kind: "plain_box", minHeightMm: 18, images: [] })) }];
  const layout = buildLayout(card), layoutPath = path.join(dir, "layout.json");
  await writeFile(layoutPath, JSON.stringify(layout));
  for (const dpi of [150, 300]) {
    let checked = 0;
    for (const page of layout.pages) {
      const questions = page.blocks.flatMap(b => b.type === "subjective" ? b.questions : []);
      const grids = questions.map(q => q.scoreCells.map(c => {
        const r = c.rect;
        const printed = box(r, "#fff") + `<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" fill="none" stroke="#111" stroke-width=".15"/>` +
          `<text x="${r.x + r.width / 2}" y="${r.y + r.height * .75}" text-anchor="middle" font-family="Arial" font-size="2.6">${c.score ?? ""}</text>`;
        const mark = cases[Number(q.questionNumber) - 1].marks.find(([score]) => c.score === score);
        return printed + (mark ? stroke(r, mark[1]) : "");
      }).join("")).join("");
      const digits = (page.studentArea?.digitCells ?? []).filter(c => c.digit === 2).map(c => box(c.rect, "#111")).join("");
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${page.width} ${page.height}">${box({ x: 0, y: 0, width: page.width, height: page.height }, "#fff")}${page.markers.map(m => box(m.rect, "#111")).join("")}${qrDarkRects(page.header.qrCode).map(r => box(r, "#111")).join("")}${digits}${grids}</svg>`;
      const imagePath = path.join(dir, `red-${dpi}-${page.pageNumber}.jpg`);
      await sharp(Buffer.from(svg)).resize(Math.round(page.width / 25.4 * dpi), Math.round(page.height / 25.4 * dpi)).jpeg({ quality: 85 }).toFile(imagePath);
      const result = await recognizeAnswerCard({ imagePath, layoutPath, pageNumber: page.pageNumber, dpi }) as CombinedRecognitionResult & {
        output?: { dpi: number; widthPx: number; heightPx: number };
      };
      assert.equal(result.output?.dpi, dpi, "native output must use the requested scan DPI");
      assert.equal(result.output?.widthPx, Math.round(page.width / 25.4 * dpi));
      assert.equal(result.output?.heightPx, Math.round(page.height / 25.4 * dpi));
      assert.notEqual(result.status, "failed", result.message);
      assert.equal(result.subjectiveQuestions.length, questions.length);
      for (const recognition of result.subjectiveQuestions) {
        const test = cases[Number(recognition.questionNumber) - 1];
        const context = `${test.name}, ${dpi} DPI: ${JSON.stringify(recognition)}`;
        assert.equal(recognition.status, test.expected === null ? "invalid" : "ok", context);
        assert.equal(recognition.score, test.expected ?? 0, context);
        const grade = gradeSubjectiveRecognition(card, recognition)!;
        assert.equal(grade.needsReview, test.expected === null, context);
        assert.equal(grade.score, test.expected ?? 0, context);
        ++checked;
      }
    }
    assert.equal(checked, cases.length);
    console.log(`PASS ${checked} native red pen and grading cases at ${dpi} DPI`);
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
