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
