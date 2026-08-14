import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { resolveAnswerCardDataDir } from "../../db";
import { makePlaceholderPng } from "./png";
// 填空题升级演示种子（#211）：自定义横线 / 文字注释 / 插入图片
// ────────────────────────────────────────────────────────────────────────────

const FILL_BLANK_CARD_ID = "88000001"; // 演示-语文卡

/**
 * 为演示-语文卡补一个填空题块（3 道题）：
 * - Q1：两空，逐空自定义横线宽度/高度 + 右侧批注 + 文字注释；
 * - Q2：一空 + 插入图片（居中，资源写入卡片资源目录，与 /api/cards/:id/assets 上传产物同构）；
 * - Q3：一空普通横线（对照，无注释/图片）。
 * 清除演示数据时经 subjective_blocks.card_id → answer_cards ON DELETE CASCADE 自动级联，无需额外清理。
 */
export function seedFillBlankDemo(db: Database.Database): void {
  // 卡片不存在时跳过（防御性检查；演示卡号被真实数据占用时 seedExam 的 INSERT 会先行报错）
  const card = db.prepare("SELECT id FROM answer_cards WHERE id = ?").get(FILL_BLANK_CARD_ID) as { id: string } | undefined;
  if (!card) return;

  const blockId = "fb-demo-1";
  db.prepare(`
    INSERT OR IGNORE INTO subjective_blocks (id, card_id, sort_order, block_kind, title)
    VALUES (?, ?, 0, 'fill_blank', '填空题（演示）')
  `).run(blockId, FILL_BLANK_CARD_ID);

  // 图片资源：写入 data/answer-card/assets/<cardId>/，设计器/PDF 以 /api/assets/:cardId/:assetId 读取
  const assetsDir = path.join(resolveAnswerCardDataDir(), "assets", FILL_BLANK_CARD_ID);
  fs.mkdirSync(assetsDir, { recursive: true });
  const assetFile = path.join(assetsDir, "fig-demo.png");
  if (!fs.existsSync(assetFile)) {
    fs.writeFileSync(assetFile, makePlaceholderPng(96, 60, [245, 243, 235]));
  }

  const insertQ = db.prepare(`
    INSERT OR IGNORE INTO subjective_questions
      (id, block_id, number, score, style, kind, min_height_mm, blanks_count, blanks_width_mm, blanks_height_mm,
       blanks_label_style, blanks_items_json, annotation, sort_order)
    VALUES (?, ?, ?, ?, 'plain_subjective', 'blank', ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertImg = db.prepare(
    "INSERT OR IGNORE INTO subjective_question_images (question_id, asset_id, original_name, width_mm, height_mm, align, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );

  // Q1：两空，逐空自定义横线宽度/高度 + 右侧批注 + 文字注释（blanks_items_json 与设计器存储格式一致）
  insertQ.run(
    "fb-q1", blockId, 1, 6, 14, 2, 30, 6, "arabic_parentheses",
    JSON.stringify([
      { label: "(1)", widthMm: 20, heightMm: 6 },
      { label: "(2)", widthMm: 34, heightMm: 8, rightAnnotation: "填＞或＜" }
    ]),
    "请在横线上填写正确的成语，注意字形与笔画。",
    0
  );

  // Q2：一空 + 插入图片（居中）
  insertQ.run(
    "fb-q2", blockId, 2, 4, 14, 1, 30, 6, "arabic_parentheses",
    JSON.stringify([{ label: "(1)", widthMm: 30, heightMm: 6 }]),
    "观察下面的图片，先写出数量关系式，再列式解答。注意单位换算，结果保留一位小数。",
    1
  );
  insertImg.run("fb-q2", "fig-demo.png", "fig-demo.png", 48, 22, "center", 0);

  // Q3：一空普通横线（对照，仅文字注释）
  insertQ.run(
    "fb-q3", blockId, 3, 3, 14, 1, 34, 6, "none",
    null,
    "注：答案不唯一，言之有理即可。",
    2
  );

  console.log(`[seed] 填空题演示: 卡 ${FILL_BLANK_CARD_ID} 补填空题块（自定义横线 / 文字注释 / 插入图片）`);
}
