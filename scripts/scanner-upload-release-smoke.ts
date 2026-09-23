import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createScannerUploadManager } from "../src/apps/answer-card/client/lib/scannerUploadManager";

// Run with node --expose-gc --import tsx. Observe reachability, not input mutation
// or the absence of getBlob calls: a retained closure can leak without being read.
const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
assert(gc, "This test requires --expose-gc");
const manager = createScannerUploadManager({
  isOnline: () => false,
  getServerKind: () => "offline",
  remoteFetch: async () => { throw new Error("No network expected"); },
});

function startJob() {
  const payload = { blob: new Blob([new Uint8Array(1024 * 1024)]) };
  const ref = new WeakRef(payload);
  const id = manager.startUpload({
    kind: "scan", cardId: "release-test", name: "release-test",
    pages: [{ pageNum: 1, side: "front", getBlob: async () => payload.blob }],
  });
  return { id, ref };
}

const { id, ref } = startJob();
for (let i = 0; i < 100 && manager.getState().jobs[0]?.status !== "paused"; i++) await delay(10);
assert.equal(manager.getState().jobs[0]?.status, "paused");
await delay(0);
gc();
assert(ref.deref(), "Paused jobs must retain data for retry");
manager.cancelJob(id);
let collected = false;
for (let i = 0; i < 100; i++) {
  // WeakRef.deref keeps its target alive until the current JS turn ends.
  await delay(10);
  gc();
  if (!ref.deref()) { collected = true; break; }
}
assert.equal(manager.getState().jobs[0]?.status, "cancelled");
assert(collected, "Cancelled job still retains its page payload");
manager.dismissJob(id);
console.log("PASS scanner upload release: retry retains payload; cancellation releases it");
