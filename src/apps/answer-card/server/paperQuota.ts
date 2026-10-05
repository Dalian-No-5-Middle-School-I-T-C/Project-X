import { readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

import type { DbAdapter } from "../../../server/db/mysql";
import { paperDir, paperTmpDir, papersDir } from "./storage";
import {
  DEFAULT_PAPER_STORAGE_LIMITS,
  MAX_PAPER_BYTES_PER_CARD,
  MAX_PAPER_BYTES_TOTAL,
  MAX_PAPER_PAGES_PER_CARD,
  type PaperStorageLimits,
} from "../../../shared/paperStorageLimits";

/**
 * 原卷累计容量核算（安全 R10）。
 *
 * `original_paper_pages` 表没有体积列，历史上也没有任何累计口径：只挡单个文件 50 MiB，
 * 于是「同一张卡反复上传」与「无限张卡」两条路都能把数据盘写满。这里改用**磁盘实测**而不是
 * 给表加 `size_bytes` 列：
 *  - 存量数据立刻被计入（新列对旧行只能是 0，等于对老部署失效）；
 *  - 图片页会同时落 jpg 与配对 pdf，只有磁盘扫描量得到真实占盘；
 *  - 恢复/清理流程改动了目录也不需要维护一个会漂移的计数器。
 * 单卡体积扫的是该卡自己的目录（页数已被上限约束，量级可控）；全局体积扫整个 `papers/`，
 * 用 60 秒 TTL 缓存 + 越界早停，避免每次上传都走一遍全盘。
 */

const MEBIBYTE = 1024 * 1024;
const TOTAL_SCAN_TTL_MS = 60_000;

let cachedTotal: { bytes: number; exact: boolean; at: number } | null = null;

/** 上传成功/删除页后调用：让下一次读取重新实测，而不是继续用 60 秒前的缓存。 */
export function invalidatePaperUsageCache(): void {
  cachedTotal = null;
}

/** 测试用：确认可无配置回落到默认口径。 */
export const DEFAULT_PAPER_LIMITS = DEFAULT_PAPER_STORAGE_LIMITS;

/**
 * 清掉 `_tmp` 里滞留的暂存上传件（安全 R14）。
 *
 * multer 的落盘发生在路由之前：请求被中断、体积/数量被拒、进程崩溃，都会留下没人引用的临时文件。
 * 路由自身的 `finally` 只能覆盖「进入了处理函数」的那部分，所以再补一道「只删超过存活期的普通文件」的
 * 兜底清理，由上传入口顺带触发（不引入定时器，重启后第一次上传即自愈）。
 */
export async function purgeStaleTmpUploads(tmpDir: string, maxAgeMs = 60 * 60_000): Promise<number> {
  const now = Date.now();
  let removed = 0;
  let entries;
  try {
    entries = await readdir(tmpDir, { withFileTypes: true });
  } catch {
    return 0; // 目录还不存在（首次上传前）属于正常情况
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue; // 目录与符号链接一律不碰
    const full = path.join(tmpDir, entry.name);
    try {
      const info = await stat(full);
      if (now - info.mtimeMs < maxAgeMs) continue;
      await unlink(full);
      removed += 1;
    } catch {
      continue; // 并发删除/权限异常：留给下一次
    }
  }
  return removed;
}

async function sumDirBytes(
  dir: string,
  stopAfter?: number,
  skipDirs?: ReadonlySet<string>
): Promise<{ bytes: number; stoppedEarly: boolean; partial: boolean }> {
  let total = 0;
  let partial = false;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return { bytes: 0, stoppedEarly: false, partial: true }; // 目录读不出来 = 用量未知
  }
  for (const entry of entries) {
    // 不跟随符号链接：目录里放一个指向 / 的软链，就等于把「磁盘用量」变成「任意文件读取」。
    if (entry.isSymbolicLink()) { partial = true; continue; }
    const full = path.join(dir, entry.name);
    if (skipDirs?.has(full)) continue; // 暂存目录等「不属于长期占盘」的子树，整棵跳过
    if (entry.isDirectory()) {
      const nested = await sumDirBytes(full, stopAfter === undefined ? undefined : stopAfter - total);
      total += nested.bytes;
      if (nested.partial) partial = true;
      if (nested.stoppedEarly) return { bytes: total, stoppedEarly: true, partial };
      continue;
    }
    if (!entry.isFile()) { partial = true; continue; }
    try {
      total += (await stat(full)).size;
    } catch (err) {
      // 扫描途中文件被删除是正常并发（可当 0）；其它错误说明这次测量不完整。
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") partial = true;
    }
    if (stopAfter !== undefined && total > stopAfter) return { bytes: total, stoppedEarly: true, partial };
  }
  return { bytes: total, stoppedEarly: false, partial };
}

export interface PapersUsage {
  bytes: number;
  /** false 表示这是下界（早停/符号链接/读盘失败），拒绝判定需要更保守 */
  exact: boolean;
}

/**
 * `papers/` 目录的实测占盘体积。
 * 超过上限时**不缓存早停结果**（它只是下界），避免缓存值被误当成完整用量。
 *
 * `_tmp` 整棵跳过：里面是「正在路上的请求」的暂存副本，由上传预算与滞留清理负责，
 * 不属于原卷的长期占盘；计入的话每条请求都会把自己算两次。
 */
export async function readPapersTotalBytes(limitBytes: number = MAX_PAPER_BYTES_TOTAL): Promise<PapersUsage> {
  if (cachedTotal && Date.now() - cachedTotal.at < TOTAL_SCAN_TTL_MS) {
    return { bytes: cachedTotal.bytes, exact: cachedTotal.exact };
  }
  const scanned = await sumDirBytes(papersDir, limitBytes, new Set([paperTmpDir]));
  if (scanned.stoppedEarly) return { bytes: scanned.bytes, exact: false };
  cachedTotal = { bytes: scanned.bytes, exact: !scanned.partial, at: Date.now() };
  return { bytes: scanned.bytes, exact: !scanned.partial };
}

export interface PaperQuotaSnapshot {
  cardPages: number;
  cardBytes: number;
  totalBytes: number;
  /** 全局用量是否为精确值（早停/读盘受限时为 false，只作为下界） */
  totalExact: boolean;
}

/**
 * 读取当前占用。页数走 DB（`COUNT(*) WHERE card_id = ?`，双方言一致），
 * 体积走磁盘实测；两者都不做相关子查询，也不拼 `IN ()`。
 */
export async function readPaperQuota(db: DbAdapter, cardId: string): Promise<PaperQuotaSnapshot> {
  const row = await db.get<{ c: number | string }>(
    "SELECT COUNT(*) AS c FROM original_paper_pages WHERE card_id = ?",
    cardId
  );
  const cardPages = Number(row?.c ?? 0);
  const [cardScan, total] = await Promise.all([
    sumDirBytes(paperDir(cardId)),
    readPapersTotalBytes(),
  ]);
  return {
    cardPages,
    cardBytes: cardScan.bytes,
    totalBytes: total.bytes,
    totalExact: total.exact && !cardScan.partial,
  };
}

export interface IncomingPaperUpload {
  pages: number;
  /**
   * 本次增量的字节数。admission 阶段只有上传件本身的体积可看，只能当下界用；
   * 落盘之后由 `assertWrittenPaperWithinQuota` 按实际写入量复测（原卷转换会变大）。
   */
  bytes: number;
}

export type PaperQuotaVerdict =
  | { ok: true }
  | { ok: false; reason: "pages" | "card-bytes" | "total-bytes"; message: string };

function mib(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / MEBIBYTE))} MiB`;
}

/** 纯函数形式的容量判定：给定当前占用与本次增量，判断是否放行（便于按边界值断言）。 */
export function evaluatePaperQuota(
  snapshot: PaperQuotaSnapshot,
  incoming: IncomingPaperUpload,
  limits: Pick<PaperStorageLimits, "maxPaperPagesPerCard" | "maxPaperBytesPerCard" | "maxPaperBytesTotal"> = {
    maxPaperPagesPerCard: MAX_PAPER_PAGES_PER_CARD,
    maxPaperBytesPerCard: MAX_PAPER_BYTES_PER_CARD,
    maxPaperBytesTotal: MAX_PAPER_BYTES_TOTAL,
  }
): PaperQuotaVerdict {
  if (incoming.pages <= 0) return { ok: true };
  // 体积类判定一律用「严格大于」：磁盘实测可能是下界（早停/权限受限），
  // 恰好等于上限时下界意味着真实用量可能并未超额 —— 宁可少拒一次，也不误拒一次。
  // 页数来自 DB 计数，是精确值，同样口径保持一致。
  if (snapshot.cardPages + incoming.pages > limits.maxPaperPagesPerCard) {
    return {
      ok: false,
      reason: "pages",
      message: `原卷页数超出单张答题卡上限：已有 ${snapshot.cardPages} 页，本次 ${incoming.pages} 页，最多 ${limits.maxPaperPagesPerCard} 页（可由 PROJECTX_PAPER_MAX_PAGES_PER_CARD 调整，上限 600）`,
    };
  }
  if (snapshot.cardBytes + incoming.bytes > limits.maxPaperBytesPerCard) {
    return {
      ok: false,
      reason: "card-bytes",
      message: `该答题卡原卷累计体积已达上限：已占 ${mib(snapshot.cardBytes)}，本次 ${mib(incoming.bytes)}，单卡最多 ${mib(limits.maxPaperBytesPerCard)}（可由 PROJECTX_PAPER_MAX_BYTES_PER_CARD_MIB 调整）`,
    };
  }
  if (snapshot.totalBytes + incoming.bytes > limits.maxPaperBytesTotal) {
    return {
      ok: false,
      reason: "total-bytes",
      message: `服务器原卷存储总量已达上限：当前 ${mib(snapshot.totalBytes)}，本次需要 ${mib(incoming.bytes)}，总量最多 ${mib(limits.maxPaperBytesTotal)}（可由 PROJECTX_PAPER_MAX_TOTAL_MIB 调整）。请先清理不再需要的原卷或扩容后重试`,
    };
  }
  return { ok: true };
}

/** 落盘后复测越界：由路由回滚事务、删除本轮写入并返回 413（安全 R10 与 PR #312 CR14）。 */
export class PaperQuotaRollbackError extends Error {
  readonly reason: "pages" | "card-bytes" | "total-bytes";
  constructor(reason: "pages" | "card-bytes" | "total-bytes", message: string) {
    super(message);
    this.name = "PaperQuotaRollbackError";
    this.reason = reason;
  }
}

/**
 * 用**实际落盘体积**复测容量闸门（PR #312 CR14）。
 *
 * 上传 admission 只能按输入字节估算，而原卷是要转换的：一张 844 KiB 的 JPEG 会同时落成
 * jpg 与配对 PDF，实测约 1.41 MiB——单看输入，1 MiB 的额度会被穿透。所以写入完成后必须
 * 按磁盘真实增量再判一次，越界就抛错：事务回滚掉这一批 DB 行，已落盘的文件由调用方删除。
 *
 * - 单卡这一维**重新实测**：卡目录最多几百个文件，扫得起，而且这才是刚写出来的真相；
 *   基线取「实测值减去本轮写入量」，不引入会漂移的计数器。
 * - 全局这一维沿用 admission 读到的缓存值 + 本轮实测增量：每次上传都强制重扫整个 `papers/`
 *   会把 60 秒缓存的收益全部赔掉。缓存若恰好在本次请求期间被别人刷新过，这一维会把自己
 *   算两次——方向是保守的（宁多少拒一次）。
 *
 * 必须在事务内用 `tx` 调用，才看得见本次尚未提交的页行。
 */
export async function assertWrittenPaperWithinQuota(
  db: DbAdapter,
  cardId: string,
  admission: PaperQuotaSnapshot,
  written: { pages: number; bytes: number },
  limits?: Parameters<typeof evaluatePaperQuota>[2]
): Promise<void> {
  const post = await readPaperQuota(db, cardId);
  const verdict = evaluatePaperQuota(
    {
      cardPages: Math.max(0, post.cardPages - written.pages),
      cardBytes: Math.max(0, post.cardBytes - written.bytes),
      totalBytes: admission.totalBytes,
      totalExact: admission.totalExact && post.totalExact,
    },
    { pages: written.pages, bytes: written.bytes },
    limits
  );
  if (!verdict.ok) throw new PaperQuotaRollbackError(verdict.reason, verdict.message);
}
