import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { rootDir } from "./storage";
import { readFile } from "node:fs/promises";
import { parseIdentityMode, type CardIdentity, type IdentityMode } from "../../../shared/cardIdentity";

export type RecognitionRequest = {
  identityMode?: IdentityMode;
  imagePath: string;
  layoutPath: string;
  pageNumber: number;
  dpi: number;
  debugDir?: string;
  cropsDir?: string;
};

export type RecognitionResult = Record<string, unknown>;

function processResourcesPath(): string | undefined {
  return (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
}

function nativeResourceDir(): string {
  return process.arch === "ia32" ? "win-ia32" : "win-x64";
}

function nativeBuildPlatform(): string {
  return process.arch === "ia32" ? "Win32" : "x64";
}

export function resolveRecognizerExe(): string {
  const configured = process.env.ANSWER_CARD_RECOGNIZER_EXE;
  const resourcesPath = processResourcesPath();
  const resourceDir = nativeResourceDir();
  const buildPlatform = nativeBuildPlatform();
  const candidates = [
    configured,
    resourcesPath ? path.join(resourcesPath, "native", resourceDir, "answer-card-recognizer.exe") : undefined,
    path.join(rootDir, "resources", "native", resourceDir, "answer-card-recognizer.exe"),
    path.join(rootDir, "native", "AnswerCardRecognizer", buildPlatform, "Release", "answer-card-recognizer.exe"),
    path.join(rootDir, "native", "AnswerCardRecognizer", buildPlatform, "Debug", "answer-card-recognizer.exe")
  ].filter((item): item is string => Boolean(item));

  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`Native recognizer executable not found. Checked: ${candidates.join("; ")}`);
  }
  return found;
}

function parseRecognizerOutput(stdout: string): RecognitionResult | null {
  const text = stdout.trim();
  if (!text) return null;
  return JSON.parse(text) as RecognitionResult;
}

/**
 * Windows NTSTATUS 退出码 → 可操作的中文诊断。
 *
 * 识别器是 /MD 动态 CRT 的原生 exe，加载期若缺少运行库依赖会直接以 NTSTATUS
 * 退出（进程根本没跑起来，因此 stderr 必然为空）。旧实现只报裸码
 * 「Native recognizer exited with code 3221225794」，现场无从下手；此处翻译成
 * 带处置建议的文案。十进制码对照：0xC0000000 + 低位。
 */
function describeRecognizerExitCode(code: number | null): string | null {
  if (code === null) return null;
  // 有些环境回传的是无符号十进制，先归一到 32 位无符号语义再比对
  const unsigned = code >>> 0;
  const table: Record<number, string> = {
    0xc0000135: // STATUS_DLL_NOT_FOUND
      "缺少 VC++ 运行库：识别器依赖的 msvcp140/vcruntime140 等 DLL 未找到，" +
      "且 opencv_world4130.dll 的依赖也未满足。请确认 resources/native/<arch>/ 下的运行库随包分发完整。",
    0xc0000142: // STATUS_DLL_INIT_FAILED
      "运行库初始化失败（STATUS_DLL_INIT_FAILED，0xC0000142）：识别器或其依赖的 DLL 在加载期初始化失败，" +
      "通常是运行库版本不匹配或环境不完整（常见于扫描端未正确打包 UCRT/VC++ 运行库、或系统过旧）。" +
      "请重新安装扫描端安装包（务必包含 resources/native 下的运行库），必要时在目标机安装 VC++ 运行库后重试。",
    0xc000007b: // STATUS_INVALID_IMAGE_FORMAT
      "位宽或格式不匹配（0xC000007B）：识别器与扫描端进程位宽不一致（例如 ia32 包内混入 x64 组件），" +
      "请确认安装包与扫描仪驱动位宽一致。",
  };
  return table[unsigned] ?? null;
}

function buildBaseArgs(request: RecognitionRequest): string[] {
  const args = [
    "--identity-mode", parseIdentityMode(request.identityMode),
    "--image",
    request.imagePath,
    "--layout",
    request.layoutPath,
    "--page",
    String(request.pageNumber),
    "--dpi",
    String(request.dpi)
  ];
  if (request.debugDir) {
    args.push("--debug-dir", request.debugDir);
  }
  return args;
}

function isCropsDirUnsupportedError(result: RecognitionResult | null, errorMessage: string): boolean {
  const msg = (result as any)?.message ?? errorMessage ?? "";
  return typeof msg === "string" && msg.includes("Unknown argument: --crops-dir");
}

function execRecognizer(exePath: string, args: string[]): Promise<RecognitionResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(exePath, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 30_000);

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      if (timedOut) {
        reject(new Error("Native recognizer timed out after 30000ms."));
        return;
      }

      try {
        const parsed = parseRecognizerOutput(stdout);
        if (parsed) {
          resolve(parsed);
          return;
        }
      } catch (error) {
        reject(new Error(`Native recognizer returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }

      // 加载期失败（缺运行库/位宽不符）不会有 stderr，优先给可操作的中文诊断
      const diagnosis = describeRecognizerExitCode(code);
      if (diagnosis) {
        reject(new Error(`Native recognizer exited with code ${code ?? "unknown"}: ${diagnosis}`));
        return;
      }

      reject(new Error(`Native recognizer exited with code ${code ?? "unknown"}${stderr ? `: ${stderr}` : ""}`));
    });
  });
}

async function runWithCropsFallback(request: RecognitionRequest, exePath: string, baseArgs: string[]): Promise<RecognitionResult> {
  if (!request.cropsDir) {
    return execRecognizer(exePath, baseArgs);
  }
  const argsWithCrops = [...baseArgs, "--crops-dir", request.cropsDir];
  try {
    const result = await execRecognizer(exePath, argsWithCrops);
    if (isCropsDirUnsupportedError(result, "")) {
      console.warn("[recognizer] old exe does not support --crops-dir, retrying without it");
      // 五轮D1：降级后切块必然为空，明示提示（配合 persistAnswerBlockCrops 的 empty 日志）
      console.warn("[recognizer] crops-dir 不受支持：本次识别不会产出大题切块（网阅队列将为空）");
      return execRecognizer(exePath, baseArgs);
    }
    return result;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("Unknown argument: --crops-dir") || msg.includes("--crops-dir")) {
      console.warn("[recognizer] old exe fallback without --crops-dir after error:", msg);
      console.warn("[recognizer] crops-dir 不受支持：本次识别不会产出大题切块（网阅队列将为空）");
      return execRecognizer(exePath, baseArgs);
    }
    throw error;
  }
}

export async function recognizeObjectiveAnswers(request: RecognitionRequest): Promise<RecognitionResult> {
  const exePath = resolveRecognizerExe();
  const baseArgs = buildBaseArgs(request);
  return validateIdentity(await runWithCropsFallback(request, exePath, baseArgs), request);
}

export async function recognizeAnswerCard(request: RecognitionRequest): Promise<RecognitionResult> {
  const exePath = resolveRecognizerExe();
  const baseArgs = buildBaseArgs(request);
  return validateIdentity(await runWithCropsFallback(request, exePath, baseArgs), request);
}

export class CardIdentityError extends Error {
  readonly status = 422;
  constructor(message: string, readonly code = "CARD_IDENTITY_REJECTED") { super(message); }
}

/** Enforce the native contract before any caller can grade, inherit IDs, or save crops. */
export async function validateIdentity(result: RecognitionResult, request: RecognitionRequest): Promise<RecognitionResult> {
  const identity = result.identity as CardIdentity | undefined;
  if (!identity) {
    const message = String(result.message ?? "");
    if (result.status === "failed" && !message.includes("Unknown argument") && !message.includes("identity")) {
      throw new Error(message || "答题卡识别失败");
    }
    throw new CardIdentityError("识别器不支持二维码身份校验，请升级 Windows 扫描端原生识别器", "RECOGNIZER_UPGRADE_REQUIRED");
  }
  const layout = JSON.parse(await readFile(request.layoutPath, "utf8")) as { cardId: string };
  if (identity.status === "verified" && identity.cardId === layout.cardId && identity.pageNumber === request.pageNumber) return result;
  if (identity.status === "unverified" && request.identityMode === "legacy"
    && ["QR_MISSING", "QR_UNREADABLE"].includes(identity.code)) {
    if (result.status !== "failed") result.message = "未校验卡 ID（兼容旧卡模式）";
    return result;
  }
  const reasons: Record<string, string> = {
    QR_MISSING: "未找到二维码", QR_UNREADABLE: "二维码无法读取", QR_INVALID: "二维码协议或内容无效",
    QR_CONFLICT: "检测到多个不同二维码", CARD_MISMATCH: "答题卡 ID 不匹配", PAGE_MISMATCH: "答题卡页码不匹配",
  };
  throw new CardIdentityError(`${reasons[identity.code] ?? "二维码身份校验失败"}；预期 ${layout.cardId} 第 ${request.pageNumber} 页，实际 ${identity.cardId ?? "未知"} 第 ${identity.pageNumber ?? "未知"} 页`);
}
