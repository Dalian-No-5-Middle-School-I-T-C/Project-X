import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { createDefaultCard } from "../src/shared/defaultCard";
import { buildLayout } from "../src/shared/layout";
import type { AnswerCard, ObjectiveBlock, Rect, SubjectiveBlock } from "../src/shared/types";
import { createPdf } from "../src/apps/answer-card/server/pdf";
import { mapScanPageToLayout } from "../src/apps/answer-card/server/scanner/scanner-service";
import { recognizeAnswerCard, resolveRecognizerExe } from "../src/apps/answer-card/server/recognition";
import type { CombinedRecognitionResult, LayoutDocument } from "../src/shared/types";

function objectiveBlock(questionCount: number): ObjectiveBlock {
  return {
    id: "obj_a3_verify",
    type: "objective",
    title: "客观题",
    questionStart: 1,
    questionCount,
    optionCount: 4,
    mode: "single",
    scorePerQuestion: 1,
    density: "compact",
    questions: Array.from({ length: questionCount }, (_, index) => ({
      questionNumber: index + 1,
      optionCount: 4,
      mode: "single" as const,
      score: 1
    }))
  };
}

function subjectiveBlock(score: number, minHeightMm = 34): SubjectiveBlock {
  return {
    id: `subj_${score}_${minHeightMm}`,
    type: "subjective",
    blockKind: "answer",
    title: "解答题",
    questions: [{
      id: `subj_q_${score}_${minHeightMm}`,
      number: 1,
      score,
      style: "manual_score_grid",
      kind: "lined_answer",
      minHeightMm,
      lineGrid: { enabled: true, lineSpacingMm: 8 },
      images: []
    }]
  };
}

function makeCard(size: "A4" | "A3", questionCount: number): AnswerCard {
  const card = createDefaultCard(size === "A3" ? "30000001" : "40000001", "wuli", size);
  card.title = `${size} 验证答题卡`;
  card.bodyBlocks = [objectiveBlock(questionCount)];
  return card;
}

function contains(outer: Rect, inner: Rect, tolerance = 0.002): boolean {
  return inner.x >= outer.x - tolerance &&
    inner.y >= outer.y - tolerance &&
    inner.x + inner.width <= outer.x + outer.width + tolerance &&
    inner.y + inner.height <= outer.y + outer.height + tolerance;
}

function panelIndexForRect(page: ReturnType<typeof buildLayout>["pages"][number], value: Rect): number {
  return page.panels.findIndex((panel) => contains(panel.rect, value));
}

async function pdfBuffer(card: AnswerCard): Promise<Buffer> {
  const doc = createPdf(card);
  const chunks: Buffer[] = [];
  return await new Promise((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}

function syntheticSvg(layout: LayoutDocument, studentNumber: string): string {
  const page = layout.pages[0];
  const rectSvg = (value: Rect, fill: string, stroke = "#111", strokeWidth = 0.18) =>
    `<rect x="${value.x}" y="${value.y}" width="${value.width}" height="${value.height}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`;
  const markers = page.markers.map((marker) => rectSvg(marker.rect, "#000", "#000", 0)).join("");
  const digits = (page.studentArea?.digitCells ?? []).map((cell) =>
    rectSvg(cell.rect, Number(studentNumber[cell.digitIndex]) === cell.digit ? "#000" : "#fff")
  ).join("");
  const options = page.blocks.flatMap((block) => block.type === "objective" ? block.items : [])
    .flatMap((item) => item.options.map((option) => rectSvg(option.rect, option.label === "A" ? "#000" : "#fff")))
    .join("");
  const scoreMarks = page.blocks.flatMap((block) => block.type === "subjective" ? block.questions : [])
    .flatMap((question) => question.scoreCells)
    .filter((cell) => cell.score === 4)
    .map((cell) => `<line x1="${cell.rect.x + 0.35}" y1="${cell.rect.y + 0.35}" x2="${cell.rect.x + cell.rect.width - 0.35}" y2="${cell.rect.y + cell.rect.height - 0.35}" stroke="#e00000" stroke-width="0.5" stroke-linecap="round"/>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${page.width} ${page.height}" width="${page.width}mm" height="${page.height}mm"><rect width="100%" height="100%" fill="#fff"/>${markers}${digits}${options}${scoreMarks}</svg>`;
}

async function verifyNativeRotations(card: AnswerCard, layout: LayoutDocument): Promise<void> {
  resolveRecognizerExe();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "projectx-a3-native-"));
  try {
    const layoutFile = path.join(tempDir, "layout.json");
    const baseImage = path.join(tempDir, "base.png");
    await writeFile(layoutFile, JSON.stringify(layout), "utf8");
    await sharp(Buffer.from(syntheticSvg(layout, "12345")))
      .resize(Math.round(420 / 25.4 * 300), Math.round(297 / 25.4 * 300))
      .png()
      .toFile(baseImage);

    for (const rotation of [0, 90, 180, 270]) {
      const imagePath = path.join(tempDir, `rotated-${rotation}.png`);
      await sharp(baseImage).rotate(rotation).png().toFile(imagePath);
      const result = await recognizeAnswerCard({ imagePath, layoutPath: layoutFile, pageNumber: 1, dpi: 300 }) as CombinedRecognitionResult;
      assert.notEqual(result.status, "failed", `原生识别器未能识别旋转 ${rotation}° 的 A3 图像：${result.message ?? ""}`);
      assert.equal(result.studentId?.value, "12345", `旋转 ${rotation}° 后学号识别错误`);
      assert.deepEqual(result.questions[0]?.selectedOptions, ["A"], `旋转 ${rotation}° 后客观题识别错误`);
      assert.equal(result.subjectiveQuestions[0]?.score, 4, `旋转 ${rotation}° 后主观题分数识别错误`);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function verifyPersistence(): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "projectx-a3-db-"));
  const previousDbPath = process.env.PROJECTX_DB_PATH;
  process.env.PROJECTX_DB_PATH = path.join(tempDir, "verify.db");
  const { initializeDatabase, closeDatabase } = await import("../src/server/db/index");
  const { CardRepository } = await import("../src/server/repositories/CardRepository");
  try {
    initializeDatabase();
    const repository = new CardRepository();
    const card = makeCard("A3", 8);
    await repository.createCard(card);
    await repository.updateCard(card);
    const savedA3 = await repository.findById(card.id);
    assert.deepEqual(savedA3?.paper, { size: "A3", orientation: "landscape" });
    assert.equal(savedA3?.layoutVersion, 2);

    card.paper = { size: "A4", orientation: "portrait" };
    await repository.updateCard(card);
    const savedA4 = await repository.findById(card.id);
    assert.deepEqual(savedA4?.paper, { size: "A4", orientation: "portrait" });
  } finally {
    closeDatabase();
    if (previousDbPath === undefined) delete process.env.PROJECTX_DB_PATH;
    else process.env.PROJECTX_DB_PATH = previousDbPath;
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const a3 = makeCard("A3", 600);
  const a3Layout = buildLayout(a3);
  assert.equal(a3Layout.width, 420);
  assert.equal(a3Layout.height, 297);
  assert.ok(a3Layout.pages.length >= 2, "600 道客观题应跨越至少两张 A3");

  const firstPanels = a3Layout.pages[0].panels;
  assert.equal(firstPanels.length, 3);
  assert.deepEqual(firstPanels.map((panel) => panel.role), ["left", "middle", "right"]);
  firstPanels.forEach((panel) => assert.ok(Math.abs(panel.rect.width - 123.333) < 0.002));
  assert.ok(Math.abs(firstPanels[1].rect.x - (firstPanels[0].rect.x + firstPanels[0].rect.width) - 8) < 0.002);
  assert.ok(Math.abs(firstPanels[2].rect.x - (firstPanels[1].rect.x + firstPanels[1].rect.width) - 8) < 0.002);

  assert.ok(a3Layout.pages[0].studentArea, "第一页左版必须包含考生信息区");
  assert.ok(contains(firstPanels[0].rect, a3Layout.pages[0].studentArea!.infoRect));
  assert.ok(contains(firstPanels[0].rect, a3Layout.pages[0].studentArea!.digitRect));
  assert.equal(a3Layout.pages[0].studentArea!.infoRect.y, a3Layout.pages[0].studentArea!.digitRect.y, "A3 姓名区与填涂号区必须左右并排");
  assert.equal(
    a3Layout.pages[0].studentArea!.digitRect.x - (a3Layout.pages[0].studentArea!.infoRect.x + a3Layout.pages[0].studentArea!.infoRect.width),
    4,
    "A3 姓名区与填涂号区之间应保留 4 mm 间隔"
  );
  assert.equal(a3Layout.pages.slice(1).some((page) => Boolean(page.studentArea)), false);

  let previousRegion = -1;
  for (const page of a3Layout.pages) {
    for (const block of page.blocks) {
      const panelIndex = panelIndexForRect(page, block.rect);
      assert.notEqual(panelIndex, -1, `题块越出版面：${JSON.stringify(block.rect)}`);
      const region = (page.pageNumber - 1) * 3 + panelIndex;
      assert.ok(region >= previousRegion, "题块必须按左、中、右、下一页顺序流动");
      previousRegion = region;
    }
  }

  assert.deepEqual(a3Layout.pages[0].markers.map((marker) => marker.rect.height), [7, 7, 5.5, 5.5, 9, 9]);

  const a4Layout = buildLayout(makeCard("A4", 1));
  assert.equal(a4Layout.width, 210);
  assert.equal(a4Layout.height, 297);
  assert.equal(a4Layout.pages[0].panels.length, 1);
  assert.deepEqual(a4Layout.pages[0].studentArea?.infoRect, { x: 17, y: 48, width: 66, height: 31 });
  assert.equal(a4Layout.pages[0].blocks[0].rect.x, 17);
  assert.equal(a4Layout.pages[0].blocks[0].rect.width, 176);
  assert.deepEqual(a4Layout.pages[0].markers.map((marker) => marker.rect.height), [7, 7, 7, 7, 7, 7]);

  const v1Card = makeCard("A4", 0);
  v1Card.layoutVersion = 1;
  v1Card.bodyBlocks = [subjectiveBlock(4)];
  const v1Question = buildLayout(v1Card).pages[0].blocks.find((block) => block.type === "subjective")?.questions[0];
  assert.deepEqual(v1Question?.rect, { x: 17, y: 92, width: 176, height: 26 });
  assert.deepEqual(v1Question?.scoreCells[0]?.rect, { x: 145.4, y: 93.6, width: 6.8, height: 6 });
  assert.equal(v1Question?.lineYs.length, 0, "V1 必须保留旧版首题高度与横线坐标");

  for (const size of ["A4", "A3"] as const) {
    for (const score of [4, 16, 60]) {
      const card = makeCard(size, 0);
      card.bodyBlocks = [subjectiveBlock(score)];
      const layout = buildLayout(card);
      const question = layout.pages[0].blocks.find((block) => block.type === "subjective")?.questions[0];
      assert.ok(question && question.scoreCells.length > 0);
      question.scoreCells.forEach((cell) => {
        assert.equal(cell.rect.width, 5);
        assert.equal(cell.rect.height, 4);
        assert.ok(contains(layout.pages[0].panels[0].rect, cell.rect), `${size} ${score} 分格越出版面`);
      });
    }
  }

  const v2LineCard = makeCard("A3", 0);
  v2LineCard.bodyBlocks = [subjectiveBlock(8, 34)];
  const v2ThreeLines = buildLayout(v2LineCard).pages[0].blocks.find((block) => block.type === "subjective")?.questions[0];
  assert.equal(v2ThreeLines?.lineYs.length, 3, "V2 34mm/8mm 应提供 3 行作答线");
  assert.equal(v2ThreeLines?.lineYs[0], (v2ThreeLines?.rect.y ?? 0) + 14, "V2 分数题首条作答线应下移到题框顶部 14mm");
  assert.equal(v2ThreeLines?.lineYs[0], (v2ThreeLines?.contentRect.y ?? 0) + 8, "V2 首条作答线与分数区分割线应相距 8mm");
  v2LineCard.bodyBlocks = [subjectiveBlock(8, 62)];
  const v2SixLines = buildLayout(v2LineCard).pages[0].blocks.find((block) => block.type === "subjective")?.questions[0];
  assert.equal(v2SixLines?.lineYs.length, 6, "V2 62mm/8mm 应提供 6 行作答线");

  const zeroScoreCard = makeCard("A3", 0);
  zeroScoreCard.bodyBlocks = [subjectiveBlock(0)];
  const zeroScoreLayout = buildLayout(zeroScoreCard);
  const zeroScoreQuestion = zeroScoreLayout.pages[0].blocks.find((block) => block.type === "subjective")?.questions[0];
  assert.equal(zeroScoreQuestion?.scoreCells.length, 0);
  assert.ok(zeroScoreLayout.warnings.some((warning) => warning.includes("分值为 0")));

  const a3Pdf = await pdfBuffer(makeCard("A3", 1));
  const mediaBoxes = [...a3Pdf.toString("latin1").matchAll(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)/g)];
  assert.ok(mediaBoxes.length > 0, "A3 PDF 应包含 MediaBox");
  assert.ok(Math.abs(Number(mediaBoxes[0][1]) - 420 / 25.4 * 72) < 0.1);
  assert.ok(Math.abs(Number(mediaBoxes[0][2]) - 297 / 25.4 * 72) < 0.1);

  assert.deepEqual(mapScanPageToLayout(1, "front", 1, "single"), { groupIndex: 0, layoutPage: 1, unusedSide: false });
  assert.deepEqual(mapScanPageToLayout(2, "front", 1, "single"), { groupIndex: 1, layoutPage: 1, unusedSide: false });
  assert.deepEqual(mapScanPageToLayout(1, "back", 3, "double"), { groupIndex: 0, layoutPage: 2, unusedSide: false });
  assert.deepEqual(mapScanPageToLayout(2, "front", 3, "double"), { groupIndex: 0, layoutPage: 3, unusedSide: false });
  assert.deepEqual(mapScanPageToLayout(2, "back", 3, "double"), { groupIndex: 0, layoutPage: 4, unusedSide: true });
  assert.deepEqual(mapScanPageToLayout(3, "front", 3, "double"), { groupIndex: 1, layoutPage: 1, unusedSide: false });

  const nativeCard = makeCard("A3", 1);
  nativeCard.bodyBlocks.push(subjectiveBlock(4));
  await verifyNativeRotations(nativeCard, buildLayout(nativeCard));
  await verifyPersistence();

  console.log(`A3 verification passed: ${a3Layout.pages.length} pages, 3 panels/page, native A3 PDF and 4-way recognition.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
