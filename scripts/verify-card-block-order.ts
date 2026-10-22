import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "projectx-card-order-"));
process.env.PROJECTX_DB_PATH = path.join(dir, "test.db");
process.env.ANSWER_CARD_DATA_DIR = path.join(dir, "cards");
for (const key of Object.keys(process.env)) {
  if (/^PROJECTX_(MARIADB|MYSQL)_/.test(key)) delete process.env[key];
}

const { initializeDatabase, closeDatabase, getMysqlDb } = await import("../src/server/db");
initializeDatabase();
const { CardRepository } = await import("../src/server/repositories/CardRepository");
const { createDefaultCard } = await import("../src/shared/defaultCard");
const { buildLayout } = await import("../src/shared/layout");

const objectiveBlock = (id: string, title: string, questionStart: number) => ({
  id,
  type: "objective",
  title,
  questionStart,
  questionCount: 2,
  optionCount: 4,
  mode: "single",
  scorePerQuestion: 5,
  density: "compact",
  optionLayout: "horizontal",
  answerKey: {},
  multipleScoring: { partialScores: {}, wrongOrExtraScore: 0 }
});

const subjectiveBlock = (id: string, title: string, number: number) => ({
  id,
  type: "subjective",
  blockKind: "answer",
  title,
  questions: [{
    id: `${id}_q`,
    number,
    score: 20,
    style: "manual_score_grid",
    kind: "plain_box",
    minHeightMm: 20,
    images: []
  }]
});

const expectedTitles = ["一、客观一", "二、主观一", "三、客观二", "四、主观二"];
const card = createDefaultCard("78825347");
card.title = "题块顺序持久化回归";
card.bodyBlocks = [
  objectiveBlock("obj_1", expectedTitles[0], 1),
  subjectiveBlock("subj_2", expectedTitles[1], 2),
  objectiveBlock("obj_3", expectedTitles[2], 3),
  subjectiveBlock("subj_4", expectedTitles[3], 4)
] as any;

try {
  const repo = new CardRepository();
  await repo.createCard(card);
  await repo.updateCard(card);

  const saved = (await repo.findById(card.id))!;
  assert.deepEqual(saved.bodyBlocks.map((block: any) => block.title), expectedTitles,
    "保存后应按卡片 JSON 顺序还原交错题块");

  const db = getMysqlDb();
  const rows = await db.all<{ id: string; sort_order: number }>(
    `SELECT id, sort_order FROM objective_blocks WHERE card_id = ?
     UNION ALL
     SELECT id, sort_order FROM subjective_blocks WHERE card_id = ?
     ORDER BY sort_order`,
    card.id, card.id
  );
  assert.deepEqual(rows.map((row) => row.id), ["obj_1", "subj_2", "obj_3", "subj_4"],
    "两表 sort_order 应使用同一套整卡序号");
  assert.deepEqual(rows.map((row) => Number(row.sort_order)), [0, 1, 2, 3]);

  const layoutTitles = buildLayout(saved).pages.flatMap((page) => page.blocks.map((block) => block.title));
  assert.deepEqual(layoutTitles, expectedTitles, "layout（PDF/识别共用）应保持同一顺序");
  console.log("PASS 交错题块按卡片 JSON 顺序落库并还原");

  await db.run("UPDATE objective_blocks SET sort_order = 0 WHERE card_id = ?", card.id);
  await db.run("UPDATE subjective_blocks SET sort_order = 0 WHERE card_id = ?", card.id);
  const legacy = (await repo.findById(card.id))!;
  assert.deepEqual(legacy.bodyBlocks.map((block: any) => block.type),
    ["objective", "objective", "subjective", "subjective"],
    "历史 sort_order=0 数据应保持「先客观后主观」的旧顺序");
  console.log("PASS 历史 sort_order=0 数据保持原分组顺序");

  await repo.updateCard(legacy);
  const upgraded = (await repo.findById(card.id))!;
  assert.deepEqual(upgraded.bodyBlocks.map((block: any) => block.title),
    ["一、客观一", "三、客观二", "二、主观一", "四、主观二"]);
  const upgradedRows = await db.all<{ sort_order: number }>(
    `SELECT sort_order FROM objective_blocks WHERE card_id = ?
     UNION ALL
     SELECT sort_order FROM subjective_blocks WHERE card_id = ?
     ORDER BY sort_order`,
    card.id, card.id
  );
  assert.deepEqual(upgradedRows.map((row) => Number(row.sort_order)), [0, 1, 2, 3]);
  console.log("PASS 历史卡重新保存后升级为整卡序号");
} finally {
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
}
