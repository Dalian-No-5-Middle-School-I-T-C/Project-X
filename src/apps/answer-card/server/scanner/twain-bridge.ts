import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { rootDir } from "../storage";
import type { BridgeScanResult, ScannerSourcesResult } from "./scanner-types";

// 进行中的扫描子进程注册表：sessionId → scanner-bridge.exe 子进程，
// 供取消接口终止扫描（M4b：不再只关 SSE，真正杀进程）
const activeScans = new Map<string, ReturnType<typeof spawn>>();

// 已请求取消的会话集合：取消可能早于子进程注册到达（POST 202 后立即取消），
// 子进程尚未注册时无法杀进程，靠此集合在 runBridge spawn 前拦截启动
const cancelRequested = new Set<string>();

/** 取消指定会话的扫描：记录取消意图 + 杀主进程，2 秒后若仍存活用 taskkill /F /T 强杀进程树。
 *  返回是否找到并终止了正在运行的子进程（未注册的由 cancelRequested 拦截）。 */
export function cancelScan(sessionId: string): boolean {
  cancelRequested.add(sessionId);

  const child = activeScans.get(sessionId);
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return false; // 子进程尚未注册或已退出，交由 runBridge 的取消检查拦截
  }

  child.kill(); // Windows 下 SIGTERM → TerminateProcess

  const pid = child.pid;
  setTimeout(() => {
    if (child.exitCode === null && pid) {
      execFile("taskkill", ["/F", "/T", "/PID", String(pid)], { windowsHide: true }, () => {
        // 强杀结果不阻塞调用方；失败时进程也会被 10 分钟超时兜底
      });
    }
  }, 2000).unref();
  return true;
}

function processResourcesPath(): string | undefined {
  return (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
}

function nativeResourceDir(): string {
  return process.arch === "ia32" ? "win-ia32" : "win-x64";
}

function nativeBuildPlatform(): string {
  return process.arch === "ia32" ? "Win32" : "x64";
}

export function resolveScannerBridgeExe(): string {
  const configured = process.env.SCANNER_BRIDGE_EXE;
  const resourcesPath = processResourcesPath();
  const resourceDir = nativeResourceDir();
  const buildPlatform = nativeBuildPlatform();
  const candidates = [
    configured,
    resourcesPath ? path.join(resourcesPath, "native", resourceDir, "scanner-bridge.exe") : undefined,
    path.join(rootDir, "resources", "native", resourceDir, "scanner-bridge.exe"),
    path.join(rootDir, "native", "ScannerBridge", "scanner-bridge", buildPlatform, "Release", "scanner-bridge.exe"),
    path.join(rootDir, "native", "ScannerBridge", "scanner-bridge", buildPlatform, "Debug", "scanner-bridge.exe")
  ].filter((item): item is string => Boolean(item));

  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`未找到扫描仪桥接程序，已检查路径：${candidates.join("; ")}`);
  }
  return found;
}

function runBridge(args: string[], timeoutMs = 120_000, sessionId?: string): Promise<{ stdout: string; stderr: string }> {
  const exePath = resolveScannerBridgeExe();

  // 取消检查：用户已请求取消（可能早于本函数执行），直接拒绝启动扫描
  if (sessionId && cancelRequested.has(sessionId)) {
    return Promise.reject(new Error("扫描已取消"));
  }

  return new Promise((resolve, reject) => {
    const child = spawn(exePath, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    if (sessionId) {
      activeScans.set(sessionId, child);
      // 子进程已注册，后续取消走杀进程路径，清除待启动拦截标志
      cancelRequested.delete(sessionId);
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.on("error", (error) => {
      clearTimeout(timeout);
      if (sessionId) {
        activeScans.delete(sessionId);
      }
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (sessionId) {
        activeScans.delete(sessionId);
      }
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();

      if (timedOut) {
        reject(new Error(`扫描仪桥接程序超时（${timeoutMs}ms）`));
        return;
      }

      if (code !== 0 && !stdout.trim()) {
        reject(new Error(describeBridgeFailure(code, stderr)));
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

function parseBridgeJson(stdout: string): Record<string, unknown> {
  const text = stdout.trim();
  if (!text) throw new Error("扫描仪桥接程序返回空数据");
  return JSON.parse(text) as Record<string, unknown>;
}

/** 把桥接进程的常见 Windows 退出码翻译成可操作的中文提示（探测/扫描共用）。 */
export function describeBridgeFailure(code: number | null, stderr: string): string {
  if (code === null || code === undefined) {
    return `扫描仪桥接程序被异常终止${stderr ? `：${stderr}` : ""}`;
  }
  const unsigned = code >>> 0;
  // 0xC0000135 STATUS_DLL_NOT_FOUND：目标机缺 VC++ 运行库（vcruntime140/msvcp140 的对应位数版本）
  if (unsigned === 0xc0000135) {
    return "扫描桥接程序无法启动：系统缺少 VC++ 运行库（vcruntime140.dll / msvcp140.dll）。" +
      "请安装 Visual C++ 2015-2022 可再发行程序包（32 位系统装 x86 版）后重试；" +
      "在此之前可先用「导入阅卷」导入图片完成判分。";
  }
  // 0xC0000005 ACCESS_VIOLATION：多为 TWAIN 驱动与 32 位进程不兼容或驱动损坏
  if (unsigned === 0xc0000005) {
    return "扫描桥接程序在访问 TWAIN 设备时崩溃（常见原因：扫描仪驱动与 32 位进程不兼容或驱动损坏）。" +
      "请重装/更新扫描仪驱动后重试，期间可用「导入阅卷」方式导入已扫好的图片判分。";
  }
  return `扫描仪桥接程序退出，错误码：${code}${stderr ? `，错误信息：${stderr}` : ""}`;
}

export async function listSources(): Promise<ScannerSourcesResult> {
  const { stdout } = await runBridge(["list"], 15_000);
  return parseBridgeJson(stdout) as unknown as ScannerSourcesResult;
}

export async function scan(config: {
  sourceName: string;
  dpi: number;
  duplex: boolean;
  colorMode: string;
  paperSize: string;
  outputDir: string;
  filePrefix: string;
  maxPages: number;
  showUi?: boolean;
}, sessionId?: string): Promise<BridgeScanResult> {
  const args: string[] = [
    "scan",
    "--source", config.sourceName,
    "--dpi", String(config.dpi),
    "--mode", config.colorMode,
    "--size", config.paperSize,
    "--output", config.outputDir,
    "--prefix", config.filePrefix,
    "--max-pages", String(config.maxPages)   // 0 = 不限（native 侧 maxPages>0 才限制）
  ];

  if (config.duplex) {
    args.push("--duplex");
  }

  if (config.showUi) {
    args.push("--show-ui");
  }

  const { stdout } = await runBridge(args, 600_000, sessionId); // 10 min timeout for scanning
  return parseBridgeJson(stdout) as unknown as BridgeScanResult;
}
