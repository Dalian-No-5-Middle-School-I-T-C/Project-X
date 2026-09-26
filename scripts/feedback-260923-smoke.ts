/**
 * 2026-09-23 问题反馈的排版回归：
 * - 第 4、5 条：作文格一行只占一栏宽（A3 三等分），填满一栏再往下换行，不再横跨三栏压住其他题块
 * - 第 6 条：客观题横排一行 4 题，选项按列宽自适应、不与相邻题目串位
 * - 第 3 条：解答题横线上方可以加注记文字，且支持 **加粗** / *斜体*
 */
import assert from "node:assert/strict";
import { createDefaultCard } from "../src/shared/defaultCard";
import { buildLayout } from "../src/shared/layout";
import { isAutoBlockTitle } from "../src/apps/answer-card/client/cardModel";
import { parseRichText, richTextPlain, sliceRichText } from "../src/shared/richText";
import type { AnswerCard, ObjectiveBlock, Rect, SubjectiveBlock } from "../src/shared/types";

const PANEL_WIDTH = (420 - 17 * 2 - 8 * 2) / 3;

function contains(outer: Rect, inner: Rect, tolerance = 0.01): boolean {
  return inner.x >= outer.x - tolerance &&
    inner.y >= outer.y - tolerance &&
    inner.x + inner.width <= outer.x + outer.width + tolerance &&
    inner.y + inner.height <= outer.y + outer.height + tolerance;
}

function overlaps(a: Rect, b: Rect, tolerance = 0.01): boolean {
  return a.x < b.x + b.width - tolerance &&
    b.x < a.x + a.width - tolerance &&
    a.y < b.y + b.height - tolerance &&
    b.y < a.y + a.height - tolerance;
}

function baseCard(): AnswerCard {
  const card = createDefaultCard("86100001", "yuwen", "A3");
  card.title = "反馈验证卡";
  return card;
}

function objectiveBlock(questionCount: number): ObjectiveBlock {
  return {
    id: "obj_feedback",
    type: "objective",
    title: "一、单选（共10题，共50分）",
    questionStart: 1,
    questionCount,
    optionCount: 4,
    mode: "single",
    scorePerQuestion: 5,
    density: "compact",
    optionLayout: "horizontal",
    questions: Array.from({ length: questionCount }, (_, index) => ({
      questionNumber: index + 1,
      optionCount: 4,
      mode: "single" as const,
      score: 5
    }))
  };
}

function essayBlock(targetChars: number): SubjectiveBlock {
  return {
    id: "essay_feedback",
    type: "subjective",
    blockKind: "essay",
    title: "二、作文（共1题，共60分）",
    questions: [{
      id: "essay_q1",
      number: 1,
      score: 60,
      style: "plain_subjective",
      kind: "plain_box",
      minHeightMm: 60,
      essayGrid: {
        columns: 0,
        rows: 0,
        cellWidthMm: 7,
        cellHeightMm: 7,
        targetChars,
        showTitle: true,
        lineColor: "#c00000",
        lineWidthMm: 0.15,
        showFrame: true,
        showWordScale: true
      },
      images: []
    }]
  };
}

function answerBlock(annotation: string, minHeightMm = 34): SubjectiveBlock {
  return {
    id: "answer_feedback",
    type: "subjective",
    blockKind: "answer",
    title: "三、解答题（共1题，共12分）",
    questions: [{
      id: "answer_q1",
      number: 1,
      score: 12,
      style: "manual_score_grid",
      kind: "lined_answer",
      annotation,
      minHeightMm,
      lineGrid: { enabled: true, lineSpacingMm: 8 },
      images: []
    }]
  };
}

function verifyBlockTitleEditability(): void {
  assert.equal(isAutoBlockTitle(""), true, "空标题由自动命名接管");
  assert.equal(isAutoBlockTitle("客观题"), true, "新建默认名由自动命名接管");
  assert.equal(isAutoBlockTitle("三、解答题（共1题，共12分）"), true, "上一轮自动标题可继续跟随题量/分值刷新");
  assert.equal(isAutoBlockTitle("一、单选（共3题，共7.5分）"), true, "自动生成的小数总分标题必须继续跟随刷新");
  assert.equal(isAutoBlockTitle("第一部分 现代文阅读"), false, "人工改过的标题必须保留，不被自动命名覆盖");
  assert.equal(isAutoBlockTitle("三、解答题（共1题，共12分）补充"), false, "人工追加文字的标题必须保留");
}

function verifyRichTextParsing(): void {
  assert.deepEqual(parseRichText("**加粗**"), [{ text: "加粗", bold: true, italic: false }]);
  assert.deepEqual(parseRichText("*斜体*"), [{ text: "斜体", bold: false, italic: true }]);
  assert.deepEqual(parseRichText("***两者***"), [{ text: "两者", bold: true, italic: true }]);
  assert.equal(richTextPlain("2*3=6"), "2*3=6", "未成对的 * 必须按普通字符保留");
  assert.equal(richTextPlain("**续写要求**：至少 *80* 词"), "续写要求：至少 80 词");
  assert.equal(richTextPlain("a**b"), "a**b", "未成对的 ** 必须按普通字符保留");
  // 折行时按纯文本下标切片，行首行尾的标记样式必须跟随
  assert.deepEqual(sliceRichText("**续写要求**：至少 *80* 词", 0, 4), [{ text: "续写要求", bold: true, italic: false }]);
  assert.deepEqual(sliceRichText("**续写要求**：至少 *80* 词", 8, 10), [{ text: "80", bold: false, italic: true }]);
}

function verifyEssayGridStaysInOnePanel(): void {
  const card = baseCard();
  card.bodyBlocks = [essayBlock(100), objectiveBlock(8)];
  const layout = buildLayout(card);

  const essayBlocks = layout.pages.flatMap((page) => page.blocks)
    .filter((block) => block.type === "subjective" && block.blockId === "essay_feedback");
  assert.ok(essayBlocks.length > 0, "作文块必须至少占据一栏");

  let producedCells = 0;
  for (const block of essayBlocks) {
    assert.ok(Math.abs(block.rect.width - PANEL_WIDTH) < 0.002, `作文格必须只占一栏宽，实际 ${block.rect.width}`);
    const page = layout.pages.find((item) => item.blocks.includes(block))!;
    assert.notEqual(
      page.panels.findIndex((panel) => contains(panel.rect, block.rect)),
      -1,
      "作文格必须完整落在某一栏内（一行不跨三栏）"
    );
    const columns = Math.floor((block.rect.width - 8) / 7);
    const rows = Math.floor((block.rect.height - (9 + 2) + 1.6) / (7 + 1.6));
    producedCells += columns * rows;
  }
  assert.ok(producedCells >= 100, `作文格总数应不少于目标字数，实际 ${producedCells}`);

  // 第 5 条：作文格不得与其他题块重叠
  for (const page of layout.pages) {
    const essays = page.blocks.filter((block) => block.type === "subjective" && block.blockId === "essay_feedback");
    for (const essay of essays) {
      for (const other of page.blocks) {
        if (other.blockId === "essay_feedback") continue;
        assert.equal(
          overlaps(essay.rect, other.rect),
          false,
          `作文格与 ${other.type} ${other.blockId} 重叠：${JSON.stringify(essay.rect)} / ${JSON.stringify(other.rect)}`
        );
      }
    }
  }
}

function verifyObjectiveThreePerRowOnA3(): void {
  const card = baseCard();
  card.bodyBlocks = [objectiveBlock(8)];
  const layout = buildLayout(card);
  const block = layout.pages[0].blocks.find((item) => item.type === "objective");
  assert.ok(block && block.type === "objective");
  assert.equal(block.items.length, 8);

  const firstRowY = block.items.slice(0, 3).map((item) => item.labelY);
  assert.equal(new Set(firstRowY).size, 1, "A3 每栏一行 3 题（观感与既有卡片一致）");
  assert.ok(block.items[3].labelY > firstRowY[0], "第 4 题应换到下一行");

  const columnWidth = block.items[1].labelX - block.items[0].labelX;
  block.items.forEach((item) => {
    const right = Math.max(...item.options.map((option) => option.rect.x + option.rect.width));
    const columnRight = item.labelX - 2.5 + columnWidth;
    assert.ok(right <= columnRight + 0.01, `第 ${item.questionNumber} 题选项越过列宽（会与下一题串位）`);
  });
  // 4 选项题目沿用密度设定的固定间距，观感不变
  const gap = block.items[0].options[1].rect.x - (block.items[0].options[0].rect.x + block.items[0].options[0].rect.width);
  assert.ok(Math.abs(gap - 2.3) < 0.01, `4 选项题目选项间距应保持原设定（6.7 - 4.4），实际 ${gap}`);
}

function verifyA4KeepsFourPerRow(): void {
  const card = baseCard();
  card.paper = { size: "A4", orientation: "portrait" };
  card.bodyBlocks = [objectiveBlock(8)];
  const block = buildLayout(card).pages[0].blocks.find((item) => item.type === "objective");
  assert.ok(block && block.type === "objective");
  const firstRowY = block.items.slice(0, 4).map((item) => item.labelY);
  assert.equal(new Set(firstRowY).size, 1, "A4 仍按一行 4 题");
  assert.ok(block.items[4].labelY > firstRowY[0], "A4 第 5 题应换到下一行");
}

function verifyAnnotationAboveAnswerLines(): void {
  const card = baseCard();
  card.bodyBlocks = [answerBlock("**续写要求**：至少 *80* 词")];
  const layout = buildLayout(card);
  const question = layout.pages[0].blocks.find((block) => block.type === "subjective")?.questions[0];
  assert.ok(question, "解答题必须排版成功");

  const lines = question.annotationLines ?? [];
  assert.ok(lines.length > 0, "解答题注记必须排布在作答区上方");
  assert.ok(question.lineYs.length > 0, "解答题必须有作答横线");
  lines.forEach((line) => {
    assert.ok(line.rect.y + line.rect.height <= question.lineYs[0], "注记必须排在首条横线上方");
  });
  const runs = lines.flatMap((line) => line.runs ?? []);
  assert.ok(runs.some((run) => run.bold && run.text.includes("续写要求")), "注记必须解析出加粗片段");
  assert.ok(runs.some((run) => run.italic && run.text.includes("80")), "注记必须解析出斜体片段");
  assert.equal(lines.map((line) => line.text).join(""), "续写要求：至少 80 词", "注记纯文本不应包含标记符");
}

function verifyFixedAnswerLinesKeepCountWithAnnotation(): void {
  // 注记把横线起点下移后，固定行数的末尾行不得被边界检查丢弃
  const spacing = 8;
  const fixedCount = 5;
  const annotation = "注意：本题为选考题，请从所给两题中任选一题作答，如果多做，则按所做的第一题计分。作答前请先用2B铅笔在答题卡上把所选题目对应的题号涂黑，超出答题区域书写的答案无效";
  for (const layoutVersion of [1, 2] as const) {
    const card = baseCard();
    card.paper = { size: "A4", orientation: "portrait" };
    card.layoutVersion = layoutVersion;
    const block = answerBlock(annotation);
    const question = block.questions[0];
    question.lineGrid = { enabled: true, lineSpacingMm: spacing, fixedLineCount: fixedCount };
    question.minHeightMm = 14 + fixedCount * spacing; // 界面「按行数设高度」的公式
    card.bodyBlocks = [block];
    const laidOut = buildLayout(card).pages[0].blocks.find((item) => item.type === "subjective")?.questions[0];
    assert.ok(laidOut, `v${layoutVersion} 解答题必须排版成功`);
    assert.ok((laidOut.annotationLines ?? []).length >= 2, `v${layoutVersion} 注记应占两行以上以复现问题`);
    assert.equal(laidOut.lineYs.length, fixedCount, `v${layoutVersion} 加多行注记后固定作答横线仍须为 ${fixedCount} 条`);
  }
}

function main(): void {
  verifyBlockTitleEditability();
  verifyRichTextParsing();
  verifyEssayGridStaysInOnePanel();
  verifyObjectiveThreePerRowOnA3();
  verifyA4KeepsFourPerRow();
  verifyAnnotationAboveAnswerLines();
  verifyFixedAnswerLinesKeepCountWithAnnotation();
  console.log("verify:feedback-260923 通过（题块标题可改名 / 富文本解析 / 作文格单栏换行 / 客观题一行 3 题 / 解答题注记 / 固定行数不随注记减少）");
}

main();
