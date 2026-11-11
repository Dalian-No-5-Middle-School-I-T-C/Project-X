import assert from "node:assert/strict";
import { writeFile, readFile, chmod, readdir } from "node:fs/promises";
import path from "node:path";
import type { Server } from "node:http";
import { startScannerFlowFixture } from "./scanner-upload-flow-fixture";
import { createScannerUploadManager } from "../src/apps/answer-card/client/lib/scannerUploadManager";
import type { CombinedGradingBatchResult, CombinedRecognitionResult } from "../src/shared/types";
import {
  isSessionGroupedOcrBatch,
  isSessionGroupedRecordBatch,
  isUploadRecognizedStudentStamp,
} from "./smoke-sql-match";

// Real DB/HTTP paths with deterministic recognizer output; supports an empty
// projectx_scanner_batch_* MariaDB database via the existing fixture variables.
const fixture = await startScannerFlowFixture(0, "127.0.0.1", { duplex: true });
let localServer: Server | undefined;
try {
  const info = await (await fetch(`${fixture.baseUrl}/test/fixture`)).json();
  const { getMysqlDb } = await import("../src/server/db");
  const { CardRepository } = await import("../src/server/repositories/CardRepository");
  const store = await import("../src/apps/answer-card/server/database/scan-store");
  const { storeCorrectionPage, sessionCorrection } = await import("../src/server/services/scanCorrection");
  const { enqueueScannerSubmission } = await import("../src/server/services/scannerSubmissions");
  const { runOcrOnSession } = await import("../src/apps/answer-card/server/scanner/scanner-service");
  const db = getMysqlDb(), card = (await new CardRepository().findById(info.cardId))!;
  const recognition = (pageNumber: number): CombinedRecognitionResult => ({ status: "ok", pageNumber,
    identity: { status: "verified", code: "QR_VERIFIED", cardId: card.id, pageNumber },
    studentId: { status: "ok", value: "91001" }, questions: [], subjectiveQuestions: [],
    geometry: { imageWidth: 24, imageHeight: 24, imageToLayout: [1,0,0,0,1,0,0,0,1], layoutToImage: [1,0,0,0,1,0,0,0,1] },
  });
  const session = await store.createSession(card.id, "400-page query regression");
  const records = [];
  for (let i = 0; i < 400; i++) {
    const record = await store.createScanRecord({ sessionId: session.id, cardId: card.id, pageNum: Math.floor(i / 2) + 1,
      side: i % 2 ? "back" : "front", imagePath: "query-only.png" });
    records.push(record);
    if (i !== 0) await store.upsertRecognitionResult({ scanRecordId: record.id, objectiveJson: "[]", subjectiveJson: "[]" });
    if (i >= 398) await storeCorrectionPage(card, "twain_scan_record", record.id, recognition(i % 2 + 1));
  }
  const all = db.all.bind(db), get = db.get.bind(db);
  let reads = 0, loadedRows = 0;
  db.all = async <T>(sql: string, ...params: any[]): Promise<T[]> => {
    reads++; const rows = await all<T>(sql, ...params);
    if (isSessionGroupedRecordBatch(sql) || isSessionGroupedOcrBatch(sql)) loadedRows += rows.length;
    return rows;
  };
  db.get = async <T>(sql: string, ...params: any[]): Promise<T | null> => { reads++; return get<T>(sql, ...params); };
  try {
    const grouped = await store.listScanRecordsGroupedByStudent(session.id);
    assert.equal(grouped.flatMap(g => g.records).length, 400);
    assert.equal(grouped[0].records.find(r => r.id === records[0].id)?.recognition, null);
    assert.equal(reads, 2, "400 pages must use two reads including missing OCR rows");
    reads = loadedRows = 0;
    const correction = await sessionCorrection(card, session.id, "199", false);
    assert.deepEqual(correction.pages.map(p => p.sourceId), records.slice(-2).map(r => r.id));
    assert.equal(loadedRows, 4, "load only the selected card's two records and two OCR rows");
    assert.equal(reads, 5, "session + two batch queries + two correction snapshots");
  } finally { db.all = all; db.get = get; }
  console.log(`PASS ${db.dialect}: 400-page recognition read = 2 queries; two-sided correction = 5 queries / 2 pages`);

  const image = path.join(process.env.ANSWER_CARD_DATA_DIR!, "queue.png");
  await writeFile(image, Buffer.from(info.images.original, "base64"));
  const queueSession = await store.createSession(card.id, "queue fairness");
  for (let i = 0; i < 4; i++) await store.createScanRecord({ sessionId: queueSession.id, cardId: card.id,
    pageNum: Math.floor(i / 2) + 1, side: i % 2 ? "back" : "front", imagePath: image });
  const order: string[] = [];
  let interleaved: Promise<void> | undefined;
  await runOcrOnSession(queueSession.id, card.id, () => {}, undefined, async request => {
    order.push(`ocr${order.filter(x => x.startsWith("ocr")).length + 1}`);
    if (order.length === 1) interleaved = enqueueScannerSubmission(async () => { order.push("other-upload"); });
    return recognition(request.pageNumber);
  });
  await interleaved;
  assert.deepEqual(order, ["ocr1", "ocr2", "other-upload", "ocr3", "ocr4"]);
  console.log(`PASS ${db.dialect}: another upload runs between cards, preserving both sides of each card`);

  // Force a transaction failure after staging new image bytes. The previous
  // original must remain intact, and failed retries must not accumulate files.
  const request = (url: string, init?: RequestInit) => fetch(`${fixture.baseUrl}${url}`, {
    ...init, headers: { ...init?.headers, "X-Api-Key": info.key },
  });
  const created = await request("/api/scanner/upload/sessions", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cardId: card.id, cardVersion: info.version, pageCount: 2, name: "rollback" }) });
  assert.equal(created.status, 201);
  const remote = await created.json();
  const uploadImage = (encoded: string) => {
    const form = new FormData();
    form.append("image", new Blob([Buffer.from(encoded, "base64")], { type: "image/png" }), "image.html");
    form.append("token", remote.uploadTokens[0]); form.append("pageNum", "1"); form.append("side", "front");
    form.append("recognition", JSON.stringify(recognition(1)));
    return request(`/api/scanner/upload/sessions/${remote.sessionId}/pages`, { method: "POST", body: form });
  };
  assert.equal((await uploadImage(info.images.original)).status, 200);
  const original = (await store.getScanRecord(remote.uploadTokens[0]))!;
  assert.notEqual(path.extname(original.image_path), ".html", "file extension stays in the image allowlist");
  const filesBefore = (await readdir(path.dirname(original.image_path))).sort();
  const transaction = db.transaction.bind(db);
  db.transaction = fn => transaction(async tx => {
    const run = tx.run.bind(tx);
    tx.run = async (sql, ...params) => {
      if (isUploadRecognizedStudentStamp(sql)) throw new Error("injected upload rollback");
      return run(sql, ...params);
    };
    try { return await fn(tx); } finally { tx.run = run; }
  });
  try { assert.equal((await uploadImage(info.images.different)).status, 500); }
  finally { db.transaction = transaction; }
  assert.equal((await store.getScanRecord(original.id))!.image_path, original.image_path);
  assert.deepEqual(await readFile(original.image_path), Buffer.from(info.images.original, "base64"));
  for (let i = 0; i < 100; i++) {
    if ((await readdir(path.dirname(original.image_path))).length === filesBefore.length) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.deepEqual((await readdir(path.dirname(original.image_path))).sort(), filesBefore);
  console.log(`PASS ${db.dialect}: failed image transaction preserves original and removes staged file`);

  // Legacy rows can share one original. Hold the next queued transaction after
  // replacing its reference, then roll it back while the first upload cleans up.
  await db.run("UPDATE twain_scan_records SET image_path = ? WHERE id = ?", original.image_path, remote.uploadTokens[1]);
  let releaseRollback!: () => void, enteredRollback!: () => void;
  const rollbackGate = new Promise<void>(resolve => { releaseRollback = resolve; });
  const rollbackEntered = new Promise<void>(resolve => { enteredRollback = resolve; });
  let competing: Promise<unknown> | undefined;
  db.transaction = async fn => {
    const result = await transaction(fn);
    competing = enqueueScannerSubmission(() => transaction(async tx => {
      await tx.run("UPDATE twain_scan_records SET image_path = ? WHERE id = ?", "uncommitted-candidate.png", remote.uploadTokens[1]);
      enteredRollback();
      await rollbackGate;
      throw new Error("injected shared-original rollback");
    })).catch(error => { assert.match(String(error), /injected shared-original rollback/); });
    return result;
  };
  const replacement = uploadImage(info.images.different);
  let settled = false;
  void replacement.then(() => { settled = true; });
  try {
    await rollbackEntered;
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(settled, false, "image cleanup waits for the queued transaction to settle");
  } finally {
    releaseRollback();
    db.transaction = transaction;
    await competing;
  }
  assert.equal((await replacement).status, 200);
  assert.equal((await store.getScanRecord(remote.uploadTokens[1]))!.image_path, original.image_path);
  assert.deepEqual(await readFile(original.image_path), Buffer.from(info.images.original, "base64"));
  console.log(`PASS ${db.dialect}: shared original survives another upload's uncommitted reference change and rollback`);

  // Exercise /grading -> on-disk payload -> upload manager with one native launch.
  const root = process.env.ANSWER_CARD_DATA_DIR!;
  const executable = path.join(root, "recognizer-fixture.cjs"), callLog = path.join(root, "recognizer-calls.txt");
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), arg = name => args[args.indexOf(name) + 1];
fs.appendFileSync(${JSON.stringify(callLog)}, 'run\\n');
const page = Number(arg('--page')), result = ${JSON.stringify(recognition(1))};
result.pageNumber = page; result.identity.pageNumber = page;
const crop = path.join(arg('--crops-dir'), 'crop.png');
fs.writeFileSync(crop, Buffer.from(${JSON.stringify(info.images.original)}, 'base64'));
result.blockCrops = [{path: crop, blockId: 'flow_q', blockTitle: 'choice', blockType: 'objective', pageNumber: page,
segmentIndex: 1, questionNumbers: ['1'], rect: {x:0,y:0,width:1,height:1}, widthPx:24,heightPx:24,dpi:300}];
process.stdout.write(JSON.stringify(result));
`, "utf8");
  await chmod(executable, 0o755);
  process.env.ANSWER_CARD_RECOGNIZER_EXE = executable;
  process.env.PROJECTX_AUTH_ENFORCE = "0";
  process.env.PROJECTX_ENABLE_SCANNER = "0";
  const { createApp } = await import("../src/apps/answer-card/server/index");
  localServer = (await createApp()).listen(0, "127.0.0.1");
  await new Promise<void>(resolve => localServer!.once("listening", resolve));
  const base = `http://127.0.0.1:${(localServer.address() as { port: number }).port}`;
  const form = new FormData();
  form.append("files", new Blob([Buffer.from(info.images.original, "base64")], { type: "image/png" }), "import.png");
  form.append("prepareUpload", "1"); form.append("pageOrder", "sequential");
  const response = await fetch(`${base}/api/cards/${card.id}/grading`, { method: "POST", body: form });
  assert.equal(response.status, 200, await response.clone().text());
  const result = await response.json() as CombinedGradingBatchResult;
  assert.equal(result.rows[0].recognition.status, "ok", JSON.stringify(result.rows[0]));
  assert.ok(result.rows[0].uploadPayloadUrl);
  assert.equal(result.rows[0].inputIndex, 0);
  let sentCrop = false;
  const manager = createScannerUploadManager({ isOnline: () => true, getServerKind: () => "online",
    timeoutSignal: () => new AbortController().signal,
    localFetch: (url, init) => fetch(`${base}${url}`, init),
    remoteFetch: async (url, init) => {
      if (url.endsWith("/sessions")) return Response.json({ sessionId: "import", uploadTokens: ["page"] });
      if (url.endsWith("/crops")) {
        sentCrop = true;
        assert.deepEqual(Buffer.from(await ((init!.body as FormData).get("crops") as Blob).arrayBuffer()), Buffer.from(info.images.original, "base64"));
        return Response.json({ count: 1 });
      }
      return Response.json({ ok: true });
    },
  });
  const job = manager.startUpload({ kind: "import", cardId: card.id, cardVersion: result.cardVersion!, name: "reuse import",
    pages: [{ pageNum: 1, side: "front", uploadPayloadUrl: result.rows[0].uploadPayloadUrl,
      getBlob: async () => new Blob([Buffer.from(info.images.original, "base64")]) }] });
  const deadline = Date.now() + 5000;
  while (!manager.getState().jobs.some(j => j.id === job && (j.status === "done" || j.status === "error"))) {
    assert.ok(Date.now() < deadline, "import upload must complete");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(manager.getState().jobs[0].status, "done", manager.getState().jobs[0].message);
  assert.ok(sentCrop);
  assert.equal((await readFile(callLog, "utf8")).trim(), "run", "grading and upload share one recognition");
  console.log(`PASS ${db.dialect}: HTTP import grading and upload reuse one native result and identical crop bytes`);
} finally {
  if (localServer) await new Promise<void>(resolve => localServer!.close(() => resolve()));
  await fixture.close();
  await (await import("../src/server/db/mysql")).closeAdapter();
}
