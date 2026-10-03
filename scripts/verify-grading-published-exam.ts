/**
 * 「阅卷中已公布」考试的存量保护回归（评审 P1(1)）。
 *
 * 背景：#304 原先带一条 v57 迁移，把 `score_published = 1 AND status <> 'closed'`
 * 的存量行统一改成 `closed`，理由是「两字段错位」。但主线本来就允许阅卷期间先公布部分成绩：
 *   - 公布/撤回接口的准入条件是 `status IN ('grading','closed')`；
 *   - 扫描入库走 scannerExam.ts:9 的 `status !== 'closed'`，
 *     一旦被判成 closed，`resolveScannerExam` 立刻查不到可阅卷考试，
 *     现场表现为「答题卡未关联可阅卷的考试，成绩未入库」（评审实测复现）。
 * 展示层的「已公布仍显示阅卷中」由 toExamStatus() 以发布标志优先解决，不需要改数据。
 *
 * 因此这里钉三件事：
 *   1. 迁移不得再改写合法的 grading + 已公布状态（重跑全部迁移后状态不变）；
 *   2. 这种考试在升级后仍然是可扫描入库的目标；
 *   3. 两套方言的迁移版本号不重复、且 v57 已确定空置（避免同号被执行器静默跳过）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const HERE = fileURLToPath(new URL(".", import.meta.url));

process.env.PROJECTX_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "px-pub-status-")), "test.db");
const { initializeDatabase, getDatabase, getMysqlDb } = await import("../src/server/db/index");
const { runMigrations } = await import("../src/server/db/migrations");
const { resolveScannerExam } = await import("../src/server/services/scannerExam");

initializeDatabase();
const db = getMysqlDb();

try {
  const grade = (await db.run("INSERT INTO grades (name) VALUES ('published-grading')")).lastInsertRowid;
  const cls = (await db.run("INSERT INTO classes (grade_id, name) VALUES (?, 'published-class')", grade)).lastInsertRowid;
  await db.run("INSERT INTO answer_cards (id, title, sided) VALUES ('pub00001', '阅卷中已公布卡', 'double')");
  // 阅卷中途公布：status 仍为 grading，score_published 已是 1 —— 这是主线允许的正常状态。
  const exam = (await db.run(
    "INSERT INTO exams (name, card_id, grade_id, class_id, status, score_published) VALUES ('阅卷中途已公布', 'pub00001', ?, ?, 'grading', 1)",
    grade, cls,
  )).lastInsertRowid;

  // ① 升级幂等：把所有迁移再跑一遍（等同于现场拉起新版本），合法状态不得被改写。
  runMigrations(getDatabase());
  runMigrations(getDatabase());
  const after = await db.get<{ status: string; score_published: number }>(
    "SELECT status, score_published FROM exams WHERE id = ?", exam);
  assert.equal(after?.status, "grading", "①: 迁移不得把阅卷中已公布的考试强制结考");
  assert.equal(Number(after?.score_published), 1, "①: 发布标志必须保持 1");

  // ② 该考试升级后仍是扫描入库目标（closed 会被 scannerExam 过滤掉）。
  const resolved = await resolveScannerExam("pub00001", "session-never-used");
  assert.equal(resolved.exams.length, 1, "②: 按卡绑定应能查到考试");
  assert.equal(resolved.exam?.id, exam, "②: 已公布的在阅考试仍应被选为入库目标");
  assert.equal((await db.all<{ id: number }>(
    "SELECT e.id FROM exams e WHERE e.card_id = 'pub00001' AND e.status != 'closed'")).length, 1,
    "②: scannerResultPersistence 的取班口径必须命中该考试");

  // ③ 真正错位的组合（已公布却已结考 + 未公布未结考）不应被当作唯一合法形态：
  //    阅卷中未公布的考试同样必须可入库。
  const draft = (await db.run(
    "INSERT INTO exams (name, card_id, grade_id, class_id, status, score_published) VALUES ('阅卷中未公布', 'pub00001', ?, ?, 'grading', 0)",
    grade, cls,
  )).lastInsertRowid;
  runMigrations(getDatabase());
  assert.equal((await db.get<{ status: string }>("SELECT status FROM exams WHERE id = ?", draft))?.status, "grading",
    "③: 未公布的在阅考试同样不受迁移影响");
  // 两条 grading 考试时 resolveScannerExam 会因归属不确定返回 undefined（既有行为，此处只做显式记录）
  assert.equal((await resolveScannerExam("pub00001", "session-never-used")).exam, undefined,
    "③: 同卡多场在阅考试时归属不确定的既有语义不变");
  await db.run("DELETE FROM exams WHERE id = ?", draft);

  // ④ 迁移版本号：同号会被 schema_migrations 判重静默跳过，必须两套方言各自唯一。
  const sqliteSrc = readFileSync(path.resolve(HERE, "../src/server/db/migrations.ts"), "utf8");
  const mariaSrc = readFileSync(path.resolve(HERE, "../src/server/db/mysql.ts"), "utf8");
  const versions = (src: string) => [...src.matchAll(/\bversion:\s*(\d+)\b/g)].map((m) => Number(m[1]));
  const sqliteVersions = versions(sqliteSrc);
  const mariaVersions = versions(mariaSrc);
  for (const [name, list] of [["sqlite", sqliteVersions], ["mariadb", mariaVersions]] as const) {
    const dup = list.filter((v, i) => list.indexOf(v) !== i);
    assert.equal(dup.length, 0, `④: ${name} 迁移版本号重复：${dup.join(", ")}`);
  }
  // SQLite 侧最硬的一条证据：源里声明的每一个版本都必须在 schema_migrations 里记账，
  // 少一条就意味着同号被静默跳过（正是 #300/#301 撞号那类部署事故）。
  const applied = (await db.all<{ version: number }>("SELECT version FROM schema_migrations")).map((r) => Number(r.version));
  assert.equal(applied.length, new Set(applied).size, "④: 已应用的版本号自身不得重复");
  assert.deepEqual(applied.filter((v) => !sqliteVersions.includes(v)), [],
    "④: 存在未在任何迁移源中声明的已应用版本");
  assert.deepEqual([...new Set(sqliteVersions)].filter((v) => !applied.includes(v)), [],
    "④: SQLite 源里声明的迁移未全部记账（同号会被静默跳过）");
  assert.ok(sqliteVersions.length > 50 && mariaVersions.length > 40,
    `④: 迁移解析异常（sqlite ${sqliteVersions.length} / mariadb ${mariaVersions.length}）`);
  // v57 空置：错误状态修复已删除，同号不得复用，避免现场已记录 57 的库出现语义漂移。
  assert.equal(sqliteVersions.includes(57), false, "④: SQLite 不得复用 v57");
  assert.equal(mariaVersions.includes(57), false, "④: MariaDB 不得复用 v57");
  assert.equal(applied.includes(57), false, "④: 全新库不应记录 v57");
  assert.match(sqliteSrc, /v57：\*\*故意留空\*\*/, "④: SQLite 侧要留下 v57 空置的理由");
  assert.match(mariaSrc, /v57：\*\*故意留空\*\*/, "④: MariaDB 侧要留下 v57 空置的理由");
  for (const src of [sqliteSrc, mariaSrc]) {
    assert.equal(/repair-published-status-desync/.test(src), false, "④: 强制结考迁移必须彻底移除");
    assert.equal(/UPDATE exams SET status = 'closed'[^]*score_published = 1/.test(src), false,
      "④: 不得留下按发布标志批量改 status 的语句");
  }
  // 56/58 两套方言都在，且归档保护口径一致（评审 P1(4)）。
  for (const [name, list] of [["sqlite", sqliteVersions], ["mariadb", mariaVersions]] as const) {
    assert.ok(list.includes(56) && list.includes(58), `④: ${name} 应包含 v56 与 v58`);
  }
  assert.match(sqliteSrc, /dedupe-class-students[\s\S]{0,700}archived_at IS NULL[\s\S]{0,400}JOIN grades/,
    "④: SQLite v58 必须只清理未归档班级与年级的当前归属");
  assert.match(mariaSrc, /dedupe-class-students[\s\S]{0,900}archived_at IS NULL[\s\S]{0,600}JOIN grades/,
    "④: MariaDB v58 必须与 SQLite 同口径");

  console.log(`verify-grading-published-exam: 全部通过（sqlite 迁移 ${sqliteVersions.length} 条 / mariadb ${mariaVersions.length} 条，v57 空置，同号 58 归档保护一致）`);
} finally {
  const { closeDatabase } = await import("../src/server/db/index");
  closeDatabase();
}
