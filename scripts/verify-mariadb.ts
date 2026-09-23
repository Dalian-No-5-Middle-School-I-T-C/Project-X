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

    const { searchStudentsForExam } = await import("../src/server/services/examParticipants");
    const student = await db.run(
      "INSERT INTO users (username, password_hash, name, role_id, student_number) VALUES (?, ?, ?, 3, ?)",
      "search_regression", "test-only", "搜索!_%\\测试", "09210001",
    );
    for (const keyword of ["0921", "搜索", "!", "_", "%", "\\"]) {
      const matches = await searchStudentsForExam(db, 1, keyword);
      assert.equal(matches.length, 1);
      assert.equal(matches[0].id, student.lastInsertRowid);
    }
    assert.equal((await searchStudentsForExam(db, 1, "不存在")).length, 0);
    const { findSavedScannerOwners } = await import("../src/server/services/scannerSubmissions");
    await db.exec("ALTER TABLE scanner_submissions MODIFY student_number VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL");
    await db.run("INSERT INTO answer_cards (id, title) VALUES ('receipt_ci', '回执测试')");
    const exam = await db.run("INSERT INTO exams (name, card_id) VALUES ('回执测试', 'receipt_ci')");
    await db.run("INSERT INTO student_scores (exam_id, student_id, total_score) VALUES (?, ?, 50)", exam.lastInsertRowid, student.lastInsertRowid);
    await db.run("INSERT INTO scanner_submissions (exam_id, session_id, group_id, student_number, state, pages_json) VALUES (?, 'session_ci', 'group_ci', '09210001', 'saved', '[]')", exam.lastInsertRowid);
    assert.deepEqual(await findSavedScannerOwners(db, "session_ci", "group_ci", "09210001", "receipt_ci"),
      [{ exam_id: exam.lastInsertRowid, student_id: student.lastInsertRowid }]);
    assert.equal((await findSavedScannerOwners(db, "session_ci", "group_ci", "09210002", "receipt_ci")).length, 0);
    assert.equal((await findSavedScannerOwners(db, "session_ci", "group_ci", "09210001", "other_card")).length, 0);
    // 使用真实成绩修改路由，防止另一条学生搜索路径重新引入反斜杠 ESCAPE。
    const { default: express } = await import("express");
    const { default: scoreEditingRouter } = await import("../src/server/routes/score-editing");
    const app = express();
    app.use((req, _res, next) => { req.user = { id: student.lastInsertRowid, role_name: "admin" } as any; next(); });
    app.use("/api/exams", scoreEditingRouter);
    const httpServer = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => httpServer.once("listening", resolve));
    try {
      const address = httpServer.address() as { port: number };
      for (const keyword of ["09210001", "搜索", "!", "_", "%", "\\"]) {
        const response = await fetch(`http://127.0.0.1:${address.port}/api/exams/${exam.lastInsertRowid}/students/search?q=${encodeURIComponent(keyword)}`);
        assert.equal(response.status, 200);
        const matches = await response.json() as Array<{ id: number }>;
        assert.deepEqual(matches.map(row => row.id), [student.lastInsertRowid]);
      }
    } finally { await new Promise<void>((resolve, reject) => httpServer.close(error => error ? reject(error) : resolve())); }

    const { createAiAnalysisJob, getLatestAiAnalysisJob } = await import("../src/server/services/aiAnalysisJobs");
    const jobId = await createAiAnalysisJob({ examId: exam.lastInsertRowid, createdBy: student.lastInsertRowid });
    const savedReport = { model: "test", report: { overallJudgement: "持久化报告" } };
    await db.run("UPDATE ai_analysis_jobs SET status = 'done', result = ? WHERE id = ?", JSON.stringify(savedReport), jobId);
    const restored = await getLatestAiAnalysisJob({ examId: exam.lastInsertRowid }, student.lastInsertRowid);
    assert.equal(restored?.id, jobId);
    assert.deepEqual(restored?.result, savedReport);
    assert.equal(await getLatestAiAnalysisJob({ examId: exam.lastInsertRowid }, student.lastInsertRowid, 0), null);
    assert.equal(await getLatestAiAnalysisJob({ examId: exam.lastInsertRowid }, -1), null);
    await db.run("DELETE FROM ai_analysis_jobs WHERE id = ?", jobId);
    console.log("PASS: score-editing search route and persisted AI report recovery");
    await db.run("DELETE FROM exams WHERE id = ?", exam.lastInsertRowid);
    await db.run("DELETE FROM answer_cards WHERE id = 'receipt_ci'");
    await db.run("DELETE FROM users WHERE id = ?", student.lastInsertRowid);
    console.log("PASS: participant search, literal wildcard escaping, mixed-collation scanner receipts");

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
