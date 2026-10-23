/**
 * CVE-2026-111497：Node.js 自带的 Brotli 解码器在处理非法 block switch 时会越界写。
 * 受影响的是 22.23.4、24.22.1、26.12.1 之前的当前维护线，以及已经停更、没有补丁的 20/23/25。
 * 触发条件是进程用 `node:zlib` 解开攻击者提供的 Brotli（含 `fetch` 自动解码 `Content-Encoding: br`）。
 *
 * 服务端跑在系统 Node 上，版本不够就退出 78，不监听端口。
 * 扫描端跑在 Electron 内嵌的 Node 上。截至 2026-10-23，稳定版 Electron（含 45.0.0）仍带有
 * 未修复的 Node（24.22.0 或更早）和未修复的 Chromium 142，升级 Electron 不能补上这个洞。
 * 这里关掉 Node 的 Brotli 解码。Chromium 那条路径在 `electron/main.cjs` 里另行关掉：
 * 窗口只接受 gzip 与 deflate，br 不会进入 Chromium 的解码器。
 *
 * `electron/node-runtime-security.cjs` 是同一套规则的副本（主进程不能加载这份 TypeScript）。
 * `scripts/verify-node-runtime-cve.ts` 会核对两边的判定和下面这行 shell 检查。
 */

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
  write: (chunk?: unknown, encoding?: unknown, cb?: unknown) => boolean;
  destroyed?: boolean;
  destroy?: (error?: Error) => void;
} & Record<symbol, boolean>;

type BrotliZlib = {
  createBrotliDecompress: () => unknown;
  brotliDecompress: () => unknown;
  brotliDecompressSync: () => unknown;
  BrotliDecompress: { prototype: BrotliPrototype };
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
    return `Electron 内嵌的 Node.js ${version} 仍受 ${CVE_2026_111497} 影响（Brotli 解码越界写）。稳定版 Electron 的 Node.js 与 Chromium 都还没带上这份补丁。扫描端已关闭 Node 的 Brotli 解码。窗口加载前会再限制 Chromium 只接受 gzip 与 deflate，避免 br 进入 Chromium 的解码器。上游发布同时包含已修复 Node.js（${floors} 及以上）和已修复 Chromium 的版本后请升级扫描端。`;
  }
  return `Node.js ${version} 受 ${CVE_2026_111497} 影响（Brotli 解码越界写，畸形压缩数据可导致崩溃、内存泄露或远程代码执行）。请安装 Node.js ${floors} 及以上后再启动。20.x、23.x、25.x 已停止维护，没有补丁。进程将以退出码 ${NODE_RUNTIME_REFUSAL_EXIT_CODE} 结束。`;
}

function replaceZlibMethod(target: object, key: string, value: () => never): void {
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
 * 替换 Node 公开的 Brotli 解码入口。内置 `fetch` 在收到 `content-encoding: br` 时走
 * `BrotliDecompress.write`；把它挡在原生 `_transform` 之前，解码器就不会处理这段字节。
 * `createBrotliDecompress` 直接抛错，undici 的能力探测会把 `br` 从 Accept-Encoding 里拿掉，
 * 正常的 HTTPS 响应改用 gzip。压缩方向不动。
 */
export function installBrotliDecodeGuard(): void {
  const api = zlib as unknown as BrotliZlib;
  const proto = api.BrotliDecompress.prototype;
  if (proto[GUARD_INSTALLED]) return;
  proto[GUARD_INSTALLED] = true;
  // createBrotliDecompress 在 22.23.4 上是 configurable 但不可写，直接赋值会抛 TypeError。
  replaceZlibMethod(api, "createBrotliDecompress", () => {
    throw disabledError("createBrotliDecompress");
  });
  replaceZlibMethod(api, "brotliDecompress", () => {
    throw disabledError("brotliDecompress");
  });
  replaceZlibMethod(api, "brotliDecompressSync", () => {
    throw disabledError("brotliDecompressSync");
  });
  proto.write = function guardedWrite(this: BrotliPrototype) {
    const error = disabledError("write");
    const stream = this;
    queueMicrotask(() => {
      if (!stream.destroyed) stream.destroy?.(error);
    });
    return false;
  };
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
