/**
 * 读取构建期写入的 `dist/server/build-info.json`。
 *
 * 部署形态差异（都要能读到，否则管理员页面永远是「—」）：
 *  - 生产：`/opt/project-x-server/dist/server/index.mjs`，`import.meta.url` 落在 `dist/server/`，与文件同目录。
 *  - 扫描端 Electron 壳：服务端产物同样打进包内，按同一路径命中。
 *  - `npm run dev` 直跑源码：`import.meta.url` 落在 `src/server/lib/`，那里没有构建信息，
 *    如实返回 null，界面显示「—」。
 *    这里**故意不按 cwd 去找 `dist/server/`**：源码直跑时仓库里那份 `dist/` 属于上一次构建，
 *    把它当成本次运行的构建时间会直接误导「这台服务器是不是新包」这个判断。
 *  - 特殊布局（自定义 `PROJECTX_APP_DIR` 等）：用 `PROJECTX_BUILD_INFO_PATH` 指定绝对路径。
 *
 * 取用规则：按优先级取**第一个存在的文件**，内容不可用就说明不可用，不再往下一个候选找，
 * 也不退回当前时间——否则管理员会把「猜的」读成「这台服务器刚刚构建过」。
 * 原因文案只带文件名与错误类别，不回传目录（与管理台其余接口 F-12-8 的脱敏口径一致）。
 *
 * 缓存按文件的 mtime + 大小失效，不是进程级永久缓存：管理员可能先打开过控制台，再把新包拷进来。
 * 若一直返回第一次读到的内容，「新包已就位但服务没重启」这个最该被看见的场景反而看不见。
 */
import path from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BUILD_INFO_FILE_NAME, normalizeBuildInfo, type BuildInfo } from "../../shared/buildInfo";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 构建信息是几百字节的小文件；超过这个上限说明路径被指到别处，按不可信内容处理。 */
const MAX_BUILD_INFO_BYTES = 64 * 1024;

export type BuildInfoSource = {
  info: BuildInfo | null;
  /** 实际取用的文件路径；没取到任何文件时为 null。 */
  path: string | null;
  /** 没有可用构建信息时的原因，用于界面提示；有信息时为 null。 */
  reason: string | null;
};

function candidatePaths(env: NodeJS.ProcessEnv): string[] {
  // 显式指定时以此为准：文件不在就说「不在」，不悄悄改用别的候选，否则管理员看到的构建时间
  // 可能来自另一份产物，比「未知」更危险。
  if (env.PROJECTX_BUILD_INFO_PATH) return [path.resolve(env.PROJECTX_BUILD_INFO_PATH)];
  // 只认与服务端产物同目录的那一份：见文件头，按 cwd 兜底会把上一次构建的时间当成本次运行的。
  return [path.join(__dirname, BUILD_INFO_FILE_NAME)];
}

/** 错误原因去掉路径部分：`ENOENT` / `EACCES` 这类代码足够定位，目录本身不该出现在管理接口响应里。 */
function failureHint(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;
  return typeof code === "string" && code ? code : "unreadable";
}

let cached: BuildInfoSource | null = null;
/** 缓存对应的文件与指纹；文件被替换（部署新包）后指纹不再匹配，就会重新读。 */
let cachedStamp: { file: string; mtimeMs: number; size: number } | null = null;

/** 当前取用文件的指纹；文件不在或读不到属性时返回 null（此时不套用缓存）。 */
function currentStamp(file: string | null): { file: string; mtimeMs: number; size: number } | null {
  if (!file) return null;
  try {
    const stat = statSync(file);
    return { file, mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}

/**
 * 先找出「存在」的候选文件，再按指纹决定是否重读。
 * 这里分两步是为了让「文件被替换成同大小但内容不同」也能重读：mtime 变了就失效。
 */
function locatedFile(): string | null {
  for (const file of candidatePaths(process.env)) {
    try {
      if (existsSync(file)) return file;
    } catch {
      // 目录不可达之类的问题留到读取时统一说明，这里不猜。
    }
  }
  return null;
}

export function readBuildInfo(): BuildInfoSource {
  const file = locatedFile();
  const stamp = currentStamp(file);
  // 没有可用文件时不缓存结论：可能是部署过程中间态，下一次请求要重新看。
  if (!stamp) {
    cached = null;
    cachedStamp = null;
    const override = process.env.PROJECTX_BUILD_INFO_PATH;
    return {
      info: null,
      path: null,
      reason: override ? "指定的构建信息文件不存在" : "本次运行没有构建信息（源码直跑或旧版部署包）",
    };
  }
  if (cached && cachedStamp && cachedStamp.file === stamp.file && cachedStamp.mtimeMs === stamp.mtimeMs && cachedStamp.size === stamp.size) {
    return cached;
  }
  const fresh = loadBuildInfo(stamp.file);
  cached = fresh;
  cachedStamp = fresh.path ? currentStamp(fresh.path) : null;
  return fresh;
}

/** 真正读一次盘：内容不可用就如实说明，不退回当前时间。 */
function loadBuildInfo(file: string): BuildInfoSource {
  try {
    if (statSync(file).size > MAX_BUILD_INFO_BYTES) {
      return { info: null, path: file, reason: "构建信息文件过大，按不可信内容忽略" };
    }
    const parsed = normalizeBuildInfo(JSON.parse(readFileSync(file, "utf8")));
    // 文件存在但关键字段缺失：多半是旧版本产物或手工放置，如实说明，不退回当前时间。
    return parsed
      ? { info: parsed, path: file, reason: null }
      : { info: null, path: file, reason: `构建信息字段不完整（${path.basename(file)}，可能是旧版本产物）` };
  } catch (error) {
    return { info: null, path: file, reason: `构建信息无法解析（${path.basename(file)}，${failureHint(error)}）` };
  }
}

/** 回归夹具用：清掉缓存，让下一次读取重新落盘。 */
export function resetBuildInfoCache(): void {
  cached = null;
  cachedStamp = null;
}
