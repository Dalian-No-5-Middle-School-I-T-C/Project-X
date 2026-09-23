import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createDefaultCard } from "../src/shared/defaultCard";
import { buildLayout } from "../src/shared/layout";
import { qrDarkRects } from "../src/shared/cardIdentity";
import { recognizeAnswerCard } from "../src/apps/answer-card/server/recognition";
import type { CombinedRecognitionResult, Rect } from "../src/shared/types";

// Printed glyphs inside a uniform pencil fill must not become the only pixels
// counted as ink by per-cell Otsu. Do not commit real student scans as fixtures.
const box = (r: Rect, fill: string) => `<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" fill="${fill}"/>`;
const cell = (r: Rect, label: string, filled: boolean) =>
  box(r, filled ? "url(#pencil)" : "#fff") +
  `<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" fill="none" stroke="#111" stroke-width="0.15"/>` +
  `<text x="${r.x + r.width / 2}" y="${r.y + r.height * .75}" text-anchor="middle" font-size="${r.height * .75}" font-family="Arial" fill="#111">${label}</text>`;
const dir = await mkdtemp(path.join(os.tmpdir(), "projectx-pencil-"));
try {
  const card = createDefaultCard("90000009", "Pencil regression");
  card.bodyBlocks = [{ id: "pencil", type: "objective", title: "Pencil", questionStart: 1,
    questionCount: 4, optionCount: 3, mode: "single", scorePerQuestion: 1, density: "compact" }];
  const layout = buildLayout(card), page = layout.pages[0];
  const layoutPath = path.join(dir, "layout.json");
  await writeFile(layoutPath, JSON.stringify(layout));
  for (const gray of [100, 140, 160]) {
    for (const studentMode of ["valid", "blank", "multiple"] as const) {
      const student = (page.studentArea?.digitCells ?? []).map(c => cell(c.rect, String(c.digit),
        studentMode !== "blank" && (c.digit === Number("24237"[c.digitIndex]) || (studentMode === "multiple" && c.digitIndex === 0 && c.digit === 4)))).join("");
      const options = page.blocks.flatMap(b => b.type === "objective" ? b.items : []).map(q =>
        q.options.map(o => cell(o.rect, o.label, ({ 1: ["A"], 2: ["C"], 3: [], 4: ["A", "B"] } as Record<number, string[]>)[q.questionNumber].includes(o.label))).join("")).join("");
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${page.width} ${page.height}">
        <defs><linearGradient id="pencil"><stop stop-color="rgb(${gray - 10},${gray - 10},${gray - 10})"/><stop offset="1" stop-color="rgb(${gray + 10},${gray + 10},${gray + 10})"/></linearGradient></defs>
        ${box({ x: 0, y: 0, width: page.width, height: page.height }, "#fff")}
        ${page.markers.map(m => box(m.rect, "#000")).join("")}
        ${qrDarkRects(page.header.qrCode).map(r => box(r, "#000")).join("")}${student}${options}</svg>`;
      const imagePath = path.join(dir, `pencil-${gray}-${studentMode}.jpg`);
      await sharp(Buffer.from(svg)).resize(Math.round(page.width / 25.4 * 150), Math.round(page.height / 25.4 * 150))
        .jpeg({ quality: 85 }).toFile(imagePath);
      const result = await recognizeAnswerCard({ imagePath, layoutPath, pageNumber: 1, dpi: 300 }) as CombinedRecognitionResult;
      assert.equal(result.identity?.status, "verified");
      if (studentMode !== "valid") {
        assert.equal(result.studentId?.status, "failed", "Blank or multiple student digits must remain rejected");
        assert.equal(result.status, "failed");
      } else {
        assert.equal(result.studentId?.value, "24237");
        assert.equal(result.status, "ok");
      }
      assert.deepEqual(result.questions.map(q => q.selectedOptions), [["A"], ["C"], [], ["A", "B"]], "Pencil, blank and multiple marks");
      console.log(`PASS pencil gray=${gray}, studentMode=${studentMode}`);
    }
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
