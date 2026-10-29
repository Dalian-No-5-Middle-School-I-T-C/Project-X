/**
 * 问题反馈 API（#357）
 * 挂载点: /api/feedback
 * 表: feedback_reports / feedback_attachments
 * 权限: 全部 SYSTEM_MANAGE（主站管理员端）
 *
 * 反馈落在本系统数据库，不依赖 GitHub：扫卡室网络访问 GitHub 很慢，
 * 直连还需要把 token 放在学校服务器上。管理员在全局设置里查看，
 * 需要转发时一键复制成 Markdown 再贴到 issue。
 *
 * 附件：单次最多 15 个、单个 100 MiB，文件本体在
 * data/answer-card/feedback/<uuid>/，元数据在 feedback_attachments。
 */
import { Router, type Request, type RequestHandler, type Response } from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, readdirSync, unlinkSync, type Dirent } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { Transform } from "node:stream";
import path from "node:path";
import { authMiddleware, requirePermission, requireRole } from "../middleware/auth";
import { PERMISSIONS, roleHasPermission } from "../auth/permissions";
import { getMysqlDb } from "../db";
import { databaseTimestamp } from "../db/timestamp";
import { resolveAnswerCardDataDir } from "../db/paths";
import { requestUploadBudget, isUploadAlreadyRejected } from "../lib/uploadBudget";
import {
  FeedbackStorageQuotaError,
  FeedbackStorageUnavailableError,
  activeFeedbackTempFiles,
  createFeedbackStorageReservation,
  invalidateFeedbackStorageUsage,
  markActiveFeedbackTempFile,
  markFeedbackTempFileLeaked,
  settleFeedbackStorage,
  unmarkActiveFeedbackTempFile,
  withFeedbackMutationLock,
  type FeedbackStorageReservation,
} from "../lib/feedbackStorage";
import { purgeStaleTmpUploads } from "../../apps/answer-card/server/paperQuota";
import {
  MAX_FEEDBACK_ATTACHMENTS,
  MAX_FEEDBACK_ATTACHMENT_BYTES,
  MAX_FEEDBACK_ATTACHMENTS_TOTAL_BYTES,
} from "../../shared/feedbackLimits";

const router = Router();
router.use(authMiddleware);
// 任何反馈请求都先核对一次暂存目录：进程在删除中途退出时，文件能尽快回到原位。
router.use((_req, _res, next) => {
  void reconcileFeedbackTrashOnce().finally(next);
});

const requireAdmin = requirePermission(PERMISSIONS.SYSTEM_MANAGE);
const requireTeacher = requireRole("admin", "teacher");

const CATEGORIES = new Set(["problem", "suggestion", "other"]);
const MAX_TITLE = 100;
const MAX_CONTENT = 5000;
const MAX_CONTACT = 100;
const MAX_CONTEXT_BYTES = 8 * 1024;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const MAX_FILENAME = 200;
const MAX_MIME = 150;

const dataRoot = resolveAnswerCardDataDir();
const feedbackRoot = path.join(dataRoot, "feedback");
const feedbackTmpDir = path.join(feedbackRoot, "_tmp");
const feedbackTrashDir = path.join(feedbackRoot, "_trash");
const feedbackRootPrefix = `${path.resolve(feedbackRoot)}${path.sep}`;

// 启动时同步清掉上次中断留下的临时上传件：此刻还没有本进程的上传，不存在误删在途文件的窗口。
let feedbackTmpReady = false;
function prepareFeedbackTmpDir(): void {
  mkdirSync(feedbackTmpDir, { recursive: true });
  for (const entry of readdirSync(feedbackTmpDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const filePath = path.join(feedbackTmpDir, entry.name);
    try {
      unlinkSync(filePath);
    } catch {
      // 重启后没有存活的预留；删不掉的年轻临时件也要立刻按占盘计入准入，
      // 不能靠 _tmp 的 10 分钟宽限期（它假设文件有活跃预留）。
      markFeedbackTempFileLeaked(filePath);
    }
  }
}
try {
  prepareFeedbackTmpDir();
  feedbackTmpReady = true;
} catch (err) {
  // 目录级扫描失败时不能当成空目录：保留未就绪状态，后续上传先重试清扫，失败就拒收。
  console.error("[feedback] 临时目录启动清理失败，附件上传将暂时拒绝:", err);
}

const pendingOrphanDirs = new Set<string>();
const youngOrphanDirs = new Set<string>();
const ORPHAN_GRACE_MS = 10 * 60_000;
let orphanSweepDone = false;
let orphanSweep: Promise<void> | null = null;
let trashReconcile: Promise<void> | null = null;
const activeStagedDirs = new Set<string>();

/**
 * 删除反馈时附件目录先移到 `_trash`，数据库成功删除后再清理。
 * 这里处理崩溃/失败遗留：记录还在就移回原位，记录已经没了就删掉。
 * 每次请求都核对一次（目录通常为空，readdir 成本很低），不依赖进程重启。
 */
async function reconcileFeedbackTrashOnce(): Promise<void> {
  if (!trashReconcile) {
    trashReconcile = (async () => {
      try {
        let entries: Dirent[];
        try {
          entries = await readdir(feedbackTrashDir, { withFileTypes: true });
        } catch (err: any) {
          if (err?.code === "ENOENT") return;
          throw err;
        }
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const staged = path.join(feedbackTrashDir, entry.name);
          if (activeStagedDirs.has(staged)) continue; // 本进程里有删除正在进行，不抢它的目录
          const original = path.join(feedbackRoot, entry.name);
          try {
            const row = await getMysqlDb().get<{ id: number }>(
              "SELECT id FROM feedback_attachments WHERE stored_path LIKE ? LIMIT 1",
              `feedback/${entry.name}/%`
            );
            if (row) {
              await rename(staged, original);
              console.log(`[feedback] 已恢复暂存的附件目录: ${entry.name}`);
            } else {
              await rm(staged, { recursive: true, force: true });
              invalidateFeedbackStorageUsage();
            }
          } catch (err) {
            console.error("[feedback] 暂存附件目录核对失败:", entry.name, err);
          }
        }
      } catch (err) {
        console.error("[feedback] 暂存附件目录核对失败:", err);
      } finally {
        trashReconcile = null;
      }
    })();
  }
  await trashReconcile;
}

async function attachmentDirReferenced(dir: string): Promise<boolean> {
  const row = await getMysqlDb().get<{ id: number }>(
    "SELECT id FROM feedback_attachments WHERE stored_path LIKE ? LIMIT 1",
    `feedback/${path.basename(dir)}/%`
  );
  return Boolean(row);
}

async function retryPendingOrphanDirs(): Promise<void> {
  for (const dir of [...pendingOrphanDirs]) {
    try {
      // 即使是待清理集合，也重新确认没有被附件记录引用（并发事务可能在排队期间提交）。
      if (await attachmentDirReferenced(dir)) {
        pendingOrphanDirs.delete(dir);
        continue;
      }
      await rm(dir, { recursive: true, force: true });
      pendingOrphanDirs.delete(dir);
      invalidateFeedbackStorageUsage();
    } catch { /* 保留到下一次上传再试 */ }
  }
  // 首次核对时因未满宽限期被跳过的目录，之后每次上传都复查一次；满 10 分钟再删。
  for (const dir of [...youngOrphanDirs]) {
    try {
      const info = await stat(dir);
      if (Date.now() - info.mtimeMs < ORPHAN_GRACE_MS) continue;
      // 期间可能有并发上传的事务已经提交，删除前必须重新确认没有附件记录。
      if (await attachmentDirReferenced(dir)) {
        youngOrphanDirs.delete(dir);
        continue;
      }
      await rm(dir, { recursive: true, force: true });
      youngOrphanDirs.delete(dir);
      invalidateFeedbackStorageUsage();
    } catch (err: any) {
      if (err?.code === "ENOENT") {
        youngOrphanDirs.delete(dir);
        continue;
      }
      // 查询或删除失败都留到下一次复查；下一次仍会重新确认引用关系，不能转入盲删集合。
    }
  }
}

/**
 * 首次上传时核对「有目录、无附件记录」的孤儿目录（崩溃或清理失败遗留）。
 * 只删超过 10 分钟的目录，避免删掉另一个并发请求刚建好、事务尚未提交的目录。
 */
async function sweepFeedbackOrphansOnce(): Promise<void> {
  await reconcileFeedbackTrashOnce();
  await retryPendingOrphanDirs();
  if (orphanSweepDone) return;
  if (!orphanSweep) {
    orphanSweep = (async () => {
      try {
        const rows = await getMysqlDb().all<{ stored_path: string }>("SELECT stored_path FROM feedback_attachments");
        const referenced = new Set<string>();
        for (const row of rows) {
          const absPath = resolveStoredPath(row.stored_path);
          if (absPath) referenced.add(path.dirname(absPath));
        }
        let entries: Dirent[];
        try {
          entries = await readdir(feedbackRoot, { withFileTypes: true });
        } catch (err: any) {
          // 目录不存在才是「没有附件目录」；EIO/EACCES 等读失败要保留重试机会，
          // 否则会永久标记扫描完成，孤儿目录再也不会被回收。
          if (err?.code !== "ENOENT") throw err;
          entries = [];
        }
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name === "_tmp" || entry.name === "_trash") continue;
          const dir = path.join(feedbackRoot, entry.name);
          if (referenced.has(dir)) continue;
          try {
            const info = await stat(dir);
            if (Date.now() - info.mtimeMs < ORPHAN_GRACE_MS) {
              youngOrphanDirs.add(dir);
              continue;
            }
            await rm(dir, { recursive: true, force: true });
            invalidateFeedbackStorageUsage();
          } catch {
            // 读取/删除临时失败，回到年轻集合下一轮重新核对引用和宽限期，不直接盲删。
            youngOrphanDirs.add(dir);
          }
        }
        orphanSweepDone = true;
      } catch (err) {
        console.error("[feedback] 附件孤儿目录核对失败:", err);
      } finally {
        orphanSweep = null;
      }
    })();
  }
  await orphanSweep;
}

type FeedbackRequest = Express.Request & {
  feedbackReservation?: FeedbackStorageReservation;
  /** multer 存储引擎逐个登记临时文件，失败/断连时按这份清单清理（req.files 可能还没赋值）。 */
  feedbackTempPaths?: string[];
  /** 本次请求累计已写入的附件字节数（文本字段不算）。 */
  feedbackFileBytes?: number;
  /** multer 回调已经给出结果：此后由路由或错误处理负责清理，断连兜底不再介入。 */
  feedbackUploadFinished?: boolean;
  feedbackFinalize?: Promise<void>;
  feedbackAborted?: boolean;
  /** 每个 part 的写入流销毁器；失败/断连时统一收尾，避免迟到的 transform 再落盘。 */
  feedbackAborters?: Array<() => void>;
};

type FeedbackRow = {
  id: number;
  category: string;
  title: string;
  content: string;
  contact: string | null;
  status: string;
  username: string;
  display_name: string;
  role_name: string;
  context_json: string | null;
  created_at: string;
  resolved_at: string | null;
  resolver_name: string | null;
};

type FeedbackAttachmentRow = {
  id: number;
  feedback_id: number;
  filename: string;
  mime: string | null;
  size_bytes: number | string;
};

type FeedbackAttachment = {
  id: number;
  filename: string;
  mime: string | null;
  sizeBytes: number;
};

/** 去掉 NUL 与控制字符（保留换行/制表），并按上限直接拒绝而不是静默截断。 */
function readText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
}

function parsePositiveId(raw: unknown): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** 客户端环境信息只收扁平标量，限制键名、数量和单值长度，避免反馈行被撑爆。 */
function sanitizeContext(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= 30) break;
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(key)) continue;
    if (typeof value === "string") out[key] = value.slice(0, 500);
    else if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (typeof value === "boolean" || value === null) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function buildContextJson(client: Record<string, unknown> | null, dialect: string): string {
  const server = {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    database: dialect,
  };
  let json = JSON.stringify({ client, server });
  if (Buffer.byteLength(json, "utf8") > MAX_CONTEXT_BYTES) {
    json = JSON.stringify({ client: null, server, note: "客户端环境信息过大，已省略" });
  }
  return json;
}

/** SQLite 写 ISO（带 Z），MariaDB 的 DATETIME 是不带时区的服务器本地时间；
 *  返回给浏览器前补上时区，避免前端把服务器墙钟当成浏览器本地时间。 */
export function withTimezone(value: string | null, dialect: "sqlite" | "mariadb"): string | null {
  if (!value) return null;
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return value;
  const iso = value.replace(" ", "T");
  if (dialect === "sqlite") return `${iso}Z`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return value;
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return `${iso}${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

function decodeMultipartFilename(name: string): string {
  try {
    const decoded = Buffer.from(name, "latin1").toString("utf8");
    return Buffer.from(decoded, "utf8").toString("latin1") === name ? decoded : name;
  } catch {
    return name;
  }
}

function safeOriginalName(raw: string): string {
  const base = decodeMultipartFilename(raw).split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001F\u007F"]/g, "").trim();
  return (cleaned || "attachment").slice(0, MAX_FILENAME);
}

function safeExtension(name: string): string {
  const ext = path.extname(name).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : "";
}

function toAttachment(row: FeedbackAttachmentRow): FeedbackAttachment {
  return {
    id: Number(row.id),
    filename: row.filename,
    mime: row.mime,
    sizeBytes: Number(row.size_bytes),
  };
}

function toReport(
  row: FeedbackRow,
  dialect: "sqlite" | "mariadb",
  attachments: FeedbackAttachment[] = []
) {
  let context: unknown = null;
  if (row.context_json) {
    try { context = JSON.parse(row.context_json); } catch { context = null; }
  }
  return {
    id: Number(row.id),
    category: row.category,
    title: row.title,
    content: row.content,
    contact: row.contact,
    status: row.status === "resolved" ? "resolved" : "open",
    username: row.username,
    displayName: row.display_name,
    roleName: row.role_name,
    context,
    createdAt: withTimezone(row.created_at, dialect),
    resolvedAt: withTimezone(row.resolved_at, dialect),
    resolvedByName: row.resolver_name,
    attachments,
  };
}

function resolveStoredPath(relative: string): string | null {
  if (!relative || path.isAbsolute(relative)) return null;
  const abs = path.resolve(dataRoot, relative);
  return abs.startsWith(feedbackRootPrefix) ? abs : null;
}

type StagedAttachmentDir = { original: string; staged: string };

class FeedbackDeleteInProgressError extends Error {
  readonly code = "FEEDBACK_DELETE_IN_PROGRESS";

  constructor() {
    super("该反馈正在被其他请求删除，请稍后重试");
    this.name = "FeedbackDeleteInProgressError";
  }
}

/** 把附件目录原子移动到 `_trash`：数据库删除成功后才真正清理，失败可以移回。 */
async function stageAttachmentDirs(dirs: string[]): Promise<StagedAttachmentDir[]> {
  await mkdir(feedbackTrashDir, { recursive: true });
  const staged: StagedAttachmentDir[] = [];
  try {
    for (const dir of dirs) {
      const target = path.join(feedbackTrashDir, path.basename(dir));
      // 同一个 _trash 目录只能由一个删除请求持有；不能复用别人的标记。
      if (activeStagedDirs.has(target)) throw new FeedbackDeleteInProgressError();
      activeStagedDirs.add(target);
      try {
        await rename(dir, target);
      } catch (err: any) {
        activeStagedDirs.delete(target);
        if (err?.code === "ENOENT") {
          // 附件目录已经丢了（还原数据库、数据盘丢文件等）：当作已清理，继续删库。
          invalidateFeedbackStorageUsage();
          const leftover = await stat(target).catch(() => null);
          if (leftover?.isDirectory()) {
            // 另一个删除请求已经把它移进 _trash：不能共用同一份暂存目录，
            // 否则一方恢复、另一方清理会互相踩，留下无记录的孤儿目录。
            throw new FeedbackDeleteInProgressError();
          }
          continue;
        }
        throw err;
      }
      staged.push({ original: dir, staged: target });
    }
  } catch (err) {
    await restoreStagedDirs(staged);
    throw err;
  }
  return staged;
}

/** 数据库删除失败时把暂存目录移回原位；返回是否全部恢复。 */
async function restoreStagedDirs(staged: StagedAttachmentDir[]): Promise<boolean> {
  let ok = true;
  for (const entry of [...staged].reverse()) {
    try {
      await rename(entry.staged, entry.original);
    } catch (err) {
      ok = false;
      console.error("[feedback] 暂存附件目录恢复失败，后续请求会重试:", entry.staged, err);
    } finally {
      activeStagedDirs.delete(entry.staged);
    }
  }
  return ok;
}

async function removeStagedDirs(staged: StagedAttachmentDir[]): Promise<void> {
  for (const entry of staged) {
    try {
      await rm(entry.staged, { recursive: true, force: true });
      invalidateFeedbackStorageUsage();
    } catch (err) {
      pendingOrphanDirs.add(entry.staged);
      invalidateFeedbackStorageUsage();
      console.error("[feedback] 暂存附件清理失败，已排队重试:", entry.staged, err);
    } finally {
      activeStagedDirs.delete(entry.staged);
    }
  }
}

/** 按请求登记的路径清理临时文件；Windows 上偶发占用时重试，仍删不掉就继续按占盘计数。 */
async function removeRegisteredTempFiles(req: FeedbackRequest): Promise<void> {
  for (const filePath of req.feedbackTempPaths ?? []) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rm(filePath, { force: true });
        break;
      } catch (err) {
        if (attempt >= 4) {
          markFeedbackTempFileLeaked(filePath);
          console.error("[feedback] 临时文件清理失败，继续按占盘计数:", filePath, err);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
}

/** 先清临时文件、再释放预留：任何还留在 _tmp 的年轻文件都必须有预留或泄漏登记在册。 */
function finalizeFeedbackUpload(req: FeedbackRequest): Promise<void> {
  if (req.feedbackFinalize) return req.feedbackFinalize;
  req.feedbackAborted = true;
  let resolveFinalize!: () => void;
  // 先同步挂上 Promise 再执行收尾：abort 途中同伴的 _handleFile 回调可能立刻触发 multer
  // 错误处理并再次调用本函数，没有这份同步占位就会开第二条收尾链。
  const finalize = new Promise<void>((resolve) => { resolveFinalize = resolve; });
  req.feedbackFinalize = finalize;
  void (async () => {
    try {
      for (const abort of req.feedbackAborters ?? []) {
        try { abort(); } catch { /* 已关闭的流 */ }
      }
      await removeRegisteredTempFiles(req);
      for (const tempPath of req.feedbackTempPaths ?? []) unmarkActiveFeedbackTempFile(tempPath);
    } finally {
      req.feedbackReservation?.release();
      resolveFinalize();
    }
  })();
  return finalize;
}

/** 临时目录不可用时只拦真正带文件的上传；纯文本反馈不依赖附件目录。 */
class FeedbackTmpUnavailableError extends Error {
  readonly code = "FEEDBACK_ATTACHMENT_UNAVAILABLE";

  constructor() {
    super("附件服务暂时不可用，请稍后重试；也可以先提交不带附件的反馈");
    this.name = "FeedbackTmpUnavailableError";
  }
}

/** 按文件字节流式预留的 multer 存储：文本字段不占附件配额，文件写入受配额背压。
 *  导出供回归验证直接驱动 `_handleFile`，核对中止时每个 part 的完成回调恰好执行一次。 */
export const feedbackStorageEngine: multer.StorageEngine = {
  _handleFile(req, file, cb) {
    const state = req as FeedbackRequest;
    if (state.feedbackAborted) {
      cb(new Error("上传已中止"));
      return;
    }
    if (!feedbackTmpReady) {
      try {
        prepareFeedbackTmpDir();
        feedbackTmpReady = true;
      } catch (err) {
        console.error("[feedback] 临时目录不可用，拒绝带附件的上传:", err);
        cb(new FeedbackTmpUnavailableError());
        return;
      }
    }
    const reservation = state.feedbackReservation;
    const filename = `fb_${randomUUID()}`;
    const filePath = path.join(feedbackTmpDir, filename);
    (state.feedbackTempPaths ??= []).push(filePath);
    markActiveFeedbackTempFile(filePath);
    const out = createWriteStream(filePath);
    let size = 0;
    let finished = false;
    let transform: Transform;
    const fail = (err: Error, finalize = true): void => {
      if (finished) return;
      finished = true;
      try { file.stream.unpipe(transform); } catch { /* 已关闭的流 */ }
      out.destroy();
      cb(err);
      // Multer 在错误时可能先 drain 剩余请求体才回调；这里主动收尾，避免慢客户端
      // 把临时文件、活跃标记和预留一直锁到连接结束。
      if (finalize) void finalizeFeedbackUpload(state);
    };
    transform = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        if (finished || state.feedbackAborted) { callback(); return; }
        size += chunk.length;
        state.feedbackFileBytes = (state.feedbackFileBytes ?? 0) + chunk.length;
        const total = state.feedbackFileBytes;
        const held = reservation?.bytes ?? 0;
        if (!reservation || total > reservation.limit) {
          callback(new FeedbackStorageQuotaError());
          return;
        }
        if (total <= held) { callback(null, chunk); return; }
        reservation.ensureBytes(total)
          .then((covered) => {
            if (finished) { callback(); return; }
            if (!covered) { callback(new FeedbackStorageQuotaError()); return; }
            callback(null, chunk);
          })
          .catch((err) => callback(err as Error));
      },
    });
    (state.feedbackAborters ??= []).push(() => {
      // 每个 part 的 _handleFile 回调都必须恰好执行一次，同伴流只 destroy 不回调会让
      // Multer 的 pendingWrites 永远不归零，错误响应发不出去、请求一直挂着。
      fail(new Error("上传已中止"), false);
    });
    transform.on("error", fail);
    out.on("error", fail);
    file.stream.on("error", fail);
    out.on("finish", () => {
      if (finished) return;
      finished = true;
      cb(null, { destination: feedbackTmpDir, filename, path: filePath, size });
    });
    file.stream.pipe(transform).pipe(out);
  },
  _removeFile(_req, file, cb) {
    const filePath = (file as Express.Multer.File).path;
    if (!filePath) { cb(null); return; }
    rm(filePath, { force: true }).then(() => cb(null), (err) => cb(err));
  },
};

const upload = multer({
  storage: feedbackStorageEngine,
  limits: {
    fileSize: MAX_FEEDBACK_ATTACHMENT_BYTES,
    files: MAX_FEEDBACK_ATTACHMENTS,
    fields: 10,
    parts: MAX_FEEDBACK_ATTACHMENTS + 10,
    fieldSize: 64 * 1024,
  },
});

const attachmentBudget = requestUploadBudget({
  maxTotalBytes: MAX_FEEDBACK_ATTACHMENTS_TOTAL_BYTES,
  label: "问题反馈附件上传",
});

/** JSON 请求直接放行；multipart 先走上传统计与 multer，再交给路由处理。 */
const receiveFeedbackUpload: RequestHandler = (req, res, next) => {
  if (!req.is("multipart/form-data")) {
    next();
    return;
  }
  const state = req as FeedbackRequest;
  state.feedbackTempPaths = [];
  state.feedbackUploadFinished = false;
  state.feedbackFileBytes = 0;
  if (!feedbackTmpReady) {
    try {
      prepareFeedbackTmpDir();
      feedbackTmpReady = true;
    } catch (err) {
      // 纯文本反馈不写 _tmp，不能因为附件目录故障把它一起拒掉；
      // 真正带文件的请求由存储引擎在 _handleFile 里返回 503。
      console.error("[feedback] 临时目录仍不可用，本次请求只有带附件时才会被拒绝:", err);
    }
  }
  void purgeStaleTmpUploads(feedbackTmpDir, 60 * 60_000, activeFeedbackTempFiles())
    .catch(() => 0)
    .then(async (removedStale) => {
      if (removedStale > 0) invalidateFeedbackStorageUsage();
      await sweepFeedbackOrphansOnce();
      // 初始不占额度：只有真的写到文件字节才在存储引擎里申请预留，
      // 纯文本反馈、只声明长度不传文件的慢请求都不会锁住附件配额。
      const reservation = createFeedbackStorageReservation(
        feedbackRoot,
        feedbackTmpDir,
        MAX_FEEDBACK_ATTACHMENTS_TOTAL_BYTES
      );
      if (res.destroyed || req.destroyed) {
        reservation.release();
        return;
      }
      state.feedbackReservation = reservation;
      // 断连兜底：multer 通常会在断流时自行回滚并回调，回调里会先清理再释放；
      // 这里只处理「回调始终没来」的情况，且不再进入路由后才触发。
      res.once("close", () => {
        if (state.feedbackUploadFinished) return;
        const timer = setTimeout(() => {
          if (state.feedbackUploadFinished) return;
          void finalizeFeedbackUpload(state);
        }, 1000);
        timer.unref();
      });

      attachmentBudget(req, res, () => {
        upload.array("files", MAX_FEEDBACK_ATTACHMENTS)(req, res, async (error) => {
          state.feedbackUploadFinished = true;
          if (!error) {
            next();
            return;
          }
          await finalizeFeedbackUpload(state);
          if (isUploadAlreadyRejected(req, res)) return;
          if (error instanceof FeedbackStorageQuotaError) {
            res.status(413).json({ ok: false, code: error.code, error: error.message });
            return;
          }
          if (error instanceof FeedbackTmpUnavailableError) {
            res.status(503).json({ ok: false, code: error.code, error: error.message });
            return;
          }
          if (error instanceof FeedbackStorageUnavailableError) {
            res.status(500).json({ ok: false, code: error.code, error: error.message });
            return;
          }
          if (error instanceof multer.MulterError) {
            if (error.code === "LIMIT_FILE_SIZE") {
              res.status(413).json({
                ok: false,
                error: `单个附件不能超过 ${MAX_FEEDBACK_ATTACHMENT_BYTES / 1024 / 1024} MB`,
              });
              return;
            }
            if (error.code === "LIMIT_FILE_COUNT") {
              res.status(400).json({
                ok: false,
                error: `最多附加 ${MAX_FEEDBACK_ATTACHMENTS} 个文件`,
              });
              return;
            }
            if (["LIMIT_FIELD_COUNT", "LIMIT_FIELD_VALUE", "LIMIT_FIELD_KEY", "LIMIT_PART_COUNT"].includes(error.code)) {
              res.status(400).json({ ok: false, error: "表单字段过多或过大" });
              return;
            }
            res.status(400).json({ ok: false, error: `上传失败：${error.code}` });
            return;
          }
          next(error);
        });
      });
    })
    .catch(next);
};

const SELECT_COLUMNS = `f.id, f.category, f.title, f.content, f.contact, f.status,
  f.username, f.display_name, f.role_name, f.context_json,
  f.created_at, f.resolved_at, u.name AS resolver_name`;

async function listFeedback(req: Request, res: Response, ownerId?: number): Promise<void> {
  try {
    const requested = typeof req.query.status === "string" ? req.query.status : "all";
    const status = requested === "open" || requested === "resolved" ? requested : null;
    const rawLimit = Number.parseInt(String(req.query.limit ?? ""), 10);
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isNaN(rawLimit) ? DEFAULT_LIMIT : rawLimit));
    const cursor = req.query.cursor === undefined ? null : parsePositiveId(req.query.cursor);
    if (req.query.cursor !== undefined && !cursor) {
      res.status(400).json({ ok: false, error: "无效的分页游标" });
      return;
    }
    const db = getMysqlDb();
    const conditions: string[] = [];
    const params: Array<string | number> = [];
    if (ownerId !== undefined) { conditions.push("f.user_id = ?"); params.push(ownerId); }
    if (status) { conditions.push("f.status = ?"); params.push(status); }
    if (cursor) { conditions.push("f.id < ?"); params.push(cursor); }
    const rows = await db.all<FeedbackRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM feedback_reports f
         LEFT JOIN users u ON u.id = f.resolved_by
        ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
        ORDER BY f.id DESC
        LIMIT ?`,
      ...params,
      limit + 1
    );
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && page.length > 0 ? Number(page[page.length - 1].id) : null;

    const ids = page.map((row) => Number(row.id));
    const attachmentRows = ids.length > 0
      ? await db.all<FeedbackAttachmentRow>(
          `SELECT id, feedback_id, filename, mime, size_bytes
             FROM feedback_attachments
            WHERE feedback_id IN (${ids.map(() => "?").join(", ")})
            ORDER BY id`,
          ...ids
        )
      : [];
    const attachmentsByReport = new Map<number, FeedbackAttachment[]>();
    for (const row of attachmentRows) {
      const feedbackId = Number(row.feedback_id);
      const list = attachmentsByReport.get(feedbackId) ?? [];
      list.push(toAttachment(row));
      attachmentsByReport.set(feedbackId, list);
    }

    const counts = ownerId !== undefined
      ? await db.get<{ total: number | string; open: number | string | null }>(
          `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END), 0) AS open
             FROM feedback_reports WHERE user_id = ?`,
          ownerId
        )
      : await db.get<{ total: number | string; open: number | string | null }>(
          `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END), 0) AS open
             FROM feedback_reports`
        );
    res.json({
      ok: true,
      data: page.map((row) => toReport(row, db.dialect, attachmentsByReport.get(Number(row.id)) ?? [])),
      counts: { total: Number(counts?.total ?? 0), open: Number(counts?.open ?? 0) },
      hasMore,
      nextCursor,
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
}

// GET /api/feedback — 全部反馈（管理员）
router.get("/", requireAdmin, (req, res) => {
  void listFeedback(req, res);
});

// GET /api/feedback/mine — 当前账号自己的反馈（教师 / 管理员）
router.get("/mine", requireTeacher, (req, res) => {
  void listFeedback(req, res, req.user!.id);
});

// POST /api/feedback — 提交反馈（教师 / 管理员，multipart 可带附件）
router.post("/", requireTeacher, receiveFeedbackUpload, async (req, res) => {
  const state = req as FeedbackRequest;
  const files = ((req.files as Express.Multer.File[] | undefined) ?? []).filter(Boolean);
  const reservation = state.feedbackReservation ?? null;
  const fail = async (message: string, status = 400): Promise<void> => {
    await finalizeFeedbackUpload(state);
    res.status(status).json({ ok: false, error: message });
  };

  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const title = readText(body.title);
    const content = readText(body.content);
    const contact = readText(body.contact);
    const category = body.category === undefined ? "problem" : String(body.category);
    let rawContext = body.context;
    if (typeof rawContext === "string") {
      try { rawContext = JSON.parse(rawContext); } catch { rawContext = null; }
    }

    if (!title) { await fail("标题不能为空"); return; }
    if (title.length > MAX_TITLE) { await fail(`标题不能超过 ${MAX_TITLE} 字`); return; }
    if (!content) { await fail("详细描述不能为空"); return; }
    if (content.length > MAX_CONTENT) { await fail(`详细描述不能超过 ${MAX_CONTENT} 字`); return; }
    if (contact.length > MAX_CONTACT) { await fail(`联系方式不能超过 ${MAX_CONTACT} 字`); return; }
    if (!CATEGORIES.has(category)) { await fail("反馈类型无效"); return; }
    if (files.length > MAX_FEEDBACK_ATTACHMENTS) {
      await fail(`最多附加 ${MAX_FEEDBACK_ATTACHMENTS} 个文件`);
      return;
    }
    if (files.some((file) => file.size > MAX_FEEDBACK_ATTACHMENT_BYTES)) {
      await fail(`单个附件不能超过 ${MAX_FEEDBACK_ATTACHMENT_BYTES / 1024 / 1024} MB`, 413);
      return;
    }

    const storageKey = randomUUID();
    const finalDir = path.join(feedbackRoot, storageKey);
    const incomingBytes = files.reduce((sum, file) => sum + file.size, 0);
    let reportId: number;
    const cleanupFailedSettle = async (): Promise<void> => {
      try {
        await rm(finalDir, { recursive: true, force: true });
      } catch (cleanupErr) {
        pendingOrphanDirs.add(finalDir);
        console.error("[feedback] 附件清理失败，已排队重试:", cleanupErr);
      }
      invalidateFeedbackStorageUsage();
      await finalizeFeedbackUpload(state);
    };
    reportId = await withFeedbackMutationLock(() =>
      settleFeedbackStorage(
        feedbackRoot,
        reservation,
        incomingBytes,
        async () => {
          const stored: Array<{ filename: string; storedPath: string; mime: string | null; sizeBytes: number }> = [];
          if (files.length > 0) await mkdir(finalDir, { recursive: true });
          for (let index = 0; index < files.length; index += 1) {
            const file = files[index];
            const originalName = safeOriginalName(file.originalname);
            const storedName = `${index}${safeExtension(originalName)}`;
            const target = path.join(finalDir, storedName);
            await rename(file.path, target);
            stored.push({
              filename: originalName,
              storedPath: path.relative(dataRoot, target).split(path.sep).join("/"),
              mime: file.mimetype ? file.mimetype.slice(0, MAX_MIME) : null,
              sizeBytes: file.size,
            });
          }

          const user = req.user!;
          const db = getMysqlDb();
          const now = databaseTimestamp();
          const contextJson = buildContextJson(sanitizeContext(rawContext), db.dialect);
          return db.transaction(async (tx) => {
            const result = await tx.run(
              `INSERT INTO feedback_reports
                 (user_id, username, display_name, role_name, category, title, content, contact, context_json, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
              user.id,
              user.username.slice(0, 100),
              user.name.slice(0, 100),
              user.role_name.slice(0, 32),
              category, title, content, contact || null, contextJson, now, now
            );
            const id = Number(result.lastInsertRowid);
            for (const attachment of stored) {
              await tx.run(
                `INSERT INTO feedback_attachments
                   (feedback_id, filename, stored_path, mime, size_bytes, created_at)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                id, attachment.filename, attachment.storedPath, attachment.mime, attachment.sizeBytes, now
              );
            }
            return id;
          });
        },
        cleanupFailedSettle
      )
    );
    for (const tempPath of state.feedbackTempPaths ?? []) unmarkActiveFeedbackTempFile(tempPath);
    res.status(201).json({ ok: true, data: { id: reportId } });
  } catch (err: any) {
    await finalizeFeedbackUpload(state);
    if (err instanceof FeedbackStorageQuotaError) {
      if (!res.headersSent) {
        res.status(413).json({ ok: false, code: err.code, error: err.message });
      }
      return;
    }
    if (err instanceof FeedbackStorageUnavailableError) {
      if (!res.headersSent) {
        res.status(500).json({ ok: false, code: err.code, error: err.message });
      }
      return;
    }
    if (!res.headersSent) res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/feedback/:id/attachments/:attachmentId — 下载附件（管理员，或反馈提交人）
router.get("/:id/attachments/:attachmentId", requireTeacher, async (req, res) => {
  try {
    const feedbackId = parsePositiveId(req.params.id);
    const attachmentId = parsePositiveId(req.params.attachmentId);
    if (!feedbackId || !attachmentId) {
      return res.status(400).json({ ok: false, error: "无效的附件 ID" });
    }
    const row = await getMysqlDb().get<{ filename: string; stored_path: string; user_id: number | null }>(
      `SELECT a.filename, a.stored_path, f.user_id
         FROM feedback_attachments a
         JOIN feedback_reports f ON f.id = a.feedback_id
        WHERE a.id = ? AND a.feedback_id = ?`,
      attachmentId, feedbackId
    );
    if (!row) return res.status(404).json({ ok: false, error: "附件不存在" });
    const isAdmin = roleHasPermission(req.user!.role_id, PERMISSIONS.SYSTEM_MANAGE);
    if (!isAdmin && Number(row.user_id) !== req.user!.id) {
      return res.status(403).json({ ok: false, error: "无权下载他人的反馈附件" });
    }
    const absPath = resolveStoredPath(row.stored_path);
    if (!absPath) return res.status(404).json({ ok: false, error: "附件不存在" });
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.download(absPath, row.filename, (err) => {
      if (!err) return;
      if (res.headersSent) {
        if (!res.writableEnded) res.end();
        return;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        res.status(404).json({ ok: false, error: "附件文件不存在" });
      } else {
        res.status(500).json({ ok: false, error: "附件下载失败" });
      }
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PATCH /api/feedback/:id — 标记已处理 / 重新打开（管理员）
router.patch("/:id", requireAdmin, async (req, res) => {
  try {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "无效的反馈 ID" });
    const status = (req.body ?? {}).status;
    if (status !== "open" && status !== "resolved") {
      return res.status(400).json({ ok: false, error: "状态只能是 open 或 resolved" });
    }
    const db = getMysqlDb();
    const now = databaseTimestamp();
    const result = await db.run(
      `UPDATE feedback_reports
          SET status = ?, resolved_at = ?, resolved_by = ?, updated_at = ?
        WHERE id = ?`,
      status,
      status === "resolved" ? now : null,
      status === "resolved" ? req.user!.id : null,
      now,
      id
    );
    if (result.changes === 0) return res.status(404).json({ ok: false, error: "反馈不存在" });
    res.json({ ok: true, message: status === "resolved" ? "已标记为已处理" : "已重新打开" });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 同一反馈的 DELETE 串行执行：并发删除不会同时把同一个目录搬进 _trash。
const feedbackDeleteChains = new Map<number, Promise<unknown>>();
function enqueueFeedbackDelete<T>(id: number, work: () => Promise<T>): Promise<T> {
  const previous = feedbackDeleteChains.get(id) ?? Promise.resolve();
  const run = previous.then(work, work);
  const tail = run.then(() => undefined, () => undefined);
  feedbackDeleteChains.set(id, tail);
  void tail.then(() => {
    if (feedbackDeleteChains.get(id) === tail) feedbackDeleteChains.delete(id);
  });
  return run;
}

// DELETE /api/feedback/:id — 删除反馈并清理附件文件（管理员）
router.delete("/:id", requireAdmin, async (req, res) => {
  const id = parsePositiveId(req.params.id);
  if (!id) {
    res.status(400).json({ ok: false, error: "无效的反馈 ID" });
    return;
  }
  try {
    await enqueueFeedbackDelete(id, async () => {
      try {
        await reconcileFeedbackTrashOnce();
        // 与备份共用同一把锁：备份在数据库快照与附件目录复制之间不允许删除提交，
        // 否则备份会保留附件记录却缺少文件。
        await withFeedbackMutationLock(async () => {
          const db = getMysqlDb();
          const existing = await db.get<{ id: number }>("SELECT id FROM feedback_reports WHERE id = ?", id);
          if (!existing) return res.status(404).json({ ok: false, error: "反馈不存在" });

          const attachments = await db.all<{ stored_path: string }>(
            "SELECT stored_path FROM feedback_attachments WHERE feedback_id = ?",
            id
          );
          const dirs = new Set<string>();
          for (const attachment of attachments) {
            const absPath = resolveStoredPath(attachment.stored_path);
            if (!absPath) {
              return res.status(500).json({
                ok: false,
                code: "FEEDBACK_ATTACHMENT_PATH_INVALID",
                error: "删除反馈失败，请稍后重试",
              });
            }
            dirs.add(path.dirname(absPath));
          }
          // 附件目录先原子移入 _trash：数据库删除成功后再清理；数据库失败则移回，
          // 既不会留下指向空文件的记录，也不会留下无法定位的孤儿文件。
          let staged: StagedAttachmentDir[];
          try {
            staged = await stageAttachmentDirs([...dirs]);
          } catch (err) {
            if (err instanceof FeedbackDeleteInProgressError) {
              return res.status(409).json({ ok: false, code: err.code, error: err.message });
            }
            console.error("[feedback] 附件目录暂存失败:", err);
            return res.status(500).json({
              ok: false,
              code: "FEEDBACK_ATTACHMENT_STAGE_FAILED",
              error: "删除反馈失败，请稍后重试",
            });
          }

          let result;
          try {
            result = await db.run("DELETE FROM feedback_reports WHERE id = ?", id);
          } catch (err) {
            console.error("[feedback] 删除反馈失败，正在恢复附件:", err);
            await restoreStagedDirs(staged);
            return res.status(500).json({
              ok: false,
              code: "FEEDBACK_DELETE_FAILED",
              error: "删除反馈失败，请稍后重试",
            });
          }
          if (result.changes === 0) {
            await removeStagedDirs(staged);
            return res.status(404).json({ ok: false, error: "反馈不存在" });
          }
          await removeStagedDirs(staged);
          res.json({ ok: true, message: "反馈已删除" });
        });
      } catch (err: any) {
        if (!res.headersSent) res.status(500).json({ ok: false, error: err.message });
      }
    });
  } catch (err: any) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
