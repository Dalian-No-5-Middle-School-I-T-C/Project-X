/**
 * CVE-2026-111497：Node.js 自带的 Brotli 解码器在处理非法 block switch 时会越界写。
 * 受影响的是 22.23.4、24.22.1、26.12.1 之前的当前维护线，以及已经停更、没有补丁的 20/23/25。
 * 触发条件是进程用 `node:zlib` 解开攻击者提供的 Brotli（含 `fetch` 自动解码 `Content-Encoding: br`）。
 *
 * 服务端跑在系统 Node 上，版本不够就退出 78，不监听端口。
 * 扫描端 Electron 43.8.3 带 Node 24.22.0 与 Chromium 150.0.7871.250。
 * 内嵌 Node 低于修复版本 24.22.1，因此继续启用 Brotli 解码防护。
 * 这里关掉 Node 的 Brotli 解码。Chromium 那条路径在 `electron/main.cjs` 里另行关掉：
 * 壳直接打开远端页面时，加载前就限制编码；本地壳会在第一次远端请求创建前先装好同一限制，
 * 装好前的远端请求一律取消。
 *
 * `electron/node-runtime-security.cjs` 是同一套规则的副本（主进程不能加载这份 TypeScript）。
 * `scripts/verify-node-runtime-cve.ts` 会核对两边的判定和下面这行 shell 检查。
 */

import { Transform } from "node:stream";
import zlib from "node:zlib";

export const CVE_2026_111497 = "CVE-2026-111497";
/** sysexits.h EX_CONFIG。systemd 的 RestartPreventExitStatus 用这个码打破重启循环。 */
export const NODE_RUNTIME_REFUSAL_EXIT_CODE = 78;
export const NODE_RUNTIME_CVE_SHELL_CHECK =
  'const version=process.env.PROJECTX_NODE_VERSION_UNDER_TEST||process.versions.node;const m=/^v?(\\d+)\\.(\\d+)\\.(\\d+)(.*)$/.exec(String(version).trim());if(!m)process.exit(1);const M=+m[1],n=+m[2],p=+m[3];const bad=m[4]!==""||M<22||M===23||M===25||(M===22&&(n<23||(n===23&&p<4)))||(M===24&&(n<22||(n===22&&p<1)))||(M===26&&(n<12||(n===12&&p<1)));if(bad)process.exit(1);';

const ENFORCED = Symbol.for("projectx.cve-2026-111497");
const GUARD_INSTALLED = Symbol.for("projectx.cve-2026-111497-brotli-guard");

export type NodeRuntimeCveAction = "allow" | "guard" | "refuse";

export type NodeRuntimeCveDecision = {
  action: NodeRuntimeCveAction;
  version: string;
  message: string;
};

type BrotliPrototype = {
  _transform: (chunk: unknown, encoding: unknown, callback: (error?: Error) => void) => void;
  _processChunk: (chunk: unknown, flushFlag: unknown, callback?: (error?: Error) => void) => unknown;
} & Record<symbol, boolean>;

type BrotliConstructor = { prototype: BrotliPrototype };

type BrotliZlib = {
  createBrotliDecompress: () => unknown;
  brotliDecompress: () => unknown;
  brotliDecompressSync: () => unknown;
  BrotliDecompress: BrotliConstructor;
};

function parseNodeVersion(version: string): { major: number; minor: number; patch: number; prerelease: boolean } | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(.*)$/.exec(version.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] !== "",
  };
}

function olderThan(version: { major: number; minor: number; patch: number }, floor: readonly [number, number, number]): boolean {
  if (version.major !== floor[0]) return version.major < floor[0];
  if (version.minor !== floor[1]) return version.minor < floor[1];
  return version.patch < floor[2];
}

/** 未知版本、预发布版本和停更版本一律当成未修复。 */
export function isNodeRuntimeVulnerableToCve2026111497(version: string): boolean {
  const parsed = parseNodeVersion(version);
  if (!parsed || parsed.prerelease) return true;
  const { major } = parsed;
  if (major < 22 || major === 23 || major === 25) return true;
  if (major === 22) return olderThan(parsed, [22, 23, 4]);
  if (major === 24) return olderThan(parsed, [24, 22, 1]);
  if (major === 26) return olderThan(parsed, [26, 12, 1]);
  return false;
}

export function nodeRuntimeCveMessage(version: string, action: Exclude<NodeRuntimeCveAction, "allow">): string {
  const floors = "22.23.4、24.22.1 或 26.12.1";
  if (action === "guard") {
    return `Electron 内嵌的 Node.js ${version} 仍受 ${CVE_2026_111497} 影响（Brotli 解码越界写）。扫描端已关闭 Node 的 Brotli 解码。壳直接加载远端页面时，窗口在加载前只接受 gzip 与 deflate；本地壳会在第一次远端请求创建前先装好同样的限制，装好前的远端请求一律取消。上游发布同时包含已修复 Node.js（${floors} 及以上）和已修复 Chromium 的版本后请升级扫描端。`;
  }
  return `Node.js ${version} 受 ${CVE_2026_111497} 影响（Brotli 解码越界写，畸形压缩数据可导致崩溃、内存泄露或远程代码执行）。请安装 Node.js ${floors} 及以上后再启动。20.x、23.x、25.x 已停止维护，没有补丁。进程将以退出码 ${NODE_RUNTIME_REFUSAL_EXIT_CODE} 结束。`;
}

function replaceZlibMethod(target: object, key: string, value: (...args: never[]) => unknown): void {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (descriptor?.configurable) {
    Object.defineProperty(target, key, { ...descriptor, value, writable: true });
    return;
  }
  (target as Record<string, unknown>)[key] = value;
}

function disabledError(api: string): Error {
  const error = new Error(`${CVE_2026_111497}: Brotli decode is disabled (${api})`) as NodeJS.ErrnoException;
  error.code = "ERR_BROTLI_DISABLED";
  return error;
}

/**
 * 替换 Node 公开的 Brotli 解码入口。`Writable.end(chunk)` 走的是流内部的 `_write`，
 * 不会调用实例上的 `write`，所以只换 `write` 挡不住 `new BrotliDecompress().end(chunk)`。
 * 构造器直接抛错；已经拿到旧构造器的实例则在 `_transform` / `_processChunk` 停住，
 * 字节不会进入原生解码器。`createBrotliDecompress` 交给一个不会调用原生解码器的流，
 * 并在下一轮事件循环销毁：Electron 自带的 Node 22.22.1 上同步抛错会打崩进程，
 * 同步在 `_transform` 里报错又会让 `fetch` 的 `text()` 停住。压缩方向不动。
 */
function createDisabledBrotliDecompress(): Transform {
  const error = disabledError("createBrotliDecompress");
  const stream = new Transform({
    transform() {},
  });
  stream.on("error", () => {});
  setImmediate(() => {
    if (!stream.destroyed) stream.destroy(error);
  });
  return stream;
}

export function installBrotliDecodeGuard(): void {
  const api = zlib as unknown as BrotliZlib;
  const proto = api.BrotliDecompress.prototype;
  if (proto[GUARD_INSTALLED]) return;
  proto[GUARD_INSTALLED] = true;
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
  // createBrotliDecompress 在 22.23.4 上是 configurable 但不可写，直接赋值会抛 TypeError。
  replaceZlibMethod(api, "createBrotliDecompress", createDisabledBrotliDecompress);
  replaceZlibMethod(api, "brotliDecompress", () => {
    throw disabledError("brotliDecompress");
  });
  replaceZlibMethod(api, "brotliDecompressSync", () => {
    throw disabledError("brotliDecompressSync");
  });
  const DisabledBrotliDecompress = function DisabledBrotliDecompress(this: unknown) {
    throw disabledError("BrotliDecompress");
  } as unknown as BrotliConstructor;
  DisabledBrotliDecompress.prototype = proto;
  replaceZlibMethod(api, "BrotliDecompress", DisabledBrotliDecompress as unknown as () => unknown);
}

export function enforceNodeRuntimeCve2026111497(options?: {
  version?: string;
  electron?: boolean;
  /** 测试里观察 refuse 判定时不要真的退出。生产调用保持默认 true。 */
  exitProcess?: boolean;
}): NodeRuntimeCveDecision {
  const productionCall = options === undefined;
  const slot = globalThis as typeof globalThis & Record<symbol, NodeRuntimeCveDecision | undefined>;
  if (productionCall && slot[ENFORCED]) return slot[ENFORCED];

  const version = options?.version ?? process.versions.node;
  const electron = options?.electron ?? typeof process.versions.electron === "string";
  let decision: NodeRuntimeCveDecision;
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
  if (productionCall) slot[ENFORCED] = decision;
  return decision;
}
