#!/usr/bin/env node
/**
 * 随包 Windows 原生件（ia32 与 x64）的来源核对（发布链路专用）。
 *
 * 要堵的是「发出去的包里的二进制，比审过的源码旧」这件事。⑥ 门槛只搜几颗字串，
 * 字串还在就看不出来桥接是旧的；`source-sha256.txt` 也只覆盖识别器源码，
 * `native/ScannerBridge/**` 一颗都不在里面。两道检查合起来才够用：
 *
 *  1. 摘要核对：按 `resources/native/win-ia32/source-sha256.txt` 逐行取源码哈希比对
 *     （与 `package-server-ubuntu.cjs` 核对 Linux 补识别器共用 `scripts/lib/native-source-manifest.cjs`
 *     这一份判据，比对用原始字节）。**清单必须覆盖这条构建线的全部必选源码**：识别器目录下每个
 *     .cpp/.hpp、`native/CMakeLists.txt`、该线的 toolchain 与该线自己的构建脚本。清单空了、
 *     被删掉一行、或少列了必选文件都算失败——「记了几行只查几行」等于允许随包二进制悄悄落后。
 *  2. 内容核对：拿 `scanner-bridge.exe` 最后一次入库的那个提交，与当前 HEAD 比
 *     `native/ScannerBridge` 的差异；有差异就说明桥接源码动过而包内件没重编。
 *     用内容而不是提交时间比较，merge / rebase 不会造成误报。
 *     已知边界（要一次 ia32 重编才能收口，也记在 readus/发布构建与服务器更新时间.md）：基线取的是
 *     「exe 最后一次入库的提交」，改了桥接源码之后又单独重交一份 exe 会把基线一起移动，这道核对
 *     就看不出来。彻底闭合要把桥接源码摘要写进清单，而那必须与 ia32 原生件的重编同批做。
 *
 * 需要完整 git 历史：`fetch-depth: 1` 的检出查不到「 exe 最后一次入库的提交」，
 * 这时本脚本判失败并说明要加深历史，而不是当成通过。
 *
 * 运行：npm run verify:native-provenance（在 .github/workflows/release-build.yml 的扫描端作业里，
 * 紧跟 ⑥ 门槛之后、打包之前）
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bridgeExe = "resources/native/win-ia32/scanner-bridge.exe";
const bridgeSourceDir = "native/ScannerBridge";
const nativeManifest = createRequire(import.meta.url)("./lib/native-source-manifest.cjs") as {
  verifyNativeSourceManifest: (params: { rootDir: string; lane: string }) => {
    entries: Map<string, string>;
    failures: string[];
    missing: string[];
    crlfCheckout: string[];
  };
  requiredSources: (rootDir: string, lane: string) => string[];
};
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

// ── 1. 源码摘要清单（逐行摘要 + 必选覆盖面，两条 Windows 线各查一遍）──
// win-x64 的识别器同样随包分发（x64 扫描端用它），它的 source-sha256.txt 与 ia32 同构，
// 但原先没有任何人按新判据核对——「清单记了几行就只查几行」这个洞在那条线上还在。
for (const lane of ["win-ia32", "win-x64"]) {
  console.log(`\n── 随包 ${lane} 原生件的源码摘要清单`);
  const check = nativeManifest.verifyNativeSourceManifest({ rootDir: root, lane });
  // CRLF 检出单独给结论：这不是源码变更，是这份工作副本把源码检成了 CRLF。
  for (const relative of check.crlfCheckout) {
    fail(`${relative} 与清单只对得上「换行归一后」的哈希：这份工作副本把源码检成了 CRLF，而清单记的是 Linux 上的原始字节哈希。`
      + "检出要同时设 core.autocrlf=false 与 core.eol=lf：.gitattributes 的 `* text=auto` 把这些文件判成 text 后，"
      + "用哪个换行由 core.eol 决定（默认 native，在 Windows 上就是 CRLF），只关 autocrlf 不管用"
      + "（第十跑的日志证明了这点）。发布作业里两个都已设置。");
  }
  for (const message of check.failures) fail(message);
  if (check.failures.length === 0 && check.crlfCheckout.length === 0) {
    const required = nativeManifest.requiredSources(root, lane);
    pass(`${lane}: 清单 ${check.entries.size} 行，覆盖必选源码 ${required.length} 项（识别器源码 + ${required.filter(r => !r.startsWith("native/AnswerCardRecognizer")).join("、")}），摘要与当前源码一致`);
  }
  if (lane === "win-ia32") {
    const coversBridge = [...check.entries.keys()].some((relative) => relative.startsWith("native/ScannerBridge/"));
    if (!coversBridge) {
      notes.push("清单不含 native/ScannerBridge 源码，桥接的来源只靠下面的内容核对兜住。"
        + "要让清单也覆盖它，得在 `scripts/build-native-mingw.sh` 的摘要行里加上桥接源码——"
        + "但清单本身记录了那个脚本的哈希，所以这一步只能与 ia32 原生件的重编同批做，否则会立刻要求重发二进制。");
    }
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
  // 桥接的编译输入：自己的源码 + TWAIN 头（`native/CMakeLists.txt` 里直接引用，
  // twain_controller.cpp 会 #include 它）。头改了而包内件没重编，同样会发出行为对不上的 exe。
  // 这里刻意不用 existsSync 过滤：路径写错时静默丢掉等于把门禁配了个寂寞（评审指出
  // 原先配的 native/ScannerBridge/CMakeLists.txt 根本不存在），所以缺路径要响。
  const sourcePaths = [
    `${bridgeSourceDir}/scanner-bridge`,
    `${bridgeSourceDir}/third_party/twain-dsm-2.5.1/include`,
  ];
  const missingPaths = sourcePaths.filter((p) => !existsSync(path.join(root, p)));
  if (missingPaths.length > 0) {
    fail(`配置的桥接源码路径不存在：${missingPaths.join("、")}。这道门禁不能按缺着的路径判定通过。`);
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

// ── 3. TWAINDSM.dll：随包件与第三方源一致 ─────────────────
console.log("\n── TWAINDSM.dll 是否与 DSM 第三方源同步");
const stagedDsm = path.join(root, "resources", "native", "win-ia32", "TWAINDSM.dll");
const vendorDsm = path.join(
  root,
  "native",
  "ScannerBridge",
  "third_party",
  "twain-dsm-2.5.1",
  "dsm",
  "win-ia32",
  "TWAINDSM.dll",
);
if (!existsSync(vendorDsm)) {
  fail(`找不到 DSM 第三方源 ${path.relative(root, vendorDsm)}：无法核对随包 TWAINDSM.dll 是否落后。`);
} else if (!existsSync(stagedDsm)) {
  fail(`找不到随包 ${path.relative(root, stagedDsm)}：扫描端安装包不能缺 DSM。`);
} else {
  const stagedHash = sha256(stagedDsm);
  const vendorHash = sha256(vendorDsm);
  if (stagedHash === vendorHash) {
    pass("随包 TWAINDSM.dll 与 third_party/dsm/win-ia32 源字节一致");
  } else {
    fail(
      "随包 TWAINDSM.dll 与 native/ScannerBridge/third_party/twain-dsm-2.5.1/dsm/win-ia32/TWAINDSM.dll 不一致："
        + "第三方 DSM 已升级但未同步 resources/native/win-ia32/，请按交叉打包工序拷贝并入库。",
    );
  }
}

for (const note of notes) console.log(`  · ${note}`);
console.log(`\nWindows 原生件（ia32 + x64）来源核对：${failures.length === 0 ? "通过" : `${failures.length} 项失败`}。`);
if (failures.length > 0) process.exit(1);
