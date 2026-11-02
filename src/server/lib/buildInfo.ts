/**
 * 读取构建期写入的 `dist/server/build-info.json`。
 *
 * 部署形态差异（都要能读到，否则管理员页面永远是「—」）：
 *  - 生产：`/opt/project-x-server/dist/server/index.mjs`，`import.meta.url` 落在 `dist/server/`，与文件同目录。
 *  - 从仓库根跑 `npm run server`：按 cwd 命中 `dist/server/`，读到的是当前这份产物的构建时间。
 *  - `npm run dev` 直跑源码：没有构建信息，如实返回 null，界面显示「—」。
 *  - 特殊布局（自定义 `PROJECTX_APP_DIR` 等）：用 `PROJECTX_BUILD_INFO_PATH` 指定绝对路径。
 *
 * 取用规则：按优先级取**第一个存在的文件**，内容不可用就说明不可用，不再往下一个候选找，
 * 也不退回当前时间——否则管理员会把「猜的」读成「这台服务器刚刚构建过」。
 * 原因文案只带文件名与错误类别，不回传目录（与管理台其余接口 F-12-8 的脱敏口径一致）。
 *
 * 只读一次并缓存：进程运行期这份文件不会变，变了也要等重启才生效。
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
  return [
    path.join(__dirname, BUILD_INFO_FILE_NAME),
    path.join(process.cwd(), "dist", "server", BUILD_INFO_FILE_NAME),
  ];
}

/** 错误原因去掉路径部分：`ENOENT` / `EACCES` 这类代码足够定位，目录本身不该出现在管理接口响应里。 */
function failureHint(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;
  return typeof code === "string" && code ? code : "unreadable";
}

let cached: BuildInfoSource | null = null;

export function readBuildInfo(): BuildInfoSource {
  if (cached) return cached;
  const override = process.env.PROJECTX_BUILD_INFO_PATH;
  const existing: string[] = [];
  const unreadable: string[] = [];
  for (const file of candidatePaths(process.env)) {
    try {
      if (!existsSync(file)) continue;
      existing.push(file);
    } catch (error) {
      unreadable.push(`${path.basename(file)} (${failureHint(error)})`);
    }
  }
  const file = existing[0];
  if (!file) {
    cached = {
      info: null,
      path: null,
      reason: override
        ? "指定的构建信息文件不存在"
        : unreadable.length > 0
          ? `构建信息读取失败（${unreadable.join("、")}）`
          : "本次运行没有构建信息（源码直跑或旧版部署包）",
    };
    return cached;
  }
  try {
    if (statSync(file).size > MAX_BUILD_INFO_BYTES) {
      cached = { info: null, path: file, reason: "构建信息文件过大，按不可信内容忽略" };
      return cached;
    }
    const parsed = normalizeBuildInfo(JSON.parse(readFileSync(file, "utf8")));
    // 文件存在但关键字段缺失：多半是旧版本产物或手工放置，如实说明，不退回当前时间。
    cached = parsed
      ? { info: parsed, path: file, reason: null }
      : { info: null, path: file, reason: `构建信息字段不完整（${path.basename(file)}，可能是旧版本产物）` };
    return cached;
  } catch (error) {
    cached = {
      info: null,
      path: file,
      reason: `构建信息无法解析（${path.basename(file)}，${failureHint(error)}）`,
    };
    return cached;
  }
}

/** 回归夹具用：清掉缓存，让下一次读取重新按当前环境变量定位。 */
export function resetBuildInfoCache(): void {
  cached = null;
}
