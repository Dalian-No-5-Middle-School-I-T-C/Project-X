/** Exercise native partial failures through the real child-process, persistence and SSE workflow. */
import assert from "node:assert/strict";
import { writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { startScannerFlowFixture } from "./scanner-upload-flow-fixture";

const cwd = process.cwd();
const originalBridge = process.env.SCANNER_BRIDGE_EXE;
const originalRecognizer = process.env.ANSWER_CARD_RECOGNIZER_EXE;
const fixture = await startScannerFlowFixture();
const root = process.cwd();
let closeHttp: (() => Promise<void>) | undefined;
try {
  const info = await (await fetch(`${fixture.baseUrl}/test/fixture`)).json();
  const { createScanSession, runScanSession } = await import("../src/apps/answer-card/server/scanner/scanner-service");
  const { getSession, listScanRecords } = await import("../src/apps/answer-card/server/database/scan-store");
  const { liveBridgeCount } = await import("../src/apps/answer-card/server/scanner/twain-bridge");
  const { default: express } = await import("express");
  const { createScannerRouter } = await import("../src/apps/answer-card/server/scanner");
  const { makeScannerAuth } = await import("../src/server/middleware/scanner-auth");
  const app = express();
  app.use(express.json());
  app.use("/api/scanner", makeScannerAuth(true), createScannerRouter(true));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  closeHttp = () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  const api = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/scanner`;
  const image = path.join(root, "page.png");
  await writeFile(image, Buffer.from(info.images.original, "base64"));
  const recognizer = path.join(root, "recognizer.cjs");
  await writeFile(recognizer, `#!${process.execPath}\nconsole.log(JSON.stringify({status:'failed',message:'isolated unreadable test card'}));\n`, { mode: 0o755 });
  process.env.ANSWER_CARD_RECOGNIZER_EXE = recognizer;
  for (const status of ["error", "ok"] as const) {
    const bridge = path.join(root, `bridge-${status}.cjs`);
    const message = "扫描仪实际输出分辨率与所设置的 300 DPI 不一致";
    const payload = { status, message, page_count: 1, pages: [{ path: image, page: 1, side: "front", width: 24, height: 24, dpi_x: 300, dpi_y: 300 }] };
    await writeFile(bridge, `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(payload))});process.exitCode=${status === "error" ? 1 : 0};\n`, { mode: 0o755 });
    process.env.SCANNER_BRIDGE_EXE = bridge;
    const config = { cardId: info.cardId, sessionName: `partial-${status}`, sourceName: "fixture", dpi: 300, duplex: false,
      colorMode: "color", paperSize: "A4", maxPages: 2, pageTimeoutMs: 2000 };
    const sid = await createScanSession(config);
    const events: Array<{ type: string; message?: string }> = [];
    const run = runScanSession(sid, config, event => events.push(event));
    if (status === "error") await assert.rejects(run, error => error instanceof Error && error.message === message);
    else await run;
    const session = await getSession(sid);
    const records = await listScanRecords(sid);
    assert.equal(records.length, 1, "The valid page survives a later transfer failure");
    assert.equal(records[0].image_path, image);
    assert.equal(session?.status, status === "error" ? "error" : "completed");
    assert.equal(events.filter(e => e.type === "done").length, status === "error" ? 0 : 1);
    assert.equal(events.filter(e => e.type === "error").length, status === "error" ? 1 : 0);
    if (status === "error") assert.equal(events.at(-1)?.message, message);
    assert(events.some(e => e.type === "ocr_page_done"), "Retained pages remain available for recognition and correction");
    assert.equal(liveBridgeCount(), 0);
    const request = (suffix: string, method = "GET") => fetch(`${api}/session/${sid}/${suffix}`, {
      method, headers: { "X-Api-Key": info.key, "Content-Type": "application/json" },
      ...(method === "POST" ? { body: JSON.stringify({ groupId: "0" }) } : {}),
    });
    const summary = await request("results?previewOnly=1");
    assert.equal(summary.status, 200, await summary.text());
    if (status === "error") {
      const replay = await fetch(`${api}/progress/${sid}`, { headers: { "X-Api-Key": info.key } });
      assert.equal(replay.status, 200);
      const replayEvents = (await replay.text()).split("\n").filter(line => line.startsWith("data: "))
        .map(line => JSON.parse(line.slice(6)));
      assert.deepEqual(replayEvents.map(event => event.type), ["error"], "Late subscribers receive only the terminal error");
      assert.equal(replayEvents[0].message, message);
      const snapshot = await fetch(`${api}/scan/${sid}`, { headers: { "X-Api-Key": info.key } });
      assert.equal(snapshot.status, 200);
      const hydrated = await snapshot.json();
      assert.equal(hydrated.session.error_msg, message);
      assert.deepEqual(hydrated.records.map((record: { id: string }) => record.id), records.map(record => record.id), "Terminal replay recovery can hydrate persisted pages through the status API");
      const retry = await request("retry", "POST");
      assert.equal(retry.status, 200, await retry.text());
      assert.equal((await getSession(sid))?.status, "error", "Retry retains the original device error state");
      const { getMysqlDb } = await import("../src/server/db");
      await getMysqlDb().run("UPDATE twain_scan_records SET ocr_status='pending' WHERE session_id=?", sid);
      assert.equal((await request("results?previewOnly=1")).status, 409, "Unfinished OCR cannot be summarized even after a scan error");
    }
  }
  console.log("PASS scanner partial failure: pages retained, error persisted and emitted, no false completion; normal batch still completes");
} finally {
  if (originalBridge === undefined) delete process.env.SCANNER_BRIDGE_EXE;
  else process.env.SCANNER_BRIDGE_EXE = originalBridge;
  if (originalRecognizer === undefined) delete process.env.ANSWER_CARD_RECOGNIZER_EXE;
  else process.env.ANSWER_CARD_RECOGNIZER_EXE = originalRecognizer;
  await closeHttp?.();
  await fixture.close();
  process.chdir(cwd);
  await rm(root, { recursive: true, force: true });
}
