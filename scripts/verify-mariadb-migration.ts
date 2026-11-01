import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import mysql from "mysql2/promise";
import { runMigrations } from "../src/server/db/migrations";
import { getMysqlDb, initMariadbSchema, resetAdapter } from "../src/server/db/mysql";
import { databaseTimestamp } from "../src/server/db/timestamp";

assert.equal(process.env.PROJECTX_MARIADB_HOST, "127.0.0.1");
assert.equal(process.env.PROJECTX_MARIADB_DATABASE, "projectx_migration_test");
const conn = await mysql.createConnection({
  host: process.env.PROJECTX_MARIADB_HOST,
  port: Number(process.env.PROJECTX_MARIADB_PORT || 3306),
  user: process.env.PROJECTX_MARIADB_USER,
  password: process.env.PROJECTX_MARIADB_PASSWORD,
  database: process.env.PROJECTX_MARIADB_DATABASE,
  dateStrings: true,
});
const dir = mkdtempSync(path.join(tmpdir(), "mariadb-migration-"));
const sourcePath = path.join(dir, "source.db");
const digest = () => createHash("sha256").update(readFileSync(sourcePath)).digest("hex");
function migrate(args: string[]): string {
  const before = digest();
  // Migration-version mapping has separate semantics from business-table copying.
  // Keep it out of the fixture's data/row comparison in this regression.
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/migrate-to-mariadb.ts",
    "--skip-tables=schema_migrations", ...args], {
    cwd: process.cwd(), encoding: "utf8", timeout: 120000,
    env: { ...process.env, PROJECTX_DB_PATH: sourcePath },
  });
  assert.equal(digest(), before, "The source must stay byte-for-byte unchanged in every mode");
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
try {
  const [tables] = await conn.query<any[]>("SELECT TABLE_NAME FROM information_schema.tables WHERE table_schema = DATABASE()");
  assert.equal(tables.length, 0, "Use an empty disposable database");
  getMysqlDb();
  await initMariadbSchema();
  const source = new Database(sourcePath);
  try {
    source.exec(readFileSync("src/server/db/schema.sql", "utf8"));
    runMigrations(source);
    // 反馈时间用 SQLite 路由真实写入的 ISO（带 Z），覆盖跨时区/跨日归一化。
    const feedbackCreated = databaseTimestamp(new Date("2026-10-27T23:30:00Z"), "sqlite");
    const feedbackUpdated = databaseTimestamp(new Date("2026-10-28T02:00:00Z"), "sqlite");
    const feedbackResolved = databaseTimestamp(new Date("2026-10-28T02:00:00Z"), "sqlite");
    const feedbackAttachmentCreated = databaseTimestamp(new Date("2026-10-27T23:45:00Z"), "sqlite");
    source.exec(`
      INSERT INTO grades(id,name) VALUES (1,'迁移年级');
      INSERT INTO classes(id,grade_id,name) VALUES (1,1,'迁移班级');
      INSERT INTO users(id,username,password_hash,name,role_id,student_number)
        VALUES (1,'migration-student','disabled','迁移学生',3,'M001');
      INSERT INTO users(id,username,password_hash,name,role_id)
        VALUES (2,'migration-resolver','disabled','迁移处理人',2);
      INSERT INTO class_students(class_id,student_id) VALUES (1,1);
      INSERT INTO exams(id,name,status,grade_id) VALUES (1,'历史考试','grading',1);
      INSERT INTO student_scores(id,exam_id,student_id,total_score) VALUES (1,1,1,80);
      INSERT INTO feedback_reports
        (id,user_id,username,display_name,role_name,category,title,content,contact,context_json,status,created_at,updated_at,resolved_at,resolved_by)
        VALUES (1,1,'migration-student','迁移学生','student','problem','迁移反馈','反馈正文','contact@example.com',
          '{"client":{"page":"/global-settings"},"server":{"platform":"test"}}','resolved',
          '${feedbackCreated}','${feedbackUpdated}','${feedbackResolved}',2);
      INSERT INTO feedback_attachments
        (id,feedback_id,filename,stored_path,mime,size_bytes,created_at)
        VALUES (1,1,'说明.txt','feedback/test/0.txt','text/plain',5,'${feedbackAttachmentCreated}');
      DROP TABLE scan_correction_pages;
      DELETE FROM schema_migrations WHERE version IN (62,64);
      DROP TABLE exam_class_memberships;
      DELETE FROM schema_migrations WHERE version = 59;
    `);
  } finally { source.close(); }

  const dry = migrate(["--dry-run"]);
  assert.match(dry, /exam_class_memberships.*SQLite/);
  const [dryUsers] = await conn.query<any[]>("SELECT COUNT(*) AS n FROM users");
  assert.equal(Number(dryUsers[0].n), 0, "Dry-run must not copy business data");
  console.log("PASS: pre-v59 dry-run skips the absent table without changing either database");

  migrate(["--skip-backup", "--sample=2"]);
  const [scores] = await conn.query<any[]>("SELECT total_score FROM student_scores WHERE exam_id = 1 AND student_id = 1");
  assert.equal(Number(scores[0].total_score), 80);
  const [feedback] = await conn.query<any[]>(
    "SELECT user_id, resolved_by, title, content, contact, context_json, status, created_at, updated_at, resolved_at FROM feedback_reports WHERE id = 1"
  );
  assert.equal(Number(feedback[0].user_id), 1);
  assert.equal(Number(feedback[0].resolved_by), 2);
  assert.equal(feedback[0].title, "迁移反馈");
  assert.equal(feedback[0].content, "反馈正文");
  assert.equal(feedback[0].contact, "contact@example.com");
  assert.equal(feedback[0].context_json, '{"client":{"page":"/global-settings"},"server":{"platform":"test"}}');
  assert.equal(feedback[0].status, "resolved");
  const created = databaseTimestamp(new Date("2026-10-27T23:30:00Z"), "mariadb").replace(/\.\d+$/, "");
  const updated = databaseTimestamp(new Date("2026-10-28T02:00:00Z"), "mariadb").replace(/\.\d+$/, "");
  assert.equal(feedback[0].created_at, created);
  assert.equal(feedback[0].updated_at, updated);
  assert.equal(feedback[0].resolved_at, updated);
  console.log("PASS: feedback rows keep submitter, resolver, context JSON and normalized timestamps");
  const [attachments] = await conn.query<any[]>(
    "SELECT filename, stored_path, mime, size_bytes, created_at FROM feedback_attachments WHERE id = 1"
  );
  assert.equal(attachments[0].filename, "说明.txt");
  assert.equal(attachments[0].stored_path, "feedback/test/0.txt");
  assert.equal(attachments[0].mime, "text/plain");
  assert.equal(Number(attachments[0].size_bytes), 5);
  assert.equal(
    attachments[0].created_at,
    databaseTimestamp(new Date("2026-10-27T23:45:00Z"), "mariadb").replace(/\.\d+$/, "")
  );
  console.log("PASS: feedback attachments migrate with metadata and normalized timestamp");
  const [oldSnapshots] = await conn.query<any[]>("SELECT COUNT(*) AS n FROM exam_class_memberships");
  assert.equal(Number(oldSnapshots[0].n), 0, "Migration must not invent historical classes");
  migrate(["--verify-only", "--sample=2"]);
  console.log("PASS: pre-v59 full migration and verification retain existing scores and no invented snapshots");

  const upgraded = new Database(sourcePath);
  try {
    runMigrations(upgraded);
    upgraded.prepare("INSERT INTO scan_correction_pages(source_type,source_id,card_version,layout_json,recognition_json,revision) VALUES (?,?,?,?,?,?)")
      .run("twain_scan_record","migration-page","v1",'{"pageNumber":1}','{"geometry":{"imageWidth":2100}}',1720000000000);
    upgraded.prepare("UPDATE scan_correction_pages SET recovery_fingerprint=? WHERE source_id='migration-page'").run("a".repeat(64));
    upgraded.prepare("INSERT INTO exam_class_memberships(exam_id,student_id,class_id,joined_at) VALUES (1,1,1,'2026-10-04 08:00:00'),(1,1,0,NULL)").run();
  } finally { upgraded.close(); }
  migrate(["--dry-run"]);
  migrate(["--skip-backup", "--sample=2"]);
  migrate(["--verify-only", "--sample=2"]);
  const [snapshots] = await conn.query<any[]>("SELECT class_id, joined_at FROM exam_class_memberships WHERE exam_id = 1 AND student_id = 1 ORDER BY class_id");
  assert.deepEqual(snapshots.map(r => Number(r.class_id)), [0, 1], "Present tables must migrate all composite-key rows, including the unknown-class sentinel");
  assert.equal(snapshots[1].joined_at, "2026-10-04 08:00:00", "Snapshot timestamps must remain unchanged");
  const [corrections] = await conn.query<any[]>("SELECT recognition_json, revision, recovery_fingerprint FROM scan_correction_pages WHERE source_id='migration-page'");
  assert.equal(corrections[0].recognition_json,'{"geometry":{"imageWidth":2100}}');
  assert.equal(Number(corrections[0].revision),1720000000000);
  assert.equal(corrections[0].recovery_fingerprint,"a".repeat(64));
  console.log("PASS: v59 snapshots migrate and verify by their composite key; source remains read-only");
} finally {
  await conn.end();
  await resetAdapter();
  assert.equal(path.dirname(path.resolve(dir)), path.resolve(tmpdir()));
  rmSync(dir, {recursive: true, force: true});
}
