/**
 * 回归测试:验证主观题 scoreGrid 配置保存后不丢失。
 *
 * 背景:v1.6.1 之前 SubjectiveQuestion.scoreGrid 在 types.ts 已定义、前端设计器/PDF/布局
 * 全链路使用,但持久层(CardRepository + migrations)只落库了 lineGrid 和 essayGrid,
 * scoreGrid 完全没存。老师每次保存答题卡再重新打开,scoreGrid 配置都会回退/丢失。
 *
 * 本脚本验证修复后:保存→重新读取,scoreGrid 与写入值深相等。
 *
 * 运行:npx tsx scripts/verify-score-grid-persistence.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// 必须在导入任何 db 模块前设置数据库路径(getDatabase 在模块求值期读取该变量)
const tmpDir = mkdtempSync(path.join(tmpdir(), "projectx-scoregrid-"));
process.env.PROJECTX_DB_PATH = path.join(tmpDir, "verify.db");
// 固定使用临时 SQLite,避免 cloud.env 中的 MariaDB 变量干扰
delete process.env.PROJECTX_MARIADB_HOST;
delete process.env.PROJECTX_MARIADB_PORT;
delete process.env.PROJECTX_MARIADB_USER;
delete process.env.PROJECTX_MARIADB_PASSWORD;
delete process.env.PROJECTX_MARIADB_DATABASE;
delete process.env.PROJECTX_MYSQL_HOST;

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(cond: boolean, label: string): void {
  if (cond) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  \x1b[31m✗\x1b[0m ${label}`);
  }
}

function section(title: string): void {
  console.log(`\n\x1b[36m== ${title} ==\x1b[0m`);
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

import type { AnswerCard, SubjectiveQuestion, ScoreGridConfig, LineGridConfig, EssayGridConfig } from "../src/shared/types";

function buildCard(cardId: string, questions: SubjectiveQuestion[]): AnswerCard {
  return {
    id: cardId,
    title: `scoreGrid-test-${cardId}`,
    paper: { size: "A4", orientation: "portrait" },
    studentInfo: { fields: [], studentNumberDigits: 5 },
    bodyBlocks: [
      {
        id: `blk_${cardId}`,
        type: "subjective",
        blockKind: "answer",
        title: "主观题",
        questions
      } as any
    ],
    sided: "single",
    layoutVersion: 1,
    updatedAt: new Date(0).toISOString()
  };
}

const customScoreGrid: ScoreGridConfig = {
  enabled: true,
  strokeColor: "#f0f",
  strokeWidthMm: 0.2,
  fillColor: "#fef",
  fontSize: 4.2,
  dividerColor: "#abc",
  dividerWidthMm: 0.15,
  showLabel: false
};

const customLineGrid: LineGridConfig = {
  enabled: true,
  lineSpacingMm: 10,
  lineColor: "#222",
  lineWidthMm: 0.2,
  insetLeftMm: 8,
  insetRightMm: 6,
  lineStyle: "dashed"
};

const customEssayGrid: EssayGridConfig = {
  columns: 8,
  rows: 20,
  cellWidthMm: 7,
  cellHeightMm: 7,
  targetChars: 600,
  showTitle: true,
  lineColor: "#222"
};

async function main(): Promise<void> {
  console.log(`使用临时数据库: ${process.env.PROJECTX_DB_PATH}`);

  const { initializeDatabase, getDatabase, closeDatabase } = await import("../src/server/db/index");
  const { CardRepository } = await import("../src/server/repositories/CardRepository");
  const { runMigrations } = await import("../src/server/db/migrations");

  initializeDatabase();
  const repo = new CardRepository();

  // ── 1. 迁移幂等:连续跑两次 runMigrations,第二次不报错 ───
  section("1. 迁移幂等性 (v21 score_grid_json + v22 性能索引)");
  let migrationRerunOk = true;
  try {
    runMigrations(getDatabase());
  } catch (e) {
    migrationRerunOk = false;
    console.error("  runMigrations 二次执行抛错:", e);
  }
  ok(migrationRerunOk, "连续第二次 runMigrations 不抛错");

  // 验证列确实存在
  const cols = getDatabase().prepare("PRAGMA table_info(subjective_questions)").all() as Array<{ name: string }>;
  ok(cols.some((c) => c.name === "score_grid_json"), "subjective_questions 表含 score_grid_json 列");

  // 验证 v22 性能复合索引存在 (与 MariaDB 对齐)
  const indexes = getDatabase().prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>;
  const indexNames = new Set(indexes.map((i) => i.name));
  ok(indexNames.has("idx_student_scores_exam_total"), "v22 索引 idx_student_scores_exam_total 存在");
  ok(indexNames.has("idx_student_scores_exam_assigned"), "v22 索引 idx_student_scores_exam_assigned 存在");
  ok(indexNames.has("idx_question_scores_exam_type"), "v22 索引 idx_question_scores_exam_type 存在");
  ok(indexNames.has("idx_exams_grade_class"), "v22 索引 idx_exams_grade_class 存在");

  // ── 2. 核心往返:scoreGrid 自定义值保存后深相等 ─────────
  section("2. scoreGrid 自定义值往返一致性");
  {
    const card = buildCard("c1", [
      {
        id: "q1",
        number: "26",
        score: 12,
        style: "manual_score_grid",
        kind: "plain_box",
        minHeightMm: 80,
        scoreGrid: customScoreGrid
      }
    ]);
    await repo.createCard(card);
    await repo.updateCard(card);
    const readBack = await repo.findById(card.id);
    ok(readBack !== null, "findById 返回非空");
    const sub = readBack!.bodyBlocks[0] as any;
    const readQ = sub.questions[0];
    ok(jsonEqual(readQ.scoreGrid, customScoreGrid), `scoreGrid 深相等 (实际: ${JSON.stringify(readQ.scoreGrid)})`);
  }

  // ── 3. 三格共存:lineGrid + essayGrid + scoreGrid 同时往返 ─
  section("3. lineGrid / essayGrid / scoreGrid 三格共存");
  {
    const card = buildCard("c2", [
      {
        id: "q2",
        number: "27",
        score: 20,
        style: "manual_score_grid",
        kind: "plain_box",
        minHeightMm: 120,
        lineGrid: customLineGrid,
        essayGrid: customEssayGrid,
        scoreGrid: customScoreGrid
      }
    ]);
    await repo.createCard(card);
    await repo.updateCard(card);
    const readBack = await repo.findById(card.id);
    const readQ = (readBack!.bodyBlocks[0] as any).questions[0];
    ok(jsonEqual(readQ.lineGrid, customLineGrid), "lineGrid 深相等");
    ok(jsonEqual(readQ.essayGrid, customEssayGrid), "essayGrid 深相等");
    ok(jsonEqual(readQ.scoreGrid, customScoreGrid), "scoreGrid 深相等");
  }

  // ── 4. scoreGrid 为 undefined 时不报错且读回 undefined ────
  section("4. scoreGrid = undefined 边界");
  {
    const card = buildCard("c3", [
      {
        id: "q3",
        number: "28",
        score: 8,
        style: "plain_subjective",
        kind: "plain_box",
        minHeightMm: 60
        // 故意不设 scoreGrid
      }
    ]);
    let saveOk = true;
    try {
      await repo.createCard(card);
      await repo.updateCard(card);
    } catch (e) {
      saveOk = false;
      console.error("  保存抛错:", e);
    }
    ok(saveOk, "scoreGrid=undefined 时 createCard+updateCard 不抛错");
    const readBack = await repo.findById(card.id);
    const readQ = (readBack!.bodyBlocks[0] as any).questions[0];
    ok(readQ.scoreGrid === undefined, `读回 scoreGrid 为 undefined (实际: ${JSON.stringify(readQ.scoreGrid)})`);
  }

  // ── 5. scoreGrid.enabled=false 不应被丢弃 ───────────────
  section("5. scoreGrid.enabled=false 保留");
  {
    const disabled: ScoreGridConfig = { enabled: false };
    const card = buildCard("c4", [
      {
        id: "q4",
        number: "29",
        score: 5,
        style: "manual_score_grid",
        kind: "plain_box",
        minHeightMm: 50,
        scoreGrid: disabled
      }
    ]);
    await repo.createCard(card);
    await repo.updateCard(card);
    const readBack = await repo.findById(card.id);
    const readQ = (readBack!.bodyBlocks[0] as any).questions[0];
    ok(jsonEqual(readQ.scoreGrid, disabled), `enabled=false 配置保留 (实际: ${JSON.stringify(readQ.scoreGrid)})`);
  }

  // ── 6. 更新覆盖:改 scoreGrid 后再次保存,新值生效 ───────
  section("6. 二次更新覆盖旧 scoreGrid");
  {
    const card = buildCard("c5", [
      {
        id: "q5",
        number: "30",
        score: 10,
        style: "manual_score_grid",
        kind: "plain_box",
        minHeightMm: 70,
        scoreGrid: { enabled: true, strokeColor: "#000" }
      }
    ]);
    await repo.createCard(card);
    await repo.updateCard(card);

    // 修改 scoreGrid 后再次保存
    const updated = { ...card, bodyBlocks: [{ ...(card.bodyBlocks[0] as any), questions: [{ ...((card.bodyBlocks[0] as any).questions[0]), scoreGrid: customScoreGrid }] }] };
    await repo.updateCard(updated);

    const readBack = await repo.findById(card.id);
    const readQ = (readBack!.bodyBlocks[0] as any).questions[0];
    ok(jsonEqual(readQ.scoreGrid, customScoreGrid), "二次保存后 scoreGrid 为新值 (而非旧值或丢失)");
  }

  // ── 7. 多题主观题块排序保持 ───────────────────────────
  // 场景:填空题块可 push 多个题目 (App.tsx:3818),保存后重开顺序不能乱
  section("7. 多题主观题块 sort_order 保持");
  {
    const card = buildCard("c6", [
      { id: "q6a", number: "31", score: 3, style: "manual_score_grid", kind: "blank", minHeightMm: 30, blanks: { count: 3, widthMm: 20, heightMm: 8 } },
      { id: "q6b", number: "32", score: 4, style: "manual_score_grid", kind: "blank", minHeightMm: 30, blanks: { count: 4, widthMm: 20, heightMm: 8 } },
      { id: "q6c", number: "33", score: 5, style: "manual_score_grid", kind: "blank", minHeightMm: 30, blanks: { count: 5, widthMm: 20, heightMm: 8 } }
    ]);
    (card.bodyBlocks[0] as any).blockKind = "fill_blank";
    await repo.createCard(card);
    await repo.updateCard(card);
    const readBack = await repo.findById(card.id);
    const sub = readBack!.bodyBlocks[0] as any;
    ok(sub.questions.length === 3, `读回 3 个题目 (实际: ${sub.questions.length})`);
    const ids = sub.questions.map((q: any) => q.id);
    ok(ids[0] === "q6a" && ids[1] === "q6b" && ids[2] === "q6c", `题目顺序保持 [q6a, q6b, q6c] (实际: ${JSON.stringify(ids)})`);
    const nums = sub.questions.map((q: any) => q.number);
    ok(String(nums[0]) === "31" && String(nums[1]) === "32" && String(nums[2]) === "33", `题号顺序保持 [31, 32, 33] (实际: ${JSON.stringify(nums)})`);
  }

  // ── 8. 多图片排序保持 ─────────────────────────────────
  // 场景:一个主观题关联多张图片,保存后重开图片顺序不能乱
  section("8. 多图片 sort_order 保持");
  {
    const card = buildCard("c7", [
      {
        id: "q7", number: "34", score: 8, style: "manual_score_grid", kind: "plain_box", minHeightMm: 60,
        images: [
          { assetId: "asset-1", originalName: "a.png", widthMm: 50, heightMm: 30, align: "left" as const },
          { assetId: "asset-2", originalName: "b.png", widthMm: 50, heightMm: 30, align: "center" as const },
          { assetId: "asset-3", originalName: "c.png", widthMm: 50, heightMm: 30, align: "right" as const }
        ]
      }
    ]);
    await repo.createCard(card);
    await repo.updateCard(card);
    const readBack = await repo.findById(card.id);
    const readQ = (readBack!.bodyBlocks[0] as any).questions[0];
    ok(readQ.images.length === 3, `读回 3 张图片 (实际: ${readQ.images.length})`);
    const assetIds = readQ.images.map((img: any) => img.assetId);
    ok(assetIds[0] === "asset-1" && assetIds[1] === "asset-2" && assetIds[2] === "asset-3", `图片顺序保持 [asset-1, asset-2, asset-3] (实际: ${JSON.stringify(assetIds)})`);
  }

  closeDatabase();

  console.log(`\n\x1b[36m== 总结 ==\x1b[0m`);
  console.log(`通过 ${passed} 项, 失败 ${failed} 项`);
  if (failed > 0) {
    console.log("\x1b[31m失败用例:\x1b[0m");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }

  // 清理临时目录
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

main().catch((err) => {
  console.error("\x1b[31m未捕获异常:\x1b[0m", err);
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(1);
});
