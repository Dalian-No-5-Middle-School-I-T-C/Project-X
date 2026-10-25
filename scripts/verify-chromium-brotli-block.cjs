/**
 * 在 Electron 里区分「CDP 真的不让 Chromium 解码 br」和「响应头取消碰巧让 fetch 失败」。
 * 不安装 webRequest 头拦截。对照窗口不挂调试通道，应能解出原文；
 * 装上 Network.setAcceptedEncodings 之后，顶层文档、同源新窗口、iframe 和 Worker 都解不出原文。
 *
 * 由 scripts/verify-node-runtime-cve.ts 在本机有 Electron 二进制时拉起。
 */

const { app, BrowserWindow } = require("electron");
const http = require("node:http");
const zlib = require("node:zlib");
const {
  installChromiumBrotliDecodeBlock,
  registerChromiumBrotliProtection,
} = require("../electron/node-runtime-security.cjs");

app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-features", "ServiceWorker");
app.disableHardwareAcceleration();

const decodedDoc = Buffer.from("<!doctype html><title>decoded-br</title>");
const gzipDoc = Buffer.from("<!doctype html><title>gzip-ok</title>");
const childDoc = Buffer.from("<!doctype html><title>decoded-child</title>");
const iframeDoc = Buffer.from("<!doctype html><title>decoded-iframe</title>");
const brText = Buffer.from("hello-br");
const seen = [];
const failures = [];
let gone = null;

function brotli(body) {
  return zlib.brotliCompressSync(body);
}

const server = http.createServer((req, res) => {
  seen.push({ url: req.url, acceptEncoding: String(req.headers["accept-encoding"] || "") });
  if (req.url === "/br-doc") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-encoding": "br" });
    res.end(brotli(decodedDoc));
    return;
  }
  if (req.url === "/gz-doc") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-encoding": "gzip" });
    res.end(zlib.gzipSync(gzipDoc));
    return;
  }
  if (req.url === "/br-child") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-encoding": "br" });
    res.end(brotli(childDoc));
    return;
  }
  if (req.url === "/iframe-br") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-encoding": "br" });
    res.end(brotli(iframeDoc));
    return;
  }
  if (req.url === "/br-text") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "content-encoding": "br" });
    res.end(brotli(brText));
    return;
  }
  if (req.url === "/worker.js") {
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
    res.end("fetch('/br-text').then(async (response) => postMessage({ text: await response.text() })).catch((error) => postMessage({ error: String(error) }));");
    return;
  }
  if (req.url === "/app") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><title>app</title><body>
<iframe id="frame" src="/iframe-br"></iframe>
<script>
window.__probe = { iframe: "", worker: null, serviceWorker: "" };
const frame = document.getElementById("frame");
frame.addEventListener("load", () => {
  try { window.__probe.iframe = frame.contentDocument ? frame.contentDocument.title : ""; }
  catch (error) { window.__probe.iframe = "inaccessible"; }
});
const worker = new Worker("/worker.js");
const timer = setTimeout(() => { window.__probe.worker = { timeout: true }; }, 4000);
worker.onmessage = (event) => { clearTimeout(timer); window.__probe.worker = event.data; };
worker.onerror = () => { clearTimeout(timer); window.__probe.worker = { error: "worker-error" }; };
window.open("/br-child", "_blank");
const swTimer = setTimeout(() => {
  if (!window.__probe.serviceWorker) window.__probe.serviceWorker = "blocked";
}, 1500);
(async () => {
  try {
    if (!navigator.serviceWorker) window.__probe.serviceWorker = "missing";
    else {
      await navigator.serviceWorker.register("/sw.js");
      window.__probe.serviceWorker = "registered";
    }
  } catch (error) {
    window.__probe.serviceWorker = "blocked";
  }
  clearTimeout(swTimer);
})();
</script></body>`);
    return;
  }
  res.writeHead(404);
  res.end("missing");
});

const timeout = setTimeout(() => {
  console.error("chromium brotli probe timed out");
  app.exit(2);
}, 35000);

function report(payload) {
  console.log(`CHROMIUM_BROTLI_BLOCK ${JSON.stringify(payload)}`);
}

function requestsFor(url, start, end) {
  return seen.slice(start, end).filter((entry) => entry.url === url);
}

function hasToken(entries, token) {
  return entries.some((entry) => entry.acceptEncoding.split(",").some((part) => part.trim().toLowerCase() === token));
}

app.on("web-contents-created", (_event, contents) => {
  contents.on("render-process-gone", (_goneEvent, details) => {
    gone = { reason: details.reason, exitCode: details.exitCode };
  });
  contents.on("did-fail-load", (_failEvent, code, desc, url) => {
    failures.push({ id: contents.id, code, desc, url });
  });
});

app.whenReady().then(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const windowOptions = {
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  };

  const control = new BrowserWindow(windowOptions);
  await control.loadURL(`${origin}/br-doc`);
  const controlTitle = await control.webContents.executeJavaScript("document.title");
  // 不能 destroy 这扇对照窗口：Linux 上关掉最后一扇窗会让 Electron 退出，下一扇窗的 about:blank 会 ERR_FAILED。
  // 对照请求也打到 /br-doc。后面的断言只看这次快照之后的请求，避免对照窗口的 br 把受保护请求判成仍在声明 br。
  const protectedFrom = seen.length;

  registerChromiumBrotliProtection(app, { log() {}, onFatal(error) { throw error; } });
  const win = new BrowserWindow(windowOptions);
  win.webContents.setWindowOpenHandler(() => ({ action: "allow" }));
  await installChromiumBrotliDecodeBlock(win.webContents, () => {});

  let documentError = "";
  try {
    await win.loadURL(`${origin}/br-doc`);
  } catch (error) {
    documentError = error instanceof Error ? error.message : String(error);
  }
  const documentTitle = await win.webContents.executeJavaScript("document.title").catch(() => "");
  await win.loadURL(`${origin}/gz-doc`);
  const gzipTitle = await win.webContents.executeJavaScript("document.title");
  await win.loadURL(`${origin}/app`);
  const pageProbe = await win.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const timer = setInterval(() => {
        const probe = window.__probe;
        if (probe && probe.worker && probe.serviceWorker) {
          clearInterval(timer);
          resolve(probe);
        }
      }, 50);
      setTimeout(() => resolve(window.__probe || { timeout: true }), 7000);
    })
  `);
  const waitUntil = Date.now() + 5000;
  let childFailure;
  let iframeFailure;
  while (Date.now() < waitUntil) {
    childFailure = failures.find((entry) => String(entry.url || "").includes("/br-child"));
    iframeFailure = failures.find((entry) => String(entry.url || "").includes("/iframe-br"));
    if (childFailure && iframeFailure) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const documentRequests = requestsFor("/br-doc", protectedFrom);
  const childRequests = requestsFor("/br-child", protectedFrom);
  const iframeRequests = requestsFor("/iframe-br", protectedFrom);
  const workerRequests = requestsFor("/br-text", protectedFrom);

  report({
    control: {
      title: controlTitle,
      acceptEncodingHasBr: hasToken(requestsFor("/br-doc", 0, protectedFrom), "br"),
    },
    document: {
      error: documentError,
      title: documentTitle,
      requests: documentRequests.length,
      acceptEncodingHasBr: hasToken(documentRequests, "br"),
      acceptEncodingHasGzip: hasToken(documentRequests, "gzip"),
      code: failures.find((entry) => entry.id === win.webContents.id && String(entry.url || "").includes("/br-doc"))?.code ?? null,
    },
    gzipTitle,
    child: {
      code: childFailure ? childFailure.code : null,
      desc: childFailure ? childFailure.desc : "",
      requests: childRequests.length,
      acceptEncodingHasBr: hasToken(childRequests, "br"),
    },
    iframe: {
      title: pageProbe && pageProbe.iframe,
      code: iframeFailure ? iframeFailure.code : null,
      requests: iframeRequests.length,
      acceptEncodingHasBr: hasToken(iframeRequests, "br"),
    },
    worker: pageProbe && pageProbe.worker,
    workerRequest: {
      requests: workerRequests.length,
      acceptEncodingHasBr: hasToken(workerRequests, "br"),
    },
    serviceWorker: pageProbe && pageProbe.serviceWorker,
    failures,
    gone,
  });
  server.close();
  clearTimeout(timeout);
  app.exit(0);
}).catch((error) => {
  report({ error: error instanceof Error ? error.stack || error.message : String(error), seen, failures, gone });
  app.exit(1);
});
