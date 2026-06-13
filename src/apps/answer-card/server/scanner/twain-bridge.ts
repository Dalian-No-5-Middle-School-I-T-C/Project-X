import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { rootDir } from "../storage";
import type { BridgeScanResult, ScannerSourcesResult } from "./scanner-types";

function processResourcesPath(): string | undefined {
  return (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
}

export function resolveScannerBridgeExe(): string {
  const configured = process.env.SCANNER_BRIDGE_EXE;
  const resourcesPath = processResourcesPath();
  const candidates = [
    configured,
    resourcesPath ? path.join(resourcesPath, "native", "win-x64", "scanner-bridge.exe") : undefined,
    path.join(rootDir, "resources", "native", "win-x64", "scanner-bridge.exe"),
    path.join(rootDir, "native", "ScannerBridge", "scanner-bridge", "x64", "Release", "scanner-bridge.exe"),
    path.join(rootDir, "native", "ScannerBridge", "scanner-bridge", "x64", "Debug", "scanner-bridge.exe")
  ].filter((item): item is string => Boolean(item));

  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`未找到扫描仪桥接程序，已检查路径：${candidates.join("; ")}`);
  }
  return found;
}

function runBridge(args: string[], timeoutMs = 120_000): Promise<{ stdout: string; stderr: string }> {
  const exePath = resolveScannerBridgeExe();

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
    }, timeoutMs);

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
        reject(new Error(`扫描仪桥接程序超时（${timeoutMs}ms）`));
        return;
      }

      if (code !== 0 && !stdout.trim()) {
        reject(new Error(`扫描仪桥接程序退出，错误码：${code}${stderr ? `，错误信息：${stderr}` : ""}`));
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
}): Promise<BridgeScanResult> {
  const args: string[] = [
    "scan",
    "--source", config.sourceName,
    "--dpi", String(config.dpi),
    "--mode", config.colorMode,
    "--size", config.paperSize,
    "--output", config.outputDir,
    "--prefix", config.filePrefix,
    "--max-pages", String(config.maxPages || 9999)
  ];

  if (config.duplex) {
    args.push("--duplex");
  }

  const { stdout } = await runBridge(args, 600_000); // 10 min timeout for scanning
  return parseBridgeJson(stdout) as unknown as BridgeScanResult;
}
