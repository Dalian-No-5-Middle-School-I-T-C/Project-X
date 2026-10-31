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
    return `Electron 内嵌的 Node.js ${version} 仍受 ${CVE_2026_111497} 影响（Brotli 解码越界写）。扫描端已关闭 Node 的 Brotli 解码。壳直接加载远端页面时，窗口在加载前只接受 gzip 与 deflate；本地壳会在第一次远端请求创建前先装好同样的限制，装好前的远端请求一律取消。上游发布同时包含已修复 Node.js（${floors} 及以上）和已修复 Chromium 的版本后请升级扫描端。`;
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
const decodeReattachStates = new WeakMap();
const serviceWorkerCleanup = new WeakMap();
const decodeInstallPromises = new WeakMap();
const decodeReady = new WeakSet();
const decodeSuspended = new WeakSet();
const navigationHolds = new WeakSet();
const protectionRestoredHandlers = new WeakMap();
const networkPauseSessions = new WeakSet();
const contentsById = new Map();
const trackedContents = new WeakSet();
const remoteGateStarting = new Set();
const remoteGateRetryAt = new Map();
const remoteGateAttempts = new Map();
let remoteGateHandler = null;
let remoteGateRetryBaseMs = 5000;
const REMOTE_GATE_RETRY_MAX_MS = 60000;
const ENCODINGS_COMMAND_TIMEOUT_MS = 10000;

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

// 调试命令可能永久挂起（渲染进程没起来时 Network.enable 就不会返回），装不上要能变成一次可重试的失败。
function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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
  await withTimeout((async () => {
    await sendDebuggerCommand(dbg, "Network.enable", {}, sessionId);
    await sendDebuggerCommand(dbg, "Network.setAcceptedEncodings", {
      encodings: CHROMIUM_ACCEPTED_ENCODINGS.slice(),
    }, sessionId);
    await sendDebuggerCommand(dbg, "Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    }, sessionId);
  })(), ENCODINGS_COMMAND_TIMEOUT_MS, "调试命令没有返回");
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
      // Chromium 的 ServiceWorker feature 开关无效。注册和更新脚本都带这个
      // 浏览器生成的请求头；在发到网络前拒绝，覆盖本地壳尚未挂 CDP 的阶段。
      if (headerValues(details.requestHeaders, "service-worker").some((value) => value.toLowerCase() === "script")) {
        writeRuntimeLog(log, "WARN", `[Electron] 已拒绝 Service Worker 脚本 url=${details.url}`);
        finish(callback, { cancel: true });
        return;
      }
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

function clearChromiumServiceWorkers(targetSession) {
  const existing = serviceWorkerCleanup.get(targetSession);
  if (existing) return existing;
  const pending = Promise.resolve().then(() => targetSession.clearStorageData({ storages: ["serviceworkers"] }));
  serviceWorkerCleanup.set(targetSession, pending);
  pending.catch(() => serviceWorkerCleanup.delete(targetSession));
  return pending;
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

function mappedIpv4(host) {
  if (!host.startsWith("::ffff:")) return "";
  const rest = host.slice("::ffff:".length);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(rest)) return rest;
  const halves = rest.split(":");
  if (halves.length !== 2) return "";
  if (!/^[0-9a-f]{1,4}$/.test(halves[0]) || !/^[0-9a-f]{1,4}$/.test(halves[1])) return "";
  const hi = Number.parseInt(halves[0], 16);
  const lo = Number.parseInt(halves[1], 16);
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return "";
  return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
}

function isLoopbackHostname(hostname) {
  let host = String(hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  const mapped = mappedIpv4(host);
  if (mapped) host = mapped;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
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
  const retryDelayMs = Number(options?.retryDelayMs);
  remoteGateRetryBaseMs = Number.isFinite(retryDelayMs) && retryDelayMs >= 0 ? retryDelayMs : 5000;
}

function trackChromiumWebContents(webContents) {
  if (!webContents || typeof webContents.id !== "number") return;
  contentsById.set(webContents.id, webContents);
  if (trackedContents.has(webContents)) return;
  trackedContents.add(webContents);
  if (typeof webContents.once === "function") {
    webContents.once("destroyed", () => {
      if (contentsById.get(webContents.id) !== webContents) return;
      contentsById.delete(webContents.id);
      clearRemoteGate(webContents.id);
      remoteGateStarting.delete(webContents.id);
    });
  }
}

function clearRemoteGate(id) {
  if (typeof id !== "number") return;
  remoteGateRetryAt.delete(id);
  remoteGateAttempts.delete(id);
}

function remoteGateCoolingDown(id, now = Date.now()) {
  const retryAt = remoteGateRetryAt.get(id);
  return typeof retryAt === "number" && retryAt > now;
}

// 装不上不能变成终态：按指数退避记一个「下次可重试」的时间点，下一次远端请求会再试一次。
function deferRemoteGateRetry(webContents, log, error) {
  const id = webContents?.id;
  if (typeof id !== "number") return;
  const attempts = (remoteGateAttempts.get(id) || 0) + 1;
  remoteGateAttempts.set(id, attempts);
  const delay = Math.min(REMOTE_GATE_RETRY_MAX_MS, remoteGateRetryBaseMs * 2 ** Math.min(attempts - 1, 4));
  remoteGateRetryAt.set(id, Date.now() + delay);
  const detail = error instanceof Error ? error.message : String(error);
  writeRuntimeLog(log, "ERROR", `[Electron] 远端请求的 Brotli 解码限制装不上（第 ${attempts} 次），${Math.max(1, Math.round(delay / 1000))} 秒后再试 error=${detail}`);
}

function blockRemoteGate(webContents, log, error) {
  deferRemoteGateRetry(webContents, log, error);
  if (typeof remoteGateHandler?.onWindowFatal === "function") remoteGateHandler.onWindowFatal(webContents, error);
}

// 懒装兜底必须失败关闭：窗口还没受保护时，这一发远端请求不能放出去。
// 请求的 accepted encodings 在进入 onBeforeRequest 之前就已固定，放行后再补
// Network.setAcceptedEncodings 改不回来；只能取消这一发，装好后再由调用方重试。
function startRemoteGateInstall(webContents, log) {
  const id = webContents?.id;
  if (typeof id !== "number" || remoteGateStarting.has(id)) return;
  remoteGateStarting.add(id);
  const options = {
    log,
    onFatal(error) {
      blockRemoteGate(webContents, log, error);
    },
  };
  Promise.resolve(installChromiumBrotliDecodeBlock(webContents, log, options)).then(() => {
    remoteGateStarting.delete(id);
    if (decodeReady.has(webContents) && !decodeSuspended.has(webContents)) clearRemoteGate(id);
  }).catch((error) => {
    remoteGateStarting.delete(id);
    blockRemoteGate(webContents, log, error);
  });
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
  try {
    if (typeof webContents.stop === "function") webContents.stop();
  } catch {
    /* 窗口可能已经销毁 */
  }
}

function releaseChromiumBrotliSuspension(webContents) {
  decodeSuspended.delete(webContents);
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
      // 本地壳加载的是 127.0.0.1，页面自己的 fetch 才会碰到远端。
      // 还没受保护的窗口不能把远端请求发出去：请求一创建，accepted encodings 就定死了，
      // 补装 Network.setAcceptedEncodings 也改不回来。取消这一发，装好后由调用方重试。
      if (isLoopbackRequestUrl(details?.url)) {
        finish(callback, {});
        return;
      }
      const contents = id === null ? null : contentsById.get(id);
      if (!contents || (typeof contents.getType === "function" && contents.getType() === "devtools")) {
        writeRuntimeLog(log, "WARN", `[Electron] 远端请求没有对应的窗口，已取消 url=${details?.url}`);
        finish(callback, { cancel: true });
        return;
      }
      if (decodeReady.has(contents) && !decodeSuspended.has(contents)) {
        finish(callback, {});
        return;
      }
      // 让正在执行的重连先完成；耗尽后由后续远端请求按退避重新安装。
      // 回环 API 已在上面放行，本机扫描和恢复握手都可以继续使用。
      if (decodeReattachPending.has(contents)) {
        finish(callback, { cancel: true });
        return;
      }
      if (remoteGateCoolingDown(id)) {
        finish(callback, { cancel: true });
        return;
      }
      writeRuntimeLog(log, "WARN", `[Electron] 编码限制尚未装好，已取消这一发远端请求 url=${details?.url}`);
      startRemoteGateInstall(contents, log);
      finish(callback, { cancel: true });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      writeRuntimeLog(log, "ERROR", `[Electron] 暂停请求失败，已取消 url=${details?.url} error=${detail}`);
      finish(callback, { cancel: true });
    }
  });
}

function scheduleChromiumBrotliReattach(webContents, dbg, log, options, state, reason) {
  if (typeof webContents.isDestroyed === "function" && webContents.isDestroyed()) return;
  const detachReason = String(reason || "").toLowerCase();
  if (detachReason === "target closed" || detachReason === "render frame was disposed") {
    // 关窗与渲染进程崩溃都会先发 detach，而 isDestroyed() 此刻仍可能为 false。
    // 这不是保护失效：清掉就绪标记，后续页面重载会走本机 Brotli 握手重新安装。
    decodeReady.delete(webContents);
    decodeReattachPending.delete(webContents);
    decodeConfiguredSessions.delete(webContents);
    decodeInstallPromises.delete(webContents);
    return;
  }
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
    deferRemoteGateRetry(webContents, log, error);
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
    // Electron 39 的普通 window.open 可能先报告旧导航结束，令新 loadURL
    // 拒绝为 ERR_FAILED，随后才提交 about:blank。以实际文档就绪为恢复依据。
    let onReady;
    const ready = new Promise((resolve) => {
      onReady = resolve;
      if (typeof webContents.once === "function") webContents.once("dom-ready", onReady);
    });
    try {
      await webContents.loadURL("about:blank");
    } catch (error) {
      await withTimeout(ready, ENCODINGS_COMMAND_TIMEOUT_MS, "空白预热页面未就绪");
      if (webContents.getURL() !== "about:blank") throw error;
    } finally {
      if (typeof webContents.removeListener === "function") webContents.removeListener("dom-ready", onReady);
    }
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
    decodeReattachStates.set(webContents, reattachState);
    dbg.on("detach", (_event, reason) => {
      scheduleChromiumBrotliReattach(webContents, dbg, log, options, reattachState, reason);
    });
    decodeListenersInstalled.add(webContents);
  }
  try {
    // 调试通道只允许一个客户端：开发者工具占着就 attach 不上。与重连分支同一口径，先关掉。
    if (typeof webContents.isDevToolsOpened === "function" && webContents.isDevToolsOpened()) {
      webContents.closeDevTools();
    }
  } catch {
    /* 关不掉就交给下面的 attach 抛错，失败会进入可重试状态 */
  }
  try {
    if (!dbg.isAttached()) dbg.attach("1.3");
    await applyChromiumAcceptedEncodings(dbg);
    decodeReady.add(webContents);
    const reattachState = decodeReattachStates.get(webContents);
    if (reattachState) reattachState.failures = 0;
    if (typeof webContents.id === "number") clearRemoteGate(webContents.id);
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
    // 原导航的 did-stop-loading 回调尚未退出时就 loadURL(about:blank)，
    // Electron 会把旧导航的收尾误交给新 loadURL，导致 ERR_FAILED。等到下一轮再预热。
    if (typeof contents.isLoading === "function" && contents.isLoading()) {
      contents.once("did-stop-loading", () => setImmediate(run));
      return;
    }
    run();
  };
  // window.open 先发出 did-start-navigation，will-navigate 才到。
  // 不能在 did-start-navigation 里同步 stop()，Electron 39 会在这里崩溃。
  // 取消交给 will-navigate 的 preventDefault；这里只记住主框架的真实导航地址，等这一轮结束再装调试通道。
  // 子框架与 pushState/replaceState 这类同文档导航也会发这个事件，重放成顶层 loadURL 会把整页冲掉。
  contents.on("did-start-navigation", (event, url, isInPlace, isMainFrame) => {
    const target = typeof event?.url === "string" ? event.url : url;
    const mainFrame = typeof event?.isMainFrame === "boolean" ? event.isMainFrame : isMainFrame !== false;
    const sameDocument = typeof event?.isSameDocument === "boolean" ? event.isSameDocument : isInPlace === true;
    if (!mainFrame || sameDocument) return;
    if (decodeSuspended.has(contents)) {
      if (!isAbout(target)) queuedUrl = target;
      return;
    }
    if (decodeReady.has(contents) || resuming || isAbout(target)) return;
    queuedUrl = target;
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
  clearChromiumServiceWorkers,
  installChromiumBrotliNetworkPause,
  installChromiumBrotliDecodeBlock,
  registerChromiumBrotliProtection,
  chromiumBrotliProtectionEnabled,
  chromiumBrotliFailureScope,
  configureChromiumBrotliRemoteGate,
  trackChromiumWebContents,
  isChromiumBrotliDecodeReady,
};
