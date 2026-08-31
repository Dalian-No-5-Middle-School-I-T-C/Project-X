import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { createDefaultCard } from "../src/shared/defaultCard";
import { buildLayout } from "../src/shared/layout";
import type { CombinedRecognitionResult, ObjectiveBlock, Rect } from "../src/shared/types";
import { recognizeAnswerCard, resolveRecognizerExe } from "../src/apps/answer-card/server/recognition";

const SCALE_Y = 1.0545;
const OFFSET_Y_MM = -10.03;

function objectiveBlock(): ObjectiveBlock {
  return {
    id: "obj_layout_verify",
    type: "objective",
    title: "客观题",
    questionStart: 1,
    questionCount: 1,
    optionCount: 4,
    mode: "single",
    scorePerQuestion: 1,
    density: "compact",
    questions: [{ questionNumber: 1, optionCount: 4, mode: "single", score: 1 }]
  };
}

function distort(value: Rect): Rect {
  return {
    x: value.x,
    y: value.y * SCALE_Y + OFFSET_Y_MM,
    width: value.width,
    height: value.height * SCALE_Y
  };
}

function svgRect(value: Rect, fill: string, stroke = "#111", strokeWidth = 0.18): string {
  return `<rect x="${value.x}" y="${value.y}" width="${value.width}" height="${value.height}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`;
}

async function main(): Promise<void> {
  resolveRecognizerExe();
  const card = createDefaultCard("90000002", "recognizer-test");
  card.bodyBlocks = [objectiveBlock()];
  const layout = buildLayout(card);
  const page = layout.pages[0];
  const studentNumber = "82048";

  const markers = page.markers
    .filter((marker) => marker.role !== "middle-right")
    .map((marker) => svgRect(distort(marker.rect), "#000", "#000", 0))
    .join("");
  const digits = (page.studentArea?.digitCells ?? [])
    .map((cell) => svgRect(distort(cell.rect), Number(studentNumber[cell.digitIndex]) === cell.digit ? "#000" : "#fff"))
    .join("");
  const options = page.blocks
    .flatMap((block) => block.type === "objective" ? block.items : [])
    .flatMap((item) => item.options.map((option) => svgRect(distort(option.rect), option.label === "A" ? "#000" : "#fff")))
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${page.width} ${page.height}"><rect width="100%" height="100%" fill="#fff"/>${markers}${digits}${options}</svg>`;

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "projectx-recognizer-layout-"));
  try {
    const layoutPath = path.join(tempDir, "layout.json");
    const imagePath = path.join(tempDir, "distorted.png");
    await writeFile(layoutPath, JSON.stringify(layout), "utf8");
    await sharp(Buffer.from(svg))
      .resize(Math.round(page.width / 25.4 * 300), Math.round(page.height / 25.4 * 300))
      .png()
      .toFile(imagePath);

    const result = await recognizeAnswerCard({ imagePath, layoutPath, pageNumber: 1, dpi: 300 }) as CombinedRecognitionResult;
    assert.equal(result.status, "partial", result.message ?? "缺一个定位标记时应降级为 partial");
    assert.equal(result.studentId?.value, studentNumber, "纵向偏移和拉伸校正后学号应保持正确");
    assert.deepEqual(result.questions[0]?.selectedOptions, ["A"], "纵向偏移和拉伸校正后客观题应保持正确");
    assert.deepEqual(result.quality?.missingRoles, ["middle-right"], "应准确报告缺失的中右定位标记");
    console.log("识别器版式归一化验证通过：纵向拉伸 5.45%、顶部上移约 105px、缺 middle-right 时仍正确识别。");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
