/**
 * CVE-2026-111497 的主进程副本。规则与 src/shared/nodeRuntimeSecurity.ts 保持一致，
 * 由 scripts/verify-node-runtime-cve.ts 对照。扫描端主进程是 CJS，不能直接加载那份 TypeScript。
 */

"use strict";

const zlib = require("node:zlib");
const { Transform } = require("node:stream");

const CVE_2026_111497 = "CVE-2026-111497";
const NODE_RUNTIME_REFUSAL_EXIT_CODE = 78;
const NODE_RUNTIME_CVE_SHELL_CHECK =
  'const version=process.env.PROJECTX_NODE_VERSION_UNDER_TEST||process.versions.node;const m=/^v?(\\d+)\\.(\\d+)\\.(\\d+)(.*)$/.exec(String(version).trim());if(!m)process.exit(1);const M=+m[1],n=+m[2],p=+m[3];const bad=m[4]!==""||M<22||M===23||M===25||(M===22&&(n<23||(n===23&&p<4)))||(M===24&&(n<22||(n===22&&p<1)))||(M===26&&(n<12||(n===12&&p<1)));if(bad)process.exit(1);';

const ENFORCED = Symbol.for("projectx.cve-2026-111497");
const GUARD_INSTALLED = Symbol.for("projectx.cve-2026-111497-brotli-guard");
const TRACKED = Symbol.for("projectx.cve-2026-111497-tracked");

function parseNodeVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(.*)$/.exec(String(version).trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] !== "",
  };
}

function olderThan(version, floor) {
  if (version.major !== floor[0]) return version.major < floor[0];
  if (version.minor !== floor[1]) return version.minor < floor[1];
  return version.patch < floor[2];
}

function isNodeRuntimeVulnerableToCve2026111497(version) {
  const parsed = parseNodeVersion(version);
  if (!parsed || parsed.prerelease) return true;
  const major = parsed.major;
  if (major < 22 || major === 23 || major === 25) return true;
  if (major === 22) return olderThan(parsed, [22, 23, 4]);
  if (major === 24) return olderThan(parsed, [24, 22, 1]);
  if (major === 26) return olderThan(parsed, [26, 12, 1]);
  return false;
}

function nodeRuntimeCveMessage(version, action) {
  const floors = "22.23.4、24.22.1 或 26.12.1";
  if (action === "guard") {
    return `Electron 内嵌的 Node.js ${version} 仍受 ${CVE_2026_111497} 影响（Brotli 解码越界写）。已核对的 Electron 39.8.10 带的是未修复的 Node 与 Chromium 142.0.7444.265。扫描端已关闭 Node 的 Brotli 解码。壳直接加载远端页面时，窗口在加载前只接受 gzip 与 deflate；本地壳访问非本机地址时，会在该请求发出前装上同样的限制。上游发布同时包含已修复 Node.js（${floors} 及以上）和已修复 Chromium 的版本后请升级扫描端。`;
  }
  return `Node.js ${version} 受 ${CVE_2026_111497} 影响（Brotli 解码越界写，畸形压缩数据可导致崩溃、内存泄露或远程代码执行）。请安装 Node.js ${floors} 及以上后再启动。20.x、23.x、25.x 已停止维护，没有补丁。进程将以退出码 ${NODE_RUNTIME_REFUSAL_EXIT_CODE} 结束。`;
}

function disabledError(api) {
  const error = new Error(`${CVE_2026_111497}: Brotli decode is disabled (${api})`);
  error.code = "ERR_BROTLI_DISABLED";
  return error;
}

function replaceZlibMethod(target, key, value) {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (descriptor?.configurable) {
    Object.defineProperty(target, key, { ...descriptor, value, writable: true });
    return;
  }
  target[key] = value;
}

function createDisabledBrotliDecompress() {
  const error = disabledError("createBrotliDecompress");
  // undici 在读响应头时同步调用这里。Node 22.22.1（Electron 39.8.10）里同步抛错
  // 会变成没有监听器的 error 事件，进程直接退出；在 _transform 里同步 callback(error)
  // 又会赶在 fetch 的读取器接上之前，res.text() 一直挂着。
  // 字节停在这个普通 Transform 里，等调用方接上 error 监听之后再销毁。
  const stream = new Transform({
    transform() {},
  });
  stream.on("error", () => {});
  setImmediate(() => {
    if (!stream.destroyed) stream.destroy(error);
  });
  return stream;
}

function installBrotliDecodeGuard() {
  const proto = zlib.BrotliDecompress.prototype;
  if (proto[GUARD_INSTALLED]) return;
  proto[GUARD_INSTALLED] = true;
  // createBrotliDecompress 在 22.23.4 上是 configurable 但不可写，直接赋值会抛 TypeError。
  replaceZlibMethod(zlib, "createBrotliDecompress", createDisabledBrotliDecompress);
  replaceZlibMethod(zlib, "brotliDecompress", () => {
    throw disabledError("brotliDecompress");
  });
  replaceZlibMethod(zlib, "brotliDecompressSync", () => {
    throw disabledError("brotliDecompressSync");
  });
  // end(chunk) 不走实例 write，只换 write 仍会解码。构造器和 _transform 都要停。
  proto._transform = function guardedTransform(_chunk, _encoding, callback) {
    callback(disabledError("_transform"));
  };
  proto._processChunk = function guardedProcessChunk(_chunk, _flushFlag, callback) {
    const error = disabledError("_processChunk");
    if (typeof callback === "function") {
      callback(error);
      return undefined;
    }
    throw error;
  };
  function DisabledBrotliDecompress() {
    throw disabledError("BrotliDecompress");
  }
  DisabledBrotliDecompress.prototype = proto;
  replaceZlibMethod(zlib, "BrotliDecompress", DisabledBrotliDecompress);
}

function enforceNodeRuntimeCve2026111497(options) {
  const productionCall = options === undefined;
  if (productionCall && globalThis[ENFORCED]) return globalThis[ENFORCED];

  const version = options?.version ?? process.versions.node;
  const electron = options?.electron ?? typeof process.versions.electron === "string";
  let decision;
  if (!isNodeRuntimeVulnerableToCve2026111497(version)) {
    decision = { action: "allow", version, message: "" };
  } else if (electron) {
    installBrotliDecodeGuard();
    decision = { action: "guard", version, message: nodeRuntimeCveMessage(version, "guard") };
    console.error(`[${CVE_2026_111497}] ${decision.message}`);
  } else {
    decision = { action: "refuse", version, message: nodeRuntimeCveMessage(version, "refuse") };
    console.error(`[${CVE_2026_111497}] ${decision.message}`);
    if (options?.exitProcess !== false) process.exit(NODE_RUNTIME_REFUSAL_EXIT_CODE);
  }
  if (productionCall) globalThis[ENFORCED] = decision;
  return decision;
}

// Chromium 142 已去掉 brotli-encoding 这个 feature，--disable-features 关不掉解码。
// URLRequestHttpJob 只在 accepted_stream_types 含 kBrotli 时才走成功的 Brotli 解码。
// 在 Electron 39.8.10 上，列表里没有 br 时，合法 br 也不会解出原文，而是
// ERR_CONTENT_DECODING_FAILED。这组值交给 DevTools 的 Network.setAcceptedEncodings
// （必须先 Network.enable，且渲染进程已经出现，否则这条命令会一直挂起）。
const CHROMIUM_ACCEPTED_ENCODINGS = Object.freeze(["gzip", "deflate"]);

function headerValues(headers, name) {
  if (!headers || typeof headers !== "object") return [];
  const key = Object.keys(headers).find((item) => item.toLowerCase() === name);
  if (!key) return [];
  const value = headers[key];
  const parts = Array.isArray(value) ? value : [value];
  return parts.flatMap((item) => String(item).split(",")).map((item) => item.trim()).filter(Boolean);
}

function contentCodingToken(value) {
  return String(value || "").split(";")[0].trim().toLowerCase();
}

function responseUsesBrotli(headers) {
  return headerValues(headers, "content-encoding").some((item) => contentCodingToken(item) === "br");
}

function acceptEncodingWithoutBrotli(value) {
  const kept = String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => {
      const token = contentCodingToken(item);
      return token && token !== "br";
    });
  return kept.length > 0 ? kept.join(", ") : "gzip, deflate";
}

// webRequest 看得到响应头时，网络进程里的 Brotli 解码器可能已经跑过。
// 取消 br 响应只是第二层；真正让 CreateBrotliSourceStream 不执行的是下面的 CDP 覆盖。
const CHROMIUM_REQUEST_FILTER = { urls: ["<all_urls>"] };
const headerBlockedSessions = new WeakSet();
const decodeListenersInstalled = new WeakSet();
const decodeConfiguredSessions = new WeakMap();
const decodeReattachPending = new WeakSet();
const decodeInstallPromises = new WeakMap();
const decodeReady = new WeakSet();
const decodeSuspended = new WeakSet();
const suspendedContentIds = new Set();
const navigationHolds = new WeakSet();
const protectionRestoredHandlers = new WeakMap();
const networkPauseSessions = new WeakSet();
const contentsById = new Map();
const heldRemoteRequests = new Map();
const remoteGateBlocked = new Set();
let remoteGateHandler = null;
const REMOTE_GATE_TIMEOUT_MS = 5000;

function writeRuntimeLog(log, level, message) {
  if (typeof log === "function") log(level, message);
}

function chromiumBrotliBlockError(cause) {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(`${CVE_2026_111497}：无法关闭 Chromium 的 Brotli 解码（${detail}）。扫描端不会继续加载页面。`);
}

function sendDebuggerCommand(dbg, method, params, sessionId) {
  if (sessionId) return dbg.sendCommand(method, params, sessionId);
  return dbg.sendCommand(method, params);
}

function rememberDecodeSession(webContents, sessionId) {
  let known = decodeConfiguredSessions.get(webContents);
  if (!known) {
    known = new Set();
    decodeConfiguredSessions.set(webContents, known);
  }
  if (known.has(sessionId)) return false;
  known.add(sessionId);
  return true;
}

function forgetDecodeSession(webContents, sessionId) {
  const known = decodeConfiguredSessions.get(webContents);
  if (known) known.delete(sessionId);
}

async function applyChromiumAcceptedEncodings(dbg, sessionId) {
  await sendDebuggerCommand(dbg, "Network.enable", {}, sessionId);
  await sendDebuggerCommand(dbg, "Network.setAcceptedEncodings", {
    encodings: CHROMIUM_ACCEPTED_ENCODINGS.slice(),
  }, sessionId);
  await sendDebuggerCommand(dbg, "Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
  }, sessionId);
}

async function configureChildTarget(webContents, dbg, childSessionId, log) {
  if (!rememberDecodeSession(webContents, childSessionId)) return;
  try {
    await applyChromiumAcceptedEncodings(dbg, childSessionId);
    await sendDebuggerCommand(dbg, "Runtime.runIfWaitingForDebugger", {}, childSessionId);
  } catch (error) {
    forgetDecodeSession(webContents, childSessionId);
    const detail = error instanceof Error ? error.message : String(error);
    writeRuntimeLog(log, "ERROR", `[Electron] 子目标 Brotli 解码拦截失败，保持暂停 session=${childSessionId} error=${detail}`);
  }
}

function installChromiumBrotliHeaderBlock(targetSession, log) {
  if (!targetSession || !targetSession.webRequest) {
    throw new Error(`${CVE_2026_111497}：没有可用的会话，无法拦截 Chromium 的 Brotli 响应。扫描端不会继续加载页面。`);
  }
  if (headerBlockedSessions.has(targetSession)) return;
  const finish = (callback, value) => {
    try {
      callback(value);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      writeRuntimeLog(log, "ERROR", `[Electron] Brotli 响应头回调失败: ${detail}`);
    }
  };
  targetSession.webRequest.onBeforeSendHeaders(CHROMIUM_REQUEST_FILTER, (details, callback) => {
    try {
      if (!details.requestHeaders) {
        finish(callback, {});
        return;
      }
      const requestHeaders = { ...details.requestHeaders };
      const key = Object.keys(requestHeaders).find((item) => item.toLowerCase() === "accept-encoding");
      if (key) requestHeaders[key] = acceptEncodingWithoutBrotli(requestHeaders[key]);
      finish(callback, { requestHeaders });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      writeRuntimeLog(log, "ERROR", `[Electron] 去掉 Accept-Encoding 里的 br 失败，已取消请求: ${detail}`);
      finish(callback, { cancel: true });
    }
  });
  targetSession.webRequest.onHeadersReceived(CHROMIUM_REQUEST_FILTER, (details, callback) => {
    try {
      if (responseUsesBrotli(details.responseHeaders)) {
        writeRuntimeLog(log, "WARN", `[Electron] 已拒绝 Brotli 响应 url=${details.url}`);
        finish(callback, { cancel: true });
        return;
      }
      finish(callback, {});
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      writeRuntimeLog(log, "ERROR", `[Electron] 检查 Content-Encoding 失败，已取消请求: ${detail}`);
      finish(callback, { cancel: true });
    }
  });
  headerBlockedSessions.add(targetSession);
}

function chromiumBrotliProtectionEnabled() {
  return String(process.env.PROJECTX_SERVER_MODE || "").toLowerCase() === "remote";
}

function chromiumBrotliFailureScope(webContents, mainWebContents) {
  if (webContents && mainWebContents && webContents === mainWebContents && chromiumBrotliProtectionEnabled()) {
    return "process";
  }
  return "window";
}

function isLoopbackHostname(hostname) {
  let host = String(hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  if (host.startsWith("::ffff:")) return isLoopbackHostname(host.slice("::ffff:".length));
  const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (!match) return false;
  const parts = match.slice(1).map((item) => Number(item));
  return parts.every((item) => item <= 255) && parts[0] === 127;
}

function isLoopbackRequestUrl(url) {
  if (!url) return false;
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return true;
  return isLoopbackHostname(parsed.hostname);
}

function configureChromiumBrotliRemoteGate(options) {
  remoteGateHandler = options || null;
}

function trackChromiumWebContents(webContents) {
  if (!webContents || typeof webContents.id !== "number") return;
  contentsById.set(webContents.id, webContents);
  if (webContents[TRACKED]) return;
  webContents[TRACKED] = true;
  if (typeof webContents.once === "function") {
    webContents.once("destroyed", () => {
      contentsById.delete(webContents.id);
      remoteGateBlocked.delete(webContents.id);
      flushHeldRemoteRequests(webContents.id, true);
    });
  }
}

function flushHeldRemoteRequests(id, cancel) {
  const entry = heldRemoteRequests.get(id);
  if (!entry) return;
  heldRemoteRequests.delete(id);
  clearTimeout(entry.timer);
  for (const callback of entry.callbacks) {
    try {
      callback(cancel ? { cancel: true } : {});
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      writeRuntimeLog(remoteGateHandler?.log, "ERROR", `[Electron] 放行远端请求的回调失败: ${detail}`);
    }
  }
}

function holdRemoteRequest(webContents, callback, log) {
  const id = webContents.id;
  let entry = heldRemoteRequests.get(id);
  if (!entry) {
    entry = { callbacks: [], timer: null };
    heldRemoteRequests.set(id, entry);
    entry.timer = setTimeout(() => {
      if (heldRemoteRequests.get(id) !== entry) return;
      remoteGateBlocked.add(id);
      flushHeldRemoteRequests(id, true);
      const error = chromiumBrotliBlockError("等待编码限制超时");
      writeRuntimeLog(log, "ERROR", `[Electron] ${error.message}`);
      if (typeof remoteGateHandler?.onWindowFatal === "function") remoteGateHandler.onWindowFatal(webContents, error);
    }, REMOTE_GATE_TIMEOUT_MS);
    const options = {
      log,
      onFatal(error) {
        remoteGateBlocked.add(id);
        flushHeldRemoteRequests(id, true);
        if (typeof remoteGateHandler?.onWindowFatal === "function") remoteGateHandler.onWindowFatal(webContents, error);
      },
    };
    Promise.resolve(installChromiumBrotliDecodeBlock(webContents, log, options)).then(() => {
      if (heldRemoteRequests.get(id) !== entry) return;
      if (decodeReady.has(webContents) && !decodeSuspended.has(webContents)) flushHeldRemoteRequests(id, false);
      else flushHeldRemoteRequests(id, true);
    }).catch((error) => {
      if (heldRemoteRequests.get(id) !== entry) return;
      remoteGateBlocked.add(id);
      flushHeldRemoteRequests(id, true);
      const detail = error instanceof Error ? error.message : String(error);
      writeRuntimeLog(log, "ERROR", `[Electron] 远端请求发出前没能关掉 Brotli 解码: ${detail}`);
      if (typeof remoteGateHandler?.onWindowFatal === "function") remoteGateHandler.onWindowFatal(webContents, error);
    });
  }
  entry.callbacks.push(callback);
}

function isChromiumBrotliDecodeReady(webContents) {
  return decodeReady.has(webContents);
}

function rememberProtectionRestored(webContents, handler) {
  let handlers = protectionRestoredHandlers.get(webContents);
  if (!handlers) {
    handlers = new Set();
    protectionRestoredHandlers.set(webContents, handlers);
  }
  handlers.add(handler);
}

function notifyProtectionRestored(webContents) {
  const handlers = protectionRestoredHandlers.get(webContents);
  if (!handlers) return;
  for (const handler of handlers) handler();
}

// Network 代理断开时，Chromium 会清掉 setAcceptedEncodings。必须先停网，再重连。
function suspendChromiumBrotliContents(webContents) {
  decodeReady.delete(webContents);
  decodeSuspended.add(webContents);
  decodeConfiguredSessions.delete(webContents);
  if (typeof webContents?.id === "number") {
    suspendedContentIds.add(webContents.id);
    flushHeldRemoteRequests(webContents.id, true);
  }
  try {
    if (typeof webContents.stop === "function") webContents.stop();
  } catch {
    /* 窗口可能已经销毁 */
  }
}

function releaseChromiumBrotliSuspension(webContents) {
  decodeSuspended.delete(webContents);
  if (typeof webContents?.id === "number") suspendedContentIds.delete(webContents.id);
}

// onBeforeRequest 在请求发出前取消，不会把 br 交给解码器。响应头那一层来不及。
function installChromiumBrotliNetworkPause(targetSession, log) {
  if (!targetSession || !targetSession.webRequest || typeof targetSession.webRequest.onBeforeRequest !== "function") {
    throw new Error(`${CVE_2026_111497}：没有可用的会话，无法在调试通道断开时暂停网络请求。扫描端不会继续加载页面。`);
  }
  if (networkPauseSessions.has(targetSession)) return;
  networkPauseSessions.add(targetSession);
  const finish = (callback, value) => {
    try {
      callback(value);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      writeRuntimeLog(log, "ERROR", `[Electron] 暂停请求的回调失败: ${detail}`);
    }
  };
  targetSession.webRequest.onBeforeRequest(CHROMIUM_REQUEST_FILTER, (details, callback) => {
    try {
      const id = typeof details?.webContentsId === "number" ? details.webContentsId : null;
      if (id !== null && suspendedContentIds.has(id)) {
        writeRuntimeLog(log, "WARN", `[Electron] 调试通道断开，已暂停请求 url=${details.url}`);
        finish(callback, { cancel: true });
        return;
      }
      // 本地壳加载的是 127.0.0.1，页面自己的 fetch 才会碰到远端。这类请求要等编码限制装上再发出。
      if (isLoopbackRequestUrl(details?.url)) {
        finish(callback, {});
        return;
      }
      const contents = id === null ? null : contentsById.get(id);
      if (!contents || remoteGateBlocked.has(id) || (typeof contents.getType === "function" && contents.getType() === "devtools")) {
        writeRuntimeLog(log, "WARN", `[Electron] 远端请求还没有 Brotli 解码限制，已取消 url=${details?.url}`);
        finish(callback, { cancel: true });
        return;
      }
      if (decodeReady.has(contents) && !decodeSuspended.has(contents)) {
        finish(callback, {});
        return;
      }
      holdRemoteRequest(contents, (value) => finish(callback, value), log);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      writeRuntimeLog(log, "ERROR", `[Electron] 暂停请求失败，已取消 url=${details?.url} error=${detail}`);
      finish(callback, { cancel: true });
    }
  });
}

function scheduleChromiumBrotliReattach(webContents, dbg, log, options, state, reason) {
  if (typeof webContents.isDestroyed === "function" && webContents.isDestroyed()) return;
  // 先停掉当前加载并清掉「已保护」标记，再等待重连。这段时间里页面不能继续发请求。
  const alreadyPending = decodeReattachPending.has(webContents);
  suspendChromiumBrotliContents(webContents);
  if (alreadyPending) return;
  const maxAttempts = options?.maxReattachAttempts ?? 3;
  const delayMs = options?.reattachDelayMs ?? 200;
  state.failures += 1;
  if (state.failures > maxAttempts) {
    const error = chromiumBrotliBlockError(reason || "调试通道反复断开");
    writeRuntimeLog(log, "ERROR", `[Electron] 重新关闭 Chromium Brotli 解码失败: ${error.message}`);
    if (typeof options?.onFatal === "function") options.onFatal(error);
    return;
  }
  decodeReattachPending.add(webContents);
  writeRuntimeLog(log, "ERROR", `[Electron] Brotli 解码拦截通道断开 reason=${reason}，第 ${state.failures} 次重新装上`);
  setTimeout(() => {
    decodeReattachPending.delete(webContents);
    if (typeof webContents.isDestroyed === "function" && webContents.isDestroyed()) return;
    try {
      if (typeof webContents.isDevToolsOpened === "function" && webContents.isDevToolsOpened()) {
        webContents.closeDevTools();
      }
    } catch {
      /* 关不上开发者工具时，下面的重新挂载会失败并继续重试 */
    }
    // 父通道断开后，子目标的 session 一并失效。清掉记录，重连成功后再给新子目标装编码。
    decodeConfiguredSessions.delete(webContents);
    decodeInstallPromises.delete(webContents);
    Promise.resolve(installChromiumBrotliDecodeBlock(webContents, log, options)).then(() => {
      state.failures = 0;
    }).catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      scheduleChromiumBrotliReattach(webContents, dbg, log, options, state, detail);
    });
  }, delayMs * state.failures);
}

function installChromiumBrotliDecodeBlock(webContents, log, options) {
  const existing = decodeInstallPromises.get(webContents);
  if (existing) return existing;
  // 先占位再开始导航。loadURL 可能同步触发 will-navigate，那时再进来必须看到同一次安装。
  let resolvePending = () => {};
  let rejectPending = () => {};
  const pending = new Promise((resolve, reject) => {
    resolvePending = resolve;
    rejectPending = reject;
  });
  decodeInstallPromises.set(webContents, pending);
  installChromiumBrotliDecodeBlockOnce(webContents, log, options).then(resolvePending, (error) => {
    if (decodeInstallPromises.get(webContents) === pending) decodeInstallPromises.delete(webContents);
    rejectPending(error);
  });
  return pending;
}

async function installChromiumBrotliDecodeBlockOnce(webContents, log, options) {
  if (!webContents || typeof webContents.isDestroyed !== "function" || webContents.isDestroyed()) {
    throw chromiumBrotliBlockError("窗口已经关闭");
  }
  const dbg = webContents.debugger;
  if (!dbg) throw chromiumBrotliBlockError("窗口没有调试通道");
  // Network.enable 在渲染进程出现之前会一直挂起。about:blank 不走网络，也不会触发 Brotli。
  // 已经打开过页面时不能再导航到 about:blank，否则重连调试通道会把老师正在看的页面冲掉。
  if (typeof webContents.getURL === "function" && !webContents.getURL() && typeof webContents.loadURL === "function") {
    await webContents.loadURL("about:blank");
  }
  if (!decodeListenersInstalled.has(webContents)) {
    dbg.on("message", (_event, method, params, sessionId) => {
      if (method !== "Target.attachedToTarget") return;
      const childSessionId = params && typeof params.sessionId === "string" && params.sessionId
        ? params.sessionId
        : sessionId;
      if (!childSessionId) {
        writeRuntimeLog(log, "ERROR", "[Electron] 子目标没有 sessionId，保持暂停，不恢复执行");
        return;
      }
      void configureChildTarget(webContents, dbg, childSessionId, log);
    });
    const reattachState = { failures: 0 };
    dbg.on("detach", (_event, reason) => {
      scheduleChromiumBrotliReattach(webContents, dbg, log, options, reattachState, reason);
    });
    decodeListenersInstalled.add(webContents);
  }
  try {
    if (!dbg.isAttached()) dbg.attach("1.3");
    await applyChromiumAcceptedEncodings(dbg);
    decodeReady.add(webContents);
    if (typeof webContents.id === "number") remoteGateBlocked.delete(webContents.id);
    releaseChromiumBrotliSuspension(webContents);
    writeRuntimeLog(log, "INFO", "[Electron] 已限制 Chromium 只接受 gzip 与 deflate，不再解码 br");
  } catch (error) {
    throw chromiumBrotliBlockError(error);
  }
  try {
    notifyProtectionRestored(webContents);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    writeRuntimeLog(log, "ERROR", `[Electron] 编码限制恢复后继续导航失败: ${detail}`);
  }
}

function holdNavigationUntilBrotliBlock(contents, options) {
  if (navigationHolds.has(contents)) return;
  navigationHolds.add(contents);
  let queuedUrl = null;
  let resuming = false;
  let opening = false;
  const fail = (error) => {
    if (typeof options?.onFatal === "function") options.onFatal(error);
  };
  const isAbout = (url) => !url || String(url).startsWith("about:");
  rememberProtectionRestored(contents, () => {
    resuming = false;
    resume();
  });
  const resume = () => {
    if (typeof contents.isDestroyed === "function" && contents.isDestroyed()) return;
    if (!queuedUrl || resuming) return;
    if (typeof contents.isLoading === "function" && contents.isLoading()) {
      contents.once("did-stop-loading", resume);
      return;
    }
    const next = queuedUrl;
    queuedUrl = null;
    resuming = true;
    contents.loadURL(next).catch(fail);
  };
  const arm = () => {
    if (opening || decodeReady.has(contents)) {
      if (decodeReady.has(contents)) resume();
      return;
    }
    opening = true;
    const run = () => {
      installChromiumBrotliDecodeBlock(contents, options?.log, options).then(resume).catch(fail);
    };
    // stop() 之后马上 loadURL(about:blank) 会和还没停干净的导航打架，先等它停。
    if (typeof contents.isLoading === "function" && contents.isLoading()) {
      contents.once("did-stop-loading", run);
      return;
    }
    run();
  };
  // window.open 先发出 did-start-navigation，will-navigate 才到。
  // 不能在 did-start-navigation 里同步 stop()，Electron 39 会在这里崩溃。
  // 取消交给 will-navigate 的 preventDefault；这里只记住地址，等这一轮结束再装调试通道。
  contents.on("did-start-navigation", (_event, url) => {
    if (decodeSuspended.has(contents)) {
      if (!isAbout(url)) queuedUrl = url;
      return;
    }
    if (decodeReady.has(contents) || resuming || isAbout(url)) return;
    queuedUrl = url;
    setImmediate(arm);
  });
  contents.on("will-navigate", (event, url) => {
    // 通道断开后 decodeReady 已清掉，但上一轮导航可能还留着 resuming。
    // 这里不能放行，否则重连完成前的地址会直接进解码器。
    if (decodeSuspended.has(contents)) {
      if (!isAbout(url)) {
        event.preventDefault();
        queuedUrl = url;
      }
      return;
    }
    if (decodeReady.has(contents) || resuming || isAbout(url)) return;
    event.preventDefault();
    queuedUrl = url;
    arm();
  });
}

function registerChromiumBrotliProtection(electronApp, options) {
  if (!electronApp || typeof electronApp.on !== "function") {
    throw new Error(`${CVE_2026_111497}：没有应用对象，无法给新窗口安装 Brotli 解码拦截。`);
  }
  electronApp.on("web-contents-created", (_event, contents) => {
    trackChromiumWebContents(contents);
    const type = typeof contents.getType === "function" ? contents.getType() : "";
    if (type === "devtools") return;
    holdNavigationUntilBrotliBlock(contents, {
      ...options,
      onFatal(error) {
        if (typeof options?.onWindowFatal === "function") options.onWindowFatal(contents, error);
        else if (typeof options?.onFatal === "function") options.onFatal(error);
      },
    });
  });
}

module.exports = {
  CVE_2026_111497,
  NODE_RUNTIME_REFUSAL_EXIT_CODE,
  NODE_RUNTIME_CVE_SHELL_CHECK,
  CHROMIUM_ACCEPTED_ENCODINGS,
  isNodeRuntimeVulnerableToCve2026111497,
  nodeRuntimeCveMessage,
  installBrotliDecodeGuard,
  enforceNodeRuntimeCve2026111497,
  responseUsesBrotli,
  acceptEncodingWithoutBrotli,
  installChromiumBrotliHeaderBlock,
  installChromiumBrotliNetworkPause,
  installChromiumBrotliDecodeBlock,
  registerChromiumBrotliProtection,
  chromiumBrotliProtectionEnabled,
  chromiumBrotliFailureScope,
  configureChromiumBrotliRemoteGate,
  trackChromiumWebContents,
  isChromiumBrotliDecodeReady,
};
