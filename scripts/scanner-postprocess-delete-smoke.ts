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
const { resetAdapter } = await import("../src/server/db/mysql");
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
const cards = new CardRepository();
await cards.createCard(card);
await cards.updateCard(card);
const cardVersion = cardFingerprint((await cards.findById(card.id))!);

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

  // 扫描时指纹只记第一次。补传读的是这次识别的版本，后来的卡面不能覆盖。
  const versionSession = await store.createSession(card.id, "version-once");
  const firstVersion = "cccccccccccccccccccccccc";
  const secondVersion = "dddddddddddddddddddddddd";
  await store.rememberSessionCardVersion(versionSession.id, firstVersion);
  await store.rememberSessionCardVersion(versionSession.id, secondVersion);
  assert.equal((await db.get<{ card_version: string }>("SELECT card_version FROM twain_scan_sessions WHERE id = ?", versionSession.id))!.card_version, firstVersion);
  await store.rememberSessionCardVersion(session.id, secondVersion);
  assert.equal((await db.get<{ card_version: string }>("SELECT card_version FROM twain_scan_sessions WHERE id = ?", session.id))!.card_version, cardVersion,
    "已有版本的会话不能被后一次识别改写成新卡指纹");

  async function addStudent(studentNumber: string) {
    const row = await db.run("INSERT INTO users (username,password_hash,name,role_id,student_number) VALUES (?,?,?,?,?)",
      `pp_${studentNumber}`, "test-no-login", `测试${studentNumber}`, role.id, studentNumber);
    await db.run("INSERT INTO exam_participants (exam_id,student_id,source) VALUES (?,?,'explicit')", exam.lastInsertRowid, row.lastInsertRowid);
  }
  async function seedPapers(label: string, papers: Array<{ studentNumber: string; confidence: number }>) {
    const created = await store.createSession(card.id, label);
    await db.run("UPDATE twain_scan_sessions SET card_version = ?, version_source = 'upload' WHERE id = ?", cardVersion, created.id);
    for (const [index, paper] of papers.entries()) {
      const record = await store.createScanRecord({ sessionId: created.id, cardId: card.id, pageNum: index + 1, imagePath: path.join(root, `${label}-${index}.png`) });
      await db.run("UPDATE twain_scan_records SET identity_json = ? WHERE id = ?",
        JSON.stringify({ status: "verified", code: "QR_VERIFIED", cardId: card.id, pageNumber: 1 }), record.id);
      await store.updateScanOcrResult(record.id, paper.studentNumber, 1, "done");
      await store.upsertRecognitionResult({ scanRecordId: record.id,
        objectiveJson: JSON.stringify([{ questionNumber: 1, selectedOptions: ["A"], confidence: paper.confidence }]),
        subjectiveJson: "[]", gradeStatus: "done" });
    }
    await store.updateSessionStatus(created.id, "completed");
    return created;
  }
  for (const studentNumber of ["92011", "92012", "92013", "92014", "92015", "92016"]) await addStudent(studentNumber);

  // 远端删除后用 preview 刷新：留下来的组不能因此获得回执。
  const previewSession = await seedPapers("preview-delete", [
    { studentNumber: "92013", confidence: 1 },
    { studentNumber: "92014", confidence: 1 },
  ]);
  const previewDeleted = await del({ groupIds: ["1"], previewOnly: true }, `${base}/api/scanner/session/${previewSession.id}/groups`);
  assert.equal(previewDeleted.status, 200, JSON.stringify(previewDeleted.body));
  assert.equal(previewDeleted.body.deletedGroups, 1);
  assert.equal(Number((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM scanner_submissions WHERE session_id = ?", previewSession.id))!.n), 0,
    "previewOnly 删除不得给留下的组写回执");
  assert.equal(Number((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM twain_scan_records WHERE session_id = ?", previewSession.id))!.n), 1);

  // 本机删除后仍 validate：留下的组得到 pending 回执，这是本地判分常态。
  const validateSession = await seedPapers("validate-delete", [
    { studentNumber: "92015", confidence: 1 },
    { studentNumber: "92016", confidence: 1 },
  ]);
  const validateDeleted = await del({ groupIds: ["1"] }, `${base}/api/scanner/session/${validateSession.id}/groups`);
  assert.equal(validateDeleted.status, 200, JSON.stringify(validateDeleted.body));
  const survivorReceipts = await db.all<{ group_id: string; state: string }>(
    "SELECT group_id, state FROM scanner_submissions WHERE session_id = ? ORDER BY group_id", validateSession.id);
  assert.deepEqual(survivorReceipts, [{ group_id: "0", state: "pending" }], "不带 previewOnly 时，刷新要给留下的组写 pending 回执");

  // 点名入库：带存疑的组一起写正式成绩（issue #352 口径），复核计数照常随回执带回。
  const saveSession = await seedPapers("scoped-save", [
    { studentNumber: "92011", confidence: 1 },
    { studentNumber: "92012", confidence: 0.05 },
  ]);
  const saveUrl = `${base}/api/scanner/session/${saveSession.id}/results`;
  const invalidIds = await fetch(saveUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ groupIds: [1] }) });
  assert.equal(invalidIds.status, 400, await invalidIds.clone().text());
  const validatedSave = await fetch(`${base}/api/scanner/session/${saveSession.id}/validate`, { method: "POST" });
  assert.equal(validatedSave.status, 200, await validatedSave.clone().text());
  const partial = await fetch(saveUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ groupIds: ["0", "1"] }) });
  assert.equal(partial.status, 200, await partial.clone().text());
  const partialBody = await partial.json() as ScanBatchResponse;
  assert.equal(partialBody.results.find(row => row.groupId === "0")?.needsReviewCount, 0);
  assert.equal(partialBody.results.find(row => row.groupId === "1")?.needsReviewCount, 1, "低置信度必须进入待复核");
  assert.equal(partialBody.results.find(row => row.groupId === "0")?.saved, true, "点名的正常组要入库");
  assert.equal(partialBody.results.find(row => row.groupId === "1")?.saved, true, "待复核组一起入库，复核标记不拦成绩");
  const saveReceipts = await db.all<{ group_id: string; state: string }>(
    "SELECT group_id, state FROM scanner_submissions WHERE session_id = ? ORDER BY group_id", saveSession.id);
  assert.deepEqual(saveReceipts, [
    { group_id: "0", state: "saved" },
    { group_id: "1", state: "saved" },
  ]);
  const scored = await db.all<{ student_number: string }>(
    `SELECT u.student_number FROM student_scores ss JOIN users u ON u.id = ss.student_id
     WHERE ss.exam_id = ? AND u.student_number IN ('92011','92012') ORDER BY u.student_number`, exam.lastInsertRowid);
  assert.deepEqual(scored.map(row => row.student_number), ["92011", "92012"], "存疑组与正常组一起写入正式成绩");

  // 预览重卡：每份副本带上自己的判分。保留低置信度的那份时，复核计数不能变成 0。
  await addStudent("92021");
  await addStudent("92022");
  const { processScannerSession } = await import("../src/server/services/scannerSubmissions");
  const { omitPreviewDiscardedGroups, buildPostprocessGroups, buildPostprocessQueue } = await import("../src/shared/scanPostprocess");
  const duplicate = await seedPapers("dup-review", [
    { studentNumber: "92021", confidence: 0.05 },
    { studentNumber: "92021", confidence: 0.05 },
  ]);
  const preview = await processScannerSession((await cards.findById(card.id))!, duplicate.id, "preview");
  const copies = preview.failures.flatMap(failure => failure.conflicts ?? []);
  assert.equal(copies.length >= 2, true, "同考号两份卷在预览里成为重卡");
  assert.equal(copies.every(copy => copy.needsReviewCount === 1), true, "置信度 0.05 的副本要带上真实复核计数");
  assert.equal(copies.every(copy => (copy.maxScore ?? 0) > 0), true, "副本满分不能是占位 0");
  const kept = omitPreviewDiscardedGroups(preview, [{ sessionId: duplicate.id, groupId: "1" }], duplicate.id);
  assert.equal(kept.results.find(row => row.groupId === "0")?.needsReviewCount, 1, "保留份不能绕过存疑复核");
  assert.equal(buildPostprocessQueue(buildPostprocessGroups(kept, duplicate.id, 1)).some(item => item.kind === "low_confidence" && item.groupId === "0"), true);

  await addStudent("92023");
  const cleanDuplicate = await seedPapers("dup-clean", [
    { studentNumber: "92023", confidence: 1 }, { studentNumber: "92023", confidence: 1 },
  ]);
  const cleanPreview = await processScannerSession((await cards.findById(card.id))!, cleanDuplicate.id, "preview");
  for (const keep of ["0", "1"]) {
    const cleanKept = omitPreviewDiscardedGroups(cleanPreview,
      [{ sessionId: cleanDuplicate.id, groupId: keep === "0" ? "1" : "0" }], cleanDuplicate.id);
    const source = cleanPreview.failures.flatMap(f => f.conflicts ?? []).find(c => c.groupId === keep)!;
    assert.equal(cleanKept.results[0].needsReviewCount, 0, `保留第 ${keep} 份正常卷都不能制造存疑题`);
    assert.equal(cleanKept.results[0].totalScore, source.totalScore);
    assert.equal(cleanKept.results[0].maxScore, source.maxScore);
    assert.equal(buildPostprocessQueue(buildPostprocessGroups(cleanKept, cleanDuplicate.id, 1)).length, 0);
  }

  const unreviewed = await seedPapers("unreviewed-save", [{ studentNumber: "92022", confidence: 0.05 }]);
  const blockedSave = await processScannerSession((await cards.findById(card.id))!, unreviewed.id, "save", undefined, undefined, true);
  assert.equal(blockedSave.results[0]?.needsReviewCount, 1);
  assert.equal(blockedSave.results[0]?.saved, false, "显式 blockUnreviewed 时未确认卷不能入库");
  const leaked = await db.get<{ student_number: string }>(
    `SELECT u.student_number FROM student_scores ss JOIN users u ON u.id = ss.student_id
     WHERE ss.exam_id = ? AND u.student_number = '92022'`, exam.lastInsertRowid);
  assert.equal(leaked, null, "未确认卷不能写入正式成绩");

  console.log("PASS scanner-postprocess-delete-smoke");
} finally {
  // 必须等 close 回调：不等待时监听套接字仍开着；MariaDB 连接池也要 resetAdapter +
  // closeDatabase 才会释放句柄，否则 SQLite 能退出、MariaDB 上进程挂住不退出（CI 卡在整步）
  await new Promise<void>(resolve => server.close(() => resolve()));
  resetAdapter();
  closeDatabase();
}
