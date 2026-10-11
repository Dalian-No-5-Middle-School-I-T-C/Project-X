/** Identical-image reuploads retain the saved grade; equal-answer papers require manual review.
 * Set SCANNER_BATCH_MARIADB=1 with a fresh projectx_scanner_batch_* database to exercise MariaDB;
 * otherwise uses temp SQLite. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import express from "express";
import { createDefaultCard } from "../src/shared/defaultCard";
import { buildLayout } from "../src/shared/layout";
import type { ScanBatchResponse } from "../src/shared/scanPages";

await mkdir("data", { recursive: true });
const root = await mkdtemp(path.resolve("data/scanner-dup-rescan-"));
process.env.ANSWER_CARD_DATA_DIR = path.join(root, "cards");
process.env.PROJECTX_DB_PATH = path.join(root, "scanner.db");
process.env.PROJECTX_AUTH_ENFORCE = "0";
process.chdir(root);
if (process.env.SCANNER_BATCH_MARIADB === "1") {
  assert.equal(process.env.PROJECTX_MARIADB_HOST, "127.0.0.1");
  assert.match(process.env.PROJECTX_MARIADB_DATABASE ?? "", /^projectx_scanner_batch_[a-z0-9_]+$/);
} else {
  for (const name of Object.keys(process.env)) if (/^PROJECTX_(MARIADB|MYSQL)_/.test(name)) delete process.env[name];
}

const { initializeDatabase, getMysqlDb, closeDatabase, initMariadbSchema } = await import("../src/server/db");
const { resetAdapter } = await import("../src/server/db/mysql");
initializeDatabase();
const db = getMysqlDb();
if (process.env.SCANNER_BATCH_MARIADB === "1") await initMariadbSchema();
const store = await import("../src/apps/answer-card/server/database/scan-store");
async function createVerifiedRecord(params: Parameters<typeof store.createScanRecord>[0]) {
  const record = await store.createScanRecord(params);
  const identity_json = JSON.stringify({ status: "verified", code: "QR_VERIFIED", cardId: params.cardId, pageNumber: 1 });
  await db.run("UPDATE twain_scan_records SET identity_json = ? WHERE id = ?", identity_json, record.id);
  return { ...record, identity_json };
}
const { CardRepository } = await import("../src/server/repositories/CardRepository");
const { createScannerRouter } = await import("../src/apps/answer-card/server/scanner");
const card = createDefaultCard("91513001");
card.title = "重复学号重扫验证";
card.bodyBlocks = [{ id: "dup_q", type: "objective", title: "选择题", questionStart: 1, questionCount: 1,
  optionCount: 4, mode: "single", scorePerQuestion: 5, answerKey: { "1": ["A"] }, density: "normal" }];
assert.equal(buildLayout(card).pages.length, 1);
await new CardRepository().createCard(card);
await new CardRepository().updateCard(card);
const role = await db.get<{ id: number }>("SELECT id FROM roles WHERE name = 'student'");
assert(role);
await db.run("INSERT INTO users (username,password_hash,name,role_id,student_number) VALUES (?,?,?,?,?)",
  "dup_91001", "test", "重扫学生", role.id, "91001");
const exam = await db.run("INSERT INTO exams (name,card_id,status) VALUES (?,?,'grading')", "重扫验证", card.id);
await db.run("INSERT INTO exam_participants (exam_id,student_id,source) VALUES (?,(SELECT id FROM users WHERE student_number='91001'),'explicit')", exam.lastInsertRowid);

async function makeRecord(sessionId: string, pageNum: number, option: string, image = option) {
  const record = await createVerifiedRecord({ sessionId, cardId: card.id, pageNum, imagePath: path.join(root, `p${pageNum}_${option}.png`) });
  const imagePath = path.join(root, `${record.id}.png`);
  await writeFile(imagePath, `original-image-${image}`);
  await db.run("UPDATE twain_scan_records SET image_path = ? WHERE id = ?", imagePath, record.id);
  await store.updateScanOcrResult(record.id, "91001", 1, "done");
  await store.upsertRecognitionResult({ scanRecordId: record.id,
    objectiveJson: JSON.stringify([{ questionNumber: 1, selectedOptions: [option], confidence: 1 }]),
    subjectiveJson: "[]", gradeStatus: "done" });
  return { ...record, image_path: imagePath };
}

const app = express();
app.use(express.json());
app.use("/api/scanner", createScannerRouter(false));
const { default: uploadRouter } = await import("../src/server/routes/scanner-upload");
const { hashSecret } = await import("../src/server/lib/field-crypto");
await db.run("INSERT INTO api_keys (name, api_key, scope, is_active) VALUES (?,?,?,1)", "isolated-test", hashSecret("scanner-test-only"), "scanner");
app.use("/api/scanner/upload", uploadRouter);
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(500).json({ message: err.message }));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(resolve => server.once("listening", resolve));
const address = server.address() as { port: number };

async function postResults(sessionId: string) {
  const res = await fetch(`http://127.0.0.1:${address.port}/api/scanner/session/${sessionId}/results`, { method: "POST" });
  return { status: res.status, body: (await res.json()) as ScanBatchResponse };
}
const scoreOf = async () => Number((await db.get<{ n: number }>("SELECT COUNT(*) n FROM student_scores WHERE exam_id = ?", exam.lastInsertRowid))!.n);

try {
  // —— 场景 A：同一物理卡重扫（识别内容完全一致）应自动消化，不判重、不撤回成绩 ——
  const s1 = await store.createSession(card.id, "scan-a");
  await makeRecord(s1.id, 1, "A");
  await store.updateSessionStatus(s1.id, "completed");
  let r = await postResults(s1.id);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await scoreOf(), 1, "第一次保存应入库");

  const s2 = await store.createSession(card.id, "rescan-a");
  await makeRecord(s2.id, 1, "A");
  await store.updateSessionStatus(s2.id, "completed");
  r = await postResults(s2.id);
  assert.equal(r.status, 200, `重扫副本应自动消化，实际 ${r.status}: ${JSON.stringify(r.body.failures)}`);
  assert.equal(r.body.failures.length, 0, "重扫副本不应产生失败项");
  assert.equal(r.body.results.length, 0, "重扫副本已消化，不应再作为结果返回（否则远端 /complete 会因回执归属缺失 500）");
  assert.equal(await scoreOf(), 1, "重扫绝不能撤回已保存成绩");
  assert.equal(r.body.discardedGroups, 1, "相同原图重传使用统一归档状态");
  r = await postResults(s2.id);
  assert.equal(r.body.results.length + r.body.failures.length, 0, "再次保存归档卷不会复活回执");
  assert.equal(await scoreOf(), 1);

  // Equal answers on different originals still conflict; discard only the unsaved copy.
  const s3 = await store.createSession(card.id, "dup-b");
  const differentPaper = await makeRecord(s3.id, 1, "A", "different-paper-same-answer");
  await store.updateSessionStatus(s3.id, "completed");
  r = await postResults(s3.id);
  assert.equal(r.body.failures.some(f => f.conflicts?.length === 2), true, "真重复必须报含新旧两张的冲突，实际 " + JSON.stringify(r.body.failures));
  assert.equal(await scoreOf(), 0, "真重复应撤出新旧成绩待人工核对");
  const protectedOriginal = await fetch(`http://127.0.0.1:${address.port}/api/scanner/upload/sessions/${s1.id}/groups/0/discard`,
    { method: "POST", headers: { "X-Api-Key": "scanner-test-only" } });
  assert.equal(protectedOriginal.ok, false, "撤出的原成绩快照不能被作废");

  const d = await fetch(`http://127.0.0.1:${address.port}/api/scanner/upload/sessions/${s3.id}/groups/0/discard`,
    { method: "POST", headers: { "X-Api-Key": "scanner-test-only" } });
  assert.equal(d.status, 200, await d.clone().text());
  assert(await db.get("SELECT scan_record_id FROM twain_recognition_results WHERE scan_record_id = ?", differentPaper.id), "人工作废仍保留识别证据");
  assert.equal((await db.get<{ state: string }>("SELECT state FROM scanner_submissions WHERE session_id = ? AND group_id = '0'", s3.id))?.state, "discarded");

  // 作废后的卷必须从会话结果中消失：否则每次刷新都报识别失败，且 /retry 能重新识别复活回执
  const v = await fetch(`http://127.0.0.1:${address.port}/api/scanner/session/${s3.id}/results`);
  const vbody = (await v.json()) as ScanBatchResponse;
  assert.equal(vbody.failures.length, 0, "作废后的卷不应在刷新时继续报识别失败");
  assert.equal(vbody.results.length, 0, "作废后的卷不应再出现在会话结果中");

  r = await postResults(s1.id);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await scoreOf(), 1, "作废副本后原卷成绩应恢复且仅一份");
  const batch = await store.createSession(card.id, "same-answer-local-duplicates");
  await makeRecord(batch.id, 1, "A");
  await makeRecord(batch.id, 2, "A");
  await store.updateSessionStatus(batch.id, "completed");
  r = await postResults(batch.id);
  assert.equal(r.body.failures.length, 2, "同一批两份同学号卷，即使原图相同也需人工核对");
  assert.equal(r.body.failures[0].conflicts?.length, 3);

  console.log(`PASS duplicate rescan: exact-image proof, equal-answer different papers conflict, evidence retained, discarded retry stays archived (${db.dialect})`);
} finally {
  await new Promise<void>(resolve => server.close(() => resolve()));
  resetAdapter();
  closeDatabase();
}
