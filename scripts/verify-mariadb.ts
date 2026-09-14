/** Real MariaDB integration checks. Requires an empty, disposable projectx_ci database. */
import assert from "node:assert/strict";

async function main(): Promise<void> {
  // Validate explicit configuration before importing application modules. Never use config.yml.
  assert.ok(process.env.PROJECTX_MARIADB_HOST, "Set PROJECTX_MARIADB_HOST explicitly");
  assert.equal(process.env.PROJECTX_MARIADB_DATABASE, "projectx_ci", "Only projectx_ci is allowed");
  assert.ok(process.env.PROJECTX_MARIADB_USER, "Set PROJECTX_MARIADB_USER explicitly");
  assert.ok(process.env.PROJECTX_MARIADB_PASSWORD, "Set PROJECTX_MARIADB_PASSWORD explicitly");
  const { getMysqlDb, initMariadbSchema, resetAdapter, buildUpsertSQL, buildInsertIgnore } =
    await import("../src/server/db/mysql");
  const db = getMysqlDb();
  try {
    assert.equal(db.dialect, "mariadb");
    const server = await db.get<{ version: string; database_name: string }>(
      "SELECT VERSION() AS version, DATABASE() AS database_name",
    );
    assert.match(server!.version, /MariaDB/i);
    assert.equal(server!.database_name, "projectx_ci");
    assert.equal((await db.all("SHOW TABLES")).length, 0, "Test requires an empty database");
    console.log(`Testing ${server!.version}`);

    await initMariadbSchema();
    const migrations = await db.all<{ version: number; name: string }>(
      "SELECT version, name FROM schema_migrations ORDER BY version",
    );
    assert.ok(migrations.some((row) => row.version === 49), "Scanner receipts migration must be applied");
    assert.ok(await db.get("SHOW COLUMNS FROM scanner_submissions LIKE 'exam_id'"));
    assert.ok(await db.get("SHOW COLUMNS FROM answer_block_crops LIKE 'claimed_by'"));
    await initMariadbSchema();
    assert.deepEqual(await db.all("SELECT version, name FROM schema_migrations ORDER BY version"), migrations);
    console.log("PASS: fresh schema, migrations, repeated initialization");

    const upsert = buildUpsertSQL(db.dialect, "system_settings", ["key", "value"], ["key"]);
    const readValue = () => db.get<{ value: string }>("SELECT `value` FROM system_settings WHERE `key` = ?", "ci_test");
    const initial = "中文与 emoji 🧪 ' ?";
    await db.run(upsert, "ci_test", initial);
    assert.equal((await readValue())?.value, initial);
    await db.run(upsert, "ci_test", "updated");
    assert.equal((await readValue())?.value, "updated");
    await db.run(buildInsertIgnore(db.dialect, "system_settings", ["key", "value"]), "ci_test", "ignored");
    assert.equal((await readValue())?.value, "updated");
    console.log("PASS: parameter binding, utf8mb4, UPSERT, INSERT IGNORE");

    await db.transaction(async (tx) => {
      await tx.run(upsert, "ci_test", "committed");
    });
    assert.equal((await readValue())?.value, "committed");
    const rollback = new Error("intentional rollback");
    await assert.rejects(db.transaction(async (tx) => {
      await tx.run(upsert, "ci_test", "rolled back");
      await tx.run(upsert, "ci_rollback", "must not persist");
      throw rollback;
    }), (error: unknown) => error === rollback);
    assert.equal((await readValue())?.value, "committed");
    assert.equal(await db.get("SELECT `value` FROM system_settings WHERE `key` = ?", "ci_rollback"), null);
    assert.equal((await db.run("DELETE FROM system_settings WHERE `key` = ?", "ci_test")).changes, 1);
    assert.equal(await readValue(), null);
    console.log("PASS: transaction commit, rollback, delete");
  } finally {
    resetAdapter();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
