/**
 * 服务端构建元信息（build-info）的共享契约。
 *
 * 为什么要有它：发布改由 CI 出包后，管理员需要一眼确认「这台服务器上跑的是哪一次构建」，
 * 而不是靠 `package.json` 里的版本号猜（版本号相同但包没换、进程没重启都是常事）。
 *
 * 口径：
 *  - `builtAt` 是**构建**时间，由 `npm run build:server` 写入 `dist/server/build-info.json`；
 *    部署包的进程启动时间是另一件事，两者分开返回，不混成一个「更新时间」。
 *  - 拿不到依据的字段一律为 `null`（源码直跑、从 tarball 构建、无 git 元数据等），
 *    不填默认值、不拿当前时间冒充构建时间；界面据此显示「—」并说明原因。
 *  - 本文件是纯类型与归一化，不碰文件系统，客户端与服务端都能引用。
 */

export const BUILD_INFO_FILE_NAME = "build-info.json";

/** 结构版本号：字段含义变化时递增，读取端按版本归一化，避免旧包被当成新包误读。 */
export const BUILD_INFO_SCHEMA = 1;

export interface BuildInfo {
  schema: number;
  /** package.json 的版本号；缺失为 null。 */
  version: string | null;
  /** 完整提交号；无 git 元数据时为 null。 */
  commit: string | null;
  /** 短提交号，便于在界面上直接读；无 git 元数据时为 null。 */
  commitShort: string | null;
  /** 构建时工作区是否有未提交改动；无法判定时为 null（不等于 false）。 */
  commitDirty: boolean | null;
  /** 构建时间，ISO-8601 UTC。 */
  builtAt: string;
  /** 构建环境，如 `node v22.23.4 / linux-x64`；旧产物可能没写，为 null。 */
  builder: string | null;
  /** CI 触发时的分支或标签名；本地构建为 null。 */
  ciRef: string | null;
  /** CI 运行页链接，便于从服务器直接跳到那次构建；本地构建为 null。 */
  ciRunUrl: string | null;
}

/** 归一化前已有的 `builtAt` 之类字段原样透传，缺失字段补 null，多余字段丢弃。 */
function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function isoDateTime(value: unknown): string | null {
  const raw = str(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * 把磁盘上读到的任意 JSON 收敛成 `BuildInfo | null`。
 * 返回 null 表示「没有可用的构建信息」，调用方据此显示「—」，不得回退成当前时间。
 *
 * 结构版本按白名单判定：只认 `BUILD_INFO_SCHEMA`。缺字段、版本不认识、来自未来版本，
 * 一律视为不可用——按字段猜着读旧/新语义正是版本号想避免的事，宁可让管理员看到「—」加原因。
 */
export function normalizeBuildInfo(raw: unknown): BuildInfo | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const data = raw as Record<string, unknown>;
  if (data.schema !== BUILD_INFO_SCHEMA) return null;
  const builtAt = isoDateTime(data.builtAt);
  // 没有构建时间就认为这份信息不可信：宁可不显示，也不让管理员把「未知」读成「最新」。
  if (!builtAt) return null;
  const version = str(data.version);
  const commit = str(data.commit);
  return {
    schema: BUILD_INFO_SCHEMA,
    version,
    commit,
    commitShort: str(data.commitShort) ?? (commit ? commit.slice(0, 7) : null),
    commitDirty: bool(data.commitDirty),
    builtAt,
    builder: str(data.builder),
    ciRef: str(data.ciRef),
    ciRunUrl: str(data.ciRunUrl),
  };
}
