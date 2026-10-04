/** Real MariaDB integration checks. Requires an empty, disposable projectx_ci database. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

async function main(): Promise<void> {
  // Validate explicit configuration before importing application modules. Never use config.yml.
  assert.ok(process.env.PROJECTX_MARIADB_HOST, "Set PROJECTX_MARIADB_HOST explicitly");
  assert.equal(process.env.PROJECTX_MARIADB_DATABASE, "projectx_ci", "Only projectx_ci is allowed");
  assert.ok(process.env.PROJECTX_MARIADB_USER, "Set PROJECTX_MARIADB_USER explicitly");
  assert.ok(process.env.PROJECTX_MARIADB_PASSWORD, "Set PROJECTX_MARIADB_PASSWORD explicitly");
  // 管理员引导文件写在「数据库路径」的同目录；MariaDB 模式下把该指针指向临时目录，
  // 避免测试往仓库 data/ 里落真实的 bootstrap-admin.txt。
  const bootstrapTmpDir = mkdtempSync(path.join(tmpdir(), "projectx-mariadb-bootstrap-"));
  process.env.PROJECTX_DB_PATH = path.join(bootstrapTmpDir, "projectx.db");
  const { getMysqlDb, initMariadbSchema, resetAdapter, buildUpsertSQL, buildInsertIgnore } =
    await import("../src/server/db/mysql");
  const { ensureDefaultAdmin, getBootstrapAdminPath, hashPassword, verifyPassword } =
    await import("../src/server/db/index");
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
    assert.ok(await db.get("SHOW COLUMNS FROM twain_scan_sessions LIKE 'identity_mode'"));
    assert.ok(await db.get("SHOW COLUMNS FROM twain_scan_records LIKE 'identity_json'"));
    // Simulate a pre-QR installation and exercise the incremental migration too.
    await db.exec("ALTER TABLE twain_scan_sessions DROP COLUMN identity_mode");
    await db.exec("ALTER TABLE twain_scan_records DROP COLUMN identity_json");
    await db.run("DELETE FROM schema_migrations WHERE version = 51");
    await initMariadbSchema();
    assert.ok(await db.get("SHOW COLUMNS FROM twain_scan_sessions LIKE 'identity_mode'"));
    assert.ok(await db.get("SHOW COLUMNS FROM twain_scan_records LIKE 'identity_json'"));
    const migrations = await db.all<{ version: number; name: string }>(
      "SELECT version, name FROM schema_migrations ORDER BY version",
    );
    assert.ok(migrations.some((row) => row.version === 49), "Scanner receipts migration must be applied");
    assert.ok(migrations.some((row) => row.version === 53), "WeChat grade-release subscription migration must be applied");
    assert.ok(migrations.some((row) => row.version === 54), "Exam original-paper + answer-key migration must be applied");
    assert.ok(await db.get("SHOW COLUMNS FROM scanner_submissions LIKE 'exam_id'"));
    assert.ok(await db.get("SHOW COLUMNS FROM answer_block_crops LIKE 'claimed_by'"));
    await initMariadbSchema();
    assert.deepEqual(await db.all("SELECT version, name FROM schema_migrations ORDER BY version"), migrations);
    console.log("PASS: fresh schema, migrations, repeated initialization");

    // ===== R01 管理员引导口令（MariaDB 分支：buildInsertIgnore 新库路径 + 引导文件事实源）=====
    const adminFile = getBootstrapAdminPath();
    const readAdminRow = () => db.get<{ password_hash: string; password_change_required: number }>(
      "SELECT password_hash, password_change_required FROM users WHERE username = 'admin'",
    );
    await db.run("DELETE FROM users WHERE username = 'admin'");
    rmSync(adminFile, { force: true });

    const freshBootstrap = await ensureDefaultAdmin();
    const freshPassword = readFileSync(adminFile, "utf8").trim();
    assert.ok(freshBootstrap.rotated && freshBootstrap.adminId > 0, "MariaDB 新库应创建 admin 并标记轮换");
    assert.ok(freshPassword.length >= 16 && freshPassword !== "admin123", "MariaDB 新库口令为随机一次性值，不落公开常量");
    assert.equal(Number((await readAdminRow())!.password_change_required), 1, "MariaDB 新管理员被标记强制改密");
    assert.ok(await verifyPassword(freshPassword, (await readAdminRow())!.password_hash), "引导文件口令可通过 bcrypt 校验");

    const freshHash = (await readAdminRow())!.password_hash;
    const repeatBootstrap = await ensureDefaultAdmin();
    assert.equal(repeatBootstrap.rotated, false, "MariaDB 引导态库重复启动不得轮换口令");
    assert.equal((await readAdminRow())!.password_hash, freshHash, "哈希必须保持引导文件里那份，不恢复成固定值");
    assert.equal(readFileSync(adminFile, "utf8").trim(), freshPassword, "引导文件不得被重写");

    await db.run("UPDATE users SET password_hash = ?, password_change_required = 1 WHERE username = 'admin'", await hashPassword("admin123"));
    writeFileSync(adminFile, "admin123\n", { encoding: "utf8" });
    const upgradedBootstrap = await ensureDefaultAdmin();
    const upgradedPassword = readFileSync(adminFile, "utf8").trim();
    assert.equal(upgradedBootstrap.rotated, true, "残留历史公开口令的 MariaDB 库必须换发新口令");
    assert.notEqual(upgradedPassword, "admin123", "升级后引导文件不再是公开口令");
    assert.ok(await verifyPassword(upgradedPassword, (await readAdminRow())!.password_hash), "新随机口令生效");
    assert.equal(await verifyPassword("admin123", (await readAdminRow())!.password_hash), false, "admin123 在 MariaDB 侧同样失效");

    // 引导文件与库中哈希不匹配（跨机还原备份）：必须换发，否则管理员被锁死
    const stalePassword = freshPassword;
    await db.run("UPDATE users SET password_hash = ?, password_change_required = 1 WHERE username = 'admin'", await hashPassword("From-Other-Machine-Pw"));
    const mismatchBootstrap = await ensureDefaultAdmin();
    const mismatchPassword = readFileSync(adminFile, "utf8").trim();
    assert.equal(mismatchBootstrap.rotated, true, "文件与哈希不匹配时应换发口令");
    assert.notEqual(mismatchPassword, stalePassword, "旧的失配口令不得继续沿用");
    assert.ok(await verifyPassword(mismatchPassword, (await readAdminRow())!.password_hash), "失配场景下新口令生效");

    const changedHash = await hashPassword("Owner-Changed-2026!");
    await db.run("UPDATE users SET password_hash = ?, password_change_required = 0 WHERE username = 'admin'", changedHash);
    rmSync(adminFile, { force: true });
    const ownedBootstrap = await ensureDefaultAdmin();
    assert.equal(ownedBootstrap.rotated, false, "已改密的 MariaDB 账号不得被改写");
    assert.equal((await readAdminRow())!.password_hash, changedHash, "已改密哈希保持不变");
    assert.equal(existsSync(adminFile), false, "已改密后不得重新生成引导文件");

    process.env.PROJECTX_ADMIN_PASSWORD = "Hatch-Mariadb-2026!";
    try {
      await db.run("UPDATE users SET password_hash = ?, password_change_required = 1 WHERE username = 'admin'", await hashPassword("Pre-Hatch-Pw"));
      const hatchBootstrap = await ensureDefaultAdmin();
      assert.equal(hatchBootstrap.rotated, true, "逃生阀在引导态应接管口令");
      assert.equal(existsSync(adminFile), false, "逃生阀态不写引导文件");
      assert.ok(await verifyPassword("Hatch-Mariadb-2026!", (await readAdminRow())!.password_hash), "环境变量口令写入哈希");
      const hatchAgain = await ensureDefaultAdmin();
      assert.equal(hatchAgain.rotated, false, "环境变量口令与库一致时重复启动幂等");
    } finally {
      delete process.env.PROJECTX_ADMIN_PASSWORD;
    }
    console.log("PASS: mariadb admin bootstrap (fresh / stable source-of-truth / legacy invalidated / owned untouched / env hatch)");

    // v53 微信订阅：一个 openid 允许绑定多个学生，去重位是 exam_id 主键
    const wsbTables = await db.all<{ table_name: string }>(
      "SELECT TABLE_NAME AS table_name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('wechat_subscription_bindings','wechat_grade_release_notifications')",
    );
    assert.equal(wsbTables.length, 2, "wechat 订阅两张表必须存在");
    const wsbIndexes = await db.all<{ index_name: string; non_unique: number }>(
      "SELECT INDEX_NAME AS index_name, NON_UNIQUE AS non_unique FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'wechat_subscription_bindings'",
    );
    assert.ok(wsbIndexes.some((i) => i.index_name === "uk_wsb_student_template" && !Number(i.non_unique)),
      "UNIQUE(student_id, template_id) 必须保留");
    assert.ok(wsbIndexes.some((i) => i.index_name === "idx_wsb_openid" && Number(i.non_unique) === 1),
      "idx_wsb_openid 必须是普通索引");
    assert.ok(!wsbIndexes.some((i) => i.index_name.includes("openid") && !Number(i.non_unique)),
      "openid 不得再有唯一索引（一 openid 可绑多学生）");
    const wxA = await db.run(
      "INSERT INTO users (username, password_hash, name, role_id, student_number) VALUES ('wechat_ci_a', 'test-only', '微信订阅甲', 3, 'WX0000001')",
    );
    const wxB = await db.run(
      "INSERT INTO users (username, password_hash, name, role_id, student_number) VALUES ('wechat_ci_b', 'test-only', '微信订阅乙', 3, 'WX0000002')",
    );
    for (const id of [wxA.lastInsertRowid, wxB.lastInsertRowid]) {
      await db.run("INSERT INTO wechat_subscription_bindings (student_id, openid, template_id) VALUES (?, 'openid_shared_ci', 'TPL_CI')", id);
    }
    assert.equal((await db.all("SELECT id FROM wechat_subscription_bindings WHERE openid = 'openid_shared_ci'")).length, 2,
      "同一 openid 绑定两个学生应各存一行");
    await assert.rejects(
      db.run("INSERT INTO wechat_subscription_bindings (student_id, openid, template_id) VALUES (?, 'openid_dup_ci', 'TPL_CI')", wxA.lastInsertRowid),
      /Duplicate entry/,
    );
    console.log("PASS: wechat subscription bindings index semantics");

    // v54 原卷/答案：exams.show_original_paper 列 + 考试级答案表的复合主键与 UPSERT
    assert.ok(await db.get("SHOW COLUMNS FROM exams LIKE 'show_original_paper'"),
      "exams.show_original_paper 必须存在");
    const akTables = await db.all<{ table_name: string }>(
      "SELECT TABLE_NAME AS table_name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('exam_answer_keys','exam_answer_key_pages')",
    );
    assert.equal(akTables.length, 2, "exam_answer_keys / exam_answer_key_pages 必须存在");
    const akColumns = await db.all<{ column_name: string }>(
      "SELECT COLUMN_NAME AS column_name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'exam_answer_keys'",
    );
    for (const column of ["exam_id", "question_number", "answer_text", "page_index", "updated_by"]) {
      assert.ok(akColumns.some((c) => c.column_name === column), `exam_answer_keys.${column} 必须存在`);
    }
    const akIndexes = await db.all<{ index_name: string; seq: number; column_name: string }>(
      "SELECT INDEX_NAME AS index_name, SEQ_IN_INDEX AS seq, COLUMN_NAME AS column_name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'exam_answer_keys' AND INDEX_NAME = 'PRIMARY'",
    );
    assert.deepEqual(akIndexes.map((i) => `${i.seq}:${i.column_name}`).sort(), ["1:exam_id", "2:question_number"],
      "PRIMARY KEY(exam_id, question_number)：答案跟随考试而非答题卡");
    const akPageIndexes = await db.all<{ index_name: string; non_unique: number }>(
      "SELECT INDEX_NAME AS index_name, NON_UNIQUE AS non_unique FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'exam_answer_key_pages' AND INDEX_NAME = 'uq_exam_answer_key_pages'",
    );
    assert.ok(akPageIndexes.length === 2 && akPageIndexes.every((i) => !Number(i.non_unique)),
      "UNIQUE(exam_id, page_index) 保证同场考试页码不重复");
    const akExam = await db.run("INSERT INTO exams (name, score_published, show_original_paper) VALUES ('原卷答案CI', 1, 1)");
    assert.equal((await db.get<{ c: number }>("SELECT COUNT(*) AS c FROM exams WHERE id = ? AND show_original_paper = 1", akExam.lastInsertRowid))?.c, 1);
    const akUpsert = buildUpsertSQL(db.dialect, "exam_answer_keys",
      ["exam_id", "question_number", "answer_text", "page_index", "updated_by"],
      ["exam_id", "question_number"],
      ["answer_text", "page_index", "updated_by"]);
    await db.run(akUpsert, akExam.lastInsertRowid, 1, "BACD 中文 🧪", 1, null);
    assert.equal((await db.get<{ answer_text: string }>("SELECT answer_text FROM exam_answer_keys WHERE exam_id = ? AND question_number = 1", akExam.lastInsertRowid))?.answer_text, "BACD 中文 🧪",
      "utf8mb4 答案文字原样存取");
    await db.run(akUpsert, akExam.lastInsertRowid, 1, "AB", 2, null);
    assert.equal((await db.all("SELECT question_number FROM exam_answer_keys WHERE exam_id = ?", akExam.lastInsertRowid)).length, 1,
      "UPSERT 命中复合主键而非追加重复题号");
    assert.equal((await db.get<{ page_index: number }>("SELECT page_index FROM exam_answer_keys WHERE exam_id = ? AND question_number = 1", akExam.lastInsertRowid))?.page_index, 2);
    await assert.rejects(
      db.run("INSERT INTO exam_answer_key_pages (exam_id, page_index, filename, stored_path) VALUES (?, 1, 'answerkey.jpg', 'x')", akExam.lastInsertRowid)
        .then(() => db.run("INSERT INTO exam_answer_key_pages (exam_id, page_index, filename, stored_path) VALUES (?, 1, 'answerkey.jpg', 'x')", akExam.lastInsertRowid)),
      /Duplicate entry/,
    );
    await db.run("DELETE FROM exam_answer_key_pages WHERE exam_id = ?", akExam.lastInsertRowid);
    await db.run("DELETE FROM exam_answer_keys WHERE exam_id = ?", akExam.lastInsertRowid);
    await db.run("DELETE FROM exams WHERE id = ?", akExam.lastInsertRowid);
    console.log("PASS: exam show_original_paper, exam-scoped answer keys, page uniqueness");

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
    const { assertScoresPublishable } = await import("../src/server/services/examPublication");
    const publicationExam = { id: Number(exam.lastInsertRowid) };
    await assertScoresPublishable(db, publicationExam); // No roster required.
    const absent = await db.run("INSERT INTO users (username, password_hash, name, role_id) VALUES ('absent_publish', 'test-only', '尚未出分', 3)");
    await db.run("INSERT INTO exam_participants (exam_id, student_id, source) VALUES (?, ?, 'explicit'), (?, ?, 'explicit')",
      publicationExam.id, student.lastInsertRowid, publicationExam.id, absent.lastInsertRowid);
    await assertScoresPublishable(db, publicationExam); // One of two students has scores.
    await db.run("DELETE FROM exam_participants WHERE exam_id = ? AND student_id = ?", publicationExam.id, student.lastInsertRowid);
    await assert.rejects(assertScoresPublishable(db, publicationExam), /非应考学生/);
    await db.run("DELETE FROM exam_participants WHERE exam_id = ?", publicationExam.id);
    await db.run("DELETE FROM student_scores WHERE exam_id = ?", publicationExam.id);
    await assert.rejects(assertScoresPublishable(db, publicationExam), /尚无成绩/);
    await db.run("INSERT INTO student_scores (exam_id, student_id, total_score) VALUES (?, ?, 50)", publicationExam.id, student.lastInsertRowid);
    console.log("PASS: partial score publication, unknown roster, outsider and empty-score rejection");
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

    // ===== R22 扫描会话创建：会话行与其全部待上传页必须在同一事务内落库 =====
    // 路由用 `db.transaction(tx => …)` 写入 N 页；MariaDB 下若方言差异导致部分失败，
    // 会留下「会话存在但缺页」的半成品，客户端 complete 会因页数为 0 而卡死。
    await db.transaction(async (tx) => {
      await tx.run(
        `INSERT INTO twain_scan_sessions (id, card_id, name, dpi, duplex, color_mode, paper_size, page_count, identity_mode, status)
         VALUES ('r22_session', 'r22_card', 'r22_session', 300, 1, 'gray', 'A4', 3, 'qr', 'uploading')`);
      for (let page = 1; page <= 3; page++) {
        await tx.run(
          `INSERT INTO twain_scan_records (id, session_id, card_id, image_path, page_num, side, ocr_status)
           VALUES (?, 'r22_session', 'r22_card', ?, ?, ?, 'pending')`,
          `r22_token_${page}`, `pending:r22_token_${page}`, page, page === 1 ? "front" : "back");
      }
    });
    assert.equal(Number((await db.get<{ page_count: number }>("SELECT page_count FROM twain_scan_sessions WHERE id='r22_session'"))?.page_count), 3);
    assert.equal((await db.all("SELECT id FROM twain_scan_records WHERE session_id='r22_session'")).length, 3);
    await assert.rejects(db.transaction(async (tx) => {
      await tx.run(
        `INSERT INTO twain_scan_sessions (id, card_id, name, dpi, duplex, color_mode, paper_size, page_count, identity_mode, status)
         VALUES ('r22_rollback', 'r22_card', 'r22_rollback', 300, 1, 'gray', 'A4', 1, 'qr', 'uploading')`);
      await tx.run(
        `INSERT INTO twain_scan_records (id, session_id, card_id, image_path, page_num, side, ocr_status)
         VALUES ('r22_bad', 'r22_rollback', 'r22_card', 'pending:r22_bad', 1, 'front', 'pending')`);
      throw new Error("intentional session rollback");
    }));
    assert.equal(await db.get("SELECT id FROM twain_scan_sessions WHERE id='r22_rollback'"), null);
    assert.equal(await db.get("SELECT id FROM twain_scan_records WHERE id='r22_bad'"), null);
    await db.run("DELETE FROM twain_scan_records WHERE session_id='r22_session'");
    await db.run("DELETE FROM twain_scan_sessions WHERE id='r22_session'");
    console.log("PASS: scanner session + pending pages commit atomically, rollback leaves no half session (R22)");

    // Real MariaDB: replacing/clearing a head must also remove unmarked legacy links.
    const { ClassRepository } = await import("../src/server/repositories/ClassRepository");
    const classRepo = new ClassRepository();
    const headGrade = await db.run("INSERT INTO grades (name) VALUES ('head_cleanup_grade')");
    const headClass = await db.run("INSERT INTO classes (grade_id, name) VALUES (?, 'head_cleanup_class')", headGrade.lastInsertRowid);
    const otherHeadClass = await db.run("INSERT INTO classes (grade_id, name) VALUES (?, 'head_cleanup_other')", headGrade.lastInsertRowid);
    const headIds: number[] = [];
    for (let i = 0; i < 3; i++) {
      const teacher = await db.run("INSERT INTO users (username, password_hash, name, role_id, teacher_role, subject) VALUES (?, 'test-only', ?, 2, 'head_teacher', '数学')", `head_cleanup_${i}`, `head_cleanup_${i}`);
      headIds.push(Number(teacher.lastInsertRowid));
    }
    const headClassId = Number(headClass.lastInsertRowid);
    await db.run("INSERT INTO teacher_classes (teacher_id, class_id, subject, is_head_teacher) VALUES (?, ?, NULL, 1), (?, ?, NULL, 0), (?, ?, '数学', 0)", headIds[0], headClassId, headIds[1], headClassId, headIds[2], headClassId);
    await db.run("INSERT INTO teacher_classes (teacher_id, class_id, subject) VALUES (?, ?, NULL)", headIds[1], otherHeadClass.lastInsertRowid);
    await classRepo.replaceClassHeadTeacher(headClassId, headIds[2]);
    assert.equal((await db.all("SELECT teacher_id FROM teacher_classes WHERE class_id = ?", headClassId)).length, 1);
    await classRepo.replaceClassHeadTeacher(headClassId, null);
    const retainedTeacher = await db.get<{ subject: string; is_head_teacher: number }>("SELECT subject, is_head_teacher FROM teacher_classes WHERE teacher_id = ? AND class_id = ?", headIds[2], headClassId);
    assert.equal(retainedTeacher?.subject, "数学");
    assert.equal(Number(retainedTeacher?.is_head_teacher), 0);
    assert.ok(await db.get("SELECT 1 FROM teacher_classes WHERE teacher_id = ? AND class_id = ?", headIds[1], otherHeadClass.lastInsertRowid));
    // A class with only unmarked old relationships can be cleared directly, too.
    await classRepo.replaceClassHeadTeacher(Number(otherHeadClass.lastInsertRowid), null);
    assert.equal((await db.all("SELECT teacher_id FROM teacher_classes WHERE class_id = ?", otherHeadClass.lastInsertRowid)).length, 0);
    console.log("PASS: head teacher cleanup preserves subject/other-class links and removes legacy links");
  } finally {
    resetAdapter();
    rmSync(bootstrapTmpDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
