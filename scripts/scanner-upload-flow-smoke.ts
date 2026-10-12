/** Real upload manager -> authenticated HTTP -> SQLite/MariaDB persistence.
 * Recognition outcomes are controlled fixtures; this is not hardware OMR acceptance. */
import assert from "node:assert/strict";
import { createScannerUploadManager, type UploadJobSnapshot } from "../src/apps/answer-card/client/lib/scannerUploadManager";
import { uniqueScanConflictCards } from "../src/shared/scanPages";

const local = process.env.SCANNER_RECOVERY_REMOTE_URL ? null
  : await (await import("./scanner-upload-flow-fixture")).startScannerFlowFixture();
const base = process.env.SCANNER_RECOVERY_REMOTE_URL ?? local!.baseUrl;
const fixture = await (await fetch(`${base}/test/fixture`)).json() as {
  cardId: string; version: string; key: string; images: Record<string, string>; dialect: string;
};
const calls: Array<{ url: string; status: number }> = [];
const request = async (url: string, init?: RequestInit) => {
  const headers = new Headers(init?.headers); headers.set("X-Api-Key", fixture.key);
  const res = await fetch(`${base}${url}`, { ...init, headers });
  calls.push({ url, status: res.status }); return res;
};
const manager = createScannerUploadManager({ remoteFetch: request, isOnline: () => true,
  getServerKind: () => "online", sleep: async () => {}, timeoutSignal: () => new AbortController().signal,
  localFetch: async (_url, init) => {
    const image = (init!.body as FormData).get("file") as Blob;
    const encoded = Buffer.from(await image.arrayBuffer()).toString("base64");
    const kind = Object.keys(fixture.images).find(name => fixture.images[name] === encoded);
    const numbers: Record<string, string> = { original: "91001", different: "91001", normal: "91002", replacement: "91004", unknown: "91999", after: "91006", discard: "91002" };
    const failed = kind === "blank" || kind === "unreadable";
    return Response.json({ status: failed ? "failed" : "ok", message: kind === "blank" ? "Student ID recognition failed." : failed ? "Image markers unavailable." : undefined,
      identity: { status: "verified", code: "QR_VERIFIED", cardId: fixture.cardId, pageNumber: 1 },
      studentId: kind && numbers[kind] ? { status: "ok", value: numbers[kind] } : { status: "missing" },
      quality: { matchCount: kind === "unreadable" ? 0 : 4, missingRoles: [] },
      questions: [{ questionNumber: 1, selectedOptions: ["A"], confidence: 1 }], subjectiveQuestions: [] });
  },
});
async function terminal(id: string): Promise<UploadJobSnapshot> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const job = manager.getState().jobs.find(j => j.id === id)!;
    if (["done", "error"].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Upload queue stalled: ${id}`);
}
function enqueue(kind: string) {
  return manager.startUpload({ kind: "import", cardId: fixture.cardId, cardVersion: fixture.version, name: kind,
    pages: [{ groupId: "0", layoutPage: 1, pageNum: 1, side: "front", getBlob: async () => new Blob([Buffer.from(fixture.images[kind], "base64")], { type: "image/png" }) }] });
}
async function state() {
  return await (await request("/test/state")).json() as {
    scores: Array<{ student_number: string; total_score: number }>;
    receipts: Array<{ session_id: string; group_id: string; student_number: string; state: string }>;
  };
}
function cards(id: string) {
  const job = manager.getState().jobs.find(j => j.id === id)!;
  return uniqueScanConflictCards([...(job.reviewCards ?? []), ...(job.failures?.flatMap(f => f.conflicts ?? []) ?? [])]);
}
try {
  const original = enqueue("original");
  assert.equal((await terminal(original)).status, "done");
  const originalSession = (await state()).receipts.find(r => r.state === "saved")!.session_id;
  const reupload = enqueue("original");
  assert.equal((await terminal(reupload)).status, "done");
  assert.equal((await state()).scores.length, 1, "exact re-upload keeps one grade");
  assert.equal((await state()).receipts.filter(r => r.state === "discarded").length, 1);

  const duplicate = enqueue("different");
  const blank = enqueue("blank");
  const unreadable = enqueue("unreadable");
  const unknown = enqueue("unknown");
  const normal = enqueue("normal");
  for (const id of [duplicate, blank, unreadable, unknown]) assert.equal((await terminal(id)).status, "error");
  assert.equal((await terminal(normal)).status, "done", "normal upload following all abnormal cards completes");
  assert.deepEqual((await state()).scores.map(s => s.student_number), ["91002"]);
  assert.equal((await terminal(original)).status, "error", "withdrawn grade is not displayed as saved");

  assert.equal((await manager.getFailedPageBlobs(blank)).length, 1, "failed original remains viewable");
  manager.correctStudentId(blank, "91003");
  assert.equal((await terminal(blank)).status, "done", "blank student number recovers after explicit correction");
  manager.correctStudentId(unreadable, "91004");
  assert.equal((await terminal(unreadable)).status, "error", "manual number cannot bypass broken image recognition");
  assert.equal((await terminal(enqueue("replacement"))).status, "done", "readable rescan uploads through a new task");
  assert.equal((await terminal(unreadable)).status, "error", "unreadable original remains available without blocking its rescan");

  const unknownCard = manager.getState().jobs.find(j => j.id === unknown)!.reviewCards![0];
  assert((await manager.requestJob(unknown, `/api/scanner/upload/sessions/${unknownCard.sessionId}/correct`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ groupId: unknownCard.groupId, studentId: "91007" }) })).ok);
  assert((await manager.saveSession(unknown, unknownCard.sessionId)).ok);
  await manager.refreshResults(unknown);
  assert.equal((await terminal(unknown)).status, "done", "roster error recovers through remote correction and save");

  const newCard = cards(duplicate).find(c => c.sessionId !== originalSession)!;
  assert((await manager.requestJob(duplicate, `/api/scanner/upload/sessions/${newCard.sessionId}/correct`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ groupId: newCard.groupId, studentId: "91005" }) })).ok);
  assert((await manager.saveSession(duplicate, originalSession)).ok);
  assert((await manager.saveSession(duplicate, newCard.sessionId)).ok);
  await manager.refreshResults(duplicate);
  assert.equal((await terminal(original)).status, "done", "original grade restored after duplicate correction");

  const discard = enqueue("discard");
  assert.equal((await terminal(discard)).status, "error");
  const discardCard = cards(discard).find(c => !c.previouslySaved)!;
  assert((await manager.requestJob(discard, `/api/scanner/upload/sessions/${discardCard.sessionId}/groups/${discardCard.groupId}/discard`, { method: "POST" })).ok);
  assert((await manager.saveSession(discard, discardCard.sessionId)).ok);
  const originalNormal = (await state()).receipts.find(r => r.student_number === "91002" && r.state === "pending")!;
  assert((await manager.saveSession(discard, originalNormal.session_id)).ok);
  await manager.refreshResults(discard);
  assert.equal((await terminal(discard)).status, "done", "discarded paper finishes without recreating a conflict");
  assert.equal((await terminal(enqueue("after"))).status, "done", "next scan batch uploads after all manual recovery");
  assert.equal((await state()).scores.length, 7);
  console.log(`PASS scanner upload flow: ${process.platform} client -> ${fixture.dialect}, ${calls.length} real HTTP requests; exact reupload / duplicate / blank ID / unreadable / roster / correction / discard / next batch`);
} finally { await local?.close(); }
