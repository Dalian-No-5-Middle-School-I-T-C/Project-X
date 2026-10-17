/** 后处理页「多选删除」端点与 examId 读取的隔离回归。
 * 默认临时 SQLite；SCANNER_POSTPROCESS_MARIADB=1 时须指向全新的 projectx_scanner_postprocess_* 库。 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import path from "node:path";
import express from "express";
import { createDefaultCard } from "../src/shared/defaultCard";
import { buildLayout } from "../src/shared/layout";
import type { ScanBatchResponse } from "../src/shared/scanPages";

await mkdir("data", { recursive: true });
const root = await mkdtemp(path.resolve("data/scanner-postprocess-"));
process.env.ANSWER_CARD_DATA_DIR = path.join(root, "cards");
process.env.PROJECTX_DB_PATH = path.join(root, "postprocess.db");
process.env.PROJECTX_AUTH_ENFORCE = "0";
process.chdir(root);
if (process.env.SCANNER_POSTPROCESS_MARIADB === "1") {
  assert.equal(process.env.PROJECTX_MARIADB_HOST, "127.0.0.1");
  assert.match(process.env.PROJECTX_MARIADB_DATABASE ?? "", /^projectx_scanner_postprocess_[a-z0-9_]+$/);
} else {
  for (const name of Object.keys(process.env)) if (/^PROJECTX_(MARIADB|MYSQL)_/.test(name)) delete process.env[name];
}

const { initializeDatabase, getMysqlDb, closeDatabase, initMariadbSchema } = await import("../src/server/db");
initializeDatabase();
const db = getMysqlDb();
if (process.env.SCANNER_POSTPROCESS_MARIADB === "1") await initMariadbSchema();

const store = await import("../src/apps/answer-card/server/database/scan-store");
const { CardRepository } = await import("../src/server/repositories/CardRepository");
const { createScannerRouter } = await import("../src/apps/answer-card/server/scanner");
const { cardFingerprint } = await import("../src/shared/cardVersion");

const studentNumbers = ["92001", "92002"];
const card = createDefaultCard("91512002");
card.title = "后处理页删除验证";
card.bodyBlocks = [{ id: "pp_q", type: "objective", title: "选择题", questionStart: 1, questionCount: 1,
  optionCount: 4, mode: "single", scorePerQuestion: 5, answerKey: { "1": ["A"] }, density: "normal" }];
assert.equal(buildLayout(card).pages.length, 1, "单页卡：每张纸一份答题卡");
await new CardRepository().createCard(card);
const cardVersion = cardFingerprint((await new CardRepository().findById(card.id))!);

const role = await db.get<{ id: number }>("SELECT id FROM roles WHERE name = 'student'");
assert(role);
const exam = await db.run("INSERT INTO exams (name,card_id,status) VALUES (?,?,'draft')", "后处理验证", card.id);
for (const studentNumber of studentNumbers) {
  const row = await db.run("INSERT INTO users (username,password_hash,name,role_id,student_number) VALUES (?,?,?,?,?)",
    `pp_${studentNumber}`, "test-no-login", `测试${studentNumber}`, role.id, studentNumber);
  await db.run("INSERT INTO exam_participants (exam_id,student_id,source) VALUES (?,?,'explicit')", exam.lastInsertRowid, row.lastInsertRowid);
}

const session = await store.createSession(card.id, "postprocess");
await db.run("UPDATE twain_scan_sessions SET card_version = ?, version_source = 'upload' WHERE id = ?", cardVersion, session.id);
const recordIds: string[] = [];
for (const [index, studentNumber] of studentNumbers.entries()) {
  const record = await store.createScanRecord({ sessionId: session.id, cardId: card.id, pageNum: index + 1,
    imagePath: path.join(root, `page_${index}.png`) });
  await db.run("UPDATE twain_scan_records SET identity_json = ? WHERE id = ?",
    JSON.stringify({ status: "verified", code: "QR_VERIFIED", cardId: card.id, pageNumber: 1 }), record.id);
  await store.updateScanOcrResult(record.id, studentNumber, 1, "done");
  await store.upsertRecognitionResult({ scanRecordId: record.id,
    objectiveJson: JSON.stringify([{ questionNumber: 1, selectedOptions: ["A"], confidence: 1 }]),
    subjectiveJson: "[]", gradeStatus: "done" });
  recordIds.push(record.id);
}
// 订正页与识别结果都挂在扫描记录上，删除必须一并清掉
await db.run("INSERT INTO scan_correction_pages (source_type, source_id, card_version, layout_json, recognition_json, revision) VALUES (?,?,?,?,?,0)",
  "twain_scan_record", recordIds[0], cardVersion, "{}", "{}");
await store.updateSessionStatus(session.id, "completed");

const app = express();
app.use(express.json());
app.use("/api/scanner", createScannerRouter(false));
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(500).json({ message: err.message }));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(resolve => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const groupsUrl = `${base}/api/scanner/session/${session.id}/groups`;
async function del(payload: unknown, url = groupsUrl) {
  const res = await fetch(url, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}
async function recordCount() {
  return Number((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM twain_scan_records WHERE session_id = ?", session.id))!.n);
}

try {
  // 读取接口带出 examId，改考号的花名册联想依赖它
  const scan = await fetch(`${base}/api/scanner/scan/${session.id}`);
  assert.equal(scan.status, 200, await scan.clone().text());
  assert.equal(Number((await scan.json() as { examId: number | null }).examId), Number(exam.lastInsertRowid));

  assert.equal((await del({ groupIds: [] })).status, 400, "空 groupIds 必须拒绝");
  assert.equal((await del({ groupIds: ["0"] }, `${base}/api/scanner/session/pp_missing/groups`)).status, 404);

  // 扫描进行中不得删除页面
  await store.updateSessionStatus(session.id, "scanning");
  const busy = await del({ groupIds: ["0"] });
  assert.equal(busy.status, 409);
  assert.match(String(busy.body.message), /扫描/);
  await store.updateSessionStatus(session.id, "completed");

  // validate 写的 pending 回执是本机判分常态，不得拦住日常删除（spec §4.1）
  const validated = await fetch(`${base}/api/scanner/session/${session.id}/validate`, { method: "POST" });
  assert.equal(validated.status, 200, await validated.clone().text());
  assert.equal((await validated.json() as ScanBatchResponse).results.length, 2);
  const routine = await del({ groupIds: ["1"] });
  assert.equal(routine.status, 200, JSON.stringify(routine.body));
  assert.equal(routine.body.deletedGroups, 1);
  assert.equal(await recordCount(), 1, "pending 回执组可直接删除本机页面");

  // 已定论回执（saved/held/conflict/roster）必须 force，否则 409 点名冲突组
  await db.run("UPDATE scanner_submissions SET state = 'saved' WHERE session_id = ? AND group_id = '0'", session.id);
  const blocked = await del({ groupIds: ["0"] });
  assert.equal(blocked.status, 409);
  assert.deepEqual(blocked.body.blocked, ["0"]);
  assert.equal(await recordCount(), 1, "拦截时不得留下半删状态");

  // force 放行：只删本机页面与派生数据，回执保留
  const forced = await del({ groupIds: ["0"], force: true });
  assert.equal(forced.status, 200, JSON.stringify(forced.body));
  assert.equal(forced.body.deletedGroups, 1);
  assert.deepEqual(forced.body.missingGroups, []);
  assert.equal((forced.body as unknown as ScanBatchResponse).results.length, 0);
  assert.equal(await recordCount(), 0);
  assert.equal((await db.all("SELECT source_id FROM scan_correction_pages WHERE source_id = ?", recordIds[0])).length, 0);
  assert.equal((await db.all("SELECT id FROM twain_recognition_results WHERE scan_record_id = ?", recordIds[0])).length, 0);
  assert.equal((await db.all("SELECT group_id FROM scanner_submissions WHERE session_id = ? AND group_id = '0'", session.id)).length, 1,
    "删除只动本机扫描记录，不得销毁已建立的回执");

  // 从未判分的组（无回执、有页面）删除后仍算删成功
  const ghost = await store.createScanRecord({ sessionId: session.id, cardId: card.id, pageNum: 3, imagePath: path.join(root, "page_2.png") });
  const stray = await del({ groupIds: ["2"] });
  assert.equal(stray.status, 200, JSON.stringify(stray.body));
  assert.equal(await db.get("SELECT id FROM twain_scan_records WHERE id = ?", ghost.id), null);

  // 请求了不存在的组：不谎报删除数量
  const phantom = await del({ groupIds: ["9"] });
  assert.equal(phantom.status, 200, JSON.stringify(phantom.body));
  assert.equal(phantom.body.deletedGroups, 0);
  assert.deepEqual(phantom.body.missingGroups, ["9"]);
  console.log("PASS scanner-postprocess-delete-smoke");
} finally {
  server.close();
  await closeDatabase();
}
