/**
 * CVE-2026-111497：Node.js Brotli 解码越界写。
 *
 * 已修复的版本是 22.23.4、24.22.1、26.12.1。服务端在更低版本上退出 78；
 * Electron 内嵌的 Node 还没有对应的稳定版，扫描端改为拒绝进入原生 Brotli 解码。
 *
 * 用法：npx tsx scripts/verify-node-runtime-cve.ts
 * 本脚本自己必须跑在已修复的 Node 上，否则无法区分「闸门生效」和「运行时本身有洞」。
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import {
  CVE_2026_111497,
  NODE_RUNTIME_CVE_SHELL_CHECK,
  NODE_RUNTIME_REFUSAL_EXIT_CODE,
  enforceNodeRuntimeCve2026111497,
  installBrotliDecodeGuard,
  isNodeRuntimeVulnerableToCve2026111497,
} from "../src/shared/nodeRuntimeSecurity";

const require = createRequire(import.meta.url);
const cjs = require("../electron/node-runtime-security.cjs") as {
  CVE_2026_111497: string;
  NODE_RUNTIME_CVE_SHELL_CHECK: string;
  NODE_RUNTIME_REFUSAL_EXIT_CODE: number;
  isNodeRuntimeVulnerableToCve2026111497: (version: string) => boolean;
  installBrotliDecodeGuard: () => void;
  enforceNodeRuntimeCve2026111497: (options?: {
    version?: string;
    electron?: boolean;
    exitProcess?: boolean;
  }) => { action: string; version: string; message: string };
};
const packaging = require("../scripts/package-server-ubuntu.cjs") as {
  createInstallScript: () => string;
  createSystemdUnit: () => string;
  createRuntimePackageJson: () => { engines?: { node?: string } };
  createDeployReadme: () => string;
};

const versions: Array<[string, boolean]> = [
  ["20.19.5", true],
  ["22.23.3", true],
  ["v22.23.3", true],
  ["22.23.4", false],
  ["22.23.4-rc.1", true],
  ["22.24.0", false],
  ["23.11.0", true],
  ["24.22.0", true],
  ["24.22.1", false],
  ["24.23.0", false],
  ["25.2.1", true],
  ["26.12.0", true],
  ["26.12.1", false],
  ["27.0.0", false],
  ["not-a-version", true],
];

let passed = 0;
const failures: string[] = [];

function check(condition: unknown, label: string): void {
  if (condition) {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failures.push(label);
    console.log(`  \x1b[31m✗\x1b[0m ${label}`);
  }
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 8000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

if (isNodeRuntimeVulnerableToCve2026111497(process.versions.node)) {
  console.error(`当前 Node.js ${process.versions.node} 未修复 ${CVE_2026_111497}，不能用它验证闸门。`);
  process.exit(1);
}

console.log(`\n== 版本判定（当前进程 ${process.versions.node}）==`);
for (const [version, vulnerable] of versions) {
  const ts = isNodeRuntimeVulnerableToCve2026111497(version);
  const cjsResult = cjs.isNodeRuntimeVulnerableToCve2026111497(version);
  check(ts === vulnerable && cjsResult === vulnerable, `${version} → ${vulnerable ? "未修复" : "已修复"}（TS 与主进程副本一致）`);
}

check(cjs.NODE_RUNTIME_CVE_SHELL_CHECK === NODE_RUNTIME_CVE_SHELL_CHECK, "shell 检查脚本与两份实现一致");
check(cjs.NODE_RUNTIME_REFUSAL_EXIT_CODE === NODE_RUNTIME_REFUSAL_EXIT_CODE, "退出码 78 两边一致");
check(cjs.CVE_2026_111497 === CVE_2026_111497, "CVE 编号两边一致");

console.log("\n== shell 一行检查 ==");
for (const [version, vulnerable] of versions) {
  const result = await run(process.execPath, ["-e", NODE_RUNTIME_CVE_SHELL_CHECK], {
    PROJECTX_NODE_VERSION_UNDER_TEST: version,
  });
  check(vulnerable ? result.code === 1 : result.code === 0, `shell ${version} 退出码 ${vulnerable ? 1 : 0}`);
}

const shellCopies: Array<[string, string]> = [
  ["update.sh", readFileSync("update.sh", "utf8")],
  ["tools/repair-benchmark/wsl-runtime.sh", readFileSync("tools/repair-benchmark/wsl-runtime.sh", "utf8")],
  ["scripts/setup-wsl-e2e.sh", readFileSync("scripts/setup-wsl-e2e.sh", "utf8")],
  ["systemd/install.sh", packaging.createInstallScript()],
];
for (const [name, text] of shellCopies) {
  check(text.includes(NODE_RUNTIME_CVE_SHELL_CHECK), `${name} 嵌入了同一条版本检查`);
}
check(readFileSync("tools/repair-benchmark/wsl-runtime.sh", "utf8").includes("node-v22.23.4-linux-x64"), "基准环境下载 Node.js 22.23.4");
check(readFileSync("scripts/setup-wsl-e2e.sh", "utf8").includes("node-v22.23.4-linux-x64"), "WSL e2e 指向 Node.js 22.23.4");
check(!readFileSync("tools/repair-benchmark/wsl-runtime.sh", "utf8").includes("v22.22.0"), "基准环境不再下载 22.22.0");

console.log("\n== 部署与入口接线 ==");
const unit = packaging.createSystemdUnit();
check(unit.includes("RestartPreventExitStatus=78"), "systemd 对退出码 78 不再重启循环");
check(/ExecStart=\/usr\/bin\/node /.test(unit), "单元仍执行 /usr/bin/node");
const runtime = packaging.createRuntimePackageJson();
check(runtime.engines?.node === ">=22.23.4 <23 || >=24.22.1 <25 || >=26.12.1", "Ubuntu 包 engines 停在已修复版本");
const readme = packaging.createDeployReadme();
check(readme.includes("CVE-2026-111497") && readme.includes("22.23.4") && readme.includes("24.22.1") && readme.includes("26.12.1"), "部署说明写明三个修复版本");
check(!readme.includes("apt install -y nodejs"), "部署说明不再把 Ubuntu 自带 nodejs 当成运行时");
const rootPackage = JSON.parse(readFileSync("package.json", "utf8")) as { engines?: { node?: string } };
check(rootPackage.engines?.node === runtime.engines?.node, "仓库 package.json 与 Ubuntu 包的 engines 相同");
const serverEntry = readFileSync("src/apps/answer-card/server/index.ts", "utf8");
check(serverEntry.includes("enforceNodeRuntimeCve2026111497()"), "服务端入口在监听前执行运行时检查");
const mainCjs = readFileSync("electron/main.cjs", "utf8");
check(mainCjs.startsWith("//") && mainCjs.includes('require("./node-runtime-security.cjs").enforceNodeRuntimeCve2026111497()'), "扫描端主进程在加载 Electron 之前执行同一检查");
const ci = readFileSync(".github/workflows/ci.yml", "utf8");
check(!/node-version:\s*\[22\]/.test(ci) && ci.includes("22.23.4"), "CI 固定到 22.23.4，不再浮动大版本");

console.log("\n== 已修复的运行时保持 Brotli 可用 ==");
const allowed = enforceNodeRuntimeCve2026111497({ version: process.versions.node, electron: false, exitProcess: false });
check(allowed.action === "allow" && allowed.message === "", "当前进程判定为 allow，不打印拒绝文案");
const roundTrip = zlib.brotliDecompressSync(zlib.brotliCompressSync(Buffer.from("still-works"))).toString();
check(roundTrip === "still-works", "未触发闸门时 brotliDecompressSync 仍可用");
const refused = enforceNodeRuntimeCve2026111497({ version: "22.23.3", electron: false, exitProcess: false });
check(refused.action === "refuse" && refused.message.includes(CVE_2026_111497) && refused.message.includes("78"), "22.23.3 在非 Electron 下判定为 refuse");
check(zlib.brotliDecompressSync(zlib.brotliCompressSync(Buffer.from("not-poisoned"))).toString() === "not-poisoned", "只做判定不会改掉当前进程的解码器");

console.log("\n== 未修复版本：服务端退出 78，Electron 拒绝解码 ==");

const tempDir = mkdtempSync(path.join(tmpdir(), "projectx-cve-2026-111497-"));
const probePath = path.join(tempDir, "probe.cjs");
writeFileSync(probePath, `
const impl = require(process.argv[2]);
const mode = process.argv[3];
if (mode === "refuse") {
  impl.enforceNodeRuntimeCve2026111497({ version: "22.22.0", electron: false });
  console.log("SURVIVED");
  process.exit(0);
}
impl.installBrotliDecodeGuard();
const zlib = require("node:zlib");
const http = require("node:http");
const br = zlib.brotliCompressSync(Buffer.from("hello-brotli"));
const gz = zlib.gzipSync(Buffer.from("hello-gzip"));
let syncBlocked = false;
try {
  zlib.brotliDecompressSync(br);
} catch (error) {
  syncBlocked = error && error.code === "ERR_BROTLI_DISABLED";
}
const seen = [];
const server = http.createServer((req, res) => {
  seen.push(req.headers["accept-encoding"] || "");
  if (req.url === "/br") {
    res.writeHead(200, { "content-encoding": "br", "content-type": "text/plain" });
    res.end(br);
    return;
  }
  if (req.url === "/garbage") {
    res.writeHead(200, { "content-encoding": "br", "content-type": "text/plain" });
    res.end(Buffer.from("this-is-not-brotli"));
    return;
  }
  res.writeHead(200, { "content-encoding": "gzip", "content-type": "text/plain" });
  res.end(gz);
});
server.listen(0, "127.0.0.1", async () => {
  const port = server.address().port;
  const gzipText = await (await fetch("http://127.0.0.1:" + port + "/gz")).text();
  let brotliRejected = false;
  let garbageRejected = false;
  try {
    const response = await fetch("http://127.0.0.1:" + port + "/br");
    await response.text();
  } catch (error) {
    brotliRejected = true;
  }
  try {
    const response = await fetch("http://127.0.0.1:" + port + "/garbage");
    await response.text();
  } catch (error) {
    garbageRejected = true;
  }
  server.close();
  console.log(JSON.stringify({
    syncBlocked,
    gzipText,
    brotliRejected,
    garbageRejected,
    acceptEncoding: seen
  }));
});
`);

const cjsRefuse = await run(process.execPath, [probePath, path.resolve("electron/node-runtime-security.cjs"), "refuse"]);
check(cjsRefuse.code === NODE_RUNTIME_REFUSAL_EXIT_CODE && !cjsRefuse.stdout.includes("SURVIVED"), "主进程副本：22.22.0 非 Electron 退出 78");
check(cjsRefuse.stderr.includes(CVE_2026_111497), "主进程副本：拒绝文案带 CVE 编号");

const tsRefuse = await run(process.execPath, [
  "--import", "tsx",
  "-e",
  'import { enforceNodeRuntimeCve2026111497 } from "./src/shared/nodeRuntimeSecurity.ts"; enforceNodeRuntimeCve2026111497({ version: "22.22.0", electron: false }); console.log("SURVIVED");',
]);
check(tsRefuse.code === NODE_RUNTIME_REFUSAL_EXIT_CODE && !tsRefuse.stdout.includes("SURVIVED"), "服务端模块：22.22.0 非 Electron 退出 78");

async function probeGuard(modulePath: string, label: string): Promise<void> {
  const result = await run(process.execPath, [probePath, modulePath, "guard"]);
  let parsed: { syncBlocked?: boolean; gzipText?: string; brotliRejected?: boolean; garbageRejected?: boolean; acceptEncoding?: string[] } = {};
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    parsed = {};
  }
  const encodings = parsed.acceptEncoding ?? [];
  const advertisedBrotli = encodings.some((value) => value.split(",").some((part) => part.trim() === "br"));
  check(result.code === 0 && parsed.syncBlocked === true, `${label}：brotliDecompressSync 在进入原生解码前被拒绝`);
  check(result.code === 0 && parsed.gzipText === "hello-gzip", `${label}：gzip 响应仍能解开`);
  check(result.code === 0 && parsed.brotliRejected === true && parsed.garbageRejected === true, `${label}：合法与畸形的 br 响应都不会被解码`);
  check(result.code === 0 && encodings.length >= 2 && !advertisedBrotli, `${label}：出站 Accept-Encoding 不再声明 br`);
  if (result.code !== 0) {
    console.log(result.stdout);
    console.log(result.stderr);
  }
}

await probeGuard(path.resolve("electron/node-runtime-security.cjs"), "主进程副本");

const tsProbe = await run(process.execPath, [
  "--import", "tsx",
  "-e",
  `
import { installBrotliDecodeGuard } from "./src/shared/nodeRuntimeSecurity.ts";
import zlib from "node:zlib";
import { createServer } from "node:http";
installBrotliDecodeGuard();
const br = zlib.brotliCompressSync(Buffer.from("hello-brotli"));
const gz = zlib.gzipSync(Buffer.from("hello-gzip"));
let syncBlocked = false;
try { zlib.brotliDecompressSync(br); } catch (error) { syncBlocked = error && error.code === "ERR_BROTLI_DISABLED"; }
const seen = [];
const server = createServer((req, res) => {
  seen.push(String(req.headers["accept-encoding"] || ""));
  if (req.url === "/br") { res.writeHead(200, { "content-encoding": "br" }); res.end(br); return; }
  if (req.url === "/garbage") { res.writeHead(200, { "content-encoding": "br" }); res.end(Buffer.from("this-is-not-brotli")); return; }
  res.writeHead(200, { "content-encoding": "gzip" }); res.end(gz);
});
server.listen(0, "127.0.0.1", async () => {
  const port = server.address().port;
  const gzipText = await (await fetch("http://127.0.0.1:" + port + "/gz")).text();
  let brotliRejected = false;
  let garbageRejected = false;
  try { await (await fetch("http://127.0.0.1:" + port + "/br")).text(); } catch { brotliRejected = true; }
  try { await (await fetch("http://127.0.0.1:" + port + "/garbage")).text(); } catch { garbageRejected = true; }
  server.close();
  console.log(JSON.stringify({ syncBlocked, gzipText, brotliRejected, garbageRejected, acceptEncoding: seen }));
});
`,
]);
{
  let parsed: { syncBlocked?: boolean; gzipText?: string; brotliRejected?: boolean; garbageRejected?: boolean; acceptEncoding?: string[] } = {};
  try { parsed = JSON.parse(tsProbe.stdout.trim()); } catch { parsed = {}; }
  const encodings = parsed.acceptEncoding ?? [];
  const advertisedBrotli = encodings.some((value) => value.split(",").some((part) => part.trim() === "br"));
  check(tsProbe.code === 0 && parsed.syncBlocked === true && parsed.gzipText === "hello-gzip", "服务端模块：同步解码被拒，gzip 仍可用");
  check(tsProbe.code === 0 && parsed.brotliRejected === true && parsed.garbageRejected === true && !advertisedBrotli, "服务端模块：br 响应被丢弃且不再声明 br");
  if (tsProbe.code !== 0) {
    console.log(tsProbe.stdout);
    console.log(tsProbe.stderr);
  }
}

const guarded = enforceNodeRuntimeCve2026111497({ version: "24.22.0", electron: true, exitProcess: false });
check(guarded.action === "guard" && guarded.message.includes("Electron"), "Electron 24.22.0 走 guard 而不是退出");
let parentSyncBlocked = false;
try {
  zlib.brotliDecompressSync(zlib.brotliCompressSync(Buffer.from("x")));
} catch (error) {
  parentSyncBlocked = (error as NodeJS.ErrnoException).code === "ERR_BROTLI_DISABLED";
}
check(parentSyncBlocked, "guard 判定会在当前进程装上解码闸门");
let secondInstallThrew = false;
try {
  installBrotliDecodeGuard();
} catch {
  secondInstallThrew = true;
}
check(!secondInstallThrew, "重复安装闸门不会抛错");

rmSync(tempDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
