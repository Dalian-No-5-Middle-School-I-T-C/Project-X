/**
 * 在 Electron 里区分「CDP 真的不让 Chromium 解码 br」和「响应头取消碰巧让 fetch 失败」。
 * 不安装 webRequest 头拦截。对照窗口不挂调试通道，应能解出原文；
 * 装上 Network.setAcceptedEncodings 之后，顶层文档、同源新窗口（含 noopener）、iframe 和 Worker
 * 都解不出原文。
 *
 * 另有一段闸门场景：页面从「非本机」来源加载，闸门未就绪时第一次请求必须被取消，
 * 等编码限制装上后再重试；同一扇页面在没有闸门的窗口里应能解出 br。
 * 这个来源必须是 https：Chromium 只在安全来源上声明 br（http 的非回环地址连 doc 都只发
 * gzip/deflate），http 下测出来的「解不出」是浏览器自己拦的，证明不了闸门。
 * 证书用 openssl 现场自签，CI 与 Git for Windows 都自带；生成不了就让检查失败，不静默跳过。
 *
 * 由 scripts/verify-node-runtime-cve.ts 在本机有 Electron 二进制时拉起。
 */

const { app, BrowserWindow } = require("electron");
const http = require("node:http");
const https = require("node:https");
const zlib = require("node:zlib");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  configureChromiumBrotliRemoteGate,
  clearChromiumServiceWorkers,
  installChromiumBrotliHeaderBlock,
  installChromiumBrotliDecodeBlock,
  installChromiumBrotliNetworkPause,
  isChromiumBrotliDecodeReady,
  registerChromiumBrotliProtection,
  trackChromiumWebContents,
} = require("../electron/node-runtime-security.cjs");

app.commandLine.appendSwitch("disable-gpu");
// 用保留域名造一个「非本机」来源：连接仍落在 127.0.0.1，但 URL 主机名不是回环地址。
// 直接打真实的网卡地址会触发 Private Network Access 预检，测到的就不是 Brotli 这条路径了。
app.commandLine.appendSwitch("host-resolver-rules", "MAP brotli-remote.test 127.0.0.1");
// 测试域名必须直连回环夹具，不能被开发机的系统代理转发到外网。
app.commandLine.appendSwitch("no-proxy-server");
app.commandLine.appendSwitch("ignore-certificate-errors");
app.disableHardwareAcceleration();

const REMOTE_HOST = "brotli-remote.test";
const certDir = fs.mkdtempSync(path.join(os.tmpdir(), "projectx-brotli-probe-"));
const certFile = path.join(certDir, "cert.pem");
const keyFile = path.join(certDir, "key.pem");
const certResult = spawnSync("openssl", [
  "req", "-x509", "-newkey", "rsa:2048", "-nodes",
  "-keyout", keyFile, "-out", certFile, "-days", "2",
  "-subj", "/CN=brotli-remote.test",
  "-addext", "subjectAltName=DNS:brotli-remote.test",
], { stdio: "ignore" });
const remoteTls = certResult.status === 0 && fs.existsSync(certFile) && fs.existsSync(keyFile)
  ? { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) }
  : null;
function cleanupCert() {
  try {
    fs.rmSync(certDir, { recursive: true, force: true });
  } catch {
    /* 临时目录清不掉不影响结论 */
  }
}
app.on("will-quit", cleanupCert);
// app.exit() 不会触发 will-quit，各条退出路径都要自己清。


const decodedDoc = Buffer.from("<!doctype html><title>decoded-br</title>");
const gzipDoc = Buffer.from("<!doctype html><title>gzip-ok</title>");
const childDoc = Buffer.from("<!doctype html><title>decoded-child</title>");
const iframeDoc = Buffer.from("<!doctype html><title>decoded-iframe</title>");
const brText = Buffer.from("hello-br");
const seen = [];
const remoteSeen = [];
const failures = [];
const gateFailures = [];
let gone = null;

function brotli(body) {
  return zlib.brotliCompressSync(body);
}

function record(target, req) {
  target.push({ url: req.url, acceptEncoding: String(req.headers["accept-encoding"] || "") });
}

const server = http.createServer((req, res) => {
  record(seen, req);
  const pathname = String(req.url || "").split("?")[0];
  if (pathname === "/sw.js") {
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=3600" });
    res.end("self.addEventListener('install', event => event.waitUntil(self.skipWaiting())); self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));");
    return;
  }
  if (pathname === "/br-doc") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-encoding": "br" });
    res.end(brotli(decodedDoc));
    return;
  }
  if (pathname === "/gz-doc") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-encoding": "gzip" });
    res.end(zlib.gzipSync(gzipDoc));
    return;
  }
  if (pathname === "/br-child" || pathname === "/br-child-noopener") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-encoding": "br" });
    res.end(brotli(childDoc));
    return;
  }
  if (pathname === "/iframe-br") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-encoding": "br" });
    res.end(brotli(iframeDoc));
    return;
  }
  if (pathname === "/br-text") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "content-encoding": "br" });
    res.end(brotli(brText));
    return;
  }
  if (pathname === "/worker.js") {
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
    res.end("fetch('/br-text').then(async (response) => postMessage({ text: await response.text() })).catch((error) => postMessage({ error: String(error) }));");
    return;
  }
  if (pathname === "/gate") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><title>gate</title><body>
<script>
window.__gate = { text: "", error: "", started: false };
const remote = new URLSearchParams(location.search).get("remote") || "";
window.__gate.started = true;
fetch(remote, { mode: "cors", cache: "no-store" })
  .then(async (response) => { window.__gate.text = await response.text(); })
  .catch((error) => { window.__gate.error = String((error && error.message) || error); });
</script></body>`);
    return;
  }
  if (pathname === "/app") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><title>app</title><body>
<iframe id="frame" src="/iframe-br"></iframe>
<script>
window.__probe = { iframe: "", worker: null };
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
window.open("/br-child-noopener", "_blank", "noopener,noreferrer");
</script></body>`);
    return;
  }
  res.writeHead(404);
  res.end("missing");
});

// 远端 = 主机名不是回环地址的 https 服务（连接经 host-resolver-rules 落回 127.0.0.1）。
// 用 https 是因为 Chromium 只在安全来源上声明 br；http 的非回环来源连文档请求都只发 gzip/deflate。
function remoteHandler(req, res) {
  record(remoteSeen, req);
  const pathname = String(req.url || "").split("?")[0];
  if (pathname === "/gate-br-doc") {
    // 恶意/被攻陷的远端：无视 Accept-Encoding 直接回 br 文档，用来测第一发请求不能进解码器。
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-encoding": "br",
      "cache-control": "no-store",
    });
    res.end(brotli(decodedDoc));
    return;
  }
  if (pathname === "/gate" || pathname === "/gate-gz") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><title>remote-gate</title><body>
<script>
window.__gate = { text: "", error: "" };
const remote = new URLSearchParams(location.search).get("remote") || "";
fetch(remote, { cache: "no-store" })
  .then(async (response) => { window.__gate.text = await response.text(); })
  .catch((error) => { window.__gate.error = String((error && error.message) || error); });
</script></body>`);
    return;
  }
  if (pathname === "/gate-br-text" || pathname === "/gate-gz-text") {
    const compressed = pathname === "/gate-gz-text";
    res.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "content-encoding": compressed ? "gzip" : "br",
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    });
    res.end(compressed ? zlib.gzipSync(Buffer.from("hello-gzip-remote")) : brotli(brText));
    return;
  }
  res.writeHead(404, { "access-control-allow-origin": "*" });
  res.end("missing");
}

const remoteServer = remoteTls ? https.createServer(remoteTls, remoteHandler) : null;

const timeout = setTimeout(() => {
  console.error("chromium brotli probe timed out");
  cleanupCert();
  app.exit(2);
}, 50000);

function report(payload) {
  console.log(`CHROMIUM_BROTLI_BLOCK ${JSON.stringify(payload)}`);
}

function requestsFor(url, start, end) {
  return seen.slice(start, end).filter((entry) => entry.url === url);
}

function remoteRequestsFor(url) {
  return remoteSeen.filter((entry) => entry.url === url);
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

  // 有效脚本必须先注册成功。独立会话且不挂 CDP，覆盖本地壳首次访问远端之前。
  const swWindow = new BrowserWindow({ ...windowOptions, webPreferences: {
    ...windowOptions.webPreferences, partition: "service-worker-probe",
  } });
  await swWindow.loadURL(`${origin}/gz-doc`);
  const serviceWorker = {};
  serviceWorker.controlRegistered = await swWindow.webContents.executeJavaScript(`
    Promise.race([
      navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready).then(() => true),
      new Promise((_, reject) => setTimeout(() => reject(new Error('service worker control timeout')), 5000))
    ])
  `);
  // 预热普通 HTTP 缓存，防止取消只覆盖未缓存的脚本。
  await swWindow.webContents.executeJavaScript("fetch('/sw.js').then(response => response.text())");
  installChromiumBrotliHeaderBlock(swWindow.webContents.session);
  await clearChromiumServiceWorkers(swWindow.webContents.session);
  await swWindow.loadURL(`${origin}/gz-doc`);
  serviceWorker.remainingRegistrations = await swWindow.webContents.executeJavaScript(
    "navigator.serviceWorker.getRegistrations().then(items => items.length)",
  );
  const swRequestsBefore = requestsFor("/sw.js").length;
  serviceWorker.blocked = await swWindow.webContents.executeJavaScript(`
    Promise.race([
      navigator.serviceWorker.register('/sw.js').then(() => false, () => true),
      new Promise((_, reject) => setTimeout(() => reject(new Error('service worker block timeout')), 5000))
    ])
  `);
  serviceWorker.newScriptRequests = requestsFor("/sw.js").length - swRequestsBefore;

  // 闸门场景的对照组：同一扇「非本机」页面（主机名不是回环地址），不挂闸门时同源 br 应能解出原文。
  const gateControl = { text: "", error: "", skipped: "" };
  let remoteOrigin = "";
  let remotePageUrl = "";
  if (!remoteServer) {
    gateControl.skipped = "openssl 不可用，无法自签 https 证书";
  } else {
    await new Promise((resolve) => remoteServer.listen(0, "127.0.0.1", resolve));
    const remotePort = remoteServer.address().port;
    remoteOrigin = `https://${REMOTE_HOST}:${remotePort}`;
    remotePageUrl = `${remoteOrigin}/gate?remote=${encodeURIComponent(`${remoteOrigin}/gate-br-text`)}`;
    const remoteControl = new BrowserWindow(windowOptions);
    try {
      await remoteControl.loadURL(remotePageUrl);
      const controlDeadline = Date.now() + 8000;
      let gateControlResult = null;
      while (Date.now() < controlDeadline) {
        gateControlResult = await remoteControl.webContents.executeJavaScript("window.__gate || null").catch(() => null);
        if (gateControlResult && (gateControlResult.text || gateControlResult.error)) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      gateControl.text = gateControlResult?.text || "";
      gateControl.error = gateControlResult?.error || "";
    } catch (error) {
      gateControl.error = error instanceof Error ? error.message : String(error);
    }
  }
  const gateControlRequests = remoteRequestsFor("/gate-br-text").length;
  const gateControlHasBr = hasToken(remoteRequestsFor("/gate-br-text"), "br");
  // 没有闸门的对照窗口：第一发就带 br，能解出原文。
  // 闸门场景验证同一发请求在未受保护时被取消、装好后重试不再声明 br。
  const gateControlBrCount = gateControlRequests;

  // 闸门窗口必须在 registerChromiumBrotliProtection 之前创建：否则导航拦截会提前把限制装好，
  // 就测不到「未就绪时第一发远端请求被取消」这条路径。
  const gateWindowOptions = {
    show: false,
    webPreferences: { ...windowOptions.webPreferences, partition: "brotli-gate-probe" },
  };
  const gateWin = new BrowserWindow(gateWindowOptions);

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
        if (probe && probe.worker) {
          clearInterval(timer);
          resolve(probe);
        }
      }, 50);
      setTimeout(() => resolve(window.__probe || { timeout: true }), 7000);
    })
  `);

  // 闸门场景：非本机页面 + 独立会话，闸门未就绪时第一发必须取消，装好后再重试。
  const gate = {
    firstAttemptRejected: false,
    firstAttemptError: "",
    firstDocumentRequests: 0,
    gateReady: false,
    retryDocumentError: "",
    retryDocumentRequests: 0,
    retryDocumentAcceptEncodingHasBr: false,
    retryDocumentTitle: "",
    text: "", error: "", gzipText: "", gzipError: "",
  };
  configureChromiumBrotliRemoteGate({
    log() {},
    retryDelayMs: 50,
    onWindowFatal(_contents, error) {
      gateFailures.push(error instanceof Error ? error.message : String(error));
    },
  });
  installChromiumBrotliNetworkPause(gateWin.webContents.session, () => {});
  trackChromiumWebContents(gateWin.webContents);
  // 先在回环页面上落一次 URL，避免首次安装时的 about:blank 预热把正在被取消的导航冲掉。
  await gateWin.loadURL(`${origin}/gz-doc`);
  const gateRemoteStart = remoteSeen.length;
  if (remoteServer) {
    const gateFirstUrl = `${remoteOrigin}/gate-br-doc`;
    // 第一发远端请求：闸门还没装好，onBeforeRequest 必须直接取消；服务端不应看到它。
    try {
      await gateWin.loadURL(gateFirstUrl);
    } catch (error) {
      gate.firstAttemptRejected = true;
      gate.firstAttemptError = error instanceof Error ? error.message : String(error);
    }
    gate.firstDocumentRequests = remoteRequestsFor("/gate-br-doc").length;
    const readyDeadline = Date.now() + 10000;
    while (Date.now() < readyDeadline && !isChromiumBrotliDecodeReady(gateWin.webContents) && gateFailures.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    gate.gateReady = isChromiumBrotliDecodeReady(gateWin.webContents);
    // 装好后重试同一发：请求这次才创建，服务端应看到它不带 br；恶意 br 响应不能解出原文。
    try {
      await gateWin.loadURL(gateFirstUrl);
    } catch (error) {
      gate.retryDocumentError = error instanceof Error ? error.message : String(error);
    }
    gate.retryDocumentTitle = gateWin.webContents.getTitle();
    const retryDocEntries = remoteRequestsFor("/gate-br-doc").slice(gate.firstDocumentRequests);
    gate.retryDocumentRequests = retryDocEntries.length;
    gate.retryDocumentAcceptEncodingHasBr = hasToken(retryDocEntries, "br");
    // 再加载正常闸门页：同源 br fetch 仍应解不出。
    gate.pageError = "";
    try {
      await gateWin.loadURL(remotePageUrl);
      const gateDeadline = Date.now() + 12000;
      let gateResult = null;
      while (Date.now() < gateDeadline) {
        gateResult = await gateWin.webContents.executeJavaScript("window.__gate || null").catch(() => null);
        if (gateResult && (gateResult.text || gateResult.error)) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      gate.text = gateResult?.text || "";
      gate.error = gateResult?.error || "";
    } catch (error) {
      gate.pageError = error instanceof Error ? error.message : String(error);
    }
    gate.requests = remoteSeen.length - gateRemoteStart;
    const gateBrRequests = remoteRequestsFor("/gate-br-text").slice(gateControlBrCount);
    gate.brRequests = gateBrRequests.length;
    gate.brAcceptEncodingHasBr = hasToken(gateBrRequests, "br");
  } else {
    gate.skipped = gateControl.skipped;
    gate.requests = 0;
  }
  // 装上限之后 gzip 仍要能用，否则等于把远端整体关掉。
  if (remoteServer) await gateWin.webContents.executeJavaScript(`
    fetch(${JSON.stringify(`${remoteOrigin}/gate-gz-text`)}, { mode: "cors", cache: "no-store" })
      .then(async (response) => { window.__gateGzip = { text: await response.text(), error: "" }; })
      .catch((error) => { window.__gateGzip = { text: "", error: String((error && error.message) || error) }; })
  `).catch(() => {});
  const gzipDeadline = Date.now() + 5000;
  let gateGzip = null;
  while (Date.now() < gzipDeadline) {
    gateGzip = await gateWin.webContents.executeJavaScript("window.__gateGzip || null").catch(() => null);
    if (gateGzip && (gateGzip.text || gateGzip.error)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  gate.gzipText = gateGzip?.text || "";
  gate.gzipError = gateGzip?.error || "";

  const waitUntil = Date.now() + 5000;
  let childFailure;
  let noopenerChildFailure;
  let iframeFailure;
  while (Date.now() < waitUntil) {
    childFailure = failures.find((entry) => entry.url === `${origin}/br-child`);
    noopenerChildFailure = failures.find((entry) => entry.url === `${origin}/br-child-noopener`);
    iframeFailure = failures.find((entry) => String(entry.url || "").includes("/iframe-br"));
    if (childFailure && noopenerChildFailure && iframeFailure) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const documentRequests = requestsFor("/br-doc", protectedFrom);
  const childRequests = requestsFor("/br-child", protectedFrom);
  const noopenerChildRequests = requestsFor("/br-child-noopener", protectedFrom);
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
    noopenerChild: {
      code: noopenerChildFailure ? noopenerChildFailure.code : null,
      desc: noopenerChildFailure ? noopenerChildFailure.desc : "",
      requests: noopenerChildRequests.length,
      acceptEncodingHasBr: hasToken(noopenerChildRequests, "br"),
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
    serviceWorker,
    remoteSeen,
    gateControl: {
      text: gateControl.text,
      error: gateControl.error,
      requests: gateControlRequests,
      acceptEncodingHasBr: gateControlHasBr,
    },
    gate,
    gateFailures,
    failures,
    gone,
  });
  server.close();
  remoteServer?.close();
  clearTimeout(timeout);
  cleanupCert();
  app.exit(0);
}).catch((error) => {
  report({ error: error instanceof Error ? error.stack || error.message : String(error), seen, remoteSeen, failures, gateFailures, gone });
  cleanupCert();
  app.exit(1);
});
