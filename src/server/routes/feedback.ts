/**
 * 问题反馈 API（#357）
 * 挂载点: /api/feedback
 * 表: feedback_reports / feedback_attachments
 * 权限: 教师 / 管理员可提交并查看自己的反馈；全部列表、处理、删除需 system:manage
 *
 * 反馈落在本系统数据库。管理员在全局设置里查看和处理全部反馈，
 * 需要转发时一键复制成 Markdown。
 *
 * 附件：单次最多 15 个、单个 100 MiB，文件本体在
 * data/answer-card/feedback/<uuid>/，元数据在 feedback_attachments。
 */
import { Router, type Request, type RequestHandler, type Response } from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { readdirSync, unlinkSync, type Dirent } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
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
  beginChunkedFeedbackReservation,
  FEEDBACK_STREAM_STEP_BYTES,
  noteFeedbackTempPath,
  releaseFeedbackUpload,
  reserveFeedbackStorage,
  settleFeedbackStorage,
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
const feedbackRootPrefix = `${path.resolve(feedbackRoot)}${path.sep}`;

// 启动时同步清掉上次中断留下的临时上传件：此刻还没有本进程的上传，不存在误删在途文件的窗口。
try {
  for (const entry of readdirSync(feedbackTmpDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    try { unlinkSync(path.join(feedbackTmpDir, entry.name)); } catch { /* 留给下一次清理 */ }
  }
} catch { /* 目录还不存在 */ }

const pendingOrphanDirs = new Set<string>();
let orphanSweepDone = false;
let orphanSweep: Promise<void> | null = null;

async function retryPendingOrphanDirs(): Promise<void> {
  for (const dir of [...pendingOrphanDirs]) {
    try {
      await rm(dir, { recursive: true, force: true });
      pendingOrphanDirs.delete(dir);
    } catch { /* 保留到下一次上传再试 */ }
  }
}

/**
 * 首次上传时核对「有目录、无附件记录」的孤儿目录（崩溃或清理失败遗留）。
 * 只删超过 10 分钟的目录，避免删掉另一个并发请求刚建好、事务尚未提交的目录。
 */
async function sweepFeedbackOrphansOnce(): Promise<void> {
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
        } catch {
          entries = [];
        }
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name === "_tmp") continue;
          const dir = path.join(feedbackRoot, entry.name);
          if (referenced.has(dir)) continue;
          try {
            const info = await stat(dir);
            if (Date.now() - info.mtimeMs < 10 * 60_000) continue;
            await rm(dir, { recursive: true, force: true });
          } catch {
            pendingOrphanDirs.add(dir);
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
  feedbackTempPaths?: string[];
};

function tempPathsOf(req: Request): string[] {
  return (req as FeedbackRequest).feedbackTempPaths ?? [];
}

const STREAM_PREFETCH_SLACK = 64 * 1024;

/** 分块上传：已到达的字节超出当前预留就拒绝，并在还剩一个包的余量时再预留一小段。 */
function bindChunkedQuota(req: Request, res: Response, reservation: FeedbackStorageReservation): void {
  let received = 0;
  req.on("data", (chunk: Buffer) => {
    received += chunk.length;
    if (received > reservation.bytes) {
      const deficit = received - reservation.bytes;
      if (!reservation.tryGrow(deficit)) {
        if (isUploadAlreadyRejected(req, res)) return;
        res.status(413).json({
          ok: false,
          code: "FEEDBACK_STORAGE_QUOTA_EXCEEDED",
          error: "附件空间不够放下这次上传，请减少附件大小或数量后再试。",
        });
        res.once("finish", () => req.destroy());
        return;
      }
    }
    if (reservation.bytes - received < STREAM_PREFETCH_SLACK) {
      reservation.tryGrow(FEEDBACK_STREAM_STEP_BYTES);
    }
  });
}

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

const upload = multer({
  storage: multer.diskStorage({
    destination: async (_req, _file, cb) => {
      try {
        await mkdir(feedbackTmpDir, { recursive: true });
        cb(null, feedbackTmpDir);
      } catch (err) {
        cb(err as Error, "");
      }
    },
    filename: (req, _file, cb) => {
      const name = `fb_${randomUUID()}`;
      const full = path.join(feedbackTmpDir, name);
      // 在打开写入流之前登记。中断时按这份清单删除，不能只靠 multer 成功后才有的 req.files。
      noteFeedbackTempPath(full);
      const paths = ((req as FeedbackRequest).feedbackTempPaths ??= []);
      paths.push(full);
      cb(null, name);
    },
  }),
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

/** JSON 请求直接放行；multipart 先预留容量、走上传统计与 multer，再交给路由处理。 */
const receiveFeedbackUpload: RequestHandler = (req, res, next) => {
  if (!req.is("multipart/form-data")) {
    next();
    return;
  }
  // 预留容量要先读盘。先暂停正文，避免这段时间里流已经开始，后面的 multer 接不到开头。
  req.pause();
  void purgeStaleTmpUploads(feedbackTmpDir)
    .catch(() => {})
    .then(async () => {
      await sweepFeedbackOrphansOnce();
      const declared = Number(req.headers["content-length"]);
      const hasDeclaredLength = Number.isFinite(declared) && declared > 0;
      // 分块请求没有 Content-Length。只预留一个步进，再随正文增长；
      // 不能把剩余配额一次划给这条连接。单个请求仍受 requestUploadBudget 的上限约束。
      let reservation: FeedbackStorageReservation;
      try {
        reservation = hasDeclaredLength
          ? await reserveFeedbackStorage(feedbackRoot, feedbackTmpDir, declared)
          : await beginChunkedFeedbackReservation(feedbackRoot, feedbackTmpDir);
      } catch (err) {
        if (err instanceof FeedbackStorageQuotaError) {
          res.status(413).json({ ok: false, code: err.code, error: err.message });
          res.once("finish", () => req.destroy());
          return;
        }
        if (err instanceof FeedbackStorageUnavailableError) {
          res.status(500).json({ ok: false, code: err.code, error: err.message });
          res.once("finish", () => req.destroy());
          return;
        }
        throw err;
      }
      (req as FeedbackRequest).feedbackReservation = reservation;
      if (!hasDeclaredLength) bindChunkedQuota(req, res, reservation);

      let multerStarted = false;
      attachmentBudget(req, res, () => {
        multerStarted = true;
        upload.array("files", MAX_FEEDBACK_ATTACHMENTS)(req, res, async (error) => {
          if (!error) {
            next();
            return;
          }
          // 先删掉本请求已经写完的临时文件，再释放预留。req.files 在中断时经常是空的。
          await releaseFeedbackUpload(feedbackRoot, feedbackTmpDir, reservation, tempPathsOf(req));
          if (isUploadAlreadyRejected(req, res)) return;
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
      // 请求级预算在进 multer 之前就拒绝时，回调不会执行，预留必须在这里放掉。
      if (!multerStarted) {
        await releaseFeedbackUpload(feedbackRoot, feedbackTmpDir, reservation, tempPathsOf(req));
      }
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
  const files = ((req.files as Express.Multer.File[] | undefined) ?? []).filter(Boolean);
  const reservation = (req as FeedbackRequest).feedbackReservation ?? null;
  const fail = async (message: string, status = 400): Promise<void> => {
    await releaseFeedbackUpload(feedbackRoot, feedbackTmpDir, reservation, tempPathsOf(req));
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
    try {
      reportId = await settleFeedbackStorage(
        feedbackRoot,
        feedbackTmpDir,
        reservation,
        incomingBytes,
        tempPathsOf(req),
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
        }
      );
    } catch (err) {
      // 只处理提交前的失败。事务提交之后的容量核算失败由 settle 吞掉并返回 id，不能进这里删目录。
      try {
        await rm(finalDir, { recursive: true, force: true });
      } catch (cleanupErr) {
        pendingOrphanDirs.add(finalDir);
        console.error("[feedback] 附件清理失败，已排队重试:", cleanupErr);
      }
      await releaseFeedbackUpload(feedbackRoot, feedbackTmpDir, reservation, tempPathsOf(req));
      throw err;
    }
    res.status(201).json({ ok: true, data: { id: reportId } });
  } catch (err: any) {
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

// DELETE /api/feedback/:id — 删除反馈并清理附件文件（管理员）
router.delete("/:id", requireAdmin, async (req, res) => {
  try {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "无效的反馈 ID" });
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
          error: "附件路径异常，未删除反馈，请稍后重试",
        });
      }
      dirs.add(path.dirname(absPath));
    }
    // 先清文件再删库：清理失败时保留反馈，管理员可以重试；反过来会留下无法再定位的孤儿文件。
    for (const dir of dirs) {
      if (!dir.startsWith(feedbackRootPrefix)) {
        return res.status(500).json({
          ok: false,
          code: "FEEDBACK_ATTACHMENT_PATH_INVALID",
          error: "附件路径异常，未删除反馈，请稍后重试",
        });
      }
      try {
        await rm(dir, { recursive: true, force: true });
      } catch (err) {
        console.error("[feedback] 附件清理失败:", err);
        return res.status(500).json({
          ok: false,
          code: "FEEDBACK_ATTACHMENT_CLEANUP_FAILED",
          error: "附件文件清理失败，反馈未删除，请重试",
        });
      }
    }

    const result = await db.run("DELETE FROM feedback_reports WHERE id = ?", id);
    if (result.changes === 0) return res.status(404).json({ ok: false, error: "反馈不存在" });
    res.json({ ok: true, message: "反馈已删除" });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
