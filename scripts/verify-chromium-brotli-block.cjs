/**
 * 在 Electron 里确认 Chromium 不再解码 Brotli。
 * 由 scripts/verify-node-runtime-cve.ts 在本机有 Electron 二进制时拉起。
 * 结果打到 stdout 的一行 CHROMIUM_BROTLI_BLOCK JSON，退出码只表示探针自己有没有跑完。
 */

const { app, BrowserWindow } = require("electron");
const http = require("node:http");
const zlib = require("node:zlib");
const {
  installChromiumBrotliDecodeBlock,
  installChromiumBrotliHeaderBlock,
} = require("../electron/node-runtime-security.cjs");

app.commandLine.appendSwitch("disable-gpu");
app.disableHardwareAcceleration();

const gz = zlib.gzipSync(Buffer.from("hello-gzip"));
const br = zlib.brotliCompressSync(Buffer.from("hello-br"));
const seen = [];
let gone = null;

const server = http.createServer((req, res) => {
  seen.push({ url: req.url, acceptEncoding: String(req.headers["accept-encoding"] || "") });
  if (req.url === "/gz") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "content-encoding": "gzip" });
    res.end(gz);
    return;
  }
  if (req.url === "/br") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "content-encoding": "br" });
    res.end(br);
    return;
  }
  if (req.url === "/garbage") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "content-encoding": "br" });
    res.end(Buffer.from("this-is-not-brotli"));
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end("<!doctype html><title>brotli-probe</title>");
});

const timeout = setTimeout(() => {
  console.error("chromium brotli probe timed out");
  app.exit(2);
}, 25000);
timeout.unref?.();

function report(payload) {
  console.log(`CHROMIUM_BROTLI_BLOCK ${JSON.stringify(payload)}`);
}

app.whenReady().then(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    gone = { reason: details.reason, exitCode: details.exitCode };
  });
  installChromiumBrotliHeaderBlock(win.webContents.session, () => {});
  await installChromiumBrotliDecodeBlock(win.webContents, () => {});
  await win.loadURL(`http://127.0.0.1:${port}/`);
  const result = await win.webContents.executeJavaScript(`
    (async () => {
      const gzipText = await (await fetch("/gz")).text();
      let brText = null;
      let brError = null;
      try { brText = await (await fetch("/br")).text(); }
      catch (error) { brError = String(error && error.message || error); }
      let garbageText = null;
      let garbageError = null;
      try { garbageText = await (await fetch("/garbage")).text(); }
      catch (error) { garbageError = String(error && error.message || error); }
      return { gzipText, brText, brError, garbageText, garbageError };
    })()
  `);
  report({ result, seen, gone });
  server.close();
  clearTimeout(timeout);
  app.exit(0);
}).catch((error) => {
  report({ error: error instanceof Error ? error.stack || error.message : String(error), seen, gone });
  app.exit(1);
});
