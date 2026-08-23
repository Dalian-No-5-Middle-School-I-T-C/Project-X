/**
 * 答题卡同步服务（扫描端从主站拉取答题卡配置）
 *
 * 主站侧：exportCardPackage 导出某张答题卡的完整表数据包（answer_cards + 全部子表）；
 * 扫描端侧：importCardPackage 将数据包 REPLACE 写入本地库（幂等，可重复导入）。
 *
 * 数据包结构：
 * {
 *   cardId, exportedAt,
 *   tables: {
 *     answer_cards: [...], objective_blocks: [...], objective_answer_keys: [...],
 *     objective_questions: [...], objective_multiple_scoring: [...],
 *     subjective_blocks: [...], subjective_questions: [...],
 *     subjective_question_images: [...], card_assets: [...], knowledge_points: [...]
 *   }
 * }
 *
 * 说明：
 * - 资产文件（card_assets 的图片文件）不随包传输，仅同步元数据记录；
 * - 导入时 created_by 置 NULL、is_demo 置 0（本地使用，避免被演示数据清理误删）。
 */

import type { DbAdapter } from "../db/mysql";

export interface CardSyncPackage {
  cardId: string;
  exportedAt: string;
  tables: Record<string, Array<Record<string, unknown>>>;
}

/** 包内表顺序（先父后子，满足外键依赖） */
const TABLE_ORDER = [
  "answer_cards",
  "objective_blocks",
  "objective_answer_keys",
  "objective_questions",
  "objective_multiple_scoring",
  "subjective_blocks",
  "subjective_questions",
  "subjective_question_images",
  "card_assets",
  "knowledge_points",
] as const;

/** 主站导出：轻量答题卡列表（供扫描端选择） */
export async function listSyncCards(db: DbAdapter): Promise<
  Array<{ id: string; title: string; subject_label: string | null; updated_at: string | null }>
> {
  const rows = await db.all<{
    id: string; title: string; subject_label: string | null; updated_at: string | null;
  }>(
    "SELECT id, title, subject_label, updated_at FROM answer_cards ORDER BY updated_at DESC"
  );
  return rows;
}

/** 主站导出：单张答题卡完整数据包 */
export async function exportCardPackage(db: DbAdapter, cardId: string): Promise<CardSyncPackage | null> {
  const card = await db.get("SELECT * FROM answer_cards WHERE id = ?", cardId);
  if (!card) return null;

  const tables: Record<string, Array<Record<string, unknown>>> = {};
  // 主表（脱敏：去掉用户关联与演示标记）
  const cardRow = { ...card };
  delete cardRow.created_by;
  delete cardRow.is_demo;
  tables.answer_cards = [cardRow];

  const objBlocks = await db.all("SELECT * FROM objective_blocks WHERE card_id = ? ORDER BY sort_order", cardId);
  tables.objective_blocks = objBlocks;
  for (const b of objBlocks) {
    const bid = (b as any).id;
    tables.objective_answer_keys = (tables.objective_answer_keys ?? []).concat(
      await db.all("SELECT * FROM objective_answer_keys WHERE block_id = ?", bid)
    );
    tables.objective_questions = (tables.objective_questions ?? []).concat(
      await db.all("SELECT * FROM objective_questions WHERE block_id = ? ORDER BY sort_order, question_number", bid)
    );
    tables.objective_multiple_scoring = (tables.objective_multiple_scoring ?? []).concat(
      await db.all("SELECT * FROM objective_multiple_scoring WHERE block_id = ?", bid)
    );
  }

  const subBlocks = await db.all("SELECT * FROM subjective_blocks WHERE card_id = ? ORDER BY sort_order", cardId);
  tables.subjective_blocks = subBlocks;
  for (const b of subBlocks) {
    const bid = (b as any).id;
    const questions = await db.all("SELECT * FROM subjective_questions WHERE block_id = ? ORDER BY sort_order, number", bid);
    tables.subjective_questions = (tables.subjective_questions ?? []).concat(questions);
    for (const q of questions) {
      const qid = (q as any).id;
      tables.subjective_question_images = (tables.subjective_question_images ?? []).concat(
        await db.all("SELECT * FROM subjective_question_images WHERE question_id = ? ORDER BY sort_order, id", qid)
      );
    }
  }

  tables.card_assets = await db.all("SELECT * FROM card_assets WHERE card_id = ?", cardId);
  tables.knowledge_points = await db.all("SELECT * FROM knowledge_points WHERE card_id = ? ORDER BY sort_order", cardId);

  return { cardId, exportedAt: new Date().toISOString(), tables };
}

/** 扫描端导入：将数据包写入本地库（REPLACE，幂等） */
export async function importCardPackage(db: DbAdapter, pkg: CardSyncPackage): Promise<{ cardId: string; tables: number }> {
  if (!pkg?.tables) throw new Error("数据包格式无效");
  const tableCount: Record<string, number> = {};

  await db.transaction(async (tx) => {
    for (const table of TABLE_ORDER) {
      const rows = pkg.tables[table];
      if (!Array.isArray(rows) || rows.length === 0) continue;

      for (const row of rows) {
        // 主表脱敏：本地使用，不继承主站用户关联/演示标记
        const clean = { ...row };
        if (table === "answer_cards") {
          delete clean.created_by;
          clean.is_demo = 0;
        }
        const cols = Object.keys(clean);
        if (cols.length === 0) continue;
        const placeholders = cols.map(() => "?").join(", ");
        const colNames = cols.map((c) => `\`${c}\``).join(", ");
        await tx.run(
          `REPLACE INTO ${table} (${colNames}) VALUES (${placeholders})`,
          ...cols.map((c) => clean[c] ?? null)
        );
        tableCount[table] = (tableCount[table] ?? 0) + 1;
      }
    }
  });

  const total = Object.values(tableCount).reduce((a, b) => a + b, 0);
  return { cardId: pkg.cardId, tables: total };
}
