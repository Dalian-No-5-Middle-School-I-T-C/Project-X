import AdmZip from "adm-zip";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  MAX_RESTORE_ZIP_ENTRIES,
  MAX_RESTORE_ZIP_ENTRY_BYTES,
  MAX_RESTORE_ZIP_RATIO,
  MAX_RESTORE_ZIP_TOTAL_BYTES,
  describeRestoreZipLimits,
} from "../../shared/restoreZipLimits";

/**
 * 备份恢复 ZIP 的解压闸门（安全 R43）。
 *
 * 独立成 service 而不是留在路由里，是为了让验证脚本能直接 import 这几个纯判定
 * （`classifyEntryName` / `checkEntryBudget` / `worstCaseEntryBytes` / `extractZipWithinBudget`）而不必起 Express。
 *
 * 抛出的 `RestoreZipError.message` **必须只含数量与限额，不含任何主机路径**：
 * 这些消息会原样返回给管理员（R25 要求恢复接口不回显主机文件系统信息）。
 */

const MEBIBYTE = 1024 * 1024;

export class RestoreZipError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "RestoreZipError";
    this.status = status;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes >= MEBIBYTE) return `${(bytes / MEBIBYTE).toFixed(bytes % MEBIBYTE === 0 ? 0 : 1)} MiB`;
  return `${bytes} B`;
}

/**
 * 条目名安全判定（R43 与早先的 zip-slip 检查合并到这里）。
 *
 * 返回 null 表示**直接拒绝**而不是「剥掉前缀后继续」：一份合法的 Project-X 备份不会含绝对路径
 * 或 `..` 条目，静默跳过会让恢复变成「换掉了一部分、另一部分悄悄丢了」的不一致状态。
 *
 * 注：POSIX 下 `..\\..\\evil` 会被当成一个普通文件名（不越界），但仍属异常条目，一并拒掉，
 * 避免同一份备份在 Windows/Linux 上解出不同结构。
 */
export function classifyEntryName(entryName: string): { safe: true } | { safe: false; reason: string } {
  const normalized = entryName.replace(/\\/g, "/");
  if (normalized === "" || normalized.includes("\0")) return { safe: false, reason: "empty" };
  if (path.isAbsolute(entryName) || /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//")) {
    return { safe: false, reason: "absolute" };
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "..")) return { safe: false, reason: "parent-dir" };
  return { safe: true };
}

/** 把条目名解析成目标目录内的落盘路径；越界（含符号链接式前缀绕过）时抛错。 */
export function resolveEntryDest(destDir: string, entryName: string): string {
  const verdict = classifyEntryName(entryName);
  if (!verdict.safe) {
    throw new RestoreZipError(`备份包含非法路径条目（${verdict.reason}），已拒绝恢复`, 400);
  }
  const resolvedDest = path.resolve(destDir);
  const candidate = path.join(resolvedDest, path.normalize(entryName));
  const rel = path.relative(resolvedDest, candidate);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new RestoreZipError("备份包含越出解压目录的条目，已拒绝恢复", 400);
  }
  return candidate;
}

export interface BudgetState {
  entries: number;
  bytes: number;
}

/**
 * 逐条目累计预算检查（纯函数，便于单测）。
 * `declaredBytes` 取 ZIP 头部声明的解压后体积——先用它拦下「声明就超限」的条目，
 * 避免为它分配内存；`actualBytes` 是真正读出来的字节数，头部撒谎时也拦得住。
 */
export function checkEntryBudget(state: BudgetState, entryCount: number, declaredBytes: number, actualBytes: number): void {
  if (entryCount > MAX_RESTORE_ZIP_ENTRIES) {
    throw new RestoreZipError(
      `备份条目数 ${entryCount} 超过解压预算 ${MAX_RESTORE_ZIP_ENTRIES} 条（${describeRestoreZipLimits()}）`,
      413,
    );
  }
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_RESTORE_ZIP_ENTRY_BYTES) {
    throw new RestoreZipError(
      `备份内存在解压后体积 ${formatBytes(declaredBytes)} 的单个文件，超过解压预算 ${formatBytes(MAX_RESTORE_ZIP_ENTRY_BYTES)}`,
      413,
    );
  }
  const counted = Number.isFinite(actualBytes) && actualBytes > 0 ? actualBytes : Math.max(0, declaredBytes);
  if (counted > MAX_RESTORE_ZIP_ENTRY_BYTES) {
    throw new RestoreZipError(
      `备份内存在解压后体积 ${formatBytes(counted)} 的单个文件，超过解压预算 ${formatBytes(MAX_RESTORE_ZIP_ENTRY_BYTES)}`,
      413,
    );
  }
  if (state.bytes + counted > MAX_RESTORE_ZIP_TOTAL_BYTES) {
    throw new RestoreZipError(
      `备份累计解压体积将超过解压预算 ${formatBytes(MAX_RESTORE_ZIP_TOTAL_BYTES)}（已解出 ${formatBytes(state.bytes)}）`,
      413,
    );
  }
  state.entries += 1;
  state.bytes += counted;
}

/** ZIP 条目方法号（`entry.header.method`）：只有这两类会真的产出字节。 */
const ZIP_METHOD_STORED = 0;
const ZIP_METHOD_DEFLATED = 8;

/**
 * 一个条目在解压时**最坏**会占用多少内存（纯函数，便于单测）。
 *
 * 正常条目照头部声明算：解压库把输出上限设为声明值，谎报则由 `checkEntryBudget`
 * 用实际读出的字节数补刀。危险的是把解压后体积声明成 0 的条目——「按声明封顶」此时
 * 等于不封顶（adm-zip 0.6.0 的 Inflater 只在声明值 >0 时才设上限，0.6.1 才有 1 字节地板），
 * 一个几百 KiB 的压缩负载能先展开成 GB 级 Buffer，再轮到体积检查。这类条目因此改按
 * 「压缩负载 × 最坏展开比」预估：DEFLATE 的物理上界约 1032:1，STORED 的输出恰等于负载本身。
 * 预估越界就在调用 `getData()` 之前拒掉，内存与磁盘都拿不到那份谎报的体积。
 */
export function worstCaseEntryBytes(method: number, compressedBytes: number, declaredBytes: number): number {
  if (declaredBytes > 0) return declaredBytes;
  if (method === ZIP_METHOD_STORED) return compressedBytes;
  if (method === ZIP_METHOD_DEFLATED) return compressedBytes * MAX_RESTORE_ZIP_RATIO;
  return 0; // 加密或未知方法在 getData() 里就会失败，不必为它预估
}

/**
 * 从 Buffer 解压 ZIP 到目标目录：条目名安全 + 三道体积/数量预算（R43）。
 *
 * 失败即抛错，调用方负责清理已落盘的临时目录。预算内的内存占用受单条上限约束，
 * 因此仍沿用「全内存读取」的稳定写法（`entry.getData()`）——前提是谎报声明为 0 的条目
 * 先被 `worstCaseEntryBytes` 拦在分配之前，否则单条上限约束的是声明而非实际。
 */
export function extractZipWithinBudget(zipBuffer: Buffer, destDir: string): void {
  let zip: AdmZip;
  try {
    zip = new AdmZip(zipBuffer);
  } catch {
    throw new RestoreZipError("备份文件解析失败：ZIP 结构损坏或格式不受支持", 400);
  }
  const entries = zip.getEntries();
  if (entries.length === 0) {
    // adm-zip 对头部不自洽的包是「静默解出 0 条」而不是抛错：若照原样走完，恢复会报告成功、
    // 实际一个字节都没写回去。真实备份至少含 metadata.json，空包一律判非法。
    throw new RestoreZipError("备份文件解析失败：ZIP 内没有任何可恢复条目", 400);
  }
  const state: BudgetState = { entries: 0, bytes: 0 };
  entries.forEach((entry, index) => {
    const declared = Number(entry.header?.size ?? 0);
    const compressed = Number(entry.header?.compressedSize ?? 0);
    const method = Number(entry.header?.method ?? -1);
    // 分配内存之前先按最坏情况估体积：声明已越界的条目、以及谎报为 0 的炸弹都在这里拦下。
    const worst = worstCaseEntryBytes(method, compressed, declared);
    if (worst > MAX_RESTORE_ZIP_ENTRY_BYTES || state.bytes + worst > MAX_RESTORE_ZIP_TOTAL_BYTES) {
      throw new RestoreZipError(
        declared > 0
          ? `备份内存在解压后体积 ${formatBytes(worst)} 的单个文件，超过解压预算 ${formatBytes(MAX_RESTORE_ZIP_ENTRY_BYTES)}`
          : `备份内有文件把解压后体积声明为 0，按最坏展开预估达 ${formatBytes(worst)}，超过解压预算（${describeRestoreZipLimits()}）`,
        413,
      );
    }
    const destPath = resolveEntryDest(destDir, entry.entryName);
    if (entry.isDirectory) {
      checkEntryBudget(state, index + 1, 0, 0);
      mkdirSync(destPath, { recursive: true });
      return;
    }
    let data: Buffer;
    try {
      data = entry.getData();
    } catch {
      throw new RestoreZipError(`备份内文件 ${path.posix.basename(entry.entryName.replace(/\\/g, "/"))} 解压失败（数据损坏或加密）`, 400);
    }
    checkEntryBudget(state, index + 1, declared, data.byteLength);
    mkdirSync(path.dirname(destPath), { recursive: true });
    writeFileSync(destPath, data);
  });
}

/** 供启动日志/健康检查引用的一行摘要。 */
export { describeRestoreZipLimits };
