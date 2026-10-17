/**
 * issue #331 ③ 的行为证据：同一张卡、同一支红笔斜线，只有色彩模式不同。
 *
 * 彩色成像下分数格读成 10 分；把同一张图转成灰度（= 现场选了「灰度/黑白」时扫描仪交来的图）
 * 后，红笔饱和度归零、红笔掩码恒空，该题落到 `no_valid_subjective_score` 并按 0 分计——
 * 而定位标记、二维码、学号与客观题一切正常。这就是「有时读不到、无规律」的机制：
 * 差别不在笔迹，也不在大题划分，而在谁那台机器忘了切彩色。
 * 因此 `npm run verify:scanner-red-pen-colormode` 锁住「含分数格的卡由服务端强制彩色」。
 *
 * Linux x86_64 上用随包的整卡改分识别器（与 CI 同一二进制）；Windows 扫描端用随包识别器。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createDefaultCard } from "../src/shared/defaultCard";
import { buildLayout } from "../src/shared/layout";
import { qrDarkRects } from "../src/shared/cardIdentity";
import { recognizeAnswerCard, recognizeCorrectionCard } from "../src/apps/answer-card/server/recognition";
import type { CombinedRecognitionResult, Rect } from "../src/shared/types";

const STUDENT = "12345";
const SCORED = 10;
const box = (r: Rect, fill: string, stroke = 0) =>
  `<rect x="${r.x}" y="${r.y * 1.02 - 2}" width="${r.width}" height="${r.height * 1.02}" fill="${fill}" stroke="#111" stroke-width="${stroke}"/>`;
// 与 scripts/verify-recognizer-geometry.ts 同一画法：一条贯穿分数格的斜线代表「选这格」。
const slash = (r: Rect) =>
  `<line x1="${r.x - .4}" y1="${(r.y + .2) * 1.02 - 2}" x2="${r.x + r.width + .4}" y2="${(r.y + r.height - .2) * 1.02 - 2}" stroke="red" stroke-width=".45"/>`;

const dir = await mkdtemp(path.join(os.tmpdir(), "projectx-red-pen-"));
try {
  const card = createDefaultCard("91514003");
  card.studentInfo.studentNumberDigits = 5;
  card.bodyBlocks = [{
    id: "objective", type: "objective", title: "客观题", questionStart: 1, questionCount: 1,
    optionCount: 4, mode: "single", scorePerQuestion: 5, density: "normal", answerKey: { 1: ["A"] },
  }, {
    id: "manual", type: "subjective", title: "手阅大题",
    questions: [{ id: "q2", number: 2, score: 30, style: "manual_score_grid", kind: "plain_box", minHeightMm: 30 }],
  }];
  const layout = buildLayout(card);
  const page = layout.pages[0];
  assert.ok(page.elements.some((element) => element.type === "score_cell"), "夹具必须真的生成分数格");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${page.width} ${page.height}">
    <rect width="100%" height="100%" fill="white"/>
    ${page.markers.map((m) => box(m.rect, "black")).join("")}
    ${qrDarkRects(page.header.qrCode).map((r) => box(r, "black")).join("")}
    ${page.elements.flatMap((e) =>
      e.type === "student_digit"
        ? [box(e.rect, Number(STUDENT[e.digitIndex]) === e.digit ? "black" : "white", .15)]
        : e.type === "objective_option"
          ? [box(e.rect, e.option === "A" ? "black" : "white", .15)]
          : e.type === "score_cell"
            ? [box(e.rect, "white", .15), ...(e.score === SCORED ? [slash(e.rect)] : [])]
            : []).join("")}
  </svg>`;

  const width = Math.round(page.width / 25.4 * 300);
  const height = Math.round(page.height / 25.4 * 300);
  const layoutPath = path.join(dir, "layout.json");
  await writeFile(layoutPath, JSON.stringify(layout));

  const raster = async (file: string, grayscale: boolean) => {
    const image = sharp(Buffer.from(svg)).resize(width, height);
    await (grayscale ? image.grayscale() : image).png().toFile(file);
  };

  const run = process.platform === "linux" && process.arch === "x64" ? recognizeCorrectionCard : recognizeAnswerCard;
  const recognize = async (file: string) =>
    (await run({ imagePath: file, layoutPath, pageNumber: 1, dpi: 300 })) as CombinedRecognitionResult;

  const colorFile = path.join(dir, "color.png");
  await raster(colorFile, false);
  const color = await recognize(colorFile);
  assert.equal(color.status, "ok", `彩色扫描应整体识别成功：${color.message ?? ""}`);
  assert.equal(color.studentId?.value, STUDENT, "彩色：定位与学号正常");
  assert.deepEqual(color.questions[0]?.selectedOptions, ["A"], "彩色：客观题正常");
  assert.equal(color.subjectiveQuestions[0]?.status, "ok", "彩色：红笔斜线要读成分数");
  assert.equal(color.subjectiveQuestions[0]?.score, SCORED, `彩色：贯穿分数格的斜线要读成 ${SCORED} 分`);
  assert.ok((color.subjectiveQuestions[0]?.validCells.length ?? 0) > 0, "彩色：必须留下有效分数格");

  const grayFile = path.join(dir, "gray.png");
  await raster(grayFile, true);
  const gray = await recognize(grayFile);
  assert.equal(gray.studentId?.value, STUDENT, "灰度：只是红笔丢了，定位/学号/客观题不受影响");
  assert.deepEqual(gray.questions[0]?.selectedOptions, ["A"], "灰度：客观题照常读取（证明失败面只在红笔）");
  assert.equal(gray.subjectiveQuestions[0]?.score, 0, "灰度：红笔斜线读不到，分数按 0 计");
  assert.equal(gray.subjectiveQuestions[0]?.status, "invalid", "灰度：该题必须留待复核，不能被当成正常的 0 分");
  assert.equal(gray.subjectiveQuestions[0]?.message, "no_valid_subjective_score", "灰度：失败原因要能归因到「没有红笔笔迹」");
  assert.equal(gray.subjectiveQuestions[0]?.validCells.length, 0, "灰度：不该有任何有效分数格");

  console.log(`PASS red pen ${width}x${height}: 彩色读到 ${color.subjectiveQuestions[0]?.score} 分，灰度同一张卡 ${gray.subjectiveQuestions[0]?.score} 分(${gray.subjectiveQuestions[0]?.message})`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
