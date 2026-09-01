/**
 * 五轮测试 A1 回归：跨方言 UPSERT / INSERT IGNORE 标识符引用。
 * MariaDB 必须给保留字列（key 等）加反引号；SQLite 用双引号等价。
 * 用法：npx tsx scripts/verify-round5-db-upsert.ts（期望全绿，退出码 0）
 */
import { buildUpsertSQL, buildInsertIgnore } from "../src/server/db/mysql";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(cond: boolean, label: string): void {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { failed++; failures.push(label); console.log(`  \x1b[31m✗\x1b[0m ${label}`); }
}
function section(title: string): void {
  console.log(`\n\x1b[36m== ${title} ==\x1b[0m`);
}

section("buildUpsertSQL — sqlite 分支对保留字列加双引号");
const sqliteUpsert = buildUpsertSQL("sqlite", "system_settings", ["key", "value", "updated_at"], ["key"], ["value", "updated_at"]);
ok(sqliteUpsert.includes('INSERT INTO system_settings ("key", "value", "updated_at")'), "列清单带双引号");
ok(sqliteUpsert.includes('ON CONFLICT("key")'), "冲突列带双引号");
ok(sqliteUpsert.includes('"value" = excluded."value"'), "SET 子句带双引号");

section("buildUpsertSQL — mariadb 分支对保留字列加反引号");
const mariadbUpsert = buildUpsertSQL("mariadb", "system_settings", ["key", "value", "updated_at"], ["key"], ["value", "updated_at"]);
ok(mariadbUpsert.includes("INSERT INTO system_settings (`key`, `value`, `updated_at`)"), "列清单带反引号");
ok(mariadbUpsert.includes("ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)"), "SET 子句带反引号");
ok(!mariadbUpsert.includes("= VALUE(") && !mariadbUpsert.includes("= VALUE'"), "不含 MySQL 8 别名 VALUE 写法");

section("buildInsertIgnore — 两方言列名均被引用");
ok(buildInsertIgnore("sqlite", "objective_blocks", ["id", "card_id"]).includes('INSERT OR IGNORE INTO objective_blocks ("id", "card_id")'), "sqlite 引用");
ok(buildInsertIgnore("mariadb", "objective_blocks", ["id", "card_id"]).includes("INSERT IGNORE INTO objective_blocks (`id`, `card_id`)"), "mariadb 引用");

section("普通列名引用后语义不变（无多余引号）");
ok(buildUpsertSQL("sqlite", "t", ["a", "b"], ["a"]).includes('"a"'), "sqlite a 引用");
ok(buildUpsertSQL("mariadb", "t", ["a", "b"], ["a"]).includes("`a`"), "mariadb a 引用");

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) { console.error("失败项:\n" + failures.map((f) => "  - " + f).join("\n")); process.exit(1); }