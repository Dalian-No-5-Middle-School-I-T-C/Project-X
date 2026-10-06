import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function resolveProjectDbPath(): string {
  const envPath = process.env.PROJECTX_DB_PATH;
  if (envPath) return path.resolve(envPath);
  return path.join(process.cwd(), "data", "projectx.db");
}

export function resolveAnswerCardDataDir(): string {
  const envDir = process.env.ANSWER_CARD_DATA_DIR;
  if (envDir) return path.resolve(envDir);
  return path.join(process.cwd(), "data", "answer-card");
}

export function resolveScannerDbPath(): string {
  return path.join(resolveAnswerCardDataDir(), "scanner.db");
}

/**
 * 安全 R31：默认库路径依赖 `process.cwd()`，而「换了工作目录再启动」会**静默新建一个空库**——
 * 表现为「数据全没了 + 管理员口令按引导态换发」（并因此触发 R01 的随机口令），现场很难自己判断是升级
 * 丢了库还是启动目录不对。Electron 与标准 Ubuntu unit 都显式给了 `PROJECTX_DB_PATH`，
 * 剩下的正是「直接 `node dist/server/index.js`」这类 standalone 形态。
 *
 * 这里**不自动切换**到探测到的其它库：静默改用一个别的库与静默新建空库是同一类错误，
 * 只是更难发现。改为在启动时把事实说出来（解析到哪、是否已存在、同机还有哪些候选库），
 * 由运维显式设 `PROJECTX_DB_PATH` 收口。
 */
export interface ProjectDbPathDiagnosis {
  /** 实际解析出的库文件路径。 */
  resolved: string;
  /** 是否由 `PROJECTX_DB_PATH` 显式指定（false = 由 cwd 推导）。 */
  explicit: boolean;
  /** 解析出的路径当前是否已存在文件。 */
  exists: boolean;
  /** 同机探测到的其它 `projectx.db`（不含 `resolved`）。 */
  candidates: string[];
  /** 需要运维看见的提示；为空表示无需关注。 */
  warnings: string[];
}

const DB_FILE = "projectx.db";

/**
 * 从本模块所在位置向上探测 `data/projectx.db`：开发态在 `src/server/db/`，
 * 构建后在 `dist/server/db/`，安装态可能更深——向上四级足以覆盖这几种形态，
 * 且不需要把任何厂商路径写死进来。`searchFromDir` 仅供验证脚本指定起点。
 */
export function candidateProjectDbPaths(searchFromDir?: string): string[] {
  const moduleDir = searchFromDir
    ? path.resolve(searchFromDir)
    : path.dirname(fileURLToPath(import.meta.url));
  const seen = new Set<string>();
  const out: string[] = [];
  let dir = moduleDir;
  for (let level = 0; level < 4; level += 1) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
    const candidate = path.join(dir, "data", DB_FILE);
    const normalized = path.resolve(candidate);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

/** 纯诊断：只读文件系统，不创建目录、不打开数据库、不改变解析结果。 */
export function diagnoseProjectDbPath(options?: { searchFromDir?: string }): ProjectDbPathDiagnosis {
  const resolved = resolveProjectDbPath();
  const explicit = Boolean(process.env.PROJECTX_DB_PATH);
  const exists = existsSync(resolved);
  const candidates = candidateProjectDbPaths(options?.searchFromDir).filter(
    (candidate) => candidate !== path.resolve(resolved) && existsSync(candidate),
  );
  const warnings: string[] = [];
  if (!explicit) {
    if (!exists) {
      warnings.push(
        `未设置 PROJECTX_DB_PATH，本次启动将在「当前工作目录」下新建空库：${resolved}。` +
          "若是升级或换了启动目录，这会表现为「数据不见了 + 管理员口令重新引导」；" +
          "请显式设置 PROJECTX_DB_PATH 指向既有库后再启动。",
      );
    }
    if (candidates.length > 0) {
      warnings.push(
        `同机另发现 ${candidates.length} 个 ${DB_FILE}（当前按工作目录选用 ${resolved}）：` +
          `${candidates.slice(0, 3).join(" / ")}${candidates.length > 3 ? " …" : ""}。` +
          "确认选中的是预期的那个库；不确定时请显式设置 PROJECTX_DB_PATH。",
      );
    }
  } else if (!exists) {
    warnings.push(`PROJECTX_DB_PATH 指向的文件不存在，将新建空库：${resolved}（路径拼写与挂载点请复核）`);
  }
  return { resolved, explicit, exists, candidates, warnings };
}
