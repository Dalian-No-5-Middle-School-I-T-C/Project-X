/**
 * 填空题升级冒烟测试：
 * 1) 填空题块逐空自定义横线宽度/高度（含右侧批注）；
 * 2) 填空题支持文字注释（自动折行）；
 * 3) 填空题支持插入图片（缩放、对齐）；
 * 4) PDF 渲染路径可正常输出（含注释行与图片占位）。
 */
import assert from "node:assert/strict";
import { createDefaultCard } from "../src/shared/defaultCard";
import { buildLayout } from "../src/shared/layout";
import type { AnswerCard, SubjectiveBlock, SubjectiveRenderItem } from "../src/shared/types";
import { createPdf } from "../src/apps/answer-card/server/pdf";

function fillBlankBlock(): SubjectiveBlock {
  return {
    id: "fb_upgrade_block",
    type: "subjective",
    blockKind: "fill_blank",
    title: "填空题",
    questions: [
      {
        id: "fb_q1",
        number: 1,
        score: 0,
        style: "plain_subjective",
        kind: "blank",
        blanks: {
          count: 2,
          widthMm: 30,
          heightMm: 6,
          labelStyle: "arabic_parentheses",
          items: [
            { label: "(1)", widthMm: 20, heightMm: 6 },
            { label: "(2)", widthMm: 34, heightMm: 8, rightAnnotation: "填＞或＜" }
          ]
        },
        images: [],
        minHeightMm: 14
      },
      {
        id: "fb_q2",
        number: 2,
        score: 0,
        style: "plain_subjective",
        kind: "blank",
        annotation:
          "观察下面图片，先写出数量关系式，再列式解答。注意单位换算，结果保留一位小数。若题目有多余条件，请说明理由。完成后检查单位与答案是否一致，必要时写出检验过程。",
        blanks: {
          count: 2,
          widthMm: 26,
          heightMm: 6,
          labelStyle: "arabic_parentheses",
          items: [
            { label: "(1)", widthMm: 26, heightMm: 6 },
            { label: "(2)", widthMm: 26, heightMm: 6, rightAnnotation: "（写算式）" }
          ]
        },
        images: [{ assetId: "fig.png", originalName: "fig.png", widthMm: 48, heightMm: 22, align: "center" }],
        minHeightMm: 14
      },
      {
        id: "fb_q3",
        number: 3,
        score: 0,
        style: "plain_subjective",
        kind: "blank",
        annotation: "注：答案不唯一，言之有理即可。",
        blanks: { count: 1, widthMm: 34, heightMm: 6, labelStyle: "none" },
        images: [],
        minHeightMm: 14
      }
    ]
  };
}

function fillBlankQuestions(card: AnswerCard): SubjectiveRenderItem[] {
  const block = card.bodyBlocks.find((item) => item.id === "fb_upgrade_block");
  assert.ok(block && block.type === "subjective", "填空题块应存在");
  const layout = buildLayout(card);
  const rendered = layout.pages.flatMap((page) => page.blocks).find(
    (blockItem): blockItem is Extract<typeof blockItem, { type: "subjective" }> =>
      blockItem.type === "subjective" && blockItem.questions.some((question) => question.questionId === "fb_q1")
  );
  assert.ok(rendered, "布局中应渲染填空题块");
  return rendered.questions;
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

async function main(): Promise<void> {
  const card = createDefaultCard("fillblank_upgrade_smoke", "wuli", "A4");
  card.bodyBlocks = [fillBlankBlock()];

  const questions = fillBlankQuestions(card);
  const q1 = questions.find((question) => question.questionId === "fb_q1");
  const q2 = questions.find((question) => question.questionId === "fb_q2");
  const q3 = questions.find((question) => question.questionId === "fb_q3");
  assert.ok(q1 && q2 && q3, "三个填空题都应完成排版");

  // 1) 逐空自定义横线：两个空的宽度不同，且右侧批注保留
  assert.equal(q1.blanks.length, 2, "第 1 题应有 2 条横线");
  assert.notEqual(q1.blanks[0].width, q1.blanks[1].width, "自定义横线宽度应逐空生效");
  assert.equal(q1.blankRightAnnotations?.[1], "填＞或＜", "右侧批注应保留");
  assert.notEqual(q1.blanks[0].height, q1.blanks[1].height, "自定义横线高度应逐空生效");

  // 2) 文字注释：折行输出多行，且位于单元格内
  assert.ok((q2.annotationLines?.length ?? 0) >= 2, "长注释应自动折行");
  for (const line of q2.annotationLines ?? []) {
    assert.ok(line.text.length > 0, "注释行不应为空");
    assert.ok(line.rect.x + line.rect.width <= q2.rect.x + q2.rect.width + 0.002, "注释应位于单元格宽度内");
  }

  // 3) 图片：进入布局、缩放后不超过单元格宽度
  assert.equal(q2.images.length, 1, "第 2 题应排入 1 张图片");
  const image = q2.images[0];
  assert.ok(image.rect.width <= q2.rect.width + 0.002, "图片宽度不应超过单元格");
  assert.ok(image.rect.x >= q2.rect.x - 0.002 && image.rect.y >= q2.rect.y - 0.002, "图片应在单元格内");

  // 4) 无注释/图片的普通填空仍保持最小行高
  assert.ok(q3.rect.height >= 13, "普通填空单元格高度不应低于最小行高");

  // 5) PDF 渲染路径（含注释行与缺失图片占位）不抛错
  const buffer = await pdfBuffer(card);
  assert.ok(buffer.length > 1000, "PDF 应有实际内容");

  console.log("fill-blank-upgrade-smoke: 通过（自定义横线 / 文字注释 / 插入图片 / PDF）");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
