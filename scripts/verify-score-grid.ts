/**
 * 得分填涂格渲染门控冒烟测试（PR #242 反馈补丁）：
 * 1) shouldRenderScoreGrid 纯函数：enabled=false 关闭 / 缺省向后兼容 / showLabel 不影响方格；
 * 2) 布局链路：layout.ts 按 enabled 裁剪 scoreCells，判定函数与之一致（SVG 预览 / PDF 共用）；
 * 3) PDF 渲染路径在关闭得分格时不抛错。
 */
import assert from "node:assert/strict";
import { createDefaultCard } from "../src/shared/defaultCard";
import { buildLayout } from "../src/shared/layout";
import { shouldRenderScoreGrid } from "../src/shared/scoreGrid";
import type { AnswerCard, SubjectiveBlock, SubjectiveRenderItem } from "../src/shared/types";
import { createPdf } from "../src/apps/answer-card/server/pdf";

function answerBlock(scoreGrid: SubjectiveRenderItem["scoreGrid"]): SubjectiveBlock {
  return {
    id: "sg_block",
    type: "subjective",
    blockKind: "answer",
    title: "解答题",
    questions: [
      {
        id: "sg_q1",
        number: 1,
        score: 12,
        style: "manual_score_grid",
        kind: "lined_answer",
        lineGrid: { enabled: true, lineSpacingMm: 7, fixedLineCount: 5, lineColor: "#222", lineWidthMm: 0.15, insetLeftMm: 4, insetRightMm: 4 },
        scoreGrid,
        images: [],
        minHeightMm: 49
      }
    ]
  };
}

/** 手工构造渲染项（predicate 只消费 style / scoreGrid.enabled / scoreCells） */
function renderItem(partial: Partial<SubjectiveRenderItem>): SubjectiveRenderItem {
  return {
    blockId: "sg_block",
    questionId: "sg_q1",
    questionNumber: 1,
    score: 12,
    style: "manual_score_grid",
    kind: "lined_answer",
    rect: { x: 0, y: 0, width: 100, height: 40 },
    contentRect: { x: 0, y: 8, width: 100, height: 32 },
    scoreCells: [],
    lineYs: [],
    blanks: [],
    images: [],
    ...partial
  };
}

function firstSubjectiveQuestion(card: AnswerCard, isV2: boolean): SubjectiveRenderItem {
  card.layoutVersion = isV2 ? 2 : 1;
  const layout = buildLayout(card);
  const block = layout.pages.flatMap((page) => page.blocks).find(
    (item): item is Extract<typeof item, { type: "subjective" }> =>
      item.type === "subjective" && item.questions.some((question) => question.questionId === "sg_q1")
  );
  assert.ok(block, "布局中应渲染解答题块");
  return block.questions.find((question) => question.questionId === "sg_q1")!;
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

function predicateUnitChecks(): void {
  // 1) enabled === false → 不渲染（PR #242 核心场景）
  assert.equal(
    shouldRenderScoreGrid(renderItem({ scoreGrid: { enabled: false } }), false),
    false,
    "enabled=false 时应关闭得分格"
  );
  assert.equal(
    shouldRenderScoreGrid(renderItem({ scoreGrid: { enabled: false } }), true),
    false,
    "enabled=false 在 V2 下同样关闭"
  );

  // 2) scoreGrid 缺省（旧数据）→ 向后兼容，仍渲染
  assert.equal(
    shouldRenderScoreGrid(renderItem({}), false),
    true,
    "scoreGrid 缺省时应向后兼容渲染"
  );

  // 3) showLabel === false → 仅隐藏“得分”标签，方格判定不受影响
  assert.equal(
    shouldRenderScoreGrid(renderItem({ scoreGrid: { enabled: true, showLabel: false }, scoreCells: [{ score: 12, rect: { x: 0, y: 0, width: 4, height: 4 } }] }), true),
    true,
    "showLabel=false 不应影响方格渲染判定"
  );

  // 4) 非 manual_score_grid 样式 → 不渲染
  assert.equal(
    shouldRenderScoreGrid(renderItem({ style: "plain_subjective" }), false),
    false,
    "纯主观题样式不应渲染得分格"
  );

  // 5) V2 且无实际方格 → 不渲染（layout 已裁剪，防御性判定）
  assert.equal(
    shouldRenderScoreGrid(renderItem({ scoreGrid: { enabled: true } }), true),
    false,
    "V2 无 scoreCells 时不应渲染"
  );

  // 6) V1 且无实际方格 → 按样式放行（V1 布局仍可能预留表头行）
  assert.equal(
    shouldRenderScoreGrid(renderItem({ scoreGrid: { enabled: true } }), false),
    true,
    "V1 按样式放行"
  );

  // 7) V2 且有方格 → 渲染
  assert.equal(
    shouldRenderScoreGrid(renderItem({ scoreGrid: { enabled: true }, scoreCells: [{ score: 12, rect: { x: 0, y: 0, width: 4, height: 4 } }] }), true),
    true,
    "V2 有 scoreCells 时应渲染"
  );
}

async function main(): Promise<void> {
  predicateUnitChecks();

  // 链路：enabled=false → layout 不产出方格 → 判定 false（SVG 预览与 PDF 共用同一门控）
  {
    const card = createDefaultCard("score_grid_smoke_disabled", "wuli", "A4");
    card.bodyBlocks = [answerBlock({ enabled: false })];
    const question = firstSubjectiveQuestion(card, false);
    assert.equal(question.scoreCells.length, 0, "enabled=false 时 layout 不应生成 scoreCells");
    assert.equal(shouldRenderScoreGrid(question, false), false, "渲染判定应与 layout 一致（关闭）");
    const buffer = await pdfBuffer(card);
    assert.ok(buffer.length > 1000, "关闭得分格后 PDF 仍应正常输出");
  }

  // 链路：scoreGrid 缺省 → layout 正常生成方格 → 判定 true（向后兼容）
  {
    const card = createDefaultCard("score_grid_smoke_default", "wuli", "A4");
    card.bodyBlocks = [answerBlock(undefined)];
    const question = firstSubjectiveQuestion(card, false);
    assert.ok(question.scoreCells.length > 0, "scoreGrid 缺省时 layout 应生成 scoreCells");
    assert.equal(shouldRenderScoreGrid(question, false), true, "渲染判定应与 layout 一致（开启）");
  }

  // 链路：showLabel=false 但 enabled → 方格仍在（仅标签被隐藏，属渲染层独立开关）
  {
    const card = createDefaultCard("score_grid_smoke_label", "wuli", "A4");
    card.bodyBlocks = [answerBlock({ enabled: true, showLabel: false })];
    const question = firstSubjectiveQuestion(card, true);
    assert.ok(question.scoreCells.length > 0, "showLabel=false 不应移除 scoreCells");
    assert.equal(shouldRenderScoreGrid(question, true), true, "方格判定不受 showLabel 影响");
  }

  console.log("verify-score-grid: 通过（判定函数 / layout 链路 / PDF 冒烟）");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
