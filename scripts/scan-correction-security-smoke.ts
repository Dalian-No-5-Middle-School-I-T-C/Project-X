import assert from "node:assert/strict";
import { open, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { startScannerFlowFixture } from "./scanner-upload-flow-fixture";
import { cardFingerprint } from "../src/shared/cardVersion";

const fixture = await startScannerFlowFixture();
try {
  const info = await (await fetch(`${fixture.baseUrl}/test/fixture`)).json();
  const { getMysqlDb } = await import("../src/server/db");
  const { CardRepository } = await import("../src/server/repositories/CardRepository");
  const store = await import("../src/apps/answer-card/server/database/scan-store");
  const { hashSecret } = await import("../src/server/lib/field-crypto");
  const { recognizeSessionCorrection } = await import("../src/server/services/scanCorrection");
  const { assertScanImageDimensions, scanImagePixelLimit, ScanImageBudgetError } = await import("../src/server/lib/scanImageBudget");
  const db = getMysqlDb(), card = (await new CardRepository().findById(info.cardId))!;
  const png = Buffer.from(info.images.original, "base64");
  for (const format of ["jpeg", "tiff", "webp"] as const) {
    const bytes = await sharp(png).toFormat(format).toBuffer();
    assert.deepEqual(await assertScanImageDimensions(bytes), { width: 24, height: 24 }, `${format} headers remain supported`);
  }
  const bmp = Buffer.alloc(54); bmp.write("BM"); bmp.writeUInt32LE(54, 2); bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14); bmp.writeUInt32LE(24, 18); bmp.writeInt32LE(-24, 22);
  assert.deepEqual(await assertScanImageDimensions(bmp), { width: 24, height: 24 }, "top-down BMP headers remain supported");
  assert.equal(scanImagePixelLimit("1000000", "x64"), 1_000_000);
  assert.equal(scanImagePixelLimit("999999999999", "x64"), 400_000_000);
  assert.equal(scanImagePixelLimit("0", "x64"), 100_000_000);
  assert.equal(scanImagePixelLimit("9223372036854775808", "x64"), 100_000_000);
  assert.equal(scanImagePixelLimit("bad", "ia32"), 40_000_000);
  const ordinary = Buffer.from(png); ordinary.writeUInt32BE(7016, 16); ordinary.writeUInt32BE(9933, 20);
  assert.deepEqual(await assertScanImageDimensions(ordinary), { width: 7016, height: 9933 }, "A3 at 600 DPI remains within the default pixel budget");
  const oversized = Buffer.from(png); oversized.writeUInt32BE(30000, 16); oversized.writeUInt32BE(30000, 20);
  await assert.rejects(assertScanImageDimensions(oversized), ScanImageBudgetError);
  const originalPixelEnv = process.env.PROJECTX_RECOGNIZER_MAX_IMAGE_PIXELS;
  try {
    process.env.PROJECTX_RECOGNIZER_MAX_IMAGE_PIXELS = "1000000";
    await assert.rejects(assertScanImageDimensions(ordinary), ScanImageBudgetError);
  } finally {
    if (originalPixelEnv === undefined) delete process.env.PROJECTX_RECOGNIZER_MAX_IMAGE_PIXELS;
    else process.env.PROJECTX_RECOGNIZER_MAX_IMAGE_PIXELS = originalPixelEnv;
  }
  const imagePath = path.join(process.env.ANSWER_CARD_DATA_DIR!, "large-recovery.png");
  await writeFile(imagePath, Buffer.from(info.images.original, "base64"));
  // Sparse trailing data keeps fixture setup small but forces hashing the full scan.
  const imageSize = 64 * 1024 * 1024;
  await truncate(imagePath, imageSize);
  async function source() {
    const session = await store.createSession(card.id, "recovery security");
    await db.run("UPDATE twain_scan_sessions SET status='completed',card_version=?,version_source='upload' WHERE id=?", cardFingerprint(card), session.id);
    const record = await store.createScanRecord({ sessionId: session.id, cardId: card.id, pageNum: 1, imagePath });
    await db.run("UPDATE twain_scan_records SET ocr_status='failed' WHERE id=?", record.id);
    return { session, record, url: `${fixture.baseUrl}/api/scanner/upload/sessions/${session.id}/groups/0/correction` };
  }
  const keys = [info.key, "correction-security-second", "correction-security-third"];
  for (const key of keys.slice(1)) await db.run("INSERT INTO api_keys (name,api_key,scope,is_active) VALUES (?,?,'scanner',1)", key, hashSecret(key));
  const request = (url: string, key = keys[0]) => fetch(url, { headers: { "X-Api-Key": key } });
  const upload = await fetch(`${fixture.baseUrl}/api/scanner/upload/sessions`, { method: "POST", headers: { "X-Api-Key": info.key, "Content-Type": "application/json" },
    body: JSON.stringify({ cardId: card.id, cardVersion: cardFingerprint(card), pageCount: 1 }) });
  assert.equal(upload.status, 201);
  const uploadedSession = await upload.json(), token = uploadedSession.uploadTokens[0];
  const uploadState = JSON.stringify(await db.get("SELECT * FROM twain_scan_records WHERE id=?", token));
  const form = new FormData(); form.set("image", new Blob([oversized], { type: "image/png" }), "oversized.png");
  form.set("token", token); form.set("pageNum", "1"); form.set("side", "front");
  const rejectedUpload = await fetch(`${fixture.baseUrl}/api/scanner/upload/sessions/${uploadedSession.sessionId}/pages`, { method: "POST", headers: { "X-Api-Key": info.key }, body: form });
  assert.equal(rejectedUpload.status, 413); assert.equal((await rejectedUpload.json()).code, "SCAN_IMAGE_PIXEL_LIMIT");
  assert.equal(JSON.stringify(await db.get("SELECT * FROM twain_scan_records WHERE id=?", token)), uploadState, "oversized upload leaves the record unchanged");
  const oversizedPath = path.join(process.env.ANSWER_CARD_DATA_DIR!, "old-oversized.png");
  await writeFile(oversizedPath, oversized);
  const oldOversized = await source();
  await db.run("UPDATE twain_scan_records SET image_path=? WHERE id=?", oversizedPath, oldOversized.record.id);
  const refused = await request(oldOversized.url);
  assert.equal(refused.status, 409); assert.match((await refused.json()).message, /安全像素上限/);
  let recognizerCalled = false;
  await assert.rejects(recognizeSessionCorrection(card, oldOversized.session.id, "0", {}, async () => {
    recognizerCalled = true; throw new Error("oversized scan reached recognizer");
  }), ScanImageBudgetError);
  assert.equal(recognizerCalled, false, "oversized historical scans are rejected before native recognition");
  const first = await source();
  assert.equal((await fetch(first.url)).status, 401, "authorization precedes recovery work");
  const burst = await Promise.all(Array.from({ length: 8 }, () => request(first.url)));
  assert.equal(burst.filter(r => r.status === 200).length, 1, "one key/session has only one in-flight correction");
  assert.equal(burst.filter(r => r.status === 429).length, 7, "parallel reads are rejected without queueing scans");
  for (const response of burst.filter(r => r.status === 429)) assert.equal((await response.json()).code, "CORRECTION_BUSY");
  const original = await burst.find(r => r.status === 200)!.json();

  const other = await source();
  const sameKey = await Promise.all([request(first.url), request(other.url)]);
  assert.equal(sameKey.filter(r => r.status === 200).length, 1, "switching sessions cannot bypass the key concurrency limit");
  assert.equal(sameKey.filter(r => r.status === 429).length, 1);
  const sameSession = await Promise.all([request(first.url, keys[1]), request(first.url, keys[2])]);
  assert.equal(sameSession.filter(r => r.status === 200).length, 1, "switching keys cannot bypass the session concurrency limit");
  assert.equal(sameSession.filter(r => r.status === 429).length, 1);
  const third = await source();
  const global = await Promise.all([request(first.url), request(other.url, keys[1]), request(third.url, keys[2])]);
  assert.equal(global.filter(r => r.status === 200).length, 2, "different keys and sessions share a global bound");
  assert.equal(global.filter(r => r.status === 429).length, 1);

  const image = await open(imagePath, "r+");
  try { await image.write(Buffer.from([1]), 0, 1, imageSize - 1); } finally { await image.close(); }
  const changed = await (await request(first.url)).json();
  assert.notEqual(changed.pages[0].recovery.fingerprint, original.pages[0].recovery.fingerprint, "streaming hash covers bytes beyond the image header");
  await assert.rejects(recognizeSessionCorrection(card, first.session.id, "0", {
    version: original.version, pages: [{ sourceId: first.record.id, fingerprint: original.pages[0].recovery.fingerprint }],
  }, async () => { throw new Error("stale scan must not reach recognition"); }), /原卷或版式已变化/);

  await db.run("UPDATE twain_scan_records SET image_path=? WHERE id=?", path.join(process.env.ANSWER_CARD_DATA_DIR!, "missing.png"), first.record.id);
  assert.equal((await request(first.url)).status, 409, "unreadable source fails");
  await db.run("UPDATE twain_scan_records SET image_path=? WHERE id=?", imagePath, first.record.id);
  assert.equal((await request(first.url)).status, 200, "failed reads release their concurrency slot");

  // Use an already-saved source to check rates without performing file I/O.
  await db.run("INSERT INTO scanner_submissions (exam_id,session_id,group_id,student_number,state,pages_json) VALUES ((SELECT id FROM exams WHERE card_id=?),?,'0','91001','saved','[]')", card.id, third.session.id);
  let sessionLimited = false;
  for (let i = 0; i < 31; i++) {
    const response = await request(third.url, keys[2]);
    if (response.status === 429) {
      assert.equal((await response.json()).code, "CORRECTION_RATE_LIMITED");
      sessionLimited = true;
      break;
    }
    assert.equal(response.status, 409);
  }
  assert(sessionLimited, "sequential requests are limited per session");
  let callerLimited = false;
  for (let i = 0; i < 61; i++) {
    const response = await request(`${fixture.baseUrl}/api/scanner/upload/sessions/${first.session.id}/groups/missing-${i}/correction`, keys[2]);
    if (response.status === 429 && response.headers.get("ratelimit-limit") === "60") {
      callerLimited = true;
      break;
    }
  }
  assert(callerLimited, "the caller rate limit covers all groups and sessions");
  console.log("PASS correction recovery security: decoded-pixel bounds, supported image headers, upload/recovery preflight, concurrent key/session/global bounds, full-file fingerprint, stale source rejection, error cleanup and request rate limits");
} finally { await fixture.close(); }
