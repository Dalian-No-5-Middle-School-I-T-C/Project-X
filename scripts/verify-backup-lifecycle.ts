/** Actual createApp HTTP backup/restore, including rollback, disconnect and recovery fencing.
 * SQLite: npm run verify:backup-lifecycle [-- --large]
 * MariaDB: dedicated empty projectx_backup_test on 127.0.0.1, plus --mariadb.
 * --large uploads 15 x 99 MiB using a bounded stream and verifies restored downloads.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const maria = process.argv.includes("--mariadb");
const large = process.argv.includes("--large");
if (maria) {
  assert.equal(process.env.PROJECTX_MARIADB_HOST, "127.0.0.1");
  assert.equal(process.env.PROJECTX_MARIADB_DATABASE, "projectx_backup_test");
} else {
  delete process.env.PROJECTX_MARIADB_HOST;
  delete process.env.PROJECTX_MYSQL_HOST;
}
const root = await fs.mkdtemp(path.join(tmpdir(), "projectx-backup-lifecycle-"));
const cwd = process.cwd();
process.chdir(root);
process.env.TMPDIR = root;
process.env.TEMP = root;
process.env.TMP = root;
process.env.PROJECTX_DB_PATH = path.join(root, "data", "projectx.db");
process.env.ANSWER_CARD_DATA_DIR = path.join(root, "data"); // exercise DB inside replaced tree
process.env.PROJECTX_TOKEN_DIR = path.join(root, "tokens");
process.env.PROJECTX_ENABLE_SCANNER = "0";
delete process.env.PROJECTX_ADMIN_PASSWORD;
delete process.env.PROJECTX_SECRET_KEY;
delete process.env.PROJECTX_FEEDBACK_ATTACHMENT_TOTAL_MIB;
const dbModule = await import("../src/server/db/index");
const { closeAdapter } = await import("../src/server/db/mysql");
const { getDb: scannerDb, closeDb } = await import("../src/apps/answer-card/server/database");
const { withServiceMaintenance, isServiceMaintenanceActive } = await import("../src/server/lib/serviceTasks");
const { restoreRecoveryMarkerPath } = await import("../src/server/lib/restoreRecovery");
const { createApp } = await import("../src/apps/answer-card/server/index");
const { analysisCache } = await import("../src/server/services/analysisCache");
const { getAnalysisThresholds, invalidateAnalysisThresholdsCache } = await import("../src/server/services/analysisConfig");
const { readPapersTotalBytes, invalidatePaperUsageCache } = await import("../src/apps/answer-card/server/paperQuota");
const { authService } = await import("../src/server/services/AuthService");
const { encryptField, decryptField, invalidateSecretKeyCache } = await import("../src/server/lib/field-crypto");
const { readAiQuotaSnapshot } = await import("../src/server/services/aiQuota");
if (maria) {
  const row = await dbModule.getMysqlDb().get<{ n: number }>("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE()");
  assert.equal(Number(row?.n), 0, "Use a fresh disposable database");
}
let server: http.Server | undefined;
let checks = 0;
const pass = (name: string) => { checks++; console.log(`PASS ${name}`); };
const originalRm = fs.rm;
let token = "";
const password = "BackupLifecycle-2026!";
const login = async () => {
  const result = await authService.login("admin", password);
  assert.equal(result.success, true); assert.ok(result.token); token = result.token;
};
const hashFile = async (file: string) => {
  const hash = createHash("sha256"); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest("hex");
};
try {
  const app = await createApp();
  server = http.createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const admin = await dbModule.getMysqlDb().get<{ id: number }>("SELECT id FROM users WHERE username='admin'");
  assert.ok(admin);
  const boot = (await fs.readFile(path.join(root, "data", "bootstrap-admin.txt"), "utf8")).trim();
  assert.equal((await authService.changePassword(admin.id, boot, password)).success, true);
  await login();
  const headers = () => ({ Authorization: `Bearer ${token}` });
  const request = (route: string, init: RequestInit = {}) => fetch(base + route, { ...init, headers: { ...headers(), ...init.headers } });
  const json = async (route: string, init: RequestInit = {}) => { const res = await request(route, init); return { status: res.status, body: await res.json() }; };
  const restore = async (file: string) => json("/api/db/restore", {
    method: "POST", headers: { "Content-Type": "application/zip" }, body: createReadStream(file) as unknown as BodyInit, duplex: "half",
  } as RequestInit);
  const backup = path.join(root, "snapshot.zip");
  const fixture = path.join(root, "payload.bin");
  const chunk = randomBytes(1024 * 1024);
  const fileMib = large ? 99 : 4;
  await pipeline(Readable.from((async function* () { for (let i = 0; i < fileMib; i++) yield chunk; })()), createWriteStream(fixture));
  const expectedHash = await hashFile(fixture);
  const count = large ? 15 : 2;
  const boundary = "lifecycle-test-boundary";
  async function* multipart() {
    for (const [name, value] of Object.entries({ title: "snapshot A", content: "restore lifecycle", category: "problem" })) {
      yield Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
    }
    for (let i = 0; i < count; i++) {
      yield Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="fixture-${i}.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`);
      yield* createReadStream(fixture); yield Buffer.from("\r\n");
    }
    yield Buffer.from(`--${boundary}--\r\n`);
  }
  const created = await json("/api/feedback", { method: "POST", headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` }, body: Readable.from(multipart()) as unknown as BodyInit, duplex: "half" } as RequestInit);
  assert.equal(created.status, 201, JSON.stringify(created));
  const feedbackId = Number(created.body.data?.id);
  assert.ok(feedbackId, JSON.stringify(created));
  pass(`actual upload ${count} x ${fileMib} MiB`);
  if (!maria) { scannerDb().exec("CREATE TABLE restore_probe(value TEXT); INSERT INTO restore_probe VALUES ('A')"); }
  const extra = path.join(root, "data", "backgrounds", "snapshot.txt");
  await fs.mkdir(path.dirname(extra), { recursive: true }); await fs.writeFile(extra, "A");
  const paper = path.join(root, "data", "papers", "cache-probe", "original.bin");
  await fs.mkdir(path.dirname(paper), { recursive: true }); await fs.writeFile(paper, "A");
  const originalPassRate = (await getAnalysisThresholds()).passRate;
  assert.equal((await readPapersTotalBytes()).bytes, 1);
  await dbModule.getMysqlDb().run(
    "INSERT INTO ai_providers (user_id, name, provider_type, api_key) VALUES (?, ?, ?, ?)",
    admin.id, "restore-key-probe", "openai", encryptField("snapshot secret"),
  );
  // Historical backups may contain queue rows without any live process task.
  await dbModule.getMysqlDb().run("INSERT INTO ai_analysis_jobs (status, created_by) VALUES ('queued', ?)", admin.id);
  await dbModule.getMysqlDb().run("INSERT INTO ai_analysis_jobs (status, created_by) VALUES ('queued', ?)", admin.id);
  await dbModule.getMysqlDb().run("INSERT INTO ai_analysis_jobs (status, created_by) VALUES ('running', ?)", admin.id);
  await dbModule.getMysqlDb().run("INSERT INTO ai_analysis_runs (user_id, feature, success) VALUES (?, 'restored-pending', NULL)", admin.id);
  await dbModule.getMysqlDb().run("INSERT INTO ai_analysis_runs (user_id, feature, success) VALUES (?, 'restored-done', 1)", admin.id);
  const providerSecret = async () => decryptField((await dbModule.getMysqlDb().get<{ api_key: string }>(
    "SELECT api_key FROM ai_providers WHERE name = ?", "restore-key-probe",
  ))!.api_key);
  const download = await request("/api/db/backup");
  assert.equal(download.status, 200, download.status === 200 ? "" : await download.text());
  await pipeline(Readable.fromWeb(download.body as any), createWriteStream(backup));
  pass(`backup downloaded ${(await fs.stat(backup)).size} bytes`);

  // Receiving response headers means the immutable snapshot is ready. Leave ZIP unread.
  const paused = await new Promise<{ req: http.ClientRequest; res: http.IncomingMessage }>((resolve, reject) => {
    const req = http.get(base + "/api/db/backup", { headers: headers() }, (res) => { res.pause(); resolve({ req, res }); }); req.on("error", reject);
  });
  assert.equal(paused.res.statusCode, 200);
  const duringDownload = await json("/api/feedback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "while downloading", content: "still writable", category: "problem" }), signal: AbortSignal.timeout(5000) });
  assert.equal(duringDownload.status, 201, JSON.stringify(duringDownload));
  paused.req.destroy(); paused.res.destroy();
  await withServiceMaintenance({} as any, async () => undefined);
  assert.equal((await fs.readdir(root)).filter(n => n.startsWith("projectx-backup-")).length, 0);
  pass("slow/disconnected backup frees mutation lock and cleans snapshot");

  const mutate = async () => {
    await dbModule.getMysqlDb().run("DELETE FROM ai_analysis_jobs");
    await dbModule.getMysqlDb().run("DELETE FROM ai_analysis_runs");
    await dbModule.getMysqlDb().run("INSERT INTO ai_analysis_jobs (status, created_by) VALUES ('queued', ?)", admin.id);
    await dbModule.getMysqlDb().run("INSERT INTO ai_analysis_runs (user_id, feature, success) VALUES (?, 'live-pending', NULL)", admin.id);
    await fs.writeFile(path.join(root, "data", "secret.key"), randomBytes(32));
    invalidateSecretKeyCache();
    await dbModule.getMysqlDb().run("UPDATE ai_providers SET api_key = ? WHERE name = ?", encryptField("live secret"), "restore-key-probe");
    await dbModule.getMysqlDb().run("UPDATE feedback_reports SET title = ? WHERE id = ?", "live B", feedbackId);
    await fs.writeFile(extra, "B");
    await fs.writeFile(paper, "BBBB"); invalidatePaperUsageCache();
    assert.equal((await readPapersTotalBytes()).bytes, 4);
    await dbModule.getMysqlDb().run("DELETE FROM system_settings WHERE `key` = ?", "analysis_pass_rate");
    await dbModule.getMysqlDb().run("INSERT INTO system_settings (`key`, value) VALUES (?, ?)", "analysis_pass_rate", "0.8");
    invalidateAnalysisThresholdsCache(); assert.equal((await getAnalysisThresholds()).passRate, 0.8);
    analysisCache.set("restore-probe", { score: "B" });
    if (!maria) scannerDb().prepare("UPDATE restore_probe SET value='B'").run();
  };
  const title = async () => (await dbModule.getMysqlDb().get<{ title: string }>("SELECT title FROM feedback_reports WHERE id = ?", feedbackId))?.title;
  await mutate();
  // Fail after DB import, data-tree switch, cache reload and token revocation.
  let injected = 0;
  fs.rm = (async (target: any, options: any) => {
    if (String(target) === restoreRecoveryMarkerPath() && injected++ === 0) {
      assert.equal(await title(), "snapshot A"); assert.equal(await fs.readFile(extra, "utf8"), "A");
      assert.equal(await providerSecret(), "snapshot secret");
      throw new Error("injected failure after replacement");
    }
    return originalRm(target, options);
  }) as typeof fs.rm;
  syncBuiltinESMExports();
  const failed = await restore(backup);
  fs.rm = originalRm; syncBuiltinESMExports();
  assert.equal(failed.status, 500); assert.ok(injected >= 2);
  assert.equal(await title(), "live B"); assert.equal(await fs.readFile(extra, "utf8"), "B");
  if (!maria) assert.equal((scannerDb().prepare("SELECT value FROM restore_probe").get() as any).value, "B");
  assert.equal(existsSync(restoreRecoveryMarkerPath()), false);
  assert.equal((await readPapersTotalBytes()).bytes, 4);
  assert.equal((await getAnalysisThresholds()).passRate, 0.8); assert.equal(analysisCache.size, 0);
  assert.equal(await providerSecret(), "live secret");
  assert.deepEqual(await dbModule.getMysqlDb().all("SELECT status FROM ai_analysis_jobs"), [{ status: "queued" }]);
  assert.deepEqual(await dbModule.getMysqlDb().all("SELECT feature, success FROM ai_analysis_runs"), [{ feature: "live-pending", success: null }]);
  await login(); assert.equal((await request("/api/feedback")).status, 200);
  pass("failure after full replacement rolls back database, data tree and scanner, then accepts login");

  analysisCache.set("restore-probe", { score: "B" });
  const oldToken = token;
  const restored = await restore(backup); assert.equal(restored.status, 200, JSON.stringify(restored));
  assert.equal(await title(), "snapshot A"); assert.equal(await fs.readFile(extra, "utf8"), "A");
  assert.equal((await readPapersTotalBytes()).bytes, 1);
  assert.equal((await getAnalysisThresholds()).passRate, originalPassRate); assert.equal(analysisCache.size, 0);
  assert.equal(await providerSecret(), "snapshot secret");
  const newSecret = encryptField("written after restore");
  invalidateSecretKeyCache();
  assert.equal(decryptField(newSecret), "written after restore");
  assert.equal((await readAiQuotaSnapshot(dbModule.getMysqlDb(), admin.id)).activeJobsForUser, 0);
  const restoredJobs = await dbModule.getMysqlDb().all<{ status: string }>("SELECT status FROM ai_analysis_jobs");
  assert.equal(restoredJobs.length, 3); assert.ok(restoredJobs.every(job => job.status === "error"));
  assert.deepEqual(await dbModule.getMysqlDb().all("SELECT feature, success, error_code FROM ai_analysis_runs ORDER BY id"), [
    { feature: "restored-pending", success: 0, error_code: "INTERRUPTED" },
    { feature: "restored-done", success: 1, error_code: null },
  ]);
  if (!maria) assert.equal((scannerDb().prepare("SELECT value FROM restore_probe").get() as any).value, "A");
  assert.equal((await fetch(base + "/api/feedback", { headers: { Authorization: `Bearer ${oldToken}` } })).status, 401);
  await login();
  const list = await json("/api/feedback");
  assert.equal(list.status, 200);
  const item = (list.body.data?.items ?? list.body.data ?? []).find((f: any) => f.id === feedbackId);
  assert.ok(item, JSON.stringify(list.body)); assert.equal(item.title, "snapshot A"); assert.equal(item.attachments.length, count);
  for (const attachment of item.attachments) {
    const res = await request(`/api/feedback/${feedbackId}/attachments/${attachment.id}`);
    assert.equal(res.status, 200);
    const hash = createHash("sha256"); for await (const chunk of Readable.fromWeb(res.body as any)) hash.update(chunk);
    assert.equal(hash.digest("hex"), expectedHash);
  }
  pass("successful restore revokes sessions; fresh login reads all original attachments with SHA-256 match");
  assert.equal(isServiceMaintenanceActive(), false);
  assert.equal(existsSync(restoreRecoveryMarkerPath()), false);
  // Force both apply and rollback to fail: recovery material must survive and requests are fenced.
  fs.rm = (async (target: any, options: any) => {
    if (String(target) === restoreRecoveryMarkerPath()) throw new Error("injected recovery marker failure");
    return originalRm(target, options);
  }) as typeof fs.rm; syncBuiltinESMExports();
  assert.equal((await restore(backup)).status, 500);
  fs.rm = originalRm; syncBuiltinESMExports();
  assert.equal((await request("/api/feedback")).status, 503);
  assert.equal((await request("/api/app/health")).status, 503);
  const marker = JSON.parse(await fs.readFile(restoreRecoveryMarkerPath(), "utf8"));
  assert.equal(marker.phase, "recovery-required"); assert.ok(existsSync(path.join(marker.recoveryDir, maria ? "dump.sql" : "projectx.db")));
  await assert.rejects(createApp(), /未完成的数据恢复/);
  pass("failed rollback preserves recovery material, blocks API and prevents application restart");
  console.log(`Backup lifecycle: ${checks} passed (${maria ? "MariaDB" : "SQLite"}, ${large ? "large" : "normal"})`);
} finally {
  fs.rm = originalRm; syncBuiltinESMExports();
  server?.closeAllConnections(); if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  closeDb(); dbModule.closeDatabase(); await closeAdapter();
  process.chdir(cwd); await fs.rm(root, { recursive: true, force: true });
}
