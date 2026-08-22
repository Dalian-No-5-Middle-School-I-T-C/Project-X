/**
 * 与 Python llmclient 共享的配置解析（安全审计 P1）。
 *
 * Python 侧 config.py 通过 `load_dotenv(ROOT_DIR / ".env")` 读取 llmclient/.env；
 * 而 Node 后端此前只读自身 process.env，导致按 .env.example 配置
 * LLMCLIENT_INTERNAL_API_KEY 后：Python 要求鉴权、Node 却不发送 Authorization → 401。
 *
 * getLlmEnv() 以 process.env 优先，其次读取同一份 llmclient/.env，
 * 使 Node 与 Python 侧看到同一个内部密钥。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function repoRoot(): string {
  const candidates = [path.resolve(__dirname, "../../../../.."), process.cwd()];
  for (const c of candidates) {
    if (existsSync(path.join(c, "llmclient", "server.py"))) return c;
  }
  return process.cwd();
}

let parsed: Record<string, string> | null = null;

function parseDotEnvLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
  if (!match) return null;
  let value = match[2].trim();
  // 去除成对引号（含单/双引号）
  if (value.length >= 2) {
    const first = value[0];
    if (first === '"' || first === "'") {
      const last = value[value.length - 1];
      if (last === first) value = value.slice(1, -1);
    }
  }
  return [match[1], value];
}

function loadLlmEnvFile(): Record<string, string> {
  if (parsed) return parsed;
  parsed = {};
  const file = path.join(repoRoot(), "llmclient", ".env");
  if (!existsSync(file)) return parsed;
  try {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const pair = parseDotEnvLine(line);
      if (pair) parsed[pair[0]] = pair[1];
    }
  } catch {
    /* 无法读取则忽略，继续回退到 process.env */
  }
  return parsed;
}

/** process.env 优先，其次读取 llmclient/.env（与 Python 侧 load_dotenv 同源）。 */
export function getLlmEnv(key: string): string | undefined {
  const fromProcess = process.env[key];
  if (fromProcess) return fromProcess;
  return loadLlmEnvFile()[key] || undefined;
}
