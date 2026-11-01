import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import multer from "multer";
import { answerCardDataOperation, withAnswerCardDataMutationLock } from "../src/server/lib/answerCardDataLock";
import { multipartTask, taskDiskStorage } from "../src/server/lib/multipartTask";
import { asyncHandler } from "../src/server/lib/asyncHandler";
import { isServiceMaintenanceActive, runServiceTask, withServiceMaintenance } from "../src/server/lib/serviceTasks";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
async function listen(app: express.Express) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}
const deadline = () => AbortSignal.timeout(5000);

test("maintenance matches case-insensitive and absolute-form API requests", async () => {
  const app = express(); let writes = 0;
  app.post("/api/write", asyncHandler(async (_req, res) => { writes++; res.end(); }));
  const server = await listen(app); const holding = gate(); const entered = gate();
  const maintenance = withServiceMaintenance({} as express.Request, async () => { entered.release(); await holding.promise; });
  try {
    await entered.promise;
    for (const target of ["/api/write", "/API/write", `${server.url}/api/write`, `${server.url}/API/write`]) {
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request(server.url, { method: "POST", path: target, signal: deadline() }, res => { res.resume(); res.once("end", () => resolve(res.statusCode!)); });
        req.on("error", reject); req.end();
      });
      assert.equal(status, 503, target);
    }
    assert.equal(writes, 0);
    holding.release(); await maintenance;
    assert.equal((await fetch(server.url + "/API/write", { method: "POST", signal: deadline() })).status, 200);
    assert.equal(writes, 1);
  } finally { holding.release(); await maintenance; await server.close(); }
});

test("response completion does not release a task before its awaited cleanup", async () => {
  const cleanup = gate(); const started = gate(); const app = express();
  app.post("/api/write", answerCardDataOperation(async (_req, res) => {
    res.end("saved"); started.release(); await cleanup.promise;
  }));
  const server = await listen(app);
  try {
    assert.equal((await fetch(server.url + "/api/write", { method: "POST", signal: deadline() })).status, 200);
    await started.promise;
    let acquired = false;
    const following = withAnswerCardDataMutationLock(async () => { acquired = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(acquired, false);
    cleanup.release(); await following;
    assert.equal(acquired, true);
  } finally { cleanup.release(); await server.close(); }
});

test("a client that disconnects while queued never enters the operation", async () => {
  const locked = gate(); const holding = gate(); const queued = gate(); const closed = gate();
  const held = withAnswerCardDataMutationLock(async () => { holding.release(); await locked.promise; });
  await holding.promise;
  let entered = false; const app = express();
  app.post("/api/write", (req, res, next) => { res.once("close", closed.release); queued.release(); next(); },
    answerCardDataOperation(async (_req, res) => { entered = true; res.end(); }));
  const server = await listen(app);
  try {
    const client = http.request(server.url + "/api/write", { method: "POST" });
    client.on("error", () => undefined); client.end(); await queued.promise;
    client.destroy(); await closed.promise; locked.release(); await held;
    await withAnswerCardDataMutationLock(async () => undefined);
    assert.equal(entered, false);
  } finally { locked.release(); await server.close(); }
});

test("disconnect during async authorization skips upload and releases the next operation", async () => {
  const authorize = gate(); const entered = gate(); const closed = gate(); const app = express();
  let uploaded = false;
  app.post("/api/write", (req, res, next) => { res.once("close", closed.release); next(); }, answerCardDataOperation(
    async (_req, _res, next) => { entered.release(); await authorize.promise; next(); },
    async (_req, res) => { uploaded = true; res.end(); },
  ));
  const server = await listen(app);
  try {
    const client = http.request(server.url + "/api/write", { method: "POST" });
    client.on("error", () => undefined); client.end(); await entered.promise;
    client.destroy(); await closed.promise; authorize.release();
    await withAnswerCardDataMutationLock(async () => undefined);
    assert.equal(uploaded, false);
  } finally { authorize.release(); await server.close(); }
});

test("a thrown operation releases its lock after finally", async () => {
  const app = express(); let cleaned = false;
  app.post("/api/write", answerCardDataOperation(async () => {
    try { throw new Error("injected"); } finally { await Promise.resolve(); cleaned = true; }
  }));
  app.use((_err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.sendStatus(500); });
  const server = await listen(app);
  try {
    assert.equal((await fetch(server.url + "/api/write", { method: "POST", signal: deadline() })).status, 500);
    await withAnswerCardDataMutationLock(async () => assert.equal(cleaned, true));
  } finally { await server.close(); }
});

test("abort during asynchronous upload destination selection waits for cleanup", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "projectx-upload-task-"));
  const destination = gate(); const selecting = gate(); const closed = gate();
  let first = true;
  const upload = multer({ storage: taskDiskStorage({ destination: async (_req, _file, cb) => {
    if (first) { first = false; selecting.release(); await destination.promise; }
    cb(null, root);
  } }) });
  const app = express();
  app.post("/api/upload", (req, res, next) => { res.once("close", closed.release); next(); },
    answerCardDataOperation(multipartTask(upload.single("file")), async (req, res) => {
      await rm(req.file!.path); res.sendStatus(201);
    }));
  const server = await listen(app);
  try {
    const client = http.request(server.url + "/api/upload", { method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=probe" } });
    client.on("error", () => undefined);
    client.write('--probe\r\nContent-Disposition: form-data; name="file"; filename="x.txt"\r\nContent-Type: text/plain\r\n\r\npartial');
    await selecting.promise; client.destroy(); await closed.promise; destination.release();
    await withAnswerCardDataMutationLock(async () => undefined);
    assert.deepEqual(await readdir(root), []);
    const form = new FormData(); form.set("file", new Blob(["next"]), "next.txt");
    assert.equal((await fetch(server.url + "/api/upload", { method: "POST", body: form, signal: deadline() })).status, 201);
    assert.deepEqual(await readdir(root), []);
  } finally { destination.release(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

test("a rejected filename collision preserves the file owned by the earlier upload", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "projectx-upload-collision-"));
  const upload = multer({ storage: taskDiskStorage({ destination: root, filename: (_req, _file, cb) => cb(null, "owned.bin") }) });
  const app = express();
  app.post("/api/upload", answerCardDataOperation(
    multipartTask(upload.single("file"), (_error, _req, res) => { res.sendStatus(409); }),
    async (_req, res) => { res.sendStatus(201); },
  ));
  const server = await listen(app);
  try {
    for (const [body, expected] of [["original", 201], ["replacement", 409]] as const) {
      const form = new FormData(); form.set("file", new Blob([body]), "input.bin");
      assert.equal((await fetch(server.url + "/api/upload", { method: "POST", body: form, signal: deadline() })).status, expected);
    }
    assert.equal(await readFile(path.join(root, "owned.bin"), "utf8"), "original");
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

test("maintenance drains disconnected async work and rejects new requests", async () => {
  const entered = gate(); const finish = gate(); const closed = gate(); const app = express();
  let wrote = false; let replaced = false;
  app.post("/api/write", asyncHandler(async (_req, res) => {
    res.once("close", closed.release); entered.release(); await finish.promise; wrote = true;
    if (!res.destroyed) res.end();
  }));
  app.post("/api/restore", asyncHandler(async (req, res) => {
    await withServiceMaintenance(req, async () => { assert.equal(wrote, true); replaced = true; }); res.end();
  }));
  const server = await listen(app);
  try {
    const client = http.request(server.url + "/api/write", { method: "POST" });
    client.on("error", () => undefined); client.end(); await entered.promise; client.destroy(); await closed.promise;
    const restoring = fetch(server.url + "/api/restore", { method: "POST", signal: deadline() });
    while (!isServiceMaintenanceActive()) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(replaced, false);
    assert.equal((await fetch(server.url + "/api/write", { method: "POST", signal: deadline() })).status, 503);
    finish.release(); assert.equal((await restoring).status, 200); assert.equal(replaced, true);
  } finally { finish.release(); await server.close(); }
});

test("a busy maintenance attempt returns without invalidating admitted tasks", async () => {
  const finish = gate(); const app = express();
  const job = runServiceTask(() => finish.promise);
  app.post("/api/restore", asyncHandler(async (req, res) => {
    try { await withServiceMaintenance(req, async () => assert.fail("must not replace"), 20); }
    catch { res.sendStatus(409); }
  }));
  const server = await listen(app);
  try {
    assert.equal((await fetch(server.url + "/api/restore", { method: "POST", signal: deadline() })).status, 409);
    assert.equal(isServiceMaintenanceActive(), false);
    finish.release(); await job;
  } finally { finish.release(); await server.close(); }
});

test("maintenance drains child jobs started by an already admitted handler", async () => {
  const entered = gate(); const startChild = gate(); const childStarted = gate(); const childDone = gate();
  const app = express(); let job: Promise<void> | undefined; let replaced = false;
  app.post("/api/work", asyncHandler(async (_req, res) => {
    entered.release(); await startChild.promise;
    job = runServiceTask(async () => { childStarted.release(); await childDone.promise; });
    res.end();
  }));
  app.post("/api/restore", asyncHandler(async (req, res) => {
    await withServiceMaintenance(req, async () => { replaced = true; }); res.end();
  }));
  const server = await listen(app);
  try {
    const working = fetch(server.url + "/api/work", { method: "POST", signal: deadline() }); await entered.promise;
    const restoring = fetch(server.url + "/api/restore", { method: "POST", signal: deadline() });
    while (!isServiceMaintenanceActive()) await new Promise<void>(resolve => setImmediate(resolve));
    startChild.release(); await childStarted.promise; assert.equal((await working).status, 200);
    assert.equal(replaced, false); childDone.release(); await job;
    assert.equal((await restoring).status, 200); assert.equal(replaced, true);
  } finally { startChild.release(); childDone.release(); await server.close(); }
});

test("late callbacks from a finished request cannot write after maintenance", async () => {
  const app = express(); let late!: () => void; let wrote = false;
  const write = asyncHandler(async (_req, _res) => { wrote = true; });
  app.post("/api/work", asyncHandler(async (req, res) => {
    late = () => { void write(req, res, () => undefined); }; res.end();
  }));
  app.post("/api/restore", asyncHandler(async (req, res) => {
    await withServiceMaintenance(req, async () => undefined); res.end();
  }));
  const server = await listen(app);
  try {
    assert.equal((await fetch(server.url + "/api/work", { method: "POST", signal: deadline() })).status, 200);
    assert.equal((await fetch(server.url + "/api/restore", { method: "POST", signal: deadline() })).status, 200);
    late(); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(wrote, false);
  } finally { await server.close(); }
});
