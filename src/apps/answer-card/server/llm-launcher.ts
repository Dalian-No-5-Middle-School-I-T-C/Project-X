/**
 * llmclient sidecar auto-launcher.
 *
 * The Node backend never talks to LLM providers directly — every AI call
 * (成绩分析 / 原卷知识点 / 学生 AI 建议) is forwarded to the Python FastAPI
 * service `llmclient` (default http://127.0.0.1:8766). To spare operators from
 * manually starting it, this module auto-spawns the sidecar when the Node
 * server boots, and (lazily) re-spawns it on first AI request if it happens to
 * be down.
 *
 * Config (env):
 *   LLMCLIENT_AUTOSTART  "false"|"0" disables auto-start (default: enabled)
 *   LLMCLIENT_PYTHON     python interpreter to use (default: "py" on win, "python3" elsewhere)
 *   LLMCLIENT_URL        where the Node side connects / where we spawn it
 *                        (default http://127.0.0.1:8766)
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rawAutostart = (process.env.LLMCLIENT_AUTOSTART ?? "true").toLowerCase();
const AUTOSTART_ENABLED = rawAutostart !== "false" && rawAutostart !== "0";

let child: ChildProcess | null = null;
let startPromise: Promise<boolean> | null = null;

function llmClientBaseUrl(): string {
  const base = (process.env.LLMCLIENT_URL || "http://127.0.0.1:8766").replace(/\/+$/, "");
  return base.startsWith("http") ? base : `http://${base}`;
}

function repoRoot(): string {
  const candidates = [
    path.resolve(__dirname, "../../../../.."),
    process.cwd(),
  ];
  for (const c of candidates) {
    if (existsSync(path.join(c, "llmclient", "server.py"))) return c;
  }
  return process.cwd();
}

/** Candidate Python interpreters, in priority order. */
function pythonCandidates(): string[] {
  if (process.env.LLMCLIENT_PYTHON) return [process.env.LLMCLIENT_PYTHON];
  return process.platform === "win32"
    ? ["py", "python", "python3"]
    : ["python3", "python", "py"];
}

/** Returns the first candidate that actually runs (skips ENOENT ones). */
function resolvePython(): string | null {
  for (const cmd of pythonCandidates()) {
    try {
      const r = spawnSync(cmd, ["-c", "import sys; sys.exit(0)"], { encoding: "utf8", timeout: 5000 });
      if (!r.error && r.status === 0) return cmd;
    } catch {
      /* try next */
    }
  }
  return null;
}

function targetHostPort(): { host: string; port: string } {
  try {
    const u = new URL(llmClientBaseUrl());
    return { host: u.hostname || "127.0.0.1", port: u.port || "8766" };
  } catch {
    return { host: "127.0.0.1", port: "8766" };
  }
}

async function ping(timeoutMs = 2000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${llmClientBaseUrl()}/health`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForHealth(maxWaitMs: number): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (child && child.killed) return false;
    if (await ping()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function spawnInternal(): ChildProcess | null {
  const root = repoRoot();
  const py = resolvePython();
  if (!py) {
    console.warn("[llmclient] no Python interpreter found (tried: " +
      pythonCandidates().join(", ") +
      "). AI features will be unavailable until the Python llmclient is started manually. " +
      "Set LLMCLIENT_PYTHON to your interpreter if it is not on PATH.");
    return null;
  }
  const { host, port } = targetHostPort();
  const args = ["-m", "uvicorn", "llmclient.server:app", "--host", host, "--port", port];
  console.log(`[llmclient] launching sidecar: ${py} ${args.join(" ")} (cwd=${root})`);
  try {
    const proc = spawn(py, args, {
      cwd: root,
      env: {
        ...process.env,
        PYTHONPATH: [root, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
        LLMCLIENT_HOST: host,
        LLMCLIENT_PORT: port,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const tag = (buf: Buffer) => buf.toString().split(/\r?\n/).filter(Boolean).forEach((l) => console.log(`[llmclient] ${l}`));
    proc.stdout?.on("data", tag);
    proc.stderr?.on("data", tag);

    proc.on("error", (err) => {
      console.warn(`[llmclient] failed to start (${err.message}). AI features will be unavailable until the Python llmclient is started manually.`);
      if (child === proc) child = null;
    });
    proc.on("exit", (code, signal) => {
      console.warn(`[llmclient] process exited (code=${code ?? "?"}, signal=${signal ?? "?"}). AI features are now unavailable.`);
      if (child === proc) child = null;
    });

    child = proc;
    return proc;
  } catch (err) {
    console.warn(`[llmclient] spawn threw: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Ensure the Python llmclient sidecar is reachable. Auto-starts it on first
 * need. Returns true if reachable (already up or just started).
 */
export function isLlmClientRunning(): boolean {
  return !!child && !child.killed;
}

export async function ensureLlmClient(maxWaitMs = 30_000): Promise<boolean> {
  if (!AUTOSTART_ENABLED) return ping();
  if (await ping()) return true;

  if (child && !child.killed) {
    return waitForHealth(maxWaitMs);
  }

  if (!startPromise) {
    startPromise = (async () => {
      spawnInternal();
      return waitForHealth(maxWaitMs);
    })();
    startPromise.finally(() => {
      startPromise = null;
    }).catch(() => {});
  }
  return startPromise ? await startPromise : false;
}

/** Boot-time best-effort auto-start (does not block server startup). */
export function startLlmClientSidecar(): void {
  if (!AUTOSTART_ENABLED) {
    console.log("[llmclient] autostart disabled (LLMCLIENT_AUTOSTART=false).");
    return;
  }
  ensureLlmClient()
    .then((ok) => {
      if (ok) console.log("[llmclient] sidecar is up.");
      else console.warn("[llmclient] sidecar did not become ready; AI features may be unavailable until it is started.");
    })
    .catch(() => {});
}

export function shutdownLlmClient(): void {
  if (child && !child.killed) {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }
  child = null;
}
