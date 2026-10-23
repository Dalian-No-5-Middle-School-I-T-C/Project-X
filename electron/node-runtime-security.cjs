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
    return `Electron 内嵌的 Node.js ${version} 仍受 ${CVE_2026_111497} 影响（Brotli 解码越界写）。稳定版 Electron 尚未带上已修复的 Node.js，扫描端已关闭 Node 的 Brotli 解码，出站请求不再接受 br。上游发布含 Node.js ${floors} 及以上的版本后请升级扫描端。`;
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

module.exports = {
  CVE_2026_111497,
  NODE_RUNTIME_REFUSAL_EXIT_CODE,
  NODE_RUNTIME_CVE_SHELL_CHECK,
  isNodeRuntimeVulnerableToCve2026111497,
  nodeRuntimeCveMessage,
  installBrotliDecodeGuard,
  enforceNodeRuntimeCve2026111497,
};
