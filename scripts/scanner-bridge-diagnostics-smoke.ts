import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock } from "node:test";

if (process.platform === "win32") {
  console.log("Scanner diagnostic child fixture requires POSIX");
} else {
  const dir = await mkdtemp(path.join(tmpdir(), "scanner-diagnostics-"));
  const exe = path.join(dir, "bridge");
  const previousExe = process.env.SCANNER_BRIDGE_EXE;
  process.env.SCANNER_BRIDGE_EXE = exe;
  const { scan, cancelScan, liveBridgeCount } = await import("../src/apps/answer-card/server/scanner/twain-bridge");
  const config = { sourceName: "fixture", dpi: 300, duplex: false, colorMode: "color",
    paperSize: "A4", outputDir: dir, filePrefix: "fixture", maxPages: 1 };
  const logs: string[] = [];
  let onLine: (line: string) => void = () => {};
  const logMock = mock.method(console, "log", (line: unknown) => {
    if (typeof line === "string" && line.startsWith("[scanner-bridge]")) {
      logs.push(line); onLine(line);
    }
  });
  const fixture = async (body: string) => {
    logs.length = 0;
    await writeFile(exe, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  };
  try {
    // The child cannot finish until its first diagnostic has been observed by the parent.
    const release = path.join(dir, "release");
    onLine = (line) => {
      if (line === "[scanner-bridge] live diagnostic") void writeFile(release, "release");
    };
    await fixture(`const fs = require('node:fs');
process.stderr.write('live diagnostic\\r\\n');
const timer = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(release)})) return;
  clearInterval(timer);
  const bytes = Buffer.from('馈纸器就绪\\n尾行');
  process.stderr.write(bytes.subarray(0, 1));
  setTimeout(() => {
    process.stderr.write(bytes.subarray(1));
    process.stdout.write(JSON.stringify({status:'success',page_count:1,pages:[]}));
  }, 20);
}, 10);
setTimeout(() => process.exit(2), 3000).unref();`);
    assert.equal((await scan(config)).page_count, 1);
    assert.deepEqual(logs, ["[scanner-bridge] live diagnostic", "[scanner-bridge] 馈纸器就绪", "[scanner-bridge] 尾行"]);
    onLine = () => {};
    await fixture("process.stderr.write('failure without newline'); process.exitCode = 1;");
    await assert.rejects(scan(config), /failure without newline/);
    assert.deepEqual(logs, ["[scanner-bridge] failure without newline"]);
    await fixture("process.stderr.write('parse diagnostic\\n'); process.stdout.write('invalid json');");
    await assert.rejects(scan(config), SyntaxError);
    assert.deepEqual(logs, ["[scanner-bridge] parse diagnostic"]);

    await fixture("process.stderr.write('cancel diagnostic\\n'); setInterval(() => {}, 1000);");
    onLine = () => { cancelScan("diagnostic-cancel"); };
    await assert.rejects(scan(config, "diagnostic-cancel"));
    assert.deepEqual(logs, ["[scanner-bridge] cancel diagnostic"]);
    assert.equal(liveBridgeCount(), 0);

    // Trigger the production timeout handler after stderr arrives, without waiting ten minutes.
    let timeoutNow: () => void = () => {};
    const originalTimeout = globalThis.setTimeout;
    const timeoutMock = mock.method(globalThis, "setTimeout", (callback: () => void, ms: number) => {
      if (ms === 600_000) {
        timeoutNow = callback;
        return originalTimeout(callback, 5000);
      }
      return originalTimeout(callback, ms);
    });
    try {
      onLine = () => { timeoutNow(); };
      await fixture("process.stderr.write('timeout diagnostic\\n'); setInterval(() => {}, 1000);");
      await assert.rejects(scan(config, "diagnostic-timeout"), /超时/);
      assert.deepEqual(logs, ["[scanner-bridge] timeout diagnostic"]);
      assert.equal(liveBridgeCount(), 0);
    } finally { timeoutMock.mock.restore(); }
  } finally {
    logMock.mock.restore();
    if (previousExe === undefined) delete process.env.SCANNER_BRIDGE_EXE;
    else process.env.SCANNER_BRIDGE_EXE = previousExe;
    await rm(dir, { recursive: true, force: true });
  }
  console.log("PASS bridge diagnostics: live output, UTF-8 chunks, trailing line, failure, parse error, cancellation and timeout");
}
