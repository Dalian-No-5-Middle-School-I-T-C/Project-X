/** SQLite: unrelated committed writes survive when crop staging fails outside the upload transaction. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { scannerCropStaging } from "../src/server/services/scannerCropStaging";
import { hashPassword, verifyPassword } from "../src/server/db";

const root = await mkdtemp(path.join(tmpdir(), "projectx-scanner-crop-staging-"));
process.env.PROJECTX_DB_PATH = path.join(root, "scanner.db");
process.env.ANSWER_CARD_DATA_DIR = path.join(root, "cards");
process.env.PROJECTX_TOKEN_DIR = path.join(root, "tokens");
process.env.PROJECTX_AUTH_ENFORCE = "1";
for (const name of Object.keys(process.env)) if (/^PROJECTX_(MARIADB|MYSQL)_/.test(name)) delete process.env[name];
await mkdir(process.env.ANSWER_CARD_DATA_DIR, { recursive: true });
process.chdir(root);

const { initializeDatabase, getMysqlDb, closeDatabase } = await import("../src/server/db");
const { resetAdapter } = await import("../src/server/db/mysql");
initializeDatabase();
const db = getMysqlDb();
assert.equal(db.dialect, "sqlite");

const { createDefaultCard } = await import("../src/shared/defaultCard");
const { CardRepository } = await import("../src/server/repositories/CardRepository");
const { cardFingerprint } = await import("../src/shared/cardVersion");
const card = createDefaultCard("91514003");
card.bodyBlocks = [{ id: "flow_q", type: "objective", title: "选择题", questionStart: 1, questionCount: 1,
  optionCount: 4, mode: "single", scorePerQuestion: 5, answerKey: { "1": ["A"] }, density: "normal" }];
await new CardRepository().createCard(card);
await new CardRepository().updateCard(card);
const version = cardFingerprint((await new CardRepository().findById(card.id))!);
const key = "isolated-crop-staging-smoke";
const { hashSecret } = await import("../src/server/lib/field-crypto");
await db.run("INSERT INTO api_keys (name,api_key,scope,is_active) VALUES (?,?,?,1)", "crop-staging-test", hashSecret(key), "scanner");

const oldPassword = "CropStaging-Original-2026!";
const newPassword = "CropStaging-Replaced-2026!";
const teacherId = Number((await db.run(
  "INSERT INTO users (username, password_hash, name, role_id) VALUES (?,?,?,2)",
  "crop_staging_teacher", await hashPassword(oldPassword), "切块回归教师",
)).lastInsertRowid);

const { default: sharp } = await import("sharp");
const pagePng = await sharp({ create: { width: 24, height: 24, channels: 3, background: { r: 90, g: 120, b: 200 } } }).png().toBuffer();
const cropPng = await sharp({ create: { width: 12, height: 12, channels: 3, background: { r: 20, g: 40, b: 80 } } }).png().toBuffer();
const recognition = { status: "ok", pageNumber: 1,
  identity: { status: "verified", code: "QR_VERIFIED", cardId: card.id, pageNumber: 1 },
  studentId: { status: "ok", value: "91001" }, questions: [], subjectiveQuestions: [],
  geometry: { imageWidth: 24, imageHeight: 24, imageToLayout: [1,0,0,0,1,0,0,0,1], layoutToImage: [1,0,0,0,1,0,0,0,1] },
};

const { default: express } = await import("express");
const { default: router } = await import("../src/server/routes/scanner-upload");
const app = express();
app.use(express.json());
app.use("/api/scanner/upload", router);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(resolve => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const request = (url: string, init?: RequestInit) => fetch(`${base}${url}`, {
  ...init, headers: { ...init?.headers, "X-Api-Key": key },
});

try {
  const created = await request("/api/scanner/upload/sessions", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cardId: card.id, cardVersion: version, pageCount: 1, name: "crop-staging" }),
  });
  assert.equal(created.status, 201);
  const remote = await created.json() as { sessionId: string; uploadTokens: string[] };

  const pageForm = new FormData();
  pageForm.append("image", new Blob([pagePng], { type: "image/png" }), "page.png");
  pageForm.append("token", remote.uploadTokens[0]);
  pageForm.append("pageNum", "1");
  pageForm.append("side", "front");
  pageForm.append("recognition", JSON.stringify(recognition));
  const pageUploaded = await request(`/api/scanner/upload/sessions/${remote.sessionId}/pages`, { method: "POST", body: pageForm });
  assert.equal(pageUploaded.status, 200, await pageUploaded.text());

  let releaseStaging!: () => void;
  let signalStagingEntered!: () => void;
  const stagingEntered = new Promise<void>(resolve => { signalStagingEntered = resolve; });
  const stagingPaused = new Promise<void>(resolve => { releaseStaging = resolve; });
  const originalWrite = scannerCropStaging.write.bind(scannerCropStaging);
  scannerCropStaging.write = async (target, data) => {
    signalStagingEntered();
    await stagingPaused;
    const err = Object.assign(new Error("EIO: i/o error, write"), { code: "EIO" });
    throw err;
  };

  const cropForm = new FormData();
  cropForm.append("crops", new Blob([cropPng], { type: "image/png" }), "crop.png");
  cropForm.append("manifest", JSON.stringify([{
    blockId: "flow_q",
    blockTitle: "选择题",
    blockType: "objective",
    pageNumber: 1,
    segmentIndex: 0,
    questionNumbers: [1],
    rect: { x: 0, y: 0, width: 10, height: 10 },
    widthPx: 12,
    heightPx: 12,
    dpi: 300,
    fileName: "crop.png",
  }]));
  const cropPromise = request(
    `/api/scanner/upload/sessions/${remote.sessionId}/pages/${remote.uploadTokens[0]}/crops`,
    { method: "POST", body: cropForm },
  );
  await stagingEntered;

  const { authService } = await import("../src/server/services/AuthService");
  const changed = await authService.changePassword(teacherId, oldPassword, newPassword);
  assert.equal(changed.success, true, changed.message);
  const hashAfterChange = (await db.get<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = ?", teacherId))!.password_hash;
  assert.equal(await verifyPassword(newPassword, hashAfterChange), true);
  releaseStaging();

  assert.equal((await cropPromise).status, 500);
  const hashAfterCrop = (await db.get<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = ?", teacherId))!.password_hash;
  assert.equal(await verifyPassword(newPassword, hashAfterCrop), true, "password change must not roll back with failed crop staging");
  assert.equal(await verifyPassword(oldPassword, hashAfterCrop), false);
  scannerCropStaging.write = originalWrite;
  console.log("PASS sqlite: committed password change survives EIO during crop staging");

  const cropOk = new FormData();
  cropOk.append("crops", new Blob([cropPng], { type: "image/png" }), "crop.png");
  cropOk.append("manifest", JSON.stringify([{
    blockId: "flow_q", blockTitle: "选择题", blockType: "objective", pageNumber: 1, segmentIndex: 0,
    questionNumbers: [1], rect: { x: 0, y: 0, width: 10, height: 10 }, widthPx: 12, heightPx: 12, dpi: 300,
    fileName: "crop.png",
  }]));
  assert.equal((await request(
    `/api/scanner/upload/sessions/${remote.sessionId}/pages/${remote.uploadTokens[0]}/crops`,
    { method: "POST", body: cropOk },
  )).status, 200);
  const committed = await db.get<{ image_path: string }>(
    "SELECT image_path FROM answer_block_crops WHERE source_record_id=?",
    remote.uploadTokens[0],
  );
  assert.ok(committed?.image_path && existsSync(committed.image_path));
  const preservedBytes = await readFile(committed.image_path);

  const { relocateUploadedCropsToStorage } = await import("../src/server/services/AnswerBlockCropService");
  const retryStaging = path.join(root, "retry-staging.png");
  const retryBytes = await sharp({ create: { width: 12, height: 12, channels: 3, background: { r: 200, g: 10, b: 10 } } }).png().toBuffer();
  await writeFile(retryStaging, retryBytes);
  const retryManifest = [{
    blockId: "flow_q", blockTitle: "选择题", blockType: "objective", pageNumber: 1, segmentIndex: 0,
    questionNumbers: [1], rect: { x: 0, y: 0, width: 10, height: 10 }, widthPx: 12, heightPx: 12, dpi: 300,
    path: retryStaging,
  }];
  const relocated = await relocateUploadedCropsToStorage({
    cardId: card.id, sourceType: "twain_scan_record", sourceRecordId: remote.uploadTokens[0],
  }, retryManifest);
  assert.notEqual(path.resolve(relocated.paths[0]!), path.resolve(committed.image_path),
    "retry staging must not target the committed crop path before the DB transaction");
  assert.deepEqual(await readFile(committed.image_path), preservedBytes,
    "relocate before persist must not replace the prior review image");

  await unlink(relocated.paths[0]!);
  assert.deepEqual(await readFile(committed.image_path), preservedBytes,
    "failed retry cleanup must retire only staged paths");
  console.log("PASS sqlite: crop retry keeps committed review images when staging is rolled back");

  const { persistAnswerBlockCrops } = await import("../src/server/services/AnswerBlockCropService");
  const { runScannerSessionTransaction } = await import("../src/server/services/scannerSubmissions");
  const rollbackStaging = path.join(root, "rollback-staging.png");
  const rollbackBytes = await sharp({
    create: { width: 12, height: 12, channels: 3, background: { r: 10, g: 200, b: 30 } },
  }).png().toBuffer();
  await writeFile(rollbackStaging, rollbackBytes);
  const rollbackRelocated = await relocateUploadedCropsToStorage({
    cardId: card.id, sourceType: "twain_scan_record", sourceRecordId: remote.uploadTokens[0],
  }, [{
    blockId: "flow_q", blockTitle: "选择题", blockType: "objective", pageNumber: 1, segmentIndex: 0,
    questionNumbers: [1], rect: { x: 0, y: 0, width: 10, height: 10 }, widthPx: 12, heightPx: 12, dpi: 300,
    path: rollbackStaging,
  }]);
  let rollbackThrown = false;
  try {
    await runScannerSessionTransaction(remote.sessionId, async (tx) => {
      await persistAnswerBlockCrops({
        cardId: card.id,
        sourceType: "twain_scan_record",
        sourceRecordId: remote.uploadTokens[0],
        crops: rollbackRelocated.crops,
        skipFileMoves: true,
      }, tx);
      throw new Error("forced rollback after crop persist");
    });
  } catch (error) {
    rollbackThrown = (error as Error).message === "forced rollback after crop persist";
  }
  assert.equal(rollbackThrown, true, "transaction must roll back after persist");
  const rowAfterRollback = await db.get<{ image_path: string }>(
    "SELECT image_path FROM answer_block_crops WHERE source_record_id=?",
    remote.uploadTokens[0],
  );
  assert.ok(rowAfterRollback?.image_path && existsSync(rowAfterRollback.image_path),
    "rolled-back retry must keep the committed crop row and file");
  assert.equal(path.resolve(rowAfterRollback!.image_path), path.resolve(committed.image_path));
  assert.deepEqual(await readFile(rowAfterRollback!.image_path), preservedBytes,
    "rolled-back retry must not delete the previously committed review image");
  await Promise.all(rollbackRelocated.paths.map((filePath) => unlink(filePath).catch(() => {})));
  console.log("PASS sqlite: rolled-back crop replace keeps prior committed images");

  const partialSource = path.join(root, "partial-ok.png");
  await writeFile(partialSource, retryBytes);
  const storageDir = path.dirname(committed.image_path);
  const beforeNames = new Set(readdirSync(storageDir));
  await assert.rejects(() => relocateUploadedCropsToStorage({
    cardId: card.id, sourceType: "twain_scan_record", sourceRecordId: remote.uploadTokens[0],
  }, [
    { ...retryManifest[0], path: partialSource },
    { ...retryManifest[0], path: path.join(root, "missing-crop.png"), segmentIndex: 1 },
  ]));
  assert.deepEqual(readdirSync(storageDir).filter((name) => !beforeNames.has(name)), [],
    "a later crop move failure must remove files already relocated in this call");
  assert.ok(existsSync(committed.image_path), "failed relocate must not remove the committed review image");
  console.log("PASS sqlite: partial crop relocate cleans the files it already moved");

  const { retireSupersededCropImages } = await import("../src/server/services/AnswerBlockCropService");
  const emptied = await db.transaction(async (tx) => persistAnswerBlockCrops({
    cardId: card.id,
    sourceType: "twain_scan_record",
    sourceRecordId: remote.uploadTokens[0],
    crops: [],
    skipFileMoves: true,
  }, tx));
  assert.ok(emptied.retireImagePaths?.some((filePath) => path.resolve(filePath) === path.resolve(committed.image_path)),
    "clearing crops must hand back the previous files for post-commit cleanup");
  assert.equal(await db.get("SELECT id FROM answer_block_crops WHERE source_record_id=?", remote.uploadTokens[0]), null);
  assert.equal(existsSync(committed.image_path), true, "the crop file stays until the caller retires it after commit");
  await retireSupersededCropImages(emptied.retireImagePaths ?? []);
  assert.equal(existsSync(committed.image_path), false, "post-commit retire removes the unreferenced crop file");
  console.log("PASS sqlite: empty crop replace retires the previous file only after commit");
} finally {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  resetAdapter();
  closeDatabase();
}
