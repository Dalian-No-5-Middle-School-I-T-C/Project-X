/**
 * CVE-2026-111497：Node.js Brotli 解码越界写。
 *
 * 已修复的版本是 22.23.4、24.22.1、26.12.1。服务端在更低版本上退出 78；
 * Electron 内嵌的 Node 还没有对应的稳定版，扫描端改为拒绝进入原生 Brotli 解码。
 * Chromium 142 的解码器是另一条路径：窗口只接受 gzip 与 deflate，br 不会交给它解。
 *
 * 用法：npx tsx scripts/verify-node-runtime-cve.ts
 * 本脚本自己必须跑在已修复的 Node 上，否则无法区分「闸门生效」和「运行时本身有洞」。
 */

import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  nodeRuntimeCveMessage,
} from "../src/shared/nodeRuntimeSecurity";

const require = createRequire(import.meta.url);
const cjs = require("../electron/node-runtime-security.cjs") as {
  CVE_2026_111497: string;
  NODE_RUNTIME_CVE_SHELL_CHECK: string;
  NODE_RUNTIME_REFUSAL_EXIT_CODE: number;
  isNodeRuntimeVulnerableToCve2026111497: (version: string) => boolean;
  installBrotliDecodeGuard: () => void;
  nodeRuntimeCveMessage: (version: string, action: "guard" | "refuse") => string;
  enforceNodeRuntimeCve2026111497: (options?: {
    version?: string;
    electron?: boolean;
    exitProcess?: boolean;
  }) => { action: string; version: string; message: string };
  CHROMIUM_ACCEPTED_ENCODINGS: readonly string[];
  responseUsesBrotli: (headers: unknown) => boolean;
  acceptEncodingWithoutBrotli: (value: unknown) => string;
  installChromiumBrotliHeaderBlock: (session: unknown, log?: (level: string, message: string) => void) => void;
  installChromiumBrotliNetworkPause: (session: unknown, log?: (level: string, message: string) => void) => void;
  isChromiumBrotliDecodeReady: (webContents: unknown) => boolean;
  installChromiumBrotliDecodeBlock: (
    webContents: unknown,
    log?: (level: string, message: string) => void,
    options?: { onFatal?: (error: unknown) => void },
  ) => Promise<void>;
  chromiumBrotliFailureScope: (webContents: unknown, mainWebContents: unknown) => "process" | "window";
  configureChromiumBrotliRemoteGate: (options: { onWindowFatal?: (webContents: unknown, error: unknown) => void; log?: (level: string, message: string) => void } | null) => void;
  trackChromiumWebContents: (webContents: { id?: number }) => void;
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

function run(command: string, args: string[], env: NodeJS.ProcessEnv = {}, timeoutMs = 8000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
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
  check(text.includes("env -u PROJECTX_NODE_VERSION_UNDER_TEST"), `${name} 清掉测试用的版本变量后再检查`);
}
check(readFileSync("tools/repair-benchmark/wsl-runtime.sh", "utf8").includes("node-v22.23.4-linux-x64"), "基准环境下载 Node.js 22.23.4");
check(readFileSync("scripts/setup-wsl-e2e.sh", "utf8").includes("node-v22.23.4-linux-x64"), "WSL e2e 指向 Node.js 22.23.4");
check(!readFileSync("tools/repair-benchmark/wsl-runtime.sh", "utf8").includes("v22.22.0"), "基准环境不再下载 22.22.0");

console.log("\n== update.sh 跳过未修复的 Node ==");
const nodePick = await run("bash", ["-c", String.raw`
set -euo pipefail
export PROJECTX_UPDATE_LIB_ONLY=1
source ./update.sh
dir=$(mktemp -d)
old="$dir/old node"
new="$dir/new-node"
bomb="$dir/bomb-node"
missing="$dir/missing node"
cat > "$old" << 'EOF'
#!/bin/bash
if [ "$1" = "--version" ]; then echo v22.14.0; exit 0; fi
exit 1
EOF
cat > "$new" << 'EOF'
#!/bin/bash
if [ "$1" = "--version" ]; then echo v22.23.4; exit 0; fi
exit 0
EOF
cat > "$bomb" << 'EOF'
#!/bin/bash
echo bomb >> "$BOMB_LOG"
exit 0
EOF
chmod +x "$old" "$new" "$bomb"
export BOMB_LOG="$dir/bomb.log"
picked=$(detect_node "$old" "$new")
status=0
only_old=$(detect_node "$old") || status=$?
skipped=$(detect_node "$missing" "$new")
first=$(detect_node "$new" "$bomb")
quiet=QUIET
if [ -f "$BOMB_LOG" ]; then quiet=BOMB; fi
printf '%s\n' "$picked" "$status" "$only_old" "$skipped" "$first" "$quiet"
rm -rf "$dir"
`]);
const pickLines = nodePick.stdout.trim().split(/\r?\n/);
check((readFileSync("update.sh", "utf8").match(/^detect_node\(\)/gm) || []).length === 1, "update.sh 只定义一次 detect_node，后面的定义不会把版本检查盖掉");
check(nodePick.code === 0 && pickLines[0]?.endsWith("new-node") && pickLines[1] === "2" && pickLines[2]?.includes("old node"), "第一个候选未修复时继续找后面的已修复运行时，全都过期则返回 2");
check(pickLines[3]?.endsWith("new-node") && pickLines[4]?.endsWith("new-node") && pickLines[5] === "QUIET", "不存在的候选会被跳过，已修复的候选不会再去启动后面的运行时");
if (nodePick.code !== 0) {
  console.log(nodePick.stdout);
  console.log(nodePick.stderr);
}

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
const startFn = serverEntry.slice(serverEntry.indexOf("export async function startServer"));
const enforceCall = "enforceNodeRuntimeCve2026111497()";
check(
  startFn.indexOf(enforceCall) > -1 && startFn.indexOf(enforceCall) < startFn.indexOf("server.listen("),
  "服务端在 startServer 里、监听前执行运行时检查",
);
check(serverEntry.indexOf(enforceCall) === serverEntry.lastIndexOf(enforceCall), "导入服务端模块不会在顶层退出");
const mainCjs = readFileSync("electron/main.cjs", "utf8");
check(mainCjs.startsWith("//") && mainCjs.includes('require("./node-runtime-security.cjs").enforceNodeRuntimeCve2026111497()'), "扫描端主进程在加载 Electron 之前执行同一检查");
check(nodeRuntimeCveMessage("24.22.0", "guard") === cjs.nodeRuntimeCveMessage("24.22.0", "guard"), "Electron 提示文案两边一致");
const decodeAt = mainCjs.indexOf("await installChromiumBrotliDecodeBlock(mainWindow.webContents");
const loadAt = mainCjs.indexOf("await mainWindow.loadURL(baseUrl)");
check(decodeAt > 0 && loadAt > decodeAt, "loadURL 之前先限制 Chromium 接受的编码");
const readyBody = mainCjs.slice(mainCjs.indexOf("app.whenReady().then(async () => {"));
const permissionAt = readyBody.indexOf("installDevicePermissionPolicy();");
const headerAt = readyBody.indexOf("installChromiumBrotliHeaderBlock(session.defaultSession");
const createAt = readyBody.indexOf("await createWindow();");
check(permissionAt > -1 && headerAt > permissionAt && createAt > headerAt, "权限策略和 Brotli 响应头拦截都在创建窗口之前");
const pauseAt = readyBody.indexOf("installChromiumBrotliNetworkPause(session.defaultSession");
check(pauseAt > headerAt && pauseAt < createAt, "默认会话在创建窗口前装上重连期间的请求暂停");
check(mainCjs.includes('app.on("session-created"'), "新建 session 同样拦截 br 响应头");
check(mainCjs.includes("installChromiumBrotliNetworkPause(createdSession"), "新建 session 同样在重连期间暂停请求");
check(mainCjs.includes("registerChromiumBrotliProtection") && mainCjs.includes("chromiumBrotliProtectionEnabled()"), "远程模式给之后创建的每个窗口安装解码拦截");
check(mainCjs.includes('app.commandLine.appendSwitch("disable-features", "ServiceWorker")'), "扫描端关掉 service worker，避免它绕开页面级调试通道");
const syntax = await run(process.execPath, ["--check", "electron/main.cjs"]);
check(syntax.code === 0, "electron/main.cjs 语法可解析");
const cjsSyntax = await run(process.execPath, ["--check", "electron/node-runtime-security.cjs"]);
check(cjsSyntax.code === 0, "node-runtime-security.cjs 语法可解析");
const ci = readFileSync(".github/workflows/ci.yml", "utf8");
check(!/node-version:\s*\[22\]/.test(ci) && ci.includes("22.23.4"), "CI 固定到 22.23.4，不再浮动大版本");
check(ci.includes("electron-chromium-brotli") && ci.includes("xvfb-run -a npm run verify:node-runtime-cve"), "CI 另有 Electron 实机作业，ignore-scripts 的主作业不会把 Chromium 检查当成已跑过");

console.log("\n== Chromium 不再接受 br ==");
check(
  cjs.CHROMIUM_ACCEPTED_ENCODINGS.length === 2
    && cjs.CHROMIUM_ACCEPTED_ENCODINGS[0] === "gzip"
    && cjs.CHROMIUM_ACCEPTED_ENCODINGS[1] === "deflate"
    && !cjs.CHROMIUM_ACCEPTED_ENCODINGS.includes("br"),
  "交给 DevTools 的编码列表只有 gzip 和 deflate",
);
check(cjs.acceptEncodingWithoutBrotli("gzip, deflate, br") === "gzip, deflate", "Accept-Encoding 去掉 br 令牌");
check(cjs.acceptEncodingWithoutBrotli("br") === "gzip, deflate", "只声明 br 时退回 gzip, deflate");
check(cjs.acceptEncodingWithoutBrotli("gzip, BR , deflate") === "gzip, deflate", "br 令牌不区分大小写");
check(cjs.acceptEncodingWithoutBrotli("gzip, br;q=1.0, deflate") === "gzip, deflate", "带 q 值的 br 令牌也会去掉");
check(cjs.acceptEncodingWithoutBrotli("br;q=0.5") === "gzip, deflate", "只声明 br;q 时退回 gzip, deflate");
check(cjs.acceptEncodingWithoutBrotli("gzip;q=0.8, br;q=1") === "gzip;q=0.8", "去掉 br 时保留其它编码的 q 值");
check(cjs.acceptEncodingWithoutBrotli("") === "gzip, deflate", "空 Accept-Encoding 退回 gzip, deflate");
check(cjs.responseUsesBrotli({ "Content-Encoding": "br" }), "Content-Encoding: br 判定为 Brotli");
check(cjs.responseUsesBrotli({ "Content-Encoding": "br;q=1" }), "带参数的 br 内容编码也判定为 Brotli");
check(cjs.responseUsesBrotli({ "content-encoding": ["gzip", "br"] }), "多值响应头里的 br 也会被发现");
check(!cjs.responseUsesBrotli({ "Content-Encoding": "gzip" }), "gzip 响应不会被当成 Brotli");
check(!cjs.responseUsesBrotli({ "Content-Encoding": "brotli" }), "只认 br 这个令牌");
check(!cjs.responseUsesBrotli(null) && !cjs.responseUsesBrotli({ "X-Other": "br" }), "没有 Content-Encoding 时不拦截");

type HeaderCallback = (value: { cancel?: boolean; requestHeaders?: Record<string, string> }) => void;
const headerLogs: string[] = [];
let beforeListeners = 0;
let receivedListeners = 0;
const headerSession = {
  webRequest: {
    onBeforeSendHeaders(_filter: unknown, listener: (details: { requestHeaders?: Record<string, string> }, callback: HeaderCallback) => void) {
      beforeListeners += 1;
      (headerSession as { before?: typeof listener }).before = listener;
    },
    onHeadersReceived(_filter: unknown, listener: (details: { url?: string; responseHeaders?: unknown }, callback: HeaderCallback) => void) {
      receivedListeners += 1;
      (headerSession as { received?: typeof listener }).received = listener;
    },
  },
};
cjs.installChromiumBrotliHeaderBlock(headerSession, (_level, message) => { headerLogs.push(message); });
cjs.installChromiumBrotliHeaderBlock(headerSession, () => { headerLogs.push("second"); });
check(beforeListeners === 1 && receivedListeners === 1, "同一个会话重复安装响应头拦截不会叠两层");
let stripped = "";
let stripCancelled = false;
(headerSession as { before: (details: { requestHeaders?: Record<string, string> }, callback: HeaderCallback) => void }).before(
  { requestHeaders: { "Accept-Encoding": "gzip, deflate, br" } },
  (value) => {
    stripped = value.requestHeaders?.["Accept-Encoding"] ?? "";
    stripCancelled = value.cancel === true;
  },
);
check(stripped === "gzip, deflate" && !stripCancelled, "发出请求前去掉已有的 br");
let brCancelled = false;
(headerSession as { received: (details: { url?: string; responseHeaders?: unknown }, callback: HeaderCallback) => void }).received(
  { url: "https://remote.example/app", responseHeaders: { "content-encoding": "br" } },
  (value) => { brCancelled = value.cancel === true; },
);
let gzipCancelled = false;
(headerSession as { received: (details: { url?: string; responseHeaders?: unknown }, callback: HeaderCallback) => void }).received(
  { url: "https://remote.example/app", responseHeaders: { "Content-Encoding": "gzip" } },
  (value) => { gzipCancelled = value.cancel === true; },
);
check(brCancelled && !gzipCancelled && headerLogs.some((line) => line.includes("https://remote.example/app")), "br 响应被取消，gzip 响应继续");

type DebuggerCall = { method: string; params: Record<string, unknown>; sessionId?: string };
function fakeWebContents(options?: { failMethod?: string; failSession?: boolean }) {
  const calls: DebuggerCall[] = [];
  const handlers: Record<string, (event: unknown, method?: string, params?: { sessionId?: string }, sessionId?: string) => void> = {};
  let attached = false;
  let devtoolsOpen = false;
  let stopped = false;
  const webContents = {
    calls,
    stopped: () => stopped,
    devtoolsClosed: () => !devtoolsOpen,
    isDestroyed: () => false,
    isDevToolsOpened: () => devtoolsOpen,
    closeDevTools: () => { devtoolsOpen = false; },
    stop: () => { stopped = true; },
    debugger: {
      isAttached: () => attached,
      attach(version: string) {
        attached = true;
        calls.push({ method: "attach", params: { version } });
      },
      on(event: string, listener: (event: unknown, method?: string, params?: { sessionId?: string }, sessionId?: string) => void) {
        handlers[event] = listener;
      },
      sendCommand(method: string, params: Record<string, unknown>, sessionId?: string) {
        calls.push({ method, params, sessionId });
        if (options?.failMethod === method && (options.failSession ? Boolean(sessionId) : !sessionId)) {
          return Promise.reject(new Error(`rejected ${method}`));
        }
        return Promise.resolve({});
      },
      emit(event: string, method?: string, params?: { sessionId?: string }, sessionId?: string) {
        handlers[event]?.(null, method, params, sessionId);
      },
    },
  };
  devtoolsOpen = true;
  return webContents;
}

const primed = fakeWebContents();
let primedUrl = "";
(primed as { getURL: () => string; loadURL: (url: string) => Promise<void> }).getURL = () => primedUrl;
(primed as { loadURL: (url: string) => Promise<void> }).loadURL = async (url: string) => {
  primedUrl = url;
  primed.calls.push({ method: "loadURL", params: { url } });
};
await cjs.installChromiumBrotliDecodeBlock(primed, () => {});
check(primed.calls[0]?.method === "loadURL" && primed.calls[0]?.params.url === "about:blank" && primed.calls[1]?.method === "attach", "渲染进程还没出现时先打开 about:blank，避免编码命令挂起");
const decoded = fakeWebContents();
await cjs.installChromiumBrotliDecodeBlock(decoded, () => {});
const mainMethods = decoded.calls.map((call) => call.method);
check(
  mainMethods[0] === "attach"
    && mainMethods[1] === "Network.enable"
    && mainMethods[2] === "Network.setAcceptedEncodings"
    && mainMethods[3] === "Target.setAutoAttach"
    && (decoded.calls[0]?.params.version === "1.3")
    && Array.isArray(decoded.calls[2]?.params.encodings)
    && (decoded.calls[2]?.params.encodings as string[]).join(",") === "gzip,deflate"
    && decoded.calls[3]?.params.waitForDebuggerOnStart === true
    && decoded.calls[3]?.params.flatten === true,
  "主框架先 Network.enable，再把可接受编码收成 gzip/deflate，并暂停新子目标",
);
decoded.debugger.emit("message", "Target.attachedToTarget", { sessionId: "child-1" }, "child-1");
await new Promise((resolve) => setImmediate(resolve));
const childCalls = decoded.calls.filter((call) => call.sessionId === "child-1").map((call) => call.method);
check(
  childCalls.join(",") === "Network.enable,Network.setAcceptedEncodings,Target.setAutoAttach,Runtime.runIfWaitingForDebugger",
  "子目标装上同样的编码覆盖之后才恢复执行",
);
const pausedChild = fakeWebContents({ failMethod: "Target.setAutoAttach", failSession: true });
await cjs.installChromiumBrotliDecodeBlock(pausedChild, () => {});
pausedChild.debugger.emit("message", "Target.attachedToTarget", { sessionId: "child-2" }, "child-2");
await new Promise((resolve) => setImmediate(resolve));
const pausedCalls = pausedChild.calls.filter((call) => call.sessionId === "child-2").map((call) => call.method);
check(
  pausedCalls.includes("Network.enable") && !pausedCalls.includes("Runtime.runIfWaitingForDebugger"),
  "子目标覆盖失败时不恢复执行",
);
const broken = fakeWebContents({ failMethod: "Network.setAcceptedEncodings" });
let startupFailed = false;
try {
  await cjs.installChromiumBrotliDecodeBlock(broken, () => {});
} catch (error) {
  startupFailed = error instanceof Error && error.message.includes(CVE_2026_111497) && error.message.includes("不会继续加载页面");
}
check(startupFailed, "主框架装不上编码覆盖时启动失败，页面不会加载");
const detached = fakeWebContents();
let fatalMessage = "";
await cjs.installChromiumBrotliDecodeBlock(detached, () => {}, {
  onFatal(error: unknown) {
    fatalMessage = error instanceof Error ? error.message : String(error);
  },
  maxReattachAttempts: 1,
  reattachDelayMs: 0,
});
detached.id = 41;
check(cjs.isChromiumBrotliDecodeReady(detached) === true, "编码限制装上之后窗口标记为已保护");
const pauseLogs: string[] = [];
let beforeRequest: ((details: { webContentsId?: number; url?: string }, callback: (value: { cancel?: boolean }) => void) => void) | undefined;
const pauseSession = {
  webRequest: {
    onBeforeRequest(_filter: unknown, listener: typeof beforeRequest) {
      beforeRequest = listener;
    },
  },
};
cjs.installChromiumBrotliNetworkPause(pauseSession, (_level, message) => { pauseLogs.push(message); });
cjs.installChromiumBrotliNetworkPause(pauseSession, () => { pauseLogs.push("second"); });
check(pauseLogs.length === 0 && typeof beforeRequest === "function", "同一个会话的请求暂停只装一层");
detached.calls.length = 0;
detached.debugger.sendCommand = () => Promise.reject(new Error("reattach failed"));
detached.debugger.emit("detach", "replaced_with_devtools");
let gapCancelled = false;
beforeRequest?.({ webContentsId: 41, url: "https://remote.example/gap" }, (value) => { gapCancelled = value.cancel === true; });
let otherCancelled = false;
beforeRequest?.({ webContentsId: 99, url: "http://127.0.0.1/other" }, (value) => { otherCancelled = value.cancel === true; });
check(
  fatalMessage === ""
    && detached.stopped()
    && cjs.isChromiumBrotliDecodeReady(detached) === false
    && gapCancelled
    && !otherCancelled,
  "调试通道一断开就停掉加载并取消这个窗口的新请求，其它窗口的本机请求不受影响",
);
await new Promise((resolve) => setTimeout(resolve, 0));
await new Promise((resolve) => setTimeout(resolve, 0));
check(detached.devtoolsClosed() && cjs.isChromiumBrotliDecodeReady(detached) === false && fatalMessage.includes(CVE_2026_111497), "调试通道重试仍失败后才停掉页面，期间不会被重新标成已保护");

const savedServerMode = process.env.PROJECTX_SERVER_MODE;
delete process.env.PROJECTX_SERVER_MODE;
check(cjs.chromiumBrotliProtectionEnabled() === false, "本地模式不在加载前强制挂上 Chromium 调试通道");
const mainContents = { id: 1 };
const auxContents = { id: 2 };
check(cjs.chromiumBrotliFailureScope(mainContents, mainContents) === "window", "本地壳主窗口的拦截失败不退出整个进程");
process.env.PROJECTX_SERVER_MODE = "remote";
check(cjs.chromiumBrotliProtectionEnabled() === true, "remote 模式才在加载前启用 Chromium 解码拦截");
check(cjs.chromiumBrotliFailureScope(mainContents, mainContents) === "process", "远端壳主窗口的拦截失败才退出进程");
check(cjs.chromiumBrotliFailureScope(auxContents, mainContents) === "window", "远端壳的辅助窗口失败只影响这个窗口");
if (savedServerMode === undefined) delete process.env.PROJECTX_SERVER_MODE;
else process.env.PROJECTX_SERVER_MODE = savedServerMode;

const remotePage = fakeWebContents();
remotePage.id = 7;
(remotePage as { getURL: () => string }).getURL = () => "http://127.0.0.1/scanner";
cjs.trackChromiumWebContents(remotePage);
const remoteResult = await Promise.race([
  new Promise<{ cancel?: boolean }>((resolve) => {
    beforeRequest?.({ webContentsId: 7, url: "https://school.example/api/exams" }, resolve);
  }),
  new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("远端请求没等到编码限制")), 1000)),
]);
check(
  remoteResult.cancel !== true
    && remotePage.calls.some((call) => call.method === "Network.setAcceptedEncodings"),
  "本地壳访问非本机地址时，先装上编码限制再放行这次请求",
);
const attachCalls = remotePage.calls.filter((call) => call.method === "attach").length;
let protectedCancelled = false;
beforeRequest?.({ webContentsId: 7, url: "https://school.example/api/next" }, (value) => { protectedCancelled = value.cancel === true; });
check(
  !protectedCancelled && remotePage.calls.filter((call) => call.method === "attach").length === attachCalls,
  "同一个窗口后续的远端请求直接放行，不再重复挂调试通道",
);
let loopbackCancelled = false;
const loopbackPage = fakeWebContents();
loopbackPage.id = 8;
cjs.trackChromiumWebContents(loopbackPage);
beforeRequest?.({ webContentsId: 8, url: "http://127.0.0.2:5174/api/health" }, (value) => { loopbackCancelled = value.cancel === true; });
check(loopbackCancelled === false && !loopbackPage.calls.some((call) => call.method === "attach"), "127.0.0.0/8 的本机请求不挂调试通道");
let mappedCancelled = false;
beforeRequest?.({ webContentsId: 8, url: "http://[::ffff:127.0.0.1]/api/health" }, (value) => { mappedCancelled = value.cancel === true; });
check(mappedCancelled === false && !loopbackPage.calls.some((call) => call.method === "attach"), "IPv4 映射的 127.0.0.1 仍算本机，不挂调试通道");
let unknownCancelled = false;
beforeRequest?.({ webContentsId: 12345, url: "https://school.example/api/unknown" }, (value) => { unknownCancelled = value.cancel === true; });
check(unknownCancelled, "还没登记的窗口不能把远端请求放出去");
const brokenPage = fakeWebContents({ failMethod: "Network.setAcceptedEncodings" });
brokenPage.id = 9;
(brokenPage as { getURL: () => string }).getURL = () => "http://127.0.0.1/scanner";
let fatalContents: unknown = null;
cjs.configureChromiumBrotliRemoteGate({
  onWindowFatal(contents) { fatalContents = contents; },
});
cjs.trackChromiumWebContents(brokenPage);
const brokenResult = await Promise.race([
  new Promise<{ cancel?: boolean }>((resolve) => {
    beforeRequest?.({ webContentsId: 9, url: "https://school.example/api/fail" }, resolve);
  }),
  new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("失败的远端请求没有结束")), 1000)),
]);
check(brokenResult.cancel === true && fatalContents === brokenPage, "编码限制装不上时取消这次远端请求，并把失败交给这个窗口");

const opened = fakeWebContents();
opened.getType = () => "window";
let openedUrl = "";
const openedUrls: string[] = [];
let releaseBlank: (() => void) | undefined;
opened.getURL = () => openedUrl;
opened.loadURL = (next: string) => {
  openedUrl = next;
  openedUrls.push(next);
  if (next === "about:blank") return new Promise<void>((resolve) => { releaseBlank = resolve; });
  return Promise.resolve();
};
const pageHandlers: Record<string, (event: { preventDefault: () => void }, url?: string) => void> = {};
opened.on = (event: string, listener: (event: { preventDefault: () => void }, url?: string) => void) => {
  pageHandlers[event] = listener;
};
const fakeApp: { on: (event: string, listener: (event: unknown, contents: typeof opened) => void) => void; created?: (event: unknown, contents: typeof opened) => void } = {
  on(event, listener) { if (event === "web-contents-created") fakeApp.created = listener; },
};
cjs.registerChromiumBrotliProtection(fakeApp, { log() {}, onFatal() {}, maxReattachAttempts: 1, reattachDelayMs: 0 });
fakeApp.created?.(null, opened);
let prevented = false;
pageHandlers["will-navigate"]?.({ preventDefault() { prevented = true; } }, "http://127.0.0.1/child");
check(prevented && !openedUrls.includes("http://127.0.0.1/child"), "同源新窗口的首次导航会先停住");
releaseBlank?.();
await new Promise((resolve) => setImmediate(resolve));
await new Promise((resolve) => setImmediate(resolve));
check(openedUrls.includes("http://127.0.0.1/child"), "解码限制装上之后才打开新窗口的目标地址");
opened.id = 77;
opened.debugger.emit("detach", "replaced_with_devtools");
let gapNavigationBlocked = false;
pageHandlers["will-navigate"]?.({ preventDefault() { gapNavigationBlocked = true; } }, "http://127.0.0.1/during-gap");
check(
  gapNavigationBlocked
    && !openedUrls.includes("http://127.0.0.1/during-gap")
    && cjs.isChromiumBrotliDecodeReady(opened) === false,
  "通道断开后，即使上一轮导航还留着放行标记，新地址也会先停住",
);
await new Promise((resolve) => setTimeout(resolve, 0));
await new Promise((resolve) => setImmediate(resolve));
check(
  cjs.isChromiumBrotliDecodeReady(opened) === true
    && openedUrls.includes("http://127.0.0.1/during-gap"),
  "编码限制重新装上之后才继续被拦住的导航",
);

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
let endCode = "";
let endText = "";
try {
  const stream = new zlib.BrotliDecompress();
  const chunks = [];
  stream.on("data", (chunk) => chunks.push(chunk));
  stream.end(br);
  endText = Buffer.concat(chunks).toString();
} catch (error) {
  endCode = error && error.code || "";
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
    endCode,
    endText,
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

async function probeGuard(modulePath: string, label: string, command = process.execPath, env: NodeJS.ProcessEnv = {}): Promise<void> {
  const result = await run(command, [probePath, modulePath, "guard"], env);
  let parsed: { syncBlocked?: boolean; endCode?: string; endText?: string; gzipText?: string; brotliRejected?: boolean; garbageRejected?: boolean; acceptEncoding?: string[] } = {};
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    parsed = {};
  }
  const encodings = parsed.acceptEncoding ?? [];
  const advertisedBrotli = encodings.some((value) => value.split(",").some((part) => part.trim() === "br"));
  check(result.code === 0 && parsed.syncBlocked === true, `${label}：brotliDecompressSync 在进入原生解码前被拒绝`);
  check(result.code === 0 && parsed.endCode === "ERR_BROTLI_DISABLED" && parsed.endText !== "hello-brotli", `${label}：new BrotliDecompress().end(chunk) 不会解出原文`);
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
let constructorBlocked = false;
let endText = "";
try {
  const stream = new zlib.BrotliDecompress();
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  stream.end(zlib.brotliCompressSync(Buffer.from("hello benign brotli")));
  endText = Buffer.concat(chunks).toString();
} catch (error) {
  constructorBlocked = (error as NodeJS.ErrnoException).code === "ERR_BROTLI_DISABLED";
}
check(constructorBlocked && endText !== "hello benign brotli", "服务端模块：new BrotliDecompress().end(chunk) 不会解出原文");
check(zlib.gunzipSync(zlib.gzipSync(Buffer.from("gz-ok"))).toString() === "gz-ok", "关掉 Brotli 之后 gzip 同步解码仍可用");

console.log("\n== Electron 里的 Chromium 实机 ==");
const electronPathFile = path.resolve("node_modules/electron/path.txt");
let electronBinary = "";
if (existsSync(electronPathFile)) {
  try {
    electronBinary = require("electron") as string;
  } catch {
    electronBinary = "";
  }
}
if (!electronBinary || !existsSync(electronBinary)) {
  console.log("  - 当前环境没有 Electron 二进制，跳过 Chromium 实机检查（CI 使用 npm install --ignore-scripts）");
} else {
  await probeGuard(path.resolve("electron/node-runtime-security.cjs"), "Electron 自带 Node", electronBinary, { ELECTRON_RUN_AS_NODE: "1" });
  const xvfb = spawnSync("sh", ["-c", "command -v xvfb-run"], { encoding: "utf8" });
  const xvfbBin = xvfb.status === 0 ? xvfb.stdout.trim() : "";
  const probeScript = path.resolve("scripts/verify-chromium-brotli-block.cjs");
  const electronArgs = ["--no-sandbox", "--disable-gpu", probeScript];
  const probe = await run(
    xvfbBin || electronBinary,
    xvfbBin ? ["-a", electronBinary, ...electronArgs] : electronArgs,
    {},
    60000,
  );
  const line = probe.stdout.split(/\r?\n/).find((item) => item.startsWith("CHROMIUM_BROTLI_BLOCK "));
  let payload: {
    error?: string;
    gone?: { reason?: string } | null;
    control?: { title?: string; acceptEncodingHasBr?: boolean };
    document?: { error?: string; title?: string; requests?: number; acceptEncodingHasBr?: boolean; acceptEncodingHasGzip?: boolean; code?: number | null };
    gzipTitle?: string;
    child?: { code?: number | null; requests?: number; acceptEncodingHasBr?: boolean } | null;
    iframe?: { title?: string; code?: number | null; requests?: number; acceptEncodingHasBr?: boolean };
    worker?: { text?: string; error?: string; timeout?: boolean } | null;
    workerRequest?: { requests?: number; acceptEncodingHasBr?: boolean };
    serviceWorker?: string;
  } = {};
  try {
    payload = JSON.parse(line?.slice("CHROMIUM_BROTLI_BLOCK ".length) || "{}");
  } catch {
    payload = {};
  }
  const workerText = payload.worker?.text ?? "";
  const liveOk = probe.code === 0
    && !payload.error
    && payload.control?.title === "decoded-br"
    && payload.control?.acceptEncodingHasBr === true
    && (payload.document?.requests ?? 0) > 0
    && payload.document?.code === -330
    && payload.document?.title !== "decoded-br"
    && payload.document?.acceptEncodingHasBr === false
    && payload.document?.acceptEncodingHasGzip === true
    && payload.gzipTitle === "gzip-ok"
    && (payload.child?.requests ?? 0) > 0
    && payload.child?.code === -330
    && payload.child?.acceptEncodingHasBr === false
    && payload.iframe?.title !== "decoded-iframe"
    && payload.iframe?.code === -330
    && payload.iframe?.acceptEncodingHasBr === false
    && (payload.workerRequest?.requests ?? 0) > 0
    && payload.workerRequest?.acceptEncodingHasBr === false
    && workerText !== "hello-br"
    && payload.worker?.timeout !== true
    && (payload.serviceWorker === "missing" || payload.serviceWorker === "blocked")
    && !payload.gone;
  check(liveOk, "未装拦截时 br 能解开；装上 CDP 后文档、新窗口、iframe、Worker 都解不开，且这些请求不再声明 br");
  if (!liveOk) {
    console.log(probe.stdout);
    console.log(probe.stderr);
  }
}

rmSync(tempDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
