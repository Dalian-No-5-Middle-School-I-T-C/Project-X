/**
 * 生成 `dist/server/build-info.json` 的构建侧工序。
 *
 * 由 `scripts/build-server.ts` 在服务端产物落盘后调用；CI 出包与本机构建走同一条路，
 * 所以服务器上读到的构建时间就是真正产出这份 `index.mjs` 的那一次构建。
 *
 * 拿不到的信息保持 null（无 git、非仓库目录、从压缩包构建），不做猜测性兜底。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BUILD_INFO_FILE_NAME, BUILD_INFO_SCHEMA, type BuildInfo } from "../../src/shared/buildInfo";

/**
 * 执行 git 并返回**去掉首尾空白的原始输出**；只有命令本身失败才返回 null。
 *
 * 这里不能把空串折叠成 null：`git status --porcelain` 在工作区干净时输出空串，
 * 那是「干净」这个确定结论，不是「取不到」。CI 的检出永远是干净的，折叠成 null 会让
 * 正式版本的构建信息一律写成「未记录」，恰好把最该告诉管理员的事实丢掉。
 */
function git(rootDir: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: rootDir, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function readVersion(rootDir: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" && pkg.version.trim() !== "" ? pkg.version.trim() : null;
  } catch {
    return null;
  }
}

/** CI 只在三个变量齐备时才拼链接，缺任何一个都返回 null，避免写出点不开的 URL。 */
function ciRunUrl(env: NodeJS.ProcessEnv): string | null {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = env;
  if (!GITHUB_SERVER_URL || !GITHUB_REPOSITORY || !GITHUB_RUN_ID) return null;
  return `${GITHUB_SERVER_URL.replace(/\/$/, "")}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
}

/**
 * `ciRef` 要回答的是「这台服务器跑的是哪一次发布的构建」。
 *
 * 光看 `GITHUB_REF_NAME` 不够：正式发版是在 main 上手动运行 `release-publish.yml`，
 * 由它调用构建线，那条构建运行的 `GITHUB_REF_NAME` 永远是 `main`，发出去的包里写不出
 * 版本标签。所以调用方（发版工作流）用 `PROJECTX_CI_REF` 显式给出标签，没给才退回
 * 分支/标签名，两者都没有（本机构建）仍按口径留 null。
 */
function ciRef(env: NodeJS.ProcessEnv): string | null {
  const explicit = env.PROJECTX_CI_REF?.trim();
  if (explicit) return explicit;
  const refName = env.GITHUB_REF_NAME?.trim();
  return refName ? refName : null;
}

/**
 * 只有当 rootDir 自己就是一个 git 工作树的根时才采集 git 信息。
 * 不这么判断的话：从压缩包解出来的源码若落在别的仓库工作树里，`git -C` 会往上找到那个父仓库，
 * 把毫不相干的 HEAD 与工作区状态记成 Project-X 的来源，管理员看到的是一个陌生提交——
 * 按口径这属于「没有 git 元数据」，应该留 null。
 */
function isGitRoot(rootDir: string): boolean {
  const top = git(rootDir, ["rev-parse", "--show-toplevel"]);
  if (top === null) return false;
  try {
    return realpathSync(top) === realpathSync(rootDir);
  } catch {
    return false;
  }
}

export function collectBuildInfo(rootDir: string, env: NodeJS.ProcessEnv = process.env): BuildInfo {
  const inRepo = isGitRoot(rootDir);
  const revision = inRepo ? git(rootDir, ["rev-parse", "HEAD"]) : null;
  const commit = revision && revision !== "" ? revision : null;
  const status = inRepo ? git(rootDir, ["status", "--porcelain"]) : null;
  // status === null 才是「无法判定」；空串是「干净」。
  const commitDirty = status === null ? null : status !== "";
  return {
    schema: BUILD_INFO_SCHEMA,
    version: readVersion(rootDir),
    commit,
    commitShort: commit ? commit.slice(0, 7) : null,
    commitDirty,
    builtAt: new Date().toISOString(),
    builder: `node ${process.version} / ${process.platform}-${process.arch}`,
    ciRef: ciRef(env),
    ciRunUrl: ciRunUrl(env),
  };
}

/** 写到 `dist/server/build-info.json`，与服务端产物同目录，随部署包一起走。 */
export function writeBuildInfoFile(rootDir: string, info: BuildInfo, outDir = path.join(rootDir, "dist", "server")): string {
  mkdirSync(outDir, { recursive: true });
  const target = path.join(outDir, BUILD_INFO_FILE_NAME);
  writeFileSync(target, `${JSON.stringify(info, null, 2)}\n`, "utf8");
  return target;
}
