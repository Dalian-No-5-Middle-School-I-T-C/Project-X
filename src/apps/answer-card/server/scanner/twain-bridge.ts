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

/** runBridge 失败时携带的桥接进程信息，供上层给出可定位的结论 */
export interface BridgeFailure extends Error {
  bridgeExitCode?: number | null;
  bridgeStderr?: string;
  bridgeStdout?: string;
}

function bridgeFailure(message: string, fields: Omit<BridgeFailure, keyof Error>): BridgeFailure {
  return Object.assign(new Error(message), fields);
}

function runBridge(args: string[], timeoutMs = 120_000, sessionId?: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
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
      // spawn 级失败：exe 不存在、无权执行等。0xC0000135/0xC000007B 这类
      // DLL 加载失败会在 close 事件里以退出码形式出现，不走这里。
      reject(bridgeFailure(`无法启动扫描桥接程序（${error.message}）`, {
        bridgeExitCode: null,
        bridgeStderr: Buffer.concat(stderrChunks).toString("utf8").trim()
      }));
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (sessionId) {
        activeScans.delete(sessionId);
      }
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();

      if (timedOut) {
        reject(bridgeFailure(`扫描仪桥接程序超时（${timeoutMs}ms）`, {
          bridgeExitCode: code,
          bridgeStderr: stderr,
          bridgeStdout: stdout
        }));
        return;
      }

      if (code !== 0 && !stdout.trim()) {
        reject(bridgeFailure(describeBridgeFailure(code, stderr), {
          bridgeExitCode: code,
          bridgeStderr: stderr,
          bridgeStdout: stdout
        }));
        return;
      }

      // 注意：非零退出码但 stdout 有内容属于正常路径——native 的 list/scan 在
      // 「没有可用数据源」时也会输出结构化 JSON 并返回 1，stderr 里的细节由调用方取用。
      resolve({ stdout, stderr, code });
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
  // 0xC0000135 STATUS_DLL_NOT_FOUND：进程启动时未能解析到某个依赖 DLL。
  // v2.5.6：2.5.5 起运行库已随包分发，故"缺少 VC++ 运行库"不再是唯一解释——
  // 现场实测 DLL 齐全却仍报此码时，多为安装不完整或文件被安全软件隔离。
  // 文案改为并列可能原因，不再一口断定缺运行库（避免误导排查方向）。
  if (unsigned === 0xc0000135) {
    return "扫描桥接程序无法启动（0xC0000135：加载依赖 DLL 失败）。" +
      "v2.5.5 起运行库已随包分发，因此通常是安装不完整或文件被安全软件隔离：" +
      "请确认安装目录 resources/native/" + nativeResourceDir() +
      " 下存在 msvcp140.dll / vcruntime140.dll / concrt140.dll，并把安装目录加入安全软件白名单；" +
      "该错误由 Windows 报告，并不表示扫描仪或驱动有问题。";
  }
  // 0xC000007B STATUS_INVALID_IMAGE_FORMAT：位宽不匹配或 DLL 损坏
  if (unsigned === 0xc000007b) {
    return "扫描桥接程序无法加载（映像格式无效，通常为 32/64 位不匹配）。" +
      "请确认当前安装包位数与扫描仪驱动位数一致：老旧扫描仪多为 32 位驱动，需使用 ia32 版扫描端。";
  }
  // 0xC0000142 STATUS_DLL_INIT_FAILED：DLL 初始化失败（运行库被安全软件拦截或版本冲突）
  if (unsigned === 0xc0000142) {
    return "扫描桥接程序启动失败（DLL 初始化失败）。" +
      "常见原因是安全软件拦截了安装目录下的运行库，或将安装目录放入了受限路径。请调整后重试。";
  }
  // 0xC0000005 ACCESS_VIOLATION：多为 TWAIN 驱动与 32 位进程不兼容或驱动损坏
  if (unsigned === 0xc0000005) {
    return "扫描桥接程序在访问 TWAIN 设备时崩溃（常见原因：扫描仪驱动与 32 位进程不兼容或驱动损坏）。" +
      "请重装/更新扫描仪驱动后重试，期间可用「导入阅卷」方式导入已扫好的图片判分。";
  }
  return `扫描仪桥接程序退出，错误码：${code}${stderr ? `，错误信息：${stderr}` : ""}`;
}

/** 当前扫描端进程位宽对应的原生资源目录名（与 nativeResourceDir 一致的对外可读形式）。 */
function runtimeArch(): string {
  return process.arch === "ia32" ? "ia32" : process.arch === "x64" ? "x64" : process.arch;
}

/** 位宽不匹配是「检测不到扫描仪」的高频根因，且从现象上无法与「没接设备」区分，故显式提示。 */
export function archMismatchHint(): string {
  if (process.arch === "ia32") {
    return "当前为 32 位扫描端，只能枚举 32 位 TWAIN 驱动；若该扫描仪仅提供 64 位驱动，请改用 x64 版扫描端。";
  }
  if (process.arch === "x64") {
    return "当前为 64 位扫描端，只能枚举 64 位 TWAIN 驱动；老旧扫描仪多为 32 位驱动，此时请改用 ia32 版扫描端。";
  }
  return "";
}

const FALLBACK_SOURCES_MESSAGE: Record<string, string> = {
  DSM_LOAD_FAILED: "无法加载 TWAIN 数据源管理器（TWAINDSM.dll）",
  OPENDSM_FAILED: "TWAIN 数据源管理器打开失败",
  WINDOW_CREATE_FAILED: "扫描桥接程序无法创建 TWAIN 宿主窗口",
  NO_SOURCES: "未枚举到任何扫描仪驱动",
  BRIDGE_EXIT_NONZERO: "扫描桥接程序异常退出",
  BRIDGE_NO_OUTPUT: "扫描桥接程序未返回可解析的结果",
  BRIDGE_MISSING: "未找到扫描桥接程序",
  UNKNOWN: "扫描仪检测失败"
};

/**
 * 从桥接输出反推根因。新版 exe 直接给出 `code`；旧版 exe 只有字段缺失的 JSON，
 * 用 stderr 关键字与退出码兜底推断——保证不重编译 exe 也能拿到可定位的结论。
 */
function deriveSourcesCode(
  payload: Record<string, unknown>,
  stderr: string,
  exitCode: number | null
): string {
  const explicit = payload.code;
  if (typeof explicit === "string" && explicit) return explicit;

  const log = `${stderr}\n${typeof payload.message === "string" ? payload.message : ""}`;
  if (/OPENDSM/i.test(log) || /ConditionCode/i.test(log)) return "OPENDSM_FAILED";
  if (/TWAINDSM|twain_32|LoadLibrary|DSM/i.test(log) && /fail|无法|失败|缺少|错误|error/i.test(log)) {
    return "DSM_LOAD_FAILED";
  }
  if (Array.isArray(payload.sources) && payload.sources.length > 0) return "OK";
  if (exitCode !== null && exitCode !== 0) return "BRIDGE_EXIT_NONZERO";
  return "NO_SOURCES";
}

export async function listSources(): Promise<ScannerSourcesResult> {
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;

  try {
    const outcome = await runBridge(["list"], 15_000);
    stdout = outcome.stdout;
    stderr = outcome.stderr;
    exitCode = outcome.code;
  } catch (error) {
    // 桥接程序压根起不来（exe 缺失 / 缺运行库 / 位宽错误）：describeBridgeFailure 已给出中文原因
    const failure = error as BridgeFailure;
    const startedButExited = failure.bridgeExitCode !== undefined && failure.bridgeExitCode !== null;
    const code = startedButExited ? "BRIDGE_EXIT_NONZERO" : "BRIDGE_MISSING";
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "error",
      sources: [],
      code,
      message,
      hint: startedButExited
        ? "桥接程序已启动但立即退出，通常是运行库缺失或位数不匹配；详见下方原始输出。"
        : "请确认安装包完整（resources/native 目录存在）后重新安装。",
      arch: runtimeArch(),
      exitCode: failure.bridgeExitCode ?? null,
      bridgeStderr: failure.bridgeStderr
    };
  }

  let payload: Record<string, unknown>;
  try {
    payload = parseBridgeJson(stdout);
  } catch (error) {
    return {
      status: "error",
      sources: [],
      code: "BRIDGE_NO_OUTPUT",
      message: `${FALLBACK_SOURCES_MESSAGE.BRIDGE_NO_OUTPUT}：${error instanceof Error ? error.message : String(error)}`,
      hint: "这通常意味着安装的扫描端与本机不兼容（位数或运行库）。请附上下方原始输出以便定位。",
      arch: runtimeArch(),
      exitCode,
      bridgeStderr: stderr
    };
  }

  const code = deriveSourcesCode(payload, stderr, exitCode);
  const rawSources = Array.isArray(payload.sources) ? payload.sources : [];
  const sources = rawSources
    .map((item) => (item && typeof item === "object" && typeof (item as { name?: unknown }).name === "string"
      ? { name: (item as { name: string }).name }
      : null))
    .filter((item): item is { name: string } => item !== null && item.name.length > 0);

  const ok = code === "OK" && sources.length > 0;

  return {
    status: ok ? "ok" : "error",
    sources,
    code: code as ScannerSourcesResult["code"],
    message: ok
      ? undefined
      : (typeof payload.message === "string" && payload.message) || FALLBACK_SOURCES_MESSAGE[code] || FALLBACK_SOURCES_MESSAGE.UNKNOWN,
    hint: ok ? undefined : (typeof payload.hint === "string" && payload.hint) || archMismatchHint(),
    arch: typeof payload.arch === "string" ? payload.arch : runtimeArch(),
    dsmLoaded: typeof payload.dsm_loaded === "boolean" ? payload.dsm_loaded : undefined,
    dsmPath: typeof payload.dsm_path === "string" ? payload.dsm_path : undefined,
    dsmSearch: typeof payload.dsm_search === "string" ? payload.dsm_search : undefined,
    openDsmRc: typeof payload.open_dsm_rc === "number" ? payload.open_dsm_rc : undefined,
    conditionCode: typeof payload.condition_code === "number" ? payload.condition_code : undefined,
    windowCreated: typeof payload.window_created === "boolean" ? payload.window_created : undefined,
    bridgeStderr: stderr || undefined,
    exitCode
  };
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
  /** 等下一页(ADF 送纸)的空闲超时,默认 15000ms,native 侧兜底 */
  pageTimeoutMs?: number;
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

  if (config.pageTimeoutMs && config.pageTimeoutMs > 0) {
    args.push("--page-timeout-ms", String(config.pageTimeoutMs));
  }

  if (config.duplex) {
    args.push("--duplex");
  }

  if (config.showUi) {
    args.push("--show-ui");
  }

  const { stdout } = await runBridge(args, 600_000, sessionId); // 10 min timeout for scanning
  return parseBridgeJson(stdout) as unknown as BridgeScanResult;
}
