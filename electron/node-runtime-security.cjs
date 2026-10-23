/**
 * CVE-2026-111497 的主进程副本。规则与 src/shared/nodeRuntimeSecurity.ts 保持一致，
 * 由 scripts/verify-node-runtime-cve.ts 对照。扫描端主进程是 CJS，不能直接加载那份 TypeScript。
 */

"use strict";

const zlib = require("node:zlib");

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
    return `Electron 内嵌的 Node.js ${version} 仍受 ${CVE_2026_111497} 影响（Brotli 解码越界写）。稳定版 Electron 的 Node.js 与 Chromium 都还没带上这份补丁。扫描端已关闭 Node 的 Brotli 解码。窗口加载前会再限制 Chromium 只接受 gzip 与 deflate，避免 br 进入 Chromium 的解码器。上游发布同时包含已修复 Node.js（${floors} 及以上）和已修复 Chromium 的版本后请升级扫描端。`;
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

function installBrotliDecodeGuard() {
  const proto = zlib.BrotliDecompress.prototype;
  if (proto[GUARD_INSTALLED]) return;
  proto[GUARD_INSTALLED] = true;
  // createBrotliDecompress 在 22.23.4 上是 configurable 但不可写，直接赋值会抛 TypeError。
  replaceZlibMethod(zlib, "createBrotliDecompress", () => {
    throw disabledError("createBrotliDecompress");
  });
  replaceZlibMethod(zlib, "brotliDecompress", () => {
    throw disabledError("brotliDecompress");
  });
  replaceZlibMethod(zlib, "brotliDecompressSync", () => {
    throw disabledError("brotliDecompressSync");
  });
  proto.write = function guardedWrite() {
    const error = disabledError("write");
    const stream = this;
    queueMicrotask(() => {
      if (!stream.destroyed) stream.destroy(error);
    });
    return false;
  };
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
// URLRequestHttpJob 只在 accepted_stream_types 含 kBrotli 时才 CreateBrotliSourceStream；
// 列表里没有 br 时，Content-Encoding: br 会原样透传，解码器不会跑。
// 这组值交给 DevTools 的 Network.setAcceptedEncodings（必须先 Network.enable）。
const CHROMIUM_ACCEPTED_ENCODINGS = Object.freeze(["gzip", "deflate"]);

function headerValues(headers, name) {
  if (!headers || typeof headers !== "object") return [];
  const key = Object.keys(headers).find((item) => item.toLowerCase() === name);
  if (!key) return [];
  const value = headers[key];
  const parts = Array.isArray(value) ? value : [value];
  return parts.flatMap((item) => String(item).split(",")).map((item) => item.trim()).filter(Boolean);
}

function responseUsesBrotli(headers) {
  return headerValues(headers, "content-encoding").some((item) => item.toLowerCase() === "br");
}

function acceptEncodingWithoutBrotli(value) {
  const kept = String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item && item.toLowerCase() !== "br");
  return kept.length > 0 ? kept.join(", ") : "gzip, deflate";
}

// webRequest 看得到响应头时，网络进程里的 Brotli 解码器可能已经跑过。
// 取消 br 响应只是第二层；真正让 CreateBrotliSourceStream 不执行的是下面的 CDP 覆盖。
const CHROMIUM_REQUEST_FILTER = { urls: ["<all_urls>"] };
const headerBlockedSessions = new WeakSet();
const decodeListenersInstalled = new WeakSet();
const decodeConfiguredSessions = new WeakMap();
const decodeReattachPending = new WeakSet();

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

async function installChromiumBrotliDecodeBlock(webContents, log, options) {
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
    dbg.on("detach", (_event, reason) => {
      if (typeof webContents.isDestroyed === "function" && webContents.isDestroyed()) return;
      if (decodeReattachPending.has(webContents)) return;
      decodeReattachPending.add(webContents);
      decodeConfiguredSessions.delete(webContents);
      writeRuntimeLog(log, "ERROR", `[Electron] Brotli 解码拦截通道断开 reason=${reason}，正在重新装上`);
      setImmediate(() => {
        decodeReattachPending.delete(webContents);
        if (typeof webContents.isDestroyed === "function" && webContents.isDestroyed()) return;
        try {
          if (typeof webContents.isDevToolsOpened === "function" && webContents.isDevToolsOpened()) {
            webContents.closeDevTools();
          }
        } catch {
          /* 关不上开发者工具时，下面的重新挂载会失败并停掉页面 */
        }
        Promise.resolve(installChromiumBrotliDecodeBlock(webContents, log, options)).catch((error) => {
          const detail = error instanceof Error ? error.message : String(error);
          writeRuntimeLog(log, "ERROR", `[Electron] 重新关闭 Chromium Brotli 解码失败: ${detail}`);
          try {
            if (typeof webContents.stop === "function") webContents.stop();
          } catch {
            /* 页面可能已经销毁 */
          }
          if (typeof options?.onFatal === "function") options.onFatal(error);
        });
      });
    });
    decodeListenersInstalled.add(webContents);
  }
  try {
    if (!dbg.isAttached()) dbg.attach("1.3");
    await applyChromiumAcceptedEncodings(dbg);
    writeRuntimeLog(log, "INFO", "[Electron] 已限制 Chromium 只接受 gzip 与 deflate，不再解码 br");
  } catch (error) {
    throw chromiumBrotliBlockError(error);
  }
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
  installChromiumBrotliDecodeBlock,
};
