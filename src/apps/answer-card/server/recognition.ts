import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { rootDir } from "./storage";

export type RecognitionRequest = {
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

export async function recognizeObjectiveAnswers(request: RecognitionRequest): Promise<RecognitionResult> {
  const exePath = resolveRecognizerExe();
  const args = [
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
  if (request.cropsDir) {
    args.push("--crops-dir", request.cropsDir);
  }

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

export async function recognizeAnswerCard(request: RecognitionRequest): Promise<RecognitionResult> {
  const exePath = resolveRecognizerExe();
  const args = [
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
  if (request.cropsDir) {
    args.push("--crops-dir", request.cropsDir);
  }

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

