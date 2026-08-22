import { buildInsertIgnore, type DbAdapter } from "../../db";
import { ESSAY_DEFAULT_LINE_COLOR } from "../../../shared/essayGrid";
// 作文格仿高考样式演示种子（答题卡设计器修复）：朱红格线 / 行间虚线 / 每 100 字刻度
// ────────────────────────────────────────────────────────────────────────────

const LANGUAGE_CARD_ID = "88000001"; // 演示-语文卡（填空题 + 作文块演示）

/**
 * 为演示-语文卡补一个作文块（1 道题）：
 * - 与设计器新建作文块的默认配置一致（essayGrid.ts / cardModel.defaultEssayBlock）：
 *   7mm 方格、目标 600 字、朱红格线（ESSAY_DEFAULT_LINE_COLOR）、粗边框 + 每 100 字刻度，
 *   行缝由 essayGrid.ts 几何唯一事实源推导（预览/PDF/排版引擎三端一致）。
 * - 演示-第25周考试包等已有卡片的旧作文沿用已存 lineColor（#222），本种子仅约束新建块。
 * 清除演示数据时经 subjective_blocks.card_id → answer_cards ON DELETE CASCADE 自动级联。
 */
export async function seedEssayDemo(db: DbAdapter): Promise<void> {
  const card = await db.get("SELECT id FROM answer_cards WHERE id = ?", LANGUAGE_CARD_ID) as { id: string } | undefined;
  if (!card) return;

  const blockId = "essay-demo-1";
  await db.run(
    buildInsertIgnore(db.dialect, "subjective_blocks", ["id", "card_id", "sort_order", "block_kind", "title"]),
    blockId, LANGUAGE_CARD_ID, 1, "essay", "作文（演示）"
  );

  const insertQ = buildInsertIgnore(db.dialect, "subjective_questions", [
    "id", "block_id", "number", "score", "style", "kind", "min_height_mm",
    "line_grid_enabled", "line_spacing_mm", "essay_grid_json", "annotation", "sort_order"
  ]);

  // 与 cardModel.defaultEssayBlock 相同的新建默认配置（lineColor = ESSAY_DEFAULT_LINE_COLOR）
  await db.run(
    insertQ,
    "essay-q1", blockId, 4, 60, "manual_score_grid", "plain_box", 280,
    0, 7,
    JSON.stringify({
      columns: 0,
      rows: 0,
      cellWidthMm: 7,
      cellHeightMm: 7,
      targetChars: 600,
      showTitle: true,
      lineColor: ESSAY_DEFAULT_LINE_COLOR,
      lineWidthMm: 0.15,
      showFrame: true,
      showWordScale: true
    }),
    "阅读下面的材料，根据要求写作。不少于 600 字，立意自定，文体自选（诗歌除外），不得抄袭。",
    0
  );

  console.log(`[seed] 作文格演示: 卡 ${LANGUAGE_CARD_ID} 补作文块（朱红格线 / 每 100 字刻度 / 目标 600 字）`);
}
