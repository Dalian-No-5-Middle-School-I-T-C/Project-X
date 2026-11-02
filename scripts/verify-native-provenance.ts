#!/usr/bin/env node
/**
 * 随包 Windows ia32 原生件的来源核对（发布链路专用）。
 *
 * 要堵的是「发出去的包里的二进制，比审过的源码旧」这件事。⑥ 门槛只搜几颗字串，
 * 字串还在就看不出来桥接是旧的；`source-sha256.txt` 也只覆盖识别器源码，
 * `native/ScannerBridge/**` 一颗都不在里面。两道检查合起来才够用：
 *
 *  1. 摘要核对：按 `resources/native/win-ia32/source-sha256.txt` 逐行取 `native/**` 与
 *     `scripts/build-native-mingw.sh` 的哈希比对（与 `package-server-ubuntu.cjs` 核对 Linux
 *     补识别器的同一套规则，比对用原始字节）。清单没列的源码不在这一道的保护范围内。
 *  2. 内容核对：拿 `scanner-bridge.exe` 最后一次入库的那个提交，与当前 HEAD 比
 *     `native/ScannerBridge` 的差异；有差异就说明桥接源码动过而包内件没重编。
 *     用内容而不是提交时间比较，merge / rebase 不会造成误报。
 *
 * 需要完整 git 历史：`fetch-depth: 1` 的检出查不到「 exe 最后一次入库的提交」，
 * 这时本脚本判失败并说明要加深历史，而不是当成通过。
 *
 * 运行：npm run verify:native-provenance（在 .github/workflows/release.yml 的扫描端作业里，
 * 紧跟 ⑥ 门槛之后、打包之前）
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = path.join(root, "resources", "native", "win-ia32", "source-sha256.txt");
const bridgeExe = "resources/native/win-ia32/scanner-bridge.exe";
const bridgeSourceDir = "native/ScannerBridge";
const failures: string[] = [];
const notes: string[] = [];

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function fail(message: string): void {
  failures.push(message);
  console.error(`  ✗ ${message}`);
}

function pass(message: string): void {
  console.log(`  ✓ ${message}`);
}

// ── 1. 源码摘要清单 ──────────────────────────────────────
console.log("\n── 随包 ia32 原生件的源码摘要清单");
if (!existsSync(manifest)) {
  fail(`找不到清单 ${path.relative(root, manifest)}：交叉构建工序的产物来源没有被记录下来。`);
} else {
  const lines = readFileSync(manifest, "utf8").split(/\r?\n/).filter((line) => line.trim() !== "");
  const checkedDirs = new Set<string>();
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  (native\/[A-Za-z0-9_./-]+|scripts\/[A-Za-z0-9_./-]+)$/.exec(line);
    if (!match) {
      fail(`清单里有无法解析的行：${line.slice(0, 80)}`);
      continue;
    }
    const [, expected, relative] = match;
    const file = path.join(root, relative);
    if (!existsSync(file)) {
      fail(`清单列出的文件已不存在：${relative}（源码被移动或删除，包内件对应不到当前仓库）`);
      continue;
    }
    const actual = sha256(file);
    if (actual === expected) {
      checkedDirs.add(relative.split("/").slice(0, 2).join("/"));
      continue;
    }
    // 与 package-server-ubuntu.cjs 同一套判读：行尾差异是检出问题，不是源码变更。
    const normalized = Buffer.from(readFileSync(file).toString("utf8").replace(/\r\n/g, "\n"), "utf8");
    const lfDigest = createHash("sha256").update(normalized).digest("hex");
    if (lfDigest === expected) {
      fail(`${relative} 是 CRLF 检出的工作副本，无法核对 ia32 原生件源码摘要。请在 LF 检出（Linux 构建机或 CI）上跑这道门禁。`);
    } else {
      fail(`${relative} 与清单摘要不一致：源码已改动而随包 ia32 识别器没重编。请按 readus/Windows32位扫描端交叉打包.md 重编并入库。`);
    }
  }
  if (failures.length === 0) {
    pass(`清单 ${lines.length} 行全部与当前源码一致（覆盖：${[...checkedDirs].join("、")}）`);
  }
  const coversBridge = lines.some((line) => line.includes("native/ScannerBridge/"));
  if (!coversBridge) {
    notes.push("清单不含 native/ScannerBridge 源码，桥接的来源只靠下面的内容核对兜住。"
      + "要让清单也覆盖它，得在 `scripts/build-native-mingw.sh` 的摘要行里加上桥接源码——"
      + "但清单本身记录了那个脚本的哈希，所以这一步只能与 ia32 原生件的重编同批做，否则会立刻要求重发二进制。");
  }
}

// ── 2. 桥接：内容核对 ────────────────────────────────────
console.log("\n── scanner-bridge.exe 是否落后于桥接源码");
let bridgeCommit = "";
try {
  bridgeCommit = git(["log", "-1", "--format=%H", "--", bridgeExe]);
} catch (error) {
  fail(`git log 查询失败：${error instanceof Error ? error.message.split("\n")[0] : "unknown"}`);
}
if (!bridgeCommit) {
  fail(`查不到 ${bridgeExe} 的入库提交。可能是浅克隆（fetch-depth 太小）或该文件未纳入版本控制——这道门禁要完整历史才能判。`);
} else {
  // 桥接目录里除了源码还有 third_party/twain-dsm 的二进制与声明；只比源码子目录，
  // 否则重打包 third_party 也会误报成「源码动过没重编」。
  const sourcePaths = [
    `${bridgeSourceDir}/scanner-bridge`,
    `${bridgeSourceDir}/CMakeLists.txt`,
  ].filter((p) => existsSync(path.join(root, p)));
  if (sourcePaths.length === 0) {
    fail(`找不到桥接源码路径（${bridgeSourceDir}），无法核对包内件是否落后。`);
  } else {
    let drifted = false;
    try {
      git(["diff", "--quiet", bridgeCommit, "HEAD", "--", ...sourcePaths]);
    } catch {
      drifted = true;
    }
    if (drifted) {
      fail(`桥接源码在 ${bridgeExe} 最后一次入库之后又变了（对比提交 ${bridgeCommit.slice(0, 7)}..HEAD）。随包 exe 仍是旧的，发出去的行为会落后于审过的源码：请按交叉打包工序重编 ia32 并入库。`);
    } else {
      pass(`自提交 ${bridgeCommit.slice(0, 7)} 入库以来，${sourcePaths.join(" 与 ")} 没有内容变化`);
    }
  }
}

for (const note of notes) console.log(`  · ${note}`);
console.log(`\nia32 原生件来源核对：${failures.length === 0 ? "通过" : `${failures.length} 项失败`}。`);
if (failures.length > 0) process.exit(1);
