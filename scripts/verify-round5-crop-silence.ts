/**
 * 五轮测试 D1：切块持久化对"空切块 / 字段缺失"不得静默——返回统计并保留日志。
 * 用法：npx tsx scripts/verify-round5-crop-silence.ts（期望全绿，退出码 0）
 */
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmpDir = mkdtempSync(path.join(tmpdir(), "projectx-round5-crop-"));
process.env.PROJECTX_DB_PATH = path.join(tmpDir, "round5-crop.db");
delete process.env.PROJECTX_MARIADB_HOST;
delete process.env.PROJECTX_MYSQL_HOST;

import { getMysqlDb } from "../src/server/db";
import { persistAnswerBlockCrops } from "../src/server/services/AnswerBlockCropService";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(cond: boolean, label: string): void {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { failed++; failures.push(label); console.log(`  \x1b[31m✗\x1b[0m ${label}`); }
}
function section(title: string): void { console.log(`\n\x1b[36m== ${title} ==\x1b[0m`); }

async function main(): Promise<void> {
  const db = getMysqlDb();
  // 最小表结构：涵盖 persistAnswerBlockCrops INSERT 用到的全部列
  await db.exec(`
    CREATE TABLE answer_cards (id TEXT PRIMARY KEY);
    CREATE TABLE answer_block_crops (
      id TEXT PRIMARY KEY, card_id TEXT, exam_id INTEGER, student_id INTEGER, student_number TEXT,
      source_type TEXT, source_record_id TEXT, block_id TEXT, block_title TEXT, block_type TEXT,
      page_number INTEGER, segment_index INTEGER, question_numbers TEXT, rect_json TEXT,
      image_path TEXT, width_px INTEGER, height_px INTEGER, dpi INTEGER, status TEXT, review_round INTEGER
    );
  `);
  await db.run("INSERT INTO answer_cards (id) VALUES ('card-1')");

  section("空切块 — 返回统计且不写库");
  const r1 = await persistAnswerBlockCrops({
    cardId: "card-1", examId: 1, studentId: 1, studentNumber: "1001",
    sourceType: "scan_record", sourceRecordId: 7, crops: [],
  }, db);
  ok(r1.persisted === 0 && r1.empty === true, `空切块返回统计 (${JSON.stringify(r1)})`);

  section("字段缺失 — 跳过并计数");
  const r2 = await persistAnswerBlockCrops({
    cardId: "card-1", examId: 1, studentId: 1, studentNumber: "1001",
    sourceType: "scan_record", sourceRecordId: 8,
    crops: [
      { path: "/tmp/nonexist.png", blockId: "b1", questionNumbers: [1] } as any,
      { path: "/tmp/x.png", blockId: "b2", questionNumbers: [] } as any,
    ],
  }, db);
  ok(r2.persisted === 0 && r2.skipped === 2, `2 条无效切块被跳过并计数 (${JSON.stringify(r2)})`);

  section("有效切块 — 落库并计入 persisted");
  const validPng = path.join(tmpDir, "valid.png");
  writeFileSync(validPng, "png");
  const r3 = await persistAnswerBlockCrops({
    cardId: "card-1", examId: 1, studentId: 1, studentNumber: "1001",
    sourceType: "scan_record", sourceRecordId: 9,
    crops: [
      { path: validPng, blockId: "b1", questionNumbers: [1], pageNumber: 1, segmentIndex: 0, blockTitle: "阅读理解", rect: { x: 0, y: 0, w: 10, h: 10 }, widthPx: 100, heightPx: 200, dpi: 300 } as any,
    ],
  }, db);
  ok(r3.persisted === 1 && r3.skipped === 0 && r3.empty === false, `1 条有效切块落库 (${JSON.stringify(r3)})`);

  const rows = await db.all("SELECT COUNT(*) AS cnt FROM answer_block_crops") as Array<{ cnt: number }>;
  ok(Number(rows[0].cnt) === 1, "库内仅 1 条有效切块");

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) { console.error("失败项:\n" + failures.map((f) => "  - " + f).join("\n")); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });