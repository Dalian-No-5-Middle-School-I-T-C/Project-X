/**
 * 备份恢复期间的维护守卫（评审 P09）。
 *
 * 背景：restore 流程会 closeDatabase 并替换 DB 文件，期间并发请求可能读到
 * 旧连接或半替换状态。本模块以「恢复标志文件」提供进程间可见的维护状态：
 * - beginRestore()：恢复开始时写 .restoring 标志（含时间戳）；
 * - finishRestore()：恢复完成/失败后删除标志（finally 保证）；
 * - isRestoring()：业务中间件检测，命中返回 503「系统维护中」。
 *
 * 标志文件放在主 DB 同目录（与方言无关，SQLite/MariaDB 共用同一路径语义）。
 */
import { existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveProjectDbPath } from "../db";

export function restoringFlagPath(): string {
  return path.join(path.dirname(resolveProjectDbPath()), ".restoring");
}

export function isRestoring(): boolean {
  return existsSync(restoringFlagPath());
}

export function beginRestore(): void {
  try {
    writeFileSync(restoringFlagPath(), String(Date.now()), { encoding: "utf8", flag: "w" });
  } catch (err) {
    console.warn("[Restore] 写入维护标志失败（不影响恢复流程）:", err);
  }
}

export function finishRestore(): void {
  try {
    rmSync(restoringFlagPath(), { force: true });
  } catch (err) {
    console.warn("[Restore] 清理维护标志失败:", err);
  }
}
