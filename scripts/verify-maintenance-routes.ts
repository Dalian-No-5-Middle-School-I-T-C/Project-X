/** Real application routes: delayed upload writers and SSE completion during maintenance. */
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";

const root = await fsp.mkdtemp(path.join(tmpdir(), "projectx-maintenance-routes-"));
const cwd = process.cwd();
process.chdir(root);
process.env.PROJECTX_DB_PATH = path.join(root, "data", "projectx.db");
process.env.ANSWER_CARD_DATA_DIR = path.join(root, "data");
process.env.PROJECTX_TOKEN_DIR = path.join(root, "tokens");
process.env.PROJECTX_ENABLE_SCANNER = "0";
process.env.PROJECTX_AUTH_ENFORCE = "0";
delete process.env.PROJECTX_MARIADB_HOST;
delete process.env.PROJECTX_MYSQL_HOST;
const { createApp } = await import("../src/apps/answer-card/server/index");
const { withServiceMaintenance, isServiceMaintenanceActive } = await import("../src/server/lib/serviceTasks");
const { closeAdapter } = await import("../src/server/db/mysql");
const { closeDatabase } = await import("../src/server/db/index");
const { closeDb } = await import("../src/apps/answer-card/server/database");
const { CardRepository } = await import("../src/server/repositories/CardRepository");
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { release, promise }; }
const originalOpen = fs.open;
const originalFind = CardRepository.prototype.findById;
const app = await createApp();
const server = http.createServer(app);
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
try {
  for (const [route, field] of [["recognition", "file"], ["recognition/objective", "file"], ["grading", "files"], ["grading/objective", "files"]]) {
    const openStarted = gate(); const openGate = gate(); const disconnected = gate();
    let captured = "";
    fs.open = ((...args: any[]) => {
      if (String(args[0]).includes(`${path.sep}recognition${path.sep}uploads${path.sep}lifecycle-probe${path.sep}`)) {
        captured = String(args[0]); openStarted.release();
        void openGate.promise.then(() => (originalOpen as any)(...args));
      } else (originalOpen as any)(...args);
    }) as typeof fs.open;
    syncBuiltinESMExports();
    server.once("request", (_req, res) => res.once("close", disconnected.release));
    const client = http.request(`${base}/api/cards/lifecycle-probe/${route}`, { method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=probe" } });
    client.on("error", () => undefined);
    client.write(`--probe\r\nContent-Disposition: form-data; name="${field}"; filename="old.png"\r\nContent-Type: image/png\r\n\r\nOLD_REQUEST_DATA`);
    let entered = false;
    try {
      await openStarted.promise; client.destroy(); await disconnected.promise;
      const maintenance = withServiceMaintenance({} as any, async () => {
        entered = true; assert.equal(fs.existsSync(captured), false, "old upload must be removed before maintenance enters");
      });
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(isServiceMaintenanceActive(), true); assert.equal(entered, false);
      openGate.release(); await maintenance; assert.equal(entered, true);
      console.log(`PASS ${route}: disconnected disk writer drains before maintenance`);
    } finally { openGate.release(); client.destroy(); fs.open = originalOpen; syncBuiltinESMExports(); }
  }
  const lookupStarted = gate(); const lookupGate = gate();
  CardRepository.prototype.findById = async function(id: string) {
    if (id === "sse-probe") { lookupStarted.release(); await lookupGate.promise; throw new Error("injected grading lookup failure"); }
    return originalFind.call(this, id);
  };
  const sse = await fetch(`${base}/api/cards/sse-probe/grading/progress/sse-batch`, { signal: AbortSignal.timeout(10_000) });
  assert.equal(sse.status, 200);
  const writing = fetch(`${base}/api/cards/sse-probe/grading/objective`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ progressId: "sse-batch" }), signal: AbortSignal.timeout(10_000),
  });
  await lookupStarted.promise;
  const maintenance = withServiceMaintenance({} as any, async () => undefined);
  lookupGate.release();
  assert.equal((await writing).status, 500); await maintenance; await sse.body?.cancel();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal((await fetch(`${base}/api/app/health`)).status, 200);
  console.log("PASS maintenance closes SSE before late grading error without write-after-end");
} finally {
  fs.open = originalOpen; syncBuiltinESMExports(); CardRepository.prototype.findById = originalFind;
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  closeDb(); closeDatabase(); await closeAdapter(); process.chdir(cwd); await fsp.rm(root, { recursive: true, force: true });
}
